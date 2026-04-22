import crypto from "node:crypto";
import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { PaymentProviderFactory } from "../../../services/payments/PaymentProviderFactory.js";

const ACTIVE_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];

function safeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function assertUuid(value, field = "id") {
  const normalized = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new AppError(400, `${field} invalido`, { code: "PUBLIC_PAGOS_INVALID_UUID", details: { field } });
  }
  return normalized;
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hashString(value) {
  const source = String(value || "");
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function buildBookingShortCode(value, length = 5) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "N/A";
  const safeLength = Math.max(3, Math.min(5, Number(length) || 5));
  const maxValue = 36 ** safeLength;
  const hashed = hashString(normalized) % maxValue;
  return hashed
    .toString(36)
    .toUpperCase()
    .padStart(safeLength, "0")
    .slice(-safeLength);
}

function formatDateTimeHn(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "Fecha por confirmar";
  return parsed.toLocaleString("es-HN", { timeZone: "America/Tegucigalpa" });
}

function resolvePaymentsFromAlias() {
  const fromAddress = safeText(process.env.SMTP_FROM_PAYMENTS) || safeText(process.env.SMTP_FROM) || null;
  if (!fromAddress) return null;
  if (fromAddress.includes("<")) return fromAddress;
  return `MasterFade Pagos <${fromAddress}>`;
}

function buildPostPaymentEmailTemplate({
  recipientName,
  bookingCode,
  groupId,
  totalGrupo,
  detailLines,
}) {
  const safeName = safeText(recipientName) || "Cliente";
  const safeCode = safeText(bookingCode) || "N/A";
  const safeGroupId = safeText(groupId) || "N/D";
  const moneyLabel = `HNL ${Number(totalGrupo || 0).toFixed(2)}`;
  const detailList = Array.isArray(detailLines) ? detailLines : [];
  const detailHtml = detailList
    .map((line) => `<li style="margin:0 0 6px;color:#d9dce4;font-size:14px;line-height:1.6;">${escapeHtml(line)}</li>`)
    .join("");
  const detailText = detailList.map((line) => `- ${line}`);
  const title = `Reserva confirmada #${safeCode}`;
  const text = [
    title,
    "",
    `Hola ${safeName},`,
    "",
    "Tu reserva fue confirmada después de validar el pago.",
    `Código de cita: ${safeCode}`,
    `Total pagado: ${moneyLabel}`,
    "",
    "Detalle:",
    ...detailText,
  ].join("\n");

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade Pagos</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">Hola ${escapeHtml(safeName)},</p>
                    <p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">Tu reserva fue confirmada después de validar el pago.</p>
                    <div style="margin:0 0 14px;border:1px solid #2b2f3f;border-radius:12px;padding:10px 12px;background:#1a1f2e;">
                      <p style="margin:0;color:#f8f9fb;font-size:14px;font-weight:700;">Código de cita: ${escapeHtml(safeCode)}</p>
                      <p style="margin:6px 0 0;color:#d4b068;font-size:14px;">Total pagado: ${escapeHtml(moneyLabel)}</p>
                    </div>
                    <p style="margin:0 0 8px;color:#f4f6fb;font-size:14px;font-weight:600;">Detalle:</p>
                    <ul style="margin:0 0 10px 18px;padding:0;">${detailHtml}</ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  return {
    subject: title,
    text,
    html,
  };
}

function buildCallbackUrl(groupId) {
  const base = safeText(process.env.PUBLIC_WEB_URL) || safeText(process.env.FRONTEND_PUBLIC_URL) || "http://localhost:5173";
  return `${base.replace(/\/+$/, "")}/agendar/exito?id_grupo_cita=${encodeURIComponent(groupId)}`;
}

async function ensureProvider(client, providerCode) {
  const code = String(providerCode || "mock").trim().toLowerCase();
  if (!code) {
    throw new AppError(400, "Proveedor de pago requerido", { code: "PUBLIC_PAGOS_PROVIDER_REQUIRED" });
  }
  const found = await client.query(
    `SELECT id_provider, codigo, nombre, activo FROM public.payment_providers WHERE codigo = $1::text LIMIT 1`,
    [code]
  );
  if (found.rows[0]) {
    if (!found.rows[0].activo) {
      throw new AppError(409, "El proveedor de pago no esta activo", { code: "PUBLIC_PAGOS_PROVIDER_INACTIVE" });
    }
    return found.rows[0];
  }
  const inserted = await client.query(
    `
      INSERT INTO public.payment_providers (codigo, nombre, activo, configuracion_publica)
      VALUES ($1::text, $2::text, TRUE, '{}'::jsonb)
      RETURNING id_provider, codigo, nombre, activo
    `,
    [code, code === "mock" ? "Proveedor Mock" : `Proveedor ${code}`]
  );
  return inserted.rows[0];
}

async function loadPublicGroup(client, { groupId, titularEmail }) {
  const result = await client.query(
    `
      SELECT
        cg.id_grupo_cita,
        cg.id_cliente_titular,
        cg.id_persona_titular,
        c.id_cita,
        c.orden_integrante,
        c.estado_cita_codigo,
        c.total_pagar_hnl,
        hold.id_hold,
        hold.estado_hold_codigo,
        hold.expires_at,
        co.direccion_correo
      FROM public.citas_grupos cg
      JOIN public.citas c
        ON c.id_grupo_cita = cg.id_grupo_cita
       AND c.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT h.id_hold, h.estado_hold_codigo, h.expires_at
        FROM public.citas_holds h
        WHERE h.id_cita = c.id_cita
        ORDER BY h.created_at DESC
        LIMIT 1
      ) hold ON TRUE
      LEFT JOIN public.correos co
        ON co.id_persona = cg.id_persona_titular
       AND co.deleted_at IS NULL
       AND co.es_principal IS TRUE
      WHERE cg.id_grupo_cita = $1::uuid
      ORDER BY c.orden_integrante ASC, c.created_at ASC
    `,
    [groupId]
  );
  if (!result.rows.length) {
    throw new AppError(404, "La reserva indicada no existe", { code: "PUBLIC_PAGOS_GROUP_NOT_FOUND" });
  }
  const normalizedTitularEmail = normalizeEmail(titularEmail);
  const dbTitularEmail = normalizeEmail(result.rows[0]?.direccion_correo || "");
  if (normalizedTitularEmail && dbTitularEmail && normalizedTitularEmail !== dbTitularEmail) {
    throw new AppError(403, "No tienes permisos para operar esta reserva", { code: "PUBLIC_PAGOS_GROUP_FORBIDDEN" });
  }
  return result.rows;
}

async function resolvePublicIntentCreatorUserId(client, { groupRows }) {
  const titularClientId = groupRows?.[0]?.id_cliente_titular ?? null;
  if (titularClientId) {
    const ownerResult = await client.query(
      `
        SELECT id_usuario
        FROM public.clientes
        WHERE id_cliente = $1::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [titularClientId]
    );
    const ownerUserId = ownerResult.rows[0]?.id_usuario ?? null;
    if (ownerUserId) return ownerUserId;
  }

  const fallbackResult = await client.query(
    `
      SELECT u.id_usuario
      FROM public.usuarios u
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'activo') = 'activo'
      ORDER BY u.created_at ASC
      LIMIT 1
    `
  );
  const fallbackUserId = fallbackResult.rows[0]?.id_usuario ?? null;
  if (!fallbackUserId) {
    throw new AppError(500, "No se pudo iniciar el pago", {
      code: "PUBLIC_PAGOS_SYSTEM_USER_NOT_FOUND",
    });
  }

  return fallbackUserId;
}

async function queuePostPaymentEmails(client, { idGrupoCita, totalGrupo }) {
  const rows = await client.query(
    `
      SELECT
        c.id_cita,
        c.alias_integrante,
        c.orden_integrante,
        c.contacto_nombre,
        c.contacto_email,
        c.inicio_at,
        c.total_pagar_hnl,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Barbero') AS nombre_barbero
      FROM public.citas c
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC
    `,
    [idGrupoCita]
  );
  const blocks = rows.rows;
  if (!blocks.length) return;
  const detailLines = blocks.map((item) => {
    const dateLabel = formatDateTimeHn(item.inicio_at);
    return `${item.alias_integrante || `Integrante ${item.orden_integrante}`}: ${dateLabel} con ${item.nombre_barbero}`;
  });
  const bookingCode = buildBookingShortCode(idGrupoCita, 5);
  const subject = `Reserva confirmada #${bookingCode}`;
  const sentEmails = new Set();
  for (const block of blocks) {
    const to = normalizeEmail(block.contacto_email);
    if (!to || sentEmails.has(to)) continue;
    sentEmails.add(to);
    const body = [
      `Hola ${block.contacto_nombre || block.alias_integrante || "Cliente"},`,
      "",
      "Tu reserva fue confirmada después de validar el pago.",
      `Código de cita: ${bookingCode}`,
      `Total pagado: HNL ${Number(totalGrupo || 0).toFixed(2)}`,
      "",
      "Detalle:",
      ...detailLines.map((line) => `- ${line}`),
    ].join("\n");
    await client.query(
      `
        INSERT INTO public.notificaciones_email (
          evento,
          correo_destino,
          asunto,
          cuerpo,
          estado_notificacion_codigo,
          id_cita
        )
        VALUES ('cita_confirmada_post_pago', $1::text, $2::text, $3::text, 'pendiente', $4::uuid)
      `,
      [to, subject, body, block.id_cita]
    );
  }
}

async function dispatchPostPaymentEmails(client, { idGrupoCita, mailer, logger }) {
  const queued = await client.query(
    `
      SELECT
        ne.id_notificacion,
        ne.correo_destino,
        ne.asunto,
        ne.cuerpo
      FROM public.notificaciones_email ne
      JOIN public.citas c
        ON c.id_cita = ne.id_cita
      WHERE c.id_grupo_cita = $1::uuid
        AND ne.evento = 'cita_confirmada_post_pago'
        AND ne.estado_notificacion_codigo = 'pendiente'
      ORDER BY ne.created_at ASC
    `,
    [idGrupoCita]
  );

  if (!queued.rows.length) {
    return { pending: 0, sent: 0, failed: 0 };
  }

  if (!mailer?.configured) {
    logger?.warn?.(
      { idGrupoCita, pending: queued.rows.length },
      "SMTP no configurado: notificaciones post-pago quedan en pendiente"
    );
    return { pending: queued.rows.length, sent: 0, failed: 0 };
  }

  const groupRows = await client.query(
    `
      SELECT
        c.alias_integrante,
        c.orden_integrante,
        c.contacto_nombre,
        c.contacto_email,
        c.inicio_at,
        c.total_pagar_hnl,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Barbero') AS nombre_barbero
      FROM public.citas c
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC
    `,
    [idGrupoCita]
  );

  const groupBlocks = groupRows.rows;
  const totalGrupo = groupBlocks.reduce((sum, row) => sum + Number(row.total_pagar_hnl || 0), 0);
  const bookingCode = buildBookingShortCode(idGrupoCita, 5);
  const detailLines = groupBlocks.map((item) => {
    const dateLabel = formatDateTimeHn(item.inicio_at);
    return `${item.alias_integrante || `Integrante ${item.orden_integrante}`}: ${dateLabel} con ${item.nombre_barbero}`;
  });
  const recipientMap = new Map();
  for (const block of groupBlocks) {
    const email = normalizeEmail(block?.contacto_email);
    if (!email) continue;
    recipientMap.set(email, {
      name: safeText(block?.contacto_nombre) || safeText(block?.alias_integrante) || "Cliente",
    });
  }
  const senderFrom = resolvePaymentsFromAlias();
  let sent = 0;
  let failed = 0;
  for (const row of queued.rows) {
    const to = normalizeEmail(row?.correo_destino);
    if (!to) {
      failed += 1;
      await client.query(
        `
          UPDATE public.notificaciones_email
          SET estado_notificacion_codigo = 'fallida',
              ultimo_error = 'Correo destino invalido',
              updated_at = now()
          WHERE id_notificacion = $1::uuid
        `,
        [row.id_notificacion]
      );
      continue;
    }

    const recipient = recipientMap.get(to) || { name: "Cliente" };
    const template = buildPostPaymentEmailTemplate({
      recipientName: recipient.name,
      bookingCode,
      groupId: idGrupoCita,
      totalGrupo,
      detailLines,
    });

    const delivery = await mailer.sendMail({
      to,
      subject: template.subject,
      text: template.text,
      html: template.html,
      from: senderFrom,
    });

    if (delivery?.sent) {
      sent += 1;
      await client.query(
        `
          UPDATE public.notificaciones_email
          SET estado_notificacion_codigo = 'enviada',
              enviado_en = now(),
              ultimo_error = null,
              updated_at = now()
          WHERE id_notificacion = $1::uuid
        `,
        [row.id_notificacion]
      );
      continue;
    }

    failed += 1;
    const errorText = safeText(delivery?.message) || "No se pudo enviar por SMTP";
    await client.query(
      `
        UPDATE public.notificaciones_email
        SET estado_notificacion_codigo = 'fallida',
            ultimo_error = $2::text,
            updated_at = now()
        WHERE id_notificacion = $1::uuid
      `,
      [row.id_notificacion, errorText]
    );
  }

  return { pending: queued.rows.length, sent, failed };
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
          'Punto por acompañante pagado',
          $5::uuid
        )
        ON CONFLICT DO NOTHING
      `,
      [titular.id_cliente, companion.id_cita, cycleId, companion.id_sucursal, titular.id_usuario]
    );
  }
}

async function confirmGroupAfterPaid(client, { idCitaAnchor }) {
  const groupResult = await client.query(
    `SELECT id_grupo_cita FROM public.citas WHERE id_cita = $1::uuid AND deleted_at IS NULL LIMIT 1`,
    [idCitaAnchor]
  );
  const idGrupoCita = groupResult.rows[0]?.id_grupo_cita ?? null;
  if (!idGrupoCita) return null;

  const totalResult = await client.query(
    `SELECT COALESCE(SUM(total_pagar_hnl),0)::numeric AS total FROM public.citas WHERE id_grupo_cita = $1::uuid AND deleted_at IS NULL`,
    [idGrupoCita]
  );
  const totalGrupo = Number(totalResult.rows[0]?.total ?? 0);

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

  await queuePostPaymentEmails(client, { idGrupoCita, totalGrupo });
  await grantCompanionPoints(client, { idGrupoCita });
  return { id_grupo_cita: idGrupoCita, total_hnl: totalGrupo };
}

export default async function publicPagosRoutes(app) {
  app.post("/crear-intent", {
    schema: {
      body: {
        type: "object",
        required: ["id_grupo_cita", "titular_email"],
        properties: {
          id_grupo_cita: { type: "string", format: "uuid" },
          titular_email: { type: "string", format: "email", maxLength: 160 },
          nombre_apellido: { type: "string", maxLength: 180 },
          dni: { type: "string", maxLength: 40 },
          telefono: { type: "string", maxLength: 24 },
          direccion: { type: "string", maxLength: 240 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await dbClient.query("BEGIN");
      const idGrupoCita = assertUuid(request.body?.id_grupo_cita, "id_grupo_cita");
      const titularEmail = normalizeEmail(request.body?.titular_email);
      const providerCode = safeText(app.config?.paymentProvider || process.env.PAYMENT_PROVIDER)?.toLowerCase() || "mock";
      const groupRows = await loadPublicGroup(dbClient, { groupId: idGrupoCita, titularEmail });
      const createdByUserId = await resolvePublicIntentCreatorUserId(dbClient, { groupRows });
      const invalidState = groupRows.some((row) => !["en_espera", "pendiente_pago"].includes(String(row.estado_cita_codigo || "")));
      if (invalidState) {
        throw new AppError(409, "La reserva no esta disponible para pago", { code: "PUBLIC_PAGOS_GROUP_STATE_INVALID" });
      }
      const expiredHold = groupRows.some((row) => row.estado_hold_codigo !== "activo" || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now());
      if (expiredHold) {
        throw new AppError(409, "El hold de la reserva ya expiro", { code: "PUBLIC_PAGOS_HOLD_EXPIRED" });
      }
      const provider = await ensureProvider(dbClient, providerCode);
      const anchor = groupRows[0];
      const totalGroup = groupRows.reduce((acc, row) => acc + Number(row.total_pagar_hnl || 0), 0);
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
          [anchor.id_cita, provider.id_provider, createdByUserId, ACTIVE_INTENT_STATES]
        );
      if (existingIntent.rows[0]) {
        await dbClient.query("COMMIT");
        return sendOk(reply, {
          id_intent: existingIntent.rows[0].id_intent,
          payment_url: existingIntent.rows[0].link_pago_url ?? null,
          expires_at: new Date(existingIntent.rows[0].expires_at).toISOString(),
          monto_hnl: Number(existingIntent.rows[0].monto_hnl || 0),
          moneda_codigo: existingIntent.rows[0].moneda_codigo || "HNL",
          estado_intent_codigo: existingIntent.rows[0].estado_intent_codigo,
        });
      }

      const idempotencyKey = `mf_public_${idGrupoCita}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const providerAdapter = PaymentProviderFactory.create();
      const providerIntent = await providerAdapter.createIntent({
        idempotencyKey,
        montoHnl: totalGroup,
        moneda: "HNL",
        descripcion: `Reserva publica ${idGrupoCita}`,
        callbackUrl: buildCallbackUrl(idGrupoCita),
        metadata: {
          id_grupo_cita: idGrupoCita,
          id_cita_anchor: anchor.id_cita,
        },
      });

      const created = await dbClient.query(
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
            'HNL',
            $5::text,
            $6::text,
            $7::text,
            $8::timestamptz,
            $9::uuid
          )
          RETURNING id_intent, link_pago_url, expires_at, monto_hnl, moneda_codigo, estado_intent_codigo
        `,
        [
          provider.id_provider,
          anchor.id_cita,
          anchor.id_hold,
          totalGroup,
          providerIntent.paymentUrl ?? null,
          providerIntent.providerIntentId ?? null,
          idempotencyKey,
          new Date(anchor.expires_at).toISOString(),
          createdByUserId,
        ]
      );

      await dbClient.query(
        `
          UPDATE public.citas
          SET estado_cita_codigo = 'pendiente_pago',
              updated_at = now()
          WHERE id_grupo_cita = $1::uuid
            AND deleted_at IS NULL
            AND estado_cita_codigo = 'en_espera'
        `,
        [idGrupoCita]
      );
      await dbClient.query("COMMIT");
      return sendOk(reply, {
        id_intent: created.rows[0].id_intent,
        payment_url: created.rows[0].link_pago_url ?? null,
        expires_at: new Date(created.rows[0].expires_at).toISOString(),
        monto_hnl: Number(created.rows[0].monto_hnl || 0),
        moneda_codigo: created.rows[0].moneda_codigo || "HNL",
        estado_intent_codigo: created.rows[0].estado_intent_codigo,
      }, { statusCode: 201 });
    } catch (error) {
      try { await dbClient.query("ROLLBACK"); } catch { /* no-op */ }
      if (error instanceof AppError) {
        return sendError(reply, error.statusCode, error.message, { code: error.code, details: error.details, requestId: request.id });
      }
      request.log.error({ err: error }, "No se pudo crear intent publico");
      return sendError(reply, 500, "No se pudo iniciar el pago", { code: "PUBLIC_PAGOS_CREATE_INTENT_ERROR", requestId: request.id });
    } finally {
      dbClient.release();
    }
  });

  app.get("/estado", {
    schema: {
      querystring: {
        type: "object",
        required: ["id_grupo_cita", "id_intent", "titular_email"],
        properties: {
          id_grupo_cita: { type: "string", format: "uuid" },
          id_intent: { type: "string", format: "uuid" },
          titular_email: { type: "string", format: "email", maxLength: 160 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    try {
      const idGrupoCita = assertUuid(request.query?.id_grupo_cita, "id_grupo_cita");
      const idIntent = assertUuid(request.query?.id_intent, "id_intent");
      const titularEmail = normalizeEmail(request.query?.titular_email);
      const groupRows = await loadPublicGroup(app.db, { groupId: idGrupoCita, titularEmail });
      const intentResult = await app.db.query(
        `
          SELECT id_intent, estado_intent_codigo, expires_at, monto_hnl, moneda_codigo
          FROM public.payment_intents
          WHERE id_intent = $1::uuid
          LIMIT 1
        `,
        [idIntent]
      );
      if (!intentResult.rows[0]) {
        throw new AppError(404, "Intent de pago no encontrado", { code: "PUBLIC_PAGOS_INTENT_NOT_FOUND" });
      }
      const allConfirmed = groupRows.every((row) => String(row.estado_cita_codigo || "") === "confirmada");
      if (allConfirmed) {
        try {
          await dispatchPostPaymentEmails(app.db, {
            idGrupoCita,
            mailer: app.mailer,
            logger: request.log,
          });
        } catch (dispatchError) {
          request.log.error(
            { err: dispatchError, idGrupoCita, requestId: request.id },
            "No se pudo despachar correo post-pago al consultar estado"
          );
        }
      }
      return sendOk(reply, {
        id_intent: idIntent,
        estado_intent_codigo: intentResult.rows[0].estado_intent_codigo,
        booking_confirmed: allConfirmed,
        expires_at: intentResult.rows[0].expires_at ? new Date(intentResult.rows[0].expires_at).toISOString() : null,
        monto_hnl: Number(intentResult.rows[0].monto_hnl || 0),
        moneda_codigo: intentResult.rows[0].moneda_codigo || "HNL",
        id_grupo_cita: idGrupoCita,
      });
    } catch (error) {
      if (error instanceof AppError) {
        return sendError(reply, error.statusCode, error.message, { code: error.code, details: error.details, requestId: request.id });
      }
      request.log.error({ err: error }, "No se pudo consultar estado de pago publico");
      return sendError(reply, 500, "No se pudo consultar el estado del pago", { code: "PUBLIC_PAGOS_STATUS_ERROR", requestId: request.id });
    }
  });

  app.post("/mock-completar", {
    schema: {
      body: {
        type: "object",
        required: ["id_intent", "titular_email"],
        properties: {
          id_intent: { type: "string", format: "uuid" },
          titular_email: { type: "string", format: "email", maxLength: 160 },
          provider_event_id: { type: "string", maxLength: 120 },
          status: { type: "string", enum: ["paid", "failed", "expired"] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      const idIntent = assertUuid(request.body?.id_intent, "id_intent");
      const status = safeText(request.body?.status)?.toLowerCase() || "paid";
      const providerEventId = safeText(request.body?.provider_event_id) || `mock_${idIntent}_${status}`;
      await dbClient.query("BEGIN");
      const intentResult = await dbClient.query(
        `
          SELECT pi.id_intent, pi.id_cita, pi.id_provider, pi.monto_hnl, pi.moneda_codigo
          FROM public.payment_intents pi
          WHERE pi.id_intent = $1::uuid
          LIMIT 1
        `,
        [idIntent]
      );
      const intent = intentResult.rows[0];
      if (!intent) {
        throw new AppError(404, "Intent no encontrado", { code: "PUBLIC_PAGOS_INTENT_NOT_FOUND" });
      }

      const groupLookup = await dbClient.query(
        `SELECT id_grupo_cita FROM public.citas WHERE id_cita = $1::uuid LIMIT 1`,
        [intent.id_cita]
      );
      const idGrupoCita = groupLookup.rows[0]?.id_grupo_cita ?? null;
      if (!idGrupoCita) {
        throw new AppError(409, "No se encontro grupo para el intent", { code: "PUBLIC_PAGOS_GROUP_REFERENCE_MISSING" });
      }
      await loadPublicGroup(dbClient, { groupId: idGrupoCita, titularEmail: request.body?.titular_email });

      const insertedEvent = await dbClient.query(
        `
          INSERT INTO public.payment_events (id_provider, provider_event_id, evento_tipo, firma_valida, payload_esencial, id_intent)
          VALUES ($1::uuid, $2::text, $3::text, TRUE, $4::jsonb, $5::uuid)
          ON CONFLICT (id_provider, provider_event_id)
          DO NOTHING
          RETURNING id_event
        `,
        [intent.id_provider, providerEventId, `payment.${status}`, { status, id_intent: idIntent }, idIntent]
      );
      if (!insertedEvent.rows[0]) {
        await dbClient.query("COMMIT");
        return sendOk(reply, { processed: false, duplicate: true, status });
      }

      if (status === "paid") {
        const providerTxId = `tx_mock_${idIntent}`;
        await dbClient.query(
          `
            INSERT INTO public.payments (
              id_intent, estado_pago_codigo, provider_tx_id, monto_hnl, moneda_codigo, paid_at, registrado_manualmente
            )
            VALUES ($1::uuid, 'capturado', $2::text, $3::numeric, $4::text, now(), FALSE)
            ON CONFLICT (provider_tx_id) DO UPDATE SET updated_at = now()
            RETURNING id_payment
          `,
          [idIntent, providerTxId, Number(intent.monto_hnl || 0), safeText(intent.moneda_codigo) || "HNL"]
        );
        await dbClient.query(
          `UPDATE public.payment_intents SET estado_intent_codigo = 'confirmado', updated_at = now() WHERE id_intent = $1::uuid`,
          [idIntent]
        );
        const confirm = await confirmGroupAfterPaid(dbClient, { idCitaAnchor: intent.id_cita });
        await dbClient.query("COMMIT");
        let emailDelivery = { pending: 0, sent: 0, failed: 0 };
        try {
          emailDelivery = await dispatchPostPaymentEmails(app.db, {
            idGrupoCita,
            mailer: app.mailer,
            logger: request.log,
          });
        } catch (dispatchError) {
          request.log.error(
            { err: dispatchError, idGrupoCita, requestId: request.id },
            "No se pudo despachar correo post-pago al completar pago mock"
          );
        }
        return sendOk(reply, { processed: true, duplicate: false, status, booking: confirm, email_delivery: emailDelivery });
      }

      if (status === "failed" || status === "expired") {
        await dbClient.query(
          `UPDATE public.payment_intents SET estado_intent_codigo = $2::text, updated_at = now() WHERE id_intent = $1::uuid`,
          [idIntent, status === "failed" ? "fallido" : "expirado"]
        );
        await dbClient.query(
          `
            UPDATE public.citas
            SET estado_cita_codigo = 'expirada', updated_at = now()
            WHERE id_grupo_cita = $1::uuid
              AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
          `,
          [idGrupoCita]
        );
      }

      await dbClient.query("COMMIT");
      return sendOk(reply, { processed: true, duplicate: false, status });
    } catch (error) {
      try { await dbClient.query("ROLLBACK"); } catch { /* no-op */ }
      if (error instanceof AppError) {
        return sendError(reply, error.statusCode, error.message, { code: error.code, details: error.details, requestId: request.id });
      }
      request.log.error({ err: error }, "No se pudo completar pago mock");
      return sendError(reply, 500, "No se pudo completar el pago", { code: "PUBLIC_PAGOS_MOCK_COMPLETE_ERROR", requestId: request.id });
    } finally {
      dbClient.release();
    }
  });
}
