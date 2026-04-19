import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

// AM: Catalogo publico muestra beneficios comerciales de servicio y cortesia.
const PLAN_BENEFIT_TYPES = ["servicio", "cortesia"];
const PLAN_CATEGORY_MIN = 1;
const PLAN_CATEGORY_MAX = 5;
const DEFAULT_PLAN_CATEGORY = 1;
const requestIdSchema = { type: "string" };

const PLAN_CATEGORY_COLUMN_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'membership_plans'
      AND column_name = 'categoria_nivel'
  ) AS exists
`;

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

const planBenefitSchema = {
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

const planSchema = {
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
    orden_visual: { type: "integer" },
    beneficios: { type: "array", items: planBenefitSchema },
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
    "orden_visual",
    "beneficios",
  ],
  additionalProperties: false,
};

const PUBLIC_PLANS_SQL = `
  WITH scoped_offers AS (
    SELECT
      mps.id_plan,
      mps.id_sucursal,
      mps.precio_hnl,
      mps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY mps.id_plan, mps.id_sucursal
        ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
      ) AS rn
    FROM public.membership_plans_sucursal mps
    JOIN public.sucursales su
      ON su.id_sucursal = mps.id_sucursal
    WHERE mps.activo IS TRUE
      AND mps.visible_publico IS TRUE
      AND mps.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR mps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_plan,
      so.id_sucursal,
      so.precio_hnl,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  ),
  effective_offers AS (
    SELECT
      po.id_plan,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.precio_hnl)
        ELSE MAX(po.precio_hnl)
      END AS precio_hnl,
      CASE
        -- AM: Seleccion determinista de sucursal efectiva sin depender de operadores min/max uuid.
        WHEN $1::uuid IS NULL THEN MIN(po.id_sucursal::text)::uuid
        ELSE MAX(po.id_sucursal::text)::uuid
      END AS id_sucursal,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.orden_visual)
        ELSE MAX(po.orden_visual)
      END AS orden_visual
    FROM picked_offers po
    GROUP BY po.id_plan
  )
  SELECT
    mp.id_plan,
    eo.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    mp.categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(eo.precio_hnl, mp.precio_hnl) AS precio_hnl,
    mp.beneficios,
    eo.orden_visual
  FROM public.membership_plans mp
  JOIN effective_offers eo
    ON eo.id_plan = mp.id_plan
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  WHERE mp.activo IS TRUE
    AND COALESCE(eo.precio_hnl, mp.precio_hnl) > 0
  ORDER BY eo.orden_visual ASC, mp.nombre_plan ASC
`;

const PUBLIC_PLANS_SQL_LEGACY = `
  WITH scoped_offers AS (
    SELECT
      mps.id_plan,
      mps.id_sucursal,
      mps.precio_hnl,
      mps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY mps.id_plan, mps.id_sucursal
        ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
      ) AS rn
    FROM public.membership_plans_sucursal mps
    JOIN public.sucursales su
      ON su.id_sucursal = mps.id_sucursal
    WHERE mps.activo IS TRUE
      AND mps.visible_publico IS TRUE
      AND mps.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR mps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_plan,
      so.id_sucursal,
      so.precio_hnl,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  ),
  effective_offers AS (
    SELECT
      po.id_plan,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.precio_hnl)
        ELSE MAX(po.precio_hnl)
      END AS precio_hnl,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.id_sucursal::text)::uuid
        ELSE MAX(po.id_sucursal::text)::uuid
      END AS id_sucursal,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.orden_visual)
        ELSE MAX(po.orden_visual)
      END AS orden_visual
    FROM picked_offers po
    GROUP BY po.id_plan
  )
  SELECT
    mp.id_plan,
    eo.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    1::smallint AS categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    COALESCE(eo.precio_hnl, mp.precio_hnl) AS precio_hnl,
    mp.beneficios,
    eo.orden_visual
  FROM public.membership_plans mp
  JOIN effective_offers eo
    ON eo.id_plan = mp.id_plan
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  WHERE mp.activo IS TRUE
    AND COALESCE(eo.precio_hnl, mp.precio_hnl) > 0
  ORDER BY eo.orden_visual ASC, mp.nombre_plan ASC
`;

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
      // AM: Compatibilidad legacy de solo lectura:
      // 1) servicio requiere id_servicio;
      // 2) cortesia moderna requiere id_cortesia;
      // 3) solo para visualizar datos viejos se acepta cortesia sin id_cortesia si tipo=cortesia y trae nombre/codigo.
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
      nombre: beneficio.nombre || (beneficio.tipo === "servicio" ? "Servicio incluido" : (beneficio.codigo || "Cortesia incluida")),
    }));
}

function normalizePlanCategory(value, fallback = DEFAULT_PLAN_CATEGORY) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < PLAN_CATEGORY_MIN || parsed > PLAN_CATEGORY_MAX) return fallback;
  return parsed;
}

async function hasPlanCategoryColumn(app) {
  const { rows } = await app.db.query(PLAN_CATEGORY_COLUMN_EXISTS_SQL);
  return Boolean(rows[0]?.exists);
}

function mapPlanRow(row) {
  return {
    id_plan: row.id_plan,
    id_sucursal: row.id_sucursal ?? null,
    nombre_plan: row.nombre_plan,
    descripcion: row.descripcion ?? null,
    periodo_membresia_codigo: row.periodo_membresia_codigo,
    periodo_membresia_label: row.periodo_membresia_label || row.periodo_membresia_codigo,
    categoria_nivel: normalizePlanCategory(row.categoria_nivel, DEFAULT_PLAN_CATEGORY),
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    orden_visual: Number(row.orden_visual ?? 100),
    beneficios: parseStoredBenefits(row.beneficios),
  };
}

function isValidPublicPlan(plan) {
  const price = Number(plan?.precio_hnl);
  if (!Number.isFinite(price) || price <= 0) return false;
  const benefits = Array.isArray(plan?.beneficios) ? plan.beneficios : [];
  return benefits.some((benefit) => String(benefit?.tipo || "").toLowerCase() === "servicio" && benefit?.id_servicio);
}

function sendPublicPlansError(reply, requestId, statusCode, message, code) {
  return sendError(reply, statusCode, message, {
    code,
    requestId,
  });
}

export default async function publicPlansRoutes(app) {
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  planes: { type: "array", items: planSchema },
                },
                required: ["planes"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendPublicPlansError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      try {
        const supportsPlanCategoryColumn = await hasPlanCategoryColumn(app);
        const querySql = supportsPlanCategoryColumn ? PUBLIC_PLANS_SQL : PUBLIC_PLANS_SQL_LEGACY;
        const { rows } = await app.db.query(querySql, [request.query?.id_sucursal ?? null]);
        const planes = rows.map(mapPlanRow).filter(isValidPublicPlan);
        return sendOk(reply, { planes });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog planes error");
        if (error?.code === "42P01" && String(error?.message || "").includes("membership_plans_sucursal")) {
          return sendPublicPlansError(reply, request.id, 500, "Falta aplicar migracion de PLANES multi-sucursal en la base de datos", "PUBLIC_PLAN_MIGRATION_REQUIRED");
        }
        if (error?.code === "42703" && String(error?.message || "").includes("categoria_nivel")) {
          return sendPublicPlansError(reply, request.id, 500, "Falta aplicar migracion de categoria de planes en la base de datos", "PUBLIC_PLAN_CATEGORY_MIGRATION_REQUIRED");
        }
        return sendPublicPlansError(reply, request.id, 500, "No se pudo consultar el catalogo de planes", "PUBLIC_CATALOG_PLANS_ERROR");
      }
    }
  );
}
