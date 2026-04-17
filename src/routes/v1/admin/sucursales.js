import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const SUPER_ADMIN_ONLY = ["super_admin"];

const NAME_MAX_LENGTH = 140;
const ADDRESS_MAX_LENGTH = 300;
const PHONE_MAX_LENGTH = 30;
const PHONE_ALLOWED_PATTERN = /^[+()\-.\s\d]{6,30}$/;

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const listSucursalesQuerySchema = {
  type: "object",
  properties: {
    solo_activas: { type: "boolean" },
  },
  additionalProperties: false,
};

const sucursalCreateBodySchema = {
  type: "object",
  required: ["id_empresa", "nombre_sucursal"],
  properties: {
    id_empresa: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string", minLength: 1, maxLength: NAME_MAX_LENGTH },
    direccion: { type: ["string", "null"], maxLength: ADDRESS_MAX_LENGTH },
    telefono: { type: ["string", "null"], maxLength: PHONE_MAX_LENGTH },
    fecha_inauguracion: { type: ["string", "null"], format: "date" },
    estado: { type: "boolean" },
  },
  additionalProperties: false,
};

const sucursalPatchBodySchema = {
  type: "object",
  minProperties: 1,
  properties: {
    id_empresa: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string", minLength: 1, maxLength: NAME_MAX_LENGTH },
    direccion: { type: ["string", "null"], maxLength: ADDRESS_MAX_LENGTH },
    telefono: { type: ["string", "null"], maxLength: PHONE_MAX_LENGTH },
    fecha_inauguracion: { type: ["string", "null"], format: "date" },
    estado: { type: "boolean" },
  },
  additionalProperties: false,
};

const SUCURSAL_SELECT_SQL = `
  SELECT
    s.id_sucursal,
    s.id_empresa,
    e.nombre_empresa,
    s.nombre_sucursal,
    s.direccion_texto AS direccion,
    s.telefono_texto AS telefono,
    s.fecha_inauguracion,
    COALESCE(s.estado, TRUE) AS estado
  FROM public.sucursales s
  JOIN public.empresas e
    ON e.id_empresa = s.id_empresa
  WHERE s.deleted_at IS NULL
`;

const LIST_SUCURSALES_SQL = `${SUCURSAL_SELECT_SQL}
  ORDER BY s.nombre_sucursal ASC
`;

const LIST_ACTIVE_SUCURSALES_SQL = `${SUCURSAL_SELECT_SQL}
  AND COALESCE(s.estado, TRUE) IS TRUE
  ORDER BY s.nombre_sucursal ASC
`;

const GET_SUCURSAL_SQL = `${SUCURSAL_SELECT_SQL}
  AND s.id_sucursal = $1::uuid
  LIMIT 1
`;

const LIST_EMPRESAS_SQL = `
  SELECT
    e.id_empresa,
    e.nombre_empresa
  FROM public.empresas e
  ORDER BY e.nombre_empresa ASC
`;

const DEPENDENCY_SUMMARY_SQL = `
  SELECT
    (SELECT COUNT(*)::int
     FROM public.empleados e
     WHERE e.id_sucursal = $1::uuid
       AND e.deleted_at IS NULL
       AND COALESCE(e.estado, TRUE) IS TRUE) AS empleados_activos,
    (SELECT COUNT(*)::int
     FROM public.clientes c
     WHERE c.id_sucursal_origen = $1::uuid
       AND c.deleted_at IS NULL
       AND COALESCE(c.estado, TRUE) IS TRUE) AS clientes_activos,
    (SELECT COUNT(*)::int
     FROM public.roles_usuarios ru
     WHERE ru.id_sucursal = $1::uuid
       AND ru.activo IS TRUE) AS roles_activos,
    (SELECT COUNT(*)::int
     FROM public.servicios_tarifas st
     WHERE st.id_sucursal = $1::uuid
       AND st.deleted_at IS NULL
       AND COALESCE(st.activo, TRUE) IS TRUE) AS tarifas_activas,
    (SELECT COUNT(*)::int
     FROM public.citas ci
     WHERE ci.id_sucursal = $1::uuid
       AND ci.deleted_at IS NULL
      AND ci.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
       AND ci.inicio_at >= NOW()) AS citas_futuras_activas
`;

function normalizeRequired(value, fieldName, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new AppError(400, `${fieldName} es obligatorio`, {
      code: "SUCURSALES_REQUIRED_FIELD",
      details: { field: fieldName },
    });
  }
  if (normalized.length > maxLength) {
    throw new AppError(400, `${fieldName} excede la longitud permitida`, {
      code: "SUCURSALES_FIELD_TOO_LONG",
      details: { field: fieldName, maxLength },
    });
  }
  return normalized;
}

function normalizeOptional(value, maxLength, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const normalized = String(value).trim();
  if (!normalized) return null;

  if (normalized.length > maxLength) {
    throw new AppError(400, `${fieldName} excede la longitud permitida`, {
      code: "SUCURSALES_FIELD_TOO_LONG",
      details: { field: fieldName, maxLength },
    });
  }

  return normalized;
}

function normalizePhone(value) {
  const normalized = normalizeOptional(value, PHONE_MAX_LENGTH, "telefono");
  if (normalized === undefined || normalized === null) return normalized;

  if (!PHONE_ALLOWED_PATTERN.test(normalized)) {
    throw new AppError(400, "telefono tiene formato invalido", {
      code: "SUCURSALES_INVALID_PHONE",
    });
  }

  return normalized;
}

function normalizeDateOnly(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const normalized = String(value).trim();
  if (!normalized) return null;

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "fecha_inauguracion invalida", {
      code: "SUCURSALES_INVALID_DATE",
    });
  }

  return normalized;
}

function mapSucursal(row) {
  return {
    id_sucursal: row.id_sucursal,
    id_empresa: row.id_empresa,
    nombre_empresa: row.nombre_empresa ?? null,
    nombre_sucursal: row.nombre_sucursal,
    direccion: row.direccion ?? null,
    telefono: row.telefono ?? null,
    fecha_inauguracion: row.fecha_inauguracion ?? null,
    estado: Boolean(row.estado),
  };
}

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    details: error instanceof Error ? error.message : message,
    requestId: request.id,
  });
}

async function ensureCompanyExists(client, idEmpresa) {
  const { rowCount } = await client.query(
    `
      SELECT 1
      FROM public.empresas
      WHERE id_empresa = $1::uuid
      LIMIT 1
    `,
    [idEmpresa]
  );

  if (!rowCount) {
    throw new AppError(400, "La empresa indicada no existe", {
      code: "SUCURSALES_COMPANY_NOT_FOUND",
    });
  }
}

async function findSucursalById(client, idSucursal) {
  const { rows } = await client.query(GET_SUCURSAL_SQL, [idSucursal]);
  return rows[0] ?? null;
}

async function assertUniqueBranchName(client, { idEmpresa, nombreSucursal, excludeId = null }) {
  const { rowCount } = await client.query(
    `
      SELECT s.id_sucursal
      FROM public.sucursales s
      WHERE s.id_empresa = $1::uuid
        AND s.deleted_at IS NULL
        AND LOWER(TRIM(s.nombre_sucursal)) = LOWER(TRIM($2::text))
        AND ($3::uuid IS NULL OR s.id_sucursal <> $3::uuid)
      LIMIT 1
    `,
    [idEmpresa, nombreSucursal, excludeId]
  );

  if (rowCount) {
    throw new AppError(409, "Ya existe una sucursal con ese nombre para la empresa seleccionada", {
      code: "SUCURSALES_DUPLICATE_NAME",
      details: {
        id_empresa: idEmpresa,
        nombre_sucursal: nombreSucursal,
      },
    });
  }
}

async function getDependencySummary(client, idSucursal) {
  const { rows } = await client.query(DEPENDENCY_SUMMARY_SQL, [idSucursal]);
  return rows[0] ?? null;
}

function hasActiveDependencies(summary) {
  if (!summary) return false;

  return [
    Number(summary.empleados_activos || 0),
    Number(summary.clientes_activos || 0),
    Number(summary.roles_activos || 0),
    Number(summary.tarifas_activas || 0),
    Number(summary.citas_futuras_activas || 0),
  ].some((count) => count > 0);
}

async function assertCanDeactivateBranch(client, idSucursal) {
  // JK: Antes de inactivar, protegemos la integridad operativa para no dejar referencias activas inconsistentes.
  const dependencySummary = await getDependencySummary(client, idSucursal);
  if (!hasActiveDependencies(dependencySummary)) {
    return;
  }

  throw new AppError(409, "No se puede inactivar la sucursal porque existen dependencias activas", {
    code: "SUCURSALES_HAS_ACTIVE_DEPENDENCIES",
    details: {
      empleados_activos: Number(dependencySummary?.empleados_activos || 0),
      clientes_activos: Number(dependencySummary?.clientes_activos || 0),
      roles_activos: Number(dependencySummary?.roles_activos || 0),
      tarifas_activas: Number(dependencySummary?.tarifas_activas || 0),
      citas_futuras_activas: Number(dependencySummary?.citas_futuras_activas || 0),
    },
  });
}

async function createSucursal(client, payload) {
  const idEmpresa = String(payload?.id_empresa || "").trim();
  const nombreSucursal = normalizeRequired(payload?.nombre_sucursal, "nombre_sucursal", NAME_MAX_LENGTH);
  const direccion = normalizeOptional(payload?.direccion, ADDRESS_MAX_LENGTH, "direccion");
  const telefono = normalizePhone(payload?.telefono);
  const fechaInauguracion = normalizeDateOnly(payload?.fecha_inauguracion);
  const estado = payload?.estado === undefined ? true : Boolean(payload?.estado);

  await ensureCompanyExists(client, idEmpresa);
  await assertUniqueBranchName(client, { idEmpresa, nombreSucursal });

  const created = await client.query(
    `
      INSERT INTO public.sucursales (
        id_empresa,
        nombre_sucursal,
        direccion_texto,
        telefono_texto,
        fecha_inauguracion,
        estado
      )
      VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::date, $6::boolean)
      RETURNING id_sucursal
    `,
    [idEmpresa, nombreSucursal, direccion ?? null, telefono ?? null, fechaInauguracion ?? null, estado]
  );

  return findSucursalById(client, created.rows[0].id_sucursal);
}

async function updateSucursal(client, idSucursal, patch = {}) {
  const current = await findSucursalById(client, idSucursal);

  if (!current) {
    throw new AppError(404, "Sucursal no encontrada", {
      code: "SUCURSALES_NOT_FOUND",
    });
  }

  const next = {
    id_empresa:
      patch.id_empresa !== undefined ? String(patch.id_empresa || "").trim() : current.id_empresa,
    nombre_sucursal:
      patch.nombre_sucursal !== undefined
        ? normalizeRequired(patch.nombre_sucursal, "nombre_sucursal", NAME_MAX_LENGTH)
        : current.nombre_sucursal,
    direccion:
      patch.direccion !== undefined
        ? normalizeOptional(patch.direccion, ADDRESS_MAX_LENGTH, "direccion")
        : current.direccion,
    telefono:
      patch.telefono !== undefined
        ? normalizePhone(patch.telefono)
        : current.telefono,
    fecha_inauguracion:
      patch.fecha_inauguracion !== undefined
        ? normalizeDateOnly(patch.fecha_inauguracion)
        : current.fecha_inauguracion,
    estado:
      patch.estado !== undefined ? Boolean(patch.estado) : Boolean(current.estado),
  };

  await ensureCompanyExists(client, next.id_empresa);
  await assertUniqueBranchName(client, {
    idEmpresa: next.id_empresa,
    nombreSucursal: next.nombre_sucursal,
    excludeId: idSucursal,
  });

  if (Boolean(current.estado) && !next.estado) {
    await assertCanDeactivateBranch(client, idSucursal);
  }

  await client.query(
    `
      UPDATE public.sucursales
      SET
        id_empresa = $2::uuid,
        nombre_sucursal = $3::text,
        direccion_texto = $4::text,
        telefono_texto = $5::text,
        fecha_inauguracion = $6::date,
        estado = $7::boolean,
        updated_at = NOW()
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
    `,
    [
      idSucursal,
      next.id_empresa,
      next.nombre_sucursal,
      next.direccion ?? null,
      next.telefono ?? null,
      next.fecha_inauguracion ?? null,
      next.estado,
    ]
  );

  return findSucursalById(client, idSucursal);
}

async function setSucursalState(client, idSucursal, targetState) {
  const current = await findSucursalById(client, idSucursal);

  if (!current) {
    throw new AppError(404, "Sucursal no encontrada", {
      code: "SUCURSALES_NOT_FOUND",
    });
  }

  const normalizedState = Boolean(targetState);
  if (Boolean(current.estado) === normalizedState) {
    return {
      sucursal: mapSucursal(current),
      changed: false,
    };
  }

  if (!normalizedState) {
    await assertCanDeactivateBranch(client, idSucursal);
  }

  await client.query(
    `
      UPDATE public.sucursales
      SET
        estado = $2::boolean,
        updated_at = NOW()
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
    `,
    [idSucursal, normalizedState]
  );

  const updated = await findSucursalById(client, idSucursal);
  return {
    sucursal: mapSucursal(updated),
    changed: true,
  };
}

export default async function adminSucursalesRoutes(app) {
  // JK: Listado principal para el modulo SUCURSALES, restringido a SUPER_ADMIN en esta fase.
  app.get("/", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { querystring: listSucursalesQuerySchema } }, async (request, reply) => {
    try {
      const onlyActive = request.query?.solo_activas === true || request.query?.solo_activas === "true";
      const { rows } = await app.db.query(onlyActive ? LIST_ACTIVE_SUCURSALES_SQL : LIST_SUCURSALES_SQL);
      return sendOk(reply, { sucursales: rows.map(mapSucursal) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar sucursales", "SUCURSALES_LIST_ERROR");
    }
  });

  // JK: Catalogo de empresas para alimentar selectores en creacion/edicion de sucursales.
  app.get("/empresas", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(LIST_EMPRESAS_SQL);
      return sendOk(reply, { empresas: rows });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar empresas", "SUCURSALES_COMPANIES_LIST_ERROR");
    }
  });

  app.get("/:id", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { params: idParamSchema } }, async (request, reply) => {
    try {
      const found = await findSucursalById(app.db, request.params.id);

      if (!found) {
        return sendError(reply, 404, "Sucursal no encontrada", {
          code: "SUCURSALES_NOT_FOUND",
          requestId: request.id,
        });
      }

      return sendOk(reply, { sucursal: mapSucursal(found) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar sucursal", "SUCURSALES_DETAIL_ERROR");
    }
  });

  app.post(
    "/",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: { body: sucursalCreateBodySchema },
    },
    async (request, reply) => {
      try {
        const created = await createSucursal(app.db, request.body || {});
        return sendOk(reply, { sucursal: mapSucursal(created) }, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo crear sucursal", "SUCURSALES_CREATE_ERROR");
      }
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: { params: idParamSchema, body: sucursalPatchBodySchema },
    },
    async (request, reply) => {
      try {
        const updated = await updateSucursal(app.db, request.params.id, request.body || {});
        return sendOk(reply, { sucursal: mapSucursal(updated) }, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar sucursal", "SUCURSALES_UPDATE_ERROR");
      }
    }
  );

  app.patch(
    "/:id/inactivar",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: { params: idParamSchema },
    },
    async (request, reply) => {
      try {
        const result = await setSucursalState(app.db, request.params.id, false);
        return sendOk(
          reply,
          {
            sucursal: result.sucursal,
            changed: result.changed,
            mensaje: result.changed ? "Sucursal inactivada correctamente" : "La sucursal ya estaba inactiva",
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo inactivar sucursal", "SUCURSALES_INACTIVATE_ERROR");
      }
    }
  );

  app.patch(
    "/:id/activar",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: { params: idParamSchema },
    },
    async (request, reply) => {
      try {
        const result = await setSucursalState(app.db, request.params.id, true);
        return sendOk(
          reply,
          {
            sucursal: result.sucursal,
            changed: result.changed,
            mensaje: result.changed ? "Sucursal activada correctamente" : "La sucursal ya estaba activa",
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo activar sucursal", "SUCURSALES_ACTIVATE_ERROR");
      }
    }
  );

  // JK: Alias legado de DELETE para mantener compatibilidad, ahora se transforma en inactivacion (sin borrado).
  app.delete(
    "/:id",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: { params: idParamSchema },
    },
    async (request, reply) => {
      try {
        const result = await setSucursalState(app.db, request.params.id, false);
        return sendOk(
          reply,
          {
            sucursal: result.sucursal,
            changed: result.changed,
            mensaje: result.changed ? "Sucursal inactivada correctamente" : "La sucursal ya estaba inactiva",
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo inactivar sucursal", "SUCURSALES_DELETE_ALIAS_ERROR");
      }
    }
  );
}
