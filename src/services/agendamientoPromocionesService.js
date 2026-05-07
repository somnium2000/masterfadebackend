import { AppError } from "../utils/errors.js";

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function normalizeUuid(value) {
  const safe = String(value || "").trim();
  return safe || null;
}

function normalizePromotionIds(rawValue) {
  const items = Array.isArray(rawValue) ? rawValue : [rawValue];
  const unique = new Set();
  for (const item of items) {
    if (Array.isArray(item)) {
      for (const nested of item) {
        const normalized = normalizeUuid(nested);
        if (normalized) unique.add(normalized);
      }
      continue;
    }
    const normalized = normalizeUuid(item);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "si", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return roundMoney(parsed);
}

function getTimeZoneParts(dateValue, timeZone = "America/Tegucigalpa") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = formatter.formatToParts(dateValue);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const second = Number(parts.find((part) => part.type === "second")?.value);
  const weekdayRaw = String(parts.find((part) => part.type === "weekday")?.value || "").toLowerCase();
  const weekdayMap = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const weekday = weekdayMap[weekdayRaw.slice(0, 3)] ?? null;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  return { year, month, day, hour, minute, second, weekday };
}

function parseTimeToMinutes(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function checkRestrictionWindow(restriction, atDate) {
  const reasonSet = new Set();
  const tzParts = getTimeZoneParts(atDate);
  if (!tzParts) return { matches: true, reasons: [] };

  if (restriction.dia_semana != null && Number(restriction.dia_semana) !== tzParts.weekday) {
    reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
  }

  const nowMinutes = tzParts.hour * 60 + tzParts.minute;
  const startMinutes = parseTimeToMinutes(restriction.hora_inicio);
  const endMinutes = parseTimeToMinutes(restriction.hora_fin);
  if (startMinutes != null && endMinutes != null) {
    if (!(nowMinutes >= startMinutes && nowMinutes < endMinutes)) {
      reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
    }
  } else if (startMinutes != null && nowMinutes < startMinutes) {
    reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
  } else if (endMinutes != null && nowMinutes >= endMinutes) {
    reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
  }

  const nowMs = atDate.getTime();
  if (restriction.vigencia_desde) {
    const fromMs = new Date(restriction.vigencia_desde).getTime();
    if (Number.isFinite(fromMs) && nowMs < fromMs) {
      reasonSet.add("PROMOTION_EXPIRED");
    }
  }
  if (restriction.vigencia_hasta) {
    const toMs = new Date(restriction.vigencia_hasta).getTime();
    if (Number.isFinite(toMs) && nowMs > toMs) {
      reasonSet.add("PROMOTION_EXPIRED");
    }
  }

  if (restriction.ps_vigencia_desde) {
    const psFrom = new Date(`${restriction.ps_vigencia_desde}T00:00:00-06:00`).getTime();
    if (Number.isFinite(psFrom) && nowMs < psFrom) reasonSet.add("PROMOTION_EXPIRED");
  }
  if (restriction.ps_vigencia_hasta) {
    const psTo = new Date(`${restriction.ps_vigencia_hasta}T23:59:59-06:00`).getTime();
    if (Number.isFinite(psTo) && nowMs > psTo) reasonSet.add("PROMOTION_EXPIRED");
  }

  const psHourFrom = parseTimeToMinutes(restriction.ps_vigencia_hora_desde);
  const psHourTo = parseTimeToMinutes(restriction.ps_vigencia_hora_hasta);
  if (psHourFrom != null && psHourTo != null) {
    if (!(nowMinutes >= psHourFrom && nowMinutes < psHourTo)) {
      reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
    }
  } else if (psHourFrom != null && nowMinutes < psHourFrom) {
    reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
  } else if (psHourTo != null && nowMinutes >= psHourTo) {
    reasonSet.add("PROMOTION_SCHEDULE_NOT_ALLOWED");
  }

  return { matches: reasonSet.size === 0, reasons: [...reasonSet] };
}

function calculateDiscountAmount({ tipoDescuento, valorDescuento, baseAplicable }) {
  const base = roundMoney(baseAplicable);
  const value = roundMoney(valorDescuento);
  if (base <= 0 || value < 0) return 0;

  const discount = tipoDescuento === "porcentaje"
    ? base * (value / 100)
    : (tipoDescuento === "monto_fijo" ? value : NaN);

  if (!Number.isFinite(discount) || discount < 0) return 0;
  return roundMoney(Math.min(base, discount));
}

function resolveSafeMismatchCode(reasons = []) {
  if (reasons.includes("PROMOTION_BRANCH_NOT_ALLOWED")) return "PROMOTION_BRANCH_NOT_ALLOWED";
  if (reasons.includes("PROMOTION_BARBER_NOT_ALLOWED")) return "PROMOTION_BARBER_NOT_ALLOWED";
  if (reasons.includes("PROMOTION_EXPIRED")) return "PROMOTION_EXPIRED";
  if (reasons.includes("PROMOTION_SCHEDULE_NOT_ALLOWED")) return "PROMOTION_SCHEDULE_NOT_ALLOWED";
  if (reasons.includes("PROMOTION_NOT_APPLICABLE")) return "PROMOTION_NOT_APPLICABLE";
  return "PROMOTION_NOT_APPLICABLE";
}

function normalizeRuleRows(rows = []) {
  return rows.map((row) => ({
    id_promocion_regla: row.id_promocion_regla,
    id_promocion: row.id_promocion,
    titulo_promocion: row.titulo_promocion,
    estado_promocion: row.estado_promocion,
    activo: toBoolean(row.activo, false),
    tipo_descuento_codigo: String(row.tipo_descuento_codigo || "").trim().toLowerCase(),
    aplica_a_codigo: String(row.aplica_a_codigo || "").trim().toLowerCase(),
    valor_descuento: parseMoney(row.valor_descuento) ?? 0,
    es_acumulable: toBoolean(row.es_acumulable, false),
    prioridad_aplicacion: Number(row.prioridad_aplicacion ?? 100),
    max_usos_por_reserva: row.max_usos_por_reserva == null ? null : Number(row.max_usos_por_reserva),
    items: Array.isArray(row.items_json) ? row.items_json : [],
    restricciones: Array.isArray(row.restricciones_json) ? row.restricciones_json : [],
  }));
}

async function loadPromotionRules(client, promotionIds) {
  const { rows } = await client.query(
    `
      SELECT
        r.id_promocion_regla,
        r.id_promocion,
        r.tipo_descuento_codigo,
        r.aplica_a_codigo,
        r.valor_descuento,
        r.es_acumulable,
        r.prioridad_aplicacion,
        r.max_usos_por_reserva,
        r.activo,
        p.titulo AS titulo_promocion,
        p.estado AS estado_promocion,
        COALESCE(items.items_json, '[]'::json) AS items_json,
        COALESCE(restr.restricciones_json, '[]'::json) AS restricciones_json
      FROM public.promociones_reglas_agendamiento r
      JOIN public.promociones p
        ON p.id_promocion = r.id_promocion
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id_promocion_item', i.id_promocion_item,
            'tipo_item_codigo', i.tipo_item_codigo,
            'id_servicio', i.id_servicio,
            'id_paquete', i.id_paquete
          )
        ) AS items_json
        FROM public.promociones_items_agendamiento i
        WHERE i.id_promocion_regla = r.id_promocion_regla
      ) items ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id_promocion_restriccion', ra.id_promocion_restriccion,
            'id_sucursal', ra.id_sucursal,
            'id_empleado_barbero', ra.id_empleado_barbero,
            'dia_semana', ra.dia_semana,
            'hora_inicio', ra.hora_inicio,
            'hora_fin', ra.hora_fin,
            'vigencia_desde', ra.vigencia_desde,
            'vigencia_hasta', ra.vigencia_hasta,
            'solo_cliente_autenticado', ra.solo_cliente_autenticado,
            'solo_titular', ra.solo_titular,
            'ps_id_sucursal', ps.id_sucursal,
            'ps_vigencia_desde', ps.vigencia_desde,
            'ps_vigencia_hasta', ps.vigencia_hasta,
            'ps_vigencia_hora_desde', ps.vigencia_hora_desde,
            'ps_vigencia_hora_hasta', ps.vigencia_hora_hasta
          )
        ) AS restricciones_json
        FROM public.promociones_restricciones_agendamiento ra
        LEFT JOIN public.promociones_sucursal ps
          ON ps.id_promocion_sucursal = ra.id_promocion_sucursal
        WHERE ra.id_promocion_regla = r.id_promocion_regla
      ) restr ON true
      WHERE r.id_promocion = ANY($1::uuid[])
         OR r.id_promocion_regla = ANY($1::uuid[])
      ORDER BY r.prioridad_aplicacion ASC, r.created_at ASC
    `,
    [promotionIds]
  );
  return normalizeRuleRows(rows);
}

function resolveRuleForRequestedId(rules, requestedId) {
  const exactRule = rules.find((rule) => rule.id_promocion_regla === requestedId);
  if (exactRule) return exactRule;
  return rules.find((rule) => rule.id_promocion === requestedId) || null;
}

function assertRuleState(rule) {
  if (!rule) {
    throw new AppError(404, "La promocion seleccionada no existe.", {
      code: "PROMOTION_NOT_FOUND",
    });
  }

  if (!rule.activo) {
    throw new AppError(409, "La promocion seleccionada no esta activa.", {
      code: "PROMOTION_NOT_ACTIVE",
    });
  }

  const promotionState = String(rule.estado_promocion || "").trim().toLowerCase();
  if (!["publicada", "borrador"].includes(promotionState)) {
    throw new AppError(409, "La promocion seleccionada no esta activa.", {
      code: "PROMOTION_NOT_ACTIVE",
    });
  }
}

function validateRestrictions({
  rule,
  idSucursal,
  idBarbero,
  fechaInicio,
  actor,
  integrante,
}) {
  const restrictions = Array.isArray(rule.restricciones) ? rule.restricciones : [];
  if (!restrictions.length) return;

  const actorAutenticado = Boolean(actor?.id_usuario || actor?.id_persona || actor?.id_cliente);
  const appointmentDate = fechaInicio instanceof Date ? fechaInicio : new Date(fechaInicio);
  const mismatchReasons = [];

  for (const restriction of restrictions) {
    const rowReasons = [];
    const restrictionBranch = normalizeUuid(restriction.id_sucursal) || normalizeUuid(restriction.ps_id_sucursal);
    const restrictionBarber = normalizeUuid(restriction.id_empleado_barbero);

    if (restrictionBranch && restrictionBranch !== idSucursal) {
      rowReasons.push("PROMOTION_BRANCH_NOT_ALLOWED");
    }
    if (restrictionBarber && restrictionBarber !== idBarbero) {
      rowReasons.push("PROMOTION_BARBER_NOT_ALLOWED");
    }
    if (toBoolean(restriction.solo_cliente_autenticado, false) && !actorAutenticado) {
      rowReasons.push("PROMOTION_NOT_APPLICABLE");
    }
    if (toBoolean(restriction.solo_titular, false) && integrante?.rol_integrante_codigo !== "titular") {
      rowReasons.push("PROMOTION_NOT_APPLICABLE");
    }

    const windowCheck = checkRestrictionWindow(restriction, appointmentDate);
    rowReasons.push(...windowCheck.reasons);

    if (!rowReasons.length) return;
    mismatchReasons.push(...rowReasons);
  }

  throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
    code: resolveSafeMismatchCode(mismatchReasons),
  });
}

function distributeDiscountAcrossRows(rows, totalDiscount) {
  if (!rows.length) return [];
  const safeTotal = roundMoney(Math.max(0, totalDiscount));
  if (safeTotal <= 0) return rows.map((row) => ({ ...row, descuento_hnl: 0 }));

  const baseSum = roundMoney(rows.reduce((sum, row) => sum + Number(row.base_calculo_hnl || 0), 0));
  if (baseSum <= 0) return rows.map((row) => ({ ...row, descuento_hnl: 0 }));

  let assigned = 0;
  return rows.map((row, index) => {
    const base = roundMoney(row.base_calculo_hnl || 0);
    const calculated = index === rows.length - 1
      ? roundMoney(safeTotal - assigned)
      : roundMoney((base / baseSum) * safeTotal);
    if (index !== rows.length - 1) {
      assigned = roundMoney(assigned + calculated);
    }
    let discount = calculated;
    if (discount < 0) discount = 0;
    if (discount > base) discount = base;
    return { ...row, descuento_hnl: roundMoney(discount) };
  });
}

function buildServicePromotionRows({
  rule,
  normalizedSelection,
  detallesPersistidos,
}) {
  const items = Array.isArray(rule.items) ? rule.items : [];
  const targetedServiceIds = new Set(
    items
      .filter((item) => String(item?.tipo_item_codigo || "").trim().toLowerCase() === "servicio")
      .map((item) => normalizeUuid(item.id_servicio))
      .filter(Boolean)
  );
  const includedSet = new Set(Array.isArray(normalizedSelection?.serviciosIncluidosIds) ? normalizedSelection.serviciosIncluidosIds : []);

  for (const serviceId of targetedServiceIds) {
    if (includedSet.has(serviceId)) {
      throw new AppError(409, "La promocion seleccionada duplica un servicio o paquete ya incluido.", {
        code: "PROMOTION_DUPLICATES_SELECTED_ITEM",
      });
    }
  }

  const billableRows = (Array.isArray(detallesPersistidos) ? detallesPersistidos : [])
    .filter((row) => ["servicio_manual", "servicio_extra"].includes(String(row?.origen_item_codigo || "").trim().toLowerCase()))
    .filter((row) => Number(row?.total_linea_hnl || 0) > 0);

  const matchedRows = targetedServiceIds.size
    ? billableRows.filter((row) => targetedServiceIds.has(normalizeUuid(row.id_servicio)))
    : billableRows;

  if (!matchedRows.length) {
    throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
      code: "PROMOTION_NOT_APPLICABLE",
    });
  }

  const rows = matchedRows.map((row) => ({
    id_cita_detalle: row.id_cita_detalle,
    id_cita_paquete: null,
    base_calculo_hnl: roundMoney(row.total_linea_hnl || 0),
  }));
  return rows;
}

function buildPackagePromotionRows({
  rule,
  normalizedSelection,
  idCitaPaquete,
}) {
  const packageSnapshot = normalizedSelection?.paquete || null;
  const selectedPackageId = normalizeUuid(packageSnapshot?.id_paquete);
  if (!selectedPackageId || !idCitaPaquete) {
    throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
      code: "PROMOTION_NOT_APPLICABLE",
    });
  }

  const items = Array.isArray(rule.items) ? rule.items : [];
  const packageItemIds = new Set(
    items
      .filter((item) => String(item?.tipo_item_codigo || "").trim().toLowerCase() === "paquete")
      .map((item) => normalizeUuid(item.id_paquete))
      .filter(Boolean)
  );
  const serviceItemIds = items
    .filter((item) => String(item?.tipo_item_codigo || "").trim().toLowerCase() === "servicio")
    .map((item) => normalizeUuid(item.id_servicio))
    .filter(Boolean);
  if (serviceItemIds.length > 0) {
    throw new AppError(409, "La promocion seleccionada duplica un servicio o paquete ya incluido.", {
      code: "PROMOTION_DUPLICATES_SELECTED_ITEM",
    });
  }

  if (packageItemIds.size > 0 && !packageItemIds.has(selectedPackageId)) {
    throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
      code: "PROMOTION_NOT_APPLICABLE",
    });
  }

  return [{
    id_cita_detalle: null,
    id_cita_paquete: idCitaPaquete,
    base_calculo_hnl: roundMoney(packageSnapshot.total_hnl || 0),
  }];
}

function buildGlobalPromotionRows({ normalizedSelection }) {
  return [{
    id_cita_detalle: null,
    id_cita_paquete: null,
    base_calculo_hnl: roundMoney(normalizedSelection?.total_hnl || 0),
  }];
}

function buildPromotionRows({
  rule,
  normalizedSelection,
  detallesPersistidos,
  idCitaPaquete,
  integrante,
}) {
  const appliesTo = String(rule.aplica_a_codigo || "").trim().toLowerCase();
  if (appliesTo === "servicio") {
    return buildServicePromotionRows({ rule, normalizedSelection, detallesPersistidos });
  }
  if (appliesTo === "paquete") {
    return buildPackagePromotionRows({ rule, normalizedSelection, idCitaPaquete });
  }
  if (appliesTo === "reserva") {
    if (integrante?.rol_integrante_codigo !== "titular") {
      throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
        code: "PROMOTION_NOT_APPLICABLE",
      });
    }
    return buildGlobalPromotionRows({ normalizedSelection });
  }
  if (appliesTo === "titular") {
    if (integrante?.rol_integrante_codigo !== "titular") {
      throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
        code: "PROMOTION_NOT_APPLICABLE",
      });
    }
    return buildGlobalPromotionRows({ normalizedSelection });
  }

  throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
    code: "PROMOTION_NOT_APPLICABLE",
  });
}

async function insertPromotionApplication(client, payload) {
  const {
    id_grupo_cita,
    id_cita,
    id_cita_integrante,
    id_promocion,
    id_promocion_regla,
    aplica_a_codigo,
    nombre_promocion_snapshot,
    tipo_descuento_codigo,
    valor_descuento,
    base_calculo_hnl,
    descuento_calculado_hnl,
    prioridad_aplicacion,
    es_acumulable,
    id_cita_paquete,
    id_cita_detalle,
  } = payload;

  const citaIdForScope = aplica_a_codigo === "reserva" ? null : id_cita;
  const citaIntegranteForScope = aplica_a_codigo === "reserva" ? null : id_cita_integrante;

  await client.query(
    `
      INSERT INTO public.citas_promociones (
        id_grupo_cita,
        id_cita,
        id_cita_integrante,
        id_promocion,
        id_promocion_regla,
        id_cita_paquete,
        id_cita_detalle,
        aplica_a_codigo,
        nombre_promocion_snapshot,
        tipo_descuento_codigo,
        valor_descuento,
        base_calculo_hnl,
        descuento_calculado_hnl,
        prioridad_aplicacion,
        es_acumulable,
        estado_aplicacion_codigo,
        motivo_no_aplicada
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::text,
        $9,
        $10::text,
        $11::numeric,
        $12::numeric,
        $13::numeric,
        $14::int,
        $15::boolean,
        'aplicada',
        NULL
      )
    `,
    [
      id_grupo_cita,
      citaIdForScope,
      citaIntegranteForScope,
      id_promocion,
      id_promocion_regla,
      id_cita_paquete || null,
      id_cita_detalle || null,
      aplica_a_codigo,
      nombre_promocion_snapshot,
      tipo_descuento_codigo,
      roundMoney(valor_descuento || 0),
      roundMoney(base_calculo_hnl || 0),
      roundMoney(descuento_calculado_hnl || 0),
      Number.isFinite(Number(prioridad_aplicacion)) ? Number(prioridad_aplicacion) : 100,
      toBoolean(es_acumulable, false),
    ]
  );
}

export async function validarYAplicarPromocionesAgendamiento({
  client,
  logger = null,
  agendamientoConfig = null,
  id_grupo_cita,
  id_cita,
  id_cita_integrante,
  id_sucursal,
  id_barbero = null,
  fecha_inicio,
  normalizedSelection,
  promocionesSolicitadas = [],
  actor = null,
  integrante = null,
  detallesPersistidos = [],
  idCitaPaquete = null,
} = {}) {
  const requestedIds = normalizePromotionIds(promocionesSolicitadas);
  const totalAntesPromocionesHnl = roundMoney(normalizedSelection?.total_hnl || 0);
  if (!requestedIds.length) {
    return {
      promocionesAplicadas: [],
      descuentoTotalHnl: 0,
      totalAntesPromocionesHnl,
      totalDespuesPromocionesHnl: totalAntesPromocionesHnl,
      advertencias: [],
    };
  }

  if (!client || typeof client.query !== "function") {
    throw new AppError(500, "No se pudo aplicar promociones en este momento.", {
      code: "BOOKING_PROMOTION_APPLICATION_FAILED",
    });
  }

  const validarBackend = toBoolean(agendamientoConfig?.validarPromocionesBackend, true);
  if (!validarBackend) {
    if (logger?.warn) {
      logger.warn(
        { code: "PROMOTIONS_BACKEND_VALIDATION_DISABLED", id_cita, requested_promotions: requestedIds.length },
        "Validacion backend de promociones deshabilitada. Se omite aplicacion comercial."
      );
    }
    return {
      promocionesAplicadas: [],
      descuentoTotalHnl: 0,
      totalAntesPromocionesHnl,
      totalDespuesPromocionesHnl: totalAntesPromocionesHnl,
      advertencias: ["PROMOTIONS_BACKEND_VALIDATION_DISABLED"],
    };
  }

  const maxPromos = Math.max(0, Math.trunc(Number(agendamientoConfig?.maxPromocionesPorReserva ?? 5)));
  if (requestedIds.length > maxPromos) {
    throw new AppError(409, "Has seleccionado mas promociones de las permitidas.", {
      code: "MAX_PROMOTIONS_EXCEEDED",
      details: { maxPromotions: maxPromos },
    });
  }

  const rules = await loadPromotionRules(client, requestedIds);
  const promocionesAplicadas = [];
  const appliedTargetLocks = new Set();
  let descuentoTotalHnl = 0;
  let totalRestante = totalAntesPromocionesHnl;

  for (const requestedId of requestedIds) {
    const rule = resolveRuleForRequestedId(rules, requestedId);
    assertRuleState(rule);

    validateRestrictions({
      rule,
      idSucursal: id_sucursal,
      idBarbero: id_barbero,
      fechaInicio: fecha_inicio,
      actor,
      integrante,
    });

    if (!rule.es_acumulable && requestedIds.length > 1) {
      throw new AppError(409, "La promocion seleccionada no es acumulable.", {
        code: "PROMOTION_NOT_STACKABLE",
      });
    }

    if (Number.isFinite(rule.max_usos_por_reserva) && rule.max_usos_por_reserva < 1) {
      throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
        code: "PROMOTION_NOT_APPLICABLE",
      });
    }

    const promotionRows = buildPromotionRows({
      rule,
      normalizedSelection,
      detallesPersistidos,
      idCitaPaquete,
      integrante,
    });
    const appliesTo = String(rule.aplica_a_codigo || "").trim().toLowerCase();
    const lockKey = `${appliesTo}:${promotionRows.map((row) => row.id_cita_detalle || row.id_cita_paquete || "global").join(",")}`;
    if (appliedTargetLocks.has(lockKey)) {
      throw new AppError(409, "La promocion seleccionada no es acumulable.", {
        code: "PROMOTION_NOT_STACKABLE",
      });
    }
    appliedTargetLocks.add(lockKey);

    const baseCalculo = roundMoney(promotionRows.reduce((sum, row) => sum + Number(row.base_calculo_hnl || 0), 0));
    if (baseCalculo <= 0) {
      throw new AppError(409, "La promocion seleccionada no aplica para esta reserva.", {
        code: "PROMOTION_NOT_APPLICABLE",
      });
    }

    let descuento = calculateDiscountAmount({
      tipoDescuento: rule.tipo_descuento_codigo,
      valorDescuento: rule.valor_descuento,
      baseAplicable: baseCalculo,
    });

    if (descuento <= 0) {
      throw new AppError(409, "No fue posible calcular el descuento de la promocion.", {
        code: "PROMOTION_AMOUNT_INVALID",
      });
    }
    if (descuento > totalRestante) {
      descuento = totalRestante;
    }
    if (descuento <= 0) break;

    const distributedRows = distributeDiscountAcrossRows(promotionRows, descuento);
    for (const row of distributedRows) {
      await insertPromotionApplication(client, {
        id_grupo_cita,
        id_cita,
        id_cita_integrante,
        id_promocion: rule.id_promocion,
        id_promocion_regla: rule.id_promocion_regla,
        id_cita_paquete: row.id_cita_paquete,
        id_cita_detalle: row.id_cita_detalle,
        aplica_a_codigo: appliesTo,
        nombre_promocion_snapshot: normalizeUuid(rule.titulo_promocion) || "Promocion",
        tipo_descuento_codigo: rule.tipo_descuento_codigo,
        valor_descuento: rule.valor_descuento,
        base_calculo_hnl: row.base_calculo_hnl,
        descuento_calculado_hnl: row.descuento_hnl,
        prioridad_aplicacion: rule.prioridad_aplicacion,
        es_acumulable: rule.es_acumulable,
      });
    }

    descuentoTotalHnl = roundMoney(descuentoTotalHnl + descuento);
    totalRestante = roundMoney(Math.max(0, totalRestante - descuento));
    promocionesAplicadas.push({
      id_promocion: rule.id_promocion,
      id_promocion_regla: rule.id_promocion_regla,
      nombre_promocion: rule.titulo_promocion || "Promocion",
      aplica_a_codigo: appliesTo,
      tipo_descuento_codigo: rule.tipo_descuento_codigo,
      valor_descuento: rule.valor_descuento,
      base_calculo_hnl: baseCalculo,
      descuento_hnl: descuento,
      es_acumulable: rule.es_acumulable,
    });
  }

  return {
    promocionesAplicadas,
    descuentoTotalHnl: roundMoney(descuentoTotalHnl),
    totalAntesPromocionesHnl,
    totalDespuesPromocionesHnl: roundMoney(Math.max(0, totalAntesPromocionesHnl - descuentoTotalHnl)),
    advertencias: [],
  };
}
