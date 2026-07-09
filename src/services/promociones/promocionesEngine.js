import {
  allocateDiscountAcrossLines,
  buildCanonicalDiscountLines,
  normalizeMoney,
} from "../bookingDiscounts.js";

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEvaluationScope(candidate = {}) {
  const scope = normalizeCode(candidate.scope_evaluacion_codigo);
  return ["cita", "integrante", "grupo_cita"].includes(scope) ? scope : "cita";
}

function normalizeDiscountType(candidate = {}) {
  const type = normalizeCode(candidate.tipo_descuento_codigo);
  const mecanica = normalizeCode(candidate.mecanica);
  if (type === "bonificacion" || mecanica === "dos_por_uno") return "bonificacion";
  return type || "monto_fijo";
}

function toDateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toWeekKey(dateIso) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function overlapsWindow(nowMin, startMin, endMin) {
  if (startMin == null || endMin == null) return true;
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin <= endMin;
  return nowMin >= startMin || nowMin <= endMin;
}

function normalizeCollectionQuantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeUnitCount(value) {
  const quantity = normalizeCollectionQuantity(value);
  return Math.max(1, Math.trunc(quantity));
}

function normalizeUnitPrice(entry = {}) {
  const direct = Number(entry?.precio_unitario_hnl ?? entry?.precio_hnl ?? NaN);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const qty = normalizeCollectionQuantity(entry?.cantidad);
  const subtotal = Number(entry?.subtotal_hnl ?? NaN);
  if (Number.isFinite(subtotal) && subtotal >= 0 && qty > 0) return subtotal / qty;
  return null;
}

function isBonificationPromotion(candidate = {}) {
  return normalizeDiscountType(candidate) === "bonificacion";
}

function findApplicablePromotionCode(context = {}, candidate = {}) {
  const currentCode = normalizeCode(context.codigo_promocional);
  if (!currentCode) return null;
  for (const code of Array.isArray(candidate.codes) ? candidate.codes : []) {
    if (!code.activo) continue;
    const codeValue = normalizeCode(code.codigo);
    if (!codeValue || codeValue !== currentCode) continue;
    const from = code.vigencia_desde ? new Date(code.vigencia_desde) : null;
    const to = code.vigencia_hasta ? new Date(code.vigencia_hasta) : null;
    const now = context.fecha_hora ? new Date(context.fecha_hora) : new Date();
    if (from && now < from) continue;
    if (to && now > to) continue;
    return {
      id_promocion_codigo: code.id_promocion_codigo || null,
      codigo_promocional_snapshot: code.codigo || null,
    };
  }
  const legacy = normalizeCode(candidate.codigo_promocional);
  if (legacy && legacy === currentCode) {
    return {
      id_promocion_codigo: null,
      codigo_promocional_snapshot: candidate.codigo_promocional || context.codigo_promocional || null,
    };
  }
  return null;
}

function getContextDiscountLines(context = {}) {
  if (Array.isArray(context.discount_lines) && context.discount_lines.length) {
    return context.discount_lines.map((line) => ({
      ...line,
      base_disponible_hnl: normalizeMoney(line.base_disponible_hnl ?? (
        Number(line.subtotal_hnl || 0) - Number(line.descuento_previo_hnl || 0)
      )),
    }));
  }
  return buildCanonicalDiscountLines(context.servicios || [], {
    orden_integrante: context.orden_integrante || 1,
  });
}

function matchesEvaluationScope(entry = {}, context = {}, scope = "cita") {
  if (scope === "grupo_cita") return true;
  if (scope === "cita") {
    const contextCitaId = String(context.id_cita || "").trim();
    const entryCitaId = String(entry.id_cita || "").trim();
    return !contextCitaId || !entryCitaId || contextCitaId === entryCitaId;
  }
  if (scope === "integrante") {
    const contextIntegranteId = String(context.id_cita_integrante || "").trim();
    const entryIntegranteId = String(entry.id_cita_integrante || "").trim();
    if (contextIntegranteId && entryIntegranteId) return contextIntegranteId === entryIntegranteId;
    const contextOrder = Number(context.orden_integrante || 0);
    const entryOrder = Number(entry.orden_integrante || 0);
    return !contextOrder || !entryOrder || contextOrder === entryOrder;
  }
  return true;
}

function getScopedDiscountLines(context = {}, candidate = {}) {
  const scope = normalizeEvaluationScope(candidate);
  return getContextDiscountLines(context).filter((line) => matchesEvaluationScope(line, context, scope));
}

function getScopedCollection(source = [], context = {}, candidate = {}) {
  const scope = normalizeEvaluationScope(candidate);
  return (Array.isArray(source) ? source : []).filter((entry) => matchesEvaluationScope(entry, context, scope));
}

function getEligibleLines(context = {}, candidate = {}) {
  const lines = getScopedDiscountLines(context, candidate);
  const applyCode = String(candidate.aplica_a_codigo || "reserva").trim().toLowerCase();
  if (applyCode === "reserva") return lines;
  if (applyCode === "titular") {
    return lines.filter((line) => Number(line.orden_integrante || 1) === 1);
  }
  if (applyCode === "servicio") {
    const targetServiceIds = new Set(
      (Array.isArray(candidate.items) ? candidate.items : [])
        .map((item) => String(item?.id_servicio || "").trim())
        .filter(Boolean)
    );
    if (!targetServiceIds.size) return [];
    return lines.filter((line) => targetServiceIds.has(String(line.id_servicio || "").trim()));
  }
  if (applyCode === "paquete") {
    const targetPackageIds = new Set(
      (Array.isArray(candidate.items) ? candidate.items : [])
        .map((item) => String(item?.id_paquete || "").trim())
        .filter(Boolean)
    );
    if (!targetPackageIds.size) return [];
    const packageIds = new Set(
      (Array.isArray(context.paquetes) ? context.paquetes : [])
        .map((item) => String(item?.id_paquete ?? item ?? "").trim())
        .filter(Boolean)
    );
    const hasTargetPackage = [...targetPackageIds].some((id) => packageIds.has(id));
    return hasTargetPackage ? lines : [];
  }
  return [];
}

function emptyTargetStats(requiredQuantity, bonusQuantity) {
  return {
    matched: false,
    quantity: 0,
    unitPrices: [],
    targetId: null,
    requiredQuantity,
    bonusQuantity,
  };
}

function buildTargetItemStats(source = [], targetIds = new Set(), idField, requiredQuantity, bonusQuantity) {
  if (!targetIds.size) return emptyTargetStats(requiredQuantity, bonusQuantity);

  const byTargetId = new Map();
  for (const entry of source) {
    const itemId = String(entry?.[idField] ?? entry ?? "").trim();
    if (!itemId || !targetIds.has(itemId)) continue;

    const qty = normalizeCollectionQuantity(entry?.cantidad);
    const unitCount = normalizeUnitCount(entry?.cantidad);
    if (!byTargetId.has(itemId)) {
      byTargetId.set(itemId, { targetId: itemId, quantity: 0, unitPrices: [] });
    }
    const target = byTargetId.get(itemId);
    target.quantity += unitCount;
    const unitPrice = normalizeUnitPrice(entry);
    if (Number.isFinite(unitPrice) && unitPrice > 0) {
      for (let i = 0; i < unitCount; i += 1) {
        target.unitPrices.push(unitPrice);
      }
    } else if (Number.isFinite(Number(entry?.subtotal_hnl)) && Number(entry.subtotal_hnl) > 0 && qty > 0) {
      const fallbackUnitPrice = Number(entry.subtotal_hnl) / qty;
      for (let i = 0; i < unitCount; i += 1) {
        target.unitPrices.push(fallbackUnitPrice);
      }
    }
  }

  const groups = [...byTargetId.values()]
    .filter((row) => row.quantity > 0)
    .sort((a, b) => {
      const aEligible = a.quantity >= requiredQuantity ? 1 : 0;
      const bEligible = b.quantity >= requiredQuantity ? 1 : 0;
      if (bEligible !== aEligible) return bEligible - aEligible;
      if (b.quantity !== a.quantity) return b.quantity - a.quantity;
      return String(a.targetId).localeCompare(String(b.targetId));
    });
  const selected = groups[0];
  if (!selected) return emptyTargetStats(requiredQuantity, bonusQuantity);
  return {
    matched: true,
    quantity: selected.quantity,
    unitPrices: selected.unitPrices,
    targetId: selected.targetId,
    requiredQuantity,
    bonusQuantity,
  };
}

function getTargetItemStats(context = {}, candidate = {}) {
  const applyCode = String(candidate.aplica_a_codigo || "").trim().toLowerCase();
  const ruleItems = Array.isArray(candidate.items) ? candidate.items : [];
  const requiredByRule = Number(ruleItems[0]?.cantidad_minima ?? candidate.cantidad_requerida ?? 0);
  const requiredQuantity = Number.isInteger(requiredByRule) && requiredByRule > 0 ? requiredByRule : 1;
  const bonificadaRaw = Number(candidate.cantidad_bonificada ?? 0);
  const bonusQuantity = Number.isInteger(bonificadaRaw) && bonificadaRaw > 0 ? bonificadaRaw : 1;

  if (applyCode === "servicio") {
    const targetServiceIds = new Set(ruleItems.map((item) => String(item?.id_servicio || "").trim()).filter(Boolean));
    const source = getScopedCollection(context.servicios, context, candidate);
    return buildTargetItemStats(source, targetServiceIds, "id_servicio", requiredQuantity, bonusQuantity);
  }

  if (applyCode === "paquete") {
    const targetPackageIds = new Set(ruleItems.map((item) => String(item?.id_paquete || "").trim()).filter(Boolean));
    const source = getScopedCollection(context.paquetes, context, candidate);
    return buildTargetItemStats(source, targetPackageIds, "id_paquete", requiredQuantity, bonusQuantity);
  }

  return emptyTargetStats(requiredQuantity, bonusQuantity);
}

function buildEligibleUnitEntries(lines = []) {
  const unitEntries = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const serviceId = String(line?.id_servicio || "").trim();
    const unitCount = normalizeUnitCount(line?.cantidad);
    const base = Number(line?.base_disponible_hnl ?? line?.subtotal_hnl ?? 0);
    const unitPrice = normalizeUnitPrice(line) ?? (unitCount > 0 ? base / unitCount : 0);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
    for (let i = 0; i < unitCount; i += 1) {
      unitEntries.push({
        line_key: line.line_key || null,
        id_servicio: serviceId || null,
        price: unitPrice,
      });
    }
  }
  return unitEntries;
}

function resolveBonificationBlocks(candidate = {}, quantity = 0, requiredQuantity = 1) {
  let blocks = Math.floor(Number(quantity || 0) / Math.max(1, Number(requiredQuantity || 1)));
  if (candidate.max_usos_por_reserva != null) {
    const maxUses = Number(candidate.max_usos_por_reserva);
    if (Number.isFinite(maxUses) && maxUses > 0) {
      blocks = Math.min(blocks, Math.floor(maxUses));
    }
  } else if (normalizeEvaluationScope(candidate) === "grupo_cita") {
    blocks = Math.min(blocks, 1);
  }
  return Math.max(0, blocks);
}

function buildBonificationPlanForUnits(candidate = {}, unitEntries = [], requiredQuantity = 1, bonusQuantity = 1) {
  const mode = normalizeCode(candidate.bonificacion_modo_codigo || "menor_precio");
  const sortedUnits = [...unitEntries]
    .sort((a, b) => (mode === "menor_precio" ? a.price - b.price : a.price - b.price));
  const blocks = resolveBonificationBlocks(candidate, sortedUnits.length, requiredQuantity);
  const bonusUnits = Math.min(blocks * bonusQuantity, sortedUnits.length);
  const selectedUnits = sortedUnits.slice(0, bonusUnits);
  const discount = normalizeMoney(selectedUnits.reduce((sum, entry) => sum + entry.price, 0));
  const byLineKey = new Map();
  for (const entry of selectedUnits) {
    if (!entry.line_key) continue;
    byLineKey.set(entry.line_key, normalizeMoney((byLineKey.get(entry.line_key) || 0) + entry.price));
  }
  const allocations = [...byLineKey.entries()].map(([lineKey, amount]) => ({
    line_key: lineKey,
    descuento_hnl: amount,
  }));
  return { discount, allocations };
}

function calculateBonificationPlan(context = {}, candidate = {}, eligibleLines = []) {
  const stats = getTargetItemStats(context, candidate);
  const lineUnitEntries = buildEligibleUnitEntries(eligibleLines);
  const fallbackUnitEntries = Array.isArray(stats.unitPrices)
    ? stats.unitPrices
        .filter((price) => Number.isFinite(price) && price > 0)
        .map((price) => ({ line_key: null, price }))
    : [];
  const unitEntries = lineUnitEntries.length ? lineUnitEntries : fallbackUnitEntries;

  if (!stats.matched || stats.quantity < stats.requiredQuantity || !unitEntries.length) {
    return { discount: 0, allocations: [] };
  }

  const applyCode = normalizeCode(candidate.aplica_a_codigo);
  if (applyCode === "servicio" && lineUnitEntries.length) {
    const targetServiceIds = new Set(
      (Array.isArray(candidate.items) ? candidate.items : [])
        .map((item) => String(item?.id_servicio || "").trim())
        .filter(Boolean)
    );
    const byService = new Map();
    for (const entry of lineUnitEntries) {
      const serviceId = String(entry.id_servicio || "").trim();
      if (!serviceId || (targetServiceIds.size && !targetServiceIds.has(serviceId))) continue;
      if (!byService.has(serviceId)) byService.set(serviceId, []);
      byService.get(serviceId).push(entry);
    }
    const plans = [...byService.values()]
      .filter((entries) => entries.length >= stats.requiredQuantity)
      .map((entries) => buildBonificationPlanForUnits(
        candidate,
        entries,
        stats.requiredQuantity,
        stats.bonusQuantity
      ))
      .filter((plan) => Number(plan.discount || 0) > 0)
      .sort((a, b) => b.discount - a.discount);
    return plans[0] || { discount: 0, allocations: [] };
  }

  return buildBonificationPlanForUnits(candidate, unitEntries, stats.requiredQuantity, stats.bonusQuantity);
}

export function calculateDiscount(context = {}, candidate = {}) {
  const eligibleLines = getEligibleLines(context, candidate);
  const subtotal = normalizeMoney(eligibleLines.reduce((sum, line) => sum + Number(line.base_disponible_hnl || 0), 0));
  const value = Number(candidate.valor_descuento || 0);
  const maxDiscount = candidate.max_descuento_hnl == null ? null : Number(candidate.max_descuento_hnl);
  let discount = 0;
  if (candidate.tipo_descuento_codigo === "porcentaje") {
    discount = subtotal * (value / 100);
  } else if (candidate.tipo_descuento_codigo === "monto_fijo") {
    discount = value;
  } else if (isBonificationPromotion(candidate)) {
    discount = calculateBonificationPlan(context, candidate, eligibleLines).discount;
  }
  if (!Number.isFinite(discount) || discount <= 0) return 0;
  if (maxDiscount != null && Number.isFinite(maxDiscount)) {
    discount = Math.min(discount, maxDiscount);
  }
  discount = Math.min(discount, subtotal);
  return Number(discount.toFixed(2));
}

function buildLineAllocations(context = {}, candidate = {}, eligibleLines = [], discount = 0) {
  if (isBonificationPromotion(candidate)) {
    const plan = calculateBonificationPlan(context, candidate, eligibleLines);
    if (plan.allocations.length) {
      let remaining = normalizeMoney(discount);
      return plan.allocations
        .map((allocation) => {
          const amount = normalizeMoney(Math.min(Number(allocation.descuento_hnl || 0), remaining));
          remaining = normalizeMoney(Math.max(0, remaining - amount));
          return { ...allocation, descuento_hnl: amount };
        })
        .filter((allocation) => Number(allocation.descuento_hnl || 0) > 0);
    }
  }
  return allocateDiscountAcrossLines(eligibleLines, discount);
}

export function validatePromotionCandidate(context = {}, candidate = {}) {
  const dateRef = String(context.fecha_operativa || context.fecha || toDateOnly(new Date()) || "").slice(0, 10);
  const timeRef = String(context.hora || "").trim();
  const barbero = context.id_empleado_barbero ? String(context.id_empleado_barbero).trim() : null;
  const isClientAuthenticated = Boolean(context.es_cliente_autenticado);
  const hasClient = Boolean(context.id_cliente || context.id_persona);

  if (String(candidate.estado_promocion || "").toLowerCase() !== "publicada" && context.canal === "public") {
    return { valid: false, reasonCode: "PROMOCION_NO_PUBLICADA", reason: "La promocion no esta publicada." };
  }
  if (!candidate.regla_activa) {
    return { valid: false, reasonCode: "REGLA_INACTIVA", reason: "La regla de promocion esta inactiva." };
  }

  if (candidate.vigencia_desde && dateRef < String(candidate.vigencia_desde).slice(0, 10)) {
    return { valid: false, reasonCode: "PROMOCION_FUERA_DE_VIGENCIA", reason: "La promocion aun no inicia vigencia." };
  }
  if (candidate.vigencia_hasta && dateRef > String(candidate.vigencia_hasta).slice(0, 10)) {
    return { valid: false, reasonCode: "PROMOCION_FUERA_DE_VIGENCIA", reason: "La promocion ya no esta vigente." };
  }

  const hourStart = candidate.vigencia_hora_desde ? String(candidate.vigencia_hora_desde).slice(0, 5) : null;
  const hourEnd = candidate.vigencia_hora_hasta ? String(candidate.vigencia_hora_hasta).slice(0, 5) : null;
  if (timeRef && (hourStart || hourEnd)) {
    const refMin = Number(timeRef.slice(0, 2)) * 60 + Number(timeRef.slice(3, 5));
    const startMin = hourStart ? Number(hourStart.slice(0, 2)) * 60 + Number(hourStart.slice(3, 5)) : null;
    const endMin = hourEnd ? Number(hourEnd.slice(0, 2)) * 60 + Number(hourEnd.slice(3, 5)) : null;
    if (!overlapsWindow(refMin, startMin, endMin)) {
      return { valid: false, reasonCode: "PROMOCION_FUERA_DE_HORARIO", reason: "La promocion no aplica en este horario." };
    }
  }

  const eligibleLines = getEligibleLines(context, candidate);
  const eligibleSubtotal = normalizeMoney(eligibleLines.reduce((sum, line) => sum + Number(line.base_disponible_hnl || 0), 0));
  if (candidate.min_subtotal_hnl != null && eligibleSubtotal < Number(candidate.min_subtotal_hnl || 0)) {
    return { valid: false, reasonCode: "PROMOCION_MIN_SUBTOTAL", reason: "El subtotal no cumple el minimo de la promocion." };
  }

  if (candidate.requiere_codigo || String(candidate.modo_aplicacion_codigo || "").toLowerCase() === "codigo") {
    if (!findApplicablePromotionCode(context, candidate)) {
      return { valid: false, reasonCode: "PROMOCION_CODIGO_INVALIDO", reason: "El codigo promocional no aplica para esta regla." };
    }
  }

  const restrictions = Array.isArray(candidate.restricciones) ? candidate.restricciones : [];
  if (restrictions.length) {
    const nowDate = new Date(`${dateRef}T00:00:00`);
    const day = nowDate.getDay();
    const timeRefMin = timeRef ? (Number(timeRef.slice(0, 2)) * 60 + Number(timeRef.slice(3, 5))) : null;

    let allowByAnyRestriction = false;
    for (const r of restrictions) {
      if (r.id_sucursal && context.id_sucursal && String(r.id_sucursal) !== String(context.id_sucursal)) continue;
      if (r.id_empleado_barbero && barbero && String(r.id_empleado_barbero) !== barbero) continue;
      if (r.id_empleado_barbero && !barbero) continue;
      if (r.dia_semana != null && Number(r.dia_semana) !== day) continue;
      if (r.vigencia_desde_d && dateRef < r.vigencia_desde_d) continue;
      if (r.vigencia_hasta_d && dateRef > r.vigencia_hasta_d) continue;
      if (timeRefMin != null && (r.hora_inicio_min != null || r.hora_fin_min != null)) {
        if (!overlapsWindow(timeRefMin, r.hora_inicio_min, r.hora_fin_min)) continue;
      }
      if (r.solo_cliente_autenticado && !isClientAuthenticated) continue;
      if (r.solo_titular && !context.es_titular) continue;
      allowByAnyRestriction = true;
      break;
    }
    if (!allowByAnyRestriction) {
      return { valid: false, reasonCode: "PROMOCION_RESTRICCION", reason: "La promocion no cumple restricciones operativas." };
    }
  }

  const items = Array.isArray(candidate.items) ? candidate.items : [];
  const serviceIds = new Set((context.servicios || []).map((item) => String(item.id_servicio || item).trim()));
  const packageIds = new Set((context.paquetes || []).map((item) => String(item.id_paquete || item).trim()));
  if (items.length) {
    let matchedItem = false;
    for (const item of items) {
      if (item.id_servicio && serviceIds.has(String(item.id_servicio))) matchedItem = true;
      if (item.id_paquete && packageIds.has(String(item.id_paquete))) matchedItem = true;
    }
    if (!matchedItem && ["servicio", "paquete"].includes(String(candidate.aplica_a_codigo || ""))) {
      return { valid: false, reasonCode: "PROMOCION_ITEM_NO_APLICA", reason: "La promocion no aplica a los items seleccionados." };
    }
  }
  if (["servicio", "titular", "reserva"].includes(String(candidate.aplica_a_codigo || "")) && eligibleSubtotal <= 0) {
    return { valid: false, reasonCode: "PROMOCION_SIN_LINEAS_ELEGIBLES", reason: "La promocion no tiene lineas elegibles disponibles." };
  }

  if (
    candidate.tipo_descuento_codigo === "bonificacion"
    || String(candidate.mecanica || "").trim().toLowerCase() === "dos_por_uno"
  ) {
    const stats = getTargetItemStats(context, candidate);
    if (!stats.matched) {
      return { valid: false, reasonCode: "PROMOCION_ITEM_NO_APLICA", reason: "La promocion no aplica a los items seleccionados." };
    }
    if (stats.quantity < stats.requiredQuantity) {
      return {
        valid: false,
        reasonCode: "CANTIDAD_MINIMA_NO_CUMPLIDA",
        reason: "La cantidad seleccionada no cumple el minimo requerido para la promocion.",
      };
    }
  }

  if (!hasClient && (candidate.max_usos_por_cliente || (candidate.codes || []).some((row) => row.max_usos_por_cliente))) {
    return { valid: false, reasonCode: "PROMOCION_CLIENTE_REQUERIDO", reason: "La promocion requiere cliente identificado." };
  }

  return { valid: true, reasonCode: null, reason: null };
}

export function resolvePromotionConflicts(_context = {}, evaluatedPromotions = [], compatibilityMap = new Map()) {
  const applied = [];
  const discarded = [];
  const itemLocks = new Map();

  const sorted = [...evaluatedPromotions].sort((a, b) => {
    const pa = Number(a.prioridad_aplicacion ?? 100);
    const pb = Number(b.prioridad_aplicacion ?? 100);
    if (pa !== pb) return pa - pb; // AM: menor numero = mayor prioridad.
    return Number(b.descuento_calculado_hnl || 0) - Number(a.descuento_calculado_hnl || 0);
  });

  for (const candidate of sorted) {
    if (!candidate.isValid || Number(candidate.descuento_calculado_hnl || 0) <= 0) {
      discarded.push(candidate);
      continue;
    }

    const locks = candidate.targetKeys || ["reserva"]; 
    let conflictWith = null;
    for (const lock of locks) {
      const owner = itemLocks.get(lock);
      if (!owner) continue;
      const pairKey = [owner.id_promocion_regla, candidate.id_promocion_regla].sort().join(":");
      const isCompatible = compatibilityMap.get(pairKey) === true;
      if (!isCompatible) {
        conflictWith = owner;
        break;
      }
    }

    if (conflictWith) {
      discarded.push({
        ...candidate,
        reasonCode: "PROMOCION_NO_COMPATIBLE",
        reason: "La promocion no es compatible con otra promocion aplicada.",
      });
      continue;
    }

    applied.push(candidate);
    for (const lock of locks) {
      if (!candidate.es_acumulable) {
        itemLocks.set(lock, candidate);
      }
    }
  }

  return { applied, discarded };
}

export function buildPromotionResult(context = {}, resolved = {}) {
  const subtotal = Number(context.subtotal_hnl || 0);
  const applied = resolved.applied || [];
  const discarded = resolved.discarded || [];
  const totalDiscount = Number(applied.reduce((sum, row) => sum + Number(row.descuento_calculado_hnl || 0), 0).toFixed(2));
  const cappedDiscount = Math.min(totalDiscount, subtotal);
  return {
    subtotal_hnl: subtotal,
    descuento_total_hnl: cappedDiscount,
    total_hnl: Number((subtotal - cappedDiscount).toFixed(2)),
    promociones_aplicadas: applied.map((row) => ({
      id_promocion: row.id_promocion,
      id_promocion_regla: row.id_promocion_regla,
      titulo: row.nombre_promocion_snapshot || "Promocion",
      aplica_a_codigo: row.aplica_a_codigo,
      tipo_descuento_codigo: normalizeDiscountType(row),
      mecanica: row.mecanica || null,
      scope_evaluacion_codigo: row.scope_evaluacion_codigo || null,
      bonificacion_modo_codigo: row.bonificacion_modo_codigo || null,
      valor_descuento: Number(row.valor_descuento || 0),
      base_calculo_hnl: Number(row.base_calculo_hnl || 0),
      descuento_calculado_hnl: Number(row.descuento_calculado_hnl || 0),
      prioridad_aplicacion: Number(row.prioridad_aplicacion || 100),
      es_acumulable: Boolean(row.es_acumulable),
      id_promocion_sucursal: row.id_promocion_sucursal || null,
      id_promocion_codigo: row.id_promocion_codigo || null,
      codigo_promocional_snapshot: row.codigo_promocional_snapshot || null,
      line_allocations: Array.isArray(row.line_allocations) ? row.line_allocations.map((allocation) => ({
        line_key: allocation.line_key,
        descuento_hnl: Number(allocation.descuento_hnl || 0),
      })) : [],
      target_items: Array.isArray(row.items) ? row.items.map((item) => ({
        id_servicio: item.id_servicio || null,
        id_paquete: item.id_paquete || null,
        cantidad_minima: item.cantidad_minima || null,
      })) : [],
      target_keys: Array.isArray(row.targetKeys) ? row.targetKeys : [],
    })),
    promociones_descartadas: discarded.map((row) => ({
      id_promocion: row.id_promocion,
      id_promocion_regla: row.id_promocion_regla,
      titulo: row.nombre_promocion_snapshot || "Promocion",
      motivo_codigo: row.reasonCode || "PROMOCION_NO_ELEGIBLE",
      motivo: row.reason || "La promocion no fue elegible para esta reserva.",
      aplica_a_codigo: row.aplica_a_codigo,
      tipo_descuento_codigo: normalizeDiscountType(row),
      mecanica: row.mecanica || null,
      scope_evaluacion_codigo: row.scope_evaluacion_codigo || null,
      bonificacion_modo_codigo: row.bonificacion_modo_codigo || null,
      valor_descuento: Number(row.valor_descuento || 0),
      prioridad_aplicacion: Number(row.prioridad_aplicacion || 100),
      id_promocion_sucursal: row.id_promocion_sucursal || null,
      id_promocion_codigo: row.id_promocion_codigo || null,
      codigo_promocional_snapshot: row.codigo_promocional_snapshot || null,
      line_allocations: Array.isArray(row.line_allocations) ? row.line_allocations.map((allocation) => ({
        line_key: allocation.line_key,
        descuento_hnl: Number(allocation.descuento_hnl || 0),
      })) : [],
      target_items: Array.isArray(row.items) ? row.items.map((item) => ({
        id_servicio: item.id_servicio || null,
        id_paquete: item.id_paquete || null,
        cantidad_minima: item.cantidad_minima || null,
      })) : [],
      target_keys: Array.isArray(row.targetKeys) ? row.targetKeys : [],
    })),
  };
}

export function evaluatePromotions(context = {}, candidates = [], usageStats = { byRule: new Map(), byRuleClient: new Map(), byRulePeriod: new Map() }) {
  const evaluated = [];
  const dateRef = String(context.fecha_operativa || context.fecha || toDateOnly(new Date())).slice(0, 10);
  const weekKey = toWeekKey(dateRef);
  const monthKey = dateRef.slice(0, 7);
  const clientKey = context.id_cliente ? String(context.id_cliente) : String(context.id_persona || "");

  for (const candidate of candidates) {
    const validation = validatePromotionCandidate(context, candidate);
    let isValid = validation.valid;
    let reasonCode = validation.reasonCode;
    let reason = validation.reason;

    const totalUses = usageStats.byRule.get(candidate.id_promocion_regla) || 0;
    if (isValid && candidate.max_usos_por_reserva != null && totalUses >= Number(candidate.max_usos_por_reserva)) {
      isValid = false;
      reasonCode = "PROMOCION_MAX_USOS_RESERVA";
      reason = "La promocion alcanzo el maximo de usos por reserva.";
    }

    if (isValid && candidate.max_usos_por_cliente != null && clientKey) {
      const byClient = usageStats.byRuleClient.get(`${candidate.id_promocion_regla}:${clientKey}`) || 0;
      if (byClient >= Number(candidate.max_usos_por_cliente)) {
        isValid = false;
        reasonCode = "PROMOCION_MAX_USOS_CLIENTE";
        reason = "La promocion alcanzo el maximo de usos por cliente.";
      }
    }

    if (isValid && Array.isArray(candidate.codes) && candidate.codes.length && clientKey) {
      const maxByClientCode = candidate.codes
        .filter((row) => row.activo)
        .reduce((acc, row) => Math.max(acc, Number(row.max_usos_por_cliente || 0)), 0);
      if (maxByClientCode > 0) {
        const byClient = usageStats.byRuleClient.get(`${candidate.id_promocion_regla}:${clientKey}`) || 0;
        if (byClient >= maxByClientCode) {
          isValid = false;
          reasonCode = "PROMOCION_MAX_USOS_CLIENTE_CODIGO";
          reason = "El codigo promocional alcanzo usos maximos por cliente.";
        }
      }
    }

    if (isValid && Array.isArray(candidate.cupos) && candidate.cupos.length) {
      for (const cupo of candidate.cupos) {
        if (!cupo.activo) continue;
        const periodCode = String(cupo.periodo_codigo || "total");
        const baseSuffix = periodCode === "dia"
          ? `dia:${dateRef}`
          : periodCode === "semana"
            ? `semana:${weekKey}`
            : periodCode === "mes"
              ? `mes:${monthKey}`
              : "total";
        let key = `${candidate.id_promocion_regla}:${baseSuffix}`;
        if (cupo.id_promocion_sucursal) key = `${key}:sucursal:${String(cupo.id_promocion_sucursal)}`;
        if (cupo.id_empleado_barbero) key = `${key}:barbero:${String(cupo.id_empleado_barbero)}`;
        const used = usageStats.byRulePeriod.get(key) || 0;
        if (used >= Number(cupo.limite_usos || 0)) {
          isValid = false;
          reasonCode = "PROMOCION_CUPO_AGOTADO";
          reason = "La promocion no tiene cupos disponibles para este periodo.";
          break;
        }
      }
    }

    const eligibleLines = getEligibleLines(context, candidate);
    const eligibleBase = normalizeMoney(eligibleLines.reduce((sum, line) => sum + Number(line.base_disponible_hnl || 0), 0));
    const applicableCode = findApplicablePromotionCode(context, candidate);
    const discount = isValid ? calculateDiscount(context, candidate) : 0;
    const lineAllocations = isValid && discount > 0
      ? buildLineAllocations(context, candidate, eligibleLines, discount)
      : [];

    const targetKeys = (() => {
      const keys = [];
      const applyCode = String(candidate.aplica_a_codigo || "reserva");
      const scope = normalizeEvaluationScope(candidate);
      if (applyCode === "servicio") {
        for (const item of candidate.items || []) {
          if (item.id_servicio) keys.push(`servicio:${item.id_servicio}`);
        }
      } else if (applyCode === "paquete") {
        for (const item of candidate.items || []) {
          if (item.id_paquete) keys.push(`paquete:${item.id_paquete}`);
        }
      } else if (scope === "integrante") {
        keys.push(`integrante:${context.id_cita_integrante || context.orden_integrante || "actual"}`);
      } else if (scope === "cita") {
        keys.push(`cita:${context.id_cita || context.orden_integrante || "actual"}`);
      } else {
        keys.push(`grupo:${context.id_grupo_cita || "reserva"}`);
      }
      return keys.length ? keys : [`grupo:${context.id_grupo_cita || "reserva"}`];
    })();

    evaluated.push({
      ...candidate,
      isValid,
      reasonCode,
      reason,
      base_calculo_hnl: eligibleBase,
      descuento_calculado_hnl: discount,
      targetKeys,
      targetLineKeys: lineAllocations.map((row) => row.line_key),
      line_allocations: lineAllocations,
      id_promocion_codigo: applicableCode?.id_promocion_codigo || null,
      codigo_promocional_snapshot: applicableCode?.codigo_promocional_snapshot || null,
    });
  }

  return evaluated;
}
