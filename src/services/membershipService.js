import { AppError } from "../utils/errors.js";

const ACTIVE_STATUS = "activa";
const EXPIRED_STATUS = "vencida";
const CANCELLED_STATUS = "cancelada";
const ALLOWED_MOTIVO_FIN = new Set(["tiempo", "agotamiento", "reemplazo", "cancelacion"]);
const COVERAGE_STATUS = {
  COVERED: "cubierto_plan",
  EXTRA_PENDING: "extra_pendiente",
  EXTRA_PAID: "extra_pagado",
};
const PENDING_RENEWAL_THRESHOLD_DAYS = 3;
const MEMBERSHIP_CONSUMPTION_TYPES = {
  SERVICE: "servicio",
  COURTESY: "cortesia",
};
// AM: Lista de errores SQL de compatibilidad de esquema (tabla/columna/tipo ausente).
const SCHEMA_COMPATIBLE_ERROR_CODES = new Set(["42P01", "42703", "42704"]);
// AM: Literal SQL seguro para fallback de beneficios cuando no existe la columna snapshot.
const EMPTY_SNAPSHOT_SQL_LITERAL = `'{"version":1,"items":[]}'`;
let membershipCapabilitiesCache = null;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function toIsoDateTime(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveTimeRemainingInput(timeRemaining, finAt) {
  if (timeRemaining && typeof timeRemaining === "object") {
    return {
      dias: Number(timeRemaining.dias || 0),
      horas: Number(timeRemaining.horas || 0),
      minutos: Number(timeRemaining.minutos || 0),
      total_ms: Number(timeRemaining.total_ms || 0),
      vencido: Boolean(timeRemaining.vencido),
    };
  }
  return computeTimeRemaining(finAt);
}

export function isMembershipPendingRenewal({
  summary = null,
  timeRemaining = null,
  finAt = null,
  thresholdDays = PENDING_RENEWAL_THRESHOLD_DAYS,
} = {}) {
  const serviciosRestantes = Number(summary?.totales?.servicios_restantes || 0);
  const pendingByBalance = serviciosRestantes === 1;
  const resolvedTime = resolveTimeRemainingInput(timeRemaining, finAt);
  const pendingByExpiry = !resolvedTime.vencido && Number(resolvedTime.dias || 0) <= Number(thresholdDays || 0);
  return {
    pending: pendingByBalance || pendingByExpiry,
    pendingByBalance,
    pendingByExpiry,
    timeRemaining: resolvedTime,
  };
}

// AM: Fuente única de verdad para estado visible:
// - estado_suscripcion_codigo + motivo_fin_codigo = estado persistido/cierre
// - estado_visible = lectura operativa/UI consistente del ciclo de vida.
export function resolveMembershipVisibleState(row, { summary = null, timeRemaining = null } = {}) {
  if (!row) return "sin_plan_activo";

  const rawStatus = normalizeText(row.estado_suscripcion_codigo).toLowerCase();
  const rawReason = normalizeText(row.motivo_fin_codigo).toLowerCase();
  if (rawStatus === CANCELLED_STATUS) return "cancelada";
  if (rawStatus === EXPIRED_STATUS && rawReason === "agotamiento") return "agotada";
  if (rawStatus === EXPIRED_STATUS) return "vencida";
  if (rawStatus === ACTIVE_STATUS) {
    const pendingMeta = isMembershipPendingRenewal({
      summary,
      timeRemaining,
      finAt: row.fin_at,
      thresholdDays: PENDING_RENEWAL_THRESHOLD_DAYS,
    });
    return pendingMeta.pending ? "pendiente_renovacion" : "activa";
  }
  return rawStatus || "sin_plan_activo";
}

function isSchemaCompatibilityError(error) {
  return SCHEMA_COMPATIBLE_ERROR_CODES.has(String(error?.code || ""));
}

async function getMembershipCapabilities(client) {
  // AM: Cache por proceso para reducir consultas a information_schema por request.
  if (membershipCapabilitiesCache) return membershipCapabilitiesCache;

  let tableRow = {};
  let columnRows = [];
  try {
    const [tablesResult, columnsResult] = await Promise.all([
      client.query(
        `
          SELECT
            to_regclass('public.subscriptions') IS NOT NULL AS has_subscriptions,
            to_regclass('public.membership_plans') IS NOT NULL AS has_membership_plans,
            to_regclass('public.membership_plans_sucursal') IS NOT NULL AS has_membership_plans_sucursal,
            to_regclass('public.subscription_consumptions') IS NOT NULL AS has_subscription_consumptions,
            to_regclass('public.subscription_alert_events') IS NOT NULL AS has_subscription_alert_events,
            to_regclass('public.subscription_payments') IS NOT NULL AS has_subscription_payments,
            to_regclass('public.points_transactions') IS NOT NULL AS has_points_transactions
        `
      ),
      client.query(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name = 'subscriptions' AND column_name IN ('beneficios_snapshot', 'id_sucursal_contratada', 'motivo_fin_codigo'))
              OR (table_name = 'subscription_consumptions' AND column_name IN ('id_usuario_ejecutor', 'id_cortesia', 'source_kind', 'invalidado', 'invalidado_motivo'))
              OR (table_name = 'membership_plans' AND column_name IN ('categoria_nivel'))
              OR (table_name = 'points_transactions' AND column_name IN ('origen_punto_codigo'))
            )
        `
      ),
    ]);

    tableRow = tablesResult?.rows?.[0] || {};
    columnRows = Array.isArray(columnsResult?.rows) ? columnsResult.rows : [];
  } catch (error) {
    if (!isSchemaCompatibilityError(error)) throw error;
  }

  const columnSet = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  membershipCapabilitiesCache = {
    hasSubscriptions: Boolean(tableRow.has_subscriptions),
    hasMembershipPlans: Boolean(tableRow.has_membership_plans),
    hasMembershipPlansSucursal: Boolean(tableRow.has_membership_plans_sucursal),
    hasSubscriptionConsumptions: Boolean(tableRow.has_subscription_consumptions),
    hasSubscriptionAlertEvents: Boolean(tableRow.has_subscription_alert_events),
    hasSubscriptionPayments: Boolean(tableRow.has_subscription_payments),
    hasPointsTransactions: Boolean(tableRow.has_points_transactions),
    hasSubsBeneficiosSnapshot: columnSet.has("subscriptions.beneficios_snapshot"),
    hasSubsSucursalContratada: columnSet.has("subscriptions.id_sucursal_contratada"),
    hasSubsMotivoFin: columnSet.has("subscriptions.motivo_fin_codigo"),
    hasSubcUsuarioEjecutor: columnSet.has("subscription_consumptions.id_usuario_ejecutor"),
    hasSubcIdCortesia: columnSet.has("subscription_consumptions.id_cortesia"),
    hasSubcSourceKind: columnSet.has("subscription_consumptions.source_kind"),
    hasSubcInvalidado: columnSet.has("subscription_consumptions.invalidado"),
    hasSubcInvalidadoMotivo: columnSet.has("subscription_consumptions.invalidado_motivo"),
    hasPlanCategoriaNivel: columnSet.has("membership_plans.categoria_nivel"),
    hasPointsOrigenCodigo: columnSet.has("points_transactions.origen_punto_codigo"),
  };

  return membershipCapabilitiesCache;
}

export function normalizeBenefitsSnapshot(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const looksLikeSingleBenefit =
    payload &&
    !Array.isArray(payload) &&
    (payload.tipo !== undefined ||
      payload.id_servicio !== undefined ||
      payload.id_cortesia !== undefined ||
      payload.nombre !== undefined ||
      payload.codigo !== undefined ||
      payload.cantidad !== undefined);
  const sourceItems = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(raw)
      ? raw
      : looksLikeSingleBenefit
        ? [payload]
      : [];

  const normalizedItems = sourceItems
    .map((item) => {
      const serviceId = normalizeText(item?.id_servicio);
      const courtesyId = normalizeText(item?.id_cortesia);
      const rawType = normalizeText(item?.tipo).toLowerCase();
      const normalizedName = normalizeText(item?.nombre);
      const normalizedCode = normalizeText(item?.codigo);
      // AM: Compatibilidad de lectura:
      // 1) servicio legacy sin tipo, pero con id_servicio.
      // 2) cortesia legacy con tipo=cortesia sin id_cortesia solo se mantiene en lectura para no perder visualizacion historica.
      const isService = rawType === MEMBERSHIP_CONSUMPTION_TYPES.SERVICE || (rawType !== MEMBERSHIP_CONSUMPTION_TYPES.COURTESY && serviceId);
      const isCourtesy =
        rawType === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY
        || (!rawType && !serviceId && courtesyId);
      const cantidad = toInt(item?.cantidad, 0);
      if ((!isService && !isCourtesy) || cantidad <= 0) return null;

      if (isService) {
        if (!serviceId) return null;
        return {
          tipo: MEMBERSHIP_CONSUMPTION_TYPES.SERVICE,
          id_servicio: serviceId,
          id_cortesia: null,
          codigo: null,
          nombre: normalizedName || "Servicio",
          cantidad,
        };
      }

      const allowsLegacyCourtesyRead =
        rawType === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY
        && !courtesyId
        && Boolean(normalizedName || normalizedCode);
      if (!courtesyId && !allowsLegacyCourtesyRead) return null;

      return {
        tipo: MEMBERSHIP_CONSUMPTION_TYPES.COURTESY,
        id_servicio: null,
        id_cortesia: courtesyId || null,
        // AM: id_cortesia es la referencia funcional; codigo/nombre son snapshot visual de apoyo.
        codigo: normalizedCode || null,
        nombre: normalizedName || (normalizedCode || "Cortesia"),
        cantidad,
      };
    })
    .filter(Boolean);

  return {
    version: toInt(payload?.version, 1),
    items: normalizedItems,
  };
}

function mapServiceBenefitKey(item) {
  return `servicio:${item.id_servicio}`;
}

function mapCourtesyBenefitKey(item) {
  const courtesyId = normalizeText(item?.id_cortesia);
  if (courtesyId) return `cortesia:${courtesyId}`;
  const fallback = normalizeText(item?.codigo) || normalizeText(item?.nombre) || "legacy";
  return `cortesia_legacy:${fallback.toLowerCase()}`;
}

function summarizeBenefits(snapshot, consumptionRows = []) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  const serviceBuckets = new Map();
  const courtesyBuckets = new Map();

  for (const item of items) {
    if (item.tipo === MEMBERSHIP_CONSUMPTION_TYPES.SERVICE) {
      const key = mapServiceBenefitKey(item);
      const current = serviceBuckets.get(key) || {
        key,
        id_servicio: item.id_servicio,
        nombre: item.nombre,
        total: 0,
        consumido: 0,
      };
      current.total += toInt(item.cantidad, 0);
      serviceBuckets.set(key, current);
      continue;
    }

    if (item.tipo === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY) {
      const key = mapCourtesyBenefitKey(item);
      const current = courtesyBuckets.get(key) || {
        key,
        id_cortesia: item.id_cortesia || null,
        codigo: item.codigo || null,
        nombre: item.nombre || "Cortesia",
        total: 0,
        consumido: 0,
      };
      current.total += toInt(item.cantidad, 0);
      courtesyBuckets.set(key, current);
    }
  }

  for (const row of consumptionRows) {
    if (row.coverage_status !== COVERAGE_STATUS.COVERED) continue;
    const qty = toInt(row.cantidad, 0);
    if (qty <= 0) continue;

    if (row.item_tipo === MEMBERSHIP_CONSUMPTION_TYPES.SERVICE && row.id_servicio) {
      const key = `servicio:${row.id_servicio}`;
      const bucket = serviceBuckets.get(key);
      if (!bucket) continue;
      bucket.consumido += qty;
      continue;
    }

    if (row.item_tipo === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY) {
      const idCortesia = normalizeText(row.id_cortesia);
      if (!idCortesia) continue;
      const key = `cortesia:${idCortesia}`;
      const bucket = courtesyBuckets.get(key);
      if (!bucket) continue;
      bucket.consumido += qty;
    }
  }

  const servicios = [...serviceBuckets.values()]
    .map((bucket) => ({
      id_servicio: bucket.id_servicio,
      nombre: bucket.nombre,
      total: bucket.total,
      consumido: bucket.consumido,
      restante: Math.max(0, bucket.total - bucket.consumido),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es-HN"));
  const cortesias = [...courtesyBuckets.values()]
    .map((bucket) => ({
      id_cortesia: bucket.id_cortesia,
      codigo: bucket.codigo,
      nombre: bucket.nombre,
      total: bucket.total,
      consumido: bucket.consumido,
      restante: Math.max(0, bucket.total - bucket.consumido),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es-HN"));

  const serviciosTotal = servicios.reduce((acc, item) => acc + item.total, 0);
  const serviciosConsumidos = servicios.reduce((acc, item) => acc + item.consumido, 0);
  const serviciosRestantes = servicios.reduce((acc, item) => acc + item.restante, 0);
  const cortesiasTotal = cortesias.reduce((acc, item) => acc + item.total, 0);
  const cortesiasConsumidas = cortesias.reduce((acc, item) => acc + item.consumido, 0);
  const cortesiasRestantes = cortesias.reduce((acc, item) => acc + item.restante, 0);
  const beneficiosTotales = serviciosTotal + cortesiasTotal;
  const beneficiosRestantes = serviciosRestantes + cortesiasRestantes;
  const agotadoPorServicios = serviciosTotal > 0 && serviciosRestantes <= 0;
  const agotadoPorCortesias = cortesiasTotal > 0 && cortesiasRestantes <= 0;

  return {
    servicios,
    cortesias,
    totales: {
      servicios_total: serviciosTotal,
      servicios_consumidos: serviciosConsumidos,
      servicios_restantes: serviciosRestantes,
      cortesias_total: cortesiasTotal,
      cortesias_consumidas: cortesiasConsumidas,
      cortesias_restantes: cortesiasRestantes,
      beneficios_totales: beneficiosTotales,
      beneficios_restantes: beneficiosRestantes,
      operativo_servicios_total: serviciosTotal,
      operativo_servicios_consumidos: serviciosConsumidos,
      operativo_servicios_restantes: serviciosRestantes,
      operativo_cortesias_total: cortesiasTotal,
      operativo_cortesias_consumidas: cortesiasConsumidas,
      operativo_cortesias_restantes: cortesiasRestantes,
    },
    agotado: agotadoPorServicios || agotadoPorCortesias,
  };
}

function computeTimeRemaining(finAt) {
  const endDate = new Date(finAt);
  if (Number.isNaN(endDate.getTime())) {
    return {
      dias: 0,
      horas: 0,
      minutos: 0,
      total_ms: 0,
      vencido: true,
    };
  }

  const nowMs = Date.now();
  const delta = Math.max(0, endDate.getTime() - nowMs);
  const dias = Math.floor(delta / (24 * 60 * 60 * 1000));
  const horas = Math.floor((delta % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutos = Math.floor((delta % (60 * 60 * 1000)) / (60 * 1000));

  return {
    dias,
    horas,
    minutos,
    total_ms: delta,
    vencido: delta <= 0,
  };
}

async function getSubscriptionConsumptionRows(client, idSuscripcion) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionConsumptions) return [];
  const selectUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? "sc.id_usuario_ejecutor"
    : "NULL::uuid AS id_usuario_ejecutor";
  const joinUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? `
        LEFT JOIN public.usuarios ue
          ON ue.id_usuario = sc.id_usuario_ejecutor
        LEFT JOIN public.personas pu
          ON pu.id_persona = ue.id_persona
      `
    : "";
  const selectNombreUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? "COALESCE(NULLIF(TRIM(CONCAT(pu.nombres, ' ', pu.apellidos)), ''), NULL) AS nombre_usuario_ejecutor"
    : "NULL::text AS nombre_usuario_ejecutor";
  const selectIdCortesia = capabilities.hasSubcIdCortesia
    ? "sc.id_cortesia"
    : "NULL::uuid AS id_cortesia";
  const selectSourceKind = capabilities.hasSubcSourceKind
    ? "sc.source_kind"
    : "NULL::text AS source_kind";
  const selectInvalidado = capabilities.hasSubcInvalidado
    ? "sc.invalidado"
    : "FALSE AS invalidado";
  const selectInvalidadoMotivo = capabilities.hasSubcInvalidadoMotivo
    ? "sc.invalidado_motivo"
    : "NULL::text AS invalidado_motivo";
  const operationalValidityWhere = [
    capabilities.hasSubcInvalidado ? "COALESCE(sc.invalidado, FALSE) IS FALSE" : "TRUE",
    capabilities.hasSubcSourceKind ? "sc.source_kind = 'appointment_completed'" : "TRUE",
  ].join(" AND ");

  try {
    const { rows } = await client.query(
      `
        SELECT
          sc.id_consumo,
          sc.id_suscripcion,
          sc.id_cliente,
          sc.id_cita,
          c.estado_cita_codigo,
          sc.orden_integrante,
          sc.item_tipo,
          sc.id_servicio,
          ${selectIdCortesia},
          sc.item_codigo,
          sc.item_nombre,
          sc.cantidad,
          sc.precio_unitario_hnl,
          sc.total_hnl,
          sc.coverage_status,
          ${selectSourceKind},
          ${selectInvalidado},
          ${selectInvalidadoMotivo},
          ${selectUsuarioEjecutor},
          ${selectNombreUsuarioEjecutor},
          c.id_sucursal,
          s.nombre_sucursal,
          sc.created_at
        FROM public.subscription_consumptions sc
        LEFT JOIN public.citas c
          ON c.id_cita = sc.id_cita
        LEFT JOIN public.sucursales s
          ON s.id_sucursal = c.id_sucursal
        ${joinUsuarioEjecutor}
        WHERE sc.id_suscripcion = $1::uuid
          AND ${operationalValidityWhere}
          AND (
            c.id_cita IS NULL
            OR c.estado_cita_codigo NOT IN ('expirada', 'cancelada')
          )
        ORDER BY sc.created_at DESC, sc.id_consumo DESC
      `,
      [idSuscripcion]
    );
    return rows;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return [];
    throw error;
  }
}

async function getClienteConsumptionRows(client, idCliente, { limit = 40 } = {}) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionConsumptions) return [];
  const maxLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
  const selectUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? "sc.id_usuario_ejecutor"
    : "NULL::uuid AS id_usuario_ejecutor";
  const joinUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? `
        LEFT JOIN public.usuarios ue
          ON ue.id_usuario = sc.id_usuario_ejecutor
        LEFT JOIN public.personas pu
          ON pu.id_persona = ue.id_persona
      `
    : "";
  const selectNombreUsuarioEjecutor = capabilities.hasSubcUsuarioEjecutor
    ? "COALESCE(NULLIF(TRIM(CONCAT(pu.nombres, ' ', pu.apellidos)), ''), NULL) AS nombre_usuario_ejecutor"
    : "NULL::text AS nombre_usuario_ejecutor";
  const selectIdCortesia = capabilities.hasSubcIdCortesia
    ? "sc.id_cortesia"
    : "NULL::uuid AS id_cortesia";
  const selectSourceKind = capabilities.hasSubcSourceKind
    ? "sc.source_kind"
    : "NULL::text AS source_kind";
  const selectInvalidado = capabilities.hasSubcInvalidado
    ? "sc.invalidado"
    : "FALSE AS invalidado";
  const selectInvalidadoMotivo = capabilities.hasSubcInvalidadoMotivo
    ? "sc.invalidado_motivo"
    : "NULL::text AS invalidado_motivo";
  const operationalValidityWhere = [
    capabilities.hasSubcInvalidado ? "COALESCE(sc.invalidado, FALSE) IS FALSE" : "TRUE",
    capabilities.hasSubcSourceKind ? "sc.source_kind = 'appointment_completed'" : "TRUE",
  ].join(" AND ");

  try {
    const { rows } = await client.query(
      `
        SELECT
          sc.id_consumo,
          sc.id_suscripcion,
          sc.id_cliente,
          sc.id_cita,
          c.estado_cita_codigo,
          sc.orden_integrante,
          sc.item_tipo,
          sc.id_servicio,
          ${selectIdCortesia},
          sc.item_codigo,
          sc.item_nombre,
          sc.cantidad,
          sc.precio_unitario_hnl,
          sc.total_hnl,
          sc.coverage_status,
          ${selectSourceKind},
          ${selectInvalidado},
          ${selectInvalidadoMotivo},
          ${selectUsuarioEjecutor},
          ${selectNombreUsuarioEjecutor},
          c.id_sucursal,
          s.nombre_sucursal,
          sc.created_at
        FROM public.subscription_consumptions sc
        LEFT JOIN public.citas c
          ON c.id_cita = sc.id_cita
        LEFT JOIN public.sucursales s
          ON s.id_sucursal = c.id_sucursal
        ${joinUsuarioEjecutor}
        WHERE sc.id_cliente = $1::uuid
          AND ${operationalValidityWhere}
        ORDER BY sc.created_at DESC, sc.id_consumo DESC
        LIMIT $2::int
      `,
      [idCliente, maxLimit]
    );
    return rows;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return [];
    throw error;
  }
}

async function getActiveSubscriptionRow(client, clienteId, { forUpdate = false } = {}) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions || !capabilities.hasMembershipPlans) return null;

  // AM: Fallback compatible cuando subscriptions.beneficios_snapshot no existe aún.
  const selectBeneficiosSnapshot = capabilities.hasSubsBeneficiosSnapshot
    ? "s.beneficios_snapshot"
    : `${EMPTY_SNAPSHOT_SQL_LITERAL}::jsonb AS beneficios_snapshot`;
  const selectSucursalContratada = capabilities.hasSubsSucursalContratada
    ? "s.id_sucursal_contratada"
    : "NULL::uuid AS id_sucursal_contratada";
  const selectMotivoFin = capabilities.hasSubsMotivoFin
    ? "s.motivo_fin_codigo"
    : "NULL::text AS motivo_fin_codigo";
  const selectCategoria = capabilities.hasPlanCategoriaNivel
    ? "mp.categoria_nivel"
    : "1::smallint AS categoria_nivel";

  const lockClause = forUpdate ? "FOR UPDATE" : "";
  try {
    const { rows } = await client.query(
      `
        SELECT
          s.id_suscripcion,
          s.id_cliente,
          s.id_plan,
          s.estado_suscripcion_codigo,
          s.inicio_at,
          s.fin_at,
          s.renovacion_auto,
          s.cancelada_al_fin,
          ${selectSucursalContratada},
          ${selectBeneficiosSnapshot},
          ${selectMotivoFin},
          s.created_at,
          mp.nombre_plan,
          mp.descripcion AS plan_descripcion,
          mp.periodo_membresia_codigo,
          ${selectCategoria}
        FROM public.subscriptions s
        JOIN public.membership_plans mp
          ON mp.id_plan = s.id_plan
        WHERE s.id_cliente = $1::uuid
          AND s.estado_suscripcion_codigo = $2
        ORDER BY s.inicio_at DESC, s.created_at DESC
        LIMIT 1
        ${lockClause}
      `,
      [clienteId, ACTIVE_STATUS]
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return null;
    throw error;
  }
}

export async function ensureSubscriptionLifecycle(client, clienteId, { forUpdate = false } = {}) {
  const capabilities = await getMembershipCapabilities(client);
  const activeRow = await getActiveSubscriptionRow(client, clienteId, { forUpdate });
  if (!activeRow) {
    return {
      active: null,
      summary: null,
      time_remaining: null,
      changed: false,
    };
  }

  const snapshot = normalizeBenefitsSnapshot(activeRow.beneficios_snapshot);
  const consumptionRows = await getSubscriptionConsumptionRows(client, activeRow.id_suscripcion);
  const summary = summarizeBenefits(snapshot, consumptionRows);
  const timeRemaining = computeTimeRemaining(activeRow.fin_at);

  if (timeRemaining.vencido) {
    const baseSet = ["estado_suscripcion_codigo = $2", "updated_at = now()"];
    const params = [activeRow.id_suscripcion, EXPIRED_STATUS];
    if (capabilities.hasSubsMotivoFin) {
      baseSet.splice(1, 0, "motivo_fin_codigo = $3");
      params.push("tiempo");
    }
    await client.query(
      `
        UPDATE public.subscriptions
        SET ${baseSet.join(", ")}
        WHERE id_suscripcion = $1::uuid
      `,
      params
    );

    return {
      active: null,
      summary,
      time_remaining: timeRemaining,
      changed: true,
      finalizado_por: "tiempo",
    };
  }

  const serviciosTotales = Number(summary?.totales?.servicios_total || 0);
  const serviciosRestantes = Number(summary?.totales?.servicios_restantes || 0);
  const agotadoPorServicios = serviciosTotales > 0 && serviciosRestantes <= 0;
  if (agotadoPorServicios) {
    const baseSet = ["estado_suscripcion_codigo = $2", "updated_at = now()"];
    const params = [activeRow.id_suscripcion, EXPIRED_STATUS];
    if (capabilities.hasSubsMotivoFin) {
      baseSet.splice(1, 0, "motivo_fin_codigo = $3");
      params.push("agotamiento");
    }
    await client.query(
      `
        UPDATE public.subscriptions
        SET ${baseSet.join(", ")}
        WHERE id_suscripcion = $1::uuid
      `,
      params
    );

    return {
      active: null,
      summary,
      time_remaining: timeRemaining,
      changed: true,
      finalizado_por: "agotamiento",
    };
  }

  return {
    active: {
      ...activeRow,
      beneficios_snapshot: snapshot,
      consumo_rows: consumptionRows,
    },
    summary,
    time_remaining: timeRemaining,
    changed: false,
  };
}

async function getAnySubscriptionCount(client, clienteId) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions) return 0;
  try {
    const { rows } = await client.query(
      `
        SELECT COUNT(*)::int AS total
        FROM public.subscriptions
        WHERE id_cliente = $1::uuid
      `,
      [clienteId]
    );
    return Number(rows[0]?.total || 0);
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return 0;
    throw error;
  }
}

async function lockClienteMembershipScope(client, clienteId) {
  try {
    await client.query(
      `
        SELECT c.id_cliente
        FROM public.clientes c
        WHERE c.id_cliente = $1::uuid
        FOR UPDATE
      `,
      [clienteId]
    );
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return;
    throw error;
  }
}

async function getSubscriptionPrice(client, { idPlan, idSucursal }) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasMembershipPlans || !capabilities.hasMembershipPlansSucursal) return null;
  const selectCategoria = capabilities.hasPlanCategoriaNivel ? "mp.categoria_nivel" : "1::smallint AS categoria_nivel";

  try {
    const { rows } = await client.query(
      `
        WITH scoped_offers AS (
          SELECT
            mps.id_plan,
            mps.id_sucursal,
            mps.precio_hnl,
            mps.activo,
            mps.visible_publico,
            ROW_NUMBER() OVER (
              PARTITION BY mps.id_plan, mps.id_sucursal
              ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
            ) AS rn
          FROM public.membership_plans_sucursal mps
          WHERE mps.id_plan = $1::uuid
            AND mps.id_sucursal = $2::uuid
        )
        SELECT
          mp.id_plan,
          mp.nombre_plan,
          mp.descripcion,
          mp.periodo_membresia_codigo,
          ${selectCategoria},
          mp.beneficios,
          mp.activo AS plan_activo,
          so.id_sucursal,
          so.precio_hnl,
          so.activo AS oferta_activa,
          so.visible_publico
        FROM public.membership_plans mp
        JOIN scoped_offers so
          ON so.id_plan = mp.id_plan
         AND so.rn = 1
        WHERE mp.id_plan = $1::uuid
        LIMIT 1
      `,
      [idPlan, idSucursal]
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return null;
    throw error;
  }
}

async function listSubscriptionHistoryRows(client, clienteId, { limit = 20 } = {}) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions || !capabilities.hasMembershipPlans) return [];
  const maxLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const selectMotivo = capabilities.hasSubsMotivoFin ? "s.motivo_fin_codigo" : "NULL::text AS motivo_fin_codigo";
  const selectSucursalContratada = capabilities.hasSubsSucursalContratada
    ? "s.id_sucursal_contratada"
    : "NULL::uuid AS id_sucursal_contratada";
  const selectCategoria = capabilities.hasPlanCategoriaNivel ? "mp.categoria_nivel" : "1::smallint AS categoria_nivel";

  try {
    const { rows } = await client.query(
      `
        SELECT
          s.id_suscripcion,
          s.id_plan,
          s.estado_suscripcion_codigo,
          s.inicio_at,
          s.fin_at,
          ${selectSucursalContratada},
          ${selectMotivo},
          s.created_at,
          mp.nombre_plan,
          ${selectCategoria}
        FROM public.subscriptions s
        JOIN public.membership_plans mp
          ON mp.id_plan = s.id_plan
        WHERE s.id_cliente = $1::uuid
        ORDER BY s.created_at DESC
        LIMIT $2::int
      `,
      [clienteId, maxLimit]
    );
    return rows;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return [];
    throw error;
  }
}

export function buildUpgradeBlockedDetails(activeContext) {
  const time = activeContext?.time_remaining || { dias: 0, horas: 0, minutos: 0 };
  const totals = activeContext?.summary?.totales || {};

  return {
    motivo: "plan_activo_vigente",
    tiempo_restante: {
      dias: Number(time.dias || 0),
      horas: Number(time.horas || 0),
      minutos: Number(time.minutos || 0),
    },
    remanentes: {
      servicios: Number(totals.servicios_restantes || 0),
      cortesias: Number(totals.cortesias_restantes || 0),
    },
  };
}

async function closeSubscriptionById(client, idSuscripcion, {
  statusCode = EXPIRED_STATUS,
  motivoFinCodigo = null,
} = {}) {
  const capabilities = await getMembershipCapabilities(client);
  const normalizedStatus = normalizeText(statusCode) || EXPIRED_STATUS;
  const normalizedReason = normalizeText(motivoFinCodigo) || null;
  if (normalizedReason && !ALLOWED_MOTIVO_FIN.has(normalizedReason)) {
    throw new AppError(400, "Motivo de cierre de membresía inválido", {
      code: "MEMBERSHIP_CLOSE_REASON_INVALID",
      details: { motivo_fin_codigo: normalizedReason },
    });
  }

  const setParts = [
    "estado_suscripcion_codigo = $2::text",
    "updated_at = now()",
  ];
  const params = [idSuscripcion, normalizedStatus];
  if (capabilities.hasSubsMotivoFin) {
    setParts.push("motivo_fin_codigo = $3::text");
    params.push(normalizedReason);
  }

  const { rows } = await client.query(
    `
      UPDATE public.subscriptions
      SET ${setParts.join(", ")}
      WHERE id_suscripcion = $1::uuid
      RETURNING id_suscripcion, estado_suscripcion_codigo, inicio_at, fin_at
    `,
    params
  );
  return rows[0] ?? null;
}

export async function cancelMembership(client, {
  clienteId,
  motivoFinCodigo = "cancelacion",
} = {}) {
  const safeClienteId = normalizeText(clienteId);
  if (!safeClienteId) {
    throw new AppError(400, "cliente_id es obligatorio para cancelar membresía", {
      code: "MEMBERSHIP_CANCEL_CLIENT_REQUIRED",
    });
  }

  await lockClienteMembershipScope(client, safeClienteId);
  const lifecycle = await ensureSubscriptionLifecycle(client, safeClienteId, { forUpdate: true });
  if (!lifecycle.active) {
    return {
      cancelled: false,
      reason: "sin_suscripcion_activa",
      active: null,
    };
  }

  const closed = await closeSubscriptionById(client, lifecycle.active.id_suscripcion, {
    statusCode: CANCELLED_STATUS,
    motivoFinCodigo: motivoFinCodigo || "cancelacion",
  });
  return {
    cancelled: Boolean(closed),
    reason: "cancelada",
    active: lifecycle.active,
    closed,
  };
}

export async function acquireMembershipPlan(client, { clienteId, usuarioId, idPlan, idSucursal }) {
  // AM: Protege entornos con migración parcial devolviendo error de negocio controlado.
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions || !capabilities.hasMembershipPlans || !capabilities.hasMembershipPlansSucursal) {
    throw new AppError(503, "El módulo de membresías aún no está listo. Aplica la migración pendiente.", {
      code: "MEMBERSHIP_SCHEMA_NOT_READY",
    });
  }

  await lockClienteMembershipScope(client, clienteId);
  const lifecycle = await ensureSubscriptionLifecycle(client, clienteId, { forUpdate: true });
  const previousActive = lifecycle.active || null;
  let transitionType = "adquisicion";
  let closedPrevious = null;

  const planOffer = await getSubscriptionPrice(client, { idPlan, idSucursal });
  if (!planOffer || !planOffer.plan_activo || !planOffer.oferta_activa || !planOffer.visible_publico) {
    throw new AppError(404, "El plan seleccionado no está disponible para adquisición.", {
      code: "MEMBERSHIP_PLAN_NOT_AVAILABLE",
      details: { id_plan: idPlan, id_sucursal: idSucursal },
    });
  }

  const snapshot = normalizeBenefitsSnapshot(planOffer.beneficios);

  if (previousActive) {
    closedPrevious = await closeSubscriptionById(client, previousActive.id_suscripcion, {
      statusCode: EXPIRED_STATUS,
      motivoFinCodigo: "reemplazo",
    });
    transitionType = previousActive.id_plan === idPlan ? "renovacion" : "cambio_plan";
  }

  const insertColumns = [
    "id_cliente",
    "id_plan",
    "estado_suscripcion_codigo",
    "inicio_at",
    "fin_at",
    "renovacion_auto",
    "cancelada_al_fin",
    "created_by_usuario_id",
  ];
  const insertValues = [
    "$1::uuid",
    "$2::uuid",
    "'activa'",
    "now()",
    "now() + interval '1 month'",
    "FALSE",
    "FALSE",
    "$3::uuid",
  ];
  const insertParams = [clienteId, idPlan, usuarioId ?? null];

  if (capabilities.hasSubsSucursalContratada) {
    insertColumns.push("id_sucursal_contratada");
    insertValues.push("$4::uuid");
    insertParams.push(idSucursal);
  }
  if (capabilities.hasSubsBeneficiosSnapshot) {
    const bindIndex = insertParams.length + 1;
    insertColumns.push("beneficios_snapshot");
    insertValues.push(`$${bindIndex}::jsonb`);
    insertParams.push(JSON.stringify(snapshot));
  }

  const { rows } = await client.query(
    `
      INSERT INTO public.subscriptions (
        ${insertColumns.join(", ")}
      )
      VALUES (
        ${insertValues.join(", ")}
      )
      RETURNING *
    `,
    insertParams
  );

  const subscription = rows[0];

  if (capabilities.hasSubscriptionPayments) {
    await client.query(
      `
        INSERT INTO public.subscription_payments (
          id_suscripcion,
          monto_hnl,
          moneda_codigo,
          metodo,
          estado,
          id_payment,
          registrado_por_usuario_id
        )
        VALUES (
          $1::uuid,
          $2::numeric,
          'HNL',
          'online',
          'pendiente',
          NULL,
          $3::uuid
        )
      `,
      [subscription.id_suscripcion, toNumber(planOffer.precio_hnl, 0), usuarioId ?? null]
    );
  }

  return {
    subscription,
    plan: {
      id_plan: planOffer.id_plan,
      nombre_plan: planOffer.nombre_plan,
      descripcion: planOffer.descripcion ?? null,
      categoria_nivel: toInt(planOffer.categoria_nivel, 1),
      precio_hnl: toNumber(planOffer.precio_hnl, 0),
      periodo_membresia_codigo: planOffer.periodo_membresia_codigo,
    },
    snapshot,
    transition: {
      tipo: transitionType,
      tenia_plan_activo: Boolean(previousActive),
      suscripcion_anterior_id: previousActive?.id_suscripcion ?? null,
      suscripcion_anterior_cerrada_id: closedPrevious?.id_suscripcion ?? null,
      id_plan_anterior: previousActive?.id_plan ?? null,
      id_plan_nuevo: idPlan,
    },
  };
}

function mapConsumptionHistory(rows = []) {
  return rows.slice(0, 40).map((row) => ({
    id_consumo: row.id_consumo,
    id_cita: row.id_cita,
    orden_integrante: row.orden_integrante ?? null,
    item_tipo: row.item_tipo,
    tipo_movimiento: row.coverage_status,
    consumio_servicio: String(row.item_tipo || "") === MEMBERSHIP_CONSUMPTION_TYPES.SERVICE,
    consumio_cortesia: String(row.item_tipo || "") === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY,
    id_servicio: row.id_servicio ?? null,
    id_cortesia: row.id_cortesia ?? null,
    item_nombre: row.item_nombre,
    item_codigo: row.item_codigo ?? null,
    cantidad: toInt(row.cantidad, 0),
    coverage_status: row.coverage_status,
    source_kind: row.source_kind ?? null,
    invalidado: Boolean(row.invalidado),
    invalidado_motivo: row.invalidado_motivo ?? null,
    estado_cita_codigo: row.estado_cita_codigo ?? null,
    id_sucursal: row.id_sucursal ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
    id_usuario_ejecutor: row.id_usuario_ejecutor ?? null,
    nombre_usuario_ejecutor: row.nombre_usuario_ejecutor ?? null,
    total_hnl: toNumber(row.total_hnl, 0),
    created_at: toIsoDateTime(row.created_at),
  }));
}

async function getPlanDisplayInfo(client, idPlan, idSucursal) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasMembershipPlans) return null;
  const selectCategoria = capabilities.hasPlanCategoriaNivel
    ? "mp.categoria_nivel"
    : "1::smallint AS categoria_nivel";

  try {
    const { rows } = await client.query(
      `
        WITH scoped_offers AS (
          SELECT
            mps.id_plan,
            mps.id_sucursal,
            mps.precio_hnl,
            mps.activo,
            mps.visible_publico,
            ROW_NUMBER() OVER (
              PARTITION BY mps.id_plan, mps.id_sucursal
              ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
            ) AS rn
          FROM public.membership_plans_sucursal mps
          WHERE mps.id_plan = $1::uuid
            AND ($2::uuid IS NULL OR mps.id_sucursal = $2::uuid)
        )
        SELECT
          mp.id_plan,
          mp.nombre_plan,
          mp.descripcion,
          ${selectCategoria},
          mp.periodo_membresia_codigo,
          so.id_sucursal,
          so.precio_hnl,
          so.activo AS oferta_activa,
          so.visible_publico
        FROM public.membership_plans mp
        LEFT JOIN scoped_offers so
          ON so.id_plan = mp.id_plan
         AND so.rn = 1
        WHERE mp.id_plan = $1::uuid
        LIMIT 1
      `,
      [idPlan, idSucursal ?? null]
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return null;
    throw error;
  }
}

async function getMembershipPointsSummary(client, clienteId) {
  const capabilities = await getMembershipCapabilities(client);
  const summary = {
    titular: 0,
    integrante: 0,
  };

  if (!capabilities.hasPointsTransactions) {
    return summary;
  }

  try {
    if (!capabilities.hasPointsOrigenCodigo) {
      const { rows } = await client.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.points_transactions
          WHERE id_cliente = $1::uuid
            AND tipo_puntos_codigo IN ('acumular', 'ganancia')
        `,
        [clienteId]
      );
      summary.titular = Number(rows?.[0]?.total || 0);
      return summary;
    }

    const { rows } = await client.query(
      `
        SELECT origen_punto_codigo, COUNT(*)::int AS total
        FROM public.points_transactions
        WHERE id_cliente = $1::uuid
          AND tipo_puntos_codigo IN ('acumular', 'ganancia')
        GROUP BY origen_punto_codigo
      `,
      [clienteId]
    );

    for (const row of rows) {
      const origin = normalizeText(row.origen_punto_codigo).toLowerCase();
      if (origin === 'integrante') {
        summary.integrante += Number(row.total || 0);
      } else {
        summary.titular += Number(row.total || 0);
      }
    }

    return summary;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return summary;
    throw error;
  }
}

export async function getClienteMembershipState(client, clienteId) {
  // AM: Estado resiliente; nunca debe depender de columnas/tablas opcionales para responder.
  const lifecycle = await ensureSubscriptionLifecycle(client, clienteId, { forUpdate: false });
  const hasSubscriptions = (await getAnySubscriptionCount(client, clienteId)) > 0;
  const puntos = await getMembershipPointsSummary(client, clienteId);

  const subscriptionsHistoryRows = await listSubscriptionHistoryRows(client, clienteId, { limit: 20 });
  const historialMembresias = subscriptionsHistoryRows.map((row) => ({
    id_suscripcion: row.id_suscripcion,
    id_plan: row.id_plan,
    nombre_plan: row.nombre_plan,
    categoria_nivel: toInt(row.categoria_nivel, 1),
    estado_suscripcion_codigo: row.estado_suscripcion_codigo,
    estado_visible: resolveMembershipVisibleState(row),
    inicio_at: toIsoDateTime(row.inicio_at),
    fin_at: toIsoDateTime(row.fin_at),
    motivo_fin_codigo: row.motivo_fin_codigo ?? null,
    id_sucursal_contratada: row.id_sucursal_contratada ?? null,
    created_at: toIsoDateTime(row.created_at),
  }));

  if (!lifecycle.active) {
    const latest = subscriptionsHistoryRows[0] ?? null;
    const historicConsumptionRows = await getClienteConsumptionRows(client, clienteId, { limit: 40 });
    const estadoVisible = resolveMembershipVisibleState(latest);
    return {
      estado_plan: estadoVisible,
      cta_recomendada: hasSubscriptions ? "actualizar" : "adquirir",
      tiene_historial: hasSubscriptions,
      plan_activo: null,
      ultimo_plan: latest
        ? {
          id_suscripcion: latest.id_suscripcion,
          id_plan: latest.id_plan,
          nombre_plan: latest.nombre_plan,
          categoria_nivel: toInt(latest.categoria_nivel, 1),
          estado_suscripcion_codigo: latest.estado_suscripcion_codigo,
          estado_visible: estadoVisible,
          inicio_at: toIsoDateTime(latest.inicio_at),
          fin_at: toIsoDateTime(latest.fin_at),
          motivo_fin_codigo: latest.motivo_fin_codigo ?? null,
          id_sucursal_contratada: latest.id_sucursal_contratada ?? null,
        }
        : null,
      bloqueo_actualizacion: null,
      masterpuntos: puntos,
      historial_consumos: mapConsumptionHistory(historicConsumptionRows),
      historial_membresias: historialMembresias,
    };
  }

  const active = lifecycle.active;
  const summary = lifecycle.summary || summarizeBenefits(active.beneficios_snapshot, active.consumo_rows);
  const planInfo = await getPlanDisplayInfo(client, active.id_plan, active.id_sucursal_contratada);
  const estadoVisibleActivo = resolveMembershipVisibleState(active, {
    summary,
    timeRemaining: lifecycle.time_remaining,
  });

  return {
    estado_plan: estadoVisibleActivo,
    cta_recomendada: "actualizar",
    tiene_historial: true,
    plan_activo: {
      id_suscripcion: active.id_suscripcion,
      id_plan: active.id_plan,
      nombre_plan: planInfo?.nombre_plan || active.nombre_plan,
      descripcion: planInfo?.descripcion ?? active.plan_descripcion ?? null,
      categoria_nivel: toInt(planInfo?.categoria_nivel ?? active.categoria_nivel, 1),
      periodo_membresia_codigo: planInfo?.periodo_membresia_codigo || active.periodo_membresia_codigo,
      precio_hnl: toNumber(planInfo?.precio_hnl, 0),
      estado_suscripcion_codigo: active.estado_suscripcion_codigo,
      estado_visible: estadoVisibleActivo,
      inicio_at: toIsoDateTime(active.inicio_at),
      fin_at: toIsoDateTime(active.fin_at),
      id_sucursal_contratada: active.id_sucursal_contratada ?? null,
      tiempo_restante: lifecycle.time_remaining,
      ultimo_servicio_restante: Number(summary?.totales?.servicios_restantes || 0) === 1,
      remanentes: summary,
    },
    ultimo_plan: null,
    bloqueo_actualizacion: buildUpgradeBlockedDetails(lifecycle),
    masterpuntos: puntos,
    historial_consumos: mapConsumptionHistory(active.consumo_rows),
    historial_membresias: historialMembresias,
  };
}

async function listAppointmentServiceDetails(client, idCita) {
  const { rows } = await client.query(
    `
      SELECT
        cd.id_servicio,
        COALESCE(s.nombre_servicio, 'Servicio') AS nombre_servicio
      FROM public.citas_detalles cd
      LEFT JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      WHERE cd.id_cita = $1::uuid
      ORDER BY cd.id_cita_detalle ASC
    `,
    [idCita]
  );
  return rows;
}

async function getOperationalConsumptionStateForAppointment(client, idCita) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionConsumptions) {
    return {
      hasService: false,
      hasCourtesy: false,
    };
  }
  const sourceKindClause = capabilities.hasSubcSourceKind
    ? "AND sc.source_kind = 'appointment_completed'"
    : "";
  const invalidadoClause = capabilities.hasSubcInvalidado
    ? "AND COALESCE(sc.invalidado, FALSE) IS FALSE"
    : "";
  const { rows } = await client.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE sc.item_tipo = $3::text) AS service_count,
        COUNT(*) FILTER (WHERE sc.item_tipo = $4::text) AS courtesy_count
      FROM public.subscription_consumptions sc
      WHERE sc.id_cita = $1::uuid
        AND sc.coverage_status = $2::text
        ${sourceKindClause}
        ${invalidadoClause}
    `,
    [idCita, COVERAGE_STATUS.COVERED, MEMBERSHIP_CONSUMPTION_TYPES.SERVICE, MEMBERSHIP_CONSUMPTION_TYPES.COURTESY]
  );
  return {
    hasService: Number(rows?.[0]?.service_count || 0) > 0,
    hasCourtesy: Number(rows?.[0]?.courtesy_count || 0) > 0,
  };
}

function pickServiceBenefitForConsumption(summary, appointmentServiceRows = []) {
  const byServiceId = new Map(
    (Array.isArray(summary?.servicios) ? summary.servicios : [])
      .filter((service) => service?.id_servicio)
      .map((service) => [service.id_servicio, service])
  );

  for (const row of appointmentServiceRows) {
    const idServicio = normalizeText(row?.id_servicio);
    if (!idServicio) continue;
    const benefit = byServiceId.get(idServicio);
    if (toInt(benefit?.restante, 0) > 0) {
      return {
        id_servicio: idServicio,
        nombre: normalizeText(benefit?.nombre) || normalizeText(row?.nombre_servicio) || "Servicio",
      };
    }
  }

  const fallback = (Array.isArray(summary?.servicios) ? summary.servicios : [])
    .find((service) => toInt(service?.restante, 0) > 0);
  if (!fallback) return null;
  return {
    id_servicio: normalizeText(fallback.id_servicio),
    nombre: normalizeText(fallback.nombre) || "Servicio",
  };
}

function pickCourtesyBenefitForConsumption(summary) {
  const courtesy = (Array.isArray(summary?.cortesias) ? summary.cortesias : [])
    .filter((item) => Boolean(normalizeText(item?.id_cortesia)))
    .find((item) => toInt(item?.restante, 0) > 0);
  if (!courtesy) return null;
  return {
    id_cortesia: normalizeText(courtesy.id_cortesia) || null,
    nombre: normalizeText(courtesy.nombre) || "Cortesia",
  };
}

export async function consumeMembershipForCompletedAppointment(client, {
  idCita,
  idCliente,
  idSucursal,
  ordenIntegrante = null,
  usuarioEjecutorId = null,
} = {}) {
  const safeIdCita = normalizeText(idCita);
  const safeIdCliente = normalizeText(idCliente);
  const safeIdSucursal = normalizeText(idSucursal);
  if (!safeIdCita || !safeIdCliente) {
    return { aplicado: false, motivo: "sin_contexto_consumo" };
  }

  const lifecycle = await ensureSubscriptionLifecycle(client, safeIdCliente, { forUpdate: true });
  if (!lifecycle.active) {
    return { aplicado: false, motivo: "sin_suscripcion_activa" };
  }

  const activeSubscription = lifecycle.active;
  const currentSummary = lifecycle.summary || summarizeBenefits(activeSubscription.beneficios_snapshot, activeSubscription.consumo_rows);
  if (activeSubscription.id_sucursal_contratada && safeIdSucursal && activeSubscription.id_sucursal_contratada !== safeIdSucursal) {
    throw new AppError(409, "La membresia activa no corresponde a la sucursal de la cita", {
      code: "MEMBERSHIP_CONSUMPTION_BRANCH_MISMATCH",
      details: {
        id_suscripcion: activeSubscription.id_suscripcion,
        id_sucursal_cita: safeIdSucursal,
        id_sucursal_membresia: activeSubscription.id_sucursal_contratada,
      },
    });
  }

  const consumptionState = await getOperationalConsumptionStateForAppointment(client, safeIdCita);
  const alreadyHasService = Boolean(consumptionState?.hasService);
  const alreadyHasCourtesy = Boolean(consumptionState?.hasCourtesy);
  const eligibleCourtesies = (Array.isArray(currentSummary?.cortesias) ? currentSummary.cortesias : [])
    .filter((item) => Boolean(normalizeText(item?.id_cortesia)));
  const cortesiasTotales = eligibleCourtesies.reduce((acc, item) => acc + Number(item?.total || 0), 0);
  const cortesiasRestantes = eligibleCourtesies.reduce((acc, item) => acc + Number(item?.restante || 0), 0);
  const requiresCourtesyConsumption = cortesiasTotales > 0;
  if (alreadyHasService && (!requiresCourtesyConsumption || alreadyHasCourtesy)) {
    return {
      aplicado: false,
      motivo: "consumo_ya_registrado",
      id_suscripcion: activeSubscription.id_suscripcion,
      resumen: currentSummary,
      ultimo_servicio_restante: Number(currentSummary?.totales?.servicios_restantes || 0) === 1,
    };
  }

  const serviciosRestantes = Number(currentSummary?.totales?.servicios_restantes || 0);
  if (!alreadyHasService && serviciosRestantes < 1) {
    throw new AppError(409, "La membresia no tiene servicios disponibles para completar esta cita", {
      code: "MEMBERSHIP_CONSUMPTION_SERVICE_BALANCE_INSUFFICIENT",
      details: {
        id_suscripcion: activeSubscription.id_suscripcion,
        servicios_restantes: serviciosRestantes,
      },
    });
  }

  if (requiresCourtesyConsumption && !alreadyHasCourtesy && cortesiasRestantes < 1) {
    throw new AppError(409, "La membresia no tiene cortesias disponibles para completar esta cita", {
      code: "MEMBERSHIP_CONSUMPTION_COURTESY_BALANCE_INSUFFICIENT",
      details: {
        id_suscripcion: activeSubscription.id_suscripcion,
        cortesias_restantes: cortesiasRestantes,
      },
    });
  }

  const entries = [];
  if (!alreadyHasService) {
    const appointmentServiceRows = await listAppointmentServiceDetails(client, safeIdCita);
    const selectedService = pickServiceBenefitForConsumption(currentSummary, appointmentServiceRows);
    if (!selectedService?.id_servicio) {
      throw new AppError(409, "No se encontro un servicio valido para consumir en la membresia activa", {
        code: "MEMBERSHIP_CONSUMPTION_SERVICE_NOT_MATCHED",
        details: {
          id_suscripcion: activeSubscription.id_suscripcion,
          id_cita: safeIdCita,
        },
      });
    }

    entries.push({
      item_tipo: MEMBERSHIP_CONSUMPTION_TYPES.SERVICE,
      id_servicio: selectedService.id_servicio,
      id_cortesia: null,
      item_codigo: null,
      item_nombre: selectedService.nombre,
      cantidad: 1,
      precio_unitario_hnl: 0,
      total_hnl: 0,
      coverage_status: COVERAGE_STATUS.COVERED,
      source_key: `appointment:${safeIdCita}:${MEMBERSHIP_CONSUMPTION_TYPES.SERVICE}`,
      source_kind: "appointment_completed",
      invalidado: false,
      invalidado_motivo: null,
    });
  }

  if (requiresCourtesyConsumption && !alreadyHasCourtesy) {
    const selectedCourtesy = pickCourtesyBenefitForConsumption(currentSummary);
    if (!selectedCourtesy?.id_cortesia) {
      throw new AppError(409, "No se encontro una cortesia valida para consumir en la membresia activa", {
        code: "MEMBERSHIP_CONSUMPTION_COURTESY_NOT_MATCHED",
        details: {
          id_suscripcion: activeSubscription.id_suscripcion,
          id_cita: safeIdCita,
        },
      });
    }

    entries.push({
      item_tipo: MEMBERSHIP_CONSUMPTION_TYPES.COURTESY,
      id_servicio: null,
      id_cortesia: selectedCourtesy.id_cortesia,
      // AM: item_codigo/item_nombre quedan como snapshot visual, no como referencia funcional.
      item_codigo: selectedCourtesy.id_cortesia,
      item_nombre: selectedCourtesy.nombre,
      cantidad: 1,
      precio_unitario_hnl: 0,
      total_hnl: 0,
      coverage_status: COVERAGE_STATUS.COVERED,
      source_key: `appointment:${safeIdCita}:${MEMBERSHIP_CONSUMPTION_TYPES.COURTESY}`,
      source_kind: "appointment_completed",
      invalidado: false,
      invalidado_motivo: null,
    });
  }

  if (!entries.length) {
    return {
      aplicado: false,
      motivo: "consumo_ya_registrado",
      id_suscripcion: activeSubscription.id_suscripcion,
      resumen: currentSummary,
      ultimo_servicio_restante: Number(currentSummary?.totales?.servicios_restantes || 0) === 1,
    };
  }

  await insertSubscriptionConsumptionRows(client, {
    idSuscripcion: activeSubscription.id_suscripcion,
    idCliente: safeIdCliente,
    idCita: safeIdCita,
    ordenIntegrante,
    usuarioEjecutorId,
    entries,
  });

  const refreshedConsumptionRows = await getSubscriptionConsumptionRows(client, activeSubscription.id_suscripcion);
  const refreshedSummary = summarizeBenefits(activeSubscription.beneficios_snapshot, refreshedConsumptionRows);

  return {
    aplicado: true,
    motivo: "consumo_registrado",
    id_suscripcion: activeSubscription.id_suscripcion,
    consumos_registrados: entries.length,
    consumo_servicio: alreadyHasService || entries.some((entry) => entry.item_tipo === MEMBERSHIP_CONSUMPTION_TYPES.SERVICE),
    consumo_cortesia: requiresCourtesyConsumption
      ? (alreadyHasCourtesy || entries.some((entry) => entry.item_tipo === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY))
      : false,
    ultimo_servicio_restante: Number(refreshedSummary?.totales?.servicios_restantes || 0) === 1,
    resumen: refreshedSummary,
  };
}

export function createCoverageTracker(activeContext) {
  if (!activeContext?.active || !activeContext?.summary) {
    return {
      hasPlan: false,
      idSuscripcion: null,
      serviceRemaining: new Map(),
      planName: null,
    };
  }

  const serviceRemaining = new Map();
  for (const service of activeContext.summary.servicios || []) {
    if (!service?.id_servicio) continue;
    serviceRemaining.set(service.id_servicio, toInt(service.restante, 0));
  }

  return {
    hasPlan: true,
    idSuscripcion: activeContext.active.id_suscripcion,
    serviceRemaining,
    planName: activeContext.active.nombre_plan || null,
  };
}

export function consumeCoverageForServices(tracker, serviceItems = [], { isTitular = true } = {}) {
  const result = {
    items: [],
    coveredTotalHnl: 0,
    extraTotalHnl: 0,
  };

  const list = Array.isArray(serviceItems) ? serviceItems : [];
  for (const item of list) {
    const idServicio = normalizeText(item?.id_servicio);
    const nombre = normalizeText(item?.nombre_servicio) || "Servicio";
    const price = toNumber(item?.precio_hnl, 0);
    const quantity = 1;

    let status = COVERAGE_STATUS.EXTRA_PENDING;
    if (tracker?.hasPlan && isTitular && idServicio) {
      const current = toInt(tracker.serviceRemaining.get(idServicio), 0);
      if (current > 0) {
        tracker.serviceRemaining.set(idServicio, current - 1);
        status = COVERAGE_STATUS.COVERED;
      }
    }

    if (status === COVERAGE_STATUS.COVERED) {
      result.coveredTotalHnl += price * quantity;
    } else {
      result.extraTotalHnl += price * quantity;
    }

    result.items.push({
      item_tipo: "servicio",
      id_servicio: idServicio || null,
      item_codigo: null,
      item_nombre: nombre,
      cantidad: quantity,
      precio_unitario_hnl: price,
      total_hnl: price * quantity,
      coverage_status: status,
    });
  }
  return result;
}

export async function insertSubscriptionConsumptionRows(client, {
  idSuscripcion,
  idCliente,
  idCita,
  ordenIntegrante = null,
  usuarioEjecutorId = null,
  entries = [],
}) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionConsumptions) return;

  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const itemTipo = normalizeText(entry?.item_tipo).toLowerCase();
    const coverageStatus = normalizeText(entry?.coverage_status).toLowerCase();
    if (![MEMBERSHIP_CONSUMPTION_TYPES.SERVICE, MEMBERSHIP_CONSUMPTION_TYPES.COURTESY].includes(itemTipo)) continue;
    if (!Object.values(COVERAGE_STATUS).includes(coverageStatus)) continue;

    const idServicio = entry?.id_servicio ? normalizeText(entry.id_servicio) : null;
    const idCortesia = entry?.id_cortesia ? normalizeText(entry.id_cortesia) : null;
    const itemCodigo = entry?.item_codigo ? normalizeText(entry.item_codigo) : null;
    const sourceKey = normalizeText(entry?.source_key)
      || `sus:${idSuscripcion}:cita:${idCita}:ord:${ordenIntegrante ?? 1}:item:${index + 1}:${itemTipo}:${idServicio || itemCodigo || "generic"}`;
    const insertColumns = [
      "id_suscripcion",
      "id_cliente",
      "id_cita",
      "orden_integrante",
      "item_tipo",
      "id_servicio",
      "id_cortesia",
      "item_codigo",
      "item_nombre",
      "cantidad",
      "precio_unitario_hnl",
      "total_hnl",
      "coverage_status",
      "source_key",
    ];
    const insertValues = [
      "$1::uuid",
      "$2::uuid",
      "$3::uuid",
      "$4::int",
      "$5::text",
      "$6::uuid",
      "$7::uuid",
      "$8::text",
      "$9::text",
      "$10::int",
      "$11::numeric",
      "$12::numeric",
      "$13::text",
      "$14::text",
    ];
    const insertParams = [
      idSuscripcion,
      idCliente,
      idCita,
      ordenIntegrante == null ? null : Number(ordenIntegrante),
      itemTipo,
      idServicio || null,
      idCortesia || null,
      itemCodigo,
      normalizeText(entry?.item_nombre) || (itemTipo === MEMBERSHIP_CONSUMPTION_TYPES.COURTESY ? "Cortesia" : "Servicio"),
      Math.max(1, toInt(entry?.cantidad, 1)),
      Math.max(0, toNumber(entry?.precio_unitario_hnl, 0)),
      Math.max(0, toNumber(entry?.total_hnl, 0)),
      coverageStatus,
      sourceKey,
    ];
    if (capabilities.hasSubcSourceKind) {
      const bindIndex = insertParams.length + 1;
      insertColumns.push("source_kind");
      insertValues.push(`$${bindIndex}::text`);
      insertParams.push(normalizeText(entry?.source_kind) || "appointment_completed");
    }
    if (capabilities.hasSubcInvalidado) {
      const bindIndex = insertParams.length + 1;
      insertColumns.push("invalidado");
      insertValues.push(`$${bindIndex}::boolean`);
      insertParams.push(Boolean(entry?.invalidado));
    }
    if (capabilities.hasSubcInvalidadoMotivo) {
      const bindIndex = insertParams.length + 1;
      insertColumns.push("invalidado_motivo");
      insertValues.push(`$${bindIndex}::text`);
      insertParams.push(normalizeText(entry?.invalidado_motivo) || null);
    }
    if (capabilities.hasSubcUsuarioEjecutor) {
      const bindIndex = insertParams.length + 1;
      insertColumns.push("id_usuario_ejecutor");
      insertValues.push(`$${bindIndex}::uuid`);
      insertParams.push(normalizeText(usuarioEjecutorId) || null);
    }

    try {
      await client.query(
        `
          INSERT INTO public.subscription_consumptions (
            ${insertColumns.join(", ")}
          )
          VALUES (
            ${insertValues.join(", ")}
          )
          ON CONFLICT (source_key)
          DO NOTHING
        `,
        insertParams
      );
    } catch (error) {
      if (isSchemaCompatibilityError(error)) return;
      throw error;
    }
  }
}

export async function registerSubscriptionAlertEvent(client, { idSuscripcion, alertType, payload = {} }) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionAlertEvents) return false;

  const normalizedType = normalizeText(alertType).toLowerCase();
  if (!["adquisicion", "vencimiento_3_dias", "saldo_1_1"].includes(normalizedType)) {
    throw new AppError(400, "Tipo de alerta de membresía inválido", {
      code: "MEMBERSHIP_ALERT_TYPE_INVALID",
      details: { alert_type: alertType },
    });
  }

  try {
    const { rowCount } = await client.query(
      `
        INSERT INTO public.subscription_alert_events (
          id_suscripcion,
          alert_type,
          payload
        )
        VALUES ($1::uuid, $2::text, $3::jsonb)
        ON CONFLICT (id_suscripcion, alert_type)
        DO NOTHING
      `,
      [idSuscripcion, normalizedType, JSON.stringify(payload || {})]
    );
    return rowCount > 0;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return false;
    throw error;
  }
}

export async function listActiveSubscriptionsForAlerts(client) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions || !capabilities.hasMembershipPlans) return [];
  const selectSucursal = capabilities.hasSubsSucursalContratada
    ? "s.id_sucursal_contratada"
    : "NULL::uuid AS id_sucursal_contratada";
  const selectSnapshot = capabilities.hasSubsBeneficiosSnapshot
    ? "s.beneficios_snapshot"
    : `${EMPTY_SNAPSHOT_SQL_LITERAL}::jsonb AS beneficios_snapshot`;

  try {
    const { rows } = await client.query(
      `
        SELECT
          s.id_suscripcion,
          s.id_cliente,
          s.id_plan,
          s.inicio_at,
          s.fin_at,
          ${selectSucursal},
          ${selectSnapshot},
          mp.nombre_plan,
          COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Cliente') AS nombre_cliente,
          cp.email AS correo_principal
        FROM public.subscriptions s
        JOIN public.membership_plans mp
          ON mp.id_plan = s.id_plan
        JOIN public.clientes c
          ON c.id_cliente = s.id_cliente
        JOIN public.personas p
          ON p.id_persona = c.id_persona
        LEFT JOIN LATERAL (
          SELECT cr.direccion_correo::text AS email
          FROM public.correos cr
          WHERE cr.id_persona = c.id_persona
            AND cr.deleted_at IS NULL
          ORDER BY cr.es_principal DESC NULLS LAST, cr.verificado DESC NULLS LAST, cr.id_correo ASC
          LIMIT 1
        ) cp ON TRUE
        WHERE s.estado_suscripcion_codigo = 'activa'
        ORDER BY s.fin_at ASC
      `
    );
    return rows;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return [];
    throw error;
  }
}

export function classifyExpiryAlert(subscriptionRow, { thresholdDays = PENDING_RENEWAL_THRESHOLD_DAYS } = {}) {
  const pendingMeta = isMembershipPendingRenewal({
    summary: null,
    timeRemaining: null,
    finAt: subscriptionRow?.fin_at,
    thresholdDays,
  });
  const days = Number(pendingMeta?.timeRemaining?.dias || 0);
  const shouldNotify = Boolean(pendingMeta.pendingByExpiry);
  return {
    should_notify: shouldNotify,
    dias_restantes: days,
    horas_restantes: Number(pendingMeta?.timeRemaining?.horas || 0),
    minutos_restantes: Number(pendingMeta?.timeRemaining?.minutos || 0),
  };
}

export function summarizeCriticalBalance(snapshot, consumptionRows) {
  const normalizedSnapshot = normalizeBenefitsSnapshot(snapshot);
  const summary = summarizeBenefits(normalizedSnapshot, consumptionRows);
  const serviciosRestantes = Number(summary?.totales?.servicios_restantes || 0);
  const cortesiasRestantes = Number(summary?.totales?.cortesias_restantes || 0);
  return {
    ...summary,
    // AM: Mantiene nombre legacy por compatibilidad, pero el umbral crítico es solo por servicios.
    is_critical_1_1: serviciosRestantes === 1 && (Number(summary?.totales?.cortesias_total || 0) <= 0 || cortesiasRestantes === 1),
    is_last_service_remaining: serviciosRestantes === 1,
  };
}

export { COVERAGE_STATUS, ALLOWED_MOTIVO_FIN };





