import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { deriveServiceCatalogGroup, isBarberBookable } from "../../../utils/catalogMetadata.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
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

const serviceBodySchema = {
  type: "object",
  properties: {
    nombre_servicio: { type: "string", minLength: 1, maxLength: 140 },
    descripcion: { type: ["string", "null"], maxLength: 500 },
    duracion_min: { type: "integer", minimum: 1 },
    buffer_min: { type: "integer", minimum: 0 },
    precio_hnl: { type: "number", minimum: 0 },
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
    grupo_catalogo: { type: "string", enum: ["barberia", "otros"] },
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
    "agendable_barbero",
  ],
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
    activo: { type: "boolean" },
    items: { type: "array", items: packageItemResponseSchema },
  },
  required: ["id_paquete", "nombre_paquete", "descripcion", "precio_hnl", "activo", "items"],
  additionalProperties: false,
};

const LIST_SERVICES_SQL = `
  WITH scoped_tariffs AS (
    SELECT
      st.*,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio
        ORDER BY st.activo DESC, st.vigente_hasta IS NULL DESC, st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    WHERE st.id_sucursal = $1::uuid
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    s.duracion_min,
    s.buffer_min,
    s.activo,
    st.id_sucursal,
    st.precio_hnl,
    COALESCE(st.activo, FALSE) AS tarifa_activa
  FROM public.servicios s
  LEFT JOIN scoped_tariffs st
    ON st.id_servicio = s.id_servicio
   AND st.rn = 1
  WHERE s.deleted_at IS NULL
  ORDER BY s.nombre_servicio ASC
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
    WHERE st.id_sucursal = $2::uuid
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    s.duracion_min,
    s.buffer_min,
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
    s.activo
  FROM public.servicios s
  WHERE UPPER(TRIM(s.nombre_servicio)) = UPPER(TRIM($1))
    AND s.deleted_at IS NULL
  LIMIT 1
`;

const GET_LATEST_SERVICE_TARIFF_SQL = `
  SELECT
    st.id_tarifa,
    st.precio_hnl,
    st.activo
  FROM public.servicios_tarifas st
  WHERE st.id_servicio = $1::uuid
    AND st.id_sucursal = $2::uuid
    AND st.id_empleado IS NULL
    AND st.deleted_at IS NULL
  ORDER BY st.activo DESC, st.vigente_hasta IS NULL DESC, st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
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

const PACKAGE_COLUMN_SQL = `
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'paquetes'
    AND column_name = 'precio_hnl'
`;

const LIST_PACKAGES_SQL = `
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
  WHERE p.deleted_at IS NULL
  GROUP BY p.id_paquete
  ORDER BY p.nombre_paquete ASC
`;

const GET_PACKAGE_SQL = `
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

function mapAdminServiceRow(row) {
  const grupoCatalogo = deriveServiceCatalogGroup(row.nombre_servicio);

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
    agendable_barbero: isBarberBookable(row.nombre_servicio),
  };
}

function mapAdminPackageRow(row) {
  return {
    id_paquete: row.id_paquete,
    nombre_paquete: row.nombre_paquete,
    descripcion: row.descripcion ?? null,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    activo: Boolean(row.activo),
    items: Array.isArray(row.items)
      ? row.items.map((item) => ({
          id_servicio: item.id_servicio,
          nombre_servicio: item.nombre_servicio,
          cantidad: Number(item.cantidad ?? 1),
        }))
      : [],
  };
}

async function resolveBranchId(client, claims, requestedBranchId) {
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

  const { rows } = await client.query(ACTIVE_BRANCHES_SQL);

  if (rows.length === 1) {
    return rows[0].id_sucursal;
  }

  throw new AppError(400, "Debes indicar id_sucursal para operar el catalogo cuando existen multiples sucursales activas", {
    code: "CATALOG_BRANCH_REQUIRED",
  });
}

async function ensurePackagePriceColumn(client) {
  const { rowCount } = await client.query(PACKAGE_COLUMN_SQL);

  if (!rowCount) {
    throw new AppError(500, "El schema actual no tiene public.paquetes.precio_hnl. Ejecuta el patch de Fase 2.", {
      code: "CATALOG_PACKAGE_PRICE_COLUMN_MISSING",
    });
  }
}

async function ensureUniqueServiceName(client, serviceId, nombreServicio) {
  const { rows } = await client.query(
    `
      SELECT id_servicio
      FROM public.servicios
      WHERE UPPER(TRIM(nombre_servicio)) = UPPER(TRIM($1))
        AND deleted_at IS NULL
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

async function ensurePackageItemsAccessible(client, claims, items) {
  const uniqueServiceIds = [...new Set(items.map((item) => item.id_servicio))];
  const claimBranchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.filter(Boolean) : [];
  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");
  const scopedBranchIds = isSuperAdmin ? null : claimBranchIds;

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

  if (!isSuperAdmin && rows.some((row) => !row.has_scoped_tariff)) {
    throw new AppError(403, "Uno o mas servicios del paquete no estan tarifados dentro del alcance del administrador", {
      code: "AUTH_FORBIDDEN_BRANCH",
    });
  }
}

async function upsertServiceTariff(client, idServicio, idSucursal, precioHnl) {
  const { rows } = await client.query(GET_LATEST_SERVICE_TARIFF_SQL, [idServicio, idSucursal]);
  const currentTariff = rows[0];

  if (currentTariff) {
    await client.query(
      `
        UPDATE public.servicios_tarifas
        SET
          precio_hnl = $2::numeric,
          activo = TRUE,
          vigente_hasta = NULL,
          deleted_at = NULL,
          updated_at = NOW()
        WHERE id_tarifa = $1::uuid
      `,
      [currentTariff.id_tarifa, precioHnl]
    );
    return;
  }

  await client.query(
    `
      INSERT INTO public.servicios_tarifas (
        id_servicio,
        id_sucursal,
        id_empleado,
        precio_hnl,
        vigente_desde,
        activo
      )
      VALUES ($1::uuid, $2::uuid, NULL, $3::numeric, CURRENT_DATE, TRUE)
    `,
    [idServicio, idSucursal, precioHnl]
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
                  id_sucursal: { type: "string", format: "uuid" },
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
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null);
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

        await client.query("BEGIN");

        const existingResult = await client.query(GET_SERVICE_BY_NAME_SQL, [nombreServicio]);
        let idServicio = existingResult.rows[0]?.id_servicio;

        if (idServicio) {
          await client.query(
            `
              UPDATE public.servicios
              SET
                nombre_servicio = $2,
                descripcion = $3,
                duracion_min = $4::int,
                buffer_min = $5::int,
                activo = TRUE,
                deleted_at = NULL,
                updated_at = NOW()
              WHERE id_servicio = $1::uuid
            `,
            [idServicio, nombreServicio, descripcion ?? null, duracionMin, bufferMin]
          );
        } else {
          const insertResult = await client.query(
            `
              INSERT INTO public.servicios (
                nombre_servicio,
                descripcion,
                duracion_min,
                buffer_min,
                activo
              )
              VALUES ($1, $2, $3::int, $4::int, TRUE)
              RETURNING id_servicio
            `,
            [nombreServicio, descripcion ?? null, duracionMin, bufferMin]
          );
          idServicio = insertResult.rows[0].id_servicio;
        }

        await upsertServiceTariff(client, idServicio, branchId, precioHnl);

        const finalResult = await client.query(GET_SERVICE_SQL, [idServicio, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminServiceRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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

        await ensureUniqueServiceName(client, request.params.id, nombreServicio);

        await client.query(
          `
            UPDATE public.servicios
            SET
              nombre_servicio = $2,
              descripcion = $3,
              duracion_min = $4::int,
              buffer_min = $5::int,
              activo = TRUE,
              deleted_at = NULL,
              updated_at = NOW()
            WHERE id_servicio = $1::uuid
          `,
          [request.params.id, nombreServicio, descripcion ?? null, duracionMin, bufferMin]
        );

        if (precioHnl !== null) {
          await upsertServiceTariff(client, request.params.id, branchId, precioHnl);
        }

        const finalResult = await client.query(GET_SERVICE_SQL, [request.params.id, branchId]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminServiceRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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
          [request.params.id, branchId]
        );

        if (!tariffUpdate.rowCount) {
          throw new AppError(404, "No existe una tarifa activa para este servicio dentro de la sucursal indicada", {
            code: "CATALOG_SERVICE_SCOPE_NOT_FOUND",
          });
        }

        const remainingResult = await client.query(ACTIVE_SERVICE_TARIFFS_COUNT_SQL, [request.params.id]);
        const activeTariffsRemaining = Number(remainingResult.rows[0]?.total ?? 0);

        if (activeTariffsRemaining === 0) {
          await client.query(
            `
              UPDATE public.servicios
              SET
                activo = FALSE,
                deleted_at = COALESCE(deleted_at, NOW()),
                updated_at = NOW()
              WHERE id_servicio = $1::uuid
            `,
            [request.params.id]
          );
        }

        await client.query("COMMIT");

        return sendOk(reply, {
          id_servicio: request.params.id,
          id_sucursal: branchId,
          inactivated: true,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  paquetes: { type: "array", items: packageResponseSchema },
                },
                required: ["paquetes"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { rows } = await app.db.query(LIST_PACKAGES_SQL);
        return sendOk(reply, {
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
        const nombrePaquete = normalizeRequiredText(request.body.nombre_paquete);
        const descripcion = normalizeOptionalText(request.body.descripcion);
        const precioHnl = Number(request.body.precio_hnl);
        const items = request.body.items || [];

        await ensurePackagePriceColumn(client);
        await ensureUniquePackageName(client, null, nombrePaquete);
        await ensurePackageItemsAccessible(client, request.claims, items);

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

        const finalResult = await client.query(GET_PACKAGE_SQL, [idPaquete]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminPackageRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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
        await ensurePackagePriceColumn(client);
        await client.query("BEGIN");

        const currentResult = await client.query(GET_PACKAGE_SQL, [request.params.id]);
        const current = currentResult.rows[0];

        if (!current) {
          throw new AppError(404, "El paquete solicitado no existe", {
            code: "CATALOG_PACKAGE_NOT_FOUND",
          });
        }

        const nombrePaquete =
          request.body.nombre_paquete !== undefined
            ? normalizeRequiredText(request.body.nombre_paquete)
            : current.nombre_paquete;
        const descripcion =
          request.body.descripcion !== undefined ? normalizeOptionalText(request.body.descripcion) : current.descripcion;
        const precioHnl =
          request.body.precio_hnl !== undefined
            ? Number(request.body.precio_hnl)
            : current.precio_hnl == null
              ? 0
              : Number(current.precio_hnl);

        await ensureUniquePackageName(client, request.params.id, nombrePaquete);

        if (request.body.items) {
          await ensurePackageItemsAccessible(client, request.claims, request.body.items);
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

        if (request.body.items) {
          await replacePackageItems(client, request.params.id, request.body.items);
        }

        const finalResult = await client.query(GET_PACKAGE_SQL, [request.params.id]);
        await client.query("COMMIT");

        return sendOk(reply, mapAdminPackageRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_paquete: { type: "string", format: "uuid" },
                  inactivated: { type: "boolean" },
                },
                required: ["id_paquete", "inactivated"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await ensurePackagePriceColumn(app.db);
        const result = await app.db.query(
          `
            UPDATE public.paquetes
            SET
              activo = FALSE,
              deleted_at = COALESCE(deleted_at, NOW()),
              updated_at = NOW()
            WHERE id_paquete = $1::uuid
              AND deleted_at IS NULL
            RETURNING id_paquete
          `,
          [request.params.id]
        );

        if (!result.rowCount) {
          throw new AppError(404, "El paquete solicitado no existe", {
            code: "CATALOG_PACKAGE_NOT_FOUND",
          });
        }

        return sendOk(reply, {
          id_paquete: request.params.id,
          inactivated: true,
        });
      } catch (error) {
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo inactivar el paquete del catalogo",
          "ADMIN_CATALOG_PACKAGE_DELETE_ERROR"
        );
      }
    }
  );
}
