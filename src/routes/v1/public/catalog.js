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

const sucursalSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string" },
  },
  required: ["id_sucursal", "nombre_sucursal"],
  additionalProperties: false,
};

const promocionSchema = {
  type: "object",
  properties: {
    id_promocion: { type: "string", format: "uuid" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    slug: { type: "string" },
    titulo: { type: "string" },
    subtitulo: { type: ["string", "null"] },
    parrafos: { type: "array", items: { type: "string" } },
    imagen_principal_url: { type: ["string", "null"] },
    imagen_mobile_url: { type: ["string", "null"] },
    imagen_alt: { type: ["string", "null"] },
    cta_texto: { type: ["string", "null"] },
    cta_url: { type: ["string", "null"] },
    cta_tipo: { type: "string", enum: ["interno", "externo", "none"] },
    estado: { type: "string", enum: ["publicada"] },
    vigencia_desde: { type: ["string", "null"], format: "date" },
    vigencia_hasta: { type: ["string", "null"], format: "date" },
    orden_visual: { type: "integer" },
    destacada: { type: "boolean" },
  },
  required: [
    "id_promocion",
    "id_sucursal",
    "slug",
    "titulo",
    "subtitulo",
    "parrafos",
    "imagen_principal_url",
    "imagen_mobile_url",
    "imagen_alt",
    "cta_texto",
    "cta_url",
    "cta_tipo",
    "estado",
    "vigencia_desde",
    "vigencia_hasta",
    "orden_visual",
    "destacada",
  ],
  additionalProperties: false,
};

const PUBLIC_SERVICES_SQL = `
  WITH active_tariffs AS (
    SELECT
      st.id_servicio,
      st.id_sucursal,
      st.precio_hnl,
      st.duracion_min,
      st.buffer_min,
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
    SELECT id_servicio, id_sucursal, precio_hnl, duracion_min, buffer_min
    FROM active_tariffs
    WHERE rn = 1
  ),
  service_scope AS (
    SELECT
      ranked.id_servicio,
      ranked.precio_hnl,
      ranked.duracion_min,
      ranked.buffer_min
    FROM (
      SELECT
        pt.id_servicio,
        pt.precio_hnl,
        pt.duracion_min,
        pt.buffer_min,
        ROW_NUMBER() OVER (
          PARTITION BY pt.id_servicio
          ORDER BY
            pt.precio_hnl ASC NULLS LAST,
            pt.duracion_min ASC NULLS LAST,
            pt.buffer_min ASC NULLS LAST,
            pt.id_sucursal::text ASC
        ) AS rn
      FROM picked_tariffs pt
    ) ranked
    WHERE ranked.rn = 1
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    -- AM: Usa tiempos por sucursal cuando existen; fallback al servicio base para compatibilidad legacy.
    COALESCE(ss.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(ss.buffer_min, s.buffer_min) AS buffer_min,
    s.grupo_catalogo,
    s.agendable,
    ss.precio_hnl
  FROM public.servicios s
  JOIN service_scope ss
    ON ss.id_servicio = s.id_servicio
  WHERE s.deleted_at IS NULL
    AND s.activo IS TRUE
    AND s.visible_publico IS TRUE
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC
`;

const PUBLIC_PACKAGES_SQL = `
  -- AM: Oferta publica de paquetes filtrada por sucursal y validada contra servicios operativos de esa sucursal.
  WITH scoped_offers AS (
    SELECT
      ps.id_paquete,
      ps.id_sucursal,
      ps.precio_hnl,
      ROW_NUMBER() OVER (
        PARTITION BY ps.id_paquete, ps.id_sucursal
        ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
      ) AS rn
    FROM public.paquetes_sucursal ps
    JOIN public.sucursales su
      ON su.id_sucursal = ps.id_sucursal
    WHERE ps.activo IS TRUE
      AND ps.visible_publico IS TRUE
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_paquete,
      so.id_sucursal,
      so.precio_hnl
    FROM scoped_offers so
    WHERE so.rn = 1
  ),
  effective_offers AS (
    SELECT
      po.id_paquete,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.precio_hnl)
        ELSE MAX(po.precio_hnl)
      END AS precio_hnl,
      CASE
        -- AM: PostgreSQL no soporta min/max directo sobre UUID en algunos entornos; se castea via text para seleccion determinista.
        WHEN $1::uuid IS NULL THEN MIN(po.id_sucursal::text)::uuid
        ELSE MAX(po.id_sucursal::text)::uuid
      END AS id_sucursal
    FROM picked_offers po
    GROUP BY po.id_paquete
  )
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    COALESCE(eo.precio_hnl, NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric) AS precio_hnl,
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
  JOIN effective_offers eo
    ON eo.id_paquete = p.id_paquete
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
   AND s.activo IS TRUE
  LEFT JOIN LATERAL (
    SELECT 1 AS has_tarifa
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = pd.id_servicio
      AND st.id_sucursal = eo.id_sucursal
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
    ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
    LIMIT 1
  ) tariff_scope ON TRUE
  WHERE p.deleted_at IS NULL
    AND p.activo IS TRUE
  GROUP BY p.id_paquete, eo.precio_hnl, eo.id_sucursal
  HAVING COUNT(pd.id_servicio) > 0
     AND COUNT(s.id_servicio) = COUNT(pd.id_servicio)
     AND COUNT(tariff_scope.has_tarifa) = COUNT(pd.id_servicio)
  ORDER BY p.nombre_paquete ASC
`;

const PUBLIC_BRANCHES_SQL = `
  SELECT
    s.id_sucursal,
    s.nombre_sucursal
  FROM public.sucursales s
  WHERE s.deleted_at IS NULL
    AND s.estado IS TRUE
  ORDER BY s.nombre_sucursal ASC
`;

const PUBLIC_PROMOTIONS_SQL = `
  -- AM: Publica promociones vigentes por sucursal. Si no llega id_sucursal, retorna una version determinista por promocion.
  WITH scoped_promotions AS (
    SELECT
      p.id_promocion,
      ps.id_sucursal,
      p.slug,
      p.titulo,
      p.subtitulo,
      p.parrafos,
      p.imagen_principal_url,
      p.imagen_mobile_url,
      p.imagen_alt,
      p.cta_texto,
      p.cta_url,
      p.cta_tipo,
      p.estado,
      ps.vigencia_desde,
      ps.vigencia_hasta,
      ps.orden_visual,
      ps.destacada
    FROM public.promociones p
    JOIN public.promociones_sucursal ps
      ON ps.id_promocion = p.id_promocion
    JOIN public.sucursales s
      ON s.id_sucursal = ps.id_sucursal
    WHERE s.deleted_at IS NULL
      AND s.estado IS TRUE
      AND p.estado = 'publicada'
      AND ps.visible_publico IS TRUE
      AND (ps.vigencia_desde IS NULL OR ps.vigencia_desde <= CURRENT_DATE)
      AND (ps.vigencia_hasta IS NULL OR ps.vigencia_hasta >= CURRENT_DATE)
      AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  ranked AS (
    SELECT
      sp.*,
      ROW_NUMBER() OVER (
        PARTITION BY sp.id_promocion
        ORDER BY
          CASE WHEN $1::uuid IS NULL THEN 0 ELSE 1 END ASC,
          sp.destacada DESC,
          sp.orden_visual ASC,
          sp.id_sucursal::text ASC
      ) AS rn
    FROM scoped_promotions sp
  )
  SELECT
    id_promocion,
    id_sucursal,
    slug,
    titulo,
    subtitulo,
    parrafos,
    imagen_principal_url,
    imagen_mobile_url,
    imagen_alt,
    cta_texto,
    cta_url,
    cta_tipo,
    estado,
    vigencia_desde,
    vigencia_hasta,
    orden_visual,
    destacada
  FROM ranked
  WHERE ($1::uuid IS NULL AND rn = 1) OR ($1::uuid IS NOT NULL)
  ORDER BY destacada DESC, orden_visual ASC, titulo ASC
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

function mapBranchRow(row) {
  return {
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal,
  };
}

function mapPromotionRow(row) {
  return {
    id_promocion: row.id_promocion,
    id_sucursal: row.id_sucursal ?? null,
    slug: row.slug,
    titulo: row.titulo,
    subtitulo: row.subtitulo ?? null,
    parrafos: Array.isArray(row.parrafos) ? row.parrafos : [],
    imagen_principal_url: row.imagen_principal_url ?? null,
    imagen_mobile_url: row.imagen_mobile_url ?? null,
    imagen_alt: row.imagen_alt ?? null,
    cta_texto: row.cta_texto ?? null,
    cta_url: row.cta_url ?? null,
    cta_tipo: row.cta_tipo || "none",
    estado: "publicada",
    vigencia_desde: row.vigencia_desde ?? null,
    vigencia_hasta: row.vigencia_hasta ?? null,
    orden_visual: Number(row.orden_visual ?? 100),
    destacada: Boolean(row.destacada),
  };
}

export default async function publicCatalogRoutes(app) {
  app.get(
    "/sucursales",
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
                  sucursales: { type: "array", items: sucursalSchema },
                },
                required: ["sucursales"],
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
        const { rows } = await app.db.query(PUBLIC_BRANCHES_SQL);
        return sendOk(reply, {
          sucursales: rows.map(mapBranchRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog sucursales error");
        return sendError(reply, 500, "No se pudo consultar sucursales publicas del catalogo", {
          code: "PUBLIC_CATALOG_BRANCHES_ERROR",
          details: error instanceof Error ? error.message : "Unknown public catalog branches error",
        });
      }
    }
  );

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
        const { rows } = await app.db.query(PUBLIC_PACKAGES_SQL, [request.query?.id_sucursal ?? null]);
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

  app.get(
    "/promociones",
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
                  promociones: { type: "array", items: promocionSchema },
                },
                required: ["promociones"],
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
        const { rows } = await app.db.query(PUBLIC_PROMOTIONS_SQL, [request.query?.id_sucursal ?? null]);
        return sendOk(reply, {
          promociones: rows.map(mapPromotionRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog promociones error");
        if (
          error?.code === "42P01" &&
          (String(error?.message || "").includes("promociones_sucursal") || String(error?.message || "").includes("promociones"))
        ) {
          return sendError(reply, 500, "Falta aplicar migracion de PROMOCIONES multi-sucursal en la base de datos", {
            code: "PUBLIC_PROMOTIONS_MIGRATION_REQUIRED",
            details: error.message,
          });
        }
        return sendError(reply, 500, "No se pudo consultar el catalogo de promociones", {
          code: "PUBLIC_CATALOG_PROMOTIONS_ERROR",
          details: error instanceof Error ? error.message : "Unknown public catalog promotions error",
        });
      }
    }
  );
}
