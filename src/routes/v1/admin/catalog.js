import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
const requestIdSchema = { type: "string" };
const SERVICE_GROUPS = ["barberia", "otros"];

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

const serviceBodySchema = {
  type: "object",
  properties: {
    nombre_servicio: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    duracion_min: { type: "integer", minimum: 1 },
    buffer_min: { type: "integer", minimum: 0 },
    precio_hnl: { type: "number", minimum: 0 },
    grupo_catalogo: { type: "string", enum: SERVICE_GROUPS },
    visible_publico: { type: "boolean" },
    agendable: { type: "boolean" },
    orden_visual: { type: "integer", minimum: 0 },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
  },
  required: ["nombre_servicio", "duracion_min", "buffer_min", "precio_hnl"],
  additionalProperties: false,
};

const servicePatchSchema = {
  type: "object",
  properties: {
    nombre_servicio: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    duracion_min: { type: "integer", minimum: 1 },
    buffer_min: { type: "integer", minimum: 0 },
    precio_hnl: { type: "number", minimum: 0 },
    grupo_catalogo: { type: "string", enum: SERVICE_GROUPS },
    visible_publico: { type: "boolean" },
    agendable: { type: "boolean" },
    orden_visual: { type: "integer", minimum: 0 },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
  },
  minProperties: 1,
  additionalProperties: false,
};

const packageBodySchema = {
  type: "object",
  properties: {
    nombre_paquete: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    precio_hnl: { type: "number", minimum: 0 },
    // AM: Operacion multi-sucursal: alta y edicion de paquetes siempre debe poder fijar sucursal objetivo.
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    visible_publico: { type: "boolean" },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id_servicio: { type: "string", format: "uuid" },
          cantidad: { type: "integer", minimum: 1 },
        },
        required: ["id_servicio", "cantidad"],
        additionalProperties: false,
      },
    },
  },
  required: ["nombre_paquete", "precio_hnl", "items"],
  additionalProperties: false,
};

const packagePatchSchema = {
  type: "object",
  properties: {
    nombre_paquete: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    precio_hnl: { type: "number", minimum: 0 },
    // AM: Permite ajustar visibilidad/oferta en la sucursal seleccionada sin romper metadata global.
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    visible_publico: { type: "boolean" },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id_servicio: { type: "string", format: "uuid" },
          cantidad: { type: "integer", minimum: 1 },
        },
        required: ["id_servicio", "cantidad"],
        additionalProperties: false,
      },
    },
  },
  minProperties: 1,
  additionalProperties: false,
};

const serviceResponseSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    descripcion: { type: ["string", "null"] },
    duracion_min: { type: "integer" },
    buffer_min: { type: "integer" },
    precio_hnl: { type: ["number", "null"] },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    activo: { type: "boolean" },
    tarifa_activa: { type: "boolean" },
    grupo_catalogo: { type: "string", enum: SERVICE_GROUPS },
    visible_publico: { type: "boolean" },
    agendable: { type: "boolean" },
    orden_visual: { type: "integer" },
    agendable_barbero: { type: "boolean" },
  },
  required: [
    "id_servicio",
    "nombre_servicio",
    "descripcion",
    "duracion_min",
    "buffer_min",
    "precio_hnl",
    "id_sucursal",
    "activo",
    "tarifa_activa",
    "grupo_catalogo",
    "visible_publico",
    "agendable",
    "orden_visual",
    "agendable_barbero",
  ],
  additionalProperties: false,
};

const serviceStateBodySchema = {
  type: "object",
  properties: {
    activo: { type: "boolean" },
    precio_hnl: { type: ["number", "null"], minimum: 0 },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
  },
  required: ["activo"],
  additionalProperties: false,
};

const packageStateBodySchema = {
  type: "object",
  properties: {
    activo: { type: "boolean" },
    // AM: Cambio de estado por sucursal para evitar inactivaciones globales accidentales.
    id_sucursal: { type: ["string", "null"], format: "uuid" },
  },
  required: ["activo"],
  additionalProperties: false,
};

const packageItemResponseSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["id_servicio", "nombre_servicio", "cantidad"],
  additionalProperties: false,
};

const packageResponseSchema = {
  type: "object",
  properties: {
    id_paquete: { type: "string", format: "uuid" },
    nombre_paquete: { type: "string" },
    descripcion: { type: ["string", "null"] },
    precio_hnl: { type: ["number", "null"] },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    activo: { type: "boolean" },
    visible_publico: { type: "boolean" },
    items: { type: "array", items: packageItemResponseSchema },
  },
  required: ["id_paquete", "nombre_paquete", "descripcion", "precio_hnl", "id_sucursal", "activo", "visible_publico", "items"],
  additionalProperties: false,
};

const LIST_SERVICES_SQL = `
  WITH scoped_tariffs AS (
    SELECT
      st.*,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio, st.id_sucursal
        ORDER BY st.activo DESC, st.vigente_hasta IS NULL DESC, st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    WHERE ($1::uuid IS NULL OR st.id_sucursal = $1::uuid)
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    -- AM: Duracion y buffer efectivos por sucursal con fallback al valor base del servicio.
    COALESCE(st.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(st.buffer_min, s.buffer_min) AS buffer_min,
    s.grupo_catalogo,
    s.visible_publico,
    s.agendable,
    s.orden_visual,
    s.activo,
    st.id_sucursal,
    st.precio_hnl,
    COALESCE(st.activo, FALSE) AS tarifa_activa
  FROM public.servicios s
  LEFT JOIN scoped_tariffs st
    ON st.id_servicio = s.id_servicio
   AND st.rn = 1
  WHERE s.deleted_at IS NULL
    -- AM: Si se solicita una sucursal especifica, se excluyen servicios sin tarifa en dicha sucursal.
    AND ($1::uuid IS NULL OR st.id_sucursal IS NOT NULL)
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC, st.id_sucursal ASC NULLS LAST
`;

const GET_SERVICE_SQL = `
  WITH scoped_tariffs AS (
    SELECT
      st.*,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio
        ORDER BY st.activo DESC, st.vigente_hasta IS NULL DESC, st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    WHERE ($2::uuid IS NULL OR st.id_sucursal = $2::uuid)
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    -- AM: Duracion y buffer efectivos por sucursal con fallback al valor base del servicio.
    COALESCE(st.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(st.buffer_min, s.buffer_min) AS buffer_min,
    s.grupo_catalogo,
    s.visible_publico,
    s.agendable,
    s.orden_visual,
    s.activo,
    st.id_sucursal,
    st.precio_hnl,
    COALESCE(st.activo, FALSE) AS tarifa_activa
  FROM public.servicios s
  LEFT JOIN scoped_tariffs st
    ON st.id_servicio = s.id_servicio
   AND st.rn = 1
  WHERE s.id_servicio = $1::uuid
    AND s.deleted_at IS NULL
`;

const GET_SERVICE_BY_NAME_SQL = `
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    s.duracion_min,
    s.buffer_min,
    s.grupo_catalogo,
    s.visible_publico,
    s.agendable,
    s.orden_visual,
    s.deleted_at,
    s.activo
  FROM public.servicios s
  WHERE UPPER(TRIM(s.nombre_servicio)) = UPPER(TRIM($1))
  LIMIT 1
`;

const GET_SERVICE_BASE_SQL = `
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    s.duracion_min,
    s.buffer_min,
    s.grupo_catalogo,
    s.visible_publico,
    s.agendable,
    s.orden_visual,
    s.activo,
    s.deleted_at
  FROM public.servicios s
  WHERE s.id_servicio = $1::uuid
  LIMIT 1
`;

const GET_LATEST_SERVICE_TARIFF_SQL = `
  SELECT
    st.id_tarifa,
    st.precio_hnl,
    st.duracion_min,
    st.buffer_min,
    st.activo
  FROM public.servicios_tarifas st
  WHERE st.id_servicio = $1::uuid
    AND st.id_sucursal = $2::uuid
    AND st.id_empleado IS NULL
  ORDER BY st.activo DESC, st.vigente_hasta IS NULL DESC, st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
  LIMIT 1
  FOR UPDATE
`;

const GET_LATEST_ANY_SERVICE_TARIFF_SQL = `
  SELECT
    st.id_tarifa,
    st.precio_hnl,
    st.duracion_min,
    st.buffer_min,
    st.activo,
    st.deleted_at
  FROM public.servicios_tarifas st
  WHERE st.id_servicio = $1::uuid
    AND st.id_sucursal = $2::uuid
    AND st.id_empleado IS NULL
  ORDER BY st.updated_at DESC, st.vigente_desde DESC, st.id_tarifa DESC
  LIMIT 1
  FOR UPDATE
`;

const ACTIVE_SERVICE_TARIFFS_COUNT_SQL = `
  SELECT COUNT(*)::int AS total
  FROM public.servicios_tarifas st
  WHERE st.id_servicio = $1::uuid
    AND st.id_empleado IS NULL
    AND st.deleted_at IS NULL
    AND st.activo IS TRUE
`;

const ACTIVE_BRANCHES_SQL = `
  SELECT s.id_sucursal
  FROM public.sucursales s
  WHERE s.deleted_at IS NULL
    AND s.estado IS TRUE
  ORDER BY s.nombre_sucursal ASC
`;

const LIST_PACKAGES_SQL = `
  -- AM: Oferta de paquetes por sucursal (precio/estado/visibilidad) para evitar catalogo global ambiguo.
  WITH scoped_offers AS (
    SELECT
      ps.id_paquete,
      ps.id_sucursal,
      ps.precio_hnl,
      ps.activo,
      ps.visible_publico,
      ROW_NUMBER() OVER (
        PARTITION BY ps.id_paquete, ps.id_sucursal
        ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
      ) AS rn
    FROM public.paquetes_sucursal ps
    WHERE ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_paquete,
      so.id_sucursal,
      so.precio_hnl,
      so.activo,
      so.visible_publico
    FROM scoped_offers so
    WHERE so.rn = 1
  )
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    po.id_sucursal,
    COALESCE(po.precio_hnl, NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric) AS precio_hnl,
    (COALESCE(po.activo, FALSE) AND p.activo IS TRUE) AS activo,
    COALESCE(po.visible_publico, FALSE) AS visible_publico,
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
  JOIN picked_offers po
    ON po.id_paquete = p.id_paquete
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
   AND s.activo IS TRUE
  LEFT JOIN LATERAL (
    -- AM: El paquete solo es operativo en una sucursal si cada servicio tiene tarifa vigente en esa sucursal.
    SELECT 1 AS has_tarifa
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = pd.id_servicio
      AND st.id_sucursal = po.id_sucursal
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
    ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
    LIMIT 1
  ) tariff_scope ON TRUE
  WHERE p.deleted_at IS NULL
  GROUP BY p.id_paquete, po.id_sucursal, po.precio_hnl, po.activo, po.visible_publico
  HAVING COUNT(pd.id_servicio) > 0
     AND COUNT(s.id_servicio) = COUNT(pd.id_servicio)
     AND COUNT(tariff_scope.has_tarifa) = COUNT(pd.id_servicio)
  ORDER BY p.nombre_paquete ASC, po.id_sucursal ASC
`;

const GET_PACKAGE_BASE_SQL = `
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric AS precio_hnl,
    p.activo,
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
  WHERE p.id_paquete = $1::uuid
    AND p.deleted_at IS NULL
  GROUP BY p.id_paquete
`;

const GET_PACKAGE_SCOPED_SQL = `
  -- AM: Lectura puntual de paquete dentro de una sucursal.
  WITH picked_offer AS (
    SELECT
      ps.id_paquete,
      ps.id_sucursal,
      ps.precio_hnl,
      ps.activo,
      ps.visible_publico
    FROM public.paquetes_sucursal ps
    WHERE ps.id_paquete = $1::uuid
      AND ps.id_sucursal = $2::uuid
    ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
    LIMIT 1
  )
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    po.id_sucursal,
    COALESCE(po.precio_hnl, NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric) AS precio_hnl,
    (COALESCE(po.activo, FALSE) AND p.activo IS TRUE) AS activo,
    COALESCE(po.visible_publico, FALSE) AS visible_publico,
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
  JOIN picked_offer po
    ON po.id_paquete = p.id_paquete
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
  WHERE p.id_paquete = $1::uuid
    AND p.deleted_at IS NULL
  GROUP BY p.id_paquete, po.id_sucursal, po.precio_hnl, po.activo, po.visible_publico
`;

const GET_PACKAGE_OFFER_SQL = `
  SELECT
    ps.id_paquete_sucursal,
    ps.id_paquete,
    ps.id_sucursal,
    ps.precio_hnl,
    ps.activo,
    ps.visible_publico
  FROM public.paquetes_sucursal ps
  WHERE ps.id_paquete = $1::uuid
    AND ps.id_sucursal = $2::uuid
  ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
  LIMIT 1
  FOR UPDATE
`;

function normalizeOptionalText(value) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredText(value) {
  return String(value || "").trim();
}

function normalizeServiceGroup(value, fallback = "barberia") {
  const normalized = String(value || fallback).trim().toLowerCase();
  return SERVICE_GROUPS.includes(normalized) ? normalized : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeOrderVisual(value, fallback = 100) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function mapAdminServiceRow(row) {
  const grupoCatalogo = normalizeServiceGroup(row.grupo_catalogo);
  const agendable = normalizeBoolean(row.agendable, grupoCatalogo === "barberia");
  const visiblePublico = normalizeBoolean(row.visible_publico, true);
  const ordenVisual = normalizeOrderVisual(row.orden_visual, 100);

  return {
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio,
    descripcion: row.descripcion ?? null,
    duracion_min: Number(row.duracion_min),
    buffer_min: Number(row.buffer_min ?? 0),
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    id_sucursal: row.id_sucursal ?? null,
    activo: Boolean(row.activo),
    tarifa_activa: Boolean(row.tarifa_activa),
    grupo_catalogo: grupoCatalogo,
    visible_publico: visiblePublico,
    agendable,
    orden_visual: ordenVisual,
    // AM: Campo legado conservado para compatibilidad de clientes frontend antiguos.
    agendable_barbero: agendable,
  };
}

function mapAdminPackageRow(row) {
  return {
    id_paquete: row.id_paquete,
    nombre_paquete: row.nombre_paquete,
    descripcion: row.descripcion ?? null,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    id_sucursal: row.id_sucursal ?? null,
    activo: Boolean(row.activo),
    visible_publico: normalizeBoolean(row.visible_publico, Boolean(row.activo)),
    items: Array.isArray(row.items)
      ? row.items.map((item) => ({
        id_servicio: item.id_servicio,
        nombre_servicio: item.nombre_servicio,
        cantidad: Number(item.cantidad ?? 1),
      }))
      : [],
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

    if (isSuperAdmin) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM public.sucursales WHERE id_sucursal = $1::uuid AND deleted_at IS NULL AND estado IS TRUE",
        [requestedBranchId]
      );

      if (!rowCount) {
        throw new AppError(404, "La sucursal indicada no existe o no esta activa", {
          code: "CATALOG_BRANCH_NOT_FOUND",
        });
      }
    }

    return requestedBranchId;
  }

  if (!isSuperAdmin) {
    if (claimBranchIds.length === 1) {
      return claimBranchIds[0];
    }

    if (claimBranchIds.length === 0) {
      throw new AppError(400, "El usuario autenticado no tiene una sucursal asociada para gestionar catalogo", {
        code: "CATALOG_BRANCH_REQUIRED",
      });
    }

    throw new AppError(400, "Debes indicar id_sucursal cuando tu acceso cubre multiples sucursales", {
      code: "CATALOG_BRANCH_REQUIRED",
    });
  }

  if (allowAllForSuperAdmin) {
    return null;
  }

  const { rows } = await client.query(ACTIVE_BRANCHES_SQL);

  if (rows.length === 1) {
    return rows[0].id_sucursal;
  }

  throw new AppError(400, "Debes indicar id_sucursal para operar el catalogo cuando existen multiples sucursales activas", {
    code: "CATALOG_BRANCH_REQUIRED",
  });
}

async function ensureUniqueServiceName(client, serviceId, nombreServicio) {
  const { rows } = await client.query(
    `
      SELECT id_servicio
      FROM public.servicios
      WHERE UPPER(TRIM(nombre_servicio)) = UPPER(TRIM($1))
        AND ($2::uuid IS NULL OR id_servicio <> $2::uuid)
      LIMIT 1
    `,
    [nombreServicio, serviceId ?? null]
  );

  if (rows[0]) {
    throw new AppError(409, "Ya existe un servicio con ese nombre", {
      code: "CATALOG_SERVICE_DUPLICATE",
    });
  }
}

async function ensureUniquePackageName(client, packageId, nombrePaquete) {
  const { rows } = await client.query(
    `
      SELECT id_paquete
      FROM public.paquetes
      WHERE UPPER(TRIM(nombre_paquete)) = UPPER(TRIM($1))
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id_paquete <> $2::uuid)
      LIMIT 1
    `,
    [nombrePaquete, packageId ?? null]
  );

  if (rows[0]) {
    throw new AppError(409, "Ya existe un paquete con ese nombre", {
      code: "CATALOG_PACKAGE_DUPLICATE",
    });
  }
}

function normalizePackageItems(items) {
  // AM: Normaliza y valida el detalle para evitar paquetes vacios o con servicios duplicados.
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, "Agrega al menos un servicio al paquete", {
      code: "CATALOG_PACKAGE_ITEMS_REQUIRED",
    });
  }

  const seenServiceIds = new Set();

  return items.map((item) => {
    const idServicio = String(item?.id_servicio || "").trim();
    const cantidad = Number(item?.cantidad);

    if (!idServicio) {
      throw new AppError(400, "Cada item del paquete requiere id_servicio", {
        code: "CATALOG_PACKAGE_ITEM_INVALID",
      });
    }

    if (!Number.isInteger(cantidad) || cantidad < 1) {
      throw new AppError(400, "La cantidad de cada servicio del paquete debe ser mayor o igual a 1", {
        code: "CATALOG_PACKAGE_ITEM_INVALID",
      });
    }

    if (seenServiceIds.has(idServicio)) {
      throw new AppError(400, "No se permite repetir el mismo servicio dentro de un paquete", {
        code: "CATALOG_PACKAGE_DUPLICATE_SERVICE",
      });
    }

    seenServiceIds.add(idServicio);
    return {
      id_servicio: idServicio,
      cantidad,
    };
  });
}

async function ensurePackageItemsAccessible(client, claims, items, branchId = null) {
  const uniqueServiceIds = [...new Set(items.map((item) => item.id_servicio))];
  const claimBranchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.filter(Boolean) : [];
  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");
  const scopedBranchIds = branchId ? [branchId] : isSuperAdmin ? null : claimBranchIds;

  const { rows } = await client.query(
    `
      SELECT
        s.id_servicio,
        EXISTS (
          SELECT 1
          FROM public.servicios_tarifas st
          WHERE st.id_servicio = s.id_servicio
            AND st.id_empleado IS NULL
            AND st.deleted_at IS NULL
            AND st.activo IS TRUE
            AND st.vigente_desde <= CURRENT_DATE
            AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
            AND ($1::uuid[] IS NULL OR st.id_sucursal = ANY($1::uuid[]))
        ) AS has_scoped_tariff
      FROM public.servicios s
      WHERE s.id_servicio = ANY($2::uuid[])
        AND s.deleted_at IS NULL
        AND s.activo IS TRUE
    `,
    [scopedBranchIds, uniqueServiceIds]
  );

  if (rows.length !== uniqueServiceIds.length) {
    throw new AppError(400, "Uno o mas servicios del paquete no existen o no estan activos", {
      code: "CATALOG_PACKAGE_SERVICE_NOT_FOUND",
    });
  }

  if (rows.some((row) => !row.has_scoped_tariff)) {
    if (branchId) {
      // AM: Regla multi-sucursal: el paquete no puede depender de servicios no operativos en la sucursal objetivo.
      throw new AppError(409, "Uno o mas servicios no estan disponibles en la sucursal indicada", {
        code: "CATALOG_PACKAGE_SERVICE_OUT_OF_SCOPE",
      });
    }

    if (!isSuperAdmin) {
      throw new AppError(403, "Uno o mas servicios del paquete no estan tarifados dentro del alcance del administrador", {
        code: "AUTH_FORBIDDEN_BRANCH",
      });
    }
  }
}

async function upsertServiceTariff(client, idServicio, idSucursal, precioHnl, options = {}) {
  const parsedDuration =
    options?.duracionMin === undefined || options?.duracionMin === null ? null : Number(options.duracionMin);
  const parsedBuffer =
    options?.bufferMin === undefined || options?.bufferMin === null ? null : Number(options.bufferMin);
  const duracionMin = Number.isFinite(parsedDuration) ? Math.max(1, Math.floor(parsedDuration)) : null;
  const bufferMin = Number.isFinite(parsedBuffer) ? Math.max(0, Math.floor(parsedBuffer)) : null;

  const { rows } = await client.query(GET_LATEST_SERVICE_TARIFF_SQL, [idServicio, idSucursal]);
  const currentTariff = rows[0];

  if (currentTariff) {
    // AM: Reactiva la misma tarifa historica cuando existe, evitando colisiones de unicidad al reactivar.
    await client.query(
      `
        UPDATE public.servicios_tarifas
        SET
          precio_hnl = $2::numeric,
          duracion_min = COALESCE($3::int, duracion_min),
          buffer_min = COALESCE($4::int, buffer_min),
          activo = TRUE,
          vigente_hasta = NULL,
          deleted_at = NULL,
          updated_at = NOW()
        WHERE id_tarifa = $1::uuid
      `,
      [currentTariff.id_tarifa, precioHnl, duracionMin, bufferMin]
    );
    return;
  }

  try {
    await client.query(
      `
        INSERT INTO public.servicios_tarifas (
          id_servicio,
          id_sucursal,
          id_empleado,
          precio_hnl,
          duracion_min,
          buffer_min,
          vigente_desde,
          activo
        )
        VALUES ($1::uuid, $2::uuid, NULL, $3::numeric, $4::int, $5::int, CURRENT_DATE, TRUE)
      `,
      [idServicio, idSucursal, precioHnl, duracionMin, bufferMin]
    );
  } catch (error) {
    if (error?.code !== "23505") {
      throw error;
    }

    // AM: Fallback defensivo ante restricciones unicas legacy en servicios_tarifas.
    const fallback = await client.query(GET_LATEST_ANY_SERVICE_TARIFF_SQL, [idServicio, idSucursal]);
    const candidate = fallback.rows[0];

    if (!candidate?.id_tarifa) {
      throw error;
    }

    await client.query(
      `
        UPDATE public.servicios_tarifas
        SET
          precio_hnl = $2::numeric,
          duracion_min = COALESCE($3::int, duracion_min),
          buffer_min = COALESCE($4::int, buffer_min),
          activo = TRUE,
          vigente_hasta = NULL,
          deleted_at = NULL,
          updated_at = NOW()
        WHERE id_tarifa = $1::uuid
      `,
      [candidate.id_tarifa, precioHnl, duracionMin, bufferMin]
    );
  }
}

async function inactivateServiceByBranch(client, idServicio, idSucursal) {
  const tariffUpdate = await client.query(
    `
      UPDATE public.servicios_tarifas
      SET
        activo = FALSE,
        deleted_at = COALESCE(deleted_at, NOW()),
        updated_at = NOW()
      WHERE id_servicio = $1::uuid
        AND id_sucursal = $2::uuid
        AND id_empleado IS NULL
        AND deleted_at IS NULL
        AND activo IS TRUE
    `,
    [idServicio, idSucursal]
  );

  if (!tariffUpdate.rowCount) {
    throw new AppError(404, "No existe una tarifa activa para este servicio dentro de la sucursal indicada", {
      code: "CATALOG_SERVICE_SCOPE_NOT_FOUND",
    });
  }

  const remainingResult = await client.query(ACTIVE_SERVICE_TARIFFS_COUNT_SQL, [idServicio]);
  const activeTariffsRemaining = Number(remainingResult.rows[0]?.total ?? 0);

  if (activeTariffsRemaining === 0) {
    // AM: Conserva el servicio para reactivacion operativa; se usa activo, no borrado logico duro.
    await client.query(
      `
        UPDATE public.servicios
        SET
          activo = FALSE,
          deleted_at = NULL,
          updated_at = NOW()
        WHERE id_servicio = $1::uuid
      `,
      [idServicio]
    );
  }
}

async function activateServiceByBranch(client, idServicio, idSucursal, precioHnl = null) {
  await client.query(
    `
      UPDATE public.servicios
      SET
        activo = TRUE,
        deleted_at = NULL,
        updated_at = NOW()
      WHERE id_servicio = $1::uuid
    `,
    [idServicio]
  );

  if (precioHnl != null) {
    await upsertServiceTariff(client, idServicio, idSucursal, Number(precioHnl));
    return;
  }

  const latestAnyTariffResult = await client.query(GET_LATEST_ANY_SERVICE_TARIFF_SQL, [idServicio, idSucursal]);
  const latestAnyTariff = latestAnyTariffResult.rows[0];

  if (!latestAnyTariff) {
    throw new AppError(400, "No existe una tarifa previa para reactivar. Debes enviar precio_hnl.", {
      code: "CATALOG_SERVICE_PRICE_REQUIRED",
    });
  }

  await client.query(
    `
      UPDATE public.servicios_tarifas
      SET
        activo = TRUE,
        deleted_at = NULL,
        vigente_hasta = NULL,
        updated_at = NOW()
      WHERE id_tarifa = $1::uuid
    `,
    [latestAnyTariff.id_tarifa]
  );
}

async function replacePackageItems(client, idPaquete, items) {
  await client.query("DELETE FROM public.paquetes_detalles WHERE id_paquete = $1::uuid", [idPaquete]);

  for (const item of items) {
    await client.query(
      `
        INSERT INTO public.paquetes_detalles (id_paquete, id_servicio, cantidad)
        VALUES ($1::uuid, $2::uuid, $3::int)
      `,
      [idPaquete, item.id_servicio, item.cantidad]
    );
  }
}

async function upsertPackageBranchOffer(client, idPaquete, idSucursal, payload = {}) {
  // AM: Mantiene una sola fila operativa por (paquete, sucursal) para precio/estado/visibilidad.
  const currentOfferResult = await client.query(GET_PACKAGE_OFFER_SQL, [idPaquete, idSucursal]);
  const currentOffer = currentOfferResult.rows[0];

  const hasPrecio = payload?.precioHnl !== undefined && payload?.precioHnl !== null;
  const hasActivo = payload?.activo !== undefined && payload?.activo !== null;
  const hasVisiblePublico = payload?.visiblePublico !== undefined && payload?.visiblePublico !== null;

  const precioHnl = hasPrecio
    ? Number(payload.precioHnl)
    : currentOffer?.precio_hnl === undefined || currentOffer?.precio_hnl === null
      ? null
      : Number(currentOffer.precio_hnl);
  const activo = hasActivo ? Boolean(payload.activo) : Boolean(currentOffer?.activo ?? true);
  const visiblePublico = hasVisiblePublico
    ? Boolean(payload.visiblePublico)
    : Boolean(currentOffer?.visible_publico ?? true);

  if (currentOffer?.id_paquete_sucursal) {
    await client.query(
      `
        UPDATE public.paquetes_sucursal
        SET
          precio_hnl = $2::numeric,
          activo = $3::boolean,
          visible_publico = $4::boolean,
          updated_at = NOW()
        WHERE id_paquete_sucursal = $1::uuid
      `,
      [currentOffer.id_paquete_sucursal, precioHnl, activo, visiblePublico]
    );
    return;
  }

  await client.query(
    `
      INSERT INTO public.paquetes_sucursal (
        id_paquete,
        id_sucursal,
        precio_hnl,
        activo,
        visible_publico
      )
      VALUES ($1::uuid, $2::uuid, $3::numeric, $4::boolean, $5::boolean)
    `,
    [idPaquete, idSucursal, precioHnl, activo, visiblePublico]
  );
}

function sendHandledError(reply, request, error, fallbackMessage, fallbackCode) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
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

export default async function adminCatalogRoutes(app) {
  app.get(
    "/servicios",
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
                  servicios: { type: "array", items: serviceResponseSchema },
                },
                required: ["id_sucursal", "servicios"],
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
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null, true);
        const { rows } = await client.query(LIST_SERVICES_SQL, [branchId]);

        return sendOk(reply, {
          id_sucursal: branchId,
          servicios: rows.map(mapAdminServiceRow),
        });
      } catch (error) {
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo consultar el catalogo administrativo de servicios",
          "ADMIN_CATALOG_SERVICES_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/servicios",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        body: serviceBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: serviceResponseSchema,
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
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        const nombreServicio = normalizeRequiredText(request.body.nombre_servicio);
        const descripcion = normalizeOptionalText(request.body.descripcion);
        const duracionMin = Number(request.body.duracion_min);
        const bufferMin = Number(request.body.buffer_min);
        const precioHnl = Number(request.body.precio_hnl);
        const grupoCatalogo = normalizeServiceGroup(request.body.grupo_catalogo, "barberia");
        const visiblePublico = normalizeBoolean(request.body.visible_publico, true);
        const agendable = normalizeBoolean(request.body.agendable, grupoCatalogo === "barberia");
        const ordenVisual = normalizeOrderVisual(request.body.orden_visual, 100);

        await client.query("BEGIN");

        const existingResult = await client.query(GET_SERVICE_BY_NAME_SQL, [nombreServicio]);
        let idServicio = existingResult.rows[0]?.id_servicio;

        if (idServicio) {
          // AM: En multi-sucursal, duracion/buffer se persisten por tarifa de sucursal; no se pisan globalmente aqui.
          await client.query(
            `
              UPDATE public.servicios
              SET
                nombre_servicio = $2,
                descripcion = $3,
                grupo_catalogo = $4,
                visible_publico = $5::boolean,
                agendable = $6::boolean,
                orden_visual = $7::int,
                activo = TRUE,
                deleted_at = NULL,
                updated_at = NOW()
              WHERE id_servicio = $1::uuid
            `,
            [
              idServicio,
              nombreServicio,
              descripcion ?? null,
              grupoCatalogo,
              visiblePublico,
              agendable,
              ordenVisual,
            ]
          );
        } else {
          const insertResult = await client.query(
            `
              INSERT INTO public.servicios (
                nombre_servicio,
                descripcion,
                duracion_min,
                buffer_min,
                grupo_catalogo,
                visible_publico,
                agendable,
                orden_visual,
                activo
              )
              VALUES ($1, $2, $3::int, $4::int, $5, $6::boolean, $7::boolean, $8::int, TRUE)
              RETURNING id_servicio
            `,
            [
              nombreServicio,
              descripcion ?? null,
              duracionMin,
              bufferMin,
              grupoCatalogo,
              visiblePublico,
              agendable,
              ordenVisual,
            ]
          );
          idServicio = insertResult.rows[0].id_servicio;
        }

        await upsertServiceTariff(client, idServicio, branchId, precioHnl, {
          duracionMin,
          bufferMin,
        });

        const finalResult = await client.query(GET_SERVICE_SQL, [idServicio, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminServiceRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo crear el servicio del catalogo",
          "ADMIN_CATALOG_SERVICE_CREATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/servicios/:id",
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
        body: servicePatchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: serviceResponseSchema,
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
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);

        await client.query("BEGIN");

        const currentResult = await client.query(GET_SERVICE_SQL, [request.params.id, branchId]);
        const current = currentResult.rows[0];

        if (!current) {
          throw new AppError(404, "El servicio solicitado no existe", {
            code: "CATALOG_SERVICE_NOT_FOUND",
          });
        }

        const nombreServicio =
          request.body.nombre_servicio !== undefined
            ? normalizeRequiredText(request.body.nombre_servicio)
            : current.nombre_servicio;
        const descripcion =
          request.body.descripcion !== undefined ? normalizeOptionalText(request.body.descripcion) : current.descripcion;
        const duracionMin =
          request.body.duracion_min !== undefined ? Number(request.body.duracion_min) : Number(current.duracion_min);
        const bufferMin =
          request.body.buffer_min !== undefined ? Number(request.body.buffer_min) : Number(current.buffer_min ?? 0);
        const precioHnl =
          request.body.precio_hnl !== undefined
            ? Number(request.body.precio_hnl)
            : current.precio_hnl == null
              ? null
              : Number(current.precio_hnl);
        const grupoCatalogo =
          request.body.grupo_catalogo !== undefined
            ? normalizeServiceGroup(request.body.grupo_catalogo)
            : normalizeServiceGroup(current.grupo_catalogo);
        const visiblePublico =
          request.body.visible_publico !== undefined
            ? normalizeBoolean(request.body.visible_publico)
            : normalizeBoolean(current.visible_publico, true);
        const agendable =
          request.body.agendable !== undefined
            ? normalizeBoolean(request.body.agendable)
            : normalizeBoolean(current.agendable, grupoCatalogo === "barberia");
        const ordenVisual =
          request.body.orden_visual !== undefined
            ? normalizeOrderVisual(request.body.orden_visual)
            : normalizeOrderVisual(current.orden_visual, 100);

        await ensureUniqueServiceName(client, request.params.id, nombreServicio);

        await client.query(
          `
            UPDATE public.servicios
            SET
              nombre_servicio = $2,
              descripcion = $3,
              grupo_catalogo = $4,
              visible_publico = $5::boolean,
              agendable = $6::boolean,
              orden_visual = $7::int,
              activo = TRUE,
              deleted_at = NULL,
              updated_at = NOW()
            WHERE id_servicio = $1::uuid
          `,
          [
            request.params.id,
            nombreServicio,
            descripcion ?? null,
            grupoCatalogo,
            visiblePublico,
            agendable,
            ordenVisual,
          ]
        );

        if (precioHnl !== null || request.body.duracion_min !== undefined || request.body.buffer_min !== undefined) {
          if (precioHnl === null) {
            throw new AppError(400, "No existe una tarifa previa en la sucursal para guardar la duracion y buffer", {
              code: "CATALOG_SERVICE_PRICE_REQUIRED",
            });
          }

          // AM: Guarda precio + tiempos operativos en el alcance de sucursal.
          await upsertServiceTariff(client, request.params.id, branchId, precioHnl, {
            duracionMin,
            bufferMin,
          });
        }

        const finalResult = await client.query(GET_SERVICE_SQL, [request.params.id, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminServiceRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el servicio del catalogo",
          "ADMIN_CATALOG_SERVICE_UPDATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/servicios/:id/estado",
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
        body: serviceStateBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: serviceResponseSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        const requestedState = Boolean(request.body?.activo);
        const precioHnl =
          request.body?.precio_hnl === undefined || request.body?.precio_hnl === null
            ? null
            : Number(request.body.precio_hnl);

        await client.query("BEGIN");

        const baseResult = await client.query(GET_SERVICE_BASE_SQL, [request.params.id]);
        const baseService = baseResult.rows[0];
        if (!baseService) {
          throw new AppError(404, "El servicio solicitado no existe", {
            code: "CATALOG_SERVICE_NOT_FOUND",
          });
        }

        if (requestedState) {
          await activateServiceByBranch(client, request.params.id, branchId, precioHnl);
        } else {
          await inactivateServiceByBranch(client, request.params.id, branchId);
        }

        const finalResult = await client.query(GET_SERVICE_SQL, [request.params.id, branchId]);
        if (!finalResult.rows[0]) {
          throw new AppError(404, "No se pudo obtener el servicio actualizado para la sucursal indicada", {
            code: "CATALOG_SERVICE_NOT_FOUND",
          });
        }
        await client.query("COMMIT");

        return sendOk(reply, mapAdminServiceRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el estado del servicio del catalogo",
          "ADMIN_CATALOG_SERVICE_STATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/paquetes/:id/estado",
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
        body: packageStateBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: packageResponseSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        await client.query("BEGIN");

        const baseResult = await client.query(GET_PACKAGE_BASE_SQL, [request.params.id]);
        const basePackage = baseResult.rows[0];
        if (!basePackage) {
          throw new AppError(404, "El paquete solicitado no existe", {
            code: "CATALOG_PACKAGE_NOT_FOUND",
          });
        }

        const nextActivo = Boolean(request.body.activo);
        if (nextActivo) {
          // AM: Solo se reactiva una oferta de sucursal si su composicion sigue disponible en esa sucursal.
          const currentItems = normalizePackageItems(basePackage.items || []);
          await ensurePackageItemsAccessible(client, request.claims, currentItems, branchId);
        }

        await upsertPackageBranchOffer(client, request.params.id, branchId, {
          activo: nextActivo,
        });

        // AM: Conserva el paquete base operativo; el estado comercial se controla por sucursal.
        await client.query(
          `
            UPDATE public.paquetes
            SET
              activo = TRUE,
              deleted_at = NULL,
              updated_at = NOW()
            WHERE id_paquete = $1::uuid
          `,
          [request.params.id]
        );

        const finalResult = await client.query(GET_PACKAGE_SCOPED_SQL, [request.params.id, branchId]);
        if (!finalResult.rows[0]) {
          throw new AppError(404, "No se pudo obtener la oferta del paquete para la sucursal indicada", {
            code: "CATALOG_PACKAGE_SCOPE_NOT_FOUND",
          });
        }
        await client.query("COMMIT");

        return sendOk(reply, mapAdminPackageRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el estado del paquete del catalogo",
          "ADMIN_CATALOG_PACKAGE_STATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.delete(
    "/servicios/:id",
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
        querystring: queryBranchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_servicio: { type: "string", format: "uuid" },
                  id_sucursal: { type: "string", format: "uuid" },
                  inactivated: { type: "boolean" },
                },
                required: ["id_servicio", "id_sucursal", "inactivated"],
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
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null);

        await client.query("BEGIN");

        const currentResult = await client.query(GET_SERVICE_SQL, [request.params.id, branchId]);
        if (!currentResult.rows[0]) {
          throw new AppError(404, "El servicio solicitado no existe", {
            code: "CATALOG_SERVICE_NOT_FOUND",
          });
        }

        await inactivateServiceByBranch(client, request.params.id, branchId);

        await client.query("COMMIT");

        return sendOk(reply, {
          id_servicio: request.params.id,
          id_sucursal: branchId,
          inactivated: true,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo inactivar el servicio del catalogo",
          "ADMIN_CATALOG_SERVICE_DELETE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/paquetes",
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
                  paquetes: { type: "array", items: packageResponseSchema },
                },
                required: ["id_sucursal", "paquetes"],
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
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null, true);
        const { rows } = await client.query(LIST_PACKAGES_SQL, [branchId]);
        return sendOk(reply, {
          id_sucursal: branchId,
          paquetes: rows.map(mapAdminPackageRow),
        });
      } catch (error) {
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo consultar el catalogo administrativo de paquetes",
          "ADMIN_CATALOG_PACKAGES_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/paquetes",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        body: packageBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: packageResponseSchema,
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
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        const nombrePaquete = normalizeRequiredText(request.body.nombre_paquete);
        const descripcion = normalizeOptionalText(request.body.descripcion);
        const precioHnl = Number(request.body.precio_hnl);
        const visiblePublico = normalizeBoolean(request.body.visible_publico, true);
        const items = normalizePackageItems(request.body.items);

        await ensureUniquePackageName(client, null, nombrePaquete);
        await ensurePackageItemsAccessible(client, request.claims, items, branchId);

        await client.query("BEGIN");

        const insertResult = await client.query(
          `
            INSERT INTO public.paquetes (
              nombre_paquete,
              descripcion,
              precio_hnl,
              activo
            )
            VALUES ($1, $2, $3::numeric, TRUE)
            RETURNING id_paquete
          `,
          [nombrePaquete, descripcion ?? null, precioHnl]
        );

        const idPaquete = insertResult.rows[0].id_paquete;
        await replacePackageItems(client, idPaquete, items);
        // AM: Crea oferta operativa del paquete en la sucursal seleccionada.
        await upsertPackageBranchOffer(client, idPaquete, branchId, {
          precioHnl,
          activo: true,
          visiblePublico,
        });

        const finalResult = await client.query(GET_PACKAGE_SCOPED_SQL, [idPaquete, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminPackageRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo crear el paquete del catalogo",
          "ADMIN_CATALOG_PACKAGE_CREATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/paquetes/:id",
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
        body: packagePatchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: packageResponseSchema,
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
        const branchId = await resolveBranchId(client, request.claims, request.body?.id_sucursal ?? null);
        await client.query("BEGIN");

        const baseResult = await client.query(GET_PACKAGE_BASE_SQL, [request.params.id]);
        const basePackage = baseResult.rows[0];
        const scopedResult = await client.query(GET_PACKAGE_SCOPED_SQL, [request.params.id, branchId]);
        const scopedPackage = scopedResult.rows[0] ?? null;

        if (!basePackage) {
          throw new AppError(404, "El paquete solicitado no existe", {
            code: "CATALOG_PACKAGE_NOT_FOUND",
          });
        }

        const nombrePaquete =
          request.body.nombre_paquete !== undefined
            ? normalizeRequiredText(request.body.nombre_paquete)
            : basePackage.nombre_paquete;
        const descripcion =
          request.body.descripcion !== undefined ? normalizeOptionalText(request.body.descripcion) : basePackage.descripcion;
        const precioHnl =
          request.body.precio_hnl !== undefined
            ? Number(request.body.precio_hnl)
            : scopedPackage?.precio_hnl == null
              ? basePackage.precio_hnl == null
                ? 0
                : Number(basePackage.precio_hnl)
              : Number(scopedPackage.precio_hnl);
        const visiblePublico =
          request.body.visible_publico !== undefined
            ? normalizeBoolean(request.body.visible_publico)
            : normalizeBoolean(scopedPackage?.visible_publico, true);
        const nextActivo = normalizeBoolean(scopedPackage?.activo, true);
        const nextItems = request.body.items !== undefined ? normalizePackageItems(request.body.items) : null;

        await ensureUniquePackageName(client, request.params.id, nombrePaquete);

        if (nextItems) {
          await ensurePackageItemsAccessible(client, request.claims, nextItems, branchId);
        }

        await client.query(
          `
            UPDATE public.paquetes
            SET
              nombre_paquete = $2,
              descripcion = $3,
              precio_hnl = $4::numeric,
              activo = TRUE,
              deleted_at = NULL,
              updated_at = NOW()
            WHERE id_paquete = $1::uuid
          `,
          [request.params.id, nombrePaquete, descripcion ?? null, precioHnl]
        );

        if (nextItems) {
          await replacePackageItems(client, request.params.id, nextItems);
        }

        // AM: Mantiene precio/estado/visibilidad por sucursal sin duplicar paquetes globales.
        await upsertPackageBranchOffer(client, request.params.id, branchId, {
          precioHnl,
          activo: nextActivo,
          visiblePublico,
        });

        const finalResult = await client.query(GET_PACKAGE_SCOPED_SQL, [request.params.id, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminPackageRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el paquete del catalogo",
          "ADMIN_CATALOG_PACKAGE_UPDATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );

  app.delete(
    "/paquetes/:id",
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
        querystring: queryBranchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_paquete: { type: "string", format: "uuid" },
                  id_sucursal: { type: "string", format: "uuid" },
                  inactivated: { type: "boolean" },
                },
                required: ["id_paquete", "id_sucursal", "inactivated"],
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
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();

      try {
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null);
        await client.query("BEGIN");

        const baseResult = await client.query(GET_PACKAGE_BASE_SQL, [request.params.id]);
        if (!baseResult.rows[0]) {
          throw new AppError(404, "El paquete solicitado no existe", {
            code: "CATALOG_PACKAGE_NOT_FOUND",
          });
        }

        // AM: Delete legacy se mantiene como inactivacion por sucursal para no afectar otras sedes.
        await upsertPackageBranchOffer(client, request.params.id, branchId, {
          activo: false,
        });

        await client.query("COMMIT");

        return sendOk(reply, {
          id_paquete: request.params.id,
          id_sucursal: branchId,
          inactivated: true,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo inactivar el paquete del catalogo",
          "ADMIN_CATALOG_PACKAGE_DELETE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );
}
