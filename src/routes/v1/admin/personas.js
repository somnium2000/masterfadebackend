import crypto from "node:crypto";
import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { generateRecoveryActionLink } from "../../../services/authRecovery.js";

const SUPER_ADMIN_ONLY = ["super_admin"];
const ACCESS_STATUS = {
  PENDING_PASSWORD: "pendiente_password",
  ACTIVE: "activo",
  BLOCKED: "bloqueado",
  INACTIVE: "inactivo",
};
const EMPLOYEE_ALLOWED_ROLES = new Set(["super_admin", "admin", "barbero"]);
const BRANCH_REQUIRED_ROLES = new Set(["admin", "barbero"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// AM: Regla operativa de identidad hondurena para esta fase (13 digitos).
const DNI_PATTERN = /^\d{13}$/;
const RTN_PATTERN = /^\d{14}$/;

const personaInputSchema = {
  type: "object",
  properties: {
    nombres: { type: "string", minLength: 1, maxLength: 120 },
    apellidos: { type: "string", minLength: 1, maxLength: 120 },
    fecha_nacimiento: { type: ["string", "null"], format: "date" },
    genero_codigo: { type: ["string", "null"], maxLength: 30 },
    dni: { type: ["string", "null"], maxLength: 30 },
    rtn: { type: ["string", "null"], maxLength: 30 },
    telefono_principal: { type: ["string", "null"], maxLength: 30 },
    direccion_texto: { type: ["string", "null"], maxLength: 300 },
    observaciones: { type: ["string", "null"], maxLength: 500 },
  },
  required: ["nombres", "apellidos"],
  additionalProperties: false,
};

const empleadoCreateBodySchema = {
  type: "object",
  properties: {
    persona: personaInputSchema,
    acceso: {
      type: "object",
      properties: {
        correo_principal: { type: "string", minLength: 5, maxLength: 160 },
        roles: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["super_admin", "admin", "barbero"] },
        },
      },
      required: ["correo_principal", "roles"],
      additionalProperties: false,
    },
    empleado: {
      type: "object",
      properties: {
        id_sucursal: { type: "string", format: "uuid" },
        fecha_ingreso: { type: ["string", "null"], format: "date-time" },
        salario_base: { type: ["number", "null"], minimum: 0 },
        estado: { type: "boolean" },
        es_barbero: { type: "boolean" },
      },
      required: ["id_sucursal", "es_barbero"],
      additionalProperties: false,
    },
  },
  required: ["persona", "acceso", "empleado"],
  additionalProperties: false,
};

const clienteCreateBodySchema = {
  type: "object",
  properties: {
    persona: personaInputSchema,
    acceso: {
      type: "object",
      properties: {
        habilitar_acceso: { type: "boolean" },
        correo_principal: { type: "string", minLength: 5, maxLength: 160 },
      },
      required: ["habilitar_acceso", "correo_principal"],
      additionalProperties: false,
    },
    cliente: {
      type: "object",
      properties: {
        id_sucursal_origen: { type: ["string", "null"], format: "uuid" },
        fecha_ingreso: { type: ["string", "null"], format: "date-time" },
        estado: { type: "boolean" },
        consentimiento_marketing: { type: "boolean" },
        acepta_terminos: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  required: ["persona", "acceso"],
  additionalProperties: false,
};

const usuarioSetupBodySchema = {
  type: "object",
  properties: {
    marcar_pendiente_password: { type: "boolean" },
  },
  additionalProperties: false,
};

const usuarioUpdateBodySchema = {
  type: "object",
  properties: {
    persona: {
      type: "object",
      properties: {
        nombres: { type: ["string", "null"], minLength: 1, maxLength: 120 },
        apellidos: { type: ["string", "null"], minLength: 1, maxLength: 120 },
        telefono_principal: { type: ["string", "null"], maxLength: 30 },
      },
      additionalProperties: false,
    },
    acceso: {
      type: "object",
      properties: {
        correo_principal: { type: ["string", "null"], minLength: 5, maxLength: 160 },
        rol_principal: { type: ["string", "null"], minLength: 1, maxLength: 50 },
        id_sucursal: { type: ["string", "null"], format: "uuid" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const usuarioAccessStatusBodySchema = {
  type: "object",
  properties: {
    estado_acceso: { type: "string", enum: ["pendiente_password", "activo", "bloqueado", "inactivo"] },
  },
  required: ["estado_acceso"],
  additionalProperties: false,
};

const clienteUpdateBodySchema = {
  type: "object",
  properties: {
    persona: personaInputSchema,
    acceso: {
      type: "object",
      properties: {
        habilitar_acceso: { type: "boolean" },
        correo_principal: { type: "string", minLength: 5, maxLength: 160 },
      },
      additionalProperties: false,
    },
    cliente: {
      type: "object",
      properties: {
        id_sucursal_origen: { type: ["string", "null"], format: "uuid" },
        fecha_ingreso: { type: ["string", "null"], format: "date-time" },
        estado: { type: "boolean" },
        consentimiento_marketing: { type: "boolean" },
        acepta_terminos: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  required: ["persona"],
  additionalProperties: false,
};

const LIST_PERSONAS_SQL = `
  SELECT
    p.id_persona,
    p.nombres,
    p.apellidos,
    p.fecha_nacimiento,
    p.genero_codigo,
    p.dni,
    p.rtn,
    p.telefono_principal,
    NULLIF(cp.email, '') AS email,
    EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id_persona = p.id_persona AND u.deleted_at IS NULL) AS tiene_usuario,
    EXISTS (SELECT 1 FROM public.empleados e WHERE e.id_persona = p.id_persona AND e.deleted_at IS NULL) AS tiene_empleado,
    EXISTS (SELECT 1 FROM public.clientes c WHERE c.id_persona = p.id_persona AND c.deleted_at IS NULL) AS tiene_cliente
  FROM public.personas p
  LEFT JOIN LATERAL (
    SELECT c.direccion_correo::text AS email
    FROM public.correos c
    WHERE c.id_persona = p.id_persona
      AND c.deleted_at IS NULL
    ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
    LIMIT 1
  ) cp ON TRUE
  WHERE p.deleted_at IS NULL
  ORDER BY p.nombres ASC, p.apellidos ASC
`;

const LIST_USUARIOS_SQL = `
  SELECT
    u.id_usuario,
    u.id_persona,
    p.nombres,
    p.apellidos,
    p.telefono_principal,
    COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS email,
    COALESCE(u.estado, TRUE) AS estado,
    u.estado_acceso,
    u.credenciales_completadas_at,
    u.ultimo_login_at,
    COALESCE(
      jsonb_agg(jsonb_build_object('rol', r.nombre, 'id_sucursal', ru.id_sucursal) ORDER BY r.nombre, ru.id_sucursal)
      FILTER (WHERE r.nombre IS NOT NULL),
      '[]'::jsonb
    ) AS roles,
    EXISTS (SELECT 1 FROM public.empleados e WHERE e.id_persona = u.id_persona AND e.deleted_at IS NULL) AS tiene_empleado,
    EXISTS (SELECT 1 FROM public.clientes c WHERE c.id_usuario = u.id_usuario AND c.deleted_at IS NULL) AS tiene_cliente
  FROM public.usuarios u
  LEFT JOIN public.personas p ON p.id_persona = u.id_persona
  LEFT JOIN auth.users au ON au.id = u.id_usuario
  LEFT JOIN LATERAL (
    SELECT c.direccion_correo::text AS email
    FROM public.correos c
    WHERE c.id_persona = u.id_persona
      AND c.deleted_at IS NULL
    ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
    LIMIT 1
  ) cp ON TRUE
  LEFT JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario AND ru.activo IS TRUE
  LEFT JOIN public.roles r ON r.id_rol = ru.id_rol
  WHERE u.deleted_at IS NULL
  GROUP BY u.id_usuario, u.id_persona, p.nombres, p.apellidos, p.telefono_principal, cp.email, au.email, u.estado, u.estado_acceso, u.credenciales_completadas_at, u.ultimo_login_at
  ORDER BY p.nombres ASC, p.apellidos ASC, u.id_usuario ASC
`;

const EMPLEADO_BASE_SQL = `
  SELECT
    e.id_empleado,
    e.id_persona,
    u.id_usuario,
    p.nombres,
    p.apellidos,
    p.fecha_nacimiento,
    p.genero_codigo,
    p.dni,
    p.rtn,
    p.telefono_principal,
    p.direccion_texto,
    p.observaciones,
    COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS correo_principal,
    e.id_sucursal,
    s.nombre_sucursal,
    e.fecha_ingreso,
    e.salario_base,
    COALESCE(e.estado, TRUE) AS estado_laboral,
    COALESCE(e.es_barbero, FALSE) AS es_barbero,
    COALESCE(u.estado, TRUE) AS estado_usuario,
    COALESCE(u.estado_acceso, 'pendiente_password') AS estado_acceso,
    u.credenciales_completadas_at,
    u.ultimo_login_at,
    COALESCE((
      SELECT array_agg(r.nombre ORDER BY r.nombre)
      FROM public.roles_usuarios ru
      JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = u.id_usuario
        AND ru.activo IS TRUE
    ), ARRAY[]::text[]) AS roles
  FROM public.empleados e
  JOIN public.personas p ON p.id_persona = e.id_persona
  LEFT JOIN public.usuarios u ON u.id_persona = e.id_persona AND u.deleted_at IS NULL
  LEFT JOIN auth.users au ON au.id = u.id_usuario
  LEFT JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
  LEFT JOIN LATERAL (
    SELECT c.direccion_correo::text AS email
    FROM public.correos c
    WHERE c.id_persona = e.id_persona
      AND c.deleted_at IS NULL
    ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
    LIMIT 1
  ) cp ON TRUE
  WHERE e.deleted_at IS NULL
`;

const LIST_EMPLEADOS_SQL = `${EMPLEADO_BASE_SQL}
  ORDER BY p.nombres ASC, p.apellidos ASC, e.id_empleado ASC
`;

const EMPLEADO_BY_ID_SQL = `${EMPLEADO_BASE_SQL}
  AND e.id_empleado = $1::uuid
  LIMIT 1
`;

const EMPLEADO_BY_USER_SQL = `${EMPLEADO_BASE_SQL}
  AND u.id_usuario = $1::uuid
  LIMIT 1
`;

const CLIENTE_BASE_SQL = `
  SELECT
    c.id_cliente,
    c.id_persona,
    c.id_usuario,
    p.nombres,
    p.apellidos,
    p.fecha_nacimiento,
    p.genero_codigo,
    p.dni,
    p.rtn,
    p.telefono_principal,
    p.direccion_texto,
    p.observaciones,
    COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS correo_principal,
    c.fecha_ingreso,
    COALESCE(c.estado, TRUE) AS estado_cliente,
    c.id_sucursal_origen,
    s.nombre_sucursal,
    COALESCE(c.consentimiento_marketing, FALSE) AS consentimiento_marketing,
    COALESCE(c.acepta_terminos, FALSE) AS acepta_terminos,
    (c.id_usuario IS NOT NULL) AS tiene_acceso,
    CASE
      WHEN c.id_usuario IS NULL THEN 'sin_acceso'
      ELSE COALESCE(u.estado_acceso, 'pendiente_password')
    END AS estado_acceso,
    u.credenciales_completadas_at,
    u.ultimo_login_at
  FROM public.clientes c
  JOIN public.personas p ON p.id_persona = c.id_persona
  LEFT JOIN public.usuarios u ON u.id_usuario = c.id_usuario AND u.deleted_at IS NULL
  LEFT JOIN auth.users au ON au.id = c.id_usuario
  LEFT JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal_origen
  LEFT JOIN LATERAL (
    SELECT c2.direccion_correo::text AS email
    FROM public.correos c2
    WHERE c2.id_persona = c.id_persona
      AND c2.deleted_at IS NULL
    ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
    LIMIT 1
  ) cp ON TRUE
  WHERE c.deleted_at IS NULL
`;

const LIST_CLIENTES_SQL = `${CLIENTE_BASE_SQL}
  ORDER BY p.nombres ASC, p.apellidos ASC, c.id_cliente ASC
`;

const CLIENTE_BY_ID_SQL = `${CLIENTE_BASE_SQL}
  AND c.id_cliente = $1::uuid
  LIMIT 1
`;

const USUARIO_BY_ID_SQL = `
  SELECT *
  FROM (${LIST_USUARIOS_SQL}) usuarios
  WHERE usuarios.id_usuario = $1::uuid
  LIMIT 1
`;

const FK_RELATIONS_CACHE = new Map();
let clientsConsentColumnsCache = null;

function normalizeRequired(value) {
  return String(value || "").trim();
}

function normalizeOptional(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDateOnly(value) {
  const raw = normalizeOptional(value);
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "Fecha invalida", { code: "PERSONAS_INVALID_DATE" });
  }
  return raw;
}

function normalizeDigits(value) {
  const raw = normalizeOptional(value);
  if (!raw) return null;
  return raw.replace(/\D/g, "");
}

function normalizeMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError(400, "salario_base debe ser un numero mayor o igual a cero", {
      code: "PERSONAS_INVALID_SALARY",
    });
  }
  return numeric;
}

function assertBirthDateNotFuture(dateValue) {
  if (!dateValue) return;
  const given = new Date(`${dateValue}T00:00:00.000Z`);
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (given.getTime() > todayUtc.getTime()) {
    throw new AppError(400, "fecha_nacimiento no puede estar en el futuro", {
      code: "PERSONAS_BIRTHDATE_FUTURE",
    });
  }
}

function assertDni(dniDigits) {
  if (!dniDigits) return;
  if (!DNI_PATTERN.test(dniDigits)) {
    throw new AppError(400, "dni debe tener 13 digitos", { code: "PERSONAS_INVALID_DNI" });
  }
}

function assertRtn(rtnDigits) {
  if (!rtnDigits) return;
  if (!RTN_PATTERN.test(rtnDigits)) {
    throw new AppError(400, "rtn debe tener 14 digitos", { code: "PERSONAS_INVALID_RTN" });
  }
}

function assertValidEmail(email) {
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "correo_principal debe ser un correo valido", { code: "PERSONAS_INVALID_EMAIL" });
  }
}

function buildRandomPassword() {
  const raw = crypto.randomBytes(24).toString("base64url");
  return `Mf!${raw.slice(0, 20)}9`;
}

function mapUsuario(row) {
  const roles = Array.isArray(row.roles) ? row.roles : [];
  const tieneEmpleado = Boolean(row.tiene_empleado);
  const tieneCliente = Boolean(row.tiene_cliente);
  return {
    id_usuario: row.id_usuario,
    id_persona: row.id_persona,
    nombres: row.nombres ?? "",
    apellidos: row.apellidos ?? "",
    nombre_completo: `${String(row.nombres ?? "").trim()} ${String(row.apellidos ?? "").trim()}`.trim(),
    telefono_principal: row.telefono_principal ?? null,
    email: row.email ?? null,
    estado: Boolean(row.estado),
    estado_acceso: row.estado_acceso ?? ACCESS_STATUS.PENDING_PASSWORD,
    credenciales_completadas_at: row.credenciales_completadas_at ?? null,
    ultimo_login_at: row.ultimo_login_at ?? null,
    roles,
    tiene_empleado: tieneEmpleado,
    tiene_cliente: tieneCliente,
    origen: tieneEmpleado && tieneCliente ? "empleado_cliente" : tieneEmpleado ? "empleado" : tieneCliente ? "cliente" : "interno",
  };
}

function mapEmpleado(row) {
  return {
    id_empleado: row.id_empleado,
    id_persona: row.id_persona,
    id_usuario: row.id_usuario ?? null,
    nombres: row.nombres ?? "",
    apellidos: row.apellidos ?? "",
    nombre_completo: `${String(row.nombres ?? "").trim()} ${String(row.apellidos ?? "").trim()}`.trim(),
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    genero_codigo: row.genero_codigo ?? null,
    dni: row.dni ?? null,
    rtn: row.rtn ?? null,
    telefono_principal: row.telefono_principal ?? null,
    direccion_texto: row.direccion_texto ?? null,
    observaciones: row.observaciones ?? null,
    correo_principal: row.correo_principal ?? null,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    fecha_ingreso: row.fecha_ingreso ?? null,
    salario_base: row.salario_base ?? null,
    estado_laboral: Boolean(row.estado_laboral),
    es_barbero: Boolean(row.es_barbero),
    estado_usuario: Boolean(row.estado_usuario),
    estado_acceso: row.estado_acceso ?? ACCESS_STATUS.PENDING_PASSWORD,
    credenciales_completadas_at: row.credenciales_completadas_at ?? null,
    ultimo_login_at: row.ultimo_login_at ?? null,
    roles: Array.isArray(row.roles) ? row.roles : [],
  };
}

function mapCliente(row) {
  return {
    id_cliente: row.id_cliente,
    id_persona: row.id_persona,
    id_usuario: row.id_usuario ?? null,
    nombres: row.nombres ?? "",
    apellidos: row.apellidos ?? "",
    nombre_completo: `${String(row.nombres ?? "").trim()} ${String(row.apellidos ?? "").trim()}`.trim(),
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    genero_codigo: row.genero_codigo ?? null,
    dni: row.dni ?? null,
    rtn: row.rtn ?? null,
    telefono_principal: row.telefono_principal ?? null,
    direccion_texto: row.direccion_texto ?? null,
    observaciones: row.observaciones ?? null,
    correo_principal: row.correo_principal ?? null,
    fecha_ingreso: row.fecha_ingreso ?? null,
    estado_cliente: Boolean(row.estado_cliente),
    id_sucursal_origen: row.id_sucursal_origen ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
    consentimiento_marketing: Boolean(row.consentimiento_marketing),
    acepta_terminos: Boolean(row.acepta_terminos),
    tiene_acceso: Boolean(row.tiene_acceso),
    estado_acceso: row.estado_acceso,
    credenciales_completadas_at: row.credenciales_completadas_at ?? null,
    ultimo_login_at: row.ultimo_login_at ?? null,
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

function quoteIdent(identifier) {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

function parsePgTextArray(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;
  const text = String(rawValue || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return [];
  const body = text.slice(1, -1);
  if (!body) return [];
  return body
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"));
}

async function getForeignKeyRelationsByTarget(client, targetTable) {
  if (FK_RELATIONS_CACHE.has(targetTable)) {
    return FK_RELATIONS_CACHE.get(targetTable);
  }

  const result = await client.query(
    `
      SELECT
        con.conname,
        src_ns.nspname AS source_schema,
        src.relname AS source_table,
        array_agg(src_att.attname ORDER BY u.ord) AS source_columns,
        tgt_ns.nspname AS target_schema,
        tgt.relname AS target_table,
        array_agg(tgt_att.attname ORDER BY u.ord) AS target_columns
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
      JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(src_attnum, tgt_attnum, ord) ON TRUE
      JOIN pg_attribute src_att ON src_att.attrelid = src.oid AND src_att.attnum = u.src_attnum
      JOIN pg_attribute tgt_att ON tgt_att.attrelid = tgt.oid AND tgt_att.attnum = u.tgt_attnum
      WHERE con.contype = 'f'
        AND tgt_ns.nspname = 'public'
        AND tgt.relname = $1
      GROUP BY con.conname, src_ns.nspname, src.relname, tgt_ns.nspname, tgt.relname
      ORDER BY src_ns.nspname, src.relname, con.conname
    `,
    [targetTable]
  );

  FK_RELATIONS_CACHE.set(targetTable, result.rows);
  return result.rows;
}

async function findExternalDependenciesForRecord(
  client,
  { targetTable, targetColumn, idValue, allowedSourceTables = new Set() }
) {
  const relations = await getForeignKeyRelationsByTarget(client, targetTable);
  const dependencies = [];

  for (const relation of relations) {
    const sourceColumns = parsePgTextArray(relation.source_columns);
    const targetColumns = parsePgTextArray(relation.target_columns);
    if (sourceColumns.length !== 1 || targetColumns.length !== 1) {
      continue;
    }
    if (targetColumns[0] !== targetColumn) {
      continue;
    }

    const sourceKey = `${relation.source_schema}.${relation.source_table}`;
    if (allowedSourceTables.has(sourceKey)) {
      continue;
    }

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM ${quoteIdent(relation.source_schema)}.${quoteIdent(relation.source_table)}
      WHERE ${quoteIdent(sourceColumns[0])} = $1::uuid
    `;
    const countResult = await client.query(countQuery, [idValue]);
    const total = Number(countResult.rows?.[0]?.total ?? 0);
    if (total > 0) {
      dependencies.push({
        target_table: `public.${targetTable}`,
        target_column: targetColumn,
        target_id: idValue,
        source_table: sourceKey,
        source_column: sourceColumns[0],
        constraint: relation.conname,
        total,
      });
    }
  }

  return dependencies;
}

async function assertBundleHasNoExternalDependencies(client, bundle) {
  const dependencies = [];

  for (const idEmpleado of bundle.empleadoIds) {
    dependencies.push(
      ...(await findExternalDependenciesForRecord(client, {
        targetTable: "empleados",
        targetColumn: "id_empleado",
        idValue: idEmpleado,
      }))
    );
  }

  for (const idCliente of bundle.clienteIds) {
    dependencies.push(
      ...(await findExternalDependenciesForRecord(client, {
        targetTable: "clientes",
        targetColumn: "id_cliente",
        idValue: idCliente,
      }))
    );
  }

  // AM: Permite limpiar referencias internas del dominio Personas antes de borrar usuarios.
  const usuariosAllowedSources = new Set(["public.roles_usuarios", "public.clientes", "public.empleados"]);
  for (const idUsuario of bundle.usuarioIds) {
    dependencies.push(
      ...(await findExternalDependenciesForRecord(client, {
        targetTable: "usuarios",
        targetColumn: "id_usuario",
        idValue: idUsuario,
        allowedSourceTables: usuariosAllowedSources,
      }))
    );
  }

  if (bundle.personaId) {
    const personasAllowedSources = new Set([
      "public.empleados",
      "public.clientes",
      "public.usuarios",
      "public.correos",
    ]);
    dependencies.push(
      ...(await findExternalDependenciesForRecord(client, {
        targetTable: "personas",
        targetColumn: "id_persona",
        idValue: bundle.personaId,
        allowedSourceTables: personasAllowedSources,
      }))
    );
  }

  for (const idCorreo of bundle.correoIds) {
    dependencies.push(
      ...(await findExternalDependenciesForRecord(client, {
        targetTable: "correos",
        targetColumn: "id_correo",
        idValue: idCorreo,
      }))
    );
  }

  if (!dependencies.length) return;

  throw new AppError(409, "No se puede eliminar porque existen dependencias en otros modulos", {
    code: "PERSONAS_DELETE_HAS_EXTERNAL_DEPENDENCIES",
    details: dependencies,
  });
}

async function findReplacementEmpleadoId(client, idEmpleado, empleadoIdsToDelete = []) {
  const excludedIds = uniqueUuidList([idEmpleado, ...empleadoIdsToDelete]);
  const result = await client.query(
    `
      SELECT e.id_empleado
      FROM public.empleados e
      WHERE e.deleted_at IS NULL
        AND NOT (e.id_empleado = ANY($1::uuid[]))
      ORDER BY e.id_empleado ASC
      LIMIT 1
    `,
    [excludedIds]
  );
  return result.rows?.[0]?.id_empleado ?? null;
}

async function reassignHorariosEmpleadoIfNeeded(client, idEmpleado, empleadoIdsToDelete = []) {
  const refsResult = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.horarios_semanales_empleados
      WHERE id_empleado = $1::uuid
    `,
    [idEmpleado]
  );
  const totalRefs = Number(refsResult.rows?.[0]?.total ?? 0);
  if (totalRefs <= 0) {
    return { moved: 0, replacementId: null };
  }

  const replacementId = await findReplacementEmpleadoId(client, idEmpleado, empleadoIdsToDelete);
  if (!replacementId) {
    throw new AppError(409, "No se puede eliminar el empleado porque no existe otro empleado para reasignar su horario", {
      code: "PERSONAS_DELETE_EMPLOYEE_REASSIGN_REQUIRED",
      details: {
        id_empleado: idEmpleado,
        source_table: "public.horarios_semanales_empleados",
        source_column: "id_empleado",
        total: totalRefs,
      },
    });
  }

  // AM: Reasignacion temporal automatica de horarios al siguiente empleado disponible para permitir limpieza operativa.
  const updateResult = await client.query(
    `
      UPDATE public.horarios_semanales_empleados
      SET id_empleado = $2::uuid
      WHERE id_empleado = $1::uuid
    `,
    [idEmpleado, replacementId]
  );
  return { moved: Number(updateResult.rowCount || 0), replacementId };
}

async function applyTemporaryEmployeeReassignments(client, empleadoIdsToDelete = []) {
  const ids = uniqueUuidList(empleadoIdsToDelete);
  if (!ids.length) {
    return [];
  }

  const summary = [];
  for (const idEmpleado of ids) {
    const reassignment = await reassignHorariosEmpleadoIfNeeded(client, idEmpleado, ids);
    if (reassignment.moved > 0) {
      summary.push({
        id_empleado_origen: idEmpleado,
        id_empleado_destino: reassignment.replacementId,
        horarios_reasignados: reassignment.moved,
      });
    }
  }
  return summary;
}

async function ensureActiveBranch(client, branchId) {
  const raw = normalizeOptional(branchId);
  if (!raw) return null;
  const result = await client.query(
    `
      SELECT id_sucursal
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
        AND estado IS TRUE
      LIMIT 1
    `,
    [raw]
  );
  if (!result.rowCount) {
    throw new AppError(400, "La sucursal no existe o no esta activa", {
      code: "PERSONAS_BRANCH_NOT_FOUND",
    });
  }
  return raw;
}

async function hasClientsConsentTimestampColumns(client) {
  if (clientsConsentColumnsCache !== null) {
    return clientsConsentColumnsCache;
  }

  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'clientes'
        AND column_name IN ('acepta_terminos_at', 'consentimiento_marketing_at')
    `
  );

  const columns = new Set(rows.map((row) => String(row.column_name)));
  clientsConsentColumnsCache =
    columns.has("acepta_terminos_at") && columns.has("consentimiento_marketing_at");
  return clientsConsentColumnsCache;
}

async function ensureEmailAvailability(client, email, { excludePersonaId = null, excludeUserId = null } = {}) {
  const correoResult = await client.query(
    `
      SELECT id_persona
      FROM public.correos
      WHERE LOWER(direccion_correo::text) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  if (correoResult.rowCount) {
    const existingPersonaId = correoResult.rows[0].id_persona ?? null;
    if (!excludePersonaId || existingPersonaId !== excludePersonaId) {
      throw new AppError(409, "El correo ya esta vinculado a otra persona", {
        code: "PERSONAS_EMAIL_ALREADY_EXISTS",
      });
    }
  }

  const authResult = await client.query(
    `
      SELECT id
      FROM auth.users
      WHERE LOWER(email::text) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  if (authResult.rowCount) {
    const existingUserId = authResult.rows[0].id ?? null;
    if (!excludeUserId || existingUserId !== excludeUserId) {
      throw new AppError(409, "El correo ya existe en auth.users", {
        code: "PERSONAS_AUTH_EMAIL_ALREADY_EXISTS",
      });
    }
  }
}

async function upsertPrimaryEmail(client, personaId, email) {
  if (!email) return;

  const existing = await client.query(
    `
      SELECT id_correo
      FROM public.correos
      WHERE id_persona = $1::uuid
      ORDER BY es_principal DESC NULLS LAST, created_at ASC
      LIMIT 1
    `,
    [personaId]
  );

  if (existing.rowCount) {
    await client.query(
      `
        UPDATE public.correos
        SET direccion_correo = $2,
            es_principal = TRUE,
            verificado = TRUE,
            updated_at = NOW(),
            deleted_at = NULL
        WHERE id_correo = $1::uuid
      `,
      [existing.rows[0].id_correo, email]
    );
    await client.query(
      `
        UPDATE public.correos
        SET es_principal = FALSE,
            updated_at = NOW()
        WHERE id_persona = $1::uuid
          AND id_correo <> $2::uuid
          AND es_principal IS TRUE
      `,
      [personaId, existing.rows[0].id_correo]
    );
    return;
  }

  await client.query(
    `
      INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
      VALUES ($1::uuid, $2, TRUE, TRUE)
    `,
    [personaId, email]
  );
}

async function loadRoleIdByName(client) {
  const roleRows = await client.query("SELECT id_rol, nombre FROM public.roles");
  return new Map(roleRows.rows.map((row) => [String(row.nombre), row.id_rol]));
}

function parseEmployeeRoleNames(rawRoles, esBarbero) {
  const normalizedRoles = Array.isArray(rawRoles)
    ? rawRoles.map((value) => normalizeRequired(value).toLowerCase()).filter(Boolean)
    : [];

  if (!normalizedRoles.length) {
    throw new AppError(400, "Debes asignar al menos un rol para el empleado", {
      code: "PERSONAS_ROLE_REQUIRED",
    });
  }

  const uniqueRoles = [...new Set(normalizedRoles)];

  for (const role of uniqueRoles) {
    if (!EMPLOYEE_ALLOWED_ROLES.has(role)) {
      throw new AppError(400, `Rol invalido para empleado: ${role}`, {
        code: "PERSONAS_ROLE_NOT_ALLOWED",
      });
    }
  }

  if (esBarbero && !uniqueRoles.includes("barbero")) {
    throw new AppError(400, "Si empleado.es_barbero=true debes asignar rol barbero", {
      code: "PERSONAS_BARBER_ROLE_REQUIRED",
    });
  }

  if (!esBarbero && uniqueRoles.includes("barbero")) {
    throw new AppError(400, "Si asignas rol barbero debes marcar empleado.es_barbero=true", {
      code: "PERSONAS_BARBER_FLAG_REQUIRED",
    });
  }

  if (uniqueRoles.includes("super_admin") && uniqueRoles.length > 1) {
    throw new AppError(400, "super_admin debe ser un rol exclusivo en esta fase", {
      code: "PERSONAS_SUPER_ADMIN_ROLE_EXCLUSIVE",
    });
  }

  return uniqueRoles;
}

async function setEmployeeRoleAssignments(client, { roleIdsByName, roleNames, userId, branchId, assignedBy }) {
  const employeeRoleIds = [];
  for (const roleName of EMPLOYEE_ALLOWED_ROLES) {
    if (roleIdsByName.has(roleName)) employeeRoleIds.push(roleIdsByName.get(roleName));
  }

  if (employeeRoleIds.length) {
    await client.query(
      `
        UPDATE public.roles_usuarios
        SET activo = FALSE,
            updated_at = NOW()
        WHERE id_usuario = $1::uuid
          AND id_rol = ANY($2::uuid[])
          AND activo IS TRUE
      `,
      [userId, employeeRoleIds]
    );
  }

  for (const roleName of roleNames) {
    const roleId = roleIdsByName.get(roleName);
    if (!roleId) {
      throw new AppError(400, `Rol no encontrado: ${roleName}`, {
        code: "PERSONAS_ROLE_NOT_FOUND",
      });
    }

    const revived = await client.query(
      `
        UPDATE public.roles_usuarios
        SET id_sucursal = $3::uuid,
            activo = TRUE,
            asignado_por = $4::uuid,
            updated_at = NOW()
        WHERE id_usuario = $1::uuid
          AND id_rol = $2::uuid
      `,
      [userId, roleId, roleName === "super_admin" ? null : branchId, assignedBy]
    );

    if (!revived.rowCount) {
      await client.query(
        `
          INSERT INTO public.roles_usuarios (id_rol, id_usuario, id_sucursal, activo, asignado_por)
          VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE, $4::uuid)
        `,
        [roleId, userId, roleName === "super_admin" ? null : branchId, assignedBy]
      );
    }
  }
}

async function ensureClienteRoleAssignment(client, roleIdsByName, userId, branchId, assignedBy) {
  const roleId = roleIdsByName.get("cliente");
  if (!roleId) {
    throw new AppError(500, "Rol cliente no existe en catalogo", {
      code: "PERSONAS_CLIENT_ROLE_MISSING",
    });
  }

  if (!branchId) {
    throw new AppError(400, "Cliente con acceso requiere id_sucursal_origen activo", {
      code: "PERSONAS_CLIENT_BRANCH_REQUIRED",
    });
  }

  const revived = await client.query(
    `
      UPDATE public.roles_usuarios
      SET activo = TRUE,
          id_sucursal = $3::uuid,
          asignado_por = $4::uuid,
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND id_rol = $2::uuid
    `,
    [userId, roleId, branchId, assignedBy]
  );

  if (!revived.rowCount) {
    await client.query(
      `
        INSERT INTO public.roles_usuarios (id_rol, id_usuario, id_sucursal, activo, asignado_por)
        VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE, $4::uuid)
      `,
      [roleId, userId, branchId, assignedBy]
    );
  }
}

async function createAuthIdentity(app, { email, nombres, apellidos }) {
  if (!app.supabaseAdmin) {
    throw new AppError(500, "Supabase Admin no esta configurado", {
      code: "SUPABASE_ADMIN_NOT_CONFIGURED",
    });
  }

  const randomPassword = buildRandomPassword();
  const createAuth = await app.supabaseAdmin.auth.admin.createUser({
    email,
    password: randomPassword,
    email_confirm: true,
    user_metadata: { full_name: `${nombres} ${apellidos}`.trim() },
  });

  if (createAuth.error || !createAuth.data?.user?.id) {
    throw new AppError(500, "No se pudo crear la identidad en Supabase Auth", {
      code: "PERSONAS_AUTH_CREATE_ERROR",
      details: createAuth.error?.message || "AUTH_CREATE_FAILED",
    });
  }

  return createAuth.data.user.id;
}

async function deleteAuthIdentity(app, request, authUserId) {
  if (!authUserId || !app.supabaseAdmin) return;
  const rollbackAuth = await app.supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (rollbackAuth.error) {
    request.log.error({ err: rollbackAuth.error, authUserId }, "Compensacion de auth.users fallo");
  }
}

async function sendPasswordSetupEmail(app, email) {
  if (!app.supabaseAdmin) {
    return {
      sent: false,
      message: "Supabase Admin no configurado para generar enlace de configuracion",
    };
  }

  if (!app.mailer?.configured) {
    return {
      sent: false,
      message: "Servicio SMTP no configurado para enviar correo de configuracion",
    };
  }

  try {
    // AM: Flujo Opcion 2: recovery link por Supabase Admin + entrega SMTP backend.
    const recovery = await generateRecoveryActionLink(app, email);
    if (!recovery.found || !recovery.action_link) {
      return {
        sent: false,
        message: "No se encontro identidad en Auth para enviar configuracion",
      };
    }

    const delivery = await app.mailer.sendPasswordRecoveryEmail({
      to: email,
      actionLink: recovery.action_link,
      kind: "setup",
    });

    if (!delivery.sent) {
      return {
        sent: false,
        message: delivery.message || "No se pudo enviar el correo de configuracion",
      };
    }

    return { sent: true, message: "Correo de configuracion enviado por SMTP" };
  } catch (error) {
    return {
      sent: false,
      message: error instanceof Error ? error.message : "No se pudo enviar el correo de configuracion",
    };
  }
}

function buildPersonaPayload(rawPersona) {
  const nombres = normalizeRequired(rawPersona?.nombres);
  const apellidos = normalizeRequired(rawPersona?.apellidos);
  const fechaNacimiento = normalizeDateOnly(rawPersona?.fecha_nacimiento ?? null);
  const generoCodigo = normalizeOptional(rawPersona?.genero_codigo ?? null);
  const dni = normalizeDigits(rawPersona?.dni ?? null);
  const rtn = normalizeDigits(rawPersona?.rtn ?? null);
  const telefonoPrincipal = normalizeOptional(rawPersona?.telefono_principal ?? null);
  const direccionTexto = normalizeOptional(rawPersona?.direccion_texto ?? null);
  const observaciones = normalizeOptional(rawPersona?.observaciones ?? null);

  if (!nombres || !apellidos) {
    throw new AppError(400, "persona.nombres y persona.apellidos son obligatorios", {
      code: "PERSONAS_REQUIRED_FIELDS",
    });
  }

  assertBirthDateNotFuture(fechaNacimiento);
  assertDni(dni);
  assertRtn(rtn);

  return {
    nombres,
    apellidos,
    fecha_nacimiento: fechaNacimiento,
    genero_codigo: generoCodigo,
    dni,
    rtn,
    telefono_principal: telefonoPrincipal,
    direccion_texto: direccionTexto,
    observaciones,
  };
}

async function createEmpleado(app, request, payload) {
  const client = await app.db.connect();
  let authUserId = null;
  let transactionStarted = false;

  try {
    const persona = buildPersonaPayload(payload?.persona || {});
    const correoPrincipal = normalizeEmail(payload?.acceso?.correo_principal);
    const empleadoRaw = payload?.empleado || {};
    const idSucursal = await ensureActiveBranch(client, empleadoRaw.id_sucursal);
    const esBarbero = Boolean(empleadoRaw.es_barbero);
    const roles = parseEmployeeRoleNames(payload?.acceso?.roles, esBarbero);
    const salarioBase = normalizeMoney(empleadoRaw.salario_base);

    assertValidEmail(correoPrincipal);
    await ensureEmailAvailability(client, correoPrincipal);

    const roleIdsByName = await loadRoleIdByName(client);
    for (const role of roles) {
      if (!roleIdsByName.has(role)) {
        throw new AppError(400, `Rol invalido: ${role}`, {
          code: "PERSONAS_ROLE_NOT_FOUND",
        });
      }
      if (BRANCH_REQUIRED_ROLES.has(role) && !idSucursal) {
        throw new AppError(400, `El rol ${role} requiere id_sucursal`, {
          code: "PERSONAS_ROLE_SCOPE_REQUIRED",
        });
      }
    }

    authUserId = await createAuthIdentity(app, {
      email: correoPrincipal,
      nombres: persona.nombres,
      apellidos: persona.apellidos,
    });

    await client.query("BEGIN");
    transactionStarted = true;

    const personaInsert = await client.query(
      `
        INSERT INTO public.personas (
          nombres,
          apellidos,
          fecha_nacimiento,
          genero_codigo,
          dni,
          rtn,
          telefono_principal,
          direccion_texto,
          observaciones
        )
        VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
        RETURNING id_persona
      `,
      [
        persona.nombres,
        persona.apellidos,
        persona.fecha_nacimiento,
        persona.genero_codigo,
        persona.dni,
        persona.rtn,
        persona.telefono_principal,
        persona.direccion_texto,
        persona.observaciones,
      ]
    );

    const idPersona = personaInsert.rows[0].id_persona;

    await upsertPrimaryEmail(client, idPersona, correoPrincipal);

    await client.query(
      `
        INSERT INTO public.usuarios (
          id_usuario,
          id_persona,
          estado,
          estado_acceso,
          credenciales_completadas_at,
          ultimo_login_at
        )
        VALUES ($1::uuid, $2::uuid, TRUE, $3, NULL, NULL)
      `,
      [authUserId, idPersona, ACCESS_STATUS.PENDING_PASSWORD]
    );

    await setEmployeeRoleAssignments(client, {
      roleIdsByName,
      roleNames: roles,
      userId: authUserId,
      branchId: idSucursal,
      assignedBy: request.claims?.user?.id_usuario ?? null,
    });

    const fechaIngreso = normalizeOptional(empleadoRaw.fecha_ingreso ?? null);
    await client.query(
      `
        INSERT INTO public.empleados (
          id_persona,
          id_sucursal,
          fecha_ingreso,
          salario_base,
          estado,
          es_barbero
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          COALESCE($3::timestamptz, NOW()),
          $4::numeric,
          COALESCE($5::boolean, TRUE),
          $6::boolean
        )
      `,
      [idPersona, idSucursal, fechaIngreso, salarioBase, empleadoRaw.estado ?? true, esBarbero]
    );

    const detail = await client.query(EMPLEADO_BY_USER_SQL, [authUserId]);

    await client.query("COMMIT");
    transactionStarted = false;

    const setupResult = await sendPasswordSetupEmail(app, correoPrincipal);

    return {
      empleado: mapEmpleado(detail.rows[0]),
      setup_password: {
        requerido: true,
        enviado: setupResult.sent,
        mensaje: setupResult.message,
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    // AM: Compensacion de identidad para evitar huella en auth.users cuando falla el dominio.
    await deleteAuthIdentity(app, request, authUserId);
    throw error;
  } finally {
    client.release();
  }
}

async function updateEmpleado(app, request, idEmpleado, payload) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);
    if (!current.rowCount) {
      throw new AppError(404, "Empleado no encontrado", {
        code: "PERSONAS_EMPLOYEE_NOT_FOUND",
      });
    }

    const currentRow = current.rows[0];
    if (!currentRow.id_usuario) {
      throw new AppError(409, "El empleado no tiene usuario interno vinculado", {
        code: "PERSONAS_EMPLOYEE_WITHOUT_USER",
      });
    }

    const persona = buildPersonaPayload(payload?.persona || {});
    const correoPrincipal = normalizeEmail(payload?.acceso?.correo_principal);
    const empleadoRaw = payload?.empleado || {};
    const idSucursal = await ensureActiveBranch(client, empleadoRaw.id_sucursal);
    const esBarbero = Boolean(empleadoRaw.es_barbero);
    const roles = parseEmployeeRoleNames(payload?.acceso?.roles, esBarbero);
    const salarioBase = normalizeMoney(empleadoRaw.salario_base);

    assertValidEmail(correoPrincipal);
    await ensureEmailAvailability(client, correoPrincipal, {
      excludePersonaId: currentRow.id_persona,
      excludeUserId: currentRow.id_usuario,
    });

    const roleIdsByName = await loadRoleIdByName(client);

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.personas
        SET nombres = $2,
            apellidos = $3,
            fecha_nacimiento = $4::date,
            genero_codigo = $5,
            dni = $6,
            rtn = $7,
            telefono_principal = $8,
            direccion_texto = $9,
            observaciones = $10,
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [
        currentRow.id_persona,
        persona.nombres,
        persona.apellidos,
        persona.fecha_nacimiento,
        persona.genero_codigo,
        persona.dni,
        persona.rtn,
        persona.telefono_principal,
        persona.direccion_texto,
        persona.observaciones,
      ]
    );

    await upsertPrimaryEmail(client, currentRow.id_persona, correoPrincipal);

    await client.query(
      `
        UPDATE public.empleados
        SET id_sucursal = $2::uuid,
            fecha_ingreso = COALESCE($3::timestamptz, fecha_ingreso),
            salario_base = $4::numeric,
            estado = COALESCE($5::boolean, estado),
            es_barbero = $6::boolean,
            updated_at = NOW()
        WHERE id_empleado = $1::uuid
      `,
      [
        idEmpleado,
        idSucursal,
        normalizeOptional(empleadoRaw.fecha_ingreso ?? null),
        salarioBase,
        empleadoRaw.estado,
        esBarbero,
      ]
    );

    await setEmployeeRoleAssignments(client, {
      roleIdsByName,
      roleNames: roles,
      userId: currentRow.id_usuario,
      branchId: idSucursal,
      assignedBy: request.claims?.user?.id_usuario ?? null,
    });

    const detail = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);

    await client.query("COMMIT");
    transactionStarted = false;

    return { empleado: mapEmpleado(detail.rows[0]) };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createCliente(app, request, payload) {
  const client = await app.db.connect();
  let authUserId = null;
  let transactionStarted = false;

  try {
    const persona = buildPersonaPayload(payload?.persona || {});
    const acceso = payload?.acceso || {};
    const cliente = payload?.cliente || {};
    const habilitarAcceso = Boolean(acceso.habilitar_acceso);
    const correoPrincipal = normalizeEmail(acceso.correo_principal);
    const idSucursalOrigen = await ensureActiveBranch(client, cliente.id_sucursal_origen ?? null);
    const fechaIngreso = normalizeOptional(cliente.fecha_ingreso ?? null);
    const consentimientoMarketing = Boolean(cliente.consentimiento_marketing);
    const aceptaTerminos = Boolean(cliente.acepta_terminos);
    const consentimientosAt = new Date().toISOString();
    const consentimientoMarketingAt = consentimientoMarketing ? consentimientosAt : null;
    const aceptaTerminosAt = aceptaTerminos ? consentimientosAt : null;

    if (!correoPrincipal) {
      throw new AppError(400, "Cliente requiere correo_principal obligatorio", {
        code: "PERSONAS_CLIENT_EMAIL_REQUIRED",
      });
    }
    assertValidEmail(correoPrincipal);
    await ensureEmailAvailability(client, correoPrincipal);

    if (habilitarAcceso) {
      if (!idSucursalOrigen) {
        throw new AppError(400, "Cliente con acceso requiere id_sucursal_origen activo", {
          code: "PERSONAS_CLIENT_BRANCH_REQUIRED",
        });
      }
      authUserId = await createAuthIdentity(app, {
        email: correoPrincipal,
        nombres: persona.nombres,
        apellidos: persona.apellidos,
      });
    }

    const roleIdsByName = await loadRoleIdByName(client);

    await client.query("BEGIN");
    transactionStarted = true;

    const personaInsert = await client.query(
      `
        INSERT INTO public.personas (
          nombres,
          apellidos,
          fecha_nacimiento,
          genero_codigo,
          dni,
          rtn,
          telefono_principal,
          direccion_texto,
          observaciones
        )
        VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
        RETURNING id_persona
      `,
      [
        persona.nombres,
        persona.apellidos,
        persona.fecha_nacimiento,
        persona.genero_codigo,
        persona.dni,
        persona.rtn,
        persona.telefono_principal,
        persona.direccion_texto,
        persona.observaciones,
      ]
    );

    const idPersona = personaInsert.rows[0].id_persona;

    if (correoPrincipal) {
      await upsertPrimaryEmail(client, idPersona, correoPrincipal);
    }

    if (habilitarAcceso) {
      await client.query(
        `
          INSERT INTO public.usuarios (
            id_usuario,
            id_persona,
            estado,
            estado_acceso,
            credenciales_completadas_at,
            ultimo_login_at
          )
          VALUES ($1::uuid, $2::uuid, TRUE, $3, NULL, NULL)
        `,
        [authUserId, idPersona, ACCESS_STATUS.PENDING_PASSWORD]
      );

      await ensureClienteRoleAssignment(
        client,
        roleIdsByName,
        authUserId,
        idSucursalOrigen,
        request.claims?.user?.id_usuario ?? null
      );
    }

    const hasConsentTimestampColumns = await hasClientsConsentTimestampColumns(client);
    const clienteInsert = hasConsentTimestampColumns
      ? await client.query(
          `
            INSERT INTO public.clientes (
              id_persona,
              id_usuario,
              fecha_ingreso,
              id_sucursal_origen,
              estado,
              consentimiento_marketing,
              acepta_terminos,
              consentimiento_marketing_at,
              acepta_terminos_at
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              COALESCE($3::timestamptz, NOW()),
              $4::uuid,
              COALESCE($5::boolean, TRUE),
              COALESCE($6::boolean, FALSE),
              COALESCE($7::boolean, FALSE),
              $8::timestamptz,
              $9::timestamptz
            )
            RETURNING id_cliente
          `,
          [
            idPersona,
            authUserId,
            fechaIngreso,
            idSucursalOrigen,
            cliente.estado,
            consentimientoMarketing,
            aceptaTerminos,
            consentimientoMarketingAt,
            aceptaTerminosAt,
          ]
        )
      : await client.query(
          `
            INSERT INTO public.clientes (
              id_persona,
              id_usuario,
              fecha_ingreso,
              id_sucursal_origen,
              estado,
              consentimiento_marketing,
              acepta_terminos
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              COALESCE($3::timestamptz, NOW()),
              $4::uuid,
              COALESCE($5::boolean, TRUE),
              COALESCE($6::boolean, FALSE),
              COALESCE($7::boolean, FALSE)
            )
            RETURNING id_cliente
          `,
          [
            idPersona,
            authUserId,
            fechaIngreso,
            idSucursalOrigen,
            cliente.estado,
            consentimientoMarketing,
            aceptaTerminos,
          ]
        );

    const detail = await client.query(CLIENTE_BY_ID_SQL, [clienteInsert.rows[0].id_cliente]);

    await client.query("COMMIT");
    transactionStarted = false;

    let setupPassword = null;
    if (habilitarAcceso) {
      const setupResult = await sendPasswordSetupEmail(app, correoPrincipal);
      setupPassword = {
        requerido: true,
        enviado: setupResult.sent,
        mensaje: setupResult.message,
      };
    }

    return {
      cliente: mapCliente(detail.rows[0]),
      ...(setupPassword ? { setup_password: setupPassword } : {}),
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    // AM: Compensacion de identidad para no dejar auth.users sin relacion de dominio.
    await deleteAuthIdentity(app, request, authUserId);
    throw error;
  } finally {
    client.release();
  }
}

async function sendUsuarioPasswordSetup(app, userId, body) {
  const markPending = body?.marcar_pendiente_password !== false;
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const userResult = await client.query(
      `
        SELECT
          u.id_usuario,
          u.estado_acceso,
          COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS email
        FROM public.usuarios u
        LEFT JOIN auth.users au ON au.id = u.id_usuario
        LEFT JOIN LATERAL (
          SELECT c.direccion_correo::text AS email
          FROM public.correos c
          WHERE c.id_persona = u.id_persona
            AND c.deleted_at IS NULL
          ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
          LIMIT 1
        ) cp ON TRUE
        WHERE u.id_usuario = $1::uuid
          AND u.deleted_at IS NULL
        LIMIT 1
      `,
      [userId]
    );

    if (!userResult.rowCount) {
      throw new AppError(404, "Usuario no encontrado", { code: "PERSONAS_USER_NOT_FOUND" });
    }

    const userRow = userResult.rows[0];
    const email = normalizeEmail(userRow.email);
    if (!email) {
      throw new AppError(409, "El usuario no tiene correo principal", { code: "PERSONAS_USER_EMAIL_MISSING" });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    if (markPending) {
      await client.query(
        `
          UPDATE public.usuarios
          SET estado_acceso = $2,
              credenciales_completadas_at = NULL,
              updated_at = NOW()
          WHERE id_usuario = $1::uuid
        `,
        [userId, ACCESS_STATUS.PENDING_PASSWORD]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    const setupResult = await sendPasswordSetupEmail(app, email);
    if (!setupResult.sent) {
      // AM: En reenvio manual se exige entrega real para evitar falso positivo en UI.
      throw new AppError(502, "No se pudo enviar el correo de configuracion", {
        code: "PERSONAS_USER_SETUP_DELIVERY_FAILED",
        details: {
          email,
          reason: setupResult.message || "DELIVERY_FAILED",
        },
      });
    }

    return {
      id_usuario: userId,
      email,
      estado_acceso_objetivo: markPending ? ACCESS_STATUS.PENDING_PASSWORD : userRow.estado_acceso,
      setup_password: {
        requerido: true,
        enviado: setupResult.sent,
        mensaje: setupResult.message,
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getUsuarioOrThrow(client, userId) {
  const detail = await client.query(USUARIO_BY_ID_SQL, [userId]);
  if (!detail.rowCount) {
    throw new AppError(404, "Usuario no encontrado", { code: "PERSONAS_USER_NOT_FOUND" });
  }
  return { raw: detail.rows[0], usuario: mapUsuario(detail.rows[0]) };
}

async function syncAuthUserEmail(app, userId, email) {
  if (!app.supabaseAdmin) {
    throw new AppError(500, "Supabase Admin no esta configurado", {
      code: "SUPABASE_ADMIN_NOT_CONFIGURED",
    });
  }
  const updateAuth = await app.supabaseAdmin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (updateAuth.error) {
    throw new AppError(500, "No se pudo sincronizar correo en Supabase Auth", {
      code: "PERSONAS_AUTH_EMAIL_SYNC_ERROR",
      details: updateAuth.error.message || "AUTH_EMAIL_UPDATE_FAILED",
    });
  }
}

async function deactivateUserRolesByNames(client, userId, roleNames) {
  if (!Array.isArray(roleNames) || !roleNames.length) return;

  const roleIdsByName = await loadRoleIdByName(client);
  const roleIds = roleNames.map((name) => roleIdsByName.get(name)).filter(Boolean);
  if (!roleIds.length) return;

  await client.query(
    `
      UPDATE public.roles_usuarios
      SET activo = FALSE,
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND id_rol = ANY($2::uuid[])
        AND activo IS TRUE
    `,
    [userId, roleIds]
  );
}

async function blockUserAccessByLifecycle(client, userId) {
  if (!userId) return;
  // AM: Regla de negocio: al inactivar empleado/cliente se bloquea su usuario relacionado.
  await client.query(
    `
      UPDATE public.usuarios
      SET estado_acceso = $2,
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
    `,
    [userId, ACCESS_STATUS.BLOCKED]
  );
}

async function restoreUserAccessByLifecycle(client, userId) {
  if (!userId) return;
  // AM: Reactivacion de ciclo de vida: vuelve a activo o pendiente_password segun avance real de credenciales.
  await client.query(
    `
      UPDATE public.usuarios
      SET estado = TRUE,
          estado_acceso = CASE
            WHEN credenciales_completadas_at IS NULL THEN $2
            ELSE $3
          END,
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
    `,
    [userId, ACCESS_STATUS.PENDING_PASSWORD, ACCESS_STATUS.ACTIVE]
  );
}

async function restoreEmployeeRolesByLifecycle(client, { userId, branchId, assignedBy, esBarbero }) {
  if (!userId) return;

  const historicalRolesResult = await client.query(
    `
      SELECT DISTINCT r.nombre AS role_name
      FROM public.roles_usuarios ru
      JOIN public.roles r
        ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1::uuid
        AND r.nombre = ANY($2::text[])
    `,
    [userId, [...EMPLOYEE_ALLOWED_ROLES]]
  );

  const historicalRoleNames = historicalRolesResult.rows
    .map((row) => String(row.role_name || "").trim().toLowerCase())
    .filter((value) => EMPLOYEE_ALLOWED_ROLES.has(value));

  let candidateRoles = [...new Set(historicalRoleNames)];
  if (candidateRoles.includes("super_admin")) {
    candidateRoles = ["super_admin"];
  } else {
    if (!esBarbero) {
      candidateRoles = candidateRoles.filter((role) => role !== "barbero");
    }
    if (esBarbero && !candidateRoles.includes("barbero")) {
      candidateRoles.push("barbero");
    }
  }

  if (!candidateRoles.length) {
    // AM: Fallback de seguridad cuando no hay historial de roles internos reutilizable.
    candidateRoles = esBarbero ? ["barbero"] : ["admin"];
  }

  const normalizedRoles = candidateRoles.includes("super_admin")
    ? ["super_admin"]
    : parseEmployeeRoleNames(candidateRoles, esBarbero);
  if (normalizedRoles.some((role) => BRANCH_REQUIRED_ROLES.has(role)) && !branchId) {
    throw new AppError(409, "No se puede activar empleado sin sucursal valida para sus roles internos", {
      code: "PERSONAS_EMPLOYEE_ACTIVATE_BRANCH_REQUIRED",
    });
  }

  const roleIdsByName = await loadRoleIdByName(client);
  await setEmployeeRoleAssignments(client, {
    roleIdsByName,
    roleNames: normalizedRoles,
    userId,
    branchId,
    assignedBy,
  });
}

async function updateUsuario(app, request, userId, payload) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await getUsuarioOrThrow(client, userId);
    const raw = current.raw;
    const currentUsuario = current.usuario;

    const personaPatch = payload?.persona || {};
    const accesoPatch = payload?.acceso || {};
    const hasPersonaPatch = Object.keys(personaPatch).length > 0;
    const hasAccessPatch = Object.keys(accesoPatch).length > 0;

    if (!hasPersonaPatch && !hasAccessPatch) {
      throw new AppError(400, "Debes enviar al menos un cambio en persona o acceso", {
        code: "PERSONAS_USER_UPDATE_EMPTY",
      });
    }

    const hasNewNames = personaPatch.nombres !== undefined;
    const hasNewLastNames = personaPatch.apellidos !== undefined;
    const hasNewPhone = personaPatch.telefono_principal !== undefined;
    const hasNewEmail = accesoPatch.correo_principal !== undefined;
    const hasNewRole = accesoPatch.rol_principal !== undefined;
    const hasNewBranch = accesoPatch.id_sucursal !== undefined;

    const nextNombres = hasNewNames ? normalizeRequired(personaPatch.nombres) : normalizeRequired(raw.nombres);
    const nextApellidos = hasNewLastNames ? normalizeRequired(personaPatch.apellidos) : normalizeRequired(raw.apellidos);
    const nextPhone = hasNewPhone ? normalizeOptional(personaPatch.telefono_principal) : normalizeOptional(raw.telefono_principal);

    const currentEmail = normalizeEmail(raw.email ?? "");
    const requestedEmail = hasNewEmail ? normalizeEmail(accesoPatch.correo_principal) : currentEmail;
    if (hasNewEmail && !requestedEmail) {
      throw new AppError(400, "correo_principal no puede quedar vacio para un usuario con acceso", {
        code: "PERSONAS_USER_EMAIL_REQUIRED",
      });
    }
    if (requestedEmail) {
      assertValidEmail(requestedEmail);
    }

    const targetRoleName = hasNewRole ? normalizeRequired(accesoPatch.rol_principal).toLowerCase() : null;
    const targetBranchId = hasNewBranch ? await ensureActiveBranch(client, accesoPatch.id_sucursal) : null;
    const requestedRoleBranch = hasNewRole
      ? targetRoleName === "super_admin"
        ? null
        : await ensureActiveBranch(client, accesoPatch.id_sucursal)
      : null;

    if (targetRoleName && targetRoleName !== "super_admin" && !requestedRoleBranch) {
      throw new AppError(400, `El rol ${targetRoleName} requiere id_sucursal activo`, {
        code: "PERSONAS_ROLE_SCOPE_REQUIRED",
      });
    }

    if (hasNewEmail && requestedEmail !== currentEmail) {
      await ensureEmailAvailability(client, requestedEmail, {
        excludePersonaId: raw.id_persona,
        excludeUserId: raw.id_usuario,
      });
    }

    const roleIdsByName = hasNewRole || hasNewBranch ? await loadRoleIdByName(client) : null;

    if (targetRoleName) {
      if (!roleIdsByName?.has(targetRoleName)) {
        throw new AppError(400, `Rol no encontrado: ${targetRoleName}`, {
          code: "PERSONAS_ROLE_NOT_FOUND",
        });
      }

      // AM: Reglas de dominio para mantener coherencia entre perfil y rol principal.
      if (["super_admin", "admin", "barbero"].includes(targetRoleName) && !currentUsuario.tiene_empleado) {
        throw new AppError(409, "Solo un empleado puede tener rol super_admin/admin/barbero", {
          code: "PERSONAS_USER_ROLE_EMPLOYEE_REQUIRED",
        });
      }

      if (targetRoleName === "cliente" && !currentUsuario.tiene_cliente) {
        throw new AppError(409, "Solo un cliente puede tener rol cliente", {
          code: "PERSONAS_USER_ROLE_CLIENT_REQUIRED",
        });
      }
    }

    await client.query("BEGIN");
    transactionStarted = true;

    if (hasPersonaPatch) {
      await client.query(
        `
          UPDATE public.personas
          SET nombres = $2,
              apellidos = $3,
              telefono_principal = $4,
              updated_at = NOW()
          WHERE id_persona = $1::uuid
        `,
        [raw.id_persona, nextNombres, nextApellidos, nextPhone]
      );
    }

    if (hasNewEmail && requestedEmail) {
      await upsertPrimaryEmail(client, raw.id_persona, requestedEmail);
      if (requestedEmail !== currentEmail) {
        await syncAuthUserEmail(app, raw.id_usuario, requestedEmail);
      }
    }

    if (targetRoleName) {
      const roleId = roleIdsByName.get(targetRoleName);
      const revived = await client.query(
        `
          UPDATE public.roles_usuarios
          SET id_sucursal = $3::uuid,
              activo = TRUE,
              asignado_por = $4::uuid,
              updated_at = NOW()
          WHERE id_usuario = $1::uuid
            AND id_rol = $2::uuid
        `,
        [raw.id_usuario, roleId, requestedRoleBranch, request.claims?.user?.id_usuario ?? null]
      );

      if (!revived.rowCount) {
        await client.query(
          `
            INSERT INTO public.roles_usuarios (id_rol, id_usuario, id_sucursal, activo, asignado_por)
            VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE, $4::uuid)
          `,
          [roleId, raw.id_usuario, requestedRoleBranch, request.claims?.user?.id_usuario ?? null]
        );
      }

      if (currentUsuario.tiene_empleado) {
        const activeBarberRole = await client.query(
          `
            SELECT 1
            FROM public.roles_usuarios ru
            JOIN public.roles r
              ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = $1::uuid
              AND ru.activo IS TRUE
              AND r.nombre = 'barbero'
            LIMIT 1
          `,
          [raw.id_usuario]
        );
        const nextIsBarber = activeBarberRole.rowCount > 0;
        await client.query(
          `
            UPDATE public.empleados
            SET es_barbero = $2::boolean,
                id_sucursal = CASE
                  WHEN $3::uuid IS NULL THEN id_sucursal
                  ELSE $3::uuid
                END,
                updated_at = NOW()
            WHERE id_persona = $1::uuid
              AND deleted_at IS NULL
          `,
          [raw.id_persona, nextIsBarber, requestedRoleBranch]
        );
      }
    } else if (targetBranchId) {
      await client.query(
        `
          UPDATE public.roles_usuarios ru
          SET id_sucursal = $2::uuid,
              updated_at = NOW()
          FROM public.roles r
          WHERE ru.id_usuario = $1::uuid
            AND ru.activo IS TRUE
            AND ru.id_rol = r.id_rol
            AND r.nombre <> 'super_admin'
        `,
        [raw.id_usuario, targetBranchId]
      );

      if (currentUsuario.tiene_empleado) {
        await client.query(
          `
            UPDATE public.empleados
            SET id_sucursal = $2::uuid,
                updated_at = NOW()
            WHERE id_persona = $1::uuid
              AND deleted_at IS NULL
          `,
          [raw.id_persona, targetBranchId]
        );
      }
    }

    const detail = await getUsuarioOrThrow(client, userId);

    await client.query("COMMIT");
    transactionStarted = false;

    return { usuario: detail.usuario };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateUsuarioAccessStatus(app, userId, status) {
  if (!Object.values(ACCESS_STATUS).includes(status)) {
    throw new AppError(400, `estado_acceso invalido: ${status}`, {
      code: "PERSONAS_USER_ACCESS_STATUS_INVALID",
    });
  }

  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    await getUsuarioOrThrow(client, userId);

    if (status === ACCESS_STATUS.ACTIVE) {
      const activationGuard = await client.query(
        `
          SELECT
            EXISTS (
              SELECT 1
              FROM public.roles_usuarios ru
              WHERE ru.id_usuario = $1::uuid
                AND ru.activo IS TRUE
            ) AS has_active_roles,
            EXISTS (
              SELECT 1
              FROM public.usuarios u
              JOIN public.empleados e
                ON e.id_persona = u.id_persona
              WHERE u.id_usuario = $1::uuid
                AND e.deleted_at IS NULL
            ) AS has_empleado,
            EXISTS (
              SELECT 1
              FROM public.usuarios u
              JOIN public.empleados e
                ON e.id_persona = u.id_persona
              WHERE u.id_usuario = $1::uuid
                AND e.deleted_at IS NULL
                AND e.estado IS TRUE
            ) AS has_empleado_activo,
            EXISTS (
              SELECT 1
              FROM public.clientes c
              WHERE c.id_usuario = $1::uuid
                AND c.deleted_at IS NULL
            ) AS has_cliente,
            EXISTS (
              SELECT 1
              FROM public.clientes c
              WHERE c.id_usuario = $1::uuid
                AND c.deleted_at IS NULL
                AND c.estado IS TRUE
            ) AS has_cliente_activo
        `,
        [userId]
      );

      const guard = activationGuard.rows[0] || {};
      if (!guard.has_active_roles) {
        throw new AppError(409, "No se puede activar usuario sin roles activos. Activa primero su perfil empleado/cliente.", {
          code: "PERSONAS_USER_ACTIVATE_ROLE_REQUIRED",
        });
      }
      if (guard.has_empleado && !guard.has_empleado_activo) {
        throw new AppError(409, "No se puede activar usuario: el empleado relacionado esta inactivo", {
          code: "PERSONAS_USER_ACTIVATE_EMPLOYEE_INACTIVE",
        });
      }
      if (guard.has_cliente && !guard.has_cliente_activo) {
        throw new AppError(409, "No se puede activar usuario: el cliente relacionado esta inactivo", {
          code: "PERSONAS_USER_ACTIVATE_CLIENT_INACTIVE",
        });
      }
    }

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.usuarios
        SET estado_acceso = $2,
            credenciales_completadas_at = CASE
              WHEN $2 = $3 THEN NULL
              WHEN $2 = $4 THEN COALESCE(credenciales_completadas_at, NOW())
              ELSE credenciales_completadas_at
            END,
            updated_at = NOW()
        WHERE id_usuario = $1::uuid
      `,
      [userId, status, ACCESS_STATUS.PENDING_PASSWORD, ACCESS_STATUS.ACTIVE]
    );

    const detail = await getUsuarioOrThrow(client, userId);

    await client.query("COMMIT");
    transactionStarted = false;

    return { usuario: detail.usuario };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function inactivateEmpleado(app, idEmpleado) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);
    if (!current.rowCount) {
      throw new AppError(404, "Empleado no encontrado", {
        code: "PERSONAS_EMPLOYEE_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.empleados
        SET estado = FALSE,
            updated_at = NOW()
        WHERE id_empleado = $1::uuid
      `,
      [idEmpleado]
    );

    if (row.id_usuario) {
      await deactivateUserRolesByNames(client, row.id_usuario, [...EMPLOYEE_ALLOWED_ROLES]);
      await blockUserAccessByLifecycle(client, row.id_usuario);
    }

    const detail = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);

    await client.query("COMMIT");
    transactionStarted = false;

    return { empleado: mapEmpleado(detail.rows[0]) };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function activateEmpleado(app, request, idEmpleado) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);
    if (!current.rowCount) {
      throw new AppError(404, "Empleado no encontrado", {
        code: "PERSONAS_EMPLOYEE_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.empleados
        SET estado = TRUE,
            updated_at = NOW()
        WHERE id_empleado = $1::uuid
      `,
      [idEmpleado]
    );

    if (row.id_usuario) {
      await restoreEmployeeRolesByLifecycle(client, {
        userId: row.id_usuario,
        branchId: row.id_sucursal,
        assignedBy: request.claims?.user?.id_usuario ?? null,
        esBarbero: Boolean(row.es_barbero),
      });
      await restoreUserAccessByLifecycle(client, row.id_usuario);
    }

    const detail = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);

    await client.query("COMMIT");
    transactionStarted = false;

    return { empleado: mapEmpleado(detail.rows[0]) };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateCliente(app, request, idCliente, payload) {
  const client = await app.db.connect();
  let authUserId = null;
  let transactionStarted = false;

  try {
    const current = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);
    if (!current.rowCount) {
      throw new AppError(404, "Cliente no encontrado", {
        code: "PERSONAS_CLIENT_NOT_FOUND",
      });
    }

    const currentRow = current.rows[0];
    const persona = buildPersonaPayload(payload?.persona || {});
    const acceso = payload?.acceso || {};
    const cliente = payload?.cliente || {};
    const consentimientosAt = new Date().toISOString();

    const hasHabilitarAccesoPatch = acceso.habilitar_acceso !== undefined;
    const hasCurrentAccessState =
      currentRow?.id_usuario !== undefined || currentRow?.tiene_acceso !== undefined;
    if (!hasHabilitarAccesoPatch && !hasCurrentAccessState) {
      throw new AppError(500, "No se pudo resolver el estado actual de acceso del cliente", {
        code: "PERSONAS_CLIENT_ACCESS_STATE_UNRESOLVED",
      });
    }
    const currentHabilitarAcceso =
      currentRow?.tiene_acceso !== undefined ? Boolean(currentRow.tiene_acceso) : Boolean(currentRow?.id_usuario);
    const habilitarAcceso = hasHabilitarAccesoPatch ? Boolean(acceso.habilitar_acceso) : currentHabilitarAcceso;
    const correoPrincipal = normalizeEmail(acceso.correo_principal ?? currentRow.correo_principal ?? "");
    const idSucursalOrigen = await ensureActiveBranch(client, cliente.id_sucursal_origen ?? currentRow.id_sucursal_origen ?? null);
    const fechaIngreso = normalizeOptional(cliente.fecha_ingreso ?? currentRow.fecha_ingreso ?? null);

    if (currentRow.id_usuario && !habilitarAcceso) {
      throw new AppError(400, "El cliente ya tiene acceso. Usa accion de inactivar para restringirlo.", {
        code: "PERSONAS_CLIENT_ACCESS_DISABLE_NOT_ALLOWED",
      });
    }

    if (!correoPrincipal) {
      throw new AppError(400, "Cliente requiere correo_principal obligatorio", {
        code: "PERSONAS_CLIENT_EMAIL_REQUIRED",
      });
    }
    assertValidEmail(correoPrincipal);

    if (habilitarAcceso) {
      if (!idSucursalOrigen) {
        throw new AppError(400, "Cliente con acceso requiere id_sucursal_origen activo", {
          code: "PERSONAS_CLIENT_BRANCH_REQUIRED",
        });
      }
    }

    await ensureEmailAvailability(client, correoPrincipal, {
      excludePersonaId: currentRow.id_persona,
      excludeUserId: currentRow.id_usuario ?? null,
    });

    const hasConsentTimestampColumns = await hasClientsConsentTimestampColumns(client);
    const currentConsents = hasConsentTimestampColumns
      ? await client.query(
          `
            SELECT
              COALESCE(consentimiento_marketing, FALSE) AS consentimiento_marketing,
              COALESCE(acepta_terminos, FALSE) AS acepta_terminos,
              consentimiento_marketing_at,
              acepta_terminos_at
            FROM public.clientes
            WHERE id_cliente = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [idCliente]
        )
      : await client.query(
          `
            SELECT
              COALESCE(consentimiento_marketing, FALSE) AS consentimiento_marketing,
              COALESCE(acepta_terminos, FALSE) AS acepta_terminos,
              NULL::timestamptz AS consentimiento_marketing_at,
              NULL::timestamptz AS acepta_terminos_at
            FROM public.clientes
            WHERE id_cliente = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [idCliente]
        );
    if (!currentConsents.rowCount) {
      throw new AppError(404, "Cliente no encontrado", {
        code: "PERSONAS_CLIENT_NOT_FOUND",
      });
    }
    const currentConsentRow = currentConsents.rows[0];

    const nextConsentimientoMarketing =
      cliente.consentimiento_marketing === undefined
        ? Boolean(currentConsentRow.consentimiento_marketing)
        : Boolean(cliente.consentimiento_marketing);
    const nextAceptaTerminos =
      cliente.acepta_terminos === undefined
        ? Boolean(currentConsentRow.acepta_terminos)
        : Boolean(cliente.acepta_terminos);

    const nextConsentimientoMarketingAt = nextConsentimientoMarketing
      ? (Boolean(currentConsentRow.consentimiento_marketing) &&
        currentConsentRow.consentimiento_marketing_at
          ? currentConsentRow.consentimiento_marketing_at
          : consentimientosAt)
      : null;
    const nextAceptaTerminosAt = nextAceptaTerminos
      ? (Boolean(currentConsentRow.acepta_terminos) && currentConsentRow.acepta_terminos_at
          ? currentConsentRow.acepta_terminos_at
          : consentimientosAt)
      : null;

    const roleIdsByName = await loadRoleIdByName(client);
    if (habilitarAcceso && !currentRow.id_usuario) {
      authUserId = await createAuthIdentity(app, {
        email: correoPrincipal,
        nombres: persona.nombres,
        apellidos: persona.apellidos,
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.personas
        SET nombres = $2,
            apellidos = $3,
            fecha_nacimiento = $4::date,
            genero_codigo = $5,
            dni = $6,
            rtn = $7,
            telefono_principal = $8,
            direccion_texto = $9,
            observaciones = $10,
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [
        currentRow.id_persona,
        persona.nombres,
        persona.apellidos,
        persona.fecha_nacimiento,
        persona.genero_codigo,
        persona.dni,
        persona.rtn,
        persona.telefono_principal,
        persona.direccion_texto,
        persona.observaciones,
      ]
    );

    if (correoPrincipal) {
      await upsertPrimaryEmail(client, currentRow.id_persona, correoPrincipal);
    }

    let nextUserId = currentRow.id_usuario ?? null;
    if (habilitarAcceso && !currentRow.id_usuario) {
      nextUserId = authUserId;
      await client.query(
        `
          INSERT INTO public.usuarios (
            id_usuario,
            id_persona,
            estado,
            estado_acceso,
            credenciales_completadas_at,
            ultimo_login_at
          )
          VALUES ($1::uuid, $2::uuid, TRUE, $3, NULL, NULL)
        `,
        [nextUserId, currentRow.id_persona, ACCESS_STATUS.PENDING_PASSWORD]
      );
    }

    if (habilitarAcceso && nextUserId) {
      await ensureClienteRoleAssignment(
        client,
        roleIdsByName,
        nextUserId,
        idSucursalOrigen,
        request.claims?.user?.id_usuario ?? null
      );
      await client.query(
        `
          UPDATE public.usuarios
          SET estado_acceso = CASE
                WHEN estado_acceso = $2 THEN $3
                ELSE estado_acceso
              END,
              updated_at = NOW()
          WHERE id_usuario = $1::uuid
        `,
        [nextUserId, ACCESS_STATUS.INACTIVE, ACCESS_STATUS.PENDING_PASSWORD]
      );
    }

    if (correoPrincipal && nextUserId) {
      const previousEmail = normalizeEmail(currentRow.correo_principal ?? "");
      if (previousEmail !== correoPrincipal) {
        await syncAuthUserEmail(app, nextUserId, correoPrincipal);
      }
    }

    if (hasConsentTimestampColumns) {
      await client.query(
        `
          UPDATE public.clientes
          SET id_usuario = $2::uuid,
              fecha_ingreso = COALESCE($3::timestamptz, fecha_ingreso),
              id_sucursal_origen = $4::uuid,
              estado = COALESCE($5::boolean, estado),
              consentimiento_marketing = $6::boolean,
              acepta_terminos = $7::boolean,
              consentimiento_marketing_at = $8::timestamptz,
              acepta_terminos_at = $9::timestamptz,
              updated_at = NOW()
          WHERE id_cliente = $1::uuid
        `,
        [
          idCliente,
          nextUserId,
          fechaIngreso,
          idSucursalOrigen,
          cliente.estado,
          nextConsentimientoMarketing,
          nextAceptaTerminos,
          nextConsentimientoMarketingAt,
          nextAceptaTerminosAt,
        ]
      );
    } else {
      await client.query(
        `
          UPDATE public.clientes
          SET id_usuario = $2::uuid,
              fecha_ingreso = COALESCE($3::timestamptz, fecha_ingreso),
              id_sucursal_origen = $4::uuid,
              estado = COALESCE($5::boolean, estado),
              consentimiento_marketing = $6::boolean,
              acepta_terminos = $7::boolean,
              updated_at = NOW()
          WHERE id_cliente = $1::uuid
        `,
        [
          idCliente,
          nextUserId,
          fechaIngreso,
          idSucursalOrigen,
          cliente.estado,
          nextConsentimientoMarketing,
          nextAceptaTerminos,
        ]
      );
    }

    const detail = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);

    await client.query("COMMIT");
    transactionStarted = false;

    let setupPassword = null;
    if (habilitarAcceso && !currentRow.id_usuario) {
      const setupResult = await sendPasswordSetupEmail(app, correoPrincipal);
      setupPassword = {
        requerido: true,
        enviado: setupResult.sent,
        mensaje: setupResult.message,
      };
    }

    return {
      cliente: mapCliente(detail.rows[0]),
      ...(setupPassword ? { setup_password: setupPassword } : {}),
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    await deleteAuthIdentity(app, request, authUserId);
    throw error;
  } finally {
    client.release();
  }
}

async function inactivateCliente(app, idCliente) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);
    if (!current.rowCount) {
      throw new AppError(404, "Cliente no encontrado", {
        code: "PERSONAS_CLIENT_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.clientes
        SET estado = FALSE,
            updated_at = NOW()
        WHERE id_cliente = $1::uuid
      `,
      [idCliente]
    );

    if (row.id_usuario) {
      await deactivateUserRolesByNames(client, row.id_usuario, ["cliente"]);
      await blockUserAccessByLifecycle(client, row.id_usuario);
    }

    const detail = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);

    await client.query("COMMIT");
    transactionStarted = false;

    return { cliente: mapCliente(detail.rows[0]) };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function activateCliente(app, request, idCliente) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const current = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);
    if (!current.rowCount) {
      throw new AppError(404, "Cliente no encontrado", {
        code: "PERSONAS_CLIENT_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
        UPDATE public.clientes
        SET estado = TRUE,
            updated_at = NOW()
        WHERE id_cliente = $1::uuid
      `,
      [idCliente]
    );

    if (row.id_usuario) {
      const activeBranchId = await ensureActiveBranch(client, row.id_sucursal_origen ?? null);
      if (!activeBranchId) {
        throw new AppError(409, "No se puede activar cliente sin sucursal de origen activa", {
          code: "PERSONAS_CLIENT_ACTIVATE_BRANCH_REQUIRED",
        });
      }

      const roleIdsByName = await loadRoleIdByName(client);
      await ensureClienteRoleAssignment(
        client,
        roleIdsByName,
        row.id_usuario,
        activeBranchId,
        request.claims?.user?.id_usuario ?? null
      );
      await restoreUserAccessByLifecycle(client, row.id_usuario);
    }

    const detail = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);

    await client.query("COMMIT");
    transactionStarted = false;

    return { cliente: mapCliente(detail.rows[0]) };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

function uniqueUuidList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

async function loadPersonaDeletionBundle(client, { personaId = null, userId = null } = {}) {
  let resolvedPersonaId = personaId;
  if (!resolvedPersonaId && userId) {
    const userLookup = await client.query(
      `
        SELECT id_persona
        FROM public.usuarios
        WHERE id_usuario = $1::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [userId]
    );
    resolvedPersonaId = userLookup.rows?.[0]?.id_persona ?? null;
  }

  const employeeRows = resolvedPersonaId
    ? await client.query(
        `
          SELECT id_empleado
          FROM public.empleados
          WHERE id_persona = $1::uuid
            AND deleted_at IS NULL
        `,
        [resolvedPersonaId]
      )
    : { rows: [] };

  const clientRowsByPersona = resolvedPersonaId
    ? await client.query(
        `
          SELECT id_cliente, id_usuario
          FROM public.clientes
          WHERE id_persona = $1::uuid
            AND deleted_at IS NULL
        `,
        [resolvedPersonaId]
      )
    : { rows: [] };

  const userRowsByPersona = resolvedPersonaId
    ? await client.query(
        `
          SELECT id_usuario
          FROM public.usuarios
          WHERE id_persona = $1::uuid
            AND deleted_at IS NULL
        `,
        [resolvedPersonaId]
      )
    : { rows: [] };

  const personaUserIds = userRowsByPersona.rows.map((row) => row.id_usuario);
  if (personaUserIds.length > 1) {
    throw new AppError(409, "No se puede eliminar por ambiguedad: la persona tiene multiples usuarios activos", {
      code: "PERSONAS_DELETE_MULTI_USER_BLOCKED",
      details: { persona_id: resolvedPersonaId, user_ids: personaUserIds },
    });
  }

  const usuarioIds = uniqueUuidList([userId, ...personaUserIds]);

  const clientRowsByUser = usuarioIds.length
    ? await client.query(
        `
          SELECT id_cliente, id_usuario
          FROM public.clientes
          WHERE id_usuario = ANY($1::uuid[])
            AND deleted_at IS NULL
        `,
        [usuarioIds]
      )
    : { rows: [] };

  const correoRows = resolvedPersonaId
    ? await client.query(
        `
          SELECT id_correo
          FROM public.correos
          WHERE id_persona = $1::uuid
            AND deleted_at IS NULL
        `,
        [resolvedPersonaId]
      )
    : { rows: [] };

  const clienteIds = uniqueUuidList([
    ...clientRowsByPersona.rows.map((row) => row.id_cliente),
    ...clientRowsByUser.rows.map((row) => row.id_cliente),
  ]);

  return {
    personaId: resolvedPersonaId,
    empleadoIds: uniqueUuidList(employeeRows.rows.map((row) => row.id_empleado)),
    clienteIds,
    usuarioIds,
    correoIds: uniqueUuidList(correoRows.rows.map((row) => row.id_correo)),
  };
}

async function deleteAuthUsersStrict(client, userIds) {
  const ids = uniqueUuidList(userIds);
  if (!ids.length) return;

  try {
    // AM: Borrado de auth.users dentro de la misma transaccion para evitar inconsistencias por commit diferido.
    await client.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [ids]);
  } catch (error) {
    if (error?.code === "23503") {
      throw new AppError(409, "No se puede eliminar auth.users porque existen dependencias relacionadas", {
        code: "PERSONAS_DELETE_AUTH_HAS_DEPENDENCIES",
        details: {
          table: error?.table,
          constraint: error?.constraint,
          detail: error?.detail,
        },
      });
    }
    throw new AppError(500, "No se pudo eliminar el usuario en Supabase Auth", {
      code: "PERSONAS_DELETE_AUTH_ERROR",
      details: {
        error: error instanceof Error ? error.message : "unknown_auth_delete_error",
      },
    });
  }
}

async function deletePersonaBundlePermanently(app, client, bundle) {
  const usuarioIds = uniqueUuidList(bundle?.usuarioIds);
  const empleadoIds = uniqueUuidList(bundle?.empleadoIds);
  const clienteIds = uniqueUuidList(bundle?.clienteIds);
  const correoIds = uniqueUuidList(bundle?.correoIds);
  const personaId = bundle?.personaId ?? null;

  if (!usuarioIds.length && !empleadoIds.length && !clienteIds.length && !personaId) {
    throw new AppError(404, "No se encontro un dominio de Personas para eliminar", {
      code: "PERSONAS_DELETE_NOTHING_TO_DELETE",
    });
  }

  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const reassignmentSummary = await applyTemporaryEmployeeReassignments(client, empleadoIds);

    await assertBundleHasNoExternalDependencies(client, {
      empleadoIds,
      clienteIds,
      usuarioIds,
      correoIds,
      personaId,
    });

    if (usuarioIds.length) {
      await client.query(
        `
          UPDATE public.roles_usuarios
          SET asignado_por = NULL,
              updated_at = NOW()
          WHERE asignado_por = ANY($1::uuid[])
        `,
        [usuarioIds]
      );
      await client.query("DELETE FROM public.roles_usuarios WHERE id_usuario = ANY($1::uuid[])", [usuarioIds]);
    }

    if (empleadoIds.length) {
      await client.query("DELETE FROM public.empleados WHERE id_empleado = ANY($1::uuid[])", [empleadoIds]);
    }

    if (clienteIds.length) {
      await client.query("DELETE FROM public.clientes WHERE id_cliente = ANY($1::uuid[])", [clienteIds]);
    }

    if (correoIds.length) {
      await client.query("DELETE FROM public.correos WHERE id_correo = ANY($1::uuid[])", [correoIds]);
    }

    if (usuarioIds.length) {
      await client.query("DELETE FROM public.usuarios WHERE id_usuario = ANY($1::uuid[])", [usuarioIds]);
    }

    if (personaId) {
      await client.query("DELETE FROM public.personas WHERE id_persona = $1::uuid", [personaId]);
    }

    // AM: Solucion temporal de eliminacion permanente con limpieza estricta y atomica de auth.users.
    await deleteAuthUsersStrict(client, usuarioIds);

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      eliminacion_permanente_temporal: true,
      resumen: {
        empleados: empleadoIds.length,
        clientes: clienteIds.length,
        usuarios: usuarioIds.length,
        correos: correoIds.length,
        persona: Boolean(personaId),
        // AM: Evidencia de reasignacion temporal aplicada antes del borrado.
        reasignaciones_temporales: reassignmentSummary,
      },
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    if (!(error instanceof AppError) && error?.code === "23503") {
      throw new AppError(409, "No se puede eliminar porque existen dependencias en otros modulos", {
        code: "PERSONAS_DELETE_HAS_EXTERNAL_DEPENDENCIES",
        details: {
          table: error?.table,
          constraint: error?.constraint,
          detail: error?.detail,
        },
      });
    }
    throw error;
  }
}

async function deleteEmpleadoPermanently(app, idEmpleado) {
  const client = await app.db.connect();
  try {
    const current = await client.query(EMPLEADO_BY_ID_SQL, [idEmpleado]);
    if (!current.rowCount) {
      throw new AppError(404, "Empleado no encontrado", {
        code: "PERSONAS_EMPLOYEE_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    const bundle = await loadPersonaDeletionBundle(client, {
      personaId: row.id_persona,
      userId: row.id_usuario ?? null,
    });
    return deletePersonaBundlePermanently(app, client, bundle);
  } finally {
    client.release();
  }
}

async function deleteClientePermanently(app, idCliente) {
  const client = await app.db.connect();
  try {
    const current = await client.query(CLIENTE_BY_ID_SQL, [idCliente]);
    if (!current.rowCount) {
      throw new AppError(404, "Cliente no encontrado", {
        code: "PERSONAS_CLIENT_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    const bundle = await loadPersonaDeletionBundle(client, {
      personaId: row.id_persona,
      userId: row.id_usuario ?? null,
    });
    return deletePersonaBundlePermanently(app, client, bundle);
  } finally {
    client.release();
  }
}

async function deleteUsuarioPermanently(app, idUsuario) {
  const client = await app.db.connect();
  try {
    const current = await client.query(
      `
        SELECT id_usuario, id_persona
        FROM public.usuarios
        WHERE id_usuario = $1::uuid
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [idUsuario]
    );
    if (!current.rowCount) {
      throw new AppError(404, "Usuario no encontrado", {
        code: "PERSONAS_USER_NOT_FOUND",
      });
    }

    const row = current.rows[0];
    const bundle = await loadPersonaDeletionBundle(client, {
      personaId: row.id_persona ?? null,
      userId: row.id_usuario,
    });
    return deletePersonaBundlePermanently(app, client, bundle);
  } finally {
    client.release();
  }
}

function normalizeLegacyInternalPayload(payload) {
  return {
    persona: payload?.persona || {},
    acceso: {
      correo_principal: payload?.correo_principal,
      roles: Array.isArray(payload?.roles) ? payload.roles.map((entry) => entry?.rol).filter(Boolean) : [],
    },
    empleado: {
      id_sucursal: payload?.empleado?.id_sucursal ?? null,
      fecha_ingreso: payload?.empleado?.fecha_ingreso ?? null,
      salario_base: payload?.empleado?.salario_base ?? null,
      estado: true,
      es_barbero: Boolean(payload?.empleado?.es_barbero),
    },
    cliente: {
      id_sucursal_origen: payload?.cliente?.id_sucursal_origen ?? null,
      consentimiento_marketing: Boolean(payload?.cliente?.consentimiento_marketing),
      acepta_terminos: Boolean(payload?.cliente?.acepta_terminos),
      estado: true,
    },
    createEmployee: Boolean(payload?.crear_empleado),
    createClient: Boolean(payload?.crear_cliente),
  };
}

async function createLegacyInternalUser(app, request, payload) {
  const normalized = normalizeLegacyInternalPayload(payload);

  if (normalized.createEmployee && normalized.createClient) {
    throw new AppError(400, "Usa alta por modulo (empleados o clientes), no ambos", {
      code: "PERSONAS_LEGACY_CREATE_CONFLICT",
    });
  }

  if (normalized.createEmployee) {
    const result = await createEmpleado(app, request, {
      persona: normalized.persona,
      acceso: normalized.acceso,
      empleado: normalized.empleado,
    });
    return {
      usuario: result.empleado,
      setup_password: result.setup_password,
      legado: true,
      mensaje: "Endpoint legado redirigido al flujo de empleados",
    };
  }

  if (normalized.createClient) {
    const result = await createCliente(app, request, {
      persona: normalized.persona,
      acceso: {
        habilitar_acceso: true,
        correo_principal: normalized.acceso.correo_principal,
      },
      cliente: normalized.cliente,
    });
    return {
      usuario: result.cliente,
      setup_password: result.setup_password,
      legado: true,
      mensaje: "Endpoint legado redirigido al flujo de clientes con acceso",
    };
  }

  throw new AppError(400, "El endpoint legado requiere crear_empleado=true o crear_cliente=true", {
    code: "PERSONAS_LEGACY_CREATE_REQUIRED_PROFILE",
  });
}

export default async function adminPersonasRoutes(app) {
  app.get("/", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(LIST_PERSONAS_SQL);
      return sendOk(reply, { personas: rows });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar personas", "PERSONAS_LIST_ERROR");
    }
  });

  app.get("/catalogos", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const [rolesResult, sucursalesResult] = await Promise.all([
        app.db.query("SELECT id_rol, nombre FROM public.roles ORDER BY nombre ASC"),
        app.db.query(
          `
            SELECT id_sucursal, nombre_sucursal
            FROM public.sucursales
            WHERE deleted_at IS NULL
              AND estado IS TRUE
            ORDER BY nombre_sucursal ASC
          `
        ),
      ]);
      return sendOk(reply, { roles: rolesResult.rows, sucursales: sucursalesResult.rows });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo cargar catalogos de personas", "PERSONAS_CATALOGS_ERROR");
    }
  });

  app.get("/usuarios", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(LIST_USUARIOS_SQL);
      return sendOk(reply, { usuarios: rows.map(mapUsuario) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar usuarios", "PERSONAS_USERS_LIST_ERROR");
    }
  });

  app.patch(
    "/usuarios/:id_usuario",
    { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: usuarioUpdateBodySchema } },
    async (request, reply) => {
      try {
        const updated = await updateUsuario(app, request, request.params.id_usuario, request.body || {});
        return sendOk(reply, updated, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar usuario", "PERSONAS_USER_UPDATE_ERROR");
      }
    }
  );

  app.patch(
    "/usuarios/:id_usuario/estado-acceso",
    { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: usuarioAccessStatusBodySchema } },
    async (request, reply) => {
      try {
        const updated = await updateUsuarioAccessStatus(app, request.params.id_usuario, request.body?.estado_acceso);
        return sendOk(reply, updated, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar estado de acceso", "PERSONAS_USER_STATUS_UPDATE_ERROR");
      }
    }
  );

  app.patch("/usuarios/:id_usuario/bloquear", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await updateUsuarioAccessStatus(app, request.params.id_usuario, ACCESS_STATUS.BLOCKED);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo bloquear usuario", "PERSONAS_USER_BLOCK_ERROR");
    }
  });

  app.patch("/usuarios/:id_usuario/activar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await updateUsuarioAccessStatus(app, request.params.id_usuario, ACCESS_STATUS.ACTIVE);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo activar usuario", "PERSONAS_USER_ACTIVATE_ERROR");
    }
  });

  app.patch("/usuarios/:id_usuario/inactivar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await updateUsuarioAccessStatus(app, request.params.id_usuario, ACCESS_STATUS.INACTIVE);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo inactivar usuario", "PERSONAS_USER_INACTIVATE_ERROR");
    }
  });

  app.delete("/usuarios/:id_usuario/permanente", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const deleted = await deleteUsuarioPermanently(app, request.params.id_usuario);
      return sendOk(reply, deleted, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar usuario permanentemente", "PERSONAS_USER_DELETE_PERMANENT_ERROR");
    }
  });

  app.post(
    "/usuarios/:id_usuario/enviar-configuracion-password",
    { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: usuarioSetupBodySchema } },
    async (request, reply) => {
      try {
        const result = await sendUsuarioPasswordSetup(app, request.params.id_usuario, request.body || {});
        return sendOk(reply, result, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo enviar configuracion de password", "PERSONAS_USER_SETUP_PASSWORD_ERROR");
      }
    }
  );

  app.get("/empleados", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(LIST_EMPLEADOS_SQL);
      return sendOk(reply, { empleados: rows.map(mapEmpleado) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar empleados", "PERSONAS_EMPLOYEES_LIST_ERROR");
    }
  });

  app.get("/empleados/:id_empleado", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(EMPLEADO_BY_ID_SQL, [request.params.id_empleado]);
      if (!rows.length) {
        return sendError(reply, 404, "Empleado no encontrado", {
          code: "PERSONAS_EMPLOYEE_NOT_FOUND",
          requestId: request.id,
        });
      }
      return sendOk(reply, { empleado: mapEmpleado(rows[0]) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar detalle de empleado", "PERSONAS_EMPLOYEE_DETAIL_ERROR");
    }
  });

  app.post("/empleados", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: empleadoCreateBodySchema } }, async (request, reply) => {
    try {
      const created = await createEmpleado(app, request, request.body || {});
      return sendOk(reply, created, { statusCode: 201, requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo crear empleado", "PERSONAS_EMPLOYEE_CREATE_ERROR");
    }
  });

  app.patch(
    "/empleados/:id_empleado",
    { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: empleadoCreateBodySchema } },
    async (request, reply) => {
      try {
        const updated = await updateEmpleado(app, request, request.params.id_empleado, request.body || {});
        return sendOk(reply, updated, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar empleado", "PERSONAS_EMPLOYEE_UPDATE_ERROR");
      }
    }
  );

  app.patch("/empleados/:id_empleado/inactivar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await inactivateEmpleado(app, request.params.id_empleado);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo inactivar empleado", "PERSONAS_EMPLOYEE_INACTIVATE_ERROR");
    }
  });

  app.patch("/empleados/:id_empleado/activar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await activateEmpleado(app, request, request.params.id_empleado);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo activar empleado", "PERSONAS_EMPLOYEE_ACTIVATE_ERROR");
    }
  });

  app.delete("/empleados/:id_empleado/permanente", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const deleted = await deleteEmpleadoPermanently(app, request.params.id_empleado);
      return sendOk(reply, deleted, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar empleado permanentemente", "PERSONAS_EMPLOYEE_DELETE_PERMANENT_ERROR");
    }
  });

  app.get("/clientes", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(LIST_CLIENTES_SQL);
      return sendOk(reply, { clientes: rows.map(mapCliente) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar clientes", "PERSONAS_CLIENTS_LIST_ERROR");
    }
  });

  app.get("/clientes/:id_cliente", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const { rows } = await app.db.query(CLIENTE_BY_ID_SQL, [request.params.id_cliente]);
      if (!rows.length) {
        return sendError(reply, 404, "Cliente no encontrado", {
          code: "PERSONAS_CLIENT_NOT_FOUND",
          requestId: request.id,
        });
      }
      return sendOk(reply, { cliente: mapCliente(rows[0]) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar detalle de cliente", "PERSONAS_CLIENT_DETAIL_ERROR");
    }
  });

  app.post("/clientes", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: clienteCreateBodySchema } }, async (request, reply) => {
    try {
      const created = await createCliente(app, request, request.body || {});
      return sendOk(reply, created, { statusCode: 201, requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo crear cliente", "PERSONAS_CLIENT_CREATE_ERROR");
    }
  });

  app.patch(
    "/clientes/:id_cliente",
    { preHandler: app.requireRoles(SUPER_ADMIN_ONLY), schema: { body: clienteUpdateBodySchema } },
    async (request, reply) => {
      try {
        const updated = await updateCliente(app, request, request.params.id_cliente, request.body || {});
        return sendOk(reply, updated, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar cliente", "PERSONAS_CLIENT_UPDATE_ERROR");
      }
    }
  );

  app.patch("/clientes/:id_cliente/inactivar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await inactivateCliente(app, request.params.id_cliente);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo inactivar cliente", "PERSONAS_CLIENT_INACTIVATE_ERROR");
    }
  });

  app.patch("/clientes/:id_cliente/activar", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const updated = await activateCliente(app, request, request.params.id_cliente);
      return sendOk(reply, updated, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo activar cliente", "PERSONAS_CLIENT_ACTIVATE_ERROR");
    }
  });

  app.delete("/clientes/:id_cliente/permanente", { preHandler: app.requireRoles(SUPER_ADMIN_ONLY) }, async (request, reply) => {
    try {
      const deleted = await deleteClientePermanently(app, request.params.id_cliente);
      return sendOk(reply, deleted, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar cliente permanentemente", "PERSONAS_CLIENT_DELETE_PERMANENT_ERROR");
    }
  });

  // AM: Endpoint legado conservado por compatibilidad temporal, ahora sin exponer passwords.
  app.post(
    "/usuarios-internos",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ONLY),
      schema: {
        body: {
          type: "object",
          properties: {
            persona: personaInputSchema,
            correo_principal: { type: "string", minLength: 5, maxLength: 160 },
            roles: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  rol: { type: "string", minLength: 1, maxLength: 50 },
                  id_sucursal: { type: ["string", "null"], format: "uuid" },
                },
                required: ["rol"],
                additionalProperties: false,
              },
            },
            crear_empleado: { type: "boolean" },
            empleado: { type: ["object", "null"], additionalProperties: true },
            crear_cliente: { type: "boolean" },
            cliente: { type: ["object", "null"], additionalProperties: true },
          },
          required: ["persona", "correo_principal", "roles"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const created = await createLegacyInternalUser(app, request, request.body || {});
        return sendOk(reply, created, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo crear usuario interno", "PERSONAS_CREATE_INTERNAL_USER_ERROR");
      }
    }
  );
}
