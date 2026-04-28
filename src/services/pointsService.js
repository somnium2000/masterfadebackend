import crypto from "node:crypto";
import { AppError } from "../utils/errors.js";
import { assertUuid } from "./agendaService.js";

const DEFAULT_PUNTOS_PARA_PREMIO = 10;
const HISTORIAL_DEFAULT_LIMIT = 20;
const HISTORIAL_MAX_LIMIT = 100;
const CLIENT_SEARCH_MIN_LENGTH = 2;
const CLIENT_SEARCH_MAX_LENGTH = 80;
const CLIENT_SEARCH_DEFAULT_LIMIT = 10;
const CLIENT_SEARCH_MAX_LIMIT = 20;
const MANUAL_ADJUST_TYPE_ADD = "ajustar";
const MANUAL_ADJUST_TYPE_SUBTRACT = "ajuste_resta";
const REWARD_SERVICE_NAMES_NO_PLAN = ["corte de cabello", "corte de barba"];
const REWARD_SERVICE_NAMES_WITH_PLAN = ["facial express"];
const REDEEM_CONTEXT_TOKEN_PREFIX = "mf_reward_ctx_v1";
const REDEEM_CONTEXT_TOKEN_VERSION = 1;
const REDEEM_CONTEXT_TTL_SECONDS = Math.max(
  300,
  Number(process.env.POINTS_REDEEM_CONTEXT_TTL_SECONDS || 12 * 60 * 60)
);

const SQL_COMPATIBLE_ERROR_CODES = new Set(["42P01", "42703", "42883"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeServiceName(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function getRedeemContextSecret() {
  return normalizeText(process.env.POINTS_REDEEM_CONTEXT_SECRET)
    || normalizeText(process.env.JWT_SECRET)
    || normalizeText(process.env.COOKIE_SECRET)
    || "mf_reward_context_dev_secret";
}

function signRedeemContextPayload(payloadEncoded) {
  return crypto
    .createHmac("sha256", getRedeemContextSecret())
    .update(String(payloadEncoded || ""))
    .digest("base64url");
}

function buildRedeemContextToken(payload) {
  const payloadEncoded = encodeBase64Url(JSON.stringify(payload));
  const signature = signRedeemContextPayload(payloadEncoded);
  return `${REDEEM_CONTEXT_TOKEN_PREFIX}.${payloadEncoded}.${signature}`;
}

function parseRedeemContextToken(token) {
  const safeToken = normalizeText(token);
  const [prefix, payloadEncoded, signature] = safeToken.split(".");
  if (!prefix || !payloadEncoded || !signature || prefix !== REDEEM_CONTEXT_TOKEN_PREFIX) {
    throw new AppError(409, "El contexto de canje no es valido", {
      code: "POINTS_REDEEM_CONTEXT_INVALID",
    });
  }
  const expectedSignature = signRedeemContextPayload(payloadEncoded);
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");
  if (
    expectedBuffer.length !== receivedBuffer.length
    || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new AppError(409, "El contexto de canje no es valido", {
      code: "POINTS_REDEEM_CONTEXT_INVALID",
    });
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadEncoded));
  } catch {
    throw new AppError(409, "El contexto de canje no es valido", {
      code: "POINTS_REDEEM_CONTEXT_INVALID",
    });
  }

  if (!payload || typeof payload !== "object") {
    throw new AppError(409, "El contexto de canje no es valido", {
      code: "POINTS_REDEEM_CONTEXT_INVALID",
    });
  }
  if (Number(payload.v || 0) !== REDEEM_CONTEXT_TOKEN_VERSION) {
    throw new AppError(409, "El contexto de canje no es compatible", {
      code: "POINTS_REDEEM_CONTEXT_VERSION_INVALID",
    });
  }

  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new AppError(409, "El contexto de canje expiro. Prepara de nuevo tu recompensa.", {
      code: "POINTS_REDEEM_CONTEXT_EXPIRED",
    });
  }

  const idCliente = assertUuid(payload.id_cliente, "id_cliente");
  const idServicioCanje = assertUuid(payload.id_servicio_canje, "id_servicio_canje");
  const idSucursal = assertUuid(payload.id_sucursal, "id_sucursal");
  const puntosRequeridos = Math.max(1, Number(payload.puntos_requeridos || DEFAULT_PUNTOS_PARA_PREMIO));

  return {
    id_cliente: idCliente,
    id_servicio_canje: idServicioCanje,
    id_sucursal: idSucursal,
    puntos_requeridos: puntosRequeridos,
    iat: Number(payload.iat || 0),
    exp,
  };
}

function resolveHistoryLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return HISTORIAL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(parsed), HISTORIAL_MAX_LIMIT));
}

function normalizeClientSearchQuery(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function resolveClientSearchLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return CLIENT_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(parsed), CLIENT_SEARCH_MAX_LIMIT));
}

function sanitizeMovimientoRow(row) {
  return {
    id_points_tx: row.id_points_tx,
    tipo_puntos_codigo: row.tipo_puntos_codigo,
    origen_punto_codigo: row.origen_punto_codigo ?? null,
    puntos: Number(row.puntos || 0),
    motivo: row.motivo ?? null,
    id_cita: row.id_cita ?? null,
    id_servicio_canje: row.id_servicio_canje ?? null,
    id_sucursal_origen: row.id_sucursal_origen ?? null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function lockClientePointsScope(client, idCliente) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [idCliente]);
}

async function materializeCyclesIfAvailable(client, idCliente) {
  try {
    await client.query("SELECT public.fn_points_materialize_expired_cycles($1::uuid)", [idCliente]);
  } catch (error) {
    if (!SQL_COMPATIBLE_ERROR_CODES.has(String(error?.code || ""))) throw error;
  }
}

async function ensureClienteActivo(client, idCliente, { requireRegisteredUser = false } = {}) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_persona,
        c.id_usuario,
        c.id_sucursal_origen,
        p.nombres,
        p.apellidos
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      WHERE c.id_cliente = $1::uuid
        AND c.deleted_at IS NULL
        AND COALESCE(c.estado, TRUE) IS TRUE
      LIMIT 1
    `,
    [idCliente]
  );

  const row = rows[0] ?? null;
  if (!row) {
    throw new AppError(404, "Cliente no encontrado", {
      code: "POINTS_CLIENT_NOT_FOUND",
      details: { id_cliente: idCliente },
    });
  }

  if (requireRegisteredUser && !row.id_usuario) {
    throw new AppError(409, "El cliente no tiene usuario registrado", {
      code: "POINTS_CLIENT_NOT_REGISTERED",
      details: { id_cliente: idCliente },
    });
  }

  return row;
}

async function getSaldoActual(client, idCliente) {
  const { rows } = await client.query(
    `
      SELECT COALESCE(SUM(pt.puntos), 0)::int AS saldo_total
      FROM public.points_transactions pt
      WHERE pt.id_cliente = $1::uuid
    `,
    [idCliente]
  );
  return Number(rows[0]?.saldo_total || 0);
}

async function resolvePuntosParaPremio(client, idSucursal) {
  try {
    const { rows } = await client.query(
      `
        SELECT COALESCE(r.puntos_para_premio, $2::int)::int AS puntos_para_premio
        FROM public.fn_points_get_effective_rule($1::uuid) r
        LIMIT 1
      `,
      [idSucursal || null, DEFAULT_PUNTOS_PARA_PREMIO]
    );
    const fromFunction = Number(rows[0]?.puntos_para_premio || 0);
    if (fromFunction > 0) return fromFunction;
  } catch (error) {
    if (!SQL_COMPATIBLE_ERROR_CODES.has(String(error?.code || ""))) throw error;
  }

  const { rows } = await client.query(
    `
      SELECT COALESCE(pr.puntos_para_premio, $2::int)::int AS puntos_para_premio
      FROM public.points_rules pr
      WHERE pr.activo IS TRUE
        AND (pr.id_sucursal = $1::uuid OR pr.id_sucursal IS NULL)
      ORDER BY
        CASE WHEN pr.id_sucursal = $1::uuid THEN 0 ELSE 1 END,
        pr.updated_at DESC,
        pr.created_at DESC,
        pr.id_rule DESC
      LIMIT 1
    `,
    [idSucursal || null, DEFAULT_PUNTOS_PARA_PREMIO]
  );

  return Number(rows[0]?.puntos_para_premio || DEFAULT_PUNTOS_PARA_PREMIO);
}

async function listMovimientosCompactos(client, idCliente, { limit = HISTORIAL_DEFAULT_LIMIT } = {}) {
  const safeLimit = resolveHistoryLimit(limit);
  const { rows } = await client.query(
    `
      SELECT
        pt.id_points_tx,
        pt.tipo_puntos_codigo,
        pt.origen_punto_codigo,
        pt.puntos,
        pt.motivo,
        pt.id_cita,
        pt.id_servicio_canje,
        pt.id_sucursal_origen,
        pt.created_at
      FROM public.points_transactions pt
      WHERE pt.id_cliente = $1::uuid
      ORDER BY pt.created_at DESC, pt.id_points_tx DESC
      LIMIT $2::int
    `,
    [idCliente, safeLimit]
  );
  return rows.map(sanitizeMovimientoRow);
}

async function getAgregadosPuntos(client, idCliente) {
  const { rows } = await client.query(
    `
      SELECT
        COALESCE(SUM(pt.puntos), 0)::int AS saldo_total,
        COALESCE(SUM(CASE
          WHEN pt.puntos > 0 AND COALESCE(pt.origen_punto_codigo, 'titular') = 'titular'
            THEN pt.puntos
          ELSE 0
        END), 0)::int AS puntos_titular,
        COALESCE(SUM(CASE
          WHEN pt.puntos > 0 AND COALESCE(pt.origen_punto_codigo, 'titular') = 'integrante'
            THEN pt.puntos
          ELSE 0
        END), 0)::int AS puntos_integrante
      FROM public.points_transactions pt
      WHERE pt.id_cliente = $1::uuid
    `,
    [idCliente]
  );
  return {
    saldo_total: Number(rows[0]?.saldo_total || 0),
    puntos_titular: Number(rows[0]?.puntos_titular || 0),
    puntos_integrante: Number(rows[0]?.puntos_integrante || 0),
  };
}

async function validateSucursalActiva(client, idSucursal) {
  const { rows } = await client.query(
    `
      SELECT id_sucursal
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
        AND estado IS TRUE
      LIMIT 1
    `,
    [idSucursal]
  );
  if (!rows[0]) {
    throw new AppError(404, "Sucursal no encontrada o inactiva", {
      code: "POINTS_BRANCH_NOT_FOUND",
      details: { id_sucursal: idSucursal },
    });
  }
}

async function hasActivePlan(client, idCliente) {
  const { rows } = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM public.subscriptions s
        WHERE s.id_cliente = $1::uuid
          AND s.estado_suscripcion_codigo = 'activa'
          AND s.inicio_at <= now()
          AND s.fin_at > now()
      ) AS has_active_plan
    `,
    [idCliente]
  );
  return Boolean(rows[0]?.has_active_plan);
}

async function resolveServicioCanjeValido(client, {
  idServicioCanje,
  idSucursal,
  hasPlanActivo,
}) {
  const allowedNames = hasPlanActivo
    ? REWARD_SERVICE_NAMES_WITH_PLAN
    : REWARD_SERVICE_NAMES_NO_PLAN;
  const normalizedAllowed = new Set(allowedNames.map((entry) => normalizeServiceName(entry)));

  const { rows } = await client.query(
    `
      SELECT
        s.id_servicio,
        s.nombre_servicio
      FROM public.servicios s
      WHERE s.id_servicio = $1::uuid
        AND s.deleted_at IS NULL
        AND s.activo IS TRUE
      LIMIT 1
    `,
    [idServicioCanje]
  );

  const service = rows[0] ?? null;
  if (!service) {
    throw new AppError(404, "Servicio no encontrado o inactivo", {
      code: "POINTS_REDEEM_SERVICE_NOT_FOUND",
      details: { id_servicio: idServicioCanje },
    });
  }

  const normalizedName = normalizeServiceName(service.nombre_servicio);
  if (!normalizedAllowed.has(normalizedName)) {
    throw new AppError(409, "El servicio no esta permitido para este tipo de cliente", {
      code: "POINTS_REDEEM_SERVICE_FORBIDDEN",
      details: {
        id_servicio: idServicioCanje,
        servicio_nombre: service.nombre_servicio,
        permitidos: allowedNames,
        requiere_plan_activo: hasPlanActivo,
      },
    });
  }

  const tariffResult = await client.query(
    `
      SELECT st.id_tarifa
      FROM public.servicios_tarifas st
      WHERE st.id_servicio = $1::uuid
        AND st.id_sucursal = $2::uuid
        AND st.deleted_at IS NULL
        AND st.activo IS TRUE
        AND st.vigente_desde <= CURRENT_DATE
        AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      ORDER BY st.updated_at DESC, st.id_tarifa DESC
      LIMIT 1
    `,
    [idServicioCanje, idSucursal]
  );

  if (!tariffResult.rows[0]) {
    throw new AppError(409, "El servicio no esta disponible para canje en la sucursal indicada", {
      code: "POINTS_REDEEM_SERVICE_BRANCH_UNAVAILABLE",
      details: { id_servicio: idServicioCanje, id_sucursal: idSucursal },
    });
  }

  return {
    id_servicio: service.id_servicio,
    nombre_servicio: service.nombre_servicio,
    permitidos: allowedNames,
  };
}

function assertAdminUserId(usuarioAdmin) {
  const idUsuario = normalizeText(usuarioAdmin?.id_usuario || usuarioAdmin?.idUsuario || "");
  if (!idUsuario) {
    throw new AppError(401, "Usuario administrador no autenticado", {
      code: "POINTS_ADMIN_AUTH_REQUIRED",
    });
  }
  return assertUuid(idUsuario, "id_usuario_admin");
}

function assertMotivoObligatorio(motivo, field = "motivo") {
  const normalized = normalizeText(motivo);
  if (!normalized) {
    throw new AppError(400, `${field} es obligatorio`, {
      code: "POINTS_REASON_REQUIRED",
      details: { field },
    });
  }
  if (normalized.length < 5) {
    throw new AppError(400, `${field} debe tener al menos 5 caracteres`, {
      code: "POINTS_REASON_TOO_SHORT",
      details: { field, min_length: 5 },
    });
  }
  if (normalized.length > 300) {
    throw new AppError(400, `${field} excede el maximo de 300 caracteres`, {
      code: "POINTS_REASON_TOO_LONG",
      details: { field },
    });
  }
  return normalized;
}

function assertAjusteAccion(value) {
  const action = normalizeText(value).toLowerCase();
  if (action !== "sumar" && action !== "restar") {
    throw new AppError(400, "accion debe ser sumar o restar", {
      code: "POINTS_ADJUSTMENT_INVALID_ACTION",
      details: { accion: value },
    });
  }
  return action;
}

export async function searchActiveClientesForAdminPoints(app, { q, limit } = {}) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", { code: "DB_NOT_CONFIGURED" });
  }

  const query = normalizeClientSearchQuery(q);
  if (!query || query.length < CLIENT_SEARCH_MIN_LENGTH) {
    return { clientes: [] };
  }
  if (query.length > CLIENT_SEARCH_MAX_LENGTH) {
    throw new AppError(400, "La busqueda de cliente excede el maximo permitido", {
      code: "POINTS_CLIENT_SEARCH_QUERY_TOO_LONG",
      details: { max_length: CLIENT_SEARCH_MAX_LENGTH },
    });
  }

  const safeLimit = resolveClientSearchLimit(limit);
  const queryLower = query.toLowerCase();
  const containsPattern = `%${queryLower}%`;
  const startsWithPattern = `${queryLower}%`;

  const { rows } = await app.db.query(
    `
      SELECT
        c.id_cliente,
        TRIM(CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, ''))) AS nombre_cliente,
        COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS correo,
        NULLIF(p.telefono_principal, '') AS telefono,
        c.id_usuario
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      JOIN public.usuarios u
        ON u.id_usuario = c.id_usuario
        AND u.deleted_at IS NULL
      LEFT JOIN auth.users au
        ON au.id = c.id_usuario
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE c.deleted_at IS NULL
        AND COALESCE(c.estado, TRUE) IS TRUE
        AND c.id_usuario IS NOT NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'pendiente_password') NOT IN ('bloqueado', 'inactivo')
        AND (
          LOWER(TRIM(CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')))) LIKE $1::text
          OR LOWER(COALESCE(p.telefono_principal, '')) LIKE $1::text
          OR LOWER(COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, ''), '')) LIKE $1::text
        )
      ORDER BY
        CASE
          WHEN LOWER(TRIM(CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')))) LIKE $2::text THEN 0
          WHEN LOWER(TRIM(CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')))) LIKE $1::text THEN 1
          WHEN LOWER(COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, ''), '')) LIKE $1::text THEN 2
          WHEN LOWER(COALESCE(p.telefono_principal, '')) LIKE $1::text THEN 3
          ELSE 4
        END,
        LOWER(TRIM(CONCAT(COALESCE(p.nombres, ''), ' ', COALESCE(p.apellidos, '')))) ASC,
        c.id_cliente ASC
      LIMIT $3::int
    `,
    [containsPattern, startsWithPattern, safeLimit]
  );

  return {
    clientes: rows.map((row) => ({
      id_cliente: row.id_cliente,
      nombre_cliente: row.nombre_cliente || "Cliente",
      correo: row.correo || null,
      telefono: row.telefono || null,
      id_usuario: row.id_usuario || null,
    })),
  };
}

function assertPositiveIntegerPoints(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "puntos debe ser un entero mayor que 0", {
      code: "POINTS_ADJUSTMENT_INVALID",
      details: { puntos: value },
    });
  }
  return parsed;
}

async function ensureClienteHasActiveAccessUser(client, idUsuario, idCliente) {
  const safeUserId = assertUuid(idUsuario, "id_usuario_cliente");
  const { rows } = await client.query(
    `
      SELECT u.id_usuario
      FROM public.usuarios u
      WHERE u.id_usuario = $1::uuid
        AND u.deleted_at IS NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'pendiente_password') NOT IN ('bloqueado', 'inactivo')
      LIMIT 1
    `,
    [safeUserId]
  );
  if (!rows[0]) {
    throw new AppError(409, "El cliente no tiene usuario activo", {
      code: "POINTS_CLIENT_USER_INACTIVE",
      details: { id_cliente: idCliente, id_usuario: safeUserId },
    });
  }
}

async function resolveManualAdjustmentTypes(client) {
  const requiredTypes = [MANUAL_ADJUST_TYPE_ADD, MANUAL_ADJUST_TYPE_SUBTRACT];
  const { rows } = await client.query(
    `
      SELECT tipo_puntos_codigo, signo
      FROM public.tipos_puntos
      WHERE tipo_puntos_codigo = ANY($1::text[])
    `,
    [requiredTypes]
  );

  const signByType = new Map(
    rows.map((row) => [normalizeText(row.tipo_puntos_codigo).toLowerCase(), Number(row.signo || 0)])
  );

  const missingTypes = requiredTypes.filter((code) => !signByType.has(code));
  if (missingTypes.length > 0) {
    throw new AppError(409, "Faltan tipos de puntos requeridos para ajuste manual", {
      code: "POINTS_ADJUSTMENT_TYPE_MISSING",
      details: { missing_types: missingTypes },
    });
  }

  if (signByType.get(MANUAL_ADJUST_TYPE_ADD) !== 1 || signByType.get(MANUAL_ADJUST_TYPE_SUBTRACT) !== -1) {
    throw new AppError(409, "La configuracion de tipos de puntos para ajuste manual es invalida", {
      code: "POINTS_ADJUSTMENT_TYPE_CONFIG_INVALID",
      details: {
        required: {
          [MANUAL_ADJUST_TYPE_ADD]: 1,
          [MANUAL_ADJUST_TYPE_SUBTRACT]: -1,
        },
      },
    });
  }

  return {
    sumar: MANUAL_ADJUST_TYPE_ADD,
    restar: MANUAL_ADJUST_TYPE_SUBTRACT,
  };
}

export function normalizeRedeemContextToken(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length > 1200) {
    throw new AppError(400, "canje_context_token invalido", {
      code: "POINTS_REDEEM_CONTEXT_INVALID",
    });
  }
  return normalized;
}

export async function resolveRedeemContextForHold(dbClient, {
  idCliente,
  canjeContextToken,
  idSucursal,
} = {}) {
  const safeClienteId = assertUuid(idCliente, "id_cliente");
  const safeSucursalId = assertUuid(idSucursal, "id_sucursal");
  const safeToken = normalizeRedeemContextToken(canjeContextToken);
  const parsedContext = parseRedeemContextToken(safeToken);
  if (String(parsedContext.id_cliente || "") !== safeClienteId) {
    throw new AppError(403, "No tienes permisos para usar este canje", {
      code: "POINTS_REDEEM_CONTEXT_FORBIDDEN",
    });
  }
  if (String(parsedContext.id_sucursal || "") !== safeSucursalId) {
    throw new AppError(409, "El canje pertenece a otra sucursal", {
      code: "POINTS_REDEEM_CONTEXT_BRANCH_MISMATCH",
      details: {
        id_sucursal_canje: parsedContext.id_sucursal,
        id_sucursal_cita: safeSucursalId,
      },
    });
  }

  await lockClientePointsScope(dbClient, safeClienteId);
  await materializeCyclesIfAvailable(dbClient, safeClienteId);
  const cliente = await ensureClienteActivo(dbClient, safeClienteId, { requireRegisteredUser: true });
  await validateSucursalActiva(dbClient, safeSucursalId);
  const puntosParaPremio = await resolvePuntosParaPremio(dbClient, cliente.id_sucursal_origen || safeSucursalId);
  const puntosRequeridos = Math.max(1, Number(puntosParaPremio || DEFAULT_PUNTOS_PARA_PREMIO));
  const saldoActual = await getSaldoActual(dbClient, safeClienteId);
  if (saldoActual < puntosRequeridos) {
    throw new AppError(409, "No hay puntos suficientes para confirmar esta recompensa", {
      code: "POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM",
      details: {
        saldo_actual: saldoActual,
        puntos_requeridos: puntosRequeridos,
      },
    });
  }

  const planActivo = await hasActivePlan(dbClient, safeClienteId);
  const servicio = await resolveServicioCanjeValido(dbClient, {
    idServicioCanje: parsedContext.id_servicio_canje,
    idSucursal: safeSucursalId,
    hasPlanActivo: planActivo,
  });

  return {
    canje_context_token: safeToken,
    id_cliente: safeClienteId,
    id_servicio_canje: servicio.id_servicio,
    id_sucursal_origen: safeSucursalId,
    servicio_nombre: servicio.nombre_servicio,
    puntos_requeridos: puntosRequeridos,
    saldo_actual: saldoActual,
  };
}

export async function applyRewardRedeemForConfirmedGroup(dbClient, {
  idGrupoCita,
  idCliente,
  canjeContextToken = null,
  motivo = "Canje de recompensa ruta a tu cortesia",
  createdByUserId = null,
} = {}) {
  const safeGroupId = assertUuid(idGrupoCita, "id_grupo_cita");
  const safeClienteId = assertUuid(idCliente, "id_cliente");
  const safeContextToken = canjeContextToken ? normalizeRedeemContextToken(canjeContextToken) : null;
  const parsedToken = safeContextToken ? parseRedeemContextToken(safeContextToken) : null;
  if (parsedToken && String(parsedToken.id_cliente || "") !== safeClienteId) {
    throw new AppError(403, "No tienes permisos para usar este canje", {
      code: "POINTS_REDEEM_CONTEXT_FORBIDDEN",
    });
  }

  await lockClientePointsScope(dbClient, safeClienteId);
  await materializeCyclesIfAvailable(dbClient, safeClienteId);
  const cliente = await ensureClienteActivo(dbClient, safeClienteId, { requireRegisteredUser: false });

  const titularResult = await dbClient.query(
    `
      SELECT
        cg.id_grupo_cita,
        cg.id_cliente_titular,
        c.id_cita,
        c.id_sucursal,
        c.estado_cita_codigo,
        COALESCE(c.es_canje_recompensa, FALSE) AS es_canje_recompensa,
        COALESCE(c.descuento_hnl, 0)::numeric AS descuento_hnl,
        c.inicio_at
      FROM public.citas_grupos cg
      JOIN LATERAL (
        SELECT
          cx.id_cita,
          cx.id_sucursal,
          cx.estado_cita_codigo,
          cx.es_canje_recompensa,
          cx.descuento_hnl,
          cx.inicio_at
        FROM public.citas cx
        WHERE cx.id_grupo_cita = cg.id_grupo_cita
          AND cx.deleted_at IS NULL
        ORDER BY cx.orden_integrante ASC, cx.created_at ASC
        LIMIT 1
      ) c ON TRUE
      WHERE cg.id_grupo_cita = $1::uuid
      LIMIT 1
      FOR UPDATE
    `,
    [safeGroupId]
  );
  const titular = titularResult.rows[0] ?? null;
  if (!titular) {
    throw new AppError(404, "No se encontro la cita titular del grupo", {
      code: "POINTS_REDEEM_APPOINTMENT_NOT_FOUND",
    });
  }
  if (String(titular.id_cliente_titular || "") !== safeClienteId) {
    throw new AppError(403, "No tienes permisos para confirmar este canje", {
      code: "POINTS_REDEEM_GROUP_FORBIDDEN",
    });
  }
  if (!titular.es_canje_recompensa) {
    return {
      aplicada: false,
      ya_aplicada: false,
      motivo: "grupo_sin_canje_recompensa",
    };
  }
  if (String(titular.estado_cita_codigo || "").trim().toLowerCase() !== "confirmada") {
    throw new AppError(409, "La cita aun no esta confirmada para aplicar el canje", {
      code: "POINTS_REDEEM_APPOINTMENT_NOT_CONFIRMED",
    });
  }

  const existingTx = await dbClient.query(
    `
      SELECT
        id_points_tx,
        id_servicio_canje,
        puntos,
        created_at
      FROM public.points_transactions
      WHERE id_cliente = $1::uuid
        AND id_cita = $2::uuid
        AND tipo_puntos_codigo = 'canjear'
      ORDER BY created_at DESC, id_points_tx DESC
      LIMIT 1
      FOR UPDATE
    `,
    [safeClienteId, titular.id_cita]
  );
  if (existingTx.rows[0]) {
    return {
      aplicada: false,
      ya_aplicada: true,
      id_points_tx: existingTx.rows[0].id_points_tx,
      id_servicio_canje: existingTx.rows[0].id_servicio_canje ?? null,
      puntos_descontados: Math.abs(Number(existingTx.rows[0].puntos || 0)),
    };
  }

  const detailRowsResult = await dbClient.query(
    `
      SELECT
        cd.id_servicio,
        COALESCE(cd.subtotal_hnl, 0)::numeric AS subtotal_hnl,
        s.nombre_servicio
      FROM public.citas_detalles cd
      JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      WHERE cd.id_cita = $1::uuid
      ORDER BY cd.id_cita_detalle ASC
    `,
    [titular.id_cita]
  );
  const detailRows = detailRowsResult.rows ?? [];
  if (!detailRows.length) {
    throw new AppError(409, "La cita no tiene servicios para aplicar el canje", {
      code: "POINTS_REDEEM_SERVICE_MISSING_IN_APPOINTMENT",
    });
  }
  const idSucursal = assertUuid(titular.id_sucursal, "id_sucursal");
  const planActivo = await hasActivePlan(dbClient, safeClienteId);
  const serviceHintId = parsedToken?.id_servicio_canje
    ? assertUuid(parsedToken.id_servicio_canje, "id_servicio_canje")
    : null;

  let selectedService;
  if (serviceHintId) {
    const detailMatch = detailRows.find((row) => String(row.id_servicio || "") === serviceHintId);
    if (!detailMatch) {
      throw new AppError(409, "La cita confirmada no incluye el servicio de recompensa preparado", {
        code: "POINTS_REDEEM_SERVICE_MISMATCH",
      });
    }
    const validated = await resolveServicioCanjeValido(dbClient, {
      idServicioCanje: serviceHintId,
      idSucursal,
      hasPlanActivo: planActivo,
    });
    selectedService = {
      id_servicio: validated.id_servicio,
      nombre_servicio: validated.nombre_servicio,
      subtotal_hnl: Number(detailMatch.subtotal_hnl || 0),
    };
  } else {
    const candidates = [];
    for (const detail of detailRows) {
      try {
        const validated = await resolveServicioCanjeValido(dbClient, {
          idServicioCanje: detail.id_servicio,
          idSucursal,
          hasPlanActivo: planActivo,
        });
        candidates.push({
          id_servicio: validated.id_servicio,
          nombre_servicio: validated.nombre_servicio,
          subtotal_hnl: Number(detail.subtotal_hnl || 0),
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code !== "POINTS_REDEEM_SERVICE_FORBIDDEN") throw error;
      }
    }
    if (candidates.length === 0) {
      throw new AppError(409, "La cita confirmada no tiene un servicio valido para canje", {
        code: "POINTS_REDEEM_SERVICE_INVALID_ON_CONFIRM",
      });
    }
    if (candidates.length === 1) {
      [selectedService] = candidates;
    } else {
      const descuento = Number(titular.descuento_hnl || 0);
      const candidatesByDiscount = candidates.filter((candidate) => Math.abs(Number(candidate.subtotal_hnl || 0) - descuento) < 0.01);
      if (candidatesByDiscount.length !== 1) {
        throw new AppError(409, "No se pudo determinar de forma segura el servicio del canje", {
          code: "POINTS_REDEEM_SERVICE_AMBIGUOUS",
        });
      }
      [selectedService] = candidatesByDiscount;
    }
  }
  if (!selectedService?.id_servicio) {
    throw new AppError(409, "No se pudo validar el servicio del canje", {
      code: "POINTS_REDEEM_SERVICE_INVALID_ON_CONFIRM",
    });
  }

  const puntosParaPremio = await resolvePuntosParaPremio(dbClient, cliente.id_sucursal_origen || idSucursal);
  const puntosRequeridos = Math.max(1, Number(puntosParaPremio || DEFAULT_PUNTOS_PARA_PREMIO));
  const saldoActual = await getSaldoActual(dbClient, safeClienteId);
  if (saldoActual < puntosRequeridos) {
    throw new AppError(409, "No hay puntos suficientes para confirmar la recompensa", {
      code: "POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM",
      details: {
        saldo_actual: saldoActual,
        puntos_requeridos: puntosRequeridos,
      },
    });
  }

  const createdBy = normalizeText(createdByUserId || cliente.id_usuario || "");
  const insertResult = await dbClient.query(
    `
      INSERT INTO public.points_transactions (
        id_cliente,
        id_cita,
        id_sucursal_origen,
        id_servicio_canje,
        tipo_puntos_codigo,
        origen_punto_codigo,
        puntos,
        motivo,
        creado_por_usuario_id
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        'canjear',
        'sistema',
        $5::int,
        $6::text,
        $7::uuid
      )
      ON CONFLICT (id_cliente, id_cita, tipo_puntos_codigo)
      WHERE tipo_puntos_codigo = 'canjear'
        AND id_cita IS NOT NULL
      DO NOTHING
      RETURNING
        id_points_tx,
        id_cliente,
        id_cita,
        id_servicio_canje,
        puntos,
        created_at
    `,
    [
      safeClienteId,
      titular.id_cita,
      idSucursal,
      selectedService.id_servicio,
      -Math.abs(puntosRequeridos),
      normalizeText(motivo) || "Canje de recompensa ruta a tu cortesia",
      createdBy || null,
    ]
  );
  const movement = insertResult.rows[0] || null;
  if (!movement) {
    const conflictedTx = await dbClient.query(
      `
        SELECT
          id_points_tx,
          id_servicio_canje,
          puntos
        FROM public.points_transactions
        WHERE id_cliente = $1::uuid
          AND id_cita = $2::uuid
          AND tipo_puntos_codigo = 'canjear'
        ORDER BY created_at DESC, id_points_tx DESC
        LIMIT 1
      `,
      [safeClienteId, titular.id_cita]
    );
    const existing = conflictedTx.rows[0] || null;
    if (existing) {
      return {
        aplicada: false,
        ya_aplicada: true,
        id_points_tx: existing.id_points_tx,
        id_servicio_canje: existing.id_servicio_canje ?? selectedService.id_servicio,
        puntos_descontados: Math.abs(Number(existing.puntos || 0)),
      };
    }
    throw new AppError(409, "La recompensa ya fue aplicada para esta cita", {
      code: "POINTS_REDEEM_ALREADY_APPLIED",
    });
  }
  const saldoActualizado = await getSaldoActual(dbClient, safeClienteId);

  return {
    aplicada: true,
    ya_aplicada: false,
    id_points_tx: movement.id_points_tx,
    id_cita: titular.id_cita,
    id_servicio_canje: selectedService.id_servicio,
    servicio_nombre: selectedService.nombre_servicio,
    puntos_descontados: Math.abs(Number(movement.puntos || puntosRequeridos)),
    saldo_actual: saldoActualizado,
    canje_context_token: safeContextToken,
  };
}

export async function getClientePointsSummary(app, idCliente, { historyLimit = HISTORIAL_DEFAULT_LIMIT } = {}) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", { code: "DB_NOT_CONFIGURED" });
  }

  const safeClienteId = assertUuid(idCliente, "id_cliente");
  const client = await app.db.connect();
  try {
    await materializeCyclesIfAvailable(client, safeClienteId);
    const cliente = await ensureClienteActivo(client, safeClienteId, { requireRegisteredUser: false });
    const agregados = await getAgregadosPuntos(client, safeClienteId);
    const puntosParaPremio = await resolvePuntosParaPremio(client, cliente.id_sucursal_origen || null);
    const safeRequired = Math.max(1, Number(puntosParaPremio || DEFAULT_PUNTOS_PARA_PREMIO));
    const saldo = Number(agregados.saldo_total || 0);
    const recompensasDisponibles = Math.floor(Math.max(0, saldo) / safeRequired);
    const progresoActual = ((saldo % safeRequired) + safeRequired) % safeRequired;
    const historial = await listMovimientosCompactos(client, safeClienteId, { limit: historyLimit });

    return {
      id_cliente: cliente.id_cliente,
      nombre_cliente: `${normalizeText(cliente.nombres)} ${normalizeText(cliente.apellidos)}`.trim() || "Cliente",
      saldo_total: saldo,
      puntos_titular: Number(agregados.puntos_titular || 0),
      puntos_integrante: Number(agregados.puntos_integrante || 0),
      puntos_para_premio: safeRequired,
      recompensas_disponibles: recompensasDisponibles,
      progreso_actual: progresoActual,
      puede_canjear: saldo >= safeRequired,
      historial,
    };
  } finally {
    client.release();
  }
}

export async function addManualPointsAdjustment(app, {
  idCliente,
  accion,
  puntos,
  motivo,
  usuarioAdmin,
} = {}) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", { code: "DB_NOT_CONFIGURED" });
  }

  const safeClienteId = assertUuid(idCliente, "id_cliente");
  const safeAccion = assertAjusteAccion(accion);
  const safePuntos = assertPositiveIntegerPoints(puntos);
  const safeMotivo = assertMotivoObligatorio(motivo);
  const adminUserId = assertAdminUserId(usuarioAdmin);
  const dbClient = await app.db.connect();

  try {
    await dbClient.query("BEGIN");
    await lockClientePointsScope(dbClient, safeClienteId);
    const cliente = await ensureClienteActivo(dbClient, safeClienteId, { requireRegisteredUser: true });
    await ensureClienteHasActiveAccessUser(dbClient, cliente.id_usuario, safeClienteId);
    const adjustmentTypes = await resolveManualAdjustmentTypes(dbClient);
    await materializeCyclesIfAvailable(dbClient, safeClienteId);

    const saldoActual = await getSaldoActual(dbClient, safeClienteId);
    if (safeAccion === "restar" && saldoActual < safePuntos) {
      throw new AppError(422, "No hay puntos suficientes para restar", {
        code: "POINTS_INSUFFICIENT_BALANCE",
        details: {
          saldo_actual: saldoActual,
          puntos: safePuntos,
        },
      });
    }
    const signedPoints = safeAccion === "restar" ? -safePuntos : safePuntos;
    const saldoSiguiente = saldoActual + signedPoints;
    const tipoPuntosCodigo = safeAccion === "restar" ? adjustmentTypes.restar : adjustmentTypes.sumar;

    const insertResult = await dbClient.query(
      `
        INSERT INTO public.points_transactions (
          id_cliente,
          id_sucursal_origen,
          tipo_puntos_codigo,
          origen_punto_codigo,
          puntos,
          motivo,
          creado_por_usuario_id
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::text,
          'sistema',
          $4::int,
          $5::text,
          $6::uuid
        )
        RETURNING
          id_points_tx,
          id_cliente,
          tipo_puntos_codigo,
          origen_punto_codigo,
          puntos,
          motivo,
          created_at
      `,
      [
        safeClienteId,
        cliente.id_sucursal_origen || null,
        tipoPuntosCodigo,
        safePuntos,
        safeMotivo,
        adminUserId,
      ]
    );

    const movimiento = insertResult.rows[0];
    const saldoActualizado = await getSaldoActual(dbClient, safeClienteId);
    await dbClient.query("COMMIT");

    return {
      id_points_tx: movimiento.id_points_tx,
      id_cliente: movimiento.id_cliente,
      tipo_puntos_codigo: movimiento.tipo_puntos_codigo,
      origen_punto_codigo: movimiento.origen_punto_codigo,
      puntos: Number(movimiento.puntos || 0),
      accion: safeAccion,
      motivo: movimiento.motivo ?? null,
      saldo_actual: saldoActualizado,
      saldo_siguiente: saldoSiguiente,
      created_at: movimiento.created_at ? new Date(movimiento.created_at).toISOString() : null,
    };
  } catch (error) {
    await dbClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    dbClient.release();
  }
}

export async function redeemReward(app, {
  idCliente,
  idServicioCanje,
  idSucursal,
  usuario, // eslint-disable-line no-unused-vars
  motivo, // eslint-disable-line no-unused-vars
} = {}) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", { code: "DB_NOT_CONFIGURED" });
  }

  const safeClienteId = assertUuid(idCliente, "id_cliente");
  const safeServicioId = assertUuid(idServicioCanje, "id_servicio");
  const safeSucursalId = assertUuid(idSucursal, "id_sucursal");
  const dbClient = await app.db.connect();

  try {
    await dbClient.query("BEGIN");
    await lockClientePointsScope(dbClient, safeClienteId);
    const cliente = await ensureClienteActivo(dbClient, safeClienteId, { requireRegisteredUser: true });
    await validateSucursalActiva(dbClient, safeSucursalId);
    await materializeCyclesIfAvailable(dbClient, safeClienteId);

    const puntosParaPremio = await resolvePuntosParaPremio(dbClient, cliente.id_sucursal_origen || null);
    const safeRequired = Math.max(1, Number(puntosParaPremio || DEFAULT_PUNTOS_PARA_PREMIO));
    const saldoActual = await getSaldoActual(dbClient, safeClienteId);
    if (saldoActual < safeRequired) {
      throw new AppError(409, "No hay puntos suficientes para canjear", {
        code: "POINTS_REDEEM_INSUFFICIENT_BALANCE",
        details: {
          saldo_actual: saldoActual,
          puntos_requeridos: safeRequired,
        },
      });
    }

    const planActivo = await hasActivePlan(dbClient, safeClienteId);
    const servicio = await resolveServicioCanjeValido(dbClient, {
      idServicioCanje: safeServicioId,
      idSucursal: safeSucursalId,
      hasPlanActivo: planActivo,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + REDEEM_CONTEXT_TTL_SECONDS;
    const canjeContextToken = buildRedeemContextToken({
      v: REDEEM_CONTEXT_TOKEN_VERSION,
      id_cliente: safeClienteId,
      id_servicio_canje: safeServicioId,
      id_sucursal: safeSucursalId,
      puntos_requeridos: safeRequired,
      iat: nowSeconds,
      exp: expiresAt,
    });
    await dbClient.query("COMMIT");

    return {
      canje_preparado: true,
      id_cliente: safeClienteId,
      id_servicio_canje: safeServicioId,
      servicio_nombre: servicio.nombre_servicio,
      id_sucursal: safeSucursalId,
      puntos_requeridos: Math.abs(safeRequired),
      saldo_actual: saldoActual,
      canje_activo: true,
      canje_pendiente_asociacion_hold: true,
      canje_context_token: canjeContextToken,
      created_at: new Date().toISOString(),
      contexto_canje: {
        id_cliente: safeClienteId,
        id_servicio_canje: safeServicioId,
        id_sucursal: safeSucursalId,
        canje_context_token: canjeContextToken,
      },
    };
  } catch (error) {
    await dbClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    dbClient.release();
  }
}
