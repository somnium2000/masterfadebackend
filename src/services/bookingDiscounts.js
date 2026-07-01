import { AppError } from "../utils/errors.js";

export const DISCOUNT_SOURCE_TYPES = new Set([
  "promotion",
  "membership",
  "reward",
  "manual",
  "courtesy",
]);

export function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

export function toCents(value) {
  return Math.round(normalizeMoney(value) * 100);
}

export function fromCents(value) {
  return normalizeMoney(Number(value || 0) / 100);
}

export function buildCanonicalLineKey({
  orden_integrante = 1,
  id_servicio = null,
  id_tarifa = null,
  origen_item_codigo = "servicio_manual",
  occurrence = 1,
} = {}) {
  return [
    Math.max(1, Math.trunc(Number(orden_integrante || 1))),
    String(id_servicio || "sin_servicio").trim(),
    String(id_tarifa || "sin_tarifa").trim(),
    String(origen_item_codigo || "servicio_manual").trim(),
    Math.max(1, Math.trunc(Number(occurrence || 1))),
  ].join("|");
}

export function buildCanonicalDiscountLines(items = [], {
  orden_integrante = 1,
  origenItemCodigo = "servicio_manual",
} = {}) {
  const occurrences = new Map();
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const idServicio = String(item?.id_servicio || "").trim();
      if (!idServicio) return null;
      const idTarifa = item?.id_tarifa ? String(item.id_tarifa).trim() : null;
      const origen = String(item?.origen_item_codigo || origenItemCodigo || "servicio_manual").trim();
      const occurrenceKey = [orden_integrante, idServicio, idTarifa || "sin_tarifa", origen].join("|");
      const occurrence = (occurrences.get(occurrenceKey) || 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const quantity = Math.max(1, Math.trunc(Number(item?.cantidad || 1)));
      const unitPrice = normalizeMoney(item?.precio_unitario_hnl ?? item?.precio_hnl);
      const subtotal = normalizeMoney(item?.subtotal_hnl ?? unitPrice * quantity);
      return {
        line_key: buildCanonicalLineKey({
          orden_integrante,
          id_servicio: idServicio,
          id_tarifa: idTarifa,
          origen_item_codigo: origen,
          occurrence,
        }),
        orden_integrante: Math.max(1, Math.trunc(Number(orden_integrante || 1))),
        id_cita: item?.id_cita || null,
        id_cita_detalle: item?.id_cita_detalle || null,
        id_servicio: idServicio,
        id_tarifa: idTarifa,
        origen_item_codigo: origen,
        cantidad: quantity,
        precio_unitario_hnl: unitPrice,
        subtotal_hnl: subtotal,
        descuento_previo_hnl: normalizeMoney(item?.descuento_hnl),
        base_disponible_hnl: normalizeMoney(Math.max(0, subtotal - normalizeMoney(item?.descuento_hnl))),
      };
    })
    .filter(Boolean);
}

export function allocateDiscountAcrossLines(lines = [], discountHnl = 0) {
  const eligibleLines = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      ...line,
      capacityCents: toCents(line.base_disponible_hnl ?? line.subtotal_hnl),
    }))
    .filter((line) => line.capacityCents > 0)
    .sort((a, b) => String(a.line_key || "").localeCompare(String(b.line_key || "")));
  const requestedCents = toCents(discountHnl);
  if (requestedCents <= 0) return [];
  const totalCapacity = eligibleLines.reduce((sum, line) => sum + line.capacityCents, 0);
  if (requestedCents > totalCapacity) {
    throw new AppError(409, "No se pudo asignar el descuento completo a las lineas elegibles", {
      code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
    });
  }

  const provisional = eligibleLines.map((line) => {
    const exact = (requestedCents * line.capacityCents) / totalCapacity;
    const floor = Math.min(line.capacityCents, Math.floor(exact));
    return {
      line,
      cents: floor,
      remainder: exact - floor,
    };
  });
  let assigned = provisional.reduce((sum, row) => sum + row.cents, 0);
  let remaining = requestedCents - assigned;
  const byRemainder = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return String(a.line.line_key || "").localeCompare(String(b.line.line_key || ""));
  });
  while (remaining > 0) {
    const target = byRemainder.find((row) => row.cents < row.line.capacityCents);
    if (!target) break;
    target.cents += 1;
    remaining -= 1;
  }
  assigned = provisional.reduce((sum, row) => sum + row.cents, 0);
  if (assigned !== requestedCents) {
    throw new AppError(409, "La suma de descuentos asignados no coincide con el descuento solicitado", {
      code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
    });
  }
  return provisional
    .filter((row) => row.cents > 0)
    .map((row) => ({
      line_key: row.line.line_key,
      descuento_hnl: fromCents(row.cents),
    }));
}

export function buildDiscountPlan(lines = [], allocations = []) {
  const lineMap = new Map((Array.isArray(lines) ? lines : []).map((line) => [String(line.line_key || ""), line]));
  const plan = new Map();
  for (const line of lineMap.values()) {
    plan.set(line.line_key, {
      line_key: line.line_key,
      allocations: [],
      descuento_total_hnl: 0,
    });
  }
  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    const lineKey = String(allocation?.line_key || "").trim();
    const target = plan.get(lineKey);
    if (!target) {
      throw new AppError(409, "La asignacion de descuento apunta a una linea inexistente", {
        code: "BOOKING_PROMOTION_ALLOCATION_INVALID",
      });
    }
    const sourceType = String(allocation?.source_type || "").trim();
    if (!DISCOUNT_SOURCE_TYPES.has(sourceType)) {
      throw new AppError(409, "Tipo de fuente de descuento no soportado", {
        code: "BOOKING_DISCOUNT_SOURCE_INVALID",
      });
    }
    const discount = normalizeMoney(allocation?.descuento_hnl);
    if (discount <= 0) continue;
    const nextTotal = normalizeMoney(target.descuento_total_hnl + discount);
    const line = lineMap.get(lineKey);
    if (nextTotal > normalizeMoney(line.subtotal_hnl)) {
      throw new AppError(409, "El descuento supera el subtotal de la linea", {
        code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
      });
    }
    target.allocations.push({
      source_type: sourceType,
      source_id: allocation.source_id || null,
      id_promocion: allocation.id_promocion || null,
      id_promocion_regla: allocation.id_promocion_regla || null,
      descuento_hnl: discount,
    });
    target.descuento_total_hnl = nextTotal;
  }
  return plan;
}
