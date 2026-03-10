import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

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

const servicioSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    descripcion: { type: ["string", "null"] },
    duracion_min: { type: "integer" },
    buffer_min: { type: "integer" },
    precio_hnl: { type: "number" },
    grupo_catalogo: { type: "string", enum: ["barberia", "otros"] },
    agendable: { type: "boolean" },
    agendable_barbero: { type: "boolean" },
  },
  required: [
    "id_servicio",
    "nombre_servicio",
    "descripcion",
    "duracion_min",
    "buffer_min",
    "precio_hnl",
    "grupo_catalogo",
    "agendable",
    "agendable_barbero",
  ],
  additionalProperties: false,
};

const paqueteItemSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["id_servicio", "nombre_servicio", "cantidad"],
  additionalProperties: false,
};

const paqueteSchema = {
  type: "object",
  properties: {
    id_paquete: { type: "string", format: "uuid" },
    nombre_paquete: { type: "string" },
    descripcion: { type: ["string", "null"] },
    precio_hnl: { type: ["number", "null"] },
    items: { type: "array", items: paqueteItemSchema },
  },
  required: ["id_paquete", "nombre_paquete", "descripcion", "precio_hnl", "items"],
  additionalProperties: false,
};

const PUBLIC_SERVICES_SQL = `
  WITH active_tariffs AS (
    SELECT
      st.id_servicio,
      st.id_sucursal,
      st.precio_hnl,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio, st.id_sucursal
        ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    JOIN public.sucursales su
      ON su.id_sucursal = st.id_sucursal
    WHERE st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND st.id_empleado IS NULL
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR st.id_sucursal = $1::uuid)
  ),
  picked_tariffs AS (
    SELECT id_servicio, id_sucursal, precio_hnl
    FROM active_tariffs
    WHERE rn = 1
  ),
  service_prices AS (
    SELECT
      pt.id_servicio,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(pt.precio_hnl)
        ELSE MAX(pt.precio_hnl)
      END AS precio_hnl
    FROM picked_tariffs pt
    GROUP BY pt.id_servicio
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    s.duracion_min,
    s.buffer_min,
    s.grupo_catalogo,
    s.agendable,
    sp.precio_hnl
  FROM public.servicios s
  JOIN service_prices sp
    ON sp.id_servicio = s.id_servicio
  WHERE s.deleted_at IS NULL
    AND s.activo IS TRUE
    AND s.visible_publico IS TRUE
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC
`;

const PUBLIC_PACKAGES_SQL = `
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric AS precio_hnl,
    COALESCE(
      json_agg(
        json_build_object(
          'id_servicio', s.id_servicio,
          'nombre_servicio', s.nombre_servicio,
          'cantidad', pd.cantidad
        )
        ORDER BY s.nombre_servicio
      ) FILTER (WHERE s.id_servicio IS NOT NULL),
      '[]'::json
    ) AS items
  FROM public.paquetes p
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
   AND s.activo IS TRUE
  WHERE p.deleted_at IS NULL
    AND p.activo IS TRUE
  GROUP BY p.id_paquete
  ORDER BY p.nombre_paquete ASC
`;

function mapServiceRow(row) {
  const grupoCatalogo = String(row.grupo_catalogo || "barberia").trim().toLowerCase() === "otros" ? "otros" : "barberia";
  const agendable = Boolean(row.agendable ?? (grupoCatalogo === "barberia"));

  return {
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio,
    descripcion: row.descripcion ?? null,
    duracion_min: Number(row.duracion_min),
    buffer_min: Number(row.buffer_min ?? 0),
    precio_hnl: Number(row.precio_hnl ?? 0),
    grupo_catalogo: grupoCatalogo,
    agendable,
    // AM: Campo legado conservado temporalmente para frontend ya integrado.
    agendable_barbero: agendable,
  };
}

function mapPackageRow(row) {
  return {
    id_paquete: row.id_paquete,
    nombre_paquete: row.nombre_paquete,
    descripcion: row.descripcion ?? null,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    items: Array.isArray(row.items)
      ? row.items.map((item) => ({
          id_servicio: item.id_servicio,
          nombre_servicio: item.nombre_servicio,
          cantidad: Number(item.cantidad ?? 1),
        }))
      : [],
  };
}

export default async function publicCatalogRoutes(app) {
  app.get(
    "/servicios",
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
                  servicios: { type: "array", items: servicioSchema },
                },
                required: ["servicios"],
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
        const { rows } = await app.db.query(PUBLIC_SERVICES_SQL, [request.query?.id_sucursal ?? null]);
        return sendOk(reply, {
          servicios: rows.map(mapServiceRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog servicios error");
        return sendError(reply, 500, "No se pudo consultar el catalogo de servicios", {
          code: "PUBLIC_CATALOG_SERVICES_ERROR",
          details: error instanceof Error ? error.message : "Unknown public catalog services error",
        });
      }
    }
  );

  app.get(
    "/paquetes",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  paquetes: { type: "array", items: paqueteSchema },
                },
                required: ["paquetes"],
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
        const { rows } = await app.db.query(PUBLIC_PACKAGES_SQL);
        return sendOk(reply, {
          paquetes: rows.map(mapPackageRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog paquetes error");
        return sendError(reply, 500, "No se pudo consultar el catalogo de paquetes", {
          code: "PUBLIC_CATALOG_PACKAGES_ERROR",
          details: error instanceof Error ? error.message : "Unknown public catalog packages error",
        });
      }
    }
  );
}
