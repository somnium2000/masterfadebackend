import { AppError } from "../utils/errors.js";

function safeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const at = email.indexOf("@");
  if (at <= 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function resolvePaymentsFromAlias() {
  const fromAddress = safeText(process.env.SMTP_FROM_PAYMENTS) || safeText(process.env.SMTP_FROM) || null;
  if (!fromAddress) return null;
  if (fromAddress.includes("<")) return fromAddress;
  return `MasterFade Pagos <${fromAddress}>`;
}

function formatDateTimeHn(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "Fecha por confirmar";
  return parsed.toLocaleString("es-HN", { timeZone: "America/Tegucigalpa" });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  return `HNL ${roundMoney(value || 0).toFixed(2)}`;
}

function formatSelectionTypeLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "package" || normalized === "paquete") return "Paquete";
  if (normalized === "mixed" || normalized === "mixto") return "Paquete + servicios";
  return "Servicios";
}

function resolveAppointmentDetailLabel(cita) {
  const packageName = safeText(cita?.paquete?.nombre_paquete_snapshot);
  const serviceNames = Array.isArray(cita?.servicios)
    ? cita.servicios
      .map((servicio) => safeText(servicio?.nombre_servicio_snapshot))
      .filter(Boolean)
    : [];

  if (packageName && serviceNames.length) {
    return `${packageName} (${serviceNames.join(", ")})`;
  }
  if (packageName) return packageName;
  if (serviceNames.length) return serviceNames.join(", ");
  return "Servicios";
}

function buildMemberLookup(integrantes) {
  const rows = Array.isArray(integrantes) ? integrantes : [];
  const lookup = new Map();
  for (const row of rows) {
    const order = Number(row?.orden_integrante);
    if (!Number.isFinite(order)) continue;
    lookup.set(order, row);
  }
  return lookup;
}

function buildComprobanteEmailTemplate({ recipientName, comprobante, payload }) {
  const safeName = safeText(recipientName) || "Cliente";
  const codigoComprobante = safeText(comprobante?.codigo_comprobante) || "N/A";
  const codigoReserva = safeText(comprobante?.codigo_reserva_snapshot) || safeText(payload?.codigo_reserva) || "N/A";
  const sucursal = safeText(payload?.sucursal?.nombre_sucursal) || "Sucursal";
  const citas = Array.isArray(payload?.citas) ? payload.citas : [];
  const integrantesByOrder = buildMemberLookup(payload?.integrantes);
  const detailRows = citas.map((cita, index) => {
    const order = Number(cita?.orden_integrante);
    const member = Number.isFinite(order) ? integrantesByOrder.get(order) : null;
    const alias = safeText(member?.alias_integrante)
      || safeText(member?.nombre)
      || `Integrante ${Number.isFinite(order) && order > 0 ? order : index + 1}`;
    const fecha = formatDateTimeHn(cita?.fecha_inicio);
    const selection = formatSelectionTypeLabel(cita?.selection_type);
    const label = resolveAppointmentDetailLabel(cita);
    const totalLabel = formatMoney(cita?.total_pagar_hnl ?? cita?.total_hnl ?? 0);
    return {
      alias,
      fecha,
      selection,
      label,
      totalLabel,
      text: `${alias}: ${fecha} - ${selection} - ${label} - ${totalLabel}`,
    };
  });
  const detailLines = detailRows.map((row) => row.text);

  const totals = payload?.totales || {};
  const subtotal = formatMoney(totals.subtotal_hnl || 0);
  const descuento = formatMoney(totals.descuento_hnl || 0);
  const isv = formatMoney(totals.isv_hnl || 0);
  const total = formatMoney(totals.total_pagar_hnl ?? totals.total_hnl ?? 0);

  const subject = `Comprobante de agendamiento #${codigoReserva}`;
  const text = [
    `Hola ${safeName},`,
    "",
    "Tu reserva fue confirmada y este es tu comprobante de agendamiento no fiscal.",
    `Codigo de reserva: ${codigoReserva}`,
    `Codigo de comprobante: ${codigoComprobante}`,
    `Sucursal: ${sucursal}`,
    "",
    "Detalle de citas:",
    ...(detailLines.length ? detailLines.map((line) => `- ${line}`) : ["- Sin detalle disponible"]),
    "",
    `Subtotal: ${subtotal}`,
    `Descuento: ${descuento}`,
    `ISV: ${isv}`,
    `Total: ${total}`,
    "",
    "Nota: Este comprobante es no fiscal y no sustituye una factura fiscal.",
  ].join("\n");

  const detailHtml = detailRows.length
    ? detailRows.map((row) => `
                      <tr>
                        <td style="padding:12px 0;border-bottom:1px solid #252a39;">
                          <p style="margin:0 0 4px;color:#f4f6fb;font-size:14px;font-weight:700;">${escapeHtml(row.alias)}</p>
                          <p style="margin:0 0 4px;color:#d9dce4;font-size:14px;line-height:1.5;">${escapeHtml(row.fecha)}</p>
                          <p style="margin:0;color:#aeb5c5;font-size:13px;line-height:1.5;">${escapeHtml(row.selection)} - ${escapeHtml(row.label)}</p>
                        </td>
                        <td align="right" style="padding:12px 0 12px 12px;border-bottom:1px solid #252a39;color:#d4b068;font-size:14px;font-weight:700;white-space:nowrap;">${escapeHtml(row.totalLabel)}</td>
                      </tr>
    `).join("")
    : `
                      <tr>
                        <td style="padding:12px 0;color:#d9dce4;font-size:14px;line-height:1.5;">Sin detalle disponible</td>
                      </tr>
    `;

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(subject)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade Citas</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">Comprobante de agendamiento</h1>
                    <p style="margin:8px 0 0;color:#d4b068;font-size:14px;font-weight:700;">No fiscal</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">Hola ${escapeHtml(safeName)},</p>
                    <p style="margin:0 0 16px;color:#d9dce4;font-size:15px;line-height:1.7;">Tu reserva fue confirmada. Este es tu comprobante de agendamiento no fiscal.</p>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border:1px solid #2b2f3f;border-radius:12px;background:#1a1f2e;">
                      <tr>
                        <td style="padding:12px 14px;">
                          <p style="margin:0 0 8px;color:#aeb5c5;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Reserva</p>
                          <p style="margin:0;color:#f8f9fb;font-size:16px;font-weight:800;">${escapeHtml(codigoReserva)}</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0 14px 12px;">
                          <p style="margin:0;color:#d9dce4;font-size:14px;line-height:1.6;"><strong style="color:#f4f6fb;">Comprobante:</strong> ${escapeHtml(codigoComprobante)}</p>
                          <p style="margin:4px 0 0;color:#d9dce4;font-size:14px;line-height:1.6;"><strong style="color:#f4f6fb;">Sucursal:</strong> ${escapeHtml(sucursal)}</p>
                        </td>
                      </tr>
                    </table>

                    <p style="margin:0 0 8px;color:#f4f6fb;font-size:14px;font-weight:700;">Detalle de citas</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;">
${detailHtml}
                    </table>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #2b2f3f;border-radius:12px;background:#10141f;">
                      <tr>
                        <td style="padding:12px 14px 6px;color:#aeb5c5;font-size:14px;">Subtotal</td>
                        <td align="right" style="padding:12px 14px 6px;color:#f4f6fb;font-size:14px;">${escapeHtml(subtotal)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 14px;color:#aeb5c5;font-size:14px;">Descuento</td>
                        <td align="right" style="padding:6px 14px;color:#f4f6fb;font-size:14px;">${escapeHtml(descuento)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 14px;color:#aeb5c5;font-size:14px;">ISV</td>
                        <td align="right" style="padding:6px 14px;color:#f4f6fb;font-size:14px;">${escapeHtml(isv)}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px 12px;border-top:1px solid #2b2f3f;color:#f8f9fb;font-size:16px;font-weight:800;">Total</td>
                        <td align="right" style="padding:10px 14px 12px;border-top:1px solid #2b2f3f;color:#d4b068;font-size:16px;font-weight:800;">${escapeHtml(total)}</td>
                      </tr>
                    </table>

                    <p style="margin:16px 0 0;color:#8f98aa;font-size:12px;line-height:1.6;">Nota: Este comprobante es no fiscal y no sustituye una factura fiscal.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  return { subject, text, html };
}

async function withServiceClient({ client, pool, app }, fn) {
  if (client && typeof client.query === "function" && typeof client.release !== "function") {
    return fn(client);
  }

  const sourcePool = (pool && typeof pool.connect === "function")
    ? pool
    : (app?.db && typeof app.db.connect === "function" ? app.db : null);
  if (!sourcePool) {
    throw new AppError(500, "No se pudo procesar envio de comprobante.", {
      code: "BOOKING_RECEIPT_SEND_FAILED",
    });
  }

  const dbClient = await sourcePool.connect();
  try {
    return await fn(dbClient);
  } finally {
    dbClient.release();
  }
}

export async function confirmarComprobanteAgendamientoParaEnvio({
  client,
  logger = null,
  id_grupo_cita,
  resultadoReservaCodigo = "confirmada",
  comprobanteEmailHabilitado = true,
} = {}) {
  const lookup = await client.query(
    `
      SELECT
        id_comprobante_agendamiento,
        estado_comprobante_codigo,
        resultado_reserva_codigo
      FROM public.comprobantes_agendamiento
      WHERE id_grupo_cita = $1::uuid
      LIMIT 1
    `,
    [id_grupo_cita]
  );
  const comprobante = lookup.rows[0];
  if (!comprobante) {
    return { found: false };
  }

  const counts = await client.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'pendiente')::int AS pendientes,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'enviado')::int AS enviados,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'fallo')::int AS fallos,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'omitido')::int AS omitidos
      FROM public.comprobantes_agendamiento_destinatarios
      WHERE id_comprobante_agendamiento = $1::uuid
    `,
    [comprobante.id_comprobante_agendamiento]
  );
  const stats = counts.rows[0] || {
    total: 0, pendientes: 0, enviados: 0, fallos: 0, omitidos: 0,
  };

  let nextState = comprobante.estado_comprobante_codigo || "generado";
  if (comprobanteEmailHabilitado && Number(stats.pendientes) > 0) {
    nextState = "pendiente_envio";
  } else if (!comprobanteEmailHabilitado && logger?.warn) {
    logger.warn(
      { code: "BOOKING_RECEIPT_EMAIL_DISABLED", id_grupo_cita },
      "Confirmacion de reserva con envio de comprobante deshabilitado."
    );
  }

  await client.query(
    `
      UPDATE public.comprobantes_agendamiento
      SET resultado_reserva_codigo = $2::text,
          estado_comprobante_codigo = $3::text,
          updated_at = now()
      WHERE id_comprobante_agendamiento = $1::uuid
    `,
    [comprobante.id_comprobante_agendamiento, resultadoReservaCodigo, nextState]
  );

  return {
    found: true,
    id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
    estado_comprobante_codigo: nextState,
    resultado_reserva_codigo: resultadoReservaCodigo,
    destinatarios_totales: Number(stats.total || 0),
    destinatarios_pendientes: Number(stats.pendientes || 0),
  };
}

export async function actualizarEstadoAgregadoComprobante({
  client,
  logger = null,
  id_comprobante_agendamiento,
  comprobanteEmailHabilitado = true,
} = {}) {
  const countResult = await client.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'pendiente')::int AS pendientes,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'enviado')::int AS enviados,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'fallo')::int AS fallos,
        COUNT(*) FILTER (WHERE estado_envio_codigo = 'omitido')::int AS omitidos
      FROM public.comprobantes_agendamiento_destinatarios
      WHERE id_comprobante_agendamiento = $1::uuid
    `,
    [id_comprobante_agendamiento]
  );

  const stats = countResult.rows[0] || {
    total: 0, pendientes: 0, enviados: 0, fallos: 0, omitidos: 0,
  };
  const total = Number(stats.total || 0);
  const pendientes = Number(stats.pendientes || 0);
  const enviados = Number(stats.enviados || 0);
  const fallos = Number(stats.fallos || 0);
  const omitidos = Number(stats.omitidos || 0);

  let nextState;
  let emailEnviado = false;
  let emailEnviadoAt = null;

  if (total === 0) {
    nextState = comprobanteEmailHabilitado ? "generado" : "generado";
  } else if (pendientes > 0) {
    nextState = "pendiente_envio";
  } else if (fallos > 0 && enviados === 0 && omitidos === 0) {
    nextState = "fallo_envio";
  } else if (fallos > 0) {
    nextState = "fallo_envio";
  } else {
    nextState = "enviado";
    emailEnviado = true;
    emailEnviadoAt = new Date().toISOString();
  }

  await client.query(
    `
      UPDATE public.comprobantes_agendamiento
      SET estado_comprobante_codigo = $2::text,
          email_enviado = $3::boolean,
          email_enviado_at = CASE WHEN $4::timestamptz IS NULL THEN email_enviado_at ELSE $4::timestamptz END,
          updated_at = now()
      WHERE id_comprobante_agendamiento = $1::uuid
    `,
    [id_comprobante_agendamiento, nextState, emailEnviado, emailEnviadoAt]
  );

  logger?.info?.(
    {
      id_comprobante_agendamiento,
      total,
      pendientes,
      enviados,
      fallos,
      omitidos,
      estado_comprobante_codigo: nextState,
    },
    "Estado agregado de comprobante actualizado."
  );

  return {
    estado_comprobante_codigo: nextState,
    total,
    pendientes,
    enviados,
    fallos,
    omitidos,
  };
}

export async function procesarDestinatariosPendientesComprobante({
  app,
  client,
  logger = null,
  comprobante,
  destinatarios,
} = {}) {
  if (!comprobante?.id_comprobante_agendamiento) {
    throw new AppError(500, "No se pudo procesar envio de comprobante.", {
      code: "BOOKING_RECEIPT_SEND_FAILED",
    });
  }

  const mailer = app?.mailer;
  if (!mailer?.configured) {
    logger?.warn?.(
      { id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento, pendientes: destinatarios.length },
      "SMTP no configurado: comprobante queda pendiente."
    );
    return {
      pending: destinatarios.length,
      sent: 0,
      failed: 0,
      omitted: 0,
      mode: "smtp_unavailable",
    };
  }

  let payload = comprobante.payload_resumen;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  if (!payload || typeof payload !== "object") payload = {};

  const senderFrom = resolvePaymentsFromAlias();
  let sent = 0;
  let failed = 0;
  let omitted = 0;
  let pending;

  for (const row of destinatarios) {
    const recipientEmail = normalizeEmail(row.email_destinatario_snapshot);
    const recipientId = row.id_comprobante_destinatario;
    if (!recipientEmail || !recipientEmail.includes("@")) {
      omitted += 1;
      await client.query(
        `
          UPDATE public.comprobantes_agendamiento_destinatarios
          SET estado_envio_codigo = 'omitido',
              ultimo_error_codigo = 'EMAIL_INVALID',
              ultimo_error_detalle = 'Correo destinatario invalido',
              updated_at = now()
          WHERE id_comprobante_destinatario = $1::uuid
            AND estado_envio_codigo = 'pendiente'
        `,
        [recipientId]
      );
      continue;
    }

    const template = buildComprobanteEmailTemplate({
      recipientName: row.nombre_destinatario_snapshot,
      comprobante,
      payload,
    });

    const delivery = await mailer.sendMail({
      to: recipientEmail,
      subject: template.subject,
      text: template.text,
      html: template.html,
      from: senderFrom,
    });

    if (delivery?.sent) {
      sent += 1;
      await client.query(
        `
          UPDATE public.comprobantes_agendamiento_destinatarios
          SET estado_envio_codigo = 'enviado',
              enviado_at = now(),
              intento_envio_count = intento_envio_count + 1,
              ultimo_error_codigo = null,
              ultimo_error_detalle = null,
              updated_at = now()
          WHERE id_comprobante_destinatario = $1::uuid
            AND estado_envio_codigo = 'pendiente'
        `,
        [recipientId]
      );
      continue;
    }

    failed += 1;
    const safeError = safeText(delivery?.message) || "No se pudo enviar por SMTP";
    await client.query(
      `
        UPDATE public.comprobantes_agendamiento_destinatarios
        SET estado_envio_codigo = 'fallo',
            intento_envio_count = intento_envio_count + 1,
            ultimo_error_codigo = 'SMTP_SEND_FAILED',
            ultimo_error_detalle = $2::text,
            updated_at = now()
        WHERE id_comprobante_destinatario = $1::uuid
          AND estado_envio_codigo = 'pendiente'
      `,
      [recipientId, safeError.slice(0, 250)]
    );

    logger?.warn?.(
      {
        id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
        id_comprobante_destinatario: recipientId,
        email_masked: maskEmail(recipientEmail),
      },
      "Fallo envio de comprobante para destinatario."
    );
  }

  const pendingResult = await client.query(
    `
      SELECT COUNT(*)::int AS pendientes
      FROM public.comprobantes_agendamiento_destinatarios
      WHERE id_comprobante_agendamiento = $1::uuid
        AND estado_envio_codigo = 'pendiente'
    `,
    [comprobante.id_comprobante_agendamiento]
  );
  pending = Number(pendingResult.rows[0]?.pendientes || 0);

  return { sent, failed, omitted, pending, mode: "smtp" };
}

export async function enviarComprobanteAgendamientoNoFiscal({
  app,
  pool = null,
  client = null,
  logger = null,
  id_grupo_cita,
  id_comprobante_agendamiento = null,
  modo = "post_confirmacion",
  comprobanteEmailHabilitado = true,
} = {}) {
  return withServiceClient({ client, pool, app }, async (dbClient) => {
    const lookup = await dbClient.query(
      `
        SELECT
          id_comprobante_agendamiento,
          id_grupo_cita,
          codigo_comprobante,
          codigo_reserva_snapshot,
          estado_comprobante_codigo,
          resultado_reserva_codigo,
          payload_resumen
        FROM public.comprobantes_agendamiento
        WHERE ($1::uuid IS NULL OR id_comprobante_agendamiento = $1::uuid)
          AND ($2::uuid IS NULL OR id_grupo_cita = $2::uuid)
        LIMIT 1
      `,
      [id_comprobante_agendamiento, id_grupo_cita || null]
    );
    const comprobante = lookup.rows[0];
    if (!comprobante) {
      throw new AppError(404, "No se encontro comprobante para la reserva indicada.", {
        code: "BOOKING_RECEIPT_NOT_FOUND",
      });
    }

    const lockKey = `mf:comprobante:${comprobante.id_comprobante_agendamiento}`;
    const lockTry = await dbClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey]
    );
    const locked = Boolean(lockTry.rows[0]?.locked);
    if (!locked) {
      return {
        source: "normalized",
        mode: modo,
        id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
        skipped: true,
        reason: "LOCKED",
        pending: 0,
        sent: 0,
        failed: 0,
        omitted: 0,
      };
    }

    try {
      const recipients = await dbClient.query(
        `
          SELECT
            id_comprobante_destinatario,
            tipo_destinatario_codigo,
            nombre_destinatario_snapshot,
            email_destinatario_snapshot,
            estado_envio_codigo
          FROM public.comprobantes_agendamiento_destinatarios
          WHERE id_comprobante_agendamiento = $1::uuid
            AND estado_envio_codigo = 'pendiente'
          ORDER BY created_at ASC
        `,
        [comprobante.id_comprobante_agendamiento]
      );

      if (!comprobanteEmailHabilitado) {
        await actualizarEstadoAgregadoComprobante({
          client: dbClient,
          logger,
          id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
          comprobanteEmailHabilitado,
        });
        return {
          source: "normalized",
          mode: modo,
          id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
          skipped: true,
          reason: "EMAIL_DISABLED",
          pending: Number(recipients.rows.length || 0),
          sent: 0,
          failed: 0,
          omitted: 0,
        };
      }

      const delivery = await procesarDestinatariosPendientesComprobante({
        app,
        client: dbClient,
        logger,
        comprobante,
        destinatarios: recipients.rows,
      });
      const aggregate = await actualizarEstadoAgregadoComprobante({
        client: dbClient,
        logger,
        id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
        comprobanteEmailHabilitado,
      });

      return {
        source: "normalized",
        mode: modo,
        id_comprobante_agendamiento: comprobante.id_comprobante_agendamiento,
        pending: delivery.pending,
        sent: delivery.sent,
        failed: delivery.failed,
        omitted: delivery.omitted,
        estado_comprobante_codigo: aggregate.estado_comprobante_codigo,
      };
    } finally {
      await dbClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    }
  });
}
