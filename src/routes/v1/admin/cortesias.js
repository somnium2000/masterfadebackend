import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
const requestIdSchema = { type: "string" };
const MAX_NOMBRE_LENGTH = 140;
const MAX_DESCRIPCION_LENGTH = 500;
const CORTESIA_NAME_DUPLICATE_MESSAGE = "Ya existe una cortesía con ese nombre. Usa la cortesía existente o cambia el nombre.";

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

const querySchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    buscar: { type: "string", minLength: 1, maxLength: 140 },
  },
  additionalProperties: false,
};

const cortesiaSucursalBodySchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    activa: { type: "boolean" },
  },
  required: ["id_sucursal"],
  additionalProperties: false,
};

const cortesiaBodySchema = {
  type: "object",
  properties: {
    nombre: { type: "string", minLength: 1, maxLength: MAX_NOMBRE_LENGTH },
    descripcion: { type: ["string", "null"], maxLength: MAX_DESCRIPCION_LENGTH },
    sucursales: {
      type: "array",
      minItems: 1,
      items: cortesiaSucursalBodySchema,
    },
  },
  required: ["nombre", "sucursales"],
  additionalProperties: false,
};

const cortesiaPatchSchema = {
  type: "object",
  properties: {
    nombre: { type: "string", minLength: 1, maxLength: MAX_NOMBRE_LENGTH },
    descripcion: { type: ["string", "null"], maxLength: MAX_DESCRIPCION_LENGTH },
    sucursales: {
      type: "array",
      minItems: 1,
      items: cortesiaSucursalBodySchema,
    },
  },
  minProperties: 1,
  additionalProperties: false,
};

const cortesiaEstadoSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    activa: { type: "boolean" },
  },
  required: ["id_sucursal", "activa"],
  additionalProperties: false,
};

const cortesiaSucursalResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string" },
    activa: { type: "boolean" },
    created_at: { type: ["string", "null"] },
    updated_at: { type: ["string", "null"] },
  },
  required: ["id", "id_sucursal", "nombre_sucursal", "activa", "created_at", "updated_at"],
  additionalProperties: false,
};

const cortesiaResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    nombre: { type: "string" },
    descripcion: { type: ["string", "null"] },
    sucursales: { type: "array", items: cortesiaSucursalResponseSchema },
    created_at: { type: ["string", "null"] },
    updated_at: { type: ["string", "null"] },
  },
  required: ["id", "nombre", "descripcion", "sucursales", "created_at", "updated_at"],
  additionalProperties: false,
};

const LIST_CORTESIAS_SQL = `
  SELECT
    c.id,
    c.nombre,
    c.descripcion,
    c.created_at,
    c.updated_at,
    COALESCE(
      json_agg(
        json_build_object(
          'id', cs.id,
          'id_sucursal', cs.id_sucursal,
          'nombre_sucursal', s.nombre_sucursal,
          'activa', cs.activa,
          'created_at', cs.created_at,
          'updated_at', cs.updated_at
        )
        ORDER BY s.nombre_sucursal ASC
      ) FILTER (
        WHERE cs.id IS NOT NULL
          AND ($1::uuid IS NULL OR cs.id_sucursal = $1::uuid)
      ),
      '[]'::json
    ) AS sucursales
  FROM public.cortesias c
  JOIN public.cortesias_sucursales cs
    ON cs.cortesia_id = c.id
  JOIN public.sucursales s
    ON s.id_sucursal = cs.id_sucursal
   AND s.deleted_at IS NULL
   AND s.estado IS TRUE
  WHERE (
      $1::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.cortesias_sucursales csf
        WHERE csf.cortesia_id = c.id
          AND csf.id_sucursal = $1::uuid
      )
    )
    AND (
      $2::text IS NULL
      OR c.nombre ILIKE $2::text
      OR COALESCE(c.descripcion, '') ILIKE $2::text
    )
  GROUP BY c.id
  ORDER BY c.nombre ASC, c.created_at DESC
`;

const GET_CORTESIA_SQL = `
  SELECT
    c.id,
    c.nombre,
    c.descripcion,
    c.created_at,
    c.updated_at,
    COALESCE(
      json_agg(
        json_build_object(
          'id', cs.id,
          'id_sucursal', cs.id_sucursal,
          'nombre_sucursal', s.nombre_sucursal,
          'activa', cs.activa,
          'created_at', cs.created_at,
          'updated_at', cs.updated_at
        )
        ORDER BY s.nombre_sucursal ASC
      ) FILTER (
        WHERE cs.id IS NOT NULL
          AND ($2::uuid IS NULL OR cs.id_sucursal = $2::uuid)
      ),
      '[]'::json
    ) AS sucursales
  FROM public.cortesias c
  JOIN public.cortesias_sucursales cs
    ON cs.cortesia_id = c.id
  JOIN public.sucursales s
    ON s.id_sucursal = cs.id_sucursal
   AND s.deleted_at IS NULL
   AND s.estado IS TRUE
  WHERE c.id = $1::uuid
    AND (
      $2::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.cortesias_sucursales csf
        WHERE csf.cortesia_id = c.id
          AND csf.id_sucursal = $2::uuid
      )
    )
  GROUP BY c.id
`;

const GET_CORTESIA_BASE_SQL = `
  SELECT id, nombre, descripcion, created_at, updated_at
  FROM public.cortesias
  WHERE id = $1::uuid
  LIMIT 1
`;

function normalizeRequiredText(value, fieldName) {
  const normalized = String(value || "").normalize("NFC").trim();
  if (!normalized) {
    throw new AppError(400, `${fieldName} es obligatorio`, {
      code: "CORTESIAS_REQUIRED_FIELD",
      details: { field: fieldName },
    });
  }
  return normalized;
}

function normalizeOptionalText(value, maxLength = MAX_DESCRIPCION_LENGTH) {
  if (value === undefined) return undefined;
  const normalized = String(value ?? "").normalize("NFC").trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new AppError(400, `descripcion excede la longitud permitida (${maxLength})`, {
      code: "CORTESIAS_DESCRIPTION_TOO_LONG",
    });
  }
  return normalized;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function normalizeBuscar(value) {
  const normalized = String(value || "").normalize("NFC").trim();
  if (!normalized) return null;
  return `%${normalized}%`;
}

function mapCortesiaRow(row) {
  const sucursales = Array.isArray(row.sucursales)
    ? row.sucursales.map((item) => ({
      id: item.id,
      id_sucursal: item.id_sucursal,
      nombre_sucursal: item.nombre_sucursal,
      activa: Boolean(item.activa),
      created_at: item.created_at ?? null,
      updated_at: item.updated_at ?? null,
    }))
    : [];

  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    sucursales,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
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
      throw new AppError(400, "El usuario autenticado no tiene una sucursal asociada para gestionar cortesias", {
        code: "CATALOG_BRANCH_REQUIRED",
      });
    }

    throw new AppError(400, "Debes indicar id_sucursal cuando tu acceso cubre multiples sucursales", {
      code: "CATALOG_BRANCH_REQUIRED",
    });
  }

  if (allowAllForSuperAdmin) return null;

  const { rows } = await client.query(
    `
      SELECT s.id_sucursal
      FROM public.sucursales s
      WHERE s.deleted_at IS NULL
        AND s.estado IS TRUE
      ORDER BY s.nombre_sucursal ASC
      LIMIT 2
    `
  );

  if (rows.length === 1) {
    return rows[0].id_sucursal;
  }

  throw new AppError(400, "Debes indicar id_sucursal para operar cortesias cuando existen multiples sucursales activas", {
    code: "CATALOG_BRANCH_REQUIRED",
  });
}

async function normalizePayloadSucursales(client, claims, payloadSucursales) {
  if (!Array.isArray(payloadSucursales) || payloadSucursales.length === 0) {
    throw new AppError(400, "Debes indicar al menos una sucursal", {
      code: "CORTESIAS_BRANCHES_REQUIRED",
    });
  }

  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");
  const claimBranchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.filter(Boolean) : [];

  const normalized = payloadSucursales.map((item) => {
    const idSucursal = String(item?.id_sucursal || "").trim();
    if (!idSucursal) {
      throw new AppError(400, "Cada sucursal debe incluir id_sucursal", {
        code: "CORTESIAS_BRANCH_ID_REQUIRED",
      });
    }

    return {
      id_sucursal: idSucursal,
      activa: normalizeBoolean(item?.activa, true),
    };
  });

  const dedup = new Map();
  for (const item of normalized) {
    if (dedup.has(item.id_sucursal)) {
      throw new AppError(400, "No se permiten sucursales duplicadas en la misma cortesia", {
        code: "CORTESIAS_BRANCH_DUPLICATE",
        details: { id_sucursal: item.id_sucursal },
      });
    }
    dedup.set(item.id_sucursal, item);
  }

  const branchIds = [...dedup.keys()];

  if (!isSuperAdmin) {
    const forbidden = branchIds.find((branchId) => !claimBranchIds.includes(branchId));
    if (forbidden) {
      throw new AppError(403, "La sucursal solicitada no pertenece al alcance del usuario autenticado", {
        code: "AUTH_FORBIDDEN_BRANCH",
        details: { id_sucursal: forbidden },
      });
    }
  }

  const { rows } = await client.query(
    `
      SELECT s.id_sucursal
      FROM public.sucursales s
      WHERE s.id_sucursal = ANY($1::uuid[])
        AND s.deleted_at IS NULL
        AND s.estado IS TRUE
    `,
    [branchIds]
  );

  const validSet = new Set(rows.map((row) => row.id_sucursal));
  const invalid = branchIds.filter((branchId) => !validSet.has(branchId));
  if (invalid.length > 0) {
    throw new AppError(404, "Una o mas sucursales no existen o no estan activas", {
      code: "CATALOG_BRANCH_NOT_FOUND",
      details: { sucursales_invalidas: invalid },
    });
  }

  return branchIds.map((idSucursal) => dedup.get(idSucursal));
}

function createCourtesyNameDuplicateError() {
  return new AppError(409, CORTESIA_NAME_DUPLICATE_MESSAGE, {
    code: "CORTESIA_NAME_DUPLICATE",
  });
}

async function ensureUniqueCourtesyNameGlobal(client, cortesiaId, nombre) {
  const { rowCount } = await client.query(
    `
      SELECT 1
      FROM public.cortesias c
      WHERE LOWER(regexp_replace(TRIM(c.nombre), '[^[:alnum:]]+', '', 'g')) =
            LOWER(regexp_replace(TRIM($1::text), '[^[:alnum:]]+', '', 'g'))
        AND ($2::uuid IS NULL OR c.id <> $2::uuid)
      LIMIT 1
    `,
    [nombre, cortesiaId]
  );

  if (rowCount) {
    throw createCourtesyNameDuplicateError();
  }
}

async function syncCourtesyBranches(client, cortesiaId, sucursales) {
  const branchIds = sucursales.map((sucursal) => sucursal.id_sucursal);

  for (const sucursal of sucursales) {
    // AM: Mantiene la relacion por sucursal sin borrado fisico.
    await client.query(
      `
        INSERT INTO public.cortesias_sucursales (
          cortesia_id,
          id_sucursal,
          activa,
          updated_at
        )
        VALUES ($1::uuid, $2::uuid, $3::boolean, NOW())
        ON CONFLICT (cortesia_id, id_sucursal)
        DO UPDATE SET
          activa = EXCLUDED.activa,
          updated_at = NOW()
      `,
      [cortesiaId, sucursal.id_sucursal, sucursal.activa]
    );
  }

  await client.query(
    `
      UPDATE public.cortesias_sucursales
      SET
        activa = FALSE,
        updated_at = NOW()
      WHERE cortesia_id = $1::uuid
        AND NOT (id_sucursal = ANY($2::uuid[]))
    `,
    [cortesiaId, branchIds]
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

  if (error?.code === "23505" && error?.constraint === "uq_cortesias_nombre_normalizado_global") {
    return sendError(reply, 409, CORTESIA_NAME_DUPLICATE_MESSAGE, {
      code: "CORTESIA_NAME_DUPLICATE",
      details: error.detail || error.message,
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

export default async function adminCortesiasRoutes(app) {
  app.get(
    "/",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: querySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_sucursal: { type: ["string", "null"], format: "uuid" },
                  cortesias: { type: "array", items: cortesiaResponseSchema },
                },
                required: ["id_sucursal", "cortesias"],
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
        const branchId = await resolveBranchId(client, request.claims, request.query?.id_sucursal ?? null, true);
        const buscar = normalizeBuscar(request.query?.buscar);
        const { rows } = await client.query(LIST_CORTESIAS_SQL, [branchId, buscar]);

        return sendOk(reply, {
          id_sucursal: branchId,
          cortesias: rows.map(mapCortesiaRow),
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo consultar el catalogo administrativo de cortesias",
          "ADMIN_CORTESIAS_LIST_ERROR"
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
        body: cortesiaBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: cortesiaResponseSchema,
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
        const nombre = normalizeRequiredText(request.body?.nombre, "nombre");
        const descripcion = normalizeOptionalText(request.body?.descripcion);
        const sucursales = await normalizePayloadSucursales(client, request.claims, request.body?.sucursales);
        await ensureUniqueCourtesyNameGlobal(client, null, nombre);

        await client.query("BEGIN");

        const insertResult = await client.query(
          `
            INSERT INTO public.cortesias (nombre, descripcion)
            VALUES ($1::text, $2::text)
            RETURNING id
          `,
          [nombre, descripcion ?? null]
        );

        const cortesiaId = insertResult.rows[0].id;
        await syncCourtesyBranches(client, cortesiaId, sucursales);

        const finalResult = await client.query(GET_CORTESIA_SQL, [cortesiaId, null]);
        await client.query("COMMIT");

        return sendOk(reply, mapCortesiaRow(finalResult.rows[0]), {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo crear la cortesia",
          "ADMIN_CORTESIAS_CREATE_ERROR"
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
        body: cortesiaPatchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: cortesiaResponseSchema,
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
        await client.query("BEGIN");

        const currentResult = await client.query(GET_CORTESIA_BASE_SQL, [request.params.id]);
        const current = currentResult.rows[0];
        if (!current) {
          throw new AppError(404, "La cortesia solicitada no existe", {
            code: "CORTESIAS_NOT_FOUND",
          });
        }

        const nextNombre =
          request.body?.nombre !== undefined
            ? normalizeRequiredText(request.body.nombre, "nombre")
            : normalizeRequiredText(current.nombre, "nombre");
        const nextDescripcion =
          request.body?.descripcion !== undefined
            ? normalizeOptionalText(request.body.descripcion)
            : current.descripcion;

        let nextSucursales = null;
        if (request.body?.sucursales !== undefined) {
          nextSucursales = await normalizePayloadSucursales(client, request.claims, request.body.sucursales);
        }

        await ensureUniqueCourtesyNameGlobal(client, request.params.id, nextNombre);

        await client.query(
          `
            UPDATE public.cortesias
            SET
              nombre = $2::text,
              descripcion = $3::text,
              updated_at = NOW()
            WHERE id = $1::uuid
          `,
          [request.params.id, nextNombre, nextDescripcion ?? null]
        );

        if (nextSucursales) {
          await syncCourtesyBranches(client, request.params.id, nextSucursales);
        }

        const finalResult = await client.query(GET_CORTESIA_SQL, [request.params.id, null]);
        await client.query("COMMIT");

        return sendOk(reply, mapCortesiaRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar la cortesia",
          "ADMIN_CORTESIAS_UPDATE_ERROR"
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
        body: cortesiaEstadoSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: cortesiaResponseSchema,
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
        const nextActiva = Boolean(request.body?.activa);

        await client.query("BEGIN");

        const baseResult = await client.query(GET_CORTESIA_BASE_SQL, [request.params.id]);
        if (!baseResult.rows[0]) {
          throw new AppError(404, "La cortesia solicitada no existe", {
            code: "CORTESIAS_NOT_FOUND",
          });
        }

        const updateResult = await client.query(
          `
            UPDATE public.cortesias_sucursales
            SET
              activa = $3::boolean,
              updated_at = NOW()
            WHERE cortesia_id = $1::uuid
              AND id_sucursal = $2::uuid
            RETURNING id
          `,
          [request.params.id, branchId, nextActiva]
        );

        if (!updateResult.rowCount) {
          throw new AppError(404, "La cortesia no esta asociada a la sucursal indicada", {
            code: "CORTESIAS_SCOPE_NOT_FOUND",
          });
        }

        const finalResult = await client.query(GET_CORTESIA_SQL, [request.params.id, null]);
        await client.query("COMMIT");

        return sendOk(reply, mapCortesiaRow(finalResult.rows[0]), { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        return sendHandledError(
          reply,
          request,
          error,
          "No se pudo actualizar el estado de la cortesia",
          "ADMIN_CORTESIAS_STATE_ERROR"
        );
      } finally {
        client.release();
      }
    }
  );
}

