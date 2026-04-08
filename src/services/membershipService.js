import { AppError } from "../utils/errors.js";

const ACTIVE_STATUS = "activa";
const EXPIRED_STATUS = "vencida";
const ALLOWED_MOTIVO_FIN = new Set(["tiempo", "agotamiento", "reemplazo", "cancelacion"]);
const COVERAGE_STATUS = {
  COVERED: "cubierto_plan",
  EXTRA_PENDING: "extra_pendiente",
  EXTRA_PAID: "extra_pagado",
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
      const rawType = normalizeText(item?.tipo).toLowerCase();
      // AM: Compatibilidad con beneficios legacy sin tipo cuando viene id_servicio.
      const tipo = rawType === "servicio" || (rawType !== "cortesia" && serviceId) ? "servicio" : rawType;
      const cantidad = toInt(item?.cantidad, 0);
      // AM: Flujo operativo de membresías solo permite beneficios de tipo servicio.
      if (tipo !== "servicio" || cantidad <= 0) return null;
      const idServicio = serviceId || null;
      const nombre = normalizeText(item?.nombre) || "Servicio";
      if (!idServicio) return null;

      return {
        tipo: "servicio",
        id_servicio: idServicio,
        codigo: null,
        nombre,
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

function summarizeBenefits(snapshot, consumptionRows = []) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  const serviceBuckets = new Map();

  for (const item of items) {
    if (item.tipo === "servicio") {
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

  }

  for (const row of consumptionRows) {
    if (row.coverage_status !== COVERAGE_STATUS.COVERED) continue;
    const qty = toInt(row.cantidad, 0);
    if (qty <= 0) continue;

    if (row.item_tipo === "servicio" && row.id_servicio) {
      const key = `servicio:${row.id_servicio}`;
      const bucket = serviceBuckets.get(key);
      if (!bucket) continue;
      bucket.consumido += qty;
      continue;
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

  const serviciosTotal = servicios.reduce((acc, item) => acc + item.total, 0);
  const serviciosConsumidos = servicios.reduce((acc, item) => acc + item.consumido, 0);
  const serviciosRestantes = servicios.reduce((acc, item) => acc + item.restante, 0);
  const beneficiosTotales = serviciosTotal;
  const beneficiosRestantes = serviciosRestantes;
  // AM: Motor operativo cerrado en servicios; cortesías quedan fuera del cómputo de negocio.
  const agotadoPorServicios = serviciosTotal > 0 && serviciosRestantes <= 0;

  return {
    servicios,
    totales: {
      servicios_total: serviciosTotal,
      servicios_consumidos: serviciosConsumidos,
      servicios_restantes: serviciosRestantes,
      beneficios_totales: beneficiosTotales,
      beneficios_restantes: beneficiosRestantes,
      operativo_servicios_total: serviciosTotal,
      operativo_servicios_consumidos: serviciosConsumidos,
      operativo_servicios_restantes: serviciosRestantes,
    },
    agotado: agotadoPorServicios,
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
          sc.item_codigo,
          sc.item_nombre,
          sc.cantidad,
          sc.precio_unitario_hnl,
          sc.total_hnl,
          sc.coverage_status,
          sc.created_at
        FROM public.subscription_consumptions sc
        LEFT JOIN public.citas c
          ON c.id_cita = sc.id_cita
        WHERE sc.id_suscripcion = $1::uuid
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

  if (summary.agotado) {
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

async function getLastSubscriptionRow(client, clienteId) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptions || !capabilities.hasMembershipPlans) return null;
  const selectMotivo = capabilities.hasSubsMotivoFin ? "s.motivo_fin_codigo" : "NULL::text AS motivo_fin_codigo";
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
          ${selectMotivo},
          s.created_at,
          mp.nombre_plan,
          ${selectCategoria}
        FROM public.subscriptions s
        JOIN public.membership_plans mp
          ON mp.id_plan = s.id_plan
        WHERE s.id_cliente = $1::uuid
        ORDER BY s.created_at DESC
        LIMIT 1
      `,
      [clienteId]
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isSchemaCompatibilityError(error)) return null;
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
    },
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

  const lifecycle = await ensureSubscriptionLifecycle(client, clienteId, { forUpdate: true });
  if (lifecycle.active) {
    throw new AppError(409, "Ya tienes un plan activo y vigente. Aún no puedes actualizar.", {
      code: "MEMBERSHIP_UPGRADE_BLOCKED",
      details: buildUpgradeBlockedDetails(lifecycle),
    });
  }

  const planOffer = await getSubscriptionPrice(client, { idPlan, idSucursal });
  if (!planOffer || !planOffer.plan_activo || !planOffer.oferta_activa || !planOffer.visible_publico) {
    throw new AppError(404, "El plan seleccionado no está disponible para adquisición.", {
      code: "MEMBERSHIP_PLAN_NOT_AVAILABLE",
      details: { id_plan: idPlan, id_sucursal: idSucursal },
    });
  }

  const snapshot = normalizeBenefitsSnapshot(planOffer.beneficios);
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
  };
}

function mapConsumptionHistory(rows = []) {
  return rows.slice(0, 40).map((row) => ({
    id_consumo: row.id_consumo,
    id_cita: row.id_cita,
    orden_integrante: row.orden_integrante ?? null,
    item_tipo: row.item_tipo,
    item_nombre: row.item_nombre,
    item_codigo: row.item_codigo ?? null,
    cantidad: toInt(row.cantidad, 0),
    coverage_status: row.coverage_status,
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

  if (!lifecycle.active) {
    const latest = await getLastSubscriptionRow(client, clienteId);
    return {
      estado_plan: "sin_plan_activo",
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
          inicio_at: toIsoDateTime(latest.inicio_at),
          fin_at: toIsoDateTime(latest.fin_at),
          motivo_fin_codigo: latest.motivo_fin_codigo ?? null,
        }
        : null,
      bloqueo_actualizacion: null,
      masterpuntos: puntos,
      historial_consumos: [],
    };
  }

  const active = lifecycle.active;
  const summary = lifecycle.summary || summarizeBenefits(active.beneficios_snapshot, active.consumo_rows);
  const planInfo = await getPlanDisplayInfo(client, active.id_plan, active.id_sucursal_contratada);

  return {
    estado_plan: "activo",
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
      inicio_at: toIsoDateTime(active.inicio_at),
      fin_at: toIsoDateTime(active.fin_at),
      id_sucursal_contratada: active.id_sucursal_contratada ?? null,
      tiempo_restante: lifecycle.time_remaining,
      remanentes: summary,
    },
    ultimo_plan: null,
    bloqueo_actualizacion: buildUpgradeBlockedDetails(lifecycle),
    masterpuntos: puntos,
    historial_consumos: mapConsumptionHistory(active.consumo_rows),
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
  entries = [],
}) {
  const capabilities = await getMembershipCapabilities(client);
  if (!capabilities.hasSubscriptionConsumptions) return;

  const source = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const itemTipo = normalizeText(entry?.item_tipo).toLowerCase();
    const coverageStatus = normalizeText(entry?.coverage_status).toLowerCase();
    if (itemTipo !== "servicio") continue;
    if (!Object.values(COVERAGE_STATUS).includes(coverageStatus)) continue;

    const idServicio = entry?.id_servicio ? normalizeText(entry.id_servicio) : null;
    const itemCodigo = entry?.item_codigo ? normalizeText(entry.item_codigo) : null;
    const sourceKey = `sus:${idSuscripcion}:cita:${idCita}:ord:${ordenIntegrante ?? 1}:item:${index + 1}:${itemTipo}:${idServicio || itemCodigo || "generic"}`;

    try {
      await client.query(
        `
          INSERT INTO public.subscription_consumptions (
            id_suscripcion,
            id_cliente,
            id_cita,
            orden_integrante,
            item_tipo,
            id_servicio,
            item_codigo,
            item_nombre,
            cantidad,
            precio_unitario_hnl,
            total_hnl,
            coverage_status,
            source_key
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::int,
            $5::text,
            $6::uuid,
            $7::text,
            $8::text,
            $9::int,
            $10::numeric,
            $11::numeric,
            $12::text,
            $13::text
          )
          ON CONFLICT (source_key)
          DO NOTHING
        `,
        [
          idSuscripcion,
          idCliente,
          idCita,
          ordenIntegrante == null ? null : Number(ordenIntegrante),
          itemTipo,
          idServicio || null,
          itemCodigo,
            normalizeText(entry?.item_nombre) || "Servicio",
          Math.max(1, toInt(entry?.cantidad, 1)),
          Math.max(0, toNumber(entry?.precio_unitario_hnl, 0)),
          Math.max(0, toNumber(entry?.total_hnl, 0)),
          coverageStatus,
          sourceKey,
        ]
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

export function classifyExpiryAlert(subscriptionRow, { thresholdDays = 3 } = {}) {
  const time = computeTimeRemaining(subscriptionRow?.fin_at);
  const days = Number(time?.dias || 0);
  const shouldNotify = !time.vencido && days <= thresholdDays;
  return {
    should_notify: shouldNotify,
    dias_restantes: days,
    horas_restantes: Number(time?.horas || 0),
    minutos_restantes: Number(time?.minutos || 0),
  };
}

export function summarizeCriticalBalance(snapshot, consumptionRows) {
  const normalizedSnapshot = normalizeBenefitsSnapshot(snapshot);
  const summary = summarizeBenefits(normalizedSnapshot, consumptionRows);
  return {
    ...summary,
    // AM: Mantiene nombre legacy por compatibilidad, pero el umbral crítico es solo por servicios.
    is_critical_1_1:
      Number(summary?.totales?.servicios_restantes || 0) === 1,
  };
}

export { COVERAGE_STATUS, ALLOWED_MOTIVO_FIN };





