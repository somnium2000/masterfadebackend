import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
// AM: Se permite cortesia para exhibicion comercial; el motor operativo sigue en servicios.
const PLAN_BENEFIT_TYPES = ["servicio", "cortesia"];
const PLAN_BENEFIT_MAX_CANTIDAD = 999;
const PLAN_CATEGORY_MIN = 1;
const PLAN_CATEGORY_MAX = 5;
const DEFAULT_PLAN_CATEGORY = 1;
const requestIdSchema = { type: "string" };

const errorResponseSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
      additionalProperties: true,
    },
    requestId: requestIdSchema,
  },
  required: ["ok", "error"],
  additionalProperties: true,
};

const queryBranchSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const planBenefitBodySchema = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: PLAN_BENEFIT_TYPES },
    id_servicio: { type: ["string", "null"], format: "uuid" },
    id_cortesia: { type: ["string", "null"], format: "uuid" },
    codigo: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    nombre: { type: ["string", "null"], minLength: 1, maxLength: 160 },
    cantidad: { type: "integer", minimum: 1, maximum: PLAN_BENEFIT_MAX_CANTIDAD },
  },
  required: ["tipo", "cantidad"],
  additionalProperties: false,
};

const planBodySchema = {
  type: "object",
  properties: {
    nombre_plan: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    precio_hnl: { type: "number", exclusiveMinimum: 0 },
    periodo_membresia_codigo: { type: "string", minLength: 1, maxLength: 40 },
    categoria_nivel: { type: "integer", minimum: PLAN_CATEGORY_MIN, maximum: PLAN_CATEGORY_MAX },
    beneficios: {
      type: "array",
      minItems: 1,
      items: planBenefitBodySchema,
    },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    visible_publico: { type: "boolean" },
    orden_visual: { type: "integer", minimum: 0 },
  },
  required: ["nombre_plan", "precio_hnl", "beneficios"],
  additionalProperties: false,
};

const planPatchSchema = {
  type: "object",
  properties: {
    nombre_plan: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    precio_hnl: { type: "number", exclusiveMinimum: 0 },
    periodo_membresia_codigo: { type: "string", minLength: 1, maxLength: 40 },
    categoria_nivel: { type: "integer", minimum: PLAN_CATEGORY_MIN, maximum: PLAN_CATEGORY_MAX },
    beneficios: {
      type: "array",
      minItems: 1,
      items: planBenefitBodySchema,
    },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    visible_publico: { type: "boolean" },
    orden_visual: { type: "integer", minimum: 0 },
  },
  minProperties: 1,
  additionalProperties: false,
};

const planStateBodySchema = {
  type: "object",
  properties: {
    activo: { type: "boolean" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    confirmar_clientes_activos: { type: "boolean" },
  },
  required: ["activo"],
  additionalProperties: false,
};

const planBenefitResponseSchema = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: PLAN_BENEFIT_TYPES },
    id_servicio: { type: ["string", "null"], format: "uuid" },
    id_cortesia: { type: ["string", "null"], format: "uuid" },
    codigo: { type: ["string", "null"] },
    nombre: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["tipo", "id_servicio", "id_cortesia", "codigo", "nombre", "cantidad"],
  additionalProperties: false,
};

const planResponseSchema = {
  type: "object",
  properties: {
    id_plan: { type: "string", format: "uuid" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    nombre_plan: { type: "string" },
    descripcion: { type: ["string", "null"] },
    periodo_membresia_codigo: { type: "string" },
    periodo_membresia_label: { type: "string" },
    categoria_nivel: { type: "integer", minimum: PLAN_CATEGORY_MIN, maximum: PLAN_CATEGORY_MAX },
    precio_hnl: { type: ["number", "null"] },
    activo: { type: "boolean" },
    visible_publico: { type: "boolean" },
    orden_visual: { type: "integer" },
    beneficios: { type: "array", items: planBenefitResponseSchema },
  },
  required: [
    "id_plan",
    "id_sucursal",
    "nombre_plan",
    "descripcion",
    "periodo_membresia_codigo",
    "periodo_membresia_label",
    "categoria_nivel",
    "precio_hnl",
    "activo",
    "visible_publico",
    "orden_visual",
    "beneficios",
  ],
  additionalProperties: false,
};

const ACTIVE_BRANCHES_SQL = `
  SELECT s.id_sucursal
  FROM public.sucursales s
  WHERE s.deleted_at IS NULL
    AND s.estado IS TRUE
  ORDER BY s.nombre_sucursal ASC
`;

const PLAN_CATEGORY_COLUMN_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'membership_plans'
      AND column_name = 'categoria_nivel'
  ) AS exists
`;

const SUBSCRIPTIONS_BRANCH_COLUMN_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'subscriptions'
      AND column_name = 'id_sucursal_contratada'
  ) AS exists
`;

const LIST_PLANS_SQL = `
  WITH scoped_offers AS (
    SELECT
      mps.id_plan,
      mps.id_sucursal,
      mps.precio_hnl,
      mps.activo,
      mps.visible_publico,
      mps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY mps.id_plan, mps.id_sucursal
        ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
      ) AS rn
    FROM public.membership_plans_sucursal mps
    WHERE ($1::uuid IS NULL OR mps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_plan,
      so.id_sucursal,
      so.precio_hnl,
      so.activo,
      so.visible_publico,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  )
  SELECT
    mp.id_plan,
    po.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    mp.categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(po.precio_hnl, mp.precio_hnl) AS precio_hnl,
    (COALESCE(po.activo, FALSE) AND mp.activo IS TRUE) AS activo,
    COALESCE(po.visible_publico, FALSE) AS visible_publico,
    COALESCE(po.orden_visual, 100) AS orden_visual,
    mp.beneficios
  FROM public.membership_plans mp
  JOIN picked_offers po
    ON po.id_plan = mp.id_plan
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  ORDER BY po.orden_visual ASC, mp.nombre_plan ASC, po.id_sucursal ASC
`;

const LIST_PLANS_SQL_LEGACY = `
  WITH scoped_offers AS (
    SELECT
      mps.id_plan,
      mps.id_sucursal,
      mps.precio_hnl,
      mps.activo,
      mps.visible_publico,
      mps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY mps.id_plan, mps.id_sucursal
        ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
      ) AS rn
    FROM public.membership_plans_sucursal mps
    WHERE ($1::uuid IS NULL OR mps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_plan,
      so.id_sucursal,
      so.precio_hnl,
      so.activo,
      so.visible_publico,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  )
  SELECT
    mp.id_plan,
    po.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    1::smallint AS categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(po.precio_hnl, mp.precio_hnl) AS precio_hnl,
    (COALESCE(po.activo, FALSE) AND mp.activo IS TRUE) AS activo,
    COALESCE(po.visible_publico, FALSE) AS visible_publico,
    COALESCE(po.orden_visual, 100) AS orden_visual,
    mp.beneficios
  FROM public.membership_plans mp
  JOIN picked_offers po
    ON po.id_plan = mp.id_plan
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  ORDER BY po.orden_visual ASC, mp.nombre_plan ASC, po.id_sucursal ASC
`;

const GET_PLAN_BASE_SQL = `
  SELECT
    mp.id_plan,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    mp.categoria_nivel,
    mp.precio_hnl,
    mp.beneficios,
    mp.activo
  FROM public.membership_plans mp
  WHERE mp.id_plan = $1::uuid
  LIMIT 1
`;

const GET_PLAN_BASE_SQL_LEGACY = `
  SELECT
    mp.id_plan,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    1::smallint AS categoria_nivel,
    mp.precio_hnl,
    mp.beneficios,
    mp.activo
  FROM public.membership_plans mp
  WHERE mp.id_plan = $1::uuid
  LIMIT 1
`;

const GET_PLAN_SCOPED_SQL = `
  SELECT
    mp.id_plan,
    mps.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    mp.categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(mps.precio_hnl, mp.precio_hnl) AS precio_hnl,
    (COALESCE(mps.activo, FALSE) AND mp.activo IS TRUE) AS activo,
    COALESCE(mps.visible_publico, FALSE) AS visible_publico,
    COALESCE(mps.orden_visual, 100) AS orden_visual,
    mp.beneficios
  FROM public.membership_plans mp
  JOIN public.membership_plans_sucursal mps
    ON mps.id_plan = mp.id_plan
   AND mps.id_sucursal = $2::uuid
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  WHERE mp.id_plan = $1::uuid
  LIMIT 1
`;

const GET_PLAN_SCOPED_SQL_LEGACY = `
  SELECT
    mp.id_plan,
    mps.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    1::smallint AS categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(mps.precio_hnl, mp.precio_hnl) AS precio_hnl,
    (COALESCE(mps.activo, FALSE) AND mp.activo IS TRUE) AS activo,
    COALESCE(mps.visible_publico, FALSE) AS visible_publico,
    COALESCE(mps.orden_visual, 100) AS orden_visual,
    mp.beneficios
  FROM public.membership_plans mp
  JOIN public.membership_plans_sucursal mps
    ON mps.id_plan = mp.id_plan
   AND mps.id_sucursal = $2::uuid
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  WHERE mp.id_plan = $1::uuid
  LIMIT 1
`;

const GET_PLAN_OFFER_SQL = `
  SELECT
    mps.id_plan_sucursal,
    mps.id_plan,
    mps.id_sucursal,
    mps.precio_hnl,
    mps.activo,
    mps.visible_publico,
    mps.orden_visual
  FROM public.membership_plans_sucursal mps
  WHERE mps.id_plan = $1::uuid
    AND mps.id_sucursal = $2::uuid
  LIMIT 1
  FOR UPDATE
`;

const GET_ACTIVE_SERVICES_IN_BRANCH_SQL = `
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    EXISTS (
      SELECT 1
      FROM public.servicios_tarifas st
      WHERE st.id_servicio = s.id_servicio
        AND st.id_sucursal = $2::uuid
        AND st.id_empleado IS NULL
        AND st.deleted_at IS NULL
        AND st.activo IS TRUE
        -- AM: En planes operativos solo se permiten servicios agendables (no informativos).
        AND COALESCE(st.servicio_informativo, FALSE) IS FALSE
        AND st.vigente_desde <= CURRENT_DATE
        AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
    ) AS has_scope_tariff
  FROM public.servicios s
  WHERE s.id_servicio = ANY($1::uuid[])
    AND s.deleted_at IS NULL
    AND s.activo IS TRUE
`;

const GET_COURTESIES_IN_BRANCH_SQL = `
  SELECT
    c.id AS id_cortesia,
    c.nombre,
    cs.activa
  FROM public.cortesias c
  JOIN public.cortesias_sucursales cs
    ON cs.cortesia_id = c.id
   AND cs.id_sucursal = $2::uuid
  WHERE c.id = ANY($1::uuid[])
`;

function normalizeRequiredText(value) {
  return String(value || "").normalize("NFC").trim();
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value ?? "").normalize("NFC").trim();
  return trimmed ? trimmed : null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function normalizeOrderVisual(value, fallback = 100) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizePeriodCode(value, fallback = "mensual") {
  const normalized = String(value || fallback).trim().toLowerCase();
  // AM: En esta fase comercial del negocio los planes son mensuales para evitar reglas mixtas prematuras.
  if (normalized !== "mensual") {
    throw new AppError(400, "En esta fase solo se permite periodo mensual para planes", {
      code: "CATALOG_PLAN_PERIOD_NOT_SUPPORTED",
    });
  }
  return normalized;
}

function normalizePlanCategory(value, fallback = DEFAULT_PLAN_CATEGORY) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < PLAN_CATEGORY_MIN || parsed > PLAN_CATEGORY_MAX) {
    throw new AppError(400, `La categoria del plan debe estar entre ${PLAN_CATEGORY_MIN} y ${PLAN_CATEGORY_MAX}`, {
      code: "CATALOG_PLAN_CATEGORY_INVALID",
    });
  }
  return parsed;
}

function parsePlanCategoryFromRow(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < PLAN_CATEGORY_MIN || parsed > PLAN_CATEGORY_MAX) return DEFAULT_PLAN_CATEGORY;
  return parsed;
}

function normalizePlanBenefits(beneficios) {
  if (!Array.isArray(beneficios) || beneficios.length === 0) {
    throw new AppError(400, "Debes registrar al menos un beneficio para el plan", {
      code: "CATALOG_PLAN_BENEFITS_REQUIRED",
    });
  }

  const seenServiceIds = new Set();
  const seenCourtesyIds = new Set();
  const normalizedBenefits = beneficios.map((beneficio) => {
    const tipo = String(beneficio?.tipo || "").trim().toLowerCase();
    const cantidad = Number(beneficio?.cantidad);
    const nombre = normalizeOptionalText(beneficio?.nombre) ?? "";

    if (!PLAN_BENEFIT_TYPES.includes(tipo)) {
      throw new AppError(400, "Cada beneficio debe indicar un tipo valido (servicio o cortesia)", {
        code: "CATALOG_PLAN_BENEFIT_INVALID",
      });
    }

    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > PLAN_BENEFIT_MAX_CANTIDAD) {
      throw new AppError(400, `La cantidad de cada beneficio debe ser un entero entre 1 y ${PLAN_BENEFIT_MAX_CANTIDAD}`, {
        code: "CATALOG_PLAN_BENEFIT_INVALID",
      });
    }

    if (tipo === "servicio") {
      const idServicio = String(beneficio?.id_servicio || "").trim();
      if (!idServicio) {
        throw new AppError(400, "Los beneficios tipo servicio requieren id_servicio", {
          code: "CATALOG_PLAN_BENEFIT_INVALID",
        });
      }
      if (seenServiceIds.has(idServicio)) {
        throw new AppError(400, "No se permite repetir el mismo servicio en beneficios del plan", {
          code: "CATALOG_PLAN_BENEFIT_DUPLICATE",
        });
      }

      seenServiceIds.add(idServicio);
      return {
        tipo: "servicio",
        id_servicio: idServicio,
        id_cortesia: null,
        codigo: null,
        nombre,
        cantidad,
      };
    }

    const idCortesia = String(beneficio?.id_cortesia || "").trim();
    if (!idCortesia) {
      throw new AppError(400, "Los beneficios tipo cortesia requieren id_cortesia", {
        code: "CATALOG_PLAN_BENEFIT_INVALID",
      });
    }
    if (seenCourtesyIds.has(idCortesia)) {
      throw new AppError(400, "No se permite repetir la misma cortesia dentro del plan", {
        code: "CATALOG_PLAN_BENEFIT_DUPLICATE",
      });
    }
    seenCourtesyIds.add(idCortesia);
    return {
      tipo: "cortesia",
      id_servicio: null,
      id_cortesia: idCortesia,
      codigo: null,
      nombre,
      cantidad,
    };
  });

  if (!normalizedBenefits.some((benefit) => benefit.tipo === "servicio")) {
    throw new AppError(400, "El plan debe incluir al menos un servicio", {
      code: "CATALOG_PLAN_SERVICE_REQUIRED",
    });
  }

  return normalizedBenefits;
}

function parseStoredBenefits(rawBenefits) {
  if (!rawBenefits) return [];

  const data = rawBenefits && typeof rawBenefits === "object" ? rawBenefits : {};
  const looksLikeSingleBenefit =
    data &&
    !Array.isArray(data) &&
    (data.tipo !== undefined ||
      data.id_servicio !== undefined ||
      data.id_cortesia !== undefined ||
      data.nombre !== undefined ||
      data.codigo !== undefined ||
      data.cantidad !== undefined);
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(rawBenefits)
      ? rawBenefits
      : looksLikeSingleBenefit
        ? [data]
        : [];

  return items
    .map((beneficio) => {
      const normalizedServiceId = String(beneficio?.id_servicio || "").trim();
      const normalizedCourtesyId = String(beneficio?.id_cortesia || "").trim();
      const normalizedNombre = String(beneficio?.nombre || "").trim();
      const normalizedCodigo = beneficio?.codigo ? String(beneficio.codigo).trim() : "";
      const rawType = String(beneficio?.tipo || "").trim().toLowerCase();
      // AM: Compatibilidad legacy estricta:
      // 1) id_servicio fuerza tipo servicio aun sin tipo explicito.
      // 2) id_cortesia fuerza tipo cortesia.
      // 3) solo para lectura se permite cortesia legacy sin id_cortesia cuando tipo=cortesia y existe nombre/codigo.
      const isService = rawType === "servicio" || (rawType !== "cortesia" && normalizedServiceId);
      const isCourtesy = rawType === "cortesia" || (!rawType && !normalizedServiceId && normalizedCourtesyId);
      const allowsLegacyCourtesyRead = rawType === "cortesia" && !normalizedCourtesyId && Boolean(normalizedNombre || normalizedCodigo);
      if (!isService && !isCourtesy && !allowsLegacyCourtesyRead) {
        return null;
      }

      const tipo = isService ? "servicio" : "cortesia";
      return {
        tipo,
        id_servicio: normalizedServiceId || null,
        id_cortesia: normalizedCourtesyId || null,
        codigo: normalizedCodigo || null,
        nombre: normalizedNombre,
        cantidad: Number(beneficio?.cantidad ?? 0),
      };
    })
    .filter(Boolean)
    .filter((beneficio) => Number.isInteger(beneficio.cantidad) && beneficio.cantidad > 0)
    .filter((beneficio) => (
      beneficio.tipo === "servicio"
        ? Boolean(beneficio.id_servicio)
        : Boolean(beneficio.id_cortesia || beneficio.nombre || beneficio.codigo)
    ))
    .map((beneficio) => ({
      ...beneficio,
      nombre:
        beneficio.nombre ||
        (beneficio.tipo === "servicio"
          ? "Servicio del catalogo"
          : (beneficio.codigo || "Cortesia incluida")),
    }));
}

function serializePlanBenefits(beneficios = []) {
  return {
    version: 1,
    items: beneficios,
  };
}

function mapPlanRow(row) {
  return {
    id_plan: row.id_plan,
    id_sucursal: row.id_sucursal ?? null,
    nombre_plan: row.nombre_plan,
    descripcion: row.descripcion ?? null,
    periodo_membresia_codigo: row.periodo_membresia_codigo,
    periodo_membresia_label: row.periodo_membresia_label || row.periodo_membresia_codigo,
    categoria_nivel: parsePlanCategoryFromRow(row.categoria_nivel),
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    activo: Boolean(row.activo),
    visible_publico: Boolean(row.visible_publico),
    orden_visual: Number(row.orden_visual ?? 100),
    beneficios: parseStoredBenefits(row.beneficios),
  };
}

async function resolveBranchId(client, claims, requestedBranchId, allowAllForSuperAdmin = false) {
  const claimBranchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.filter(Boolean) : [];
  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");

  if (requestedBranchId) {
    if (!isSuperAdmin && !claimBranchIds.includes(requestedBranchId)) {
      throw new AppError(403, "La sucursal solicitada no pertenece al alcance del usuario autenticado", {
        code: "AUTH_FORBIDDEN_BRANCH",
      });
    }

    const { rowCount } = await client.query(
      "SELECT 1 FROM public.sucursales WHERE id_sucursal = $1::uuid AND deleted_at IS NULL AND estado IS TRUE",
      [requestedBranchId]
    );

    if (!rowCount) {
      throw new AppError(404, "La sucursal indicada no existe o no esta activa", {
        code: "CATALOG_BRANCH_NOT_FOUND",
      });
    }

    return requestedBranchId;
  }

  if (!isSuperAdmin) {
    if (claimBranchIds.length === 1) {
      const onlyBranchId = claimBranchIds[0];
      const { rowCount } = await client.query(
        "SELECT 1 FROM public.sucursales WHERE id_sucursal = $1::uuid AND deleted_at IS NULL AND estado IS TRUE",
        [onlyBranchId]
      );
      if (!rowCount) {
        throw new AppError(404, "La sucursal indicada no existe o no esta activa", {
          code: "CATALOG_BRANCH_NOT_FOUND",
        });
      }
      return onlyBranchId;
    }
    if (claimBranchIds.length === 0) {
      throw new AppError(400, "El usuario autenticado no tiene una sucursal asociada para gestionar planes", {
        code: "CATALOG_BRANCH_REQUIRED",
      });
    }
    throw new AppError(400, "Debes indicar id_sucursal cuando tu acceso cubre multiples sucursales", {
      code: "CATALOG_BRANCH_REQUIRED",
    });
  }

  if (allowAllForSuperAdmin) return null;

  const { rows } = await client.query(ACTIVE_BRANCHES_SQL);
  if (rows.length === 1) return rows[0].id_sucursal;

  throw new AppError(400, "Debes indicar id_sucursal para operar planes cuando existen multiples sucursales activas", {
    code: "CATALOG_BRANCH_REQUIRED",
  });
}

async function ensurePeriodExists(client, periodCode) {
  const { rowCount } = await client.query(
    "SELECT 1 FROM public.periodos_membresia WHERE periodo_membresia_codigo = $1 LIMIT 1",
    [periodCode]
  );

  if (!rowCount) {
    throw new AppError(400, "El periodo de membresia indicado no existe", {
      code: "CATALOG_PLAN_PERIOD_INVALID",
    });
  }
}

async function hasPlanCategoryColumn(client) {
  const { rows } = await client.query(PLAN_CATEGORY_COLUMN_EXISTS_SQL);
  return Boolean(rows[0]?.exists);
}

async function hasSubscriptionsBranchColumn(client) {
  const { rows } = await client.query(SUBSCRIPTIONS_BRANCH_COLUMN_EXISTS_SQL);
  return Boolean(rows[0]?.exists);
}

async function countActiveSubscriptionsForPlan(client, idPlan, idSucursal) {
  const supportsBranchScope = await hasSubscriptionsBranchColumn(client);
  const sql = supportsBranchScope
    ? `
      SELECT COUNT(*)::int AS total
      FROM public.subscriptions s
      WHERE s.id_plan = $1::uuid
        AND s.estado_suscripcion_codigo IN ('activa', 'pendiente_renovacion')
        AND s.id_sucursal_contratada = $2::uuid
    `
    : `
      SELECT COUNT(*)::int AS total
      FROM public.subscriptions s
      WHERE s.id_plan = $1::uuid
        AND s.estado_suscripcion_codigo IN ('activa', 'pendiente_renovacion')
    `;

  const params = supportsBranchScope ? [idPlan, idSucursal] : [idPlan];
  const { rows } = await client.query(sql, params);
  return Number(rows[0]?.total || 0);
}

async function ensureUniquePlanNameByBranch(client, planId, branchId, nombrePlan) {
  const { rows } = await client.query(
    `
      SELECT mp.id_plan
      FROM public.membership_plans mp
      JOIN public.membership_plans_sucursal mps
        ON mps.id_plan = mp.id_plan
      WHERE LOWER(TRIM(mp.nombre_plan)) = LOWER(TRIM($1))
        AND mps.id_sucursal = $2::uuid
        AND ($3::uuid IS NULL OR mp.id_plan <> $3::uuid)
      LIMIT 1
    `,
    [nombrePlan, branchId, planId ?? null]
  );

  if (rows[0]) {
    throw new AppError(409, "Ya existe un plan con ese nombre en la sucursal", {
      code: "CATALOG_PLAN_DUPLICATE",
    });
  }
}

async function ensurePlanServiceBenefitsAccessible(client, benefits, branchId) {
  const serviceBenefitIds = [...new Set(
    benefits
      .filter((benefit) => benefit.tipo === "servicio" && benefit.id_servicio)
      .map((benefit) => benefit.id_servicio)
  )];

  if (!serviceBenefitIds.length) {
    return benefits;
  }

  const { rows } = await client.query(GET_ACTIVE_SERVICES_IN_BRANCH_SQL, [serviceBenefitIds, branchId]);
  if (rows.length !== serviceBenefitIds.length) {
    throw new AppError(400, "Uno o más servicios de beneficios no existen o no están activos", {
      code: "CATALOG_PLAN_SERVICE_NOT_FOUND",
    });
  }

  if (rows.some((row) => !row.has_scope_tariff)) {
    // AM: Bloquea servicios fuera de sucursal, inactivos o informativos aunque el frontend falle.
    throw new AppError(409, "Uno o más servicios no son operativos para la sucursal seleccionada", {
      code: "CATALOG_PLAN_SERVICE_OUT_OF_SCOPE",
    });
  }

  const serviceNameById = new Map(rows.map((row) => [row.id_servicio, row.nombre_servicio]));
  return benefits.map((benefit) => {
    if (benefit.tipo !== "servicio") return benefit;
    return {
      ...benefit,
      // AM: Se guarda nombre de servicio snapshot para lectura publica aun si cambia el nombre en el catalogo despues.
      nombre: serviceNameById.get(benefit.id_servicio) || benefit.nombre || "Servicio del catalogo",
    };
  });
}

async function ensurePlanCourtesyBenefitsAccessible(client, benefits, branchId, existingBenefits = []) {
  const courtesyBenefitIds = [...new Set(
    benefits
      .filter((benefit) => benefit.tipo === "cortesia" && benefit.id_cortesia)
      .map((benefit) => benefit.id_cortesia)
  )];

  if (!courtesyBenefitIds.length) {
    return benefits;
  }

  const { rows } = await client.query(GET_COURTESIES_IN_BRANCH_SQL, [courtesyBenefitIds, branchId]);
  if (rows.length !== courtesyBenefitIds.length) {
    throw new AppError(400, "Una o mas cortesias de beneficios no existen en la sucursal seleccionada", {
      code: "CATALOG_PLAN_COURTESY_NOT_FOUND",
    });
  }

  const existingCourtesyIds = new Set(
    (Array.isArray(existingBenefits) ? existingBenefits : [])
      .filter((benefit) => benefit?.tipo === "cortesia" && benefit?.id_cortesia)
      .map((benefit) => benefit.id_cortesia)
  );
  const courtesyById = new Map(rows.map((row) => [row.id_cortesia, row]));

  return benefits.map((benefit) => {
    if (benefit.tipo !== "cortesia") return benefit;

    const currentCourtesy = courtesyById.get(benefit.id_cortesia);
    if (!currentCourtesy) return benefit;

    if (!currentCourtesy.activa && !existingCourtesyIds.has(benefit.id_cortesia)) {
      throw new AppError(409, "No puedes agregar cortesias inactivas al plan", {
        code: "CATALOG_PLAN_COURTESY_INACTIVE",
      });
    }

    return {
      ...benefit,
      // AM: Se guarda nombre snapshot para lectura admin/public aunque el catalogo cambie despues.
      nombre: String(currentCourtesy.nombre || "").trim() || benefit.nombre || "Cortesia del catalogo",
    };
  });
}

async function ensurePlanBenefitsAccessible(client, benefits, branchId, existingBenefits = []) {
  const withServices = await ensurePlanServiceBenefitsAccessible(client, benefits, branchId);
  return ensurePlanCourtesyBenefitsAccessible(client, withServices, branchId, existingBenefits);
}

async function upsertPlanBranchOffer(client, idPlan, idSucursal, payload = {}) {
  const currentResult = await client.query(GET_PLAN_OFFER_SQL, [idPlan, idSucursal]);
  const current = currentResult.rows[0] ?? null;

  const hasPrice = payload?.precioHnl !== undefined && payload?.precioHnl !== null;
  const hasActive = payload?.activo !== undefined && payload?.activo !== null;
  const hasVisible = payload?.visiblePublico !== undefined && payload?.visiblePublico !== null;
  const hasOrder = payload?.ordenVisual !== undefined && payload?.ordenVisual !== null;

  const precioHnl = hasPrice
    ? Number(payload.precioHnl)
    : current?.precio_hnl == null
      ? null
      : Number(current.precio_hnl);
  const activo = hasActive ? Boolean(payload.activo) : Boolean(current?.activo ?? true);
  const visiblePublico = hasVisible ? Boolean(payload.visiblePublico) : Boolean(current?.visible_publico ?? true);
  const ordenVisual = hasOrder
    ? normalizeOrderVisual(payload.ordenVisual, 100)
    : normalizeOrderVisual(current?.orden_visual, 100);

  await client.query(
    `
      INSERT INTO public.membership_plans_sucursal (
        id_plan,
        id_sucursal,
        precio_hnl,
        activo,
        visible_publico,
        orden_visual
      )
      VALUES ($1::uuid, $2::uuid, $3::numeric, $4::boolean, $5::boolean, $6::int)
      ON CONFLICT (id_plan, id_sucursal)
      DO UPDATE SET
        precio_hnl = EXCLUDED.precio_hnl,
        activo = EXCLUDED.activo,
        visible_publico = EXCLUDED.visible_publico,
        orden_visual = EXCLUDED.orden_visual,
        updated_at = NOW()
    `,
    [idPlan, idSucursal, precioHnl, activo, visiblePublico, ordenVisual]
  );
}

async function hasPlanOffersInOtherBranches(client, idPlan, branchId) {
  const { rows } = await client.query(
    `
      SELECT 1
      FROM public.membership_plans_sucursal mps
      WHERE mps.id_plan = $1::uuid
        AND mps.id_sucursal <> $2::uuid
      LIMIT 1
    `,
    [idPlan, branchId]
  );
  return rows.length > 0;
}

async function clonePlanForBranch(client, sourcePlan, branchId, supportsPlanCategoryColumn) {
  const sourcePrice =
    sourcePlan?.precio_hnl === undefined || sourcePlan?.precio_hnl === null
      ? 0
      : Number(sourcePlan.precio_hnl);

  const cloneResult = supportsPlanCategoryColumn
    ? await client.query(
      `
        INSERT INTO public.membership_plans (
          nombre_plan,
          descripcion,
          precio_hnl,
          periodo_membresia_codigo,
          categoria_nivel,
          beneficios,
          activo,
          updated_at
        )
        VALUES ($1, $2, $3::numeric, $4, $5::smallint, $6::jsonb, TRUE, NOW())
        RETURNING id_plan
      `,
      [
        sourcePlan.nombre_plan,
        sourcePlan.descripcion ?? null,
        sourcePrice,
        sourcePlan.periodo_membresia_codigo,
        normalizePlanCategory(sourcePlan.categoria_nivel, DEFAULT_PLAN_CATEGORY),
        sourcePlan.beneficios,
      ]
    )
    : await client.query(
      `
        INSERT INTO public.membership_plans (
          nombre_plan,
          descripcion,
          precio_hnl,
          periodo_membresia_codigo,
          beneficios,
          activo,
          updated_at
        )
        VALUES ($1, $2, $3::numeric, $4, $5::jsonb, TRUE, NOW())
        RETURNING id_plan
      `,
      [
        sourcePlan.nombre_plan,
        sourcePlan.descripcion ?? null,
        sourcePrice,
        sourcePlan.periodo_membresia_codigo,
        sourcePlan.beneficios,
      ]
    );
  const clonedPlanId = cloneResult.rows[0].id_plan;

  // AM: Reasigna la oferta de la sucursal al clon para aislar metadata y beneficios.
  const reassignedOffer = await client.query(
    `
      UPDATE public.membership_plans_sucursal
      SET
        id_plan = $1::uuid,
        updated_at = NOW()
      WHERE id_plan = $2::uuid
        AND id_sucursal = $3::uuid
    `,
    [clonedPlanId, sourcePlan.id_plan, branchId]
  );

  if (!reassignedOffer.rowCount) {
    await upsertPlanBranchOffer(client, clonedPlanId, branchId, {});
  }

  return clonedPlanId;
}

function sendHandledError(reply, request, error, fallbackMessage, fallbackCode) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  if (error?.code === "42P01" && String(error?.message || "").includes("membership_plans_sucursal")) {
    return sendError(reply, 500, "Falta aplicar migracion de PLANES multi-sucursal en la base de datos", {
      code: "CATALOG_PLAN_MIGRATION_REQUIRED",
      details: error.message,
      requestId: request.id,
    });
  }

  if (error?.code === "42703" && String(error?.message || "").includes("categoria_nivel")) {
    return sendError(reply, 500, "Falta aplicar migracion de categoria de planes en la base de datos", {
      code: "CATALOG_PLAN_CATEGORY_MIGRATION_REQUIRED",
      details: error.message,
      requestId: request.id,
    });
  }

  if (error?.code === "23505") {
    const constraint = String(error?.constraint || "").trim();
    if (constraint === "uq_membership_plans_nombre_ci") {
      return sendError(reply, 409, "Ya existe un plan con ese nombre", {
        code: "CATALOG_PLAN_DUPLICATE",
        details: error.detail || error.message,
        requestId: request.id,
      });
    }
    if (constraint === "uq_mps_scope") {
      return sendError(reply, 409, "Ya existe una oferta para ese plan en la sucursal seleccionada", {
        code: "CATALOG_PLAN_SCOPE_DUPLICATE",
        details: error.detail || error.message,
        requestId: request.id,
      });
    }
    return sendError(reply, 409, "Conflicto de unicidad al guardar el plan", {
      code: "CATALOG_PLAN_CONFLICT",
      details: error.detail || error.message,
      requestId: request.id,
    });
  }

  if (error?.code === "23514") {
    const constraint = String(error?.constraint || "").trim();
    if (constraint.includes("precio") || String(error?.message || "").toLowerCase().includes("precio")) {
      return sendError(reply, 409, "El precio del plan no es valido para guardar la oferta.", {
        code: "CATALOG_PLAN_INVALID_PRICE",
        requestId: request.id,
      });
    }
    if (constraint.includes("categoria") || String(error?.message || "").toLowerCase().includes("categoria")) {
      return sendError(reply, 409, "La categoria del plan no cumple las reglas definidas.", {
        code: "CATALOG_PLAN_INVALID_CATEGORY",
        requestId: request.id,
      });
    }
    return sendError(reply, 409, "La informacion del plan no cumple las reglas de integridad.", {
      code: "CATALOG_PLAN_INVALID_DATA",
      requestId: request.id,
    });
  }

  if (error?.code === "P0001") {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("precio")) {
      return sendError(reply, 409, "El precio del plan no es valido para activar u ofrecer.", {
        code: "CATALOG_PLAN_INVALID_PRICE",
        requestId: request.id,
      });
    }
    if (message.includes("servicio") || message.includes("beneficio")) {
      return sendError(reply, 409, "La composicion del plan no es valida para operar.", {
        code: "CATALOG_PLAN_INVALID_COMPOSITION",
        requestId: request.id,
      });
    }
    return sendError(reply, 409, "No se pudo completar la operacion del plan por una regla de negocio.", {
      code: "CATALOG_PLAN_BUSINESS_RULE",
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, fallbackMessage);
  return sendError(reply, 500, fallbackMessage, {
    code: fallbackCode,
    details: error instanceof Error ? error.message : fallbackMessage,
    requestId: request.id,
  });
}

export default async function adminPlansRoutes(app) {
  app.get(
    "/",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: queryBranchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_sucursal: { type: ["string", "null"], format: "uuid" },
                  planes: { type: "array", items: planResponseSchema },
                },
                required: ["id_sucursal", "planes"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const supportsPlanCategoryColumn = await hasPlanCategoryColumn(client);
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null, true);
        const listSql = supportsPlanCategoryColumn ? LIST_PLANS_SQL : LIST_PLANS_SQL_LEGACY;
        const { rows } = await client.query(listSql, [branchId]);

        return sendOk(reply, {
          id_sucursal: branchId,
          planes: rows.map(mapPlanRow),
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo consultar el catalogo administrativo de planes",
          "ADMIN_CATALOG_PLANS_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        body: planBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: planResponseSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const supportsPlanCategoryColumn = await hasPlanCategoryColumn(client);
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        const nombrePlan = normalizeRequiredText(request.body.nombre_plan);
        const descripcion = normalizeOptionalText(request.body.descripcion);
        const precioHnl = Number(request.body.precio_hnl);
        const periodCode = normalizePeriodCode(request.body.periodo_membresia_codigo, "mensual");
        const categoriaNivel = normalizePlanCategory(request.body.categoria_nivel, DEFAULT_PLAN_CATEGORY);
        const visiblePublico = normalizeBoolean(request.body.visible_publico, true);
        const ordenVisual = normalizeOrderVisual(request.body.orden_visual, 100);
        const normalizedBenefits = normalizePlanBenefits(request.body.beneficios);

        if (!Number.isFinite(precioHnl) || precioHnl <= 0) {
          throw new AppError(400, "El precio del plan debe ser mayor a 0", {
            code: "CATALOG_PLAN_PRICE_INVALID",
          });
        }

        await ensurePeriodExists(client, periodCode);
        await ensureUniquePlanNameByBranch(client, null, branchId, nombrePlan);

        await client.query("BEGIN");

        const canonicalBenefits = await ensurePlanBenefitsAccessible(client, normalizedBenefits, branchId, []);
        const insertResult = supportsPlanCategoryColumn
          ? await client.query(
            `
              INSERT INTO public.membership_plans (
                nombre_plan,
                descripcion,
                precio_hnl,
                periodo_membresia_codigo,
                categoria_nivel,
                beneficios,
                activo,
                updated_at
              )
              VALUES ($1, $2, $3::numeric, $4, $5::smallint, $6::jsonb, TRUE, NOW())
              RETURNING id_plan
            `,
            [nombrePlan, descripcion ?? null, precioHnl, periodCode, categoriaNivel, serializePlanBenefits(canonicalBenefits)]
          )
          : await client.query(
            `
              INSERT INTO public.membership_plans (
                nombre_plan,
                descripcion,
                precio_hnl,
                periodo_membresia_codigo,
                beneficios,
                activo,
                updated_at
              )
              VALUES ($1, $2, $3::numeric, $4, $5::jsonb, TRUE, NOW())
              RETURNING id_plan
            `,
            [nombrePlan, descripcion ?? null, precioHnl, periodCode, serializePlanBenefits(canonicalBenefits)]
          );

        const idPlan = insertResult.rows[0].id_plan;
        await upsertPlanBranchOffer(client, idPlan, branchId, {
          precioHnl,
          activo: true,
          visiblePublico,
          ordenVisual,
        });

        const finalResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_SCOPED_SQL : GET_PLAN_SCOPED_SQL_LEGACY,
          [idPlan, branchId]
        );
        await client.query("COMMIT");

        return sendOk(reply, mapPlanRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo crear el plan de membresia",
          "ADMIN_CATALOG_PLAN_CREATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        body: planPatchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: planResponseSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const supportsPlanCategoryColumn = await hasPlanCategoryColumn(client);
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        await client.query("BEGIN");

        const baseResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_BASE_SQL : GET_PLAN_BASE_SQL_LEGACY,
          [request.params.id]
        );
        const basePlan = baseResult.rows[0];
        if (!basePlan) {
          throw new AppError(404, "El plan solicitado no existe", {
            code: "CATALOG_PLAN_NOT_FOUND",
          });
        }

        const scopedResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_SCOPED_SQL : GET_PLAN_SCOPED_SQL_LEGACY,
          [request.params.id, branchId]
        );
        const scopedPlan = scopedResult.rows[0] ?? null;

        const shouldMutatePlanBase =
          request.body.nombre_plan !== undefined ||
          request.body.descripcion !== undefined ||
          request.body.periodo_membresia_codigo !== undefined ||
          (supportsPlanCategoryColumn && request.body.categoria_nivel !== undefined) ||
          request.body.beneficios !== undefined;
        let targetPlanId = request.params.id;

        if (shouldMutatePlanBase) {
          const planSharedAcrossBranches = await hasPlanOffersInOtherBranches(client, request.params.id, branchId);
          if (planSharedAcrossBranches) {
            targetPlanId = await clonePlanForBranch(client, basePlan, branchId, supportsPlanCategoryColumn);
          }
        }

        const targetBaseResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_BASE_SQL : GET_PLAN_BASE_SQL_LEGACY,
          [targetPlanId]
        );
        const targetBasePlan = targetBaseResult.rows[0];
        if (!targetBasePlan) {
          throw new AppError(404, "El plan solicitado no existe", {
            code: "CATALOG_PLAN_NOT_FOUND",
          });
        }

        const nombrePlan =
          request.body.nombre_plan !== undefined
            ? normalizeRequiredText(request.body.nombre_plan)
            : targetBasePlan.nombre_plan;
        const descripcion =
          request.body.descripcion !== undefined
            ? normalizeOptionalText(request.body.descripcion)
            : targetBasePlan.descripcion;
        const precioHnl =
          request.body.precio_hnl !== undefined
            ? Number(request.body.precio_hnl)
            : scopedPlan?.precio_hnl == null
              ? Number(targetBasePlan.precio_hnl)
              : Number(scopedPlan.precio_hnl);
        const periodCode =
          request.body.periodo_membresia_codigo !== undefined
            ? normalizePeriodCode(request.body.periodo_membresia_codigo)
            : normalizePeriodCode(targetBasePlan.periodo_membresia_codigo);
        const categoriaNivel = supportsPlanCategoryColumn
          ? (
            request.body.categoria_nivel !== undefined
              ? normalizePlanCategory(request.body.categoria_nivel, DEFAULT_PLAN_CATEGORY)
              : normalizePlanCategory(targetBasePlan.categoria_nivel, DEFAULT_PLAN_CATEGORY)
          )
          : DEFAULT_PLAN_CATEGORY;
        const visiblePublico =
          request.body.visible_publico !== undefined
            ? normalizeBoolean(request.body.visible_publico, true)
            : normalizeBoolean(scopedPlan?.visible_publico, true);
        const ordenVisual =
          request.body.orden_visual !== undefined
            ? normalizeOrderVisual(request.body.orden_visual, 100)
            : normalizeOrderVisual(scopedPlan?.orden_visual, 100);
        const nextActive = normalizeBoolean(scopedPlan?.activo, true);
        const shouldUpdateBenefits = request.body.beneficios !== undefined;
        const sourceBenefits = shouldUpdateBenefits
          ? normalizePlanBenefits(request.body.beneficios)
          : null;

        if (!Number.isFinite(precioHnl) || precioHnl <= 0) {
          throw new AppError(400, "El precio del plan debe ser mayor a 0", {
            code: "CATALOG_PLAN_PRICE_INVALID",
          });
        }

        await ensurePeriodExists(client, periodCode);
        await ensureUniquePlanNameByBranch(client, targetPlanId, branchId, nombrePlan);
        const canonicalBenefits = shouldUpdateBenefits
          ? await ensurePlanBenefitsAccessible(client, sourceBenefits, branchId, [])
          : null;

        if (shouldMutatePlanBase) {
          if (supportsPlanCategoryColumn) {
            if (shouldUpdateBenefits) {
              await client.query(
                `
                  UPDATE public.membership_plans
                  SET
                    nombre_plan = $2,
                    descripcion = $3,
                    periodo_membresia_codigo = $4,
                    categoria_nivel = $5::smallint,
                    beneficios = $6::jsonb,
                    activo = TRUE,
                    updated_at = NOW()
                  WHERE id_plan = $1::uuid
                `,
                [
                  targetPlanId,
                  nombrePlan,
                  descripcion ?? null,
                  periodCode,
                  categoriaNivel,
                  serializePlanBenefits(canonicalBenefits),
                ]
              );
            } else {
              await client.query(
                `
                  UPDATE public.membership_plans
                  SET
                    nombre_plan = $2,
                    descripcion = $3,
                    periodo_membresia_codigo = $4,
                    categoria_nivel = $5::smallint,
                    activo = TRUE,
                    updated_at = NOW()
                  WHERE id_plan = $1::uuid
                `,
                [
                  targetPlanId,
                  nombrePlan,
                  descripcion ?? null,
                  periodCode,
                  categoriaNivel,
                ]
              );
            }
          } else {
            if (shouldUpdateBenefits) {
              await client.query(
                `
                  UPDATE public.membership_plans
                  SET
                    nombre_plan = $2,
                    descripcion = $3,
                    periodo_membresia_codigo = $4,
                    beneficios = $5::jsonb,
                    activo = TRUE,
                    updated_at = NOW()
                  WHERE id_plan = $1::uuid
                `,
                [
                  targetPlanId,
                  nombrePlan,
                  descripcion ?? null,
                  periodCode,
                  serializePlanBenefits(canonicalBenefits),
                ]
              );
            } else {
              await client.query(
                `
                  UPDATE public.membership_plans
                  SET
                    nombre_plan = $2,
                    descripcion = $3,
                    periodo_membresia_codigo = $4,
                    activo = TRUE,
                    updated_at = NOW()
                  WHERE id_plan = $1::uuid
                `,
                [
                  targetPlanId,
                  nombrePlan,
                  descripcion ?? null,
                  periodCode,
                ]
              );
            }
          }
        }

        await upsertPlanBranchOffer(client, targetPlanId, branchId, {
          precioHnl,
          activo: nextActive,
          visiblePublico,
          ordenVisual,
        });

        const finalResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_SCOPED_SQL : GET_PLAN_SCOPED_SQL_LEGACY,
          [targetPlanId, branchId]
        );
        await client.query("COMMIT");

        return sendOk(reply, mapPlanRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el plan de membresia",
          "ADMIN_CATALOG_PLAN_UPDATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/:id/estado",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        body: planStateBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: planResponseSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const supportsPlanCategoryColumn = await hasPlanCategoryColumn(client);
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        await client.query("BEGIN");

        const baseResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_BASE_SQL : GET_PLAN_BASE_SQL_LEGACY,
          [request.params.id]
        );
        const basePlan = baseResult.rows[0];
        if (!basePlan) {
          throw new AppError(404, "El plan solicitado no existe", {
            code: "CATALOG_PLAN_NOT_FOUND",
          });
        }

        const scopedResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_SCOPED_SQL : GET_PLAN_SCOPED_SQL_LEGACY,
          [request.params.id, branchId]
        );
        const scopedPlan = scopedResult.rows[0] ?? null;
        const nextActivo = Boolean(request.body.activo);
        const baseBenefits = parseStoredBenefits(basePlan.beneficios);
        const requiresActiveSubscriptionsConfirmation = !nextActivo && request.body?.confirmar_clientes_activos !== true;

        if (requiresActiveSubscriptionsConfirmation) {
          const totalClientesActivos = await countActiveSubscriptionsForPlan(client, request.params.id, branchId);
          if (totalClientesActivos > 0) {
            throw new AppError(409, "Este plan tiene clientes con suscripcion vigente en la sucursal seleccionada.", {
              code: "CATALOG_PLAN_ACTIVE_SUBSCRIPTIONS_CONFIRM_REQUIRED",
              details: {
                total_clientes_activos: totalClientesActivos,
              },
            });
          }
        }

        if (nextActivo) {
          // AM: No se reactiva un plan si sus servicios-beneficio no estan operativos en la sucursal.
          await ensurePlanServiceBenefitsAccessible(client, baseBenefits, branchId);
        }

        await upsertPlanBranchOffer(client, request.params.id, branchId, {
          precioHnl: scopedPlan?.precio_hnl == null ? Number(basePlan.precio_hnl) : Number(scopedPlan.precio_hnl),
          activo: nextActivo,
          visiblePublico: normalizeBoolean(scopedPlan?.visible_publico, true),
          ordenVisual: normalizeOrderVisual(scopedPlan?.orden_visual, 100),
        });

        await client.query(
          `
            UPDATE public.membership_plans
            SET
              activo = TRUE,
              updated_at = NOW()
            WHERE id_plan = $1::uuid
          `,
          [request.params.id]
        );

        const finalResult = await client.query(
          supportsPlanCategoryColumn ? GET_PLAN_SCOPED_SQL : GET_PLAN_SCOPED_SQL_LEGACY,
          [request.params.id, branchId]
        );
        await client.query("COMMIT");

        return sendOk(reply, mapPlanRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el estado del plan de membresia",
          "ADMIN_CATALOG_PLAN_STATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );
}
