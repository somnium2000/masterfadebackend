import crypto from "node:crypto";
import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { PaymentProviderFactory } from "../../../services/payments/PaymentProviderFactory.js";
import { applyRewardRedeemForConfirmedGroup, grantCompanionPointsForConfirmedGroup } from "../../../services/pointsService.js";
import { resolveTodoPagoSimulatedResponse } from "../../../services/payments/todopagoSimulatedResponses.js";
import {
  markPromotionUsagesForGroup,
  previewPromotionsForAppointment,
} from "../../../services/promociones/promocionesService.js";
import { normalizeOperationalDateTime } from "../../../services/agendaService.js";

const ACTIVE_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];
const PUBLIC_PAYMENT_CONFIRMABLE_STATES = new Set(ACTIVE_INTENT_STATES);
const PUBLIC_POST_PAYMENT_CONFIRMABLE_APPOINTMENT_STATES = new Set(["en_espera", "pendiente_pago"]);
const PUBLIC_POST_PAYMENT_BLOCKING_APPOINTMENT_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon", "en_atencion"];

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

function normalizeMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Number(amount.toFixed(2));
}

function amountsMatch(left, right) {
  return Math.abs(normalizeMoney(left) - normalizeMoney(right)) < 0.01;
}

function normalizePercentage(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Number(Math.min(parsed, 100).toFixed(2));
}

function calculateLineIsv({ subtotalHnl, descuentoHnl, isvPorcentaje, incluyeIsv }) {
  const taxableBase = normalizeMoney(Math.max(0, Number(subtotalHnl || 0) - Number(descuentoHnl || 0)));
  const percentage = normalizePercentage(isvPorcentaje);
  if (percentage <= 0) return 0;
  if (incluyeIsv) {
    return normalizeMoney(taxableBase - (taxableBase / (1 + (percentage / 100))));
  }
  return normalizeMoney((taxableBase * percentage) / 100);
}

function calculateLineTotal({ subtotalHnl, descuentoHnl, isvHnl, incluyeIsv }) {
  const taxableBase = normalizeMoney(Math.max(0, Number(subtotalHnl || 0) - Number(descuentoHnl || 0)));
  return normalizeMoney(taxableBase + (incluyeIsv ? 0 : Number(isvHnl || 0)));
}

function distributeDiscountBySubtotal(detailRows = [], descuentoTotalHnl = 0) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const subtotal = normalizeMoney(rows.reduce((sum, row) => sum + Number(row.subtotal_hnl || 0), 0));
  const requestedDiscount = Math.min(normalizeMoney(descuentoTotalHnl), subtotal);
  let remainingDiscount = requestedDiscount;
  return rows.map((row, index) => {
    const discount = index === rows.length - 1
      ? remainingDiscount
      : normalizeMoney(subtotal > 0 ? (requestedDiscount * Number(row.subtotal_hnl || 0)) / subtotal : 0);
    const safeDiscount = normalizeMoney(Math.max(0, Math.min(discount, remainingDiscount, Number(row.subtotal_hnl || 0))));
    remainingDiscount = normalizeMoney(Math.max(0, remainingDiscount - safeDiscount));
    return safeDiscount;
  });
}

function distributeDiscountByRemainingCapacity(detailRows = [], descuentoTotalHnl = 0) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const capacities = rows.map((row) => normalizeMoney(
    Math.max(0, Number(row.subtotal_hnl || 0) - Number(row.descuento_hnl || 0))
  ));
  const available = normalizeMoney(capacities.reduce((sum, amount) => sum + amount, 0));
  const requestedDiscount = Math.min(normalizeMoney(descuentoTotalHnl), available);
  let remainingDiscount = requestedDiscount;
  return rows.map((row, index) => {
    const capacity = capacities[index] || 0;
    const discount = index === rows.length - 1
      ? remainingDiscount
      : normalizeMoney(available > 0 ? (requestedDiscount * capacity) / available : 0);
    const safeDiscount = normalizeMoney(Math.max(0, Math.min(discount, remainingDiscount, capacity)));
    remainingDiscount = normalizeMoney(Math.max(0, remainingDiscount - safeDiscount));
    return safeDiscount;
  });
}

function assertCompleteAllocation(allocations = [], requestedDiscount = 0, code = "BOOKING_PROMOTION_ALLOCATION_MISMATCH") {
  const assigned = normalizeMoney((Array.isArray(allocations) ? allocations : []).reduce((sum, amount) => sum + Number(amount || 0), 0));
  if (assigned !== normalizeMoney(requestedDiscount)) {
    throw new AppError(409, "No se pudo asignar completamente la promocion persistida", { code });
  }
}

export function applyPersistedPromotionDiscounts(detailRows = [], promotionRows = []) {
  const sourceRows = Array.isArray(detailRows) ? detailRows : [];
  const rows = sourceRows.map((row) => ({
    ...row,
    descuento_hnl: normalizeMoney(row?.descuento_hnl),
    descuento_no_promocional_hnl: 0,
  }));
  const byDetailId = new Map(
    rows
      .map((row) => [String(row.id_cita_detalle || "").trim(), row])
      .filter(([detailId]) => detailId)
  );
  const persistedPromoByDetail = new Map(rows.map((row) => [String(row.id_cita_detalle || "").trim(), 0]));

  for (const promotion of Array.isArray(promotionRows) ? promotionRows : []) {
    const discount = normalizeMoney(promotion?.descuento_calculado_hnl);
    if (discount <= 0) continue;
    const detailId = String(promotion?.id_cita_detalle || "").trim();
    if (detailId) {
      const row = byDetailId.get(detailId);
      if (!row) {
        throw new AppError(409, "La promocion persistida apunta a un detalle inexistente", {
          code: "BOOKING_PROMOTION_ALLOCATION_INVALID",
        });
      }
      const capacity = normalizeMoney(Math.max(0, Number(row.subtotal_hnl || 0)));
      if (discount > capacity) {
        throw new AppError(409, "La promocion persistida supera la capacidad del detalle", {
          code: "BOOKING_PROMOTION_ALLOCATION_MISMATCH",
        });
      }
      persistedPromoByDetail.set(detailId, normalizeMoney((persistedPromoByDetail.get(detailId) || 0) + discount));
      continue;
    }

    const allocations = distributeDiscountByRemainingCapacity(
      rows.map((row) => ({ ...row, descuento_hnl: persistedPromoByDetail.get(String(row.id_cita_detalle || "").trim()) || 0 })),
      discount
    );
    assertCompleteAllocation(allocations, discount);
    rows.forEach((row, index) => {
      const key = String(row.id_cita_detalle || "").trim();
      persistedPromoByDetail.set(key, normalizeMoney((persistedPromoByDetail.get(key) || 0) + Number(allocations[index] || 0)));
    });
  }

  rows.forEach((row) => {
    const key = String(row.id_cita_detalle || "").trim();
    const persistedPromotionDiscount = normalizeMoney(persistedPromoByDetail.get(key) || 0);
    const nonPromotionDiscount = normalizeMoney(Math.max(0, Number(row.descuento_hnl || 0) - persistedPromotionDiscount));
    const finalDiscount = normalizeMoney(nonPromotionDiscount + persistedPromotionDiscount);
    if (finalDiscount > normalizeMoney(row.subtotal_hnl)) {
      throw new AppError(409, "El descuento final supera la capacidad del detalle", {
        code: "BOOKING_PROMOTION_ALLOCATION_MISMATCH",
      });
    }
    row.descuento_no_promocional_hnl = nonPromotionDiscount;
    row.descuento_hnl = finalDiscount;
  });

  return rows;
}

export function buildPaymentDetailRows(detailRows = [], { descuentoTotalHnl = null } = {}) {
  const sourceRows = Array.isArray(detailRows) ? detailRows : [];
  const overrideDiscounts = descuentoTotalHnl === null
    ? null
    : distributeDiscountBySubtotal(sourceRows, descuentoTotalHnl);
  const rows = sourceRows.map((row, index) => {
    const quantity = Math.max(1, Math.trunc(Number(row?.cantidad || 1)));
    const unitPrice = normalizeMoney(row?.precio_unitario_hnl);
    const subtotalHnl = normalizeMoney(row?.subtotal_hnl ?? unitPrice * quantity);
    const incluyeIsvSnapshot = row?.incluye_isv_snapshot === true;
    const isvPorcentaje = normalizePercentage(row?.isv_porcentaje);
    return {
      id_cita_detalle: row?.id_cita_detalle,
      subtotal_hnl: subtotalHnl,
      descuento_hnl: overrideDiscounts ? overrideDiscounts[index] : normalizeMoney(row?.descuento_hnl),
      incluye_isv_snapshot: incluyeIsvSnapshot,
      isv_porcentaje: isvPorcentaje,
      isv_hnl: 0,
      total_linea_hnl: subtotalHnl,
    };
  });

  rows.forEach((row) => {
    row.isv_hnl = calculateLineIsv({
      subtotalHnl: row.subtotal_hnl,
      descuentoHnl: row.descuento_hnl,
      isvPorcentaje: row.isv_porcentaje,
      incluyeIsv: row.incluye_isv_snapshot,
    });
    row.total_linea_hnl = calculateLineTotal({
      subtotalHnl: row.subtotal_hnl,
      descuentoHnl: row.descuento_hnl,
      isvHnl: row.isv_hnl,
      incluyeIsv: row.incluye_isv_snapshot,
    });
  });
  return rows;
}

function classifyPromotionValidationError(error) {
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    return new AppError(409, "La promocion aplicada ya no es valida para esta reserva.", {
      code: "BOOKING_PROMOTION_NO_LONGER_APPLICABLE",
    });
  }
  return new AppError(503, "No se pudo validar la promocion aplicada. Intenta nuevamente.", {
    code: "BOOKING_PROMOTION_VALIDATION_UNAVAILABLE",
  });
}

const PUBLIC_PAGOS_SAFE_DETAIL_KEYS = new Set(["field"]);

function sanitizePublicPagosErrorDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails)) return undefined;
  const safeDetails = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!PUBLIC_PAGOS_SAFE_DETAIL_KEYS.has(key) || value == null) continue;
    safeDetails[key] = String(value).trim().slice(0, 120);
  }
  return Object.keys(safeDetails).length ? safeDetails : undefined;
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
  totalGrupo,
  detailLines,
}) {
  const safeName = safeText(recipientName) || "Cliente";
  const safeCode = safeText(bookingCode) || "N/A";
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

function isTodoPagoSimulationEnabled(app) {
  return app.config?.paymentProvider === "todopago"
    && app.config?.todoPago?.mode === "preprod_simulated"
    && app.config?.todoPago?.simulatedEnabled === true;
}

function resolveTodoPagoSimulationAmount(app, requestedAmount, fallbackAmount) {
  const safeFallback = Number(fallbackAmount || 0);
  if (!isTodoPagoSimulationEnabled(app)) return safeFallback;
  const safeRequested = Number(requestedAmount);
  if (!Number.isFinite(safeRequested) || safeRequested <= 0) return safeFallback;
  return safeRequested;
}

function buildTodoPagoSimulatorEventId(idIntent, responseCode) {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `todopago_sim_${idIntent}_${String(responseCode || "NA").slice(0, 8)}_${suffix}`.slice(0, 120);
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
        cg.estado_grupo_codigo,
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

function assertPublicGroupPayable(groupRows) {
  const groupState = safeText(groupRows?.[0]?.estado_grupo_codigo)?.toLowerCase() || "";
  if (groupState && groupState !== "activo") {
    throw new AppError(409, "La reserva no esta disponible para pago", { code: "PUBLIC_PAGOS_GROUP_STATE_INVALID" });
  }
  const invalidState = groupRows.some((row) => !["en_espera", "pendiente_pago"].includes(String(row.estado_cita_codigo || "")));
  if (invalidState) {
    throw new AppError(409, "La reserva no esta disponible para pago", { code: "PUBLIC_PAGOS_GROUP_STATE_INVALID" });
  }
}

function calculateGroupTotalFromRows(groupRows = []) {
  return normalizeMoney(groupRows.reduce((sum, row) => sum + Number(row.total_pagar_hnl || 0), 0));
}

async function loadPublicIntentForGroup(client, {
  groupId,
  idIntent,
  titularEmail,
  expectedAmountHnl = null,
}) {
  const groupRows = await loadPublicGroup(client, { groupId, titularEmail });
  const intentResult = await client.query(
    `
      SELECT
        pi.id_intent,
        pi.id_cita,
        pi.id_hold,
        pi.id_provider,
        pi.estado_intent_codigo,
        pi.expires_at,
        pi.monto_hnl,
        pi.moneda_codigo,
        pi.referencia_externa,
        pi.idempotency_key,
        pi.created_by_usuario_id,
        pp.codigo AS provider_code,
        c.id_grupo_cita AS intent_group_id,
        c.estado_cita_codigo AS anchor_estado_cita_codigo,
        hold_c.id_grupo_cita AS intent_hold_group_id,
        hold.estado_hold_codigo AS intent_hold_estado_codigo,
        hold.expires_at AS intent_hold_expires_at
      FROM public.payment_intents pi
      JOIN public.payment_providers pp
        ON pp.id_provider = pi.id_provider
      LEFT JOIN public.citas c
        ON c.id_cita = pi.id_cita
       AND c.deleted_at IS NULL
      LEFT JOIN public.citas_holds hold
        ON hold.id_hold = pi.id_hold
      LEFT JOIN public.citas hold_c
        ON hold_c.id_cita = hold.id_cita
       AND hold_c.deleted_at IS NULL
      WHERE pi.id_intent = $1::uuid
      LIMIT 1
    `,
    [idIntent]
  );
  const intent = intentResult.rows[0];
  if (!intent) {
    throw new AppError(404, "Intent de pago no encontrado", { code: "PUBLIC_PAGOS_INTENT_NOT_FOUND" });
  }

  if (String(intent.intent_group_id || "").trim() !== groupId) {
    throw new AppError(409, "El intent no pertenece a la reserva indicada", {
      code: "PUBLIC_PAGOS_INTENT_GROUP_MISMATCH",
    });
  }
  if (intent.id_hold && String(intent.intent_hold_group_id || "").trim() !== groupId) {
    throw new AppError(409, "El hold del intent no pertenece a la reserva indicada", {
      code: "PUBLIC_PAGOS_INTENT_HOLD_MISMATCH",
    });
  }
  if (expectedAmountHnl !== null && !amountsMatch(intent.monto_hnl, expectedAmountHnl)) {
    throw new AppError(409, "El monto del intent no coincide con la reserva vigente", {
      code: "PUBLIC_PAGOS_INTENT_AMOUNT_MISMATCH",
    });
  }

  return { groupRows, intent };
}

async function loadPostPaymentConfirmableGroup(client, { groupId }) {
  const result = await client.query(
    `
      SELECT
        cg.id_grupo_cita,
        cg.estado_grupo_codigo,
        cg.id_cliente_titular,
        c.id_cita,
        c.id_empleado_barbero,
        c.estado_cita_codigo,
        c.inicio_at,
        c.fin_at,
        hold.id_hold,
        hold.estado_hold_codigo,
        hold.expires_at
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
      WHERE cg.id_grupo_cita = $1::uuid
      ORDER BY c.orden_integrante ASC, c.created_at ASC
      FOR UPDATE OF cg, c
    `,
    [groupId]
  );
  if (!result.rows.length) {
    throw new AppError(404, "La reserva indicada no existe", { code: "PUBLIC_PAGOS_GROUP_NOT_FOUND" });
  }
  return result.rows;
}

function assertPostPaymentGroupConfirmable(groupRows) {
  const groupState = safeText(groupRows?.[0]?.estado_grupo_codigo)?.toLowerCase() || "";
  if (groupState && groupState !== "activo") {
    throw new AppError(409, "La reserva no se puede confirmar en su estado actual", {
      code: "PUBLIC_PAGOS_BOOKING_NOT_CONFIRMABLE",
    });
  }

  const allConfirmed = groupRows.every((row) => String(row.estado_cita_codigo || "").trim().toLowerCase() === "confirmada");
  if (allConfirmed) return { alreadyConfirmed: true };

  const invalidAppointment = groupRows.find((row) => (
    !PUBLIC_POST_PAYMENT_CONFIRMABLE_APPOINTMENT_STATES.has(String(row.estado_cita_codigo || "").trim().toLowerCase())
  ));
  if (invalidAppointment) {
    throw new AppError(409, "La reserva no se puede confirmar en su estado actual", {
      code: "PUBLIC_PAGOS_BOOKING_NOT_CONFIRMABLE",
    });
  }

  const nowMs = Date.now();
  const invalidHold = groupRows.find((row) => {
    const holdState = String(row.estado_hold_codigo || "").trim().toLowerCase();
    const holdExpiresMs = row.expires_at ? new Date(row.expires_at).getTime() : NaN;
    return !row.id_hold
      || holdState !== "activo"
      || !Number.isFinite(holdExpiresMs)
      || holdExpiresMs <= nowMs;
  });
  if (invalidHold) {
    throw new AppError(409, "El hold de la reserva ya no esta activo", {
      code: "PUBLIC_PAGOS_HOLD_EXPIRED",
    });
  }

  return { alreadyConfirmed: false };
}

async function assertNoPostPaymentAvailabilityConflict(client, { groupId, groupRows }) {
  for (const row of groupRows) {
    const blockConflict = await client.query(
      `
        SELECT 1
        FROM public.bloqueos_agenda b
        WHERE b.id_empleado = $1::uuid
          AND b.rango && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        LIMIT 1
      `,
      [row.id_empleado_barbero, row.inicio_at, row.fin_at]
    );
    if (blockConflict.rows[0]) {
      throw new AppError(409, "El horario de la reserva ya no esta disponible", {
        code: "PUBLIC_PAGOS_AVAILABILITY_CONFLICT",
      });
    }

    const appointmentConflict = await client.query(
      `
        SELECT 1
        FROM public.citas c
        WHERE c.id_empleado_barbero = $1::uuid
          AND c.deleted_at IS NULL
          AND c.id_grupo_cita <> $2::uuid
          AND c.estado_cita_codigo = ANY($3::text[])
          AND tstzrange(c.inicio_at, c.fin_at, '[)') && tstzrange($4::timestamptz, $5::timestamptz, '[)')
        LIMIT 1
      `,
      [row.id_empleado_barbero, groupId, PUBLIC_POST_PAYMENT_BLOCKING_APPOINTMENT_STATES, row.inicio_at, row.fin_at]
    );
    if (appointmentConflict.rows[0]) {
      throw new AppError(409, "El horario de la reserva ya no esta disponible", {
        code: "PUBLIC_PAGOS_AVAILABILITY_CONFLICT",
      });
    }
  }
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

async function recalculateGroupPromotionsForPayment(client, { idGrupoCita, logger = null } = {}) {
  const citasResult = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_grupo_cita,
        c.id_sucursal,
        c.id_empleado_barbero,
        c.inicio_at,
        c.selection_type,
        c.id_paquete,
        COALESCE(c.subtotal_servicios_hnl, 0)::numeric AS subtotal_servicios_hnl
      FROM public.citas c
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC, c.created_at ASC
    `,
    [idGrupoCita]
  );

  const promocionesAplicadas = [];
  const promocionesDescartadas = [];
  let subtotal = 0;
  let descuentoTotal = 0;
  let total = 0;
  const appliedGroupPromotionIds = new Set();

  for (const cita of citasResult.rows || []) {
    const detallesResult = await client.query(
      `
        SELECT
          id_cita_detalle,
          id_servicio,
          cantidad,
          precio_unitario_hnl,
          subtotal_hnl,
          descuento_hnl,
          incluye_isv_snapshot,
          isv_porcentaje,
          isv_hnl,
          total_linea_hnl
        FROM public.citas_detalles
        WHERE id_cita = $1::uuid
        ORDER BY id_cita_detalle ASC
      `,
      [cita.id_cita]
    );
    const persistedPromoResult = await client.query(
      `
        SELECT
          id_cita_promocion,
          id_grupo_cita,
          id_cita,
          id_cita_detalle,
          id_cita_paquete,
          id_promocion,
          id_promocion_regla,
          aplica_a_codigo,
          descuento_calculado_hnl,
          prioridad_aplicacion,
          es_acumulable,
          estado_aplicacion_codigo
        FROM public.citas_promociones
        WHERE id_grupo_cita = $1::uuid
          AND (id_cita = $2::uuid OR id_cita IS NULL)
          AND estado_aplicacion_codigo = 'aplicada'
        ORDER BY prioridad_aplicacion ASC, created_at ASC, id_cita_promocion ASC
      `,
      [idGrupoCita, cita.id_cita]
    );
    const persistedPromotions = (persistedPromoResult.rows || []).filter((row) => {
      if (row.id_cita) return true;
      const promotionId = String(row.id_cita_promocion || "").trim();
      if (!promotionId) return false;
      if (appliedGroupPromotionIds.has(promotionId)) return false;
      appliedGroupPromotionIds.add(promotionId);
      return true;
    });
    const detalleSubtotal = normalizeMoney(
      (detallesResult.rows || []).reduce((sum, row) => sum + Number(row.subtotal_hnl || 0), 0)
    );
    const subtotalCita = detalleSubtotal || Number(cita.subtotal_servicios_hnl || 0);

    if (persistedPromotions.length) {
      try {
        const operationalDateTime = normalizeOperationalDateTime(new Date(cita.inicio_at), "inicio_at");
        const preview = await previewPromotionsForAppointment(client, {
          id_sucursal: cita.id_sucursal,
          id_empleado_barbero: cita.id_empleado_barbero,
          id_grupo_cita: cita.id_grupo_cita,
          id_cita: cita.id_cita,
          fecha_hora: operationalDateTime.iso_utc,
          fecha: operationalDateTime.fecha_operativa,
          fecha_operativa: operationalDateTime.fecha_operativa,
          hora: operationalDateTime.hora_operativa,
          subtotal_hnl: subtotalCita,
          servicios: (detallesResult.rows || []).map((row) => ({
            id_servicio: row.id_servicio,
            cantidad: Number(row.cantidad || 1),
            precio_unitario_hnl: Number(row.precio_unitario_hnl || 0),
            subtotal_hnl: Number(row.subtotal_hnl || 0),
          })),
          paquetes: cita.id_paquete ? [{ id_paquete: cita.id_paquete }] : [],
          canal: "public",
        });
        const appliedRules = new Set(
          (preview.promociones_aplicadas || []).map((row) => String(row.id_promocion_regla || "").trim())
        );
        const missingRule = persistedPromotions.find(
          (row) => !appliedRules.has(String(row.id_promocion_regla || "").trim())
        );
        if (missingRule) {
          throw new AppError(409, "La promocion aplicada ya no es valida para esta reserva.", {
            code: "BOOKING_PROMOTION_NO_LONGER_APPLICABLE",
          });
        }
        promocionesAplicadas.push(...(preview.promociones_aplicadas || []));
        promocionesDescartadas.push(...(preview.promociones_descartadas || []));
      } catch (error) {
        logger?.warn?.(
          {
            err: error,
            id_grupo_cita: idGrupoCita,
            id_cita: cita.id_cita,
          },
          "No se pudo validar promociones persistidas antes de crear intent publico"
        );
        throw classifyPromotionValidationError(error);
      }
    }

    const detailSource = persistedPromotions.length
      ? applyPersistedPromotionDiscounts(detallesResult.rows, persistedPromotions)
      : detallesResult.rows;
    const normalizedDetails = buildPaymentDetailRows(detailSource);
    const totalCita = normalizedDetails.length
      ? normalizeMoney(normalizedDetails.reduce((sum, row) => sum + Number(row.total_linea_hnl || 0), 0))
      : normalizeMoney(Math.max(0, subtotalCita));
    const descuentoCita = normalizedDetails.length
      ? normalizeMoney(normalizedDetails.reduce((sum, row) => sum + Number(row.descuento_hnl || 0), 0))
      : 0;

    for (const detail of normalizedDetails) {
      await client.query(
        `
          UPDATE public.citas_detalles
          SET descuento_hnl = $2::numeric,
              isv_hnl = $3::numeric,
              total_linea_hnl = $4::numeric,
              updated_at = now()
          WHERE id_cita_detalle = $1::uuid
        `,
        [
          detail.id_cita_detalle,
          detail.descuento_hnl,
          detail.isv_hnl,
          detail.total_linea_hnl,
        ]
      );
    }

    await client.query(
      `
        UPDATE public.citas
        SET subtotal_servicios_hnl = $2::numeric,
            descuento_hnl = $3::numeric,
            total_pagar_hnl = $4::numeric,
            updated_at = now()
        WHERE id_cita = $1::uuid
      `,
      [cita.id_cita, subtotalCita, descuentoCita, totalCita]
    );

    subtotal += subtotalCita;
    descuentoTotal += descuentoCita;
    total += totalCita;
  }

  return {
    subtotal_hnl: Number(subtotal.toFixed(2)),
    descuento_total_hnl: Number(descuentoTotal.toFixed(2)),
    total_hnl: Number(total.toFixed(2)),
    promociones_aplicadas: promocionesAplicadas,
    promociones_descartadas: promocionesDescartadas,
  };
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

async function confirmGroupAfterPaid(client, { idCitaAnchor, expectedGroupId = null, expectedIntentId = null }) {
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
  if (expectedGroupId && String(idGrupoCita || "").trim() !== String(expectedGroupId || "").trim()) {
    throw new AppError(409, "El intent no pertenece a la reserva indicada", {
      code: "PUBLIC_PAGOS_INTENT_GROUP_MISMATCH",
    });
  }

  if (expectedIntentId) {
    const intentResult = await client.query(
      `
        SELECT
          pi.id_intent,
          pi.id_cita,
          pi.estado_intent_codigo,
          c.id_grupo_cita,
          EXISTS (
            SELECT 1
            FROM public.payments p
            WHERE p.id_intent = pi.id_intent
              AND p.estado_pago_codigo = 'capturado'
          ) AS has_captured_payment
        FROM public.payment_intents pi
        JOIN public.citas c
          ON c.id_cita = pi.id_cita
         AND c.deleted_at IS NULL
        WHERE pi.id_intent = $1::uuid
        FOR UPDATE OF pi
      `,
      [expectedIntentId]
    );
    const intent = intentResult.rows[0];
    if (
      !intent
      || String(intent.id_cita || "").trim() !== String(idCitaAnchor || "").trim()
      || String(intent.id_grupo_cita || "").trim() !== String(idGrupoCita || "").trim()
    ) {
      throw new AppError(409, "El intent no pertenece a la reserva indicada", {
        code: "PUBLIC_PAGOS_INTENT_GROUP_MISMATCH",
      });
    }
    if (String(intent.estado_intent_codigo || "").trim().toLowerCase() !== "confirmado" || intent.has_captured_payment !== true) {
      throw new AppError(409, "El pago no esta confirmado para esta reserva", {
        code: "PUBLIC_PAGOS_PAYMENT_NOT_CONFIRMED",
      });
    }
  }

  const groupRows = await loadPostPaymentConfirmableGroup(client, { groupId: idGrupoCita });
  const confirmability = assertPostPaymentGroupConfirmable(groupRows);
  if (confirmability.alreadyConfirmed) {
    return {
      id_grupo_cita: idGrupoCita,
      total_hnl: calculateGroupTotalFromRows(groupRows),
      ya_confirmada: true,
      recompensa_utilizada: {
        aplicada: false,
        ya_aplicada: true,
        puntos_descontados: 0,
        saldo_actual: null,
      },
    };
  }
  await assertNoPostPaymentAvailabilityConflict(client, { groupId: idGrupoCita, groupRows });

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
  await markPromotionUsagesForGroup(client, {
    id_grupo_cita: idGrupoCita,
    id_cliente: idClienteTitular || null,
  });

  await queuePostPaymentEmails(client, { idGrupoCita, totalGrupo });
  await grantCompanionPointsForConfirmedGroup(client, { idGrupoCita });
  return {
    id_grupo_cita: idGrupoCita,
    total_hnl: totalGrupo,
    recompensa_utilizada: rewardRedemption,
  };
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
      const pricing = await recalculateGroupPromotionsForPayment(dbClient, { idGrupoCita, logger: request.log });
      const createdByUserId = await resolvePublicIntentCreatorUserId(dbClient, { groupRows });
      assertPublicGroupPayable(groupRows);
      const expiredHold = groupRows.some((row) => row.estado_hold_codigo !== "activo" || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now());
      if (expiredHold) {
        throw new AppError(409, "El hold de la reserva ya expiro", { code: "PUBLIC_PAGOS_HOLD_EXPIRED" });
      }
      const provider = await ensureProvider(dbClient, providerCode);
      const anchor = groupRows[0];
      const totalGroup = normalizeMoney(pricing.total_hnl);
      if (totalGroup <= 0) {
        throw new AppError(409, "La reserva no tiene saldo pendiente de pago", {
          code: "PUBLIC_PAGOS_GROUP_NO_PENDING_BALANCE",
        });
      }
      const existingIntent = await dbClient.query(
        `
          SELECT id_intent, id_hold, link_pago_url, expires_at, monto_hnl, moneda_codigo, estado_intent_codigo
            FROM public.payment_intents
            WHERE id_cita = $1::uuid
              AND id_provider = $2::uuid
              AND created_by_usuario_id = $3::uuid
              AND estado_intent_codigo = ANY($4::text[])
              AND id_hold = $5::uuid
              AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [anchor.id_cita, provider.id_provider, createdByUserId, ACTIVE_INTENT_STATES, anchor.id_hold]
        );
      if (existingIntent.rows[0]) {
        const existingAmount = Number(existingIntent.rows[0].monto_hnl || 0);
        if (amountsMatch(existingAmount, totalGroup)) {
          await dbClient.query("COMMIT");
          return sendOk(reply, {
            id_intent: existingIntent.rows[0].id_intent,
            payment_url: existingIntent.rows[0].link_pago_url ?? null,
            expires_at: new Date(existingIntent.rows[0].expires_at).toISOString(),
            monto_hnl: Number(existingIntent.rows[0].monto_hnl || 0),
            moneda_codigo: existingIntent.rows[0].moneda_codigo || "HNL",
            estado_intent_codigo: existingIntent.rows[0].estado_intent_codigo,
            subtotal_hnl: pricing.subtotal_hnl,
            descuento_total_hnl: pricing.descuento_total_hnl,
            total_hnl: pricing.total_hnl,
            promociones_aplicadas: pricing.promociones_aplicadas,
            promociones_descartadas: pricing.promociones_descartadas,
          });
        }

        await dbClient.query(
          `
            UPDATE public.payment_intents
            SET estado_intent_codigo = 'expirado',
                updated_at = now()
            WHERE id_intent = $1::uuid
          `,
          [existingIntent.rows[0].id_intent]
        );
      }

      const idIntentLocal = crypto.randomUUID();
      const idempotencyKey = `masterfade:booking-payment:${idIntentLocal}`;
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
            id_intent,
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
            created_by_usuario_id,
            id_grupo_cita
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            'link_generado',
            $5::numeric,
            'HNL',
            $6::text,
            $7::text,
            $8::text,
            $9::timestamptz,
            $10::uuid,
            $11::uuid
          )
          RETURNING id_intent, link_pago_url, expires_at, monto_hnl, moneda_codigo, estado_intent_codigo
        `,
        [
          idIntentLocal,
          provider.id_provider,
          anchor.id_cita,
          anchor.id_hold,
          totalGroup,
          providerIntent.paymentUrl ?? null,
          providerIntent.providerIntentId ?? null,
          idempotencyKey,
          new Date(anchor.expires_at).toISOString(),
          createdByUserId,
          idGrupoCita,
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
        subtotal_hnl: pricing.subtotal_hnl,
        descuento_total_hnl: pricing.descuento_total_hnl,
        total_hnl: pricing.total_hnl,
        promociones_aplicadas: pricing.promociones_aplicadas,
        promociones_descartadas: pricing.promociones_descartadas,
      }, { statusCode: 201 });
    } catch (error) {
      try { await dbClient.query("ROLLBACK"); } catch { /* no-op */ }
      if (error instanceof AppError) {
        request.log.warn(
          { requestId: request.id, statusCode: error.statusCode, code: error.code, details: error.details },
          "Public pagos create intent handled AppError"
        );
        const safeDetails = sanitizePublicPagosErrorDetails(error.details);
        return sendError(reply, error.statusCode, error.message, {
          code: error.code,
          ...(safeDetails ? { details: safeDetails } : {}),
          requestId: request.id,
        });
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
      const currentTotal = calculateGroupTotalFromRows(await loadPublicGroup(app.db, { groupId: idGrupoCita, titularEmail }));
      const { groupRows, intent } = await loadPublicIntentForGroup(app.db, {
        groupId: idGrupoCita,
        idIntent,
        titularEmail,
        expectedAmountHnl: currentTotal,
      });
      const allConfirmed = groupRows.every((row) => String(row.estado_cita_codigo || "") === "confirmada");
      const intentState = safeText(intent.estado_intent_codigo)?.toLowerCase() || "";
      const bookingConfirmed = allConfirmed && intentState === "confirmado";
      if (bookingConfirmed) {
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
        estado_intent_codigo: intent.estado_intent_codigo,
        booking_confirmed: bookingConfirmed,
        expires_at: intent.expires_at ? new Date(intent.expires_at).toISOString() : null,
        monto_hnl: Number(intent.monto_hnl || 0),
        moneda_codigo: intent.moneda_codigo || "HNL",
        id_grupo_cita: idGrupoCita,
      });
    } catch (error) {
      if (error instanceof AppError) {
        request.log.warn(
          { requestId: request.id, statusCode: error.statusCode, code: error.code, details: error.details },
          "Public pagos status handled AppError"
        );
        const safeDetails = sanitizePublicPagosErrorDetails(error.details);
        return sendError(reply, error.statusCode, error.message, {
          code: error.code,
          ...(safeDetails ? { details: safeDetails } : {}),
          requestId: request.id,
        });
      }
      request.log.error({ err: error }, "No se pudo consultar estado de pago publico");
      return sendError(reply, 500, "No se pudo consultar el estado del pago", { code: "PUBLIC_PAGOS_STATUS_ERROR", requestId: request.id });
    }
  });

  app.post("/mock-completar", {
    schema: {
      body: {
        type: "object",
        required: ["id_grupo_cita", "id_intent", "titular_email"],
        properties: {
          id_grupo_cita: { type: "string", format: "uuid" },
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
      const idGrupoCita = assertUuid(request.body?.id_grupo_cita, "id_grupo_cita");
      const idIntent = assertUuid(request.body?.id_intent, "id_intent");
      const status = safeText(request.body?.status)?.toLowerCase() || "paid";
      const providerEventId = safeText(request.body?.provider_event_id) || `mock_${idIntent}_${status}`;
      await dbClient.query("BEGIN");
      const initialGroupRows = await loadPublicGroup(dbClient, { groupId: idGrupoCita, titularEmail: request.body?.titular_email });
      const expectedAmount = calculateGroupTotalFromRows(initialGroupRows);
      const { intent, groupRows } = await loadPublicIntentForGroup(dbClient, {
        groupId: idGrupoCita,
        idIntent,
        titularEmail: request.body?.titular_email,
        expectedAmountHnl: expectedAmount,
      });
      if (safeText(intent.provider_code)?.toLowerCase() !== "mock") {
        throw new AppError(409, "El intent no pertenece al proveedor simulado solicitado", {
          code: "PUBLIC_PAGOS_INTENT_PROVIDER_MISMATCH",
        });
      }
      const currentState = safeText(intent.estado_intent_codigo)?.toLowerCase() || "";
      if (currentState === "confirmado") {
        await dbClient.query("COMMIT");
        return sendOk(reply, {
          processed: false,
          duplicate: true,
          status: "paid",
          booking_confirmed: groupRows.every((row) => String(row.estado_cita_codigo || "") === "confirmada"),
          estado_intent_codigo: "confirmado",
        });
      }
      if (!PUBLIC_PAYMENT_CONFIRMABLE_STATES.has(currentState)) {
        throw new AppError(409, "El intent no esta disponible para completar pago", {
          code: "PUBLIC_PAGOS_INTENT_STATE_INVALID",
        });
      }

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
        const confirm = await confirmGroupAfterPaid(dbClient, {
          idCitaAnchor: intent.id_cita,
          expectedGroupId: idGrupoCita,
          expectedIntentId: idIntent,
        });
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
        request.log.warn(
          { requestId: request.id, statusCode: error.statusCode, code: error.code, details: error.details },
          "Public pagos mock complete handled AppError"
        );
        const safeDetails = sanitizePublicPagosErrorDetails(error.details);
        return sendError(reply, error.statusCode, error.message, {
          code: error.code,
          ...(safeDetails ? { details: safeDetails } : {}),
          requestId: request.id,
        });
      }
      request.log.error({ err: error }, "No se pudo completar pago mock");
      return sendError(reply, 500, "No se pudo completar el pago", { code: "PUBLIC_PAGOS_MOCK_COMPLETE_ERROR", requestId: request.id });
    } finally {
      dbClient.release();
    }
  });

  app.post("/simulator/event", {
    schema: {
      body: {
        type: "object",
        required: ["id_intent", "id_grupo_cita", "titular_email"],
        properties: {
          id_intent: { type: "string", format: "uuid" },
          id_grupo_cita: { type: "string", format: "uuid" },
          titular_email: { type: "string", format: "email", maxLength: 160 },
          status: { type: "string", maxLength: 32 },
          monto_prueba_hnl: { type: "number", minimum: 0.01 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      if (!isTodoPagoSimulationEnabled(app)) {
        throw new AppError(409, "El simulador de TodoPago no esta disponible en este entorno", {
          code: "PUBLIC_PAGOS_TODOPAGO_SIMULATOR_DISABLED",
        });
      }

      const idIntent = assertUuid(request.body?.id_intent, "id_intent");
      const idGrupoCita = assertUuid(request.body?.id_grupo_cita, "id_grupo_cita");
      const titularEmail = safeText(request.body?.titular_email);

      await dbClient.query("BEGIN");

      const initialGroupRows = await loadPublicGroup(dbClient, { groupId: idGrupoCita, titularEmail });
      const expectedAmount = calculateGroupTotalFromRows(initialGroupRows);
      const { intent, groupRows } = await loadPublicIntentForGroup(dbClient, {
        groupId: idGrupoCita,
        idIntent,
        titularEmail,
        expectedAmountHnl: expectedAmount,
      });
      if (safeText(intent.provider_code)?.toLowerCase() !== "todopago") {
        throw new AppError(409, "El intent no pertenece al proveedor simulado solicitado", {
          code: "PUBLIC_PAGOS_INTENT_PROVIDER_MISMATCH",
        });
      }

      const currentState = safeText(intent.estado_intent_codigo)?.toLowerCase() || "";
      if (currentState === "confirmado") {
        await dbClient.query("COMMIT");
        return sendOk(reply, {
          processed: false,
          duplicate: true,
          booking_confirmed: groupRows.every((row) => String(row.estado_cita_codigo || "") === "confirmada"),
          estado_intent_codigo: "confirmado",
          normalized_status: "PAID",
          response_code: "00",
          response_text: "APPROVAL 599",
          message: "El pago de esta reserva ya fue confirmado.",
        });
      }
      if (!PUBLIC_PAYMENT_CONFIRMABLE_STATES.has(currentState)) {
        throw new AppError(409, "El intent no esta disponible para simulacion", {
          code: "PUBLIC_PAGOS_INTENT_STATE_INVALID",
        });
      }

      const amountForSimulation = resolveTodoPagoSimulationAmount(
        app,
        request.body?.monto_prueba_hnl,
        intent.monto_hnl
      );
      const simulation = resolveTodoPagoSimulatedResponse(amountForSimulation);
      const providerEventId = buildTodoPagoSimulatorEventId(idIntent, simulation.responseCode);

      await dbClient.query(
        `
          INSERT INTO public.payment_events (id_provider, provider_event_id, evento_tipo, firma_valida, payload_esencial, id_intent)
          VALUES ($1::uuid, $2::text, $3::text, TRUE, $4::jsonb, $5::uuid)
        `,
        [
          intent.id_provider,
          providerEventId,
          "payment.simulated.result",
          {
            provider: "todopago",
            mode: "preprod_simulated",
            response_code: simulation.responseCode,
            response_text: simulation.responseText,
            provider_status_raw: simulation.responseText,
            normalized_status: simulation.normalizedStatus,
            monto_resuelto_hnl: amountForSimulation,
            monto_intent_hnl: Number(intent.monto_hnl || 0),
          },
          idIntent,
        ]
      );

      if (simulation.normalizedStatus === "PAID") {
        await dbClient.query(
          `
            INSERT INTO public.payments (
              id_intent, estado_pago_codigo, provider_tx_id, monto_hnl, moneda_codigo, paid_at, registrado_manualmente
            )
            VALUES ($1::uuid, 'capturado', $2::text, $3::numeric, $4::text, now(), FALSE)
            ON CONFLICT (provider_tx_id) DO UPDATE SET updated_at = now()
          `,
          [
            idIntent,
            `todopago_sim_${idIntent}_${simulation.responseCode}`,
            Number(intent.monto_hnl || 0),
            safeText(intent.moneda_codigo) || "HNL",
          ]
        );
        await dbClient.query(
          `UPDATE public.payment_intents SET estado_intent_codigo = 'confirmado', updated_at = now() WHERE id_intent = $1::uuid`,
          [idIntent]
        );
        const confirm = await confirmGroupAfterPaid(dbClient, {
          idCitaAnchor: intent.id_cita,
          expectedGroupId: idGrupoCita,
          expectedIntentId: idIntent,
        });
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
            "No se pudo despachar correo post-pago al completar pago simulado TodoPago"
          );
        }

        return sendOk(reply, {
          processed: true,
          duplicate: false,
          booking_confirmed: true,
          estado_intent_codigo: "confirmado",
          normalized_status: simulation.normalizedStatus,
          response_code: simulation.responseCode,
          response_text: simulation.responseText,
          message: simulation.userMessage,
          booking: confirm,
          email_delivery: emailDelivery,
        });
      }

      const nextIntentState = simulation.normalizedStatus === "PENDING" ? "pendiente_confirmacion" : "fallido";
      await dbClient.query(
        `UPDATE public.payment_intents SET estado_intent_codigo = $2::text, updated_at = now() WHERE id_intent = $1::uuid`,
        [idIntent, nextIntentState]
      );
      await dbClient.query("COMMIT");

      return sendOk(reply, {
        processed: true,
        duplicate: false,
        booking_confirmed: false,
        estado_intent_codigo: nextIntentState,
        normalized_status: simulation.normalizedStatus,
        response_code: simulation.responseCode,
        response_text: simulation.responseText,
        message: simulation.userMessage,
      });
    } catch (error) {
      try { await dbClient.query("ROLLBACK"); } catch { /* no-op */ }
      if (error instanceof AppError) {
        request.log.warn(
          { requestId: request.id, statusCode: error.statusCode, code: error.code, details: error.details },
          "Public pagos simulator handled AppError"
        );
        const safeDetails = sanitizePublicPagosErrorDetails(error.details);
        return sendError(reply, error.statusCode, error.message, {
          code: error.code,
          ...(safeDetails ? { details: safeDetails } : {}),
          requestId: request.id,
        });
      }
      request.log.error({ err: error }, "No se pudo completar pago simulado TodoPago");
      return sendError(reply, 500, "No se pudo completar el pago simulado", {
        code: "PUBLIC_PAGOS_SIMULATOR_COMPLETE_ERROR",
        requestId: request.id,
      });
    } finally {
      dbClient.release();
    }
  });
}
