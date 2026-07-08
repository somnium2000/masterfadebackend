import { AppError } from "../../utils/errors.js";

function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

export function buildCanonicalHoldResponse({
  requestId,
  canonicalResult = {},
  totals = {},
  blocks = [],
  extensions = {},
} = {}) {
  const subtotal = normalizeMoney(totals.subtotal_hnl ?? totals.subtotalHnl ?? canonicalResult?.monto_total_hnl);
  const discountTotal = normalizeMoney(totals.descuento_hnl ?? totals.descuentoHnl ?? canonicalResult?.descuento_total_hnl);
  const totalPayable = normalizeMoney(totals.total_hnl ?? totals.totalHnl ?? canonicalResult?.total_pagar_hnl ?? canonicalResult?.total_hnl);
  return {
    request_id: requestId,
    id_grupo_cita: canonicalResult?.id_grupo_cita || null,
    estado_grupo_codigo: canonicalResult?.estado_grupo_codigo || "activo",
    expires_at: canonicalResult?.expires_at || null,
    subtotal_hnl: subtotal,
    descuento_total_hnl: discountTotal,
    total_pagar_hnl: totalPayable,
    extras_a_pagar_hnl: normalizeMoney(extensions.extras_a_pagar_hnl ?? extensions.extras_pendientes_hnl ?? totalPayable),
    monto_total_hnl: normalizeMoney(extensions.monto_total_hnl ?? subtotal),
    total_hnl: normalizeMoney(extensions.total_hnl ?? totalPayable),
    ...extensions,
    bloques: Array.isArray(blocks) ? blocks : [],
  };
}

export async function runBookingHoldTransaction(dbClient, operation) {
  if (!dbClient || typeof dbClient.query !== "function") {
    throw new AppError(500, "Cliente de base de datos no disponible", {
      code: "BOOKING_DB_CLIENT_REQUIRED",
    });
  }
  if (typeof operation !== "function") {
    throw new AppError(500, "Operacion de hold no configurada", {
      code: "BOOKING_HOLD_OPERATION_REQUIRED",
    });
  }
  await dbClient.query("BEGIN");
  try {
    const result = await operation();
    await dbClient.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await dbClient.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export async function createBookingHold({
  dbClient,
  operation,
} = {}) {
  return runBookingHoldTransaction(dbClient, operation);
}
