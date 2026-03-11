import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const PLAN_BENEFIT_TYPES = ["servicio", "cortesia"];
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

const planBenefitSchema = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: PLAN_BENEFIT_TYPES },
    id_servicio: { type: ["string", "null"], format: "uuid" },
    codigo: { type: ["string", "null"] },
    nombre: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["tipo", "id_servicio", "codigo", "nombre", "cantidad"],
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
    precio_hnl: { type: ["number", "null"] },
    beneficios: { type: "array", items: planBenefitSchema },
  },
  required: [
    "id_plan",
    "id_sucursal",
    "nombre_plan",
    "descripcion",
    "periodo_membresia_codigo",
    "periodo_membresia_label",
    "precio_hnl",
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
  ORDER BY eo.orden_visual ASC, mp.nombre_plan ASC
`;

function parseStoredBenefits(rawBenefits) {
  if (!rawBenefits) return [];

  const data = rawBenefits && typeof rawBenefits === "object" ? rawBenefits : {};
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(rawBenefits) ? rawBenefits : [];

  return items
    .map((beneficio) => ({
      tipo: String(beneficio?.tipo || "").trim().toLowerCase() === "servicio" ? "servicio" : "cortesia",
      id_servicio: beneficio?.id_servicio ? String(beneficio.id_servicio) : null,
      codigo: beneficio?.codigo ? String(beneficio.codigo) : null,
      nombre: String(beneficio?.nombre || "").trim(),
      cantidad: Number(beneficio?.cantidad ?? 0),
    }))
    .filter((beneficio) => Number.isInteger(beneficio.cantidad) && beneficio.cantidad > 0)
    .map((beneficio) => ({
      ...beneficio,
      nombre: beneficio.nombre || (beneficio.tipo === "servicio" ? "Servicio incluido" : "Cortesia"),
    }));
}

function mapPlanRow(row) {
  return {
    id_plan: row.id_plan,
    id_sucursal: row.id_sucursal ?? null,
    nombre_plan: row.nombre_plan,
    descripcion: row.descripcion ?? null,
    periodo_membresia_codigo: row.periodo_membresia_codigo,
    periodo_membresia_label: row.periodo_membresia_label || row.periodo_membresia_codigo,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    beneficios: parseStoredBenefits(row.beneficios),
  };
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
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      try {
        const { rows } = await app.db.query(PUBLIC_PLANS_SQL, [request.query?.id_sucursal ?? null]);
        return sendOk(reply, {
          planes: rows.map(mapPlanRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog planes error");
        if (error?.code === "42P01" && String(error?.message || "").includes("membership_plans_sucursal")) {
          return sendError(reply, 500, "Falta aplicar migracion de PLANES multi-sucursal en la base de datos", {
            code: "PUBLIC_PLAN_MIGRATION_REQUIRED",
            details: error.message,
          });
        }
        return sendError(reply, 500, "No se pudo consultar el catalogo de planes", {
          code: "PUBLIC_CATALOG_PLANS_ERROR",
          details: error instanceof Error ? error.message : "Unknown public catalog plans error",
        });
      }
    }
  );
}
