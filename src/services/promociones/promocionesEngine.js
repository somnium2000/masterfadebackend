function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
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

function normalizeUnitPrice(entry = {}) {
  const direct = Number(entry?.precio_unitario_hnl ?? entry?.precio_hnl ?? NaN);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const qty = normalizeCollectionQuantity(entry?.cantidad);
  const subtotal = Number(entry?.subtotal_hnl ?? NaN);
  if (Number.isFinite(subtotal) && subtotal >= 0 && qty > 0) return subtotal / qty;
  return null;
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
    if (!targetServiceIds.size) return { matched: false, quantity: 0, unitPrice: 0, requiredQuantity, bonusQuantity };
    const source = Array.isArray(context.servicios) ? context.servicios : [];
    let quantity = 0;
    let subtotal = 0;
    for (const entry of source) {
      const serviceId = String(entry?.id_servicio ?? entry ?? "").trim();
      if (!serviceId || !targetServiceIds.has(serviceId)) continue;
      const qty = normalizeCollectionQuantity(entry?.cantidad);
      quantity += qty;
      const unitPrice = normalizeUnitPrice(entry);
      if (Number.isFinite(unitPrice)) {
        subtotal += unitPrice * qty;
      }
    }
    if (!quantity) return { matched: false, quantity: 0, unitPrice: 0, requiredQuantity, bonusQuantity };
    const unitPrice = subtotal > 0 ? (subtotal / quantity) : 0;
    return { matched: true, quantity, unitPrice, requiredQuantity, bonusQuantity };
  }

  if (applyCode === "paquete") {
    const targetPackageIds = new Set(ruleItems.map((item) => String(item?.id_paquete || "").trim()).filter(Boolean));
    if (!targetPackageIds.size) return { matched: false, quantity: 0, unitPrice: 0, requiredQuantity, bonusQuantity };
    const source = Array.isArray(context.paquetes) ? context.paquetes : [];
    let quantity = 0;
    let subtotal = 0;
    for (const entry of source) {
      const packageId = String(entry?.id_paquete ?? entry ?? "").trim();
      if (!packageId || !targetPackageIds.has(packageId)) continue;
      const qty = normalizeCollectionQuantity(entry?.cantidad);
      quantity += qty;
      const unitPrice = normalizeUnitPrice(entry);
      if (Number.isFinite(unitPrice)) {
        subtotal += unitPrice * qty;
      }
    }
    if (!quantity) return { matched: false, quantity: 0, unitPrice: 0, requiredQuantity, bonusQuantity };
    const unitPrice = subtotal > 0 ? (subtotal / quantity) : 0;
    return { matched: true, quantity, unitPrice, requiredQuantity, bonusQuantity };
  }

  return { matched: false, quantity: 0, unitPrice: 0, requiredQuantity, bonusQuantity };
}

export function calculateDiscount(context = {}, candidate = {}) {
  const subtotal = Number(context.subtotal_hnl || 0);
  const value = Number(candidate.valor_descuento || 0);
  const maxDiscount = candidate.max_descuento_hnl == null ? null : Number(candidate.max_descuento_hnl);
  let discount = 0;
  if (candidate.tipo_descuento_codigo === "porcentaje") {
    discount = subtotal * (value / 100);
  } else if (candidate.tipo_descuento_codigo === "monto_fijo") {
    discount = value;
  } else if (
    candidate.tipo_descuento_codigo === "bonificacion"
    || String(candidate.mecanica || "").trim().toLowerCase() === "dos_por_uno"
  ) {
    const stats = getTargetItemStats(context, candidate);
    if (!stats.matched || stats.quantity < stats.requiredQuantity || stats.unitPrice <= 0) {
      discount = 0;
    } else {
      let blocks = Math.floor(stats.quantity / stats.requiredQuantity);
      if (candidate.max_usos_por_reserva != null) {
        const maxUses = Number(candidate.max_usos_por_reserva);
        if (Number.isFinite(maxUses) && maxUses > 0) {
          blocks = Math.min(blocks, Math.floor(maxUses));
        }
      }
      const bonusUnits = blocks * stats.bonusQuantity;
      discount = bonusUnits * stats.unitPrice;
    }
  }
  if (!Number.isFinite(discount) || discount <= 0) return 0;
  if (maxDiscount != null && Number.isFinite(maxDiscount)) {
    discount = Math.min(discount, maxDiscount);
  }
  discount = Math.min(discount, subtotal);
  return Number(discount.toFixed(2));
}

export function validatePromotionCandidate(context = {}, candidate = {}) {
  const dateRef = String(context.fecha_operativa || context.fecha || toDateOnly(new Date()) || "").slice(0, 10);
  const timeRef = String(context.hora || "").trim();
  const barbero = context.id_empleado_barbero ? String(context.id_empleado_barbero).trim() : null;
  const isClientAuthenticated = Boolean(context.es_cliente_autenticado);
  const hasClient = Boolean(context.id_cliente || context.id_persona);
  const currentCode = normalizeCode(context.codigo_promocional);

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

  if (candidate.min_subtotal_hnl != null && Number(context.subtotal_hnl || 0) < Number(candidate.min_subtotal_hnl || 0)) {
    return { valid: false, reasonCode: "PROMOCION_MIN_SUBTOTAL", reason: "El subtotal no cumple el minimo de la promocion." };
  }

  if (candidate.requiere_codigo || String(candidate.modo_aplicacion_codigo || "").toLowerCase() === "codigo") {
    const codes = Array.isArray(candidate.codes) ? candidate.codes : [];
    const hasCodes = codes.length > 0;
    let matched = false;

    if (hasCodes) {
      for (const code of codes) {
        if (!code.activo) continue;
        const codeValue = normalizeCode(code.codigo);
        if (!codeValue || codeValue !== currentCode) continue;
        const from = code.vigencia_desde ? new Date(code.vigencia_desde) : null;
        const to = code.vigencia_hasta ? new Date(code.vigencia_hasta) : null;
        const now = context.fecha_hora ? new Date(context.fecha_hora) : new Date();
        if (from && now < from) continue;
        if (to && now > to) continue;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const legacy = normalizeCode(candidate.codigo_promocional);
      matched = Boolean(legacy && currentCode && legacy === currentCode);
    }

    if (!matched) {
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

export function resolvePromotionConflicts(context = {}, evaluatedPromotions = [], compatibilityMap = new Map()) {
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
      tipo_descuento_codigo: row.tipo_descuento_codigo,
      valor_descuento: Number(row.valor_descuento || 0),
      base_calculo_hnl: Number(row.base_calculo_hnl || 0),
      descuento_calculado_hnl: Number(row.descuento_calculado_hnl || 0),
      prioridad_aplicacion: Number(row.prioridad_aplicacion || 100),
      es_acumulable: Boolean(row.es_acumulable),
      id_promocion_sucursal: row.id_promocion_sucursal || null,
    })),
    promociones_descartadas: discarded.map((row) => ({
      id_promocion: row.id_promocion,
      id_promocion_regla: row.id_promocion_regla,
      titulo: row.nombre_promocion_snapshot || "Promocion",
      motivo_codigo: row.reasonCode || "PROMOCION_NO_ELEGIBLE",
      motivo: row.reason || "La promocion no fue elegible para esta reserva.",
      aplica_a_codigo: row.aplica_a_codigo,
      tipo_descuento_codigo: row.tipo_descuento_codigo,
      valor_descuento: Number(row.valor_descuento || 0),
      prioridad_aplicacion: Number(row.prioridad_aplicacion || 100),
      id_promocion_sucursal: row.id_promocion_sucursal || null,
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

    const discount = isValid ? calculateDiscount(context, candidate) : 0;

    const targetKeys = (() => {
      const keys = [];
      const applyCode = String(candidate.aplica_a_codigo || "reserva");
      if (applyCode === "servicio") {
        for (const item of candidate.items || []) {
          if (item.id_servicio) keys.push(`servicio:${item.id_servicio}`);
        }
      } else if (applyCode === "paquete") {
        for (const item of candidate.items || []) {
          if (item.id_paquete) keys.push(`paquete:${item.id_paquete}`);
        }
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
      base_calculo_hnl: Number(context.subtotal_hnl || 0),
      descuento_calculado_hnl: discount,
      targetKeys,
    });
  }

  return evaluated;
}
