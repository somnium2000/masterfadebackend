import crypto from "node:crypto";
import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import { assertUuid, expireStaleAppointmentReservations } from "../../services/agendaService.js";
import { PaymentProviderFactory } from "../../services/payments/PaymentProviderFactory.js";
import { MockPaymentProvider } from "../../services/payments/MockPaymentProvider.js";

const CLIENT_ALLOWED_ROLES = ["cliente", "admin", "super_admin"];
const ACTIVE_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];
const MAX_PAYMENT_INTENTS_PER_HOLD = 3;

const requestIdSchema = { type: "string" };

const errorResponseSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
      additionalProperties: true,
    },
    requestId: requestIdSchema,
  },
  required: ["ok", "error"],
  additionalProperties: true,
};

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    details: error instanceof Error ? error.message : "Unknown pagos error",
    requestId: request.id,
  });
}

function ensureClientContext(request) {
  const clienteId = request.claims?.cliente_id ?? null;
  const personaId = request.claims?.user?.id_persona ?? null;
  const usuarioId = request.claims?.user?.id_usuario ?? null;

  if (!clienteId || !personaId || !usuarioId) {
    throw new AppError(409, "El usuario autenticado no tiene un perfil cliente activo", {
      code: "PAGOS_CLIENT_CONTEXT_REQUIRED",
    });
  }

  return { clienteId, personaId, usuarioId };
}

function safeText(value) {
  const raw = String(value ?? "").trim();
  return raw.length ? raw : null;
}

function buildCallbackUrl(citaId) {
  const explicit = safeText(process.env.PAYMENT_CALLBACK_URL);
  if (explicit) return explicit;

  const frontend = safeText(process.env.FRONTEND_URL) || "http://localhost:5173";
  const base = frontend.replace(/\/+$/, "");
  return `${base}/pagos/resultado?id_cita=${encodeURIComponent(citaId)}`;
}

function normalizeProviderStatus(rawStatus) {
  const status = String(rawStatus || "").trim().toUpperCase();
  if (["PAID", "SUCCESS", "SUCCEEDED", "CAPTURED", "CAPTURADO"].includes(status)) {
    return "paid";
  }
  if (["FAILED", "FAIL", "DECLINED", "ERROR", "REJECTED"].includes(status)) {
    return "failed";
  }
  if (["EXPIRED", "TIMEOUT", "CANCELLED", "CANCELED"].includes(status)) {
    return "expired";
  }
  return "pending";
}

async function ensureProvider(client, providerCode) {
  const normalizedCode = String(providerCode || "").trim().toLowerCase();
  if (!normalizedCode) {
    throw new AppError(400, "Proveedor de pago invalido", {
      code: "PAGOS_PROVIDER_INVALID",
    });
  }

  const existing = await client.query(
    `
      SELECT id_provider, codigo, nombre, activo
      FROM public.payment_providers
      WHERE codigo = $1
      LIMIT 1
    `,
    [normalizedCode]
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].activo) {
      throw new AppError(409, "El proveedor de pago no esta activo", {
        code: "PAGOS_PROVIDER_INACTIVE",
        details: { proveedor: normalizedCode },
      });
    }
    return existing.rows[0];
  }

  if (normalizedCode !== "mock") {
    throw new AppError(404, "El proveedor solicitado no esta configurado", {
      code: "PAGOS_PROVIDER_NOT_FOUND",
      details: { proveedor: normalizedCode },
    });
  }

  const inserted = await client.query(
    `
      INSERT INTO public.payment_providers (codigo, nombre, activo, configuracion_publica)
      VALUES ('mock', 'Proveedor Mock', TRUE, '{}'::jsonb)
      ON CONFLICT (codigo)
      DO UPDATE SET activo = TRUE, updated_at = now()
      RETURNING id_provider, codigo, nombre, activo
    `
  );

  return inserted.rows[0];
}

function getProviderAdapter(providerCode) {
  if (providerCode === "mock") {
    return new MockPaymentProvider({
      mockResult: safeText(process.env.MOCK_PAYMENT_RESULT) || "PAID",
    });
  }
  return null;
}

function validateWebhookFreshness(request) {
  const timestampHeader = String(request.headers?.["x-webhook-timestamp"] || "").trim();
  if (!timestampHeader) {
    throw new AppError(400, "Cabecera de tiempo de webhook requerida", {
      code: "PAGOS_WEBHOOK_TIMESTAMP_REQUIRED",
    });
  }

  const parsedTs = Number(timestampHeader);
  if (!Number.isFinite(parsedTs)) {
    throw new AppError(400, "Cabecera de tiempo de webhook invalida", {
      code: "PAGOS_WEBHOOK_TIMESTAMP_INVALID",
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const diff = Math.abs(nowSeconds - parsedTs);
  if (diff > Number(process.env.WEBHOOK_REPLAY_WINDOW_SECONDS || 300)) {
    throw new AppError(401, "Webhook fuera de ventana permitida", {
      code: "PAGOS_WEBHOOK_REPLAY_DETECTED",
    });
  }
}

async function loadOwnedAppointment(client, { citaId, clienteId, personaId }) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_sucursal,
        c.total_pagar_hnl,
        c.moneda_codigo,
        c.estado_cita_codigo,
        hold.id_hold,
        hold.estado_hold_codigo,
        hold.expires_at AS hold_expires_at
      FROM public.citas c
      LEFT JOIN LATERAL (
        SELECT h.id_hold, h.estado_hold_codigo, h.expires_at
        FROM public.citas_holds h
        WHERE h.id_cita = c.id_cita
        ORDER BY h.created_at DESC
        LIMIT 1
      ) hold ON TRUE
      WHERE c.id_cita = $1::uuid
        AND c.deleted_at IS NULL
        AND (c.id_cliente = $2::uuid OR c.id_persona_cliente = $3::uuid)
      LIMIT 1
    `,
    [citaId, clienteId, personaId]
  );
  return rows[0] ?? null;
}

async function expireHoldAndAppointment(client, { idIntent = null, idCita, idHold = null }) {
  if (idIntent) {
    await client.query(
      `
        UPDATE public.payment_intents
        SET estado_intent_codigo = 'expirado',
            updated_at = now()
        WHERE id_intent = $1::uuid
      `,
      [idIntent]
    );
  }

  await client.query(
    `
      UPDATE public.citas
      SET estado_cita_codigo = 'expirada',
          updated_at = now()
      WHERE id_cita = $1::uuid
        AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    `,
    [idCita]
  );

  if (idHold) {
    await client.query(
      `
        UPDATE public.citas_holds
        SET estado_hold_codigo = 'expirado',
            updated_at = now()
        WHERE id_hold = $1::uuid
          AND estado_hold_codigo = 'activo'
      `,
      [idHold]
    );
  }
}

export default async function pagosRoutes(app) {
  app.post(
    "/crear-intent",
    {
      config: {
        rateLimit: {
          max: Number(process.env.PAGOS_CREAR_INTENT_RATE_LIMIT_MAX || 20),
          timeWindow: process.env.PAGOS_CREAR_INTENT_RATE_LIMIT_WINDOW || "1 minute",
        },
      },
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_cita"],
          properties: {
            id_cita: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_intent: { type: "string", format: "uuid" },
                  payment_url: { type: ["string", "null"], format: "uri" },
                  expires_at: { type: "string", format: "date-time" },
                  monto_hnl: { type: "number" },
                  moneda_codigo: { type: "string" },
                  estado_intent_codigo: { type: "string" },
                },
                required: ["id_intent", "payment_url", "expires_at", "monto_hnl", "moneda_codigo", "estado_intent_codigo"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_intent: { type: "string", format: "uuid" },
                  payment_url: { type: ["string", "null"], format: "uri" },
                  expires_at: { type: "string", format: "date-time" },
                  monto_hnl: { type: "number" },
                  moneda_codigo: { type: "string" },
                  estado_intent_codigo: { type: "string" },
                },
                required: ["id_intent", "payment_url", "expires_at", "monto_hnl", "moneda_codigo", "estado_intent_codigo"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();

      try {
        await expireStaleAppointmentReservations(dbClient, { logger: request.log });
        const { clienteId, personaId, usuarioId } = ensureClientContext(request);
        const citaId = assertUuid(request.body?.id_cita, "id_cita");
        const configuredProvider = safeText(app.config?.paymentProvider || process.env.PAYMENT_PROVIDER)?.toLowerCase() || "mock";
        if (app.config?.isProduction && configuredProvider === "mock") {
          throw new AppError(500, "Proveedor de pago no permitido en produccion", {
            code: "PAGOS_PROVIDER_MOCK_FORBIDDEN",
          });
        }
        const providerAdapter = PaymentProviderFactory.create();

        await dbClient.query("BEGIN");
        const provider = await ensureProvider(dbClient, configuredProvider);
        const cita = await loadOwnedAppointment(dbClient, { citaId, clienteId, personaId });

        if (!cita) {
          throw new AppError(404, "La cita indicada no existe", {
            code: "PAGOS_CITA_NOT_FOUND",
            details: { id_cita: citaId },
          });
        }

        const completedAppointmentPayment = await dbClient.query(
          `
            SELECT 1
            FROM public.payment_intents paid_intent
            JOIN public.payments payment
              ON payment.id_intent = paid_intent.id_intent
             AND payment.estado_pago_codigo = 'capturado'
            WHERE paid_intent.id_cita = $1::uuid
            LIMIT 1
          `,
          [cita.id_cita]
        );
        if (completedAppointmentPayment.rows[0]) {
          throw new AppError(409, "Este pago ya fue procesado.", {
            code: "PAYMENT_ALREADY_COMPLETED",
          });
        }

        if (!["en_espera", "pendiente_pago"].includes(cita.estado_cita_codigo)) {
          throw new AppError(409, "La cita no esta disponible para iniciar pago", {
            code: "PAGOS_CITA_STATE_INVALID",
            details: { estado_cita_codigo: cita.estado_cita_codigo },
          });
        }

        if (!cita.id_hold || cita.estado_hold_codigo !== "activo") {
          throw new AppError(409, "La cita no tiene un hold activo para iniciar pago", {
            code: "PAGOS_HOLD_REQUIRED",
          });
        }

        const holdExpiresAt = new Date(cita.hold_expires_at);
        if (Number.isNaN(holdExpiresAt.getTime()) || holdExpiresAt.getTime() <= Date.now()) {
          await expireHoldAndAppointment(dbClient, {
            idCita: cita.id_cita,
            idHold: cita.id_hold,
          });
          throw new AppError(409, "El hold de la cita ya expiro", {
            code: "PAGOS_HOLD_EXPIRED",
            details: { id_cita: cita.id_cita },
          });
        }

        await dbClient.query(
          `SELECT id_hold FROM public.citas_holds WHERE id_hold = $1::uuid FOR UPDATE`,
          [cita.id_hold]
        );

        const completedPayment = await dbClient.query(
          `
            SELECT 1
            FROM public.payment_intents paid_intent
            JOIN public.payments payment
              ON payment.id_intent = paid_intent.id_intent
             AND payment.estado_pago_codigo = 'capturado'
            WHERE paid_intent.id_hold = $1::uuid
            LIMIT 1
          `,
          [cita.id_hold]
        );
        if (completedPayment.rows[0]) {
          throw new AppError(409, "Este pago ya fue procesado.", {
            code: "PAYMENT_ALREADY_COMPLETED",
          });
        }

        const existingIntent = await dbClient.query(
          `
            SELECT id_intent, link_pago_url, expires_at, monto_hnl, moneda_codigo, estado_intent_codigo
            FROM public.payment_intents
            WHERE id_cita = $1::uuid
              AND id_provider = $2::uuid
              AND created_by_usuario_id = $3::uuid
              AND estado_intent_codigo = ANY($4::text[])
              AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [cita.id_cita, provider.id_provider, usuarioId, ACTIVE_INTENT_STATES]
        );

        if (existingIntent.rows[0]) {
          await dbClient.query("COMMIT");
          return sendOk(reply, {
            id_intent: existingIntent.rows[0].id_intent,
            payment_url: existingIntent.rows[0].link_pago_url ?? null,
            expires_at: new Date(existingIntent.rows[0].expires_at).toISOString(),
            monto_hnl: Number(existingIntent.rows[0].monto_hnl),
            moneda_codigo: existingIntent.rows[0].moneda_codigo,
            estado_intent_codigo: existingIntent.rows[0].estado_intent_codigo,
          });
        }

        const intentSummary = await dbClient.query(
          `
            SELECT COUNT(*)::int AS intent_count
            FROM public.payment_intents
            WHERE id_hold = $1::uuid
          `,
          [cita.id_hold]
        );
        if (Number(intentSummary.rows[0]?.intent_count || 0) >= MAX_PAYMENT_INTENTS_PER_HOLD) {
          throw new AppError(
            409,
            "No pudimos procesar el pago despues de varios intentos. Puedes iniciar una nueva reserva o contactar a MasterFade.",
            { code: "PAYMENT_RETRY_LIMIT_REACHED" }
          );
        }

        const idempotencyKey = `mf_${cita.id_cita}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const callbackUrl = buildCallbackUrl(cita.id_cita);
        const amount = Number(cita.total_pagar_hnl ?? 0);
        const currency = safeText(cita.moneda_codigo) || "HNL";

        const providerIntent = await providerAdapter.createIntent({
          idempotencyKey,
          montoHnl: amount,
          moneda: currency,
          descripcion: `Reserva de cita ${cita.id_cita}`,
          callbackUrl,
          metadata: {
            id_cita: cita.id_cita,
            id_cliente: clienteId,
            id_sucursal: cita.id_sucursal,
          },
        });

        const createdIntent = await dbClient.query(
          `
            INSERT INTO public.payment_intents (
              id_provider,
              id_cita,
              id_hold,
              estado_intent_codigo,
              monto_hnl,
              moneda_codigo,
              link_pago_url,
              referencia_externa,
              idempotency_key,
              expires_at,
              created_by_usuario_id
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              'link_generado',
              $4::numeric,
              $5::text,
              $6::text,
              $7::text,
              $8::text,
              $9::timestamptz,
              $10::uuid
            )
            RETURNING id_intent, link_pago_url, expires_at, monto_hnl, moneda_codigo, estado_intent_codigo
          `,
          [
            provider.id_provider,
            cita.id_cita,
            cita.id_hold,
            amount,
            currency,
            providerIntent.paymentUrl ?? null,
            providerIntent.providerIntentId ?? null,
            idempotencyKey,
            holdExpiresAt.toISOString(),
            usuarioId,
          ]
        );

        await dbClient.query(
          `
            UPDATE public.citas
            SET estado_cita_codigo = 'pendiente_pago',
                updated_at = now()
            WHERE id_cita = $1::uuid
              AND estado_cita_codigo = 'en_espera'
          `,
          [cita.id_cita]
        );

        await dbClient.query("COMMIT");

        return sendOk(
          reply,
          {
            id_intent: createdIntent.rows[0].id_intent,
            payment_url: createdIntent.rows[0].link_pago_url ?? null,
            expires_at: new Date(createdIntent.rows[0].expires_at).toISOString(),
            monto_hnl: Number(createdIntent.rows[0].monto_hnl),
            moneda_codigo: createdIntent.rows[0].moneda_codigo,
            estado_intent_codigo: createdIntent.rows[0].estado_intent_codigo,
          },
          { statusCode: 201 }
        );
      } catch (error) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // no-op
        }

        return sendHandled(reply, request, error, "No se pudo crear la intencion de pago", "PAGOS_CREATE_INTENT_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.post(
    "/webhook/:proveedor",
    {
      config: {
        rawBody: true,
        rateLimit: {
          max: Number(process.env.PAGOS_WEBHOOK_RATE_LIMIT_MAX || 120),
          timeWindow: process.env.PAGOS_WEBHOOK_RATE_LIMIT_WINDOW || "1 minute",
          allowList: (request) => request.ip === "127.0.0.1" || request.ip === "::1",
        },
      },
      schema: {
        params: {
          type: "object",
          required: ["proveedor"],
          properties: {
            proveedor: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        body: {
          type: "object",
          additionalProperties: true,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  provider: { type: "string" },
                  provider_event_id: { type: "string" },
                  status: { type: "string" },
                  processed: { type: "boolean" },
                  duplicate: { type: "boolean" },
                  extension_pending: { type: "boolean" },
                },
                required: ["provider", "provider_event_id", "status", "processed", "duplicate", "extension_pending"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();

      try {
        validateWebhookFreshness(request);

        const providerCode = String(request.params?.proveedor || "").trim().toLowerCase();
        const body = request.body && typeof request.body === "object" ? request.body : {};
        const providerIntentId = safeText(body.provider_intent_id ?? body.providerIntentId ?? body.referencia_externa);
        const intentIdempotencyKey = safeText(body.idempotency_key ?? body.idempotencyKey);
        const normalizedStatus = normalizeProviderStatus(body.status ?? body.estado ?? body.mock_result);
        const providerEventId = safeText(
          body.provider_event_id
          ?? body.event_id
          ?? body.eventId
          ?? body.idempotency_key
          ?? body.idempotencyKey
          ?? (providerIntentId ? `${providerIntentId}:${normalizedStatus}` : null)
        );
        const providerTxId = safeText(body.provider_tx_id ?? body.transaction_id ?? body.tx_id)
          ?? `tx_${providerCode}_${providerEventId || request.id}`;

        if (!providerCode) {
          throw new AppError(400, "El parametro proveedor es obligatorio", {
            code: "PAGOS_WEBHOOK_PROVIDER_REQUIRED",
          });
        }
        if (!providerEventId) {
          throw new AppError(400, "No se pudo determinar el identificador idempotente del evento", {
            code: "PAGOS_WEBHOOK_EVENT_ID_REQUIRED",
          });
        }
        if (!providerIntentId && !intentIdempotencyKey) {
          throw new AppError(400, "El webhook requiere provider_intent_id o idempotency_key", {
            code: "PAGOS_WEBHOOK_INTENT_REFERENCE_REQUIRED",
          });
        }

        const providerAdapter = getProviderAdapter(providerCode);
        const signature = safeText(request.headers?.["x-signature"] ?? request.headers?.["x-webhook-signature"]);
        const rawBody = String(request.rawBody || "");

        if (providerCode === "mock") {
          const expectedMockSecret = safeText(process.env.MOCK_WEBHOOK_SECRET);
          if (expectedMockSecret && signature !== expectedMockSecret) {
            throw new AppError(401, "Firma de webhook invalida", {
              code: "PAGOS_WEBHOOK_SIGNATURE_INVALID",
            });
          }
        } else if (!providerAdapter) {
          throw new AppError(400, "Proveedor de webhook no soportado", {
            code: "PAGOS_WEBHOOK_PROVIDER_UNSUPPORTED",
          });
        }

        if (!rawBody) {
          throw new AppError(400, "Cuerpo de webhook invalido", {
            code: "PAGOS_WEBHOOK_RAW_BODY_REQUIRED",
          });
        }

        if (providerAdapter && !providerAdapter.verifyWebhookSignature(rawBody, signature)) {
          throw new AppError(401, "Firma de webhook invalida", {
            code: "PAGOS_WEBHOOK_SIGNATURE_INVALID",
          });
        }

        await dbClient.query("BEGIN");
        const provider = await ensureProvider(dbClient, providerCode);

        const insertedEvent = await dbClient.query(
          `
            INSERT INTO public.payment_events (
              id_provider,
              provider_event_id,
              evento_tipo,
              firma_valida,
              payload_esencial
            )
            VALUES (
              $1::uuid,
              $2::text,
              $3::text,
              $4::boolean,
              $5::jsonb
            )
            ON CONFLICT (id_provider, provider_event_id)
            DO NOTHING
            RETURNING id_event
          `,
          [
            provider.id_provider,
            providerEventId,
            `payment.${normalizedStatus}`,
            providerAdapter ? true : false,
            {
              provider_intent_id: providerIntentId,
              idempotency_key: intentIdempotencyKey,
              status: normalizedStatus,
              provider_tx_id: providerTxId,
            },
          ]
        );

        if (!insertedEvent.rows[0]) {
          await dbClient.query("COMMIT");
          return sendOk(reply, {
            provider: providerCode,
            provider_event_id: providerEventId,
            status: normalizedStatus,
            processed: false,
            duplicate: true,
            extension_pending: false,
          });
        }

        const intentLookup = await dbClient.query(
          `
            SELECT
              pi.id_intent,
              pi.id_cita,
              pi.id_hold,
              pi.monto_hnl,
              pi.moneda_codigo
            FROM public.payment_intents pi
            WHERE pi.id_provider = $1::uuid
              AND (
                ($2::text IS NOT NULL AND pi.referencia_externa = $2::text)
                OR ($3::text IS NOT NULL AND pi.idempotency_key = $3::text)
              )
            ORDER BY pi.created_at DESC
            LIMIT 1
          `,
          [provider.id_provider, providerIntentId, intentIdempotencyKey]
        );

        const intent = intentLookup.rows[0] ?? null;
        if (!intent) {
          await dbClient.query(
            `
              UPDATE public.payment_events
              SET procesado_at = now(),
                  resultado_procesamiento = 'intent_no_encontrado'
              WHERE id_provider = $1::uuid
                AND provider_event_id = $2::text
            `,
            [provider.id_provider, providerEventId]
          );

          await dbClient.query("COMMIT");
          return sendOk(reply, {
            provider: providerCode,
            provider_event_id: providerEventId,
            status: normalizedStatus,
            processed: false,
            duplicate: false,
            extension_pending: false,
          });
        }

        if (providerCode !== "mock") {
          await dbClient.query(
            `
              UPDATE public.payment_events
              SET id_intent = $1::uuid,
                  procesado_at = now(),
                  resultado_procesamiento = $2::text
              WHERE id_provider = $3::uuid
                AND provider_event_id = $4::text
            `,
            [
              intent.id_intent,
              `proveedor_${providerCode}_pendiente_extension`,
              provider.id_provider,
              providerEventId,
            ]
          );

          await dbClient.query("COMMIT");
          return sendOk(reply, {
            provider: providerCode,
            provider_event_id: providerEventId,
            status: normalizedStatus,
            processed: false,
            duplicate: false,
            extension_pending: true,
          });
        }

        let paymentId = null;

        if (normalizedStatus === "paid") {
          const insertedPayment = await dbClient.query(
            `
              INSERT INTO public.payments (
                id_intent,
                estado_pago_codigo,
                provider_tx_id,
                monto_hnl,
                moneda_codigo,
                paid_at,
                registrado_manualmente
              )
              VALUES (
                $1::uuid,
                'capturado',
                $2::text,
                $3::numeric,
                $4::text,
                now(),
                false
              )
              ON CONFLICT (provider_tx_id)
              DO UPDATE SET updated_at = now()
              RETURNING id_payment
            `,
            [
              intent.id_intent,
              providerTxId,
              Number(intent.monto_hnl ?? 0),
              safeText(intent.moneda_codigo) || "HNL",
            ]
          );

          paymentId = insertedPayment.rows[0]?.id_payment ?? null;
        } else if (normalizedStatus === "failed" || normalizedStatus === "expired") {
          await expireHoldAndAppointment(dbClient, {
            idIntent: intent.id_intent,
            idCita: intent.id_cita,
            idHold: intent.id_hold,
          });
        } else {
          await dbClient.query(
            `
              UPDATE public.payment_intents
              SET estado_intent_codigo = 'pendiente_confirmacion',
                  updated_at = now()
              WHERE id_intent = $1::uuid
            `,
            [intent.id_intent]
          );

          await dbClient.query(
            `
              UPDATE public.citas
              SET estado_cita_codigo = 'pendiente_pago',
                  updated_at = now()
              WHERE id_cita = $1::uuid
                AND estado_cita_codigo = 'en_espera'
            `,
            [intent.id_cita]
          );
        }

        await dbClient.query(
          `
            UPDATE public.payment_events
            SET id_intent = $1::uuid,
                id_payment = $2::uuid,
                procesado_at = now(),
                resultado_procesamiento = $3::text
            WHERE id_provider = $4::uuid
              AND provider_event_id = $5::text
          `,
          [
            intent.id_intent,
            paymentId,
            normalizedStatus === "paid"
              ? "pago_aplicado"
              : normalizedStatus === "pending"
                ? "pago_pendiente"
                : "pago_no_exitoso",
            provider.id_provider,
            providerEventId,
          ]
        );

        await dbClient.query("COMMIT");

        return sendOk(reply, {
          provider: providerCode,
          provider_event_id: providerEventId,
          status: normalizedStatus,
          processed: true,
          duplicate: false,
          extension_pending: false,
        });
      } catch (error) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // no-op
        }

        return sendHandled(reply, request, error, "No se pudo procesar el webhook de pago", "PAGOS_WEBHOOK_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );
}
