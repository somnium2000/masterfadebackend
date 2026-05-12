import { AppError } from "../utils/errors.js";
import { PaymentProviderFactory } from "./payments/PaymentProviderFactory.js";
import { normalizePaymentProviderCode } from "./payments/paymentRuntimeGuard.js";
import { getAgendamientoConfig } from "./agendaService.js";
import { applyRewardRedeemForConfirmedGroup } from "./pointsService.js";
import { crearComprobanteAgendamientoNoFiscal } from "./comprobanteAgendamientoService.js";
import {
  confirmarComprobanteAgendamientoParaEnvio,
  enviarComprobanteAgendamientoNoFiscal,
} from "./comprobanteAgendamientoEmailService.js";

const PAID_STATUSES = ["paid", "success", "succeeded", "captured", "capturado", "aprobado"];
const FAILED_STATUSES = ["failed", "fail", "declined", "error", "rejected", "fallido"];
const EXPIRED_STATUSES = ["expired", "timeout", "cancelled", "canceled", "expirado"];

function safeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function safeUuid(value) {
  const normalized = safeText(value);
  if (!normalized) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

function normalizeProviderCode(value) {
  const provider = normalizePaymentProviderCode(value);
  if (!provider) {
    throw new AppError(400, "Proveedor de webhook requerido", {
      code: "PAYMENT_WEBHOOK_PROVIDER_REQUIRED",
    });
  }
  return provider;
}

function normalizeProviderStatus(value) {
  const status = safeText(value)?.toLowerCase() || "pending";
  if (PAID_STATUSES.includes(status)) return "paid";
  if (FAILED_STATUSES.includes(status)) return "failed";
  if (EXPIRED_STATUSES.includes(status)) return "expired";
  return "pending";
}

function getHeader(headers, names) {
  for (const name of names) {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    if (Array.isArray(value)) return safeText(value[0]);
    const normalized = safeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeWebhookEvent({ providerCode, body, requestId }) {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};
  const providerReference = safeText(
    payload.provider_intent_id
      ?? payload.providerIntentId
      ?? payload.provider_reference
      ?? payload.providerReference
      ?? payload.referencia_externa
      ?? metadata.provider_intent_id
      ?? metadata.provider_reference
  );
  const idempotencyKey = safeText(
    payload.idempotency_key
      ?? payload.idempotencyKey
      ?? metadata.idempotency_key
      ?? metadata.idempotencyKey
  );
  const idIntent = safeUuid(payload.id_intent ?? payload.intent_id ?? metadata.id_intent ?? metadata.intent_id);
  const idGrupoCita = safeUuid(payload.id_grupo_cita ?? metadata.id_grupo_cita);
  const idCita = safeUuid(payload.id_cita ?? metadata.id_cita ?? metadata.id_cita_anchor);
  const status = normalizeProviderStatus(payload.status ?? payload.estado ?? payload.mock_result ?? payload.payment_status);
  const providerEventId = safeText(
    payload.provider_event_id
      ?? payload.event_id
      ?? payload.eventId
      ?? payload.id_evento
      ?? payload.id
      ?? idempotencyKey
      ?? (providerReference ? `${providerReference}:${status}` : null)
  );

  if (!providerEventId) {
    throw new AppError(400, "No se pudo determinar el identificador del evento", {
      code: "PAYMENT_WEBHOOK_EVENT_ID_REQUIRED",
    });
  }

  if (!providerReference && !idempotencyKey && !idIntent && !idGrupoCita && !idCita) {
    throw new AppError(400, "Webhook sin referencia de pago reconocible", {
      code: "PAYMENT_WEBHOOK_REFERENCE_REQUIRED",
    });
  }

  const providerTxId = safeText(
    payload.provider_tx_id
      ?? payload.transaction_id
      ?? payload.transactionId
      ?? payload.tx_id
      ?? payload.payment_id
  ) || `tx_${providerCode}_${providerReference || idIntent || idGrupoCita || providerEventId || requestId}`;

  return {
    providerEventId,
    eventType: safeText(payload.evento_tipo ?? payload.type ?? payload.event_type) || `payment.${status}`,
    status,
    providerReference,
    idempotencyKey,
    idIntent,
    idGrupoCita,
    idCita,
    providerTxId,
    payloadEsencial: {
      status,
      provider_reference: providerReference,
      idempotency_key: idempotencyKey,
      id_intent: idIntent,
      id_grupo_cita: idGrupoCita,
      id_cita: idCita,
      provider_tx_id: providerTxId,
    },
  };
}

function validateWebhookSignature({ providerCode, adapter, headers, rawBody }) {
  const signature = getHeader(headers, [
    "x-webhook-signature",
    "x-signature",
    "x-provider-signature",
  ]);

  if (providerCode === "mock") {
    const expectedMockSecret = safeText(process.env.MOCK_WEBHOOK_SECRET);
    if (expectedMockSecret && signature !== expectedMockSecret) {
      throw new AppError(401, "Firma de webhook invalida", {
        code: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
      });
    }
    return true;
  }

  if (typeof adapter?.verifyWebhookSignature !== "function") {
    throw new AppError(501, "El proveedor no implementa validacion de firma webhook", {
      code: "PAYMENT_WEBHOOK_SIGNATURE_NOT_IMPLEMENTED",
    });
  }

  if (!rawBody) {
    throw new AppError(400, "Body crudo requerido para validar firma webhook", {
      code: "PAYMENT_WEBHOOK_RAW_BODY_REQUIRED",
    });
  }

  let valid;
  try {
    valid = adapter.verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    throw new AppError(401, "Firma de webhook invalida", {
      code: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
      cause: error,
    });
  }

  if (!valid) {
    throw new AppError(401, "Firma de webhook invalida", {
      code: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
    });
  }
  return true;
}

async function ensureProvider(client, providerCode) {
  const found = await client.query(
    `
      SELECT id_provider, codigo, nombre, activo
      FROM public.payment_providers
      WHERE codigo = $1::text
      LIMIT 1
    `,
    [providerCode]
  );
  const provider = found.rows[0];
  if (!provider) {
    throw new AppError(404, "Proveedor de pago no configurado", {
      code: "PAYMENT_WEBHOOK_PROVIDER_NOT_FOUND",
      details: { provider: providerCode },
    });
  }
  if (!provider.activo) {
    throw new AppError(409, "Proveedor de pago inactivo", {
      code: "PAYMENT_WEBHOOK_PROVIDER_INACTIVE",
      details: { provider: providerCode },
    });
  }
  return provider;
}

async function findIntentForEvent(client, { providerId, event }) {
  const result = await client.query(
    `
      SELECT
        pi.id_intent,
        pi.id_cita,
        pi.id_hold,
        pi.estado_intent_codigo,
        pi.monto_hnl,
        pi.moneda_codigo,
        c.id_grupo_cita
      FROM public.payment_intents pi
      LEFT JOIN public.citas c
        ON c.id_cita = pi.id_cita
       AND c.deleted_at IS NULL
      WHERE pi.id_provider = $1::uuid
        AND (
          ($2::uuid IS NOT NULL AND pi.id_intent = $2::uuid)
          OR ($3::text IS NOT NULL AND pi.referencia_externa = $3::text)
          OR ($4::text IS NOT NULL AND pi.idempotency_key = $4::text)
          OR ($5::uuid IS NOT NULL AND c.id_grupo_cita = $5::uuid)
          OR ($6::uuid IS NOT NULL AND pi.id_cita = $6::uuid)
        )
      ORDER BY
        CASE
          WHEN $2::uuid IS NOT NULL AND pi.id_intent = $2::uuid THEN 0
          WHEN $3::text IS NOT NULL AND pi.referencia_externa = $3::text THEN 1
          WHEN $4::text IS NOT NULL AND pi.idempotency_key = $4::text THEN 2
          ELSE 3
        END,
        pi.created_at DESC
      LIMIT 1
    `,
    [
      providerId,
      event.idIntent,
      event.providerReference,
      event.idempotencyKey,
      event.idGrupoCita,
      event.idCita,
    ]
  );
  return result.rows[0] ?? null;
}

async function grantCompanionPoints(client, { idGrupoCita }) {
  const titularResult = await client.query(
    `
      SELECT cg.id_cliente_titular AS id_cliente, c.id_usuario
      FROM public.citas_grupos cg
      JOIN public.clientes c
        ON c.id_cliente = cg.id_cliente_titular
      WHERE cg.id_grupo_cita = $1::uuid
      LIMIT 1
    `,
    [idGrupoCita]
  );
  const titular = titularResult.rows[0];
  if (!titular?.id_cliente || !titular?.id_usuario) return;

  const companions = await client.query(
    `
      SELECT id_cita, id_sucursal, inicio_at
      FROM public.citas
      WHERE id_grupo_cita = $1::uuid
        AND deleted_at IS NULL
        AND orden_integrante > 1
        AND estado_cita_codigo = 'confirmada'
      ORDER BY orden_integrante ASC
    `,
    [idGrupoCita]
  );

  for (const companion of companions.rows) {
    const cycleResult = await client.query(
      `SELECT * FROM public.fn_points_get_or_create_active_cycle($1::uuid, $2::int, $3::timestamptz) LIMIT 1`,
      [titular.id_cliente, 12, companion.inicio_at || new Date().toISOString()]
    );
    const cycleId = cycleResult.rows[0]?.id_cycle ?? null;
    if (!cycleId) continue;
    await client.query(
      `
        INSERT INTO public.points_transactions (
          id_cliente,
          id_cita,
          id_cycle,
          id_sucursal_origen,
          tipo_puntos_codigo,
          origen_punto_codigo,
          puntos,
          vence_at,
          motivo,
          creado_por_usuario_id
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          'acumular',
          'integrante',
          1,
          (SELECT vence_at FROM public.points_cycles WHERE id_cycle = $3::uuid),
          'Punto por acompanante pagado',
          $5::uuid
        )
        ON CONFLICT DO NOTHING
      `,
      [titular.id_cliente, companion.id_cita, cycleId, companion.id_sucursal, titular.id_usuario]
    );
  }
}

async function confirmGroupAfterPaid(client, {
  idCitaAnchor,
  agendamientoConfig = null,
  logger = null,
}) {
  const groupResult = await client.query(
    `
      SELECT
        c.id_grupo_cita,
        cg.id_cliente_titular
      FROM public.citas c
      JOIN public.citas_grupos cg
        ON cg.id_grupo_cita = c.id_grupo_cita
      WHERE c.id_cita = $1::uuid
        AND c.deleted_at IS NULL
      LIMIT 1
    `,
    [idCitaAnchor]
  );
  const idGrupoCita = groupResult.rows[0]?.id_grupo_cita ?? null;
  const idClienteTitular = groupResult.rows[0]?.id_cliente_titular ?? null;
  if (!idGrupoCita) return null;

  const totalResult = await client.query(
    `
      SELECT COALESCE(SUM(total_pagar_hnl),0)::numeric AS total
      FROM public.citas
      WHERE id_grupo_cita = $1::uuid
        AND deleted_at IS NULL
    `,
    [idGrupoCita]
  );
  const totalGrupo = Number(totalResult.rows[0]?.total ?? 0);

  await client.query(
    `
      UPDATE public.citas_grupos
      SET total_hnl = $2::numeric,
          updated_at = now()
      WHERE id_grupo_cita = $1::uuid
    `,
    [idGrupoCita, totalGrupo]
  );

  await client.query(
    `
      UPDATE public.citas
      SET estado_cita_codigo = 'confirmada',
          updated_at = now()
      WHERE id_grupo_cita = $1::uuid
        AND deleted_at IS NULL
        AND estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada')
    `,
    [idGrupoCita]
  );

  await client.query(
    `
      UPDATE public.citas_holds h
      SET estado_hold_codigo = 'consumido',
          updated_at = now()
      FROM public.citas c
      WHERE c.id_grupo_cita = $1::uuid
        AND c.id_cita = h.id_cita
        AND h.estado_hold_codigo = 'activo'
    `,
    [idGrupoCita]
  );

  let rewardRedemption = {
    aplicada: false,
    ya_aplicada: false,
    puntos_descontados: 0,
    saldo_actual: null,
  };
  if (idClienteTitular) {
    rewardRedemption = await applyRewardRedeemForConfirmedGroup(client, {
      idGrupoCita,
      idCliente: idClienteTitular,
      motivo: "Canje de recompensa ruta a tu cortesia",
    });
  }

  let receiptConfirm = await confirmarComprobanteAgendamientoParaEnvio({
    client,
    logger,
    id_grupo_cita: idGrupoCita,
    resultadoReservaCodigo: "confirmada",
    comprobanteEmailHabilitado: Boolean(agendamientoConfig?.comprobanteEmailHabilitado),
  });

  if (!receiptConfirm.found) {
    try {
      await crearComprobanteAgendamientoNoFiscal({
        client,
        logger,
        agendamientoConfig,
        id_grupo_cita: idGrupoCita,
      });
      receiptConfirm = await confirmarComprobanteAgendamientoParaEnvio({
        client,
        logger,
        id_grupo_cita: idGrupoCita,
        resultadoReservaCodigo: "confirmada",
        comprobanteEmailHabilitado: Boolean(agendamientoConfig?.comprobanteEmailHabilitado),
      });
    } catch (error) {
      logger?.warn?.(
        {
          err: error,
          code: "BOOKING_RECEIPT_CREATE_ON_PAYMENT_FAILED",
          id_grupo_cita: idGrupoCita,
        },
        "No se pudo crear comprobante normalizado post-pago."
      );
    }
  }

  await grantCompanionPoints(client, { idGrupoCita });
  return {
    id_grupo_cita: idGrupoCita,
    total_hnl: totalGrupo,
    recompensa_utilizada: rewardRedemption,
    comprobante: receiptConfirm.found ? {
      id_comprobante_agendamiento: receiptConfirm.id_comprobante_agendamiento,
      estado_comprobante_codigo: receiptConfirm.estado_comprobante_codigo,
      resultado_reserva_codigo: receiptConfirm.resultado_reserva_codigo,
    } : null,
  };
}

async function expireGroupAfterPaymentFailure(client, { idIntent, idGrupoCita, idCita, idHold, status }) {
  await client.query(
    `
      UPDATE public.payment_intents
      SET estado_intent_codigo = $2::text,
          updated_at = now()
      WHERE id_intent = $1::uuid
    `,
    [idIntent, status === "failed" ? "fallido" : "expirado"]
  );

  if (idGrupoCita) {
    await client.query(
      `
        UPDATE public.citas_grupos
        SET updated_at = now()
        WHERE id_grupo_cita = $1::uuid
      `,
      [idGrupoCita]
    );
    await client.query(
      `
        UPDATE public.citas
        SET estado_cita_codigo = 'expirada',
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
          AND deleted_at IS NULL
          AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
      `,
      [idGrupoCita]
    );
    await client.query(
      `
        UPDATE public.citas_holds h
        SET estado_hold_codigo = 'expirado',
            updated_at = now()
        FROM public.citas c
        WHERE c.id_grupo_cita = $1::uuid
          AND c.id_cita = h.id_cita
          AND h.estado_hold_codigo = 'activo'
      `,
      [idGrupoCita]
    );
    return;
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

async function dispatchReceiptAfterCommit({ app, db, logger, booking, agendamientoConfig }) {
  if (!booking?.id_grupo_cita || !booking?.comprobante?.id_comprobante_agendamiento) return null;
  try {
    return await enviarComprobanteAgendamientoNoFiscal({
      app,
      pool: db,
      logger,
      id_grupo_cita: booking.id_grupo_cita,
      id_comprobante_agendamiento: booking.comprobante.id_comprobante_agendamiento,
      modo: "payment_webhook",
      comprobanteEmailHabilitado: Boolean(agendamientoConfig?.comprobanteEmailHabilitado),
    });
  } catch (error) {
    logger?.warn?.(
      {
        err: error,
        id_grupo_cita: booking.id_grupo_cita,
      },
      "No se pudo enviar comprobante post-pago desde webhook."
    );
    return null;
  }
}

export async function processPaymentWebhook({
  app,
  db,
  providerCode: rawProviderCode,
  headers,
  body,
  rawBody,
  logger,
  requestId,
}) {
  const providerCode = normalizeProviderCode(rawProviderCode);
  let adapter;
  try {
    adapter = PaymentProviderFactory.create({ providerCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proveedor de pago no soportado";
    const mockForbidden = /mock no esta permitido/i.test(message);
    throw new AppError(mockForbidden ? 500 : 501, message, {
      code: mockForbidden ? "PAYMENT_WEBHOOK_PROVIDER_MOCK_FORBIDDEN" : "PAYMENT_WEBHOOK_PROVIDER_UNSUPPORTED",
    });
  }
  const event = normalizeWebhookEvent({ providerCode, body, requestId });
  validateWebhookSignature({ providerCode, adapter, headers, rawBody });

  const client = await db.connect();
  let booking = null;
  let agendamientoConfig = null;
  try {
    await client.query("BEGIN");
    const provider = await ensureProvider(client, providerCode);
    const insertedEvent = await client.query(
      `
        INSERT INTO public.payment_events (
          id_provider,
          provider_event_id,
          evento_tipo,
          firma_valida,
          payload_esencial
        )
        VALUES ($1::uuid, $2::text, $3::text, TRUE, $4::jsonb)
        ON CONFLICT (id_provider, provider_event_id)
        DO NOTHING
        RETURNING id_event
      `,
      [provider.id_provider, event.providerEventId, event.eventType, event.payloadEsencial]
    );

    if (!insertedEvent.rows[0]) {
      await client.query("COMMIT");
      return {
        provider: providerCode,
        provider_event_id: event.providerEventId,
        status: event.status,
        processed: false,
        duplicate: true,
        booking_confirmed: false,
      };
    }

    const intent = await findIntentForEvent(client, {
      providerId: provider.id_provider,
      event,
    });

    if (!intent) {
      await client.query(
        `
          UPDATE public.payment_events
          SET procesado_at = now(),
              resultado_procesamiento = 'intent_no_encontrado'
          WHERE id_provider = $1::uuid
            AND provider_event_id = $2::text
        `,
        [provider.id_provider, event.providerEventId]
      );
      await client.query("COMMIT");
      return {
        provider: providerCode,
        provider_event_id: event.providerEventId,
        status: event.status,
        processed: false,
        duplicate: false,
        booking_confirmed: false,
      };
    }

    let paymentId = null;
    let processingResult = "pago_no_exitoso";
    const intentAlreadyConfirmed = ["confirmado", "pagado", "paid"].includes(
      safeText(intent.estado_intent_codigo)?.toLowerCase()
    );
    if (event.status === "paid") {
      const insertedPayment = await client.query(
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
          VALUES ($1::uuid, 'capturado', $2::text, $3::numeric, $4::text, now(), FALSE)
          ON CONFLICT (provider_tx_id)
          DO UPDATE SET updated_at = now()
          RETURNING id_payment
        `,
        [
          intent.id_intent,
          event.providerTxId,
          Number(intent.monto_hnl || 0),
          safeText(intent.moneda_codigo) || "HNL",
        ]
      );
      paymentId = insertedPayment.rows[0]?.id_payment ?? null;

      await client.query(
        `
          UPDATE public.payment_intents
          SET estado_intent_codigo = 'confirmado',
              updated_at = now()
          WHERE id_intent = $1::uuid
        `,
        [intent.id_intent]
      );

      if (!intentAlreadyConfirmed) {
        agendamientoConfig = await getAgendamientoConfig(client, { logger });
        booking = intent.id_grupo_cita
          ? await confirmGroupAfterPaid(client, {
            idCitaAnchor: intent.id_cita,
            agendamientoConfig,
            logger,
          })
          : null;
      }
      processingResult = intentAlreadyConfirmed ? "intent_ya_confirmado" : "pago_aplicado";
    } else if (event.status === "failed" || event.status === "expired") {
      if (intentAlreadyConfirmed) {
        processingResult = "intent_ya_confirmado_evento_ignorado";
      } else {
        await expireGroupAfterPaymentFailure(client, {
          idIntent: intent.id_intent,
          idGrupoCita: intent.id_grupo_cita,
          idCita: intent.id_cita,
          idHold: intent.id_hold,
          status: event.status,
        });
        processingResult = "pago_no_exitoso";
      }
    } else {
      await client.query(
        `
          UPDATE public.payment_intents
          SET estado_intent_codigo = 'pendiente_confirmacion',
              updated_at = now()
          WHERE id_intent = $1::uuid
            AND estado_intent_codigo IN ('creado', 'link_generado')
        `,
        [intent.id_intent]
      );
      if (intent.id_grupo_cita) {
        await client.query(
          `
            UPDATE public.citas_grupos
            SET updated_at = now()
            WHERE id_grupo_cita = $1::uuid
          `,
          [intent.id_grupo_cita]
        );
      }
      processingResult = intentAlreadyConfirmed ? "intent_ya_confirmado_evento_ignorado" : "pago_pendiente";
    }

    await client.query(
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
        processingResult,
        provider.id_provider,
        event.providerEventId,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }

  const emailDelivery = event.status === "paid"
    ? await dispatchReceiptAfterCommit({ app, db, logger, booking, agendamientoConfig })
    : null;

  return {
    provider: providerCode,
    provider_event_id: event.providerEventId,
    status: event.status,
    processed: true,
    duplicate: false,
    booking_confirmed: Boolean(booking?.id_grupo_cita),
    booking,
    email_delivery: emailDelivery,
  };
}
