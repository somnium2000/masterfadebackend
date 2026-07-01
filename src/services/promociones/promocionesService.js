import { AppError } from "../../utils/errors.js";
import {
  getCandidatePromotionRules,
  getPromotionCodesByRules,
  getPromotionCompatibility,
  getPromotionUsageStats,
  insertAppointmentPromotionApplication,
  insertPromotionUsage,
} from "./promocionesRepository.js";
import {
  evaluatePromotions,
  resolvePromotionConflicts,
  buildPromotionResult,
} from "./promocionesEngine.js";

function normalizeDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function buildCompatibilityMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.id_promocion_regla_a, row.id_promocion_regla_b].sort().join(":");
    map.set(key, Boolean(row.compatible));
  }
  return map;
}

function buildCodesByRule(codeRows = []) {
  const map = new Map();
  for (const row of codeRows) {
    if (!map.has(row.id_promocion_regla)) map.set(row.id_promocion_regla, []);
    map.get(row.id_promocion_regla).push(row);
  }
  return map;
}

function normalizeMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Number(amount.toFixed(2));
}

function getPromotionTargetServiceIds(item = {}) {
  const ids = new Set();
  for (const target of Array.isArray(item.target_items) ? item.target_items : []) {
    const serviceId = String(target?.id_servicio || "").trim();
    if (serviceId) ids.add(serviceId);
  }
  for (const key of Array.isArray(item.target_keys) ? item.target_keys : []) {
    const text = String(key || "").trim();
    if (text.startsWith("servicio:")) ids.add(text.slice("servicio:".length));
  }
  const directServiceId = String(item.id_servicio || "").trim();
  if (directServiceId) ids.add(directServiceId);
  return ids;
}

function resolvePromotionDetailTargets(context = {}, item = {}) {
  const detailRows = Array.isArray(context.detailRows) ? context.detailRows : [];
  const directDetailId = String(item.id_cita_detalle || context.id_cita_detalle || "").trim();
  if (directDetailId) {
    return detailRows.filter((row) => String(row?.id_cita_detalle || "").trim() === directDetailId);
  }

  const serviceIds = getPromotionTargetServiceIds(item);
  if (!serviceIds.size) return [];
  return detailRows.filter((row) => serviceIds.has(String(row?.id_servicio || "").trim()));
}

function distributeDiscountAcrossDetails(detailRows = [], descuentoHnl = 0) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const capacities = rows.map((row) => normalizeMoney(Math.max(0, Number(row.subtotal_hnl || 0))));
  const available = normalizeMoney(capacities.reduce((sum, amount) => sum + amount, 0));
  const targetDiscount = Math.min(normalizeMoney(descuentoHnl), available);
  let remaining = targetDiscount;
  return rows.map((row, index) => {
    const capacity = capacities[index] || 0;
    const rawDiscount = index === rows.length - 1
      ? remaining
      : normalizeMoney(available > 0 ? (targetDiscount * capacity) / available : 0);
    const discount = normalizeMoney(Math.max(0, Math.min(rawDiscount, remaining, capacity)));
    remaining = normalizeMoney(Math.max(0, remaining - discount));
    return discount;
  });
}

function buildScopedPromotionPayloads(base = {}, context = {}, item = {}) {
  const applyCode = String(item.aplica_a_codigo || base.aplica_a_codigo || "").trim().toLowerCase();
  const payload = {
    ...base,
    aplica_a_codigo: applyCode,
    id_cita: context.id_cita || null,
    id_cita_integrante: null,
    id_cita_paquete: null,
    id_cita_detalle: null,
  };

  if (applyCode === "reserva") {
    payload.id_cita = null;
    return [payload];
  }
  if (applyCode === "titular") {
    payload.id_cita = null;
    payload.id_cita_integrante = context.id_cita_integrante || null;
    return payload.id_cita_integrante ? [payload] : [];
  }
  if (applyCode === "paquete") {
    payload.id_cita_paquete = context.id_cita_paquete || item.id_cita_paquete || null;
    return payload.id_cita && payload.id_cita_paquete ? [payload] : [];
  }
  if (applyCode === "servicio") {
    const targetDetails = resolvePromotionDetailTargets(context, item);
    const allocations = distributeDiscountAcrossDetails(targetDetails, base.descuento_calculado_hnl);
    return targetDetails
      .map((detail, index) => ({
        ...payload,
        id_cita_detalle: detail.id_cita_detalle || null,
        base_calculo_hnl: normalizeMoney(detail.subtotal_hnl),
        descuento_calculado_hnl: allocations[index] || 0,
      }))
      .filter((row) => row.id_cita && row.id_cita_detalle);
  }
  return [];
}

export async function previewPromotionsForAppointment(db, context = {}) {
  const candidates = await getCandidatePromotionRules(db, context);
  if (!candidates.length) {
    return {
      subtotal_hnl: Number(context.subtotal_hnl || 0),
      descuento_total_hnl: 0,
      total_hnl: Number(context.subtotal_hnl || 0),
      promociones_aplicadas: [],
      promociones_descartadas: [],
      usedFallbackLegacy: true,
    };
  }

  const ruleIds = candidates.map((row) => row.id_promocion_regla);
  const [codeRows, compatibilityRows, usageStats] = await Promise.all([
    getPromotionCodesByRules(db, ruleIds),
    getPromotionCompatibility(db, ruleIds),
    getPromotionUsageStats(db, context, ruleIds),
  ]);

  const codesByRule = buildCodesByRule(codeRows);
  const hydrated = candidates.map((candidate) => ({
    ...candidate,
    codes: codesByRule.get(candidate.id_promocion_regla) || [],
  }));

  const evaluated = evaluatePromotions(context, hydrated, usageStats);
  const resolved = resolvePromotionConflicts(context, evaluated, buildCompatibilityMap(compatibilityRows));
  const result = buildPromotionResult(context, resolved);

  return {
    ...result,
    evaluated,
    resolved,
    usedFallbackLegacy: false,
  };
}

export async function recordPromotionApplications(db, context = {}, result = {}, options = {}) {
  const isFormal = options.formal === true;
  const inserted = { aplicadas: [], descartadas: [], usos: [] };

  for (const applied of result.promociones_aplicadas || []) {
    const appliedPayloads = buildScopedPromotionPayloads({
      id_grupo_cita: context.id_grupo_cita,
      id_promocion: applied.id_promocion,
      id_promocion_regla: applied.id_promocion_regla,
      aplica_a_codigo: applied.aplica_a_codigo,
      nombre_promocion_snapshot: applied.titulo,
      tipo_descuento_codigo: applied.tipo_descuento_codigo,
      valor_descuento: applied.valor_descuento,
      base_calculo_hnl: applied.base_calculo_hnl,
      descuento_calculado_hnl: applied.descuento_calculado_hnl,
      prioridad_aplicacion: applied.prioridad_aplicacion,
      es_acumulable: applied.es_acumulable,
      estado_aplicacion_codigo: "aplicada",
      motivo_no_aplicada: null,
    }, context, applied);

    for (const appliedPayload of appliedPayloads) {
      const idCitaPromocion = await insertAppointmentPromotionApplication(db, appliedPayload);
      inserted.aplicadas.push(idCitaPromocion);

      if (isFormal && idCitaPromocion) {
        const idUso = await insertPromotionUsage(db, {
          id_cita_promocion: idCitaPromocion,
          id_promocion_regla: applied.id_promocion_regla,
          id_grupo_cita: context.id_grupo_cita,
          id_cita: appliedPayload.id_cita || context.id_cita || null,
          id_cliente: context.id_cliente || null,
          id_persona: context.id_persona || null,
          id_promocion_sucursal: applied.id_promocion_sucursal || context.id_promocion_sucursal || null,
          fecha_operativa: normalizeDate(context.fecha_operativa || context.fecha),
          estado_uso_codigo: "consumido",
        });
        inserted.usos.push(idUso);
      }
    }
  }

  for (const discarded of result.promociones_descartadas || []) {
    const status = discarded.motivo_codigo === "PROMOCION_NO_COMPATIBLE"
      ? "descartada_por_conflicto"
      : "no_aplicada";

    const discardedPayloads = buildScopedPromotionPayloads({
      id_grupo_cita: context.id_grupo_cita,
      id_promocion: discarded.id_promocion,
      id_promocion_regla: discarded.id_promocion_regla,
      aplica_a_codigo: discarded.aplica_a_codigo || "reserva",
      nombre_promocion_snapshot: discarded.titulo,
      tipo_descuento_codigo: discarded.tipo_descuento_codigo || "monto_fijo",
      valor_descuento: discarded.valor_descuento || 0,
      base_calculo_hnl: Number(context.subtotal_hnl || 0),
      descuento_calculado_hnl: 0,
      prioridad_aplicacion: discarded.prioridad_aplicacion || 100,
      es_acumulable: false,
      estado_aplicacion_codigo: status,
      motivo_no_aplicada: discarded.motivo || "No elegible",
    }, context, discarded);

    for (const discardedPayload of discardedPayloads) {
      const idCitaPromocion = await insertAppointmentPromotionApplication(db, discardedPayload);
      inserted.descartadas.push(idCitaPromocion);
    }
  }

  return inserted;
}

export async function applyPromotionsToAppointmentGroup(db, context = {}, options = {}) {
  const preview = await previewPromotionsForAppointment(db, context);
  if (options.persist !== false) {
    await recordPromotionApplications(db, context, preview, { formal: options.formal === true });
  }
  return preview;
}

export async function revertPromotionUsages(db, context = {}) {
  if (!context.id_grupo_cita) {
    throw new AppError(400, "id_grupo_cita es obligatorio para revertir promociones", {
      code: "PROMOTIONS_REVERT_GROUP_REQUIRED",
    });
  }

  await db.query(
    `
      UPDATE public.promociones_usos pu
      SET estado_uso_codigo = 'revertido',
          updated_at = now()
      WHERE pu.id_grupo_cita = $1::uuid
        AND pu.estado_uso_codigo IN ('reservado', 'consumido')
    `,
    [context.id_grupo_cita]
  );

  await db.query(
    `
      UPDATE public.citas_promociones cp
      SET estado_aplicacion_codigo = 'revertida'
      WHERE cp.id_grupo_cita = $1::uuid
        AND cp.estado_aplicacion_codigo = 'aplicada'
    `,
    [context.id_grupo_cita]
  );

  return true;
}

export async function markPromotionUsagesForGroup(db, context = {}) {
  const groupId = String(context.id_grupo_cita || "").trim();
  if (!groupId) {
    throw new AppError(400, "id_grupo_cita es obligatorio para consolidar usos", {
      code: "PROMOTIONS_GROUP_REQUIRED",
    });
  }

  const dateRef = normalizeDate(context.fecha_operativa || context.fecha);
  const rows = await db.query(
    `
      SELECT
        cp.id_cita_promocion,
        cp.id_promocion_regla,
        cp.id_cita
      FROM public.citas_promociones cp
      WHERE cp.id_grupo_cita = $1::uuid
        AND cp.estado_aplicacion_codigo = 'aplicada'
    `,
    [groupId]
  );

  for (const row of rows.rows || []) {
    const exists = await db.query(
      `
        SELECT 1
        FROM public.promociones_usos pu
        WHERE pu.id_cita_promocion = $1::uuid
        LIMIT 1
      `,
      [row.id_cita_promocion]
    );
    if (exists.rows[0]) continue;

    await insertPromotionUsage(db, {
      id_cita_promocion: row.id_cita_promocion,
      id_promocion_regla: row.id_promocion_regla,
      id_grupo_cita: groupId,
      id_cita: row.id_cita || null,
      id_cliente: context.id_cliente || null,
      id_persona: context.id_persona || null,
      id_promocion_sucursal: null,
      fecha_operativa: dateRef,
      estado_uso_codigo: "consumido",
    });
  }

  return true;
}
