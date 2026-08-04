import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "../utils/errors.js";
import { STORAGE_PRIVATE_BUCKET, STORAGE_PUBLIC_BUCKET } from "./storage/storageScopes.js";

const TERMINAL_REQUEST_STATES = ["completada", "rechazada", "cancelada"];
const REQUEST_CONFIRMABLE_STATES = ["pendiente_confirmacion", "bloqueada"];
const EXECUTION_TOKEN_START_STATES = ["evaluada", "procesando", "storage_pendiente", "auth_pendiente", "completada"];
const CONFIRMATION_TEXT = "ELIMINAR MI CUENTA";
const REAUTH_MAX_AGE_SECONDS = 5 * 60;
const REAUTH_FUTURE_TOLERANCE_SECONDS = 60;
const REAUTH_STORED_CLOCK_TOLERANCE_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_REFERENCE_RE = /^DEL-[A-F0-9]{12}$/;
const EXECUTION_TOKEN_TTL_MINUTES = 10;
const MAX_ACCOUNT_DELETION_ORCHESTRATION_ITERATIONS = 6;
const INTERNAL_CONFIRMATION_PHRASE = "SOLICITAR ELIMINACION DE MI CUENTA";
const INTERNAL_TERMINAL_REQUEST_STATES = ["completada", "rechazada", "cancelada"];
const INTERNAL_ACTIVE_REQUEST_STATES = ["pendiente_aprobacion", "aprobada", "procesando", "storage_pendiente", "auth_pendiente"];
const INTERNAL_CANCELABLE_STATES = ["pendiente_aprobacion"];
const INTERNAL_ALLOWED_ROLES = ["admin", "barbero", "root", "security_admin", "security_auditor", "super_admin"];
const INTERNAL_PROTECTED_ROLES = ["root", "super_admin"];

const BLOCKING_REASON_MESSAGES = {
  CLIENT_ACCOUNT_INTERNAL_ACCESS_REQUIRES_APPROVAL:
    "Esta cuenta también posee acceso interno a MASTERFADE y requiere revisión administrativa.",
  CLIENT_ACCOUNT_PROTECTED:
    "Esta cuenta está protegida y no puede eliminarse mediante el flujo de autoservicio.",
  CLIENT_ACCOUNT_PENDING_APPOINTMENTS:
    "Debes cancelar o completar tus citas pendientes antes de eliminar la cuenta.",
  CLIENT_ACCOUNT_ACTIVE_HOLDS:
    "Tienes una reserva temporal activa. Espera a que finalice o cancélala antes de eliminar la cuenta.",
  CLIENT_ACCOUNT_PENDING_PAYMENTS:
    "Hay una operación de pago en proceso. Debes esperar a que finalice antes de eliminar la cuenta.",
};

const CONSEQUENCE_MESSAGES = {
  CLIENT_ACCOUNT_MASTERPOINTS_WILL_BE_FORFEITED:
    "Los MasterPuntos disponibles se perderán permanentemente.",
  CLIENT_ACCOUNT_MEMBERSHIP_WILL_BE_CANCELLED:
    "La membresía activa y sus beneficios pendientes se perderán al eliminar la cuenta.",
  CLIENT_ACCOUNT_PENDING_MEMBERSHIP_ORDERS_WILL_BE_CANCELLED:
    "Las solicitudes de membresía pendientes se cancelarán al eliminar la cuenta.",
  CLIENT_ACCOUNT_HISTORY_WILL_BE_RETAINED_ANONYMIZED:
    "El historial operativo y transaccional se conservará de forma anonimizada.",
  CLIENT_ACCOUNT_AUTH_WILL_BE_PERMANENTLY_DELETED:
    "La identidad de acceso se eliminará permanentemente y esta acción no podrá revertirse.",
};

const INTERNAL_PROTECTED_MESSAGE = "Esta cuenta esta protegida y no puede solicitar su eliminacion desde este flujo.";

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function uniqueStringList(value) {
  return Array.from(new Set(normalizeStringList(value)));
}

function isInternalRole(role) {
  return INTERNAL_ALLOWED_ROLES.includes(String(role || "").trim());
}

function mapInternalSerializationConflict(error) {
  if (String(error?.code || "").trim() !== "40001") return error;
  return new AppError(409, "La solicitud cambio durante el procesamiento. Intenta nuevamente.", {
    code: "INTERNAL_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED",
  });
}

function assertInternalAccountDeletionIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (key.length < 16 || key.length > 160) {
    throw new AppError(400, "Debes enviar una clave de idempotencia valida.", {
      code: "INTERNAL_ACCOUNT_DELETION_IDEMPOTENCY_KEY_INVALID",
    });
  }
  return key;
}

export function validateInternalAccountDeletionRequestBody(body = {}) {
  if (String(body?.confirmation_phrase ?? "") !== INTERNAL_CONFIRMATION_PHRASE) {
    throw new AppError(400, "Debes escribir exactamente SOLICITAR ELIMINACION DE MI CUENTA para continuar.", {
      code: "INTERNAL_ACCOUNT_DELETION_CONFIRMATION_PHRASE_INVALID",
    });
  }

  const accepted = [
    body?.acknowledge_account_remains_active,
    body?.acknowledge_operational_dependencies,
    body?.acknowledge_access_revocation,
    body?.acknowledge_history_retention,
  ].every((value) => value === true);

  if (!accepted) {
    throw new AppError(400, "Debes aceptar todos los reconocimientos antes de continuar.", {
      code: "INTERNAL_ACCOUNT_DELETION_ACKNOWLEDGEMENTS_REQUIRED",
    });
  }
}

function decodeInternalJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function verifyRecentInternalAccountDeletionReauthentication(app, {
  reauthToken,
  expectedUserId,
} = {}) {
  const token = String(reauthToken || "").trim();
  if (!token) {
    throw new AppError(401, "Debes volver a autenticarte antes de enviar la solicitud.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_REQUIRED",
    });
  }

  if (!app?.supabaseAdmin) {
    throw new AppError(500, "No fue posible validar nuevamente la identidad.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_UNAVAILABLE",
    });
  }

  const authResult = await app.supabaseAdmin.auth.getUser(token);
  const authUser = authResult?.data?.user;
  if (authResult?.error || !authUser?.id) {
    throw new AppError(401, "Debes volver a autenticarte antes de enviar la solicitud.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_REQUIRED",
    });
  }

  if (String(authUser.id || "").trim() !== String(expectedUserId || "").trim()) {
    throw new AppError(403, "La reautenticacion no corresponde a la cuenta actual.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_USER_MISMATCH",
    });
  }

  const payload = decodeInternalJwtPayload(token);
  const issuedAt = Number(payload?.iat);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || issuedAt - nowSeconds > REAUTH_FUTURE_TOLERANCE_SECONDS) {
    throw new AppError(401, "Debes volver a autenticarte antes de enviar la solicitud.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_REQUIRED",
    });
  }
  if (nowSeconds - issuedAt > REAUTH_MAX_AGE_SECONDS) {
    throw new AppError(401, "La reautenticacion expiro. Vuelve a confirmar tu identidad.", {
      code: "INTERNAL_ACCOUNT_DELETION_REAUTH_EXPIRED",
    });
  }

  return {
    authUserId: authUser.id,
    authenticatedAt: new Date(issuedAt * 1000).toISOString(),
  };
}

const ACCOUNT_DELETION_PREVIEW_SQL = `
WITH params AS (
  SELECT
    $1::uuid AS cliente_id,
    $2::uuid AS persona_id,
    $3::uuid AS usuario_id
),
blocking_states AS (
  SELECT
    ARRAY['en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion']::text[]
      AS appointment_states,
    ARRAY['creado', 'link_generado', 'pendiente_confirmacion']::text[] AS intent_states,
    ARRAY['pendiente', 'autorizado']::text[] AS payment_states
),
context_cliente AS (
  SELECT c.id_cliente, c.id_persona, c.id_usuario
  FROM public.clientes c
  JOIN params p
    ON p.cliente_id = c.id_cliente
   AND p.persona_id = c.id_persona
   AND p.usuario_id = c.id_usuario
  WHERE c.estado IS TRUE
    AND c.deleted_at IS NULL
    AND COALESCE(c.anonimizado, FALSE) IS FALSE
  LIMIT 1
),
roles_activos AS (
  SELECT COALESCE(
    array_agg(DISTINCT r.nombre ORDER BY r.nombre) FILTER (WHERE r.nombre IS NOT NULL),
    ARRAY[]::text[]
  ) AS roles
  FROM params p
  LEFT JOIN public.roles_usuarios ru
    ON ru.id_usuario = p.usuario_id
   AND ru.activo IS TRUE
  LEFT JOIN public.roles r
    ON r.id_rol = ru.id_rol
),
account_flags AS (
  SELECT
    EXISTS (
      SELECT 1
      FROM public.empleados e
      JOIN params p ON p.persona_id = e.id_persona
      WHERE e.estado IS TRUE
        AND e.deleted_at IS NULL
    ) AS has_active_employee,
    EXISTS (
      SELECT 1
      FROM public.app_protected_users apu
      JOIN params p ON p.usuario_id = apu.id_usuario
      WHERE apu.activo IS TRUE
    ) AS is_protected
),
client_appointment_ids AS (
  SELECT DISTINCT c.id_cita
  FROM public.citas c
  JOIN params p ON TRUE
  LEFT JOIN public.citas_integrantes ci
    ON ci.id_cita_integrante = c.id_cita_integrante
    OR ci.id_grupo_cita = c.id_grupo_cita
  LEFT JOIN public.citas_grupos cg
    ON cg.id_grupo_cita = c.id_grupo_cita
  WHERE c.deleted_at IS NULL
    AND (
      c.id_cliente = p.cliente_id
      OR c.id_persona_cliente = p.persona_id
      OR ci.id_cliente = p.cliente_id
      OR ci.id_persona = p.persona_id
      OR ci.id_usuario = p.usuario_id
      OR cg.id_cliente_titular = p.cliente_id
      OR cg.id_persona_titular = p.persona_id
      OR cg.id_usuario_titular = p.usuario_id
    )
),
blocking_appointments_base AS (
  SELECT c.id_cita, c.estado_cita_codigo, c.inicio_at, c.fin_at, c.id_sucursal, c.id_empleado_barbero
  FROM public.citas c
  JOIN client_appointment_ids cai ON cai.id_cita = c.id_cita
  CROSS JOIN blocking_states bs
  WHERE c.estado_cita_codigo = ANY(bs.appointment_states)
),
blocking_appointments AS (
  SELECT
    COUNT(*)::int AS count,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id_cita', id_cita,
          'estado_cita_codigo', estado_cita_codigo,
          'inicio_at', inicio_at,
          'fin_at', fin_at,
          'id_sucursal', id_sucursal,
          'id_empleado_barbero', id_empleado_barbero
        )
        ORDER BY inicio_at ASC
      ) FILTER (WHERE item_rank <= 10),
      '[]'::jsonb
    ) AS items
  FROM (
    SELECT ba.*, row_number() OVER (ORDER BY ba.inicio_at ASC) AS item_rank
    FROM blocking_appointments_base ba
  ) ranked
),
client_group_ids AS (
  SELECT DISTINCT c.id_grupo_cita
  FROM public.citas c
  JOIN client_appointment_ids cai ON cai.id_cita = c.id_cita
  WHERE c.id_grupo_cita IS NOT NULL
  UNION
  SELECT DISTINCT cg.id_grupo_cita
  FROM public.citas_grupos cg
  JOIN params p ON TRUE
  WHERE cg.id_cliente_titular = p.cliente_id
     OR cg.id_persona_titular = p.persona_id
     OR cg.id_usuario_titular = p.usuario_id
),
client_related_holds AS (
  SELECT DISTINCT h.id_hold, h.estado_hold_codigo, h.expires_at
  FROM public.citas_holds h
  JOIN params p ON TRUE
  LEFT JOIN client_appointment_ids cai ON cai.id_cita = h.id_cita
  WHERE h.id_usuario = p.usuario_id OR cai.id_cita IS NOT NULL
),
client_holds AS (
  SELECT id_hold, expires_at
  FROM client_related_holds
  WHERE estado_hold_codigo = 'activo'
    AND expires_at > NOW()
),
active_holds AS (
  SELECT
    COUNT(*)::int AS count,
    MIN(expires_at) AS nearest_expiration_at
  FROM client_holds
),
pending_membership_orders AS (
  SELECT COUNT(DISTINCT mpo.id_order)::int AS count
  FROM public.membership_purchase_orders mpo
  JOIN params p ON p.cliente_id = mpo.id_cliente
  WHERE mpo.estado_orden_codigo = 'pendiente_pago'
),
client_intents AS (
  SELECT DISTINCT pi.id_intent
  FROM public.payment_intents pi
  JOIN params p ON TRUE
  LEFT JOIN client_appointment_ids cai ON cai.id_cita = pi.id_cita
  LEFT JOIN client_group_ids cgi ON cgi.id_grupo_cita = pi.id_grupo_cita
  LEFT JOIN client_related_holds crh ON crh.id_hold = pi.id_hold
  LEFT JOIN public.membership_purchase_orders mpo
    ON mpo.id_order = pi.id_membership_order
   AND mpo.id_cliente = p.cliente_id
  WHERE pi.created_by_usuario_id = p.usuario_id
     OR cai.id_cita IS NOT NULL
     OR cgi.id_grupo_cita IS NOT NULL
     OR crh.id_hold IS NOT NULL
     OR mpo.id_order IS NOT NULL
),
pending_payment_intents AS (
  SELECT COUNT(DISTINCT pi.id_intent)::int AS count
  FROM public.payment_intents pi
  JOIN client_intents ci ON ci.id_intent = pi.id_intent
  CROSS JOIN blocking_states bs
  WHERE pi.estado_intent_codigo = ANY(bs.intent_states)
),
pending_payments AS (
  SELECT COUNT(DISTINCT pay.id_payment)::int AS count
  FROM public.payments pay
  JOIN client_intents ci ON ci.id_intent = pay.id_intent
  CROSS JOIN blocking_states bs
  WHERE pay.estado_pago_codigo = ANY(bs.payment_states)
),
masterpoints AS (
  SELECT COALESCE(MAX(vpb.balance)::numeric, 0) AS balance
  FROM (
    SELECT COALESCE(vw.balance_puntos, 0)::numeric AS balance
    FROM public.vw_points_balance vw
    JOIN params p ON p.cliente_id = vw.id_cliente
  ) vpb
),
active_membership AS (
  SELECT
    s.id_suscripcion,
    s.id_plan,
    mp.nombre_plan,
    s.inicio_at,
    s.fin_at,
    s.renovacion_auto,
    s.cancelada_al_fin,
    s.id_sucursal_contratada
  FROM public.subscriptions s
  JOIN public.membership_plans mp ON mp.id_plan = s.id_plan
  JOIN params p ON p.cliente_id = s.id_cliente
  WHERE s.estado_suscripcion_codigo = 'activa'
  ORDER BY s.created_at DESC NULLS LAST, s.inicio_at DESC NULLS LAST, s.id_suscripcion DESC
  LIMIT 1
),
retained_history AS (
  SELECT
    (SELECT COUNT(DISTINCT cai.id_cita)::int FROM client_appointment_ids cai) AS appointments_count,
    (
      SELECT COUNT(DISTINCT pay.id_payment)::int
      FROM public.payments pay
      JOIN client_intents ci ON ci.id_intent = pay.id_intent
    ) AS payments_count,
    (
      SELECT COUNT(DISTINCT s.id_suscripcion)::int
      FROM public.subscriptions s
      JOIN params p ON p.cliente_id = s.id_cliente
    ) AS subscriptions_count,
    (
      SELECT COUNT(DISTINCT pt.id_points_tx)::int
      FROM public.points_transactions pt
      JOIN params p ON p.cliente_id = pt.id_cliente
    ) AS points_transactions_count
)
SELECT
  EXISTS (SELECT 1 FROM context_cliente) AS context_found,
  (SELECT roles FROM roles_activos) AS active_roles,
  (SELECT has_active_employee FROM account_flags) AS has_active_employee,
  (SELECT is_protected FROM account_flags) AS is_protected,
  jsonb_build_object(
    'count', COALESCE((SELECT count FROM blocking_appointments), 0),
    'items', COALESCE((SELECT items FROM blocking_appointments), '[]'::jsonb)
  ) AS blocking_appointments,
  jsonb_build_object(
    'count', COALESCE((SELECT count FROM active_holds), 0),
    'nearest_expiration_at', (SELECT nearest_expiration_at FROM active_holds)
  ) AS active_holds,
  jsonb_build_object(
    'intent_count', COALESCE((SELECT count FROM pending_payment_intents), 0),
    'payment_count', COALESCE((SELECT count FROM pending_payments), 0)
  ) AS pending_payments,
  COALESCE((SELECT balance FROM masterpoints), 0) AS masterpoints_balance,
  (
    SELECT to_jsonb(am)
    FROM active_membership am
  ) AS active_membership,
  COALESCE((SELECT count FROM pending_membership_orders), 0) AS pending_membership_order_count,
  jsonb_build_object(
    'appointments_count', COALESCE((SELECT appointments_count FROM retained_history), 0),
    'payments_count', COALESCE((SELECT payments_count FROM retained_history), 0),
    'subscriptions_count', COALESCE((SELECT subscriptions_count FROM retained_history), 0),
    'points_transactions_count', COALESCE((SELECT points_transactions_count FROM retained_history), 0)
  ) AS retained_history,
  NOW() AS evaluated_at
`;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIsoString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeJsonObject(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function makeMessage(code, messages) {
  return {
    code,
    message: messages[code],
  };
}

function sanitizeBlockingReasons(blockingReasons) {
  if (!Array.isArray(blockingReasons)) return [];
  return blockingReasons.map((item) => ({
    code: String(item?.code || ""),
    message: String(item?.message || ""),
  })).filter((item) => item.code && item.message);
}

export function generateAccountDeletionExecutionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashAccountDeletionExecutionToken(token) {
  return createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
}

export function verifyAccountDeletionExecutionToken(token, storedHash) {
  const candidateHash = hashAccountDeletionExecutionToken(token);
  const stored = String(storedHash || "").trim();
  if (!/^[0-9a-f]{64}$/.test(stored) || !/^[0-9a-f]{64}$/.test(candidateHash)) return false;

  const candidateBuffer = Buffer.from(candidateHash, "hex");
  const storedBuffer = Buffer.from(stored, "hex");
  if (candidateBuffer.length !== storedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, storedBuffer);
}

function issueAccountDeletionExecutionToken() {
  const token = generateAccountDeletionExecutionToken();
  return {
    token,
    tokenHash: hashAccountDeletionExecutionToken(token),
  };
}

function assertAccountDeletionExecutionReference(reference) {
  const normalized = String(reference || "").trim();
  if (!PUBLIC_REFERENCE_RE.test(normalized)) {
    throw new AppError(400, "La referencia de eliminacion no es valida.", {
      code: "CLIENT_ACCOUNT_DELETION_EXECUTION_REFERENCE_INVALID",
    });
  }
  return normalized;
}

function assertAccountDeletionExecutionTokenInput(executionToken) {
  const token = String(executionToken || "").trim();
  if (token.length < 40 || token.length > 100) {
    throw new AppError(400, "Debes enviar el token de continuacion de la eliminacion.", {
      code: "CLIENT_ACCOUNT_DELETION_EXECUTION_TOKEN_REQUIRED",
    });
  }
  return token;
}

function executionCredentialInvalidError() {
  return new AppError(401, "No fue posible validar la continuacion de la eliminacion.", {
    code: "CLIENT_ACCOUNT_DELETION_EXECUTION_CREDENTIAL_INVALID",
  });
}

function buildExecutionTokenResponse(row, token) {
  if (!token || row?.estado_codigo !== "evaluada") return undefined;
  return {
    token,
    expires_at: toIsoString(row.execution_token_expires_at),
  };
}

function buildImpactSummary(preview) {
  return {
    masterpoints_balance: toNumber(preview?.masterpoints?.balance, 0),
    masterpoints_will_forfeit: Boolean(preview?.masterpoints?.will_forfeit),
    membership_will_cancel: Boolean(preview?.membership?.will_cancel),
    pending_membership_orders_count: toNumber(preview?.pending_membership_orders?.count, 0),
    appointments_history_count: toNumber(preview?.retained_history?.appointments_count, 0),
    payments_history_count: toNumber(preview?.retained_history?.payments_count, 0),
    subscriptions_history_count: toNumber(preview?.retained_history?.subscriptions_count, 0),
    points_transactions_history_count: toNumber(preview?.retained_history?.points_transactions_count, 0),
    evaluated_at: toIsoString(preview?.evaluated_at) || new Date().toISOString(),
  };
}

function mergeInternalExecutionSummary(resumenImpacto, internalExecution) {
  return {
    ...normalizeJsonObject(resumenImpacto, {}),
    internal_execution: {
      ...internalExecution,
      pii_anonymized: false,
      storage_processed: false,
      auth_processed: false,
    },
  };
}

function mergeInternalAnonymizationSummary(resumenImpacto, internalAnonymization) {
  return {
    ...normalizeJsonObject(resumenImpacto, {}),
    internal_anonymization: {
      ...internalAnonymization,
      pii_anonymized: true,
      storage_processed: false,
      auth_processed: false,
    },
  };
}

function serializeRequestRow(row, { preview = null } = {}) {
  const estadoCodigo = String(row?.estado_codigo || "");
  return {
    id_solicitud: row?.id_solicitud ?? null,
    referencia_publica: row?.referencia_publica ?? null,
    estado_codigo: estadoCodigo,
    solicitado_at: toIsoString(row?.solicitado_at),
    reautenticado_at: toIsoString(row?.reautenticado_at),
    can_confirm: estadoCodigo === "pendiente_confirmacion" && preview?.can_delete === true,
  };
}

function mapActiveRequestDetails(row) {
  return {
    id_solicitud: row?.id_solicitud ?? null,
    referencia_publica: row?.referencia_publica ?? null,
    estado_codigo: row?.estado_codigo ?? null,
  };
}

function mapSerializationConflict(error) {
  if (String(error?.code || "").trim() !== "40001") return error;
  return new AppError(409, "La cuenta cambiÃ³ durante el procesamiento. Intenta nuevamente.", {
    code: "CLIENT_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED",
  });
}

function assertRecentProcessingReauthentication(authenticatedAt, storedReauthenticatedAt) {
  const authenticatedDate = new Date(authenticatedAt);
  const authenticatedMs = authenticatedDate.getTime();
  if (!Number.isFinite(authenticatedMs)) {
    throw new AppError(401, "Debes volver a autenticarte antes de procesar la eliminaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
    });
  }

  const nowMs = Date.now();
  if (authenticatedMs - nowMs > REAUTH_FUTURE_TOLERANCE_SECONDS * 1000) {
    throw new AppError(401, "Debes volver a autenticarte antes de procesar la eliminaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
    });
  }

  if (nowMs - authenticatedMs > REAUTH_MAX_AGE_SECONDS * 1000) {
    throw new AppError(401, "Debes volver a autenticarte antes de procesar la eliminaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
    });
  }

  const storedDate = new Date(storedReauthenticatedAt);
  const storedMs = storedDate.getTime();
  if (!Number.isFinite(storedMs)) {
    throw new AppError(401, "Debes volver a autenticarte antes de procesar la eliminaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
    });
  }

  if (authenticatedMs + REAUTH_STORED_CLOCK_TOLERANCE_SECONDS * 1000 < storedMs) {
    throw new AppError(401, "Debes volver a autenticarte antes de procesar la eliminaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
    });
  }
}

function normalizePostgresConflict(error) {
  if (error?.code !== "23505") return error;
  const constraint = String(error?.constraint || "");
  if (
    constraint === "uq_solicitud_eliminacion_idempotencia"
    || constraint === "uq_solicitud_eliminacion_cliente_activa"
    || constraint === "uq_solicitud_eliminacion_usuario_activa"
  ) {
    return new AppError(409, "Ya existe una solicitud de eliminación activa para esta cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_ALREADY_ACTIVE",
    });
  }
  return error;
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function assertConfirmationInputs(body = {}) {
  if (String(body?.confirmacion_texto ?? "").trim() !== CONFIRMATION_TEXT) {
    throw new AppError(400, "Debes escribir exactamente “ELIMINAR MI CUENTA” para continuar.", {
      code: "CLIENT_ACCOUNT_DELETION_CONFIRMATION_TEXT_INVALID",
    });
  }

  const accepted = [
    body?.acepta_perder_masterpuntos,
    body?.acepta_cancelar_membresia,
    body?.acepta_historial_anonimizado,
    body?.acepta_irreversibilidad,
  ].every((value) => value === true);

  if (!accepted) {
    throw new AppError(400, "Debes aceptar todas las consecuencias antes de continuar.", {
      code: "CLIENT_ACCOUNT_DELETION_ACCEPTANCES_REQUIRED",
    });
  }
}

async function acquireAccountDeletionUserLock(client, usuarioId) {
  await client.query(
    `
      SELECT pg_advisory_xact_lock(
        hashtext('masterfade.account_deletion'),
        hashtext($1::text)
      )
    `,
    [usuarioId]
  );
}

async function findActiveAccountDeletionRequest(client, clienteId) {
  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        idempotency_key,
        solicitado_at,
        reautenticado_at,
        resumen_impacto,
        execution_token_hash,
        execution_token_issued_at,
        execution_token_expires_at,
        execution_token_last_used_at
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_cliente = $1::uuid
        AND tipo_sujeto = 'cliente'
        AND estado_codigo <> ALL($2::text[])
      ORDER BY solicitado_at DESC, id_solicitud DESC
      LIMIT 1
      FOR UPDATE
    `,
    [clienteId, TERMINAL_REQUEST_STATES]
  );
  return rows?.[0] ?? null;
}

async function findAccountDeletionRequestForConfirmation(client, {
  requestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT id_solicitud, referencia_publica, estado_codigo, idempotency_key, solicitado_at, reautenticado_at
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND id_cliente = $2::uuid
        AND id_persona = $3::uuid
        AND id_usuario = $4::uuid
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
      LIMIT 1
      FOR UPDATE
    `,
    [requestId, clienteId, personaId, usuarioId]
  );
  return rows?.[0] ?? null;
}

async function updateAccountDeletionRequestAfterConfirmation(client, {
  requestId,
  estadoCodigo,
  reautenticadoAt,
  bloqueosDetectados,
  resumenImpacto,
  traceRequestId,
  executionTokenHash = null,
}) {
  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = $2::text,
          reautenticado_at = $3::timestamptz,
          bloqueos_detectados = $4::jsonb,
          resumen_impacto = $5::jsonb,
          request_id = $6::text,
          execution_token_hash = CASE WHEN $2::text = 'evaluada' THEN $7::text ELSE NULL END,
          execution_token_issued_at = CASE WHEN $2::text = 'evaluada' THEN NOW() ELSE execution_token_issued_at END,
          execution_token_expires_at = CASE
            WHEN $2::text = 'evaluada' THEN NOW() + ($8::int * INTERVAL '1 minute')
            ELSE NULL
          END,
          execution_token_last_used_at = CASE WHEN $2::text = 'evaluada' THEN NULL ELSE execution_token_last_used_at END
      WHERE id_solicitud = $1::uuid
      RETURNING
        id_solicitud,
        referencia_publica,
        estado_codigo,
        solicitado_at,
        reautenticado_at,
        execution_token_expires_at
    `,
    [
      requestId,
      estadoCodigo,
      reautenticadoAt,
      JSON.stringify(bloqueosDetectados),
      JSON.stringify(resumenImpacto),
      traceRequestId,
      executionTokenHash,
      EXECUTION_TOKEN_TTL_MINUTES,
    ]
  );
  return rows?.[0] ?? null;
}

function normalizeAppointmentItem(item) {
  return {
    id_cita: item.id_cita ?? null,
    estado_cita_codigo: item.estado_cita_codigo ?? null,
    inicio_at: toIsoString(item.inicio_at),
    fin_at: toIsoString(item.fin_at),
    id_sucursal: item.id_sucursal ?? null,
    id_empleado_barbero: item.id_empleado_barbero ?? null,
  };
}

function buildPreviewPayload(row) {
  const activeRoles = Array.isArray(row.active_roles)
    ? row.active_roles.map((role) => String(role || "").trim()).filter(Boolean)
    : [];
  const hasActiveEmployee = Boolean(row.has_active_employee);
  const isProtected = Boolean(row.is_protected);
  const hasInternalRole = activeRoles.some((role) => role !== "cliente");
  const onlyClienteRole = activeRoles.length > 0 && activeRoles.every((role) => role === "cliente");
  const hasInternalAccess = hasActiveEmployee || hasInternalRole || !onlyClienteRole;
  const requiresApproval = hasInternalAccess || isProtected;
  const accountMode = requiresApproval ? "requiere_aprobacion" : "autonomo";

  const blockingAppointmentsRaw = normalizeJsonObject(row.blocking_appointments, { count: 0, items: [] });
  const blockingAppointments = {
    count: toNumber(blockingAppointmentsRaw.count, 0),
    items: Array.isArray(blockingAppointmentsRaw.items)
      ? blockingAppointmentsRaw.items.map(normalizeAppointmentItem)
      : [],
  };

  const activeHoldsRaw = normalizeJsonObject(row.active_holds, { count: 0, nearest_expiration_at: null });
  const activeHolds = {
    count: toNumber(activeHoldsRaw.count, 0),
    nearest_expiration_at: toIsoString(activeHoldsRaw.nearest_expiration_at),
  };

  const pendingPaymentsRaw = normalizeJsonObject(row.pending_payments, { intent_count: 0, payment_count: 0 });
  const intentCount = toNumber(pendingPaymentsRaw.intent_count, 0);
  const paymentCount = toNumber(pendingPaymentsRaw.payment_count, 0);
  const pendingPayments = {
    intent_count: intentCount,
    payment_count: paymentCount,
    total_count: intentCount + paymentCount,
  };

  const masterpointsBalance = toNumber(row.masterpoints_balance, 0);
  const activeMembership = normalizeJsonObject(row.active_membership, null);
  const pendingMembershipOrderCount = toNumber(row.pending_membership_order_count, 0);

  const retainedHistoryRaw = normalizeJsonObject(row.retained_history, {});
  const retainedHistory = {
    appointments_count: toNumber(retainedHistoryRaw.appointments_count, 0),
    payments_count: toNumber(retainedHistoryRaw.payments_count, 0),
    subscriptions_count: toNumber(retainedHistoryRaw.subscriptions_count, 0),
    points_transactions_count: toNumber(retainedHistoryRaw.points_transactions_count, 0),
    will_be_anonymized: true,
  };

  const blockingReasons = [];
  if (hasInternalAccess) {
    blockingReasons.push(
      makeMessage("CLIENT_ACCOUNT_INTERNAL_ACCESS_REQUIRES_APPROVAL", BLOCKING_REASON_MESSAGES)
    );
  }
  if (isProtected) {
    blockingReasons.push(makeMessage("CLIENT_ACCOUNT_PROTECTED", BLOCKING_REASON_MESSAGES));
  }
  if (blockingAppointments.count > 0) {
    blockingReasons.push(makeMessage("CLIENT_ACCOUNT_PENDING_APPOINTMENTS", BLOCKING_REASON_MESSAGES));
  }
  if (activeHolds.count > 0) {
    blockingReasons.push(makeMessage("CLIENT_ACCOUNT_ACTIVE_HOLDS", BLOCKING_REASON_MESSAGES));
  }
  if (pendingPayments.total_count > 0) {
    blockingReasons.push(makeMessage("CLIENT_ACCOUNT_PENDING_PAYMENTS", BLOCKING_REASON_MESSAGES));
  }

  const consequences = [];
  if (masterpointsBalance > 0) {
    consequences.push(makeMessage("CLIENT_ACCOUNT_MASTERPOINTS_WILL_BE_FORFEITED", CONSEQUENCE_MESSAGES));
  }
  if (activeMembership) {
    consequences.push(makeMessage("CLIENT_ACCOUNT_MEMBERSHIP_WILL_BE_CANCELLED", CONSEQUENCE_MESSAGES));
  }
  if (pendingMembershipOrderCount > 0) {
    consequences.push(
      makeMessage("CLIENT_ACCOUNT_PENDING_MEMBERSHIP_ORDERS_WILL_BE_CANCELLED", CONSEQUENCE_MESSAGES)
    );
  }
  consequences.push(
    makeMessage("CLIENT_ACCOUNT_HISTORY_WILL_BE_RETAINED_ANONYMIZED", CONSEQUENCE_MESSAGES),
    makeMessage("CLIENT_ACCOUNT_AUTH_WILL_BE_PERMANENTLY_DELETED", CONSEQUENCE_MESSAGES)
  );

  return {
    can_delete: !requiresApproval && blockingReasons.length === 0,
    account_mode: accountMode,
    requires_approval: requiresApproval,
    blocking_reasons: blockingReasons,
    consequences,
    blocking_appointments: blockingAppointments,
    active_holds: activeHolds,
    pending_payments: pendingPayments,
    masterpoints: {
      balance: masterpointsBalance,
      will_forfeit: masterpointsBalance > 0,
    },
    membership: {
      will_cancel: Boolean(activeMembership),
      active_plan: activeMembership
        ? {
            id_suscripcion: activeMembership.id_suscripcion ?? null,
            id_plan: activeMembership.id_plan ?? null,
            nombre_plan: activeMembership.nombre_plan ?? null,
            inicio_at: toIsoString(activeMembership.inicio_at),
            fin_at: toIsoString(activeMembership.fin_at),
            renovacion_auto: Boolean(activeMembership.renovacion_auto),
            cancelada_al_fin: Boolean(activeMembership.cancelada_al_fin),
            id_sucursal_contratada: activeMembership.id_sucursal_contratada ?? null,
          }
        : null,
    },
    pending_membership_orders: {
      count: pendingMembershipOrderCount,
      will_cancel: pendingMembershipOrderCount > 0,
    },
    retained_history: retainedHistory,
    evaluated_at: toIsoString(row.evaluated_at) || new Date().toISOString(),
  };
}

export async function evaluateClientAccountDeletion(client, {
  clienteId,
  personaId,
  usuarioId,
} = {}) {
  const result = await client.query(
    ACCOUNT_DELETION_PREVIEW_SQL,
    [
      clienteId,
      personaId,
      usuarioId,
    ]
  );
  const row = result.rows?.[0] ?? null;

  if (!row?.context_found) {
    throw new AppError(404, "No se encontró una cuenta de cliente activa para evaluar.", {
      code: "CLIENT_ACCOUNT_DELETION_CONTEXT_NOT_FOUND",
    });
  }

  return buildPreviewPayload(row);
}

export function validateClientAccountDeletionConfirmationBody(body = {}) {
  assertConfirmationInputs(body);
}

export async function createClientAccountDeletionRequest(client, {
  clienteId,
  personaId,
  usuarioId,
  idempotencyKey,
  requestId,
} = {}) {
  await acquireAccountDeletionUserLock(client, usuarioId);

  const preview = await evaluateClientAccountDeletion(client, {
    clienteId,
    personaId,
    usuarioId,
  });

  if (preview.requires_approval) {
    throw new AppError(409, "Esta cuenta requiere revisión administrativa y no puede usar la eliminación autónoma.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUIRES_APPROVAL",
      details: {
        account_mode: "requiere_aprobacion",
        blocking_reasons: [],
      },
    });
  }

  const activeRequest = await findActiveAccountDeletionRequest(client, clienteId);
  if (activeRequest) {
    if (activeRequest.idempotency_key === idempotencyKey) {
      return {
        request: serializeRequestRow(activeRequest, { preview }),
        idempotent_replay: true,
        preview,
      };
    }

    throw new AppError(409, "Ya existe una solicitud de eliminación activa para esta cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_ALREADY_ACTIVE",
      details: mapActiveRequestDetails(activeRequest),
    });
  }

  const bloqueosDetectados = sanitizeBlockingReasons(preview.blocking_reasons);
  const resumenImpacto = buildImpactSummary(preview);
  const estadoCodigo = bloqueosDetectados.length > 0 ? "bloqueada" : "pendiente_confirmacion";

  try {
    const { rows } = await client.query(
      `
        INSERT INTO app_private.solicitudes_eliminacion_cuenta (
          tipo_sujeto,
          id_persona,
          id_usuario,
          id_cliente,
          id_empleado,
          modo_proceso,
          requiere_aprobacion,
          origen_codigo,
          estado_codigo,
          idempotency_key,
          request_id,
          bloqueos_detectados,
          resumen_impacto
        )
        VALUES (
          'cliente',
          $1::uuid,
          $2::uuid,
          $3::uuid,
          NULL,
          'autonomo',
          FALSE,
          'cliente',
          $4::text,
          $5::text,
          $6::text,
          $7::jsonb,
          $8::jsonb
        )
        RETURNING id_solicitud, referencia_publica, estado_codigo, solicitado_at, reautenticado_at
      `,
      [
        personaId,
        usuarioId,
        clienteId,
        estadoCodigo,
        idempotencyKey,
        requestId,
        JSON.stringify(bloqueosDetectados),
        JSON.stringify(resumenImpacto),
      ]
    );

    const row = rows?.[0];
    return {
      request: serializeRequestRow(row, { preview }),
      idempotent_replay: false,
      preview,
    };
  } catch (error) {
    throw normalizePostgresConflict(error);
  }
}

export async function confirmClientAccountDeletionRequest(client, {
  requestId,
  clienteId,
  personaId,
  usuarioId,
  authenticatedAt,
  traceRequestId,
} = {}) {
  await acquireAccountDeletionUserLock(client, usuarioId);

  const existing = await findAccountDeletionRequestForConfirmation(client, {
    requestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!existing) {
    throw new AppError(404, "No se encontró la solicitud de eliminación indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (existing.estado_codigo === "evaluada" && existing.reautenticado_at) {
    const executionToken = issueAccountDeletionExecutionToken();
    const updated = await updateAccountDeletionRequestAfterConfirmation(client, {
      requestId,
      estadoCodigo: "evaluada",
      reautenticadoAt: authenticatedAt,
      bloqueosDetectados: [],
      resumenImpacto: normalizeJsonObject(existing.resumen_impacto, {}),
      traceRequestId,
      executionTokenHash: executionToken.tokenHash,
    });

    return {
      request: serializeRequestRow(updated),
      ready_for_processing: true,
      idempotent_replay: true,
      execution: buildExecutionTokenResponse(updated, executionToken.token),
      preview: null,
    };
  }

  if (!REQUEST_CONFIRMABLE_STATES.includes(existing.estado_codigo)) {
    throw new AppError(409, "La solicitud no se encuentra en un estado válido para confirmación.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_STATE_INVALID",
      details: mapActiveRequestDetails(existing),
    });
  }

  const preview = await evaluateClientAccountDeletion(client, {
    clienteId,
    personaId,
    usuarioId,
  });
  const bloqueosDetectados = sanitizeBlockingReasons(preview.blocking_reasons);
  const resumenImpacto = buildImpactSummary(preview);
  const shouldBlock = preview.requires_approval || bloqueosDetectados.length > 0;

  const executionToken = shouldBlock ? null : issueAccountDeletionExecutionToken();
  const updated = await updateAccountDeletionRequestAfterConfirmation(client, {
    requestId,
    estadoCodigo: shouldBlock ? "bloqueada" : "evaluada",
    reautenticadoAt: shouldBlock ? null : authenticatedAt,
    bloqueosDetectados,
    resumenImpacto,
    traceRequestId,
    executionTokenHash: executionToken?.tokenHash ?? null,
  });

  return {
    request: serializeRequestRow(updated, { preview }),
    ready_for_processing: !shouldBlock,
    idempotent_replay: false,
    ...(executionToken ? { execution: buildExecutionTokenResponse(updated, executionToken.token) } : {}),
    preview,
  };
}

function serializeInternalRequestRow(row) {
  if (!row) return null;
  const estadoCodigo = String(row.estado_codigo || "");
  return {
    id_solicitud: row.id_solicitud ?? null,
    referencia_publica: row.referencia_publica ?? null,
    estado_codigo: estadoCodigo,
    solicitado_at: toIsoString(row.solicitado_at),
    requiere_aprobacion: row.requiere_aprobacion === true,
    can_cancel: estadoCodigo === "pendiente_aprobacion",
  };
}

async function loadInternalAccountIdentity(client, {
  usuarioId,
  personaId,
  employeeIdFromClaims,
  rolesFromClaims,
} = {}) {
  const roles = uniqueStringList(rolesFromClaims).filter(isInternalRole);
  const userResult = await client.query(
    `
      SELECT u.id_usuario, u.id_persona, u.estado, u.estado_acceso, u.deleted_at, p.id_persona AS persona_exists
      FROM public.usuarios u
      LEFT JOIN public.personas p
        ON p.id_persona = u.id_persona
      WHERE u.id_usuario = $1::uuid
      LIMIT 1
    `,
    [usuarioId]
  );
  const user = userResult.rows?.[0] ?? null;

  if (!user || user.deleted_at || user.estado !== true) {
    return {
      hardBlock: {
        code: "INTERNAL_ACCOUNT_DELETION_USER_NOT_ACTIVE",
        message: "La cuenta interna no esta activa para solicitar este proceso.",
      },
      roles,
      activeEmployees: [],
      selectedEmployee: null,
    };
  }

  const resolvedPersonaId = String(user.id_persona || personaId || "").trim();
  if (!resolvedPersonaId || !user.persona_exists) {
    return {
      hardBlock: {
        code: "INTERNAL_ACCOUNT_DELETION_PERSON_NOT_FOUND",
        message: "No fue posible confirmar la identidad personal de esta cuenta.",
      },
      roles,
      activeEmployees: [],
      selectedEmployee: null,
    };
  }

  const roleResult = await client.query(
    `
      SELECT DISTINCT r.nombre
      FROM public.roles_usuarios ru
      JOIN public.roles r
        ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1::uuid
        AND ru.activo IS TRUE
    `,
    [usuarioId]
  );
  const dbRoles = uniqueStringList(roleResult.rows?.map((row) => row.nombre)).filter(isInternalRole);
  const activeRoles = dbRoles.length ? dbRoles : roles;

  if (!activeRoles.length) {
    return {
      hardBlock: {
        code: "INTERNAL_ACCOUNT_DELETION_INTERNAL_ROLE_NOT_FOUND",
        message: "La cuenta no tiene un rol interno activo para solicitar este proceso.",
      },
      roles: activeRoles,
      activeEmployees: [],
      selectedEmployee: null,
    };
  }

  const activeEmployeesResult = await client.query(
    `
      SELECT id_empleado, id_persona, id_sucursal, COALESCE(es_barbero, FALSE) AS es_barbero
      FROM public.empleados
      WHERE id_persona = $1::uuid
        AND estado IS TRUE
        AND deleted_at IS NULL
      ORDER BY id_empleado ASC
    `,
    [resolvedPersonaId]
  );
  const activeEmployees = activeEmployeesResult.rows || [];

  if (!activeEmployees.length) {
    return {
      hardBlock: {
        code: "INTERNAL_ACCOUNT_DELETION_EMPLOYEE_NOT_FOUND",
        message: "La cuenta no tiene un vinculo laboral activo para solicitar este proceso.",
      },
      roles: activeRoles,
      activeEmployees,
      selectedEmployee: null,
    };
  }

  const claimEmployeeId = String(employeeIdFromClaims || "").trim();
  const selectedFromClaims = claimEmployeeId
    ? activeEmployees.find((employee) => String(employee.id_empleado) === claimEmployeeId)
    : null;
  let selectedEmployee = selectedFromClaims || null;
  if (!selectedEmployee && activeEmployees.length === 1) {
    selectedEmployee = activeEmployees[0];
  }

  if (!selectedEmployee) {
    return {
      hardBlock: {
        code: "INTERNAL_ACCOUNT_DELETION_EMPLOYEE_CONTEXT_AMBIGUOUS",
        message: "No fue posible determinar el vinculo laboral principal de esta cuenta.",
      },
      roles: activeRoles,
      activeEmployees,
      selectedEmployee: null,
    };
  }

  return {
    hardBlock: null,
    usuarioId,
    personaId: resolvedPersonaId,
    roles: activeRoles,
    activeEmployees,
    selectedEmployee,
  };
}

async function isProtectedInternalAccount(client, usuarioId) {
  const result = await client.query(
    `
      SELECT 1
      FROM public.app_protected_users
      WHERE id_usuario = $1::uuid
        AND activo IS TRUE
      LIMIT 1
    `,
    [usuarioId]
  );
  return result.rowCount > 0;
}

async function countInternalDependencies(client, employeeIds) {
  const ids = Array.isArray(employeeIds) ? employeeIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!ids.length) {
    return {
      future_operational_appointments: 0,
      active_weekly_schedules: 0,
      future_agenda_blocks: 0,
      public_barber_profiles: 0,
      employee_service_rates: 0,
      promotion_references: 0,
    };
  }

  const result = await client.query(
    `
      WITH employee_ids AS (
        SELECT unnest($1::uuid[]) AS id_empleado
      ),
      future_citas AS (
        SELECT COUNT(*)::int AS count
        FROM public.citas c
        JOIN employee_ids e ON e.id_empleado = c.id_empleado_barbero
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= NOW()
          AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
      ),
      weekly_schedules AS (
        SELECT COUNT(*)::int AS count
        FROM public.horarios_semanales_empleados h
        JOIN employee_ids e ON e.id_empleado = h.id_empleado
        WHERE COALESCE(h.activo, TRUE) IS TRUE
      ),
      agenda_blocks_employee AS (
        SELECT COUNT(*)::int AS count
        FROM public.agenda_bloqueos_empleados b
        JOIN employee_ids e ON e.id_empleado = b.id_empleado
        WHERE COALESCE(b.deleted_at, NULL) IS NULL
      ),
      agenda_blocks AS (
        SELECT COUNT(*)::int AS count
        FROM public.bloqueos_agenda b
        JOIN employee_ids e ON e.id_empleado = b.id_empleado
        WHERE COALESCE(b.deleted_at, NULL) IS NULL
      ),
      public_profiles AS (
        SELECT COUNT(*)::int AS count
        FROM public.barberos_perfiles_publicos p
        JOIN employee_ids e ON e.id_empleado = p.id_empleado
        WHERE COALESCE(p.activo, TRUE) IS TRUE
      ),
      service_rates AS (
        SELECT COUNT(*)::int AS count
        FROM public.servicios_tarifas st
        JOIN employee_ids e ON e.id_empleado = st.id_empleado
        WHERE COALESCE(st.deleted_at, NULL) IS NULL
      ),
      promotion_cupos AS (
        SELECT COUNT(*)::int AS count
        FROM public.promociones_reglas_cupos prc
        JOIN employee_ids e ON e.id_empleado = prc.id_empleado_barbero
      ),
      promotion_restrictions AS (
        SELECT COUNT(*)::int AS count
        FROM public.promociones_restricciones_agendamiento pra
        JOIN employee_ids e ON e.id_empleado = pra.id_empleado_barbero
      )
      SELECT
        COALESCE((SELECT count FROM future_citas), 0) AS future_operational_appointments,
        COALESCE((SELECT count FROM weekly_schedules), 0) AS active_weekly_schedules,
        COALESCE((SELECT count FROM agenda_blocks_employee), 0) + COALESCE((SELECT count FROM agenda_blocks), 0) AS future_agenda_blocks,
        COALESCE((SELECT count FROM public_profiles), 0) AS public_barber_profiles,
        COALESCE((SELECT count FROM service_rates), 0) AS employee_service_rates,
        COALESCE((SELECT count FROM promotion_cupos), 0) + COALESCE((SELECT count FROM promotion_restrictions), 0) AS promotion_references
    `,
    [ids]
  );
  const row = result.rows?.[0] || {};
  return {
    future_operational_appointments: toNumber(row.future_operational_appointments, 0),
    active_weekly_schedules: toNumber(row.active_weekly_schedules, 0),
    future_agenda_blocks: toNumber(row.future_agenda_blocks, 0),
    public_barber_profiles: toNumber(row.public_barber_profiles, 0),
    employee_service_rates: toNumber(row.employee_service_rates, 0),
    promotion_references: toNumber(row.promotion_references, 0),
  };
}

async function findCurrentInternalAccountDeletionRequest(client, { usuarioId, empleadoId } = {}) {
  const result = await client.query(
    `
      SELECT id_solicitud, referencia_publica, estado_codigo, solicitado_at, requiere_aprobacion
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE tipo_sujeto = 'personal'
        AND modo_proceso = 'requiere_aprobacion'
        AND requiere_aprobacion IS TRUE
        AND estado_codigo = ANY($3::text[])
        AND (
          id_usuario = $1::uuid
          OR id_empleado = $2::uuid
        )
      ORDER BY solicitado_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [usuarioId, empleadoId, INTERNAL_ACTIVE_REQUEST_STATES]
  );
  return result.rows?.[0] || null;
}

export async function getCurrentInternalAccountDeletionRequest(client, { usuarioId, empleadoId } = {}) {
  const row = await findCurrentInternalAccountDeletionRequest(client, { usuarioId, empleadoId });
  return { request: serializeInternalRequestRow(row) };
}

export async function evaluateInternalAccountDeletionRequest(client, {
  usuarioId,
  personaId,
  employeeIdFromClaims,
  rolesFromClaims,
} = {}) {
  const roles = uniqueStringList(rolesFromClaims);
  const identity = await loadInternalAccountIdentity(client, {
    usuarioId,
    personaId,
    employeeIdFromClaims,
    rolesFromClaims: roles,
  });
  const blockingReasons = [];
  const protectedByRole = roles.some((role) => INTERNAL_PROTECTED_ROLES.includes(role)) || identity.roles?.some((role) => INTERNAL_PROTECTED_ROLES.includes(role));
  const protectedByTable = await isProtectedInternalAccount(client, usuarioId);

  if (protectedByRole || protectedByTable) {
    blockingReasons.push({
      code: "INTERNAL_ACCOUNT_DELETION_PROTECTED",
      message: INTERNAL_PROTECTED_MESSAGE,
    });
  }
  if (identity.hardBlock) {
    blockingReasons.push(identity.hardBlock);
  }

  const activeEmployees = identity.activeEmployees || [];
  const employeeIds = activeEmployees.map((employee) => employee.id_empleado);
  const dependencyCounts = await countInternalDependencies(client, employeeIds);
  const branchesAssigned = new Set(activeEmployees.map((employee) => String(employee.id_sucursal || "").trim()).filter(Boolean)).size;
  const activeRoles = identity.roles?.length ? identity.roles : roles.filter(isInternalRole);
  const current = identity.selectedEmployee
    ? await findCurrentInternalAccountDeletionRequest(client, { usuarioId, empleadoId: identity.selectedEmployee.id_empleado })
    : null;
  if (current && !INTERNAL_TERMINAL_REQUEST_STATES.includes(String(current.estado_codigo || ""))) {
    blockingReasons.push({
      code: "INTERNAL_ACCOUNT_DELETION_REQUEST_ALREADY_ACTIVE",
      message: "Ya existe una solicitud de eliminacion activa para esta cuenta.",
    });
  }

  const evaluatedAt = new Date().toISOString();
  return {
    can_request: blockingReasons.length === 0,
    account_mode: "requires_approval",
    requires_approval: true,
    blocking_reasons: sanitizeBlockingReasons(blockingReasons),
    dependencies: {
      active_roles: activeRoles,
      active_employee_records: activeEmployees.length,
      branches_assigned: branchesAssigned,
      is_barber: activeEmployees.some((employee) => employee.es_barbero === true),
      ...dependencyCounts,
    },
    consequences: {
      account_remains_active_until_decision: true,
      requires_administrative_review: true,
      future_appointments_must_be_reassigned: dependencyCounts.future_operational_appointments > 0,
      access_will_be_revoked_if_approved: true,
      roles_will_be_disabled_if_approved: true,
      employment_records_will_be_closed_if_approved: true,
      history_retained_anonymized: true,
    },
    current_request: serializeInternalRequestRow(current),
    evaluated_at: evaluatedAt,
    employee_context: identity.selectedEmployee ? {
      id_empleado: identity.selectedEmployee.id_empleado,
    } : null,
  };
}

function buildInternalImpactSummary(preview) {
  return {
    personal_request: {
      evaluated_at: preview?.evaluated_at || new Date().toISOString(),
      active_roles: normalizeStringList(preview?.dependencies?.active_roles),
      active_employee_records: toNumber(preview?.dependencies?.active_employee_records, 0),
      branches_assigned: toNumber(preview?.dependencies?.branches_assigned, 0),
      is_barber: Boolean(preview?.dependencies?.is_barber),
      future_operational_appointments: toNumber(preview?.dependencies?.future_operational_appointments, 0),
      active_weekly_schedules: toNumber(preview?.dependencies?.active_weekly_schedules, 0),
      future_agenda_blocks: toNumber(preview?.dependencies?.future_agenda_blocks, 0),
      public_barber_profiles: toNumber(preview?.dependencies?.public_barber_profiles, 0),
      employee_service_rates: toNumber(preview?.dependencies?.employee_service_rates, 0),
      promotion_references: toNumber(preview?.dependencies?.promotion_references, 0),
      account_remains_active_until_decision: true,
      requires_administrative_review: true,
    },
  };
}

export async function createInternalAccountDeletionRequest(client, {
  usuarioId,
  personaId,
  employeeIdFromClaims,
  rolesFromClaims,
  idempotencyKey,
  requestId,
  authenticatedAt,
} = {}) {
  const safeIdempotencyKey = assertInternalAccountDeletionIdempotencyKey(idempotencyKey);
  await acquireAccountDeletionUserLock(client, usuarioId);

  const preview = await evaluateInternalAccountDeletionRequest(client, {
    usuarioId,
    personaId,
    employeeIdFromClaims,
    rolesFromClaims,
  });

  const employeeId = preview?.employee_context?.id_empleado;
  const activeRequest = employeeId
    ? await findCurrentInternalAccountDeletionRequest(client, { usuarioId, empleadoId: employeeId })
    : null;
  if (activeRequest) {
    return {
      request: serializeInternalRequestRow(activeRequest),
      created: false,
      idempotent_replay: true,
      message: "Ya existe una solicitud de eliminacion activa para esta cuenta.",
      preview,
    };
  }

  if (!preview.can_request || !employeeId) {
    throw new AppError(409, "La cuenta no puede presentar esta solicitud en este momento.", {
      code: preview.blocking_reasons?.[0]?.code || "INTERNAL_ACCOUNT_DELETION_REQUEST_BLOCKED",
      details: { blocking_reasons: preview.blocking_reasons },
    });
  }

  try {
    const result = await client.query(
      `
        INSERT INTO app_private.solicitudes_eliminacion_cuenta (
          tipo_sujeto,
          id_persona,
          id_usuario,
          id_cliente,
          id_empleado,
          modo_proceso,
          requiere_aprobacion,
          origen_codigo,
          estado_codigo,
          auth_user_id_pendiente,
          decision_codigo,
          decision_por,
          decision_at,
          comentario_decision,
          reautenticado_at,
          idempotency_key,
          request_id,
          bloqueos_detectados,
          resumen_impacto,
          procesando_at,
          completado_at,
          cancelado_at,
          fallido_at,
          execution_token_hash,
          execution_token_issued_at,
          execution_token_expires_at,
          execution_token_last_used_at
        )
        VALUES (
          'personal',
          $1::uuid,
          $2::uuid,
          NULL,
          $3::uuid,
          'requiere_aprobacion',
          TRUE,
          'personal',
          'pendiente_aprobacion',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          $4::timestamptz,
          $5::text,
          $6::text,
          '[]'::jsonb,
          $7::jsonb,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        )
        RETURNING id_solicitud, referencia_publica, estado_codigo, solicitado_at, requiere_aprobacion
      `,
      [
        personaId,
        usuarioId,
        employeeId,
        authenticatedAt,
        safeIdempotencyKey,
        requestId,
        JSON.stringify(buildInternalImpactSummary(preview)),
      ]
    );

    return {
      request: serializeInternalRequestRow(result.rows?.[0]),
      created: true,
      idempotent_replay: false,
      message: "Tu solicitud fue enviada para revision administrativa. Tu cuenta continuara activa mientras se toma una decision.",
      preview,
    };
  } catch (error) {
    throw mapInternalSerializationConflict(normalizePostgresConflict(error));
  }
}

export async function cancelInternalAccountDeletionRequest(client, {
  requestId,
  usuarioId,
  personaId,
  employeeIdFromClaims,
  rolesFromClaims,
  traceRequestId,
} = {}) {
  await acquireAccountDeletionUserLock(client, usuarioId);
  const preview = await evaluateInternalAccountDeletionRequest(client, {
    usuarioId,
    personaId,
    employeeIdFromClaims,
    rolesFromClaims,
  });
  const employeeId = preview?.employee_context?.id_empleado;

  const result = await client.query(
    `
      SELECT id_solicitud, referencia_publica, estado_codigo, solicitado_at, requiere_aprobacion, decision_codigo, decision_at
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND tipo_sujeto = 'personal'
        AND modo_proceso = 'requiere_aprobacion'
        AND requiere_aprobacion IS TRUE
        AND id_usuario = $2::uuid
        AND id_empleado = $3::uuid
      LIMIT 1
      FOR UPDATE
    `,
    [requestId, usuarioId, employeeId]
  );
  const row = result.rows?.[0] || null;
  if (!row) {
    throw new AppError(404, "No se encontro la solicitud indicada.", {
      code: "INTERNAL_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (String(row.estado_codigo || "") === "cancelada") {
    return {
      request: serializeInternalRequestRow(row),
      cancelled: true,
      idempotent_replay: true,
    };
  }

  if (!INTERNAL_CANCELABLE_STATES.includes(String(row.estado_codigo || "")) || row.decision_codigo || row.decision_at) {
    throw new AppError(409, "La solicitud ya no puede cancelarse en su estado actual.", {
      code: "INTERNAL_ACCOUNT_DELETION_CANNOT_CANCEL",
    });
  }

  try {
    const updated = await client.query(
      `
        UPDATE app_private.solicitudes_eliminacion_cuenta
        SET estado_codigo = 'cancelada',
            cancelado_at = NOW(),
            comentario_decision = NULL,
            error_codigo = NULL,
            error_detalle_tecnico = NULL,
            request_id = $2::text,
            updated_at = NOW()
        WHERE id_solicitud = $1::uuid
        RETURNING id_solicitud, referencia_publica, estado_codigo, solicitado_at, requiere_aprobacion
      `,
      [requestId, traceRequestId]
    );
    return {
      request: serializeInternalRequestRow(updated.rows?.[0]),
      cancelled: true,
      idempotent_replay: false,
    };
  } catch (error) {
    throw mapInternalSerializationConflict(error);
  }
}

async function findAccountDeletionRequestForExecution(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        reautenticado_at,
        resumen_impacto,
        procesando_at
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND id_cliente = $2::uuid
        AND id_persona = $3::uuid
        AND id_usuario = $4::uuid
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
        AND requiere_aprobacion IS FALSE
      LIMIT 1
      FOR UPDATE
    `,
    [deletionRequestId, clienteId, personaId, usuarioId]
  );
  return rows?.[0] ?? null;
}

async function blockAccountDeletionRequestForExecution(client, {
  deletionRequestId,
  bloqueosDetectados,
  resumenImpacto,
  traceRequestId,
}) {
  await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'bloqueada',
          reautenticado_at = NULL,
          procesando_at = NULL,
          auth_user_id_pendiente = NULL,
          bloqueos_detectados = $2::jsonb,
          resumen_impacto = $3::jsonb,
          request_id = $4::text,
          execution_token_hash = NULL,
          execution_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
    `,
    [
      deletionRequestId,
      JSON.stringify(bloqueosDetectados),
      JSON.stringify(resumenImpacto),
      traceRequestId,
    ]
  );
}

async function markAccountDeletionRequestProcessing(client, {
  deletionRequestId,
  usuarioId,
  traceRequestId,
}) {
  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'procesando',
          procesando_at = NOW(),
          auth_user_id_pendiente = $2::uuid,
          bloqueos_detectados = '[]'::jsonb,
          request_id = $3::text,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo, procesando_at, resumen_impacto
    `,
    [deletionRequestId, usuarioId, traceRequestId]
  );
  return rows?.[0] ?? null;
}

async function getCurrentPointsBalance(client, clienteId) {
  const { rows } = await client.query(
    `
      SELECT COALESCE((
        SELECT vpb.balance_puntos
        FROM public.vw_points_balance vpb
        WHERE vpb.id_cliente = $1::uuid
      ), 0)::integer AS balance_puntos
    `,
    [clienteId]
  );
  return toNumber(rows?.[0]?.balance_puntos, 0);
}

async function getLatestActivePointsCycleId(client, clienteId) {
  const { rows } = await client.query(
    `
      SELECT id_cycle
      FROM public.points_cycles
      WHERE id_cliente = $1::uuid
        AND estado_ciclo_codigo = 'activo'
      ORDER BY primer_acumulado_at DESC NULLS LAST, created_at DESC NULLS LAST, id_cycle DESC
      LIMIT 1
    `,
    [clienteId]
  );
  return rows?.[0]?.id_cycle ?? null;
}

async function reconcileAccountDeletionPoints(client, {
  clienteId,
  usuarioId,
  referenciaPublica,
}) {
  const pointsBalanceBefore = await getCurrentPointsBalance(client, clienteId);
  let pointsForfeited = 0;

  if (pointsBalanceBefore > 0) {
    const activeCycleId = await getLatestActivePointsCycleId(client, clienteId);
    pointsForfeited = pointsBalanceBefore;

    await client.query(
      `
        INSERT INTO public.points_transactions (
          id_cliente,
          id_cita,
          tipo_puntos_codigo,
          puntos,
          motivo,
          creado_por_usuario_id,
          id_cycle,
          id_sucursal_origen,
          id_servicio_canje,
          origen_punto_codigo
        )
        VALUES (
          $1::uuid,
          NULL,
          'ajuste_resta',
          $2::integer,
          $3::text,
          $4::uuid,
          $5::uuid,
          NULL,
          NULL,
          'sistema'
        )
      `,
      [
        clienteId,
        pointsBalanceBefore,
        `Eliminacion de cuenta ${referenciaPublica}`,
        usuarioId,
        activeCycleId,
      ]
    );
  }

  const pointsBalanceAfter = await getCurrentPointsBalance(client, clienteId);
  if (pointsBalanceAfter !== 0) {
    throw new AppError(500, "No fue posible cerrar correctamente el saldo de MasterPuntos.", {
      code: "CLIENT_ACCOUNT_DELETION_POINTS_RECONCILIATION_FAILED",
    });
  }

  return {
    pointsBalanceBefore,
    pointsForfeited,
    pointsBalanceAfter,
  };
}

async function updateFinalAccountDeletionImpactSummary(client, {
  deletionRequestId,
  resumenImpacto,
  internalExecution,
}) {
  await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET resumen_impacto = $2::jsonb,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
    `,
    [
      deletionRequestId,
      JSON.stringify(mergeInternalExecutionSummary(resumenImpacto, internalExecution)),
    ]
  );
}

export async function executeClientAccountDeletionInternal(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  authenticatedAt,
  traceRequestId,
} = {}) {
  const request = await findAccountDeletionRequestForExecution(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!request) {
    throw new AppError(404, "No se encontrÃ³ la solicitud de eliminaciÃ³n indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (request.estado_codigo === "procesando") {
    return {
      processed: true,
      ready_for_anonymization: true,
      idempotent_replay: true,
    };
  }

  if (request.estado_codigo !== "evaluada" || !request.reautenticado_at) {
    throw new AppError(409, "La solicitud no se encuentra en un estado vÃ¡lido para procesamiento.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_STATE_INVALID",
      details: mapActiveRequestDetails(request),
    });
  }

  assertRecentProcessingReauthentication(authenticatedAt, request.reautenticado_at);

  const preview = await evaluateClientAccountDeletion(client, {
    clienteId,
    personaId,
    usuarioId,
  });
  const bloqueosDetectados = sanitizeBlockingReasons(preview.blocking_reasons);
  const resumenImpacto = buildImpactSummary(preview);

  if (preview.requires_approval || bloqueosDetectados.length > 0) {
    await blockAccountDeletionRequestForExecution(client, {
      deletionRequestId,
      bloqueosDetectados,
      resumenImpacto,
      traceRequestId,
    });

    return {
      processed: false,
      ready_for_anonymization: false,
      idempotent_replay: false,
      request_state: "bloqueada",
      blocking_reasons: bloqueosDetectados,
    };
  }

  const processingRequest = await markAccountDeletionRequestProcessing(client, {
    deletionRequestId,
    usuarioId,
    traceRequestId,
  });

  const subscriptionsResult = await client.query(
    `
      UPDATE public.subscriptions
      SET estado_suscripcion_codigo = 'cancelada',
          renovacion_auto = FALSE,
          cancelada_al_fin = FALSE,
          motivo_fin_codigo = 'eliminacion_cuenta',
          updated_at = NOW()
      WHERE id_cliente = $1::uuid
        AND estado_suscripcion_codigo = 'activa'
    `,
    [clienteId]
  );

  const ordersResult = await client.query(
    `
      UPDATE public.membership_purchase_orders
      SET estado_orden_codigo = 'cancelada',
          cancelled_at = COALESCE(cancelled_at, NOW()),
          updated_at = NOW()
      WHERE id_cliente = $1::uuid
        AND estado_orden_codigo = 'pendiente_pago'
    `,
    [clienteId]
  );

  const pointsResult = await reconcileAccountDeletionPoints(client, {
    clienteId,
    usuarioId,
    referenciaPublica: request.referencia_publica,
  });

  const cyclesResult = await client.query(
    `
      UPDATE public.points_cycles
      SET estado_ciclo_codigo = 'cerrado',
          updated_at = NOW()
      WHERE id_cliente = $1::uuid
        AND estado_ciclo_codigo = 'activo'
    `,
    [clienteId]
  );

  const sessionsResult = await client.query(
    `
      UPDATE public.seguridad_sesiones
      SET estado = 'revocada',
          revocada_at = COALESCE(revocada_at, NOW()),
          cierre_at = COALESCE(cierre_at, NOW()),
          cerrada_por = $2::uuid,
          motivo_cierre = 'eliminacion_cuenta',
          request_id = $3::text
      WHERE id_usuario = $1::uuid
        AND estado = 'activa'
    `,
    [usuarioId, usuarioId, traceRequestId]
  );

  const rolesResult = await client.query(
    `
      UPDATE public.roles_usuarios
      SET activo = FALSE,
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND activo IS TRUE
    `,
    [usuarioId]
  );

  const userResult = await client.query(
    `
      UPDATE public.usuarios
      SET estado = FALSE,
          estado_acceso = 'inactivo',
          password_hash = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND id_persona = $2::uuid
    `,
    [usuarioId, personaId]
  );

  if (toNumber(userResult.rowCount, 0) !== 1) {
    throw new AppError(409, "La cuenta cambiÃ³ durante el procesamiento.", {
      code: "CLIENT_ACCOUNT_DELETION_USER_STATE_CHANGED",
    });
  }

  const clientResult = await client.query(
    `
      UPDATE public.clientes
      SET estado = FALSE,
          consentimiento_marketing = FALSE,
          consentimiento_marketing_at = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_cliente = $1::uuid
        AND id_persona = $2::uuid
        AND id_usuario = $3::uuid
        AND COALESCE(anonimizado, FALSE) IS FALSE
    `,
    [clienteId, personaId, usuarioId]
  );

  if (toNumber(clientResult.rowCount, 0) !== 1) {
    throw new AppError(409, "La cuenta cambiÃ³ durante el procesamiento.", {
      code: "CLIENT_ACCOUNT_DELETION_USER_STATE_CHANGED",
    });
  }

  const internalExecution = {
    processed_at: new Date().toISOString(),
    subscriptions_cancelled: toNumber(subscriptionsResult.rowCount, 0),
    membership_orders_cancelled: toNumber(ordersResult.rowCount, 0),
    points_balance_before: pointsResult.pointsBalanceBefore,
    points_forfeited: pointsResult.pointsForfeited,
    points_balance_after: pointsResult.pointsBalanceAfter,
    points_cycles_closed: toNumber(cyclesResult.rowCount, 0),
    sessions_revoked: toNumber(sessionsResult.rowCount, 0),
    roles_disabled: toNumber(rolesResult.rowCount, 0),
    user_disabled: true,
    client_disabled: true,
  };

  await updateFinalAccountDeletionImpactSummary(client, {
    deletionRequestId,
    resumenImpacto: request.resumen_impacto,
    internalExecution,
  });

  return {
    processed: true,
    ready_for_anonymization: true,
    idempotent_replay: false,
    request: {
      id_solicitud: processingRequest?.id_solicitud ?? deletionRequestId,
      referencia_publica: processingRequest?.referencia_publica ?? request.referencia_publica,
      estado_codigo: "procesando",
      procesando_at: toIsoString(processingRequest?.procesando_at),
    },
    internal_execution: {
      subscriptions_cancelled: internalExecution.subscriptions_cancelled,
      membership_orders_cancelled: internalExecution.membership_orders_cancelled,
      points_balance_before: internalExecution.points_balance_before,
      points_forfeited: internalExecution.points_forfeited,
      points_balance_after: internalExecution.points_balance_after,
      points_cycles_closed: internalExecution.points_cycles_closed,
      sessions_revoked: internalExecution.sessions_revoked,
      roles_disabled: internalExecution.roles_disabled,
      user_disabled: true,
      client_disabled: true,
    },
  };
}

export async function runClientAccountDeletionInternal(app, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  authenticatedAt,
  traceRequestId,
} = {}) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    await acquireAccountDeletionUserLock(client, usuarioId);

    const result = await executeClientAccountDeletionInternal(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
      authenticatedAt,
      traceRequestId,
    });

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva la causa funcional.
      }
    }
    throw mapSerializationConflict(error);
  } finally {
    client.release();
  }
}

async function findAccountDeletionRequestForAnonymization(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        resumen_impacto,
        procesando_at,
        auth_user_id_pendiente
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND id_cliente = $2::uuid
        AND id_persona = $3::uuid
        AND id_usuario = $4::uuid
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
        AND requiere_aprobacion IS FALSE
        AND auth_user_id_pendiente = $4::uuid
      LIMIT 1
      FOR UPDATE
    `,
    [deletionRequestId, clienteId, personaId, usuarioId]
  );
  return rows?.[0] ?? null;
}

async function assertAccountDeletionAnonymizationPreconditions(client, {
  clienteId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM public.usuarios u
          WHERE u.id_usuario = $1::uuid
            AND u.estado IS FALSE
            AND u.estado_acceso = 'inactivo'
            AND u.deleted_at IS NOT NULL
            AND u.password_hash IS NULL
        ) AS user_ready,
        EXISTS (
          SELECT 1
          FROM public.clientes c
          WHERE c.id_cliente = $2::uuid
            AND c.estado IS FALSE
            AND c.deleted_at IS NOT NULL
            AND c.anonimizado IS FALSE
        ) AS client_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.roles_usuarios ru
          WHERE ru.id_usuario = $1::uuid
            AND ru.activo IS TRUE
        ) AS roles_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.subscriptions s
          WHERE s.id_cliente = $2::uuid
            AND s.estado_suscripcion_codigo = 'activa'
        ) AS memberships_ready,
        COALESCE((
          SELECT vpb.balance_puntos
          FROM public.vw_points_balance vpb
          WHERE vpb.id_cliente = $2::uuid
        ), 0)::integer <= 0 AS points_ready
    `,
    [usuarioId, clienteId]
  );
  const row = rows?.[0] ?? {};
  if (!row.user_ready || !row.client_ready || !row.roles_ready || !row.memberships_ready || !row.points_ready) {
    throw new AppError(409, "La cuenta no estÃ¡ preparada para su anonimizaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED",
    });
  }
}

async function prepareAccountDeletionAnonymizationScope(client, {
  clienteId,
  personaId,
  usuarioId,
}) {
  await client.query(`
    CREATE TEMP TABLE mf_ad_original_emails (
      email text PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_original_emails (email)
      SELECT DISTINCT lower(c.direccion_correo)
      FROM public.correos c
      WHERE c.id_persona = $1::uuid
        AND c.direccion_correo IS NOT NULL
        AND btrim(c.direccion_correo) <> ''
    `,
    [personaId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_storage_assets (
      id_asset uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_storage_assets (id_asset)
      SELECT DISTINCT sa.id_asset
      FROM public.storage_assets sa
      LEFT JOIN public.personas p ON p.id_persona = $1::uuid
      WHERE sa.deleted_at IS NULL
        AND sa.status <> 'eliminado'
        AND (
          sa.owner_cliente_id = $2::uuid
          OR sa.owner_user_id = $3::uuid
          OR sa.entity_id IN ($1::uuid, $2::uuid, $3::uuid)
          OR sa.id_asset = p.foto_perfil_asset_id
        )
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_citas (
      id_cita uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_citas (id_cita)
      SELECT DISTINCT c.id_cita
      FROM public.citas c
      LEFT JOIN public.citas_integrantes ci
        ON ci.id_cita_integrante = c.id_cita_integrante
        OR ci.id_grupo_cita = c.id_grupo_cita
      LEFT JOIN public.citas_grupos cg
        ON cg.id_grupo_cita = c.id_grupo_cita
      WHERE c.id_cliente = $2::uuid
         OR c.id_persona_cliente = $1::uuid
         OR c.creada_por_usuario_id = $3::uuid
         OR ci.id_cliente = $2::uuid
         OR ci.id_persona = $1::uuid
         OR ci.id_usuario = $3::uuid
         OR lower(ci.contacto_email_snapshot) IN (SELECT email FROM mf_ad_original_emails)
         OR cg.id_cliente_titular = $2::uuid
         OR cg.id_persona_titular = $1::uuid
         OR cg.id_usuario_titular = $3::uuid
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_grupos (
      id_grupo_cita uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_grupos (id_grupo_cita)
      SELECT DISTINCT id_grupo_cita
      FROM (
        SELECT c.id_grupo_cita
        FROM public.citas c
        JOIN mf_ad_citas ac ON ac.id_cita = c.id_cita
        WHERE c.id_grupo_cita IS NOT NULL
        UNION
        SELECT cg.id_grupo_cita
        FROM public.citas_grupos cg
        WHERE cg.id_cliente_titular = $2::uuid
           OR cg.id_persona_titular = $1::uuid
           OR cg.id_usuario_titular = $3::uuid
      ) src
      WHERE id_grupo_cita IS NOT NULL
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_integrantes (
      id_cita_integrante uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_integrantes (id_cita_integrante)
      SELECT DISTINCT ci.id_cita_integrante
      FROM public.citas_integrantes ci
      WHERE ci.id_cliente = $2::uuid
         OR ci.id_persona = $1::uuid
         OR ci.id_usuario = $3::uuid
         OR ci.id_grupo_cita IN (SELECT id_grupo_cita FROM mf_ad_grupos)
            AND ci.rol_integrante_codigo = 'titular'
         OR lower(ci.contacto_email_snapshot) IN (SELECT email FROM mf_ad_original_emails)
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_comprobantes (
      id_comprobante_agendamiento uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_comprobantes (id_comprobante_agendamiento)
      SELECT DISTINCT ca.id_comprobante_agendamiento
      FROM public.comprobantes_agendamiento ca
      WHERE ca.id_grupo_cita IN (SELECT id_grupo_cita FROM mf_ad_grupos)
         OR ca.id_cliente_titular = $2::uuid
         OR ca.id_persona_titular = $1::uuid
         OR ca.id_usuario_titular = $3::uuid
         OR lower(ca.titular_email_snapshot) IN (SELECT email FROM mf_ad_original_emails)
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_facturas_emitidas (
      id_factura uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_facturas_emitidas (id_factura)
      SELECT DISTINCT f.id_factura
      FROM public.facturas f
      WHERE f.estado_factura_codigo IN ('emitida', 'anulada')
        AND (
          f.id_grupo_cita IN (SELECT id_grupo_cita FROM mf_ad_grupos)
          OR f.id_comprobante_agendamiento IN (SELECT id_comprobante_agendamiento FROM mf_ad_comprobantes)
          OR f.id_cliente_titular = $2::uuid
          OR f.id_persona_titular = $1::uuid
          OR f.id_usuario_titular = $3::uuid
          OR lower(f.receptor_email_snapshot) IN (SELECT email FROM mf_ad_original_emails)
        )
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_facturas_no_emitidas (
      id_factura uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_facturas_no_emitidas (id_factura)
      SELECT DISTINCT f.id_factura
      FROM public.facturas f
      WHERE f.estado_factura_codigo IN ('borrador', 'pendiente_emision', 'error_emision')
        AND (
          f.id_grupo_cita IN (SELECT id_grupo_cita FROM mf_ad_grupos)
          OR f.id_comprobante_agendamiento IN (SELECT id_comprobante_agendamiento FROM mf_ad_comprobantes)
          OR f.id_cliente_titular = $2::uuid
          OR f.id_persona_titular = $1::uuid
          OR f.id_usuario_titular = $3::uuid
          OR lower(f.receptor_email_snapshot) IN (SELECT email FROM mf_ad_original_emails)
        )
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_notificaciones (
      id_notificacion uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_notificaciones (id_notificacion)
      SELECT DISTINCT ne.id_notificacion
      FROM public.notificaciones_email ne
      WHERE ne.id_usuario_destino = $1::uuid
         OR ne.id_cita IN (SELECT id_cita FROM mf_ad_citas)
         OR lower(ne.correo_destino) IN (SELECT email FROM mf_ad_original_emails)
    `,
    [usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_comunicaciones (
      id_envio uuid PRIMARY KEY
    ) ON COMMIT DROP
  `);

  await client.query(
    `
      INSERT INTO mf_ad_comunicaciones (id_envio)
      SELECT DISTINCT ce.id_envio
      FROM public.comunicaciones_envios ce
      WHERE ce.id_cliente = $2::uuid
         OR ce.id_persona = $1::uuid
         OR ce.id_usuario_destino = $3::uuid
         OR lower(ce.correo_destino) IN (SELECT email FROM mf_ad_original_emails)
    `,
    [personaId, clienteId, usuarioId]
  );

  await client.query(`
    CREATE TEMP TABLE mf_ad_bitacora_targets (
      tabla text NOT NULL,
      registro_id uuid NOT NULL,
      PRIMARY KEY (tabla, registro_id)
    ) ON COMMIT DROP
  `);
}

function getRowCount(result) {
  return toNumber(result?.rowCount, 0);
}

async function verifyAccountDeletionAnonymization(client, {
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM public.personas p
          WHERE p.id_persona = $1::uuid
            AND p.nombres = 'Cliente'
            AND p.apellidos = 'eliminado'
            AND p.fecha_nacimiento IS NULL
            AND p.genero_codigo IS NULL
            AND p.dni IS NULL
            AND p.rtn IS NULL
            AND p.telefono_principal IS NULL
            AND p.direccion_texto IS NULL
            AND p.observaciones IS NULL
            AND p.foto_perfil_asset_id IS NULL
            AND p.foto_perfil_path IS NULL
        ) AS person_redacted,
        EXISTS (
          SELECT 1
          FROM public.clientes c
          WHERE c.id_cliente = $2::uuid
            AND c.anonimizado IS TRUE
        ) AS client_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.correos c
          JOIN mf_ad_original_emails oe ON oe.email = lower(c.direccion_correo)
        ) AS original_emails_absent,
        NOT EXISTS (
          SELECT 1
          FROM public.citas c
          JOIN mf_ad_citas ac ON ac.id_cita = c.id_cita
          WHERE c.contacto_email IS NOT NULL
             OR c.contacto_telefono IS NOT NULL
             OR c.alias_integrante IS NOT NULL
             OR c.notas IS NOT NULL
             OR COALESCE(c.contacto_nombre, 'Cliente eliminado') <> 'Cliente eliminado'
        ) AS appointments_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.citas_integrantes ci
          JOIN mf_ad_integrantes ai ON ai.id_cita_integrante = ci.id_cita_integrante
          WHERE ci.contacto_email_snapshot IS NOT NULL
             OR ci.contacto_telefono_snapshot IS NOT NULL
             OR ci.alias_integrante IS NOT NULL
             OR ci.contacto_nombre_snapshot <> 'Cliente eliminado'
        ) AS members_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.comprobantes_agendamiento ca
          JOIN mf_ad_comprobantes mc ON mc.id_comprobante_agendamiento = ca.id_comprobante_agendamiento
          WHERE ca.titular_email_snapshot IS NOT NULL
             OR ca.titular_telefono_snapshot IS NOT NULL
             OR ca.email_ultimo_error_detalle IS NOT NULL
             OR ca.titular_nombre_snapshot <> 'Cliente eliminado'
        ) AS receipts_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.membership_purchase_orders mpo
          WHERE mpo.id_cliente = $2::uuid
            AND (
              mpo.notas IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM mf_ad_original_emails oe
                WHERE lower(mpo.email_factura) = oe.email
                   OR lower(mpo.cliente_snapshot::text) LIKE '%' || oe.email || '%'
                   OR lower(mpo.factura_snapshot::text) LIKE '%' || oe.email || '%'
              )
            )
        ) AS orders_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.notificaciones_email ne
          JOIN mf_ad_notificaciones mn ON mn.id_notificacion = ne.id_notificacion
          JOIN mf_ad_original_emails oe ON oe.email = lower(ne.correo_destino)
        ) AS notifications_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.comunicaciones_envios ce
          JOIN mf_ad_comunicaciones mc ON mc.id_envio = ce.id_envio
          JOIN mf_ad_original_emails oe ON oe.email = lower(ce.correo_destino)
        ) AS communications_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.seguridad_sesiones ss
          WHERE ss.id_usuario = $3::uuid
            AND (ss.ip_inicio IS NOT NULL OR ss.ip_ultimo_uso IS NOT NULL OR ss.user_agent IS NOT NULL OR ss.metadata <> '{}'::jsonb)
        ) AS sessions_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.seguridad_login_logs sll
          WHERE sll.id_usuario = $3::uuid
            AND (
              sll.identificador_hash IS NOT NULL
              OR sll.email_masked IS NOT NULL
              OR sll.ip IS NOT NULL
              OR sll.user_agent IS NOT NULL
            )
        ) AS login_logs_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.seguridad_audit_logs sal
          WHERE sal.id_usuario = $3::uuid
            AND sal.ip IS NOT NULL
        ) AS audit_logs_redacted,
        NOT EXISTS (
          SELECT 1
          FROM public.bitacoras b
          JOIN mf_ad_bitacora_targets t
            ON t.registro_id = b.registro_id
           AND (b.tabla = t.tabla OR b.tabla = 'public.' || t.tabla)
          JOIN mf_ad_original_emails oe ON TRUE
          WHERE lower(COALESCE(b.datos_antes::text, '')) LIKE '%' || oe.email || '%'
             OR lower(COALESCE(b.datos_despues::text, '')) LIKE '%' || oe.email || '%'
        ) AS bitacoras_redacted
    `,
    [personaId, clienteId, usuarioId]
  );
  const row = rows?.[0] ?? {};
  const ok = Object.values(row).every((value) => value === true);
  if (!ok) {
    throw new AppError(500, "No fue posible verificar completamente la anonimizaciÃ³n de la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_ANONYMIZATION_VERIFICATION_FAILED",
    });
  }
}

async function updateAccountDeletionAnonymizationRequest(client, {
  deletionRequestId,
  usuarioId,
  traceRequestId,
  resumenImpacto,
  internalAnonymization,
  hasStorageAssets,
}) {
  const estadoCodigo = hasStorageAssets ? "storage_pendiente" : "auth_pendiente";
  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = $2::text,
          resumen_impacto = $3::jsonb,
          request_id = $4::text,
          auth_user_id_pendiente = $5::uuid,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo
    `,
    [
      deletionRequestId,
      estadoCodigo,
      JSON.stringify(mergeInternalAnonymizationSummary(resumenImpacto, internalAnonymization)),
      traceRequestId,
      usuarioId,
    ]
  );
  return rows?.[0] ?? null;
}

export async function anonymizeClientAccountDeletionInternal(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
} = {}) {
  const request = await findAccountDeletionRequestForAnonymization(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!request) {
    throw new AppError(404, "No se encontrÃ³ la solicitud de eliminaciÃ³n indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (["storage_pendiente", "auth_pendiente"].includes(request.estado_codigo)) {
    const { rows } = await client.query(
      `
        SELECT COALESCE(c.anonimizado, FALSE) AS anonimizado
        FROM public.clientes c
        WHERE c.id_cliente = $1::uuid
          AND c.id_persona = $2::uuid
          AND c.id_usuario = $3::uuid
      `,
      [clienteId, personaId, usuarioId]
    );
    if (rows?.[0]?.anonimizado === true) {
      return {
        anonymized: true,
        idempotent_replay: true,
      };
    }
  }

  if (request.estado_codigo !== "procesando" || !request.procesando_at) {
    throw new AppError(409, "La solicitud no se encuentra en un estado vÃ¡lido para anonimizaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_ANONYMIZATION_STATE_INVALID",
      details: mapActiveRequestDetails(request),
    });
  }

  await assertAccountDeletionAnonymizationPreconditions(client, {
    clienteId,
    usuarioId,
  });

  await prepareAccountDeletionAnonymizationScope(client, {
    clienteId,
    personaId,
    usuarioId,
  });

  const storageResult = await client.query(
    `
      SELECT
        COALESCE(array_agg(id_asset ORDER BY id_asset), ARRAY[]::uuid[]) AS asset_ids,
        COUNT(*)::int AS asset_count
      FROM mf_ad_storage_assets
    `
  );
  const storageAssetIds = storageResult.rows?.[0]?.asset_ids ?? [];
  const storageAssetsPending = toNumber(storageResult.rows?.[0]?.asset_count, 0);

  await client.query(
    `
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      VALUES ('personas', $1::uuid), ('clientes', $2::uuid), ('usuarios', $3::uuid)
      ON CONFLICT DO NOTHING
    `,
    [personaId, clienteId, usuarioId]
  );

  const personResult = await client.query(
    `
      UPDATE public.personas
      SET nombres = 'Cliente',
          apellidos = 'eliminado',
          fecha_nacimiento = NULL,
          genero_codigo = NULL,
          dni = NULL,
          rtn = NULL,
          telefono_principal = NULL,
          direccion_texto = NULL,
          observaciones = NULL,
          foto_perfil_asset_id = NULL,
          foto_perfil_path = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_persona = $1::uuid
    `,
    [personaId]
  );
  if (getRowCount(personResult) !== 1) {
    throw new AppError(409, "La cuenta no estÃ¡ preparada para su anonimizaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED",
    });
  }

  const clientResult = await client.query(
    `
      UPDATE public.clientes
      SET estado = FALSE,
          consentimiento_marketing = FALSE,
          consentimiento_marketing_at = NULL,
          acepta_terminos = FALSE,
          acepta_terminos_at = NULL,
          preferencias = '{}'::jsonb,
          anonimizado = TRUE,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_cliente = $1::uuid
        AND id_persona = $2::uuid
        AND id_usuario = $3::uuid
    `,
    [clienteId, personaId, usuarioId]
  );
  if (getRowCount(clientResult) !== 1) {
    throw new AppError(409, "La cuenta no estÃ¡ preparada para su anonimizaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED",
    });
  }

  const userResult = await client.query(
    `
      UPDATE public.usuarios
      SET estado = FALSE,
          estado_acceso = 'inactivo',
          password_hash = NULL,
          credenciales_completadas_at = NULL,
          ultimo_login_at = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
        AND id_persona = $2::uuid
    `,
    [usuarioId, personaId]
  );
  if (getRowCount(userResult) !== 1) {
    throw new AppError(409, "La cuenta no estÃ¡ preparada para su anonimizaciÃ³n.", {
      code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED",
    });
  }

  const emailsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.correos c
        SET direccion_correo = 'deleted+correo-' || replace(c.id_correo::text, '-', '') || '@anon.masterfade.invalid',
            es_principal = FALSE,
            verificado = FALSE,
            deleted_at = COALESCE(c.deleted_at, NOW()),
            updated_at = NOW()
        WHERE c.id_persona = $1::uuid
        RETURNING c.id_correo
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'correos', id_correo FROM updated
      ON CONFLICT DO NOTHING
    `,
    [personaId]
  );

  const membersResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.citas_integrantes ci
        SET contacto_nombre_snapshot = 'Cliente eliminado',
            contacto_email_snapshot = NULL,
            contacto_telefono_snapshot = NULL,
            alias_integrante = NULL,
            updated_at = NOW()
        WHERE ci.id_cita_integrante IN (SELECT id_cita_integrante FROM mf_ad_integrantes)
        RETURNING ci.id_cita_integrante
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'citas_integrantes', id_cita_integrante FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const appointmentsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.citas c
        SET contacto_nombre = 'Cliente eliminado',
            contacto_email = NULL,
            contacto_telefono = NULL,
            alias_integrante = NULL,
            notas = NULL,
            updated_at = NOW()
        WHERE c.id_cita IN (SELECT id_cita FROM mf_ad_citas)
        RETURNING c.id_cita
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'citas', id_cita FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const groupsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.citas_grupos cg
        SET notas = NULL,
            release_token = NULL,
            release_token_hash = NULL,
            release_token_created_at = NULL,
            updated_at = NOW()
        WHERE cg.id_grupo_cita IN (SELECT id_grupo_cita FROM mf_ad_grupos)
        RETURNING cg.id_grupo_cita
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'citas_grupos', id_grupo_cita FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const receiptsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.comprobantes_agendamiento ca
        SET titular_nombre_snapshot = 'Cliente eliminado',
            titular_email_snapshot = NULL,
            titular_telefono_snapshot = NULL,
            email_ultimo_error_detalle = NULL,
            payload_resumen = app_private.fn_redact_account_pii_jsonb_v1(payload_resumen),
            updated_at = NOW()
        WHERE ca.id_comprobante_agendamiento IN (SELECT id_comprobante_agendamiento FROM mf_ad_comprobantes)
          AND ca.tipo_comprobante_codigo = 'agendamiento_no_fiscal'
        RETURNING ca.id_comprobante_agendamiento
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'comprobantes_agendamiento', id_comprobante_agendamiento FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const recipientsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.comprobantes_agendamiento_destinatarios cad
        SET nombre_destinatario_snapshot = 'Cliente eliminado',
            email_destinatario_snapshot =
              'deleted+destinatario-' || replace(cad.id_comprobante_destinatario::text, '-', '') || '@anon.masterfade.invalid',
            ultimo_error_detalle = NULL,
            estado_envio_codigo = CASE
              WHEN cad.estado_envio_codigo = 'pendiente' THEN 'omitido'
              ELSE cad.estado_envio_codigo
            END,
            updated_at = NOW()
        WHERE cad.id_comprobante_agendamiento IN (SELECT id_comprobante_agendamiento FROM mf_ad_comprobantes)
          AND (
            cad.tipo_destinatario_codigo = 'titular'
            OR lower(cad.email_destinatario_snapshot) IN (SELECT email FROM mf_ad_original_emails)
          )
        RETURNING cad.id_comprobante_destinatario
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'comprobantes_agendamiento_destinatarios', id_comprobante_destinatario FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const ordersResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.membership_purchase_orders mpo
        SET cliente_snapshot = app_private.fn_redact_account_pii_jsonb_v1(cliente_snapshot),
            factura_snapshot = app_private.fn_redact_account_pii_jsonb_v1(factura_snapshot),
            email_factura = NULL,
            notas = NULL,
            updated_at = NOW()
        WHERE mpo.id_cliente = $1::uuid
        RETURNING mpo.id_order
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'membership_purchase_orders', id_order FROM updated
      ON CONFLICT DO NOTHING
    `,
    [clienteId]
  );

  const nonIssuedInvoicesResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.facturas f
        SET receptor_nombre_snapshot = 'Cliente eliminado',
            receptor_rtn_snapshot = NULL,
            receptor_email_snapshot = NULL,
            receptor_telefono_snapshot = NULL,
            observaciones = NULL,
            payload_factura = app_private.fn_redact_account_pii_jsonb_v1(payload_factura),
            sar_respuesta_payload = app_private.fn_redact_account_pii_jsonb_v1(sar_respuesta_payload),
            updated_at = NOW()
        WHERE f.id_factura IN (SELECT id_factura FROM mf_ad_facturas_no_emitidas)
        RETURNING f.id_factura
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'facturas', id_factura FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const fiscalInvoicesResult = await client.query("SELECT COUNT(*)::int AS count FROM mf_ad_facturas_emitidas");

  const notificationsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.notificaciones_email ne
        SET id_usuario_destino = NULL,
            correo_destino = 'deleted+notificacion-' || replace(ne.id_notificacion::text, '-', '') || '@anon.masterfade.invalid',
            asunto = 'Notificacion archivada',
            cuerpo = 'Contenido eliminado por solicitud de eliminacion de cuenta.',
            ultimo_error = NULL,
            procesando_desde = NULL,
            worker_id = NULL,
            estado_notificacion_codigo = CASE
              WHEN ne.estado_notificacion_codigo IN ('pendiente', 'procesando') THEN 'cancelada'
              ELSE ne.estado_notificacion_codigo
            END,
            updated_at = NOW()
        WHERE ne.id_notificacion IN (SELECT id_notificacion FROM mf_ad_notificaciones)
        RETURNING ne.id_notificacion
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'notificaciones_email', id_notificacion FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const communicationsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.comunicaciones_envios ce
        SET correo_destino = 'deleted+envio-' || replace(ce.id_envio::text, '-', '') || '@anon.masterfade.invalid',
            id_usuario_destino = NULL,
            provider_message_id = NULL,
            ultimo_error = NULL,
            estado_envio = CASE
              WHEN ce.estado_envio IN ('pendiente', 'enviando') THEN 'omitido'
              ELSE ce.estado_envio
            END,
            motivo_omision = CASE
              WHEN ce.estado_envio IN ('pendiente', 'enviando') THEN 'eliminacion_cuenta'
              ELSE ce.motivo_omision
            END,
            updated_at = NOW()
        WHERE ce.id_envio IN (SELECT id_envio FROM mf_ad_comunicaciones)
        RETURNING ce.id_envio
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'comunicaciones_envios', id_envio FROM updated
      ON CONFLICT DO NOTHING
    `
  );

  const securitySessionsResult = await client.query(
    `
      WITH updated AS (
        UPDATE public.seguridad_sesiones ss
        SET ip_inicio = NULL,
            ip_ultimo_uso = NULL,
            user_agent = NULL,
            metadata = '{}'::jsonb
        WHERE ss.id_usuario = $1::uuid
        RETURNING ss.id_sesion
      )
      INSERT INTO mf_ad_bitacora_targets (tabla, registro_id)
      SELECT 'seguridad_sesiones', id_sesion FROM updated
      ON CONFLICT DO NOTHING
    `,
    [usuarioId]
  );

  const securityAccessResult = await client.query(
    `
      UPDATE public.seguridad_usuarios_acceso sua
      SET failed_login_count = 0,
          last_failed_login_at = NULL,
          locked_until_at = NULL,
          password_changed_at = NULL,
          password_expires_at = NULL,
          force_password_change = FALSE,
          last_login_at = NULL,
          last_login_ip = NULL,
          updated_by = NULL,
          updated_at = NOW()
      WHERE sua.id_usuario = $1::uuid
    `,
    [usuarioId]
  );

  const loginLogsResult = await client.query(
    `
      UPDATE public.seguridad_login_logs sll
      SET identificador_hash = NULL,
          email_masked = NULL,
          ip = NULL,
          user_agent = NULL,
          metadata = app_private.fn_redact_account_pii_jsonb_v1(metadata)
      WHERE sll.id_usuario = $1::uuid
    `,
    [usuarioId]
  );

  const securityAuditResult = await client.query(
    `
      UPDATE public.seguridad_audit_logs sal
      SET ip = NULL,
          metadata = app_private.fn_redact_account_pii_jsonb_v1(metadata)
      WHERE sal.id_usuario = $1::uuid
    `,
    [usuarioId]
  );

  const alertsResult = await client.query(
    `
      UPDATE public.seguridad_alertas sa
      SET ip = NULL,
          resumen = 'Alerta historica de cuenta anonimizada',
          detalle = app_private.fn_redact_account_pii_jsonb_v1(detalle),
          comentario_resolucion = NULL
      WHERE sa.id_usuario = $1::uuid
    `,
    [usuarioId]
  );

  const auditRowsResult = await client.query(
    `
      UPDATE public.bitacoras b
      SET datos_antes = CASE
            WHEN datos_antes IS NULL THEN NULL
            ELSE app_private.fn_redact_account_pii_jsonb_v1(datos_antes)
          END,
          datos_despues = CASE
            WHEN datos_despues IS NULL THEN NULL
            ELSE app_private.fn_redact_account_pii_jsonb_v1(datos_despues)
          END,
          descripcion = CASE
            WHEN descripcion IS NULL THEN NULL
            ELSE 'Trazabilidad conservada tras anonimizacion de cuenta'
          END
      FROM mf_ad_bitacora_targets t
      WHERE b.registro_id = t.registro_id
        AND (b.tabla = t.tabla OR b.tabla = 'public.' || t.tabla)
        AND NOT EXISTS (
          SELECT 1
          FROM mf_ad_facturas_emitidas fe
          WHERE t.tabla = 'facturas'
            AND t.registro_id = fe.id_factura
        )
    `
  );

  await verifyAccountDeletionAnonymization(client, {
    clienteId,
    personaId,
    usuarioId,
  });

  const internalAnonymization = {
    anonymized_at: new Date().toISOString(),
    person_anonymized: true,
    client_anonymized: true,
    emails_anonymized: getRowCount(emailsResult),
    appointments_anonymized: getRowCount(appointmentsResult),
    appointment_members_anonymized: getRowCount(membersResult),
    appointment_groups_sanitized: getRowCount(groupsResult),
    booking_receipts_anonymized: getRowCount(receiptsResult),
    receipt_recipients_anonymized: getRowCount(recipientsResult),
    membership_orders_anonymized: getRowCount(ordersResult),
    non_issued_invoices_anonymized: getRowCount(nonIssuedInvoicesResult),
    fiscal_invoices_retained: toNumber(fiscalInvoicesResult.rows?.[0]?.count, 0),
    notifications_anonymized: getRowCount(notificationsResult),
    communications_anonymized: getRowCount(communicationsResult),
    security_records_sanitized:
      getRowCount(securitySessionsResult)
      + getRowCount(securityAccessResult)
      + getRowCount(loginLogsResult)
      + getRowCount(securityAuditResult)
      + getRowCount(alertsResult),
    audit_rows_redacted: getRowCount(auditRowsResult),
    storage_assets_pending: storageAssetsPending,
    storage_asset_ids: storageAssetIds,
  };

  const updatedRequest = await updateAccountDeletionAnonymizationRequest(client, {
    deletionRequestId,
    usuarioId,
    traceRequestId,
    resumenImpacto: request.resumen_impacto,
    internalAnonymization,
    hasStorageAssets: storageAssetsPending > 0,
  });

  const responseAnonymization = {
    person_anonymized: true,
    client_anonymized: true,
    emails_anonymized: internalAnonymization.emails_anonymized,
    appointments_anonymized: internalAnonymization.appointments_anonymized,
    appointment_members_anonymized: internalAnonymization.appointment_members_anonymized,
    appointment_groups_sanitized: internalAnonymization.appointment_groups_sanitized,
    booking_receipts_anonymized: internalAnonymization.booking_receipts_anonymized,
    receipt_recipients_anonymized: internalAnonymization.receipt_recipients_anonymized,
    membership_orders_anonymized: internalAnonymization.membership_orders_anonymized,
    non_issued_invoices_anonymized: internalAnonymization.non_issued_invoices_anonymized,
    fiscal_invoices_retained: internalAnonymization.fiscal_invoices_retained,
    notifications_anonymized: internalAnonymization.notifications_anonymized,
    communications_anonymized: internalAnonymization.communications_anonymized,
    security_records_sanitized: internalAnonymization.security_records_sanitized,
    audit_rows_redacted: internalAnonymization.audit_rows_redacted,
    storage_assets_pending: internalAnonymization.storage_assets_pending,
  };

  return {
    anonymized: true,
    idempotent_replay: false,
    request: {
      id_solicitud: updatedRequest?.id_solicitud ?? deletionRequestId,
      referencia_publica: updatedRequest?.referencia_publica ?? request.referencia_publica,
      estado_codigo: updatedRequest?.estado_codigo ?? (storageAssetsPending > 0 ? "storage_pendiente" : "auth_pendiente"),
    },
    internal_anonymization: responseAnonymization,
    ready_for_storage_cleanup: storageAssetsPending > 0,
    ready_for_auth_cleanup: storageAssetsPending === 0,
  };
}

export async function runClientAccountDeletionAnonymization(app, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
} = {}) {
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    await acquireAccountDeletionUserLock(client, usuarioId);

    const result = await anonymizeClientAccountDeletionInternal(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
      traceRequestId,
    });

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva la causa funcional.
      }
    }
    throw mapSerializationConflict(error);
  } finally {
    client.release();
  }
}

function isValidUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function getAllowedAccountDeletionStorageBuckets() {
  return new Set([
    STORAGE_PRIVATE_BUCKET,
    STORAGE_PUBLIC_BUCKET,
    "imagenes_privadas",
    "imagenes_publicas",
  ].map((bucket) => String(bucket || "").trim()).filter(Boolean));
}

function assertAccountDeletionStorageAvailable(app) {
  if (!app?.supabaseAdmin?.storage || typeof app.supabaseAdmin.storage.from !== "function") {
    throw new AppError(500, "No fue posible procesar los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_UNAVAILABLE",
    });
  }
}

async function acquireAccountDeletionSessionLock(client, usuarioId) {
  await client.query(
    `
      SELECT pg_advisory_lock(
        hashtext('masterfade.account_deletion'),
        hashtext($1::text)
      )
    `,
    [usuarioId]
  );
}

async function releaseAccountDeletionSessionLock(client, usuarioId) {
  await client.query(
    `
      SELECT pg_advisory_unlock(
        hashtext('masterfade.account_deletion'),
        hashtext($1::text)
      )
    `,
    [usuarioId]
  );
}

function readStorageAssetIdsFromRequest(request) {
  const resumenImpacto = normalizeJsonObject(request?.resumen_impacto, {});
  const rawIds = resumenImpacto?.internal_anonymization?.storage_asset_ids;
  if (!Array.isArray(rawIds)) {
    throw new AppError(500, "No fue posible validar los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_REFERENCES_INVALID",
    });
  }

  const ids = rawIds.map((value) => String(value || "").trim());
  const unique = new Set(ids.map((value) => value.toLowerCase()));
  if (
    ids.some((value) => !isValidUuid(value))
    || unique.size !== ids.length
  ) {
    throw new AppError(500, "No fue posible validar los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_REFERENCES_INVALID",
    });
  }

  return ids;
}

async function findAccountDeletionRequestForStorageCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        resumen_impacto,
        procesando_at,
        auth_user_id_pendiente
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND id_cliente = $2::uuid
        AND id_persona = $3::uuid
        AND id_usuario = $4::uuid
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
        AND requiere_aprobacion IS FALSE
        AND auth_user_id_pendiente = $4::uuid
      LIMIT 1
      FOR UPDATE
    `,
    [deletionRequestId, clienteId, personaId, usuarioId]
  );
  return rows?.[0] ?? null;
}

async function assertAccountDeletionStoragePreconditions(client, {
  clienteId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM public.clientes c
          WHERE c.id_cliente = $1::uuid
            AND c.estado IS FALSE
            AND c.deleted_at IS NOT NULL
            AND c.anonimizado IS TRUE
        ) AS client_ready,
        EXISTS (
          SELECT 1
          FROM public.usuarios u
          WHERE u.id_usuario = $2::uuid
            AND u.estado IS FALSE
            AND u.estado_acceso = 'inactivo'
            AND u.deleted_at IS NOT NULL
        ) AS user_ready
    `,
    [clienteId, usuarioId]
  );
  const row = rows?.[0] ?? {};
  if (!row.client_ready || !row.user_ready) {
    throw new AppError(409, "La cuenta no esta preparada para limpiar sus archivos.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_PRECONDITION_FAILED",
    });
  }
}

async function fetchAccountDeletionStorageAssets(client, assetIds) {
  if (!assetIds.length) return [];
  const { rows } = await client.query(
    `
      SELECT
        id_asset,
        bucket_name,
        object_path,
        status,
        deleted_at,
        owner_cliente_id,
        owner_user_id,
        entity_id
      FROM public.storage_assets
      WHERE id_asset = ANY($1::uuid[])
      FOR UPDATE
    `,
    [assetIds]
  );

  if (rows.length !== assetIds.length) {
    throw new AppError(500, "No fue posible localizar todos los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_ASSET_NOT_FOUND",
    });
  }

  const byId = new Map(rows.map((row) => [String(row.id_asset).toLowerCase(), row]));
  return assetIds.map((id) => byId.get(String(id).toLowerCase()));
}

function assertStorageAssetBelongsToAccount(asset, {
  clienteId,
  personaId,
  usuarioId,
}) {
  if (asset?.status === "eliminado" && asset?.deleted_at) return;
  const belongs = [personaId, clienteId, usuarioId].some((id) => String(asset?.entity_id || "") === String(id))
    || String(asset?.owner_cliente_id || "") === String(clienteId)
    || String(asset?.owner_user_id || "") === String(usuarioId);
  if (!belongs) {
    throw new AppError(403, "Un archivo no corresponde a la cuenta que se esta procesando.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_ASSET_OWNERSHIP_INVALID",
    });
  }
}

function assertStorageAssetLocation(asset) {
  const bucket = String(asset?.bucket_name || "").trim();
  const objectPath = String(asset?.object_path || "").trim();
  if (!getAllowedAccountDeletionStorageBuckets().has(bucket)) {
    throw new AppError(500, "No fue posible validar los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_BUCKET_INVALID",
    });
  }
  if (
    !objectPath
    || objectPath.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(objectPath)
    || objectPath.includes("..")
    || objectPath.includes("\\")
  ) {
    throw new AppError(500, "No fue posible validar los archivos asociados con la cuenta.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_PATH_INVALID",
    });
  }
}

async function prepareAccountDeletionStorageCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const request = await findAccountDeletionRequestForStorageCleanup(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!request) {
    throw new AppError(404, "No se encontro la solicitud de eliminacion indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (request.estado_codigo === "auth_pendiente") {
    const { rows } = await client.query(
      `
        SELECT COALESCE(c.anonimizado, FALSE) AS anonimizado
        FROM public.clientes c
        WHERE c.id_cliente = $1::uuid
          AND c.id_persona = $2::uuid
          AND c.id_usuario = $3::uuid
      `,
      [clienteId, personaId, usuarioId]
    );
    if (rows?.[0]?.anonimizado === true) {
      return { replay: true, request };
    }
  }

  if (request.estado_codigo !== "storage_pendiente" || !request.procesando_at) {
    throw new AppError(409, "La solicitud no se encuentra en un estado valido para limpiar sus archivos.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_STATE_INVALID",
      details: mapActiveRequestDetails(request),
    });
  }

  await assertAccountDeletionStoragePreconditions(client, { clienteId, usuarioId });
  const assetIds = readStorageAssetIdsFromRequest(request);
  const assets = await fetchAccountDeletionStorageAssets(client, assetIds);

  for (const asset of assets) {
    assertStorageAssetBelongsToAccount(asset, { clienteId, personaId, usuarioId });
    if (!(asset.status === "eliminado" && asset.deleted_at)) {
      assertStorageAssetLocation(asset);
    }
  }

  return { replay: false, request, assetIds, assets };
}

async function isStorageObjectAbsent(client, bucketName, objectPath) {
  const { rows } = await client.query(
    `
      SELECT NOT EXISTS (
        SELECT 1
        FROM storage.objects
        WHERE bucket_id = $1::text
          AND name = $2::text
      ) AS object_absent
    `,
    [bucketName, objectPath]
  );
  return rows?.[0]?.object_absent === true;
}

function sanitizeStorageErrorCode(error) {
  const raw = String(error?.code || error?.statusCode || error?.status || error?.name || "STORAGE_REMOVE_FAILED");
  return raw.replace(/[^A-Z0-9_]/gi, "_").slice(0, 80).toUpperCase() || "STORAGE_REMOVE_FAILED";
}

async function processAccountDeletionStorageAsset(app, client, asset) {
  if (asset.status === "eliminado" && asset.deleted_at) {
    return { idAsset: asset.id_asset, status: "already_deleted" };
  }

  const bucketName = String(asset.bucket_name || "").trim();
  const objectPath = String(asset.object_path || "").trim();
  const absentBefore = await isStorageObjectAbsent(client, bucketName, objectPath);
  if (absentBefore) {
    return { idAsset: asset.id_asset, status: "deleted" };
  }

  const { error } = await app.supabaseAdmin.storage.from(bucketName).remove([objectPath]);
  const absentAfter = await isStorageObjectAbsent(client, bucketName, objectPath);
  if (absentAfter) {
    return { idAsset: asset.id_asset, status: "deleted" };
  }

  return {
    idAsset: asset.id_asset,
    status: "failed",
    errorCode: sanitizeStorageErrorCode(error),
  };
}

function buildStorageCleanupSummary({
  totalAssets,
  deletedAssets,
  alreadyDeletedAssets,
  failedAssets,
  processed,
  timestamp,
}) {
  return {
    ...(processed ? { processed_at: timestamp } : { last_attempt_at: timestamp }),
    total_assets: totalAssets,
    deleted_assets: deletedAssets,
    already_deleted_assets: alreadyDeletedAssets,
    failed_assets: failedAssets,
    storage_processed: processed,
  };
}

function mergeStorageCleanupSummary(resumenImpacto, {
  storageCleanup,
  storageProcessed,
  storageAssetsPending,
}) {
  const current = normalizeJsonObject(resumenImpacto, {});
  return {
    ...current,
    internal_anonymization: {
      ...(normalizeJsonObject(current.internal_anonymization, {}) || {}),
      storage_assets_pending: storageAssetsPending,
      storage_processed: storageProcessed,
      auth_processed: false,
    },
    storage_cleanup: storageCleanup,
  };
}

async function finalizeAccountDeletionStorageCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
  results,
}) {
  const request = await findAccountDeletionRequestForStorageCleanup(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!request) {
    throw new AppError(404, "No se encontro la solicitud de eliminacion indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }
  if (request.estado_codigo !== "storage_pendiente" || !request.procesando_at) {
    throw new AppError(409, "La solicitud no se encuentra en un estado valido para limpiar sus archivos.", {
      code: "CLIENT_ACCOUNT_DELETION_STORAGE_STATE_INVALID",
      details: mapActiveRequestDetails(request),
    });
  }

  const assetIds = readStorageAssetIdsFromRequest(request);
  await fetchAccountDeletionStorageAssets(client, assetIds);

  const timestamp = new Date().toISOString();
  const deleted = results.filter((item) => item.status === "deleted");
  const alreadyDeleted = results.filter((item) => item.status === "already_deleted");
  const failed = results.filter((item) => item.status === "failed");

  for (const item of deleted) {
    await client.query(
      `
        UPDATE public.storage_assets
        SET status = 'eliminado',
            deleted_at = COALESCE(deleted_at, NOW()),
            public_url = NULL,
            original_filename = NULL,
            extension = NULL,
            metadata = jsonb_build_object(
              'account_deletion',
              jsonb_build_object(
                'status', 'deleted',
                'deleted_at', $3::text,
                'request_id', $4::text
              )
            ),
            owner_user_id = NULL,
            owner_cliente_id = NULL,
            entity_id = NULL,
            uploaded_by = NULL,
            object_path = 'deleted/account-deletion/' || replace(id_asset::text, '-', ''),
            updated_at = NOW()
        WHERE id_asset = $1::uuid
          AND id_asset = ANY($2::uuid[])
      `,
      [item.idAsset, assetIds, timestamp, traceRequestId]
    );
  }

  for (const item of failed) {
    await client.query(
      `
        UPDATE public.storage_assets
        SET status = 'fallido',
            public_url = NULL,
            original_filename = NULL,
            metadata = jsonb_build_object(
              'account_deletion',
              jsonb_build_object(
                'status', 'failed',
                'attempted_at', $3::text,
                'error_code', $4::text
              )
            ),
            updated_at = NOW()
        WHERE id_asset = $1::uuid
          AND id_asset = ANY($2::uuid[])
      `,
      [item.idAsset, assetIds, timestamp, item.errorCode || "STORAGE_REMOVE_FAILED"]
    );
  }

  const totalAssets = results.length;
  const deletedAssets = deleted.length;
  const alreadyDeletedAssets = alreadyDeleted.length;
  const failedAssets = failed.length;
  const storageProcessed = failedAssets === 0;
  const storageCleanup = buildStorageCleanupSummary({
    totalAssets,
    deletedAssets,
    alreadyDeletedAssets,
    failedAssets,
    processed: storageProcessed,
    timestamp,
  });
  const storageAssetsPending = failedAssets;
  const resumenImpacto = mergeStorageCleanupSummary(request.resumen_impacto, {
    storageCleanup,
    storageProcessed,
    storageAssetsPending,
  });

  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = $2::text,
          resumen_impacto = $3::jsonb,
          request_id = $4::text,
          auth_user_id_pendiente = $5::uuid,
          error_codigo = $6::text,
          error_detalle_tecnico = $7::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo
    `,
    [
      deletionRequestId,
      storageProcessed ? "auth_pendiente" : "storage_pendiente",
      JSON.stringify(resumenImpacto),
      traceRequestId,
      usuarioId,
      storageProcessed ? null : "CLIENT_ACCOUNT_DELETION_STORAGE_PARTIAL_FAILURE",
      storageProcessed ? null : `No se procesaron ${failedAssets} de ${totalAssets} activos de Storage.`,
    ]
  );

  return {
    storage_processed: storageProcessed,
    ready_for_auth_cleanup: storageProcessed,
    idempotent_replay: false,
    retryable: !storageProcessed,
    ...(storageProcessed ? {} : { failed_assets: failedAssets }),
    request: rows?.[0]
      ? {
          id_solicitud: rows[0].id_solicitud,
          referencia_publica: rows[0].referencia_publica,
          estado_codigo: rows[0].estado_codigo,
        }
      : undefined,
    storage_cleanup: {
      total_assets: totalAssets,
      deleted_assets: deletedAssets,
      already_deleted_assets: alreadyDeletedAssets,
      failed_assets: failedAssets,
    },
  };
}

async function markAccountDeletionStorageNoAssets(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
}) {
  const request = await findAccountDeletionRequestForStorageCleanup(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });
  if (!request) {
    throw new AppError(404, "No se encontro la solicitud de eliminacion indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  const timestamp = new Date().toISOString();
  const storageCleanup = buildStorageCleanupSummary({
    totalAssets: 0,
    deletedAssets: 0,
    alreadyDeletedAssets: 0,
    failedAssets: 0,
    processed: true,
    timestamp,
  });
  const resumenImpacto = mergeStorageCleanupSummary(request.resumen_impacto, {
    storageCleanup,
    storageProcessed: true,
    storageAssetsPending: 0,
  });

  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'auth_pendiente',
          resumen_impacto = $2::jsonb,
          request_id = $3::text,
          auth_user_id_pendiente = $4::uuid,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo
    `,
    [deletionRequestId, JSON.stringify(resumenImpacto), traceRequestId, usuarioId]
  );

  return {
    storage_processed: true,
    ready_for_auth_cleanup: true,
    idempotent_replay: false,
    retryable: false,
    request: rows?.[0]
      ? {
          id_solicitud: rows[0].id_solicitud,
          referencia_publica: rows[0].referencia_publica,
          estado_codigo: rows[0].estado_codigo,
        }
      : undefined,
    storage_cleanup: {
      total_assets: 0,
      deleted_assets: 0,
      already_deleted_assets: 0,
      failed_assets: 0,
    },
  };
}

function mapUnexpectedStorageError(error) {
  if (error instanceof AppError) return mapSerializationConflict(error);
  const mapped = mapSerializationConflict(error);
  if (mapped !== error) return mapped;
  return new AppError(503, "No fue posible completar la limpieza de archivos. Intenta nuevamente.", {
    code: "CLIENT_ACCOUNT_DELETION_STORAGE_TEMPORARY_FAILURE",
  });
}

export async function runClientAccountDeletionStorageCleanup(app, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
} = {}) {
  assertAccountDeletionStorageAvailable(app);
  const client = await app.db.connect();
  let sessionLockHeld = false;
  let transactionStarted = false;

  try {
    await acquireAccountDeletionSessionLock(client, usuarioId);
    sessionLockHeld = true;

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const prepared = await prepareAccountDeletionStorageCleanup(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
    });
    await client.query("COMMIT");
    transactionStarted = false;

    if (prepared.replay) {
      return {
        storage_processed: true,
        ready_for_auth_cleanup: true,
        idempotent_replay: true,
      };
    }

    if (prepared.assetIds.length === 0) {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      transactionStarted = true;
      const result = await markAccountDeletionStorageNoAssets(client, {
        deletionRequestId,
        clienteId,
        personaId,
        usuarioId,
        traceRequestId,
      });
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    }

    const results = [];
    for (const asset of prepared.assets) {
      results.push(await processAccountDeletionStorageAsset(app, client, asset));
    }

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const result = await finalizeAccountDeletionStorageCleanup(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
      traceRequestId,
      results,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva la causa funcional.
      }
    }
    throw mapUnexpectedStorageError(error);
  } finally {
    if (sessionLockHeld) {
      try {
        await releaseAccountDeletionSessionLock(client, usuarioId);
      } catch {
        // El cierre de conexion sigue siendo obligatorio aunque falle el unlock.
      }
    }
    client.release();
  }
}

function assertAccountDeletionAuthAvailable(app) {
  const admin = app?.supabaseAdmin?.auth?.admin;
  if (
    typeof admin?.getUserById !== "function"
    || typeof admin?.deleteUser !== "function"
  ) {
    throw new AppError(500, "No fue posible procesar la identidad de autenticacion.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_UNAVAILABLE",
    });
  }
}

function isSupabaseAuthUserNotFoundError(error) {
  if (!error) return false;
  const status = Number(error.status || error.statusCode || error.__statusCode);
  const code = String(error.code || error.error_code || "").trim().toLowerCase();
  const name = String(error.name || "").trim().toLowerCase();
  const message = String(error.message || "").trim().toLowerCase();
  return status === 404
    || code === "user_not_found"
    || code === "not_found"
    || name === "authapierror" && message.includes("user not found")
    || message.includes("user not found")
    || message.includes("user_not_found");
}

function sanitizeAuthFailureCode(code) {
  return String(code || "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE")
    .replace(/[^A-Z0-9_]/gi, "_")
    .slice(0, 100)
    .toUpperCase();
}

async function findAccountDeletionRequestForAuthCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        resumen_impacto,
        procesando_at,
        completado_at,
        auth_user_id_pendiente
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE id_solicitud = $1::uuid
        AND id_cliente = $2::uuid
        AND id_persona = $3::uuid
        AND id_usuario = $4::uuid
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
        AND requiere_aprobacion IS FALSE
      LIMIT 1
      FOR UPDATE
    `,
    [deletionRequestId, clienteId, personaId, usuarioId]
  );
  return rows?.[0] ?? null;
}

async function assertAccountDeletionAuthPreconditions(client, {
  request,
  clienteId,
  personaId,
  usuarioId,
}) {
  const resumenImpacto = normalizeJsonObject(request?.resumen_impacto, {});
  const internalAnonymization = normalizeJsonObject(resumenImpacto?.internal_anonymization, {});
  const storageAssetIds = Array.isArray(internalAnonymization?.storage_asset_ids)
    ? internalAnonymization.storage_asset_ids.map((value) => String(value || "").trim())
    : [];

  if (
    !Array.isArray(internalAnonymization?.storage_asset_ids)
    || storageAssetIds.some((id) => !isValidUuid(id))
    || new Set(storageAssetIds.map((id) => id.toLowerCase())).size !== storageAssetIds.length
    || toNumber(internalAnonymization?.storage_assets_pending, 0) !== 0
  ) {
    throw new AppError(409, "La cuenta no esta preparada para eliminar su identidad de autenticacion.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED",
    });
  }

  const { rows } = await client.query(
    `
      WITH params AS (
        SELECT $1::uuid AS cliente_id, $2::uuid AS persona_id, $3::uuid AS usuario_id
      ),
      storage_expected AS (
        SELECT unnest($4::uuid[]) AS id_asset
      ),
      storage_status AS (
        SELECT
          COUNT(sa.id_asset)::int AS found_count,
          COUNT(*) FILTER (
            WHERE sa.status <> 'eliminado'
               OR sa.deleted_at IS NULL
               OR sa.owner_user_id IS NOT NULL
               OR sa.owner_cliente_id IS NOT NULL
               OR sa.entity_id IS NOT NULL
          )::int AS invalid_count
        FROM storage_expected se
        LEFT JOIN public.storage_assets sa ON sa.id_asset = se.id_asset
      )
      SELECT
        EXISTS (
          SELECT 1
          FROM public.usuarios u, params p
          WHERE u.id_usuario = p.usuario_id
            AND u.id_persona = p.persona_id
            AND u.estado IS FALSE
            AND u.estado_acceso = 'inactivo'
            AND u.password_hash IS NULL
            AND u.deleted_at IS NOT NULL
        ) AS user_ready,
        EXISTS (
          SELECT 1
          FROM public.clientes c, params p
          WHERE c.id_cliente = p.cliente_id
            AND c.id_persona = p.persona_id
            AND c.id_usuario = p.usuario_id
            AND c.estado IS FALSE
            AND c.anonimizado IS TRUE
            AND c.deleted_at IS NOT NULL
        ) AS client_ready,
        EXISTS (
          SELECT 1
          FROM public.personas pe, params p
          WHERE pe.id_persona = p.persona_id
            AND pe.nombres = 'Cliente'
            AND pe.apellidos = 'eliminado'
            AND pe.dni IS NULL
            AND pe.rtn IS NULL
            AND pe.telefono_principal IS NULL
            AND pe.direccion_texto IS NULL
            AND pe.deleted_at IS NOT NULL
        ) AS person_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.roles_usuarios ru, params p
          WHERE ru.id_usuario = p.usuario_id
            AND ru.activo IS TRUE
        ) AS roles_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.app_protected_users apu, params p
          WHERE apu.id_usuario = p.usuario_id
            AND apu.activo IS TRUE
        ) AS protected_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.correos co, params p
          WHERE co.id_persona = p.persona_id
            AND (
              co.deleted_at IS NULL
              OR co.es_principal IS DISTINCT FROM FALSE
              OR co.verificado IS DISTINCT FROM FALSE
              OR co.direccion_correo NOT LIKE '%@anon.masterfade.invalid'
            )
        ) AS emails_ready,
        (SELECT found_count FROM storage_status) = cardinality($4::uuid[])
          AND (SELECT invalid_count FROM storage_status) = 0 AS storage_ready,
        NOT EXISTS (
          SELECT 1
          FROM public.subscriptions s, params p
          WHERE s.id_cliente = p.cliente_id
            AND s.estado_suscripcion_codigo = 'activa'
        ) AS memberships_ready,
        COALESCE((
          SELECT vpb.balance_puntos
          FROM public.vw_points_balance vpb, params p
          WHERE vpb.id_cliente = p.cliente_id
        ), 0)::numeric <= 0 AS points_ready
    `,
    [clienteId, personaId, usuarioId, storageAssetIds]
  );

  const row = rows?.[0] ?? {};
  const ok = Object.values(row).every((value) => value === true);
  if (!ok) {
    throw new AppError(409, "La cuenta no esta preparada para eliminar su identidad de autenticacion.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED",
    });
  }
}

async function prepareClientAccountDeletionAuthCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
}) {
  const request = await findAccountDeletionRequestForAuthCleanup(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (!request) {
    throw new AppError(404, "No se encontro la solicitud de eliminacion indicada.", {
      code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }

  if (
    request.estado_codigo === "completada"
    && request.completado_at
    && request.auth_user_id_pendiente === null
  ) {
    return { replay: true, request };
  }

  if (
    request.estado_codigo !== "auth_pendiente"
    || !request.procesando_at
    || request.completado_at
    || !request.auth_user_id_pendiente
  ) {
    throw new AppError(409, "La solicitud no se encuentra en un estado valido para eliminar la identidad.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_STATE_INVALID",
      details: mapActiveRequestDetails(request),
    });
  }

  if (String(request.auth_user_id_pendiente) !== String(usuarioId)) {
    throw new AppError(409, "La identidad de autenticacion no coincide con la cuenta procesada.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_IDENTITY_MISMATCH",
    });
  }

  await assertAccountDeletionAuthPreconditions(client, {
    request,
    clienteId,
    personaId,
    usuarioId,
  });

  return {
    replay: false,
    request,
    authUserId: request.auth_user_id_pendiente,
  };
}

async function findAuthUserById(app, authUserId) {
  const { data, error } = await app.supabaseAdmin.auth.admin.getUserById(authUserId);
  if (error) {
    if (isSupabaseAuthUserNotFoundError(error)) {
      return { exists: false, user: null };
    }
    throw new AppError(503, "No fue posible completar la eliminacion de la identidad. Intenta nuevamente.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
      details: { causeCode: "CLIENT_ACCOUNT_DELETION_AUTH_LOOKUP_FAILED" },
    });
  }

  if (String(data?.user?.id || "") !== String(authUserId)) {
    throw new AppError(503, "No fue posible completar la eliminacion de la identidad. Intenta nuevamente.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
      details: { causeCode: "CLIENT_ACCOUNT_DELETION_AUTH_LOOKUP_FAILED" },
    });
  }

  return { exists: true, user: { id: data.user.id } };
}

async function deleteAuthUserById(app, authUserId) {
  const { error } = await app.supabaseAdmin.auth.admin.deleteUser(authUserId, false);
  if (!error) return { deleted: true };
  return { deleted: false, error };
}

async function verifyAuthUserAbsent(app, authUserId) {
  const { data, error } = await app.supabaseAdmin.auth.admin.getUserById(authUserId);
  if (error && isSupabaseAuthUserNotFoundError(error)) return true;
  if (error) {
    throw new AppError(503, "No fue posible completar la eliminacion de la identidad. Intenta nuevamente.", {
      code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
      details: { causeCode: "CLIENT_ACCOUNT_DELETION_AUTH_LOOKUP_FAILED" },
    });
  }
  return !data?.user?.id;
}

function mergeAuthFailureSummary(resumenImpacto, {
  timestamp,
  errorCode,
}) {
  return {
    ...normalizeJsonObject(resumenImpacto, {}),
    auth_cleanup: {
      last_attempt_at: timestamp,
      auth_processed: false,
      retryable: true,
      error_code: sanitizeAuthFailureCode(errorCode),
    },
  };
}

async function persistClientAccountDeletionAuthFailure(client, {
  deletionRequestId,
  usuarioId,
  traceRequestId,
  errorCode,
}) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let transactionStarted = true;
  try {
    const { rows } = await client.query(
      `
        SELECT resumen_impacto
        FROM app_private.solicitudes_eliminacion_cuenta
        WHERE id_solicitud = $1::uuid
          AND estado_codigo = 'auth_pendiente'
          AND auth_user_id_pendiente = $2::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [deletionRequestId, usuarioId]
    );

    if (rows?.[0]) {
      const timestamp = new Date().toISOString();
      await client.query(
        `
          UPDATE app_private.solicitudes_eliminacion_cuenta
          SET estado_codigo = 'auth_pendiente',
              auth_user_id_pendiente = $2::uuid,
              error_codigo = $3::text,
              error_detalle_tecnico = 'No fue posible completar la eliminacion de Auth en este intento.',
              request_id = $4::text,
              resumen_impacto = $5::jsonb,
              updated_at = NOW()
          WHERE id_solicitud = $1::uuid
        `,
        [
          deletionRequestId,
          usuarioId,
          sanitizeAuthFailureCode(errorCode),
          traceRequestId,
          JSON.stringify(mergeAuthFailureSummary(rows[0].resumen_impacto, {
            timestamp,
            errorCode,
          })),
        ]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva la causa funcional.
      }
    }
    throw mapSerializationConflict(error);
  }
}

function mergeAuthCompletionSummary(resumenImpacto, {
  timestamp,
  authUserAlreadyAbsent,
}) {
  const current = normalizeJsonObject(resumenImpacto, {});
  const internalAnonymization = normalizeJsonObject(current.internal_anonymization, {}) || {};
  return {
    ...current,
    internal_anonymization: {
      ...internalAnonymization,
      pii_anonymized: true,
      storage_assets_pending: 0,
      storage_processed: true,
      auth_processed: true,
    },
    auth_cleanup: {
      processed_at: timestamp,
      auth_user_deleted: true,
      auth_user_already_absent: Boolean(authUserAlreadyAbsent),
      auth_processed: true,
      retryable: false,
    },
    completion: {
      completed_at: timestamp,
      account_deleted: true,
      history_retained_anonymized: true,
    },
  };
}

export async function finalizeClientAccountDeletionAuthCleanup(client, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
  authUserAlreadyAbsent = false,
} = {}) {
  const prepared = await prepareClientAccountDeletionAuthCleanup(client, {
    deletionRequestId,
    clienteId,
    personaId,
    usuarioId,
  });

  if (prepared.replay) {
    return {
      completed: true,
      auth_processed: true,
      idempotent_replay: true,
    };
  }

  const timestamp = new Date().toISOString();
  const resumenImpacto = mergeAuthCompletionSummary(prepared.request.resumen_impacto, {
    timestamp,
    authUserAlreadyAbsent,
  });

  const { rows } = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'completada',
          auth_user_id_pendiente = NULL,
          completado_at = COALESCE(completado_at, NOW()),
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          request_id = $2::text,
          resumen_impacto = $3::jsonb,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo, completado_at
    `,
    [deletionRequestId, traceRequestId, JSON.stringify(resumenImpacto)]
  );

  const row = rows?.[0];
  return {
    completed: true,
    auth_processed: true,
    idempotent_replay: false,
    request: {
      id_solicitud: row?.id_solicitud ?? deletionRequestId,
      referencia_publica: row?.referencia_publica ?? prepared.request.referencia_publica,
      estado_codigo: row?.estado_codigo ?? "completada",
      completado_at: toIsoString(row?.completado_at) || timestamp,
    },
    completion: {
      account_deleted: true,
      history_retained_anonymized: true,
    },
  };
}

async function failClientAccountDeletionAuthAttempt(client, {
  deletionRequestId,
  usuarioId,
  traceRequestId,
  errorCode,
  responseCode = "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
}) {
  await persistClientAccountDeletionAuthFailure(client, {
    deletionRequestId,
    usuarioId,
    traceRequestId,
    errorCode,
  });
  throw new AppError(503, "No fue posible completar la eliminacion de la identidad. Intenta nuevamente.", {
    code: responseCode,
  });
}

export async function runClientAccountDeletionAuthCleanup(app, {
  deletionRequestId,
  clienteId,
  personaId,
  usuarioId,
  traceRequestId,
} = {}) {
  assertAccountDeletionAuthAvailable(app);
  const client = await app.db.connect();
  let sessionLockHeld = false;
  let transactionStarted = false;

  try {
    await acquireAccountDeletionSessionLock(client, usuarioId);
    sessionLockHeld = true;

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const prepared = await prepareClientAccountDeletionAuthCleanup(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
    });
    await client.query("COMMIT");
    transactionStarted = false;

    if (prepared.replay) {
      return {
        completed: true,
        auth_processed: true,
        idempotent_replay: true,
      };
    }

    const authUserId = prepared.authUserId;
    let authUserAlreadyAbsent = false;

    try {
      const lookup = await findAuthUserById(app, authUserId);
      authUserAlreadyAbsent = !lookup.exists;

      if (lookup.exists) {
        const deleteResult = await deleteAuthUserById(app, authUserId);
        if (!deleteResult.deleted) {
          const absentAfterDeleteError = await verifyAuthUserAbsent(app, authUserId);
          if (!absentAfterDeleteError) {
            await failClientAccountDeletionAuthAttempt(client, {
              deletionRequestId,
              usuarioId,
              traceRequestId,
              errorCode: "CLIENT_ACCOUNT_DELETION_AUTH_DELETE_FAILED",
            });
          }
        }

        const absentAfterDelete = await verifyAuthUserAbsent(app, authUserId);
        if (!absentAfterDelete) {
          await failClientAccountDeletionAuthAttempt(client, {
            deletionRequestId,
            usuarioId,
            traceRequestId,
            errorCode: "CLIENT_ACCOUNT_DELETION_AUTH_VERIFICATION_FAILED",
            responseCode: "CLIENT_ACCOUNT_DELETION_AUTH_VERIFICATION_FAILED",
          });
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 503 && error.details?.causeCode) {
        await failClientAccountDeletionAuthAttempt(client, {
          deletionRequestId,
          usuarioId,
          traceRequestId,
          errorCode: error.details?.causeCode || error.code,
          responseCode: error.code === "CLIENT_ACCOUNT_DELETION_AUTH_VERIFICATION_FAILED"
            ? "CLIENT_ACCOUNT_DELETION_AUTH_VERIFICATION_FAILED"
            : "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
        });
      }
      throw error;
    }

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const result = await finalizeClientAccountDeletionAuthCleanup(client, {
      deletionRequestId,
      clienteId,
      personaId,
      usuarioId,
      traceRequestId,
      authUserAlreadyAbsent,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva la causa funcional.
      }
    }
    throw mapSerializationConflict(error);
  } finally {
    if (sessionLockHeld) {
      try {
        await releaseAccountDeletionSessionLock(client, usuarioId);
      } catch {
        // El cierre de conexion sigue siendo obligatorio aunque falle el unlock.
      }
    }
    client.release();
  }
}

function withHttpStatus(payload, statusCode) {
  Object.defineProperty(payload, "httpStatus", {
    value: statusCode,
    enumerable: false,
  });
  return payload;
}

function buildAccountDeletionCompletionResponse(context, { idempotentReplay = false } = {}) {
  return {
    completed: true,
    idempotent_replay: Boolean(idempotentReplay),
    request: {
      reference: context.referenciaPublica,
      status: "completada",
      completed_at: toIsoString(context.completadoAt),
    },
    completion: {
      account_deleted: true,
      history_retained_anonymized: true,
    },
  };
}

function buildAccountDeletionRetryableResponse(context) {
  return withHttpStatus({
    completed: false,
    retryable: true,
    request: {
      reference: context.referenciaPublica,
      status: context.estadoCodigo,
    },
  }, 503);
}

async function clearAccountDeletionExecutionToken(client, {
  deletionRequestId,
  traceRequestId,
}) {
  await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET execution_token_hash = NULL,
          execution_token_expires_at = NULL,
          request_id = $2::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
        AND estado_codigo <> 'completada'
    `,
    [deletionRequestId, traceRequestId]
  );
}

export async function loadAccountDeletionExecutionContext(client, {
  reference,
  executionToken,
  traceRequestId,
} = {}) {
  const normalizedReference = assertAccountDeletionExecutionReference(reference);
  const token = assertAccountDeletionExecutionTokenInput(executionToken);

  const { rows } = await client.query(
    `
      SELECT
        id_solicitud,
        referencia_publica,
        estado_codigo,
        id_cliente,
        id_persona,
        id_usuario,
        reautenticado_at,
        completado_at,
        execution_token_hash,
        execution_token_expires_at
      FROM app_private.solicitudes_eliminacion_cuenta
      WHERE referencia_publica = $1::text
        AND tipo_sujeto = 'cliente'
        AND modo_proceso = 'autonomo'
        AND requiere_aprobacion IS FALSE
      LIMIT 1
    `,
    [normalizedReference]
  );

  const row = rows?.[0] ?? null;
  if (!row?.execution_token_hash || !verifyAccountDeletionExecutionToken(token, row.execution_token_hash)) {
    throw executionCredentialInvalidError();
  }

  const estadoCodigo = String(row.estado_codigo || "");
  const context = {
    deletionRequestId: row.id_solicitud,
    referenciaPublica: row.referencia_publica,
    estadoCodigo,
    clienteId: row.id_cliente,
    personaId: row.id_persona,
    usuarioId: row.id_usuario,
    reautenticadoAt: row.reautenticado_at,
    completadoAt: row.completado_at,
  };

  if (estadoCodigo === "evaluada") {
    const expiresAt = new Date(row.execution_token_expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      await clearAccountDeletionExecutionToken(client, {
        deletionRequestId: row.id_solicitud,
        traceRequestId,
      });
      throw new AppError(401, "Debes confirmar nuevamente la eliminacion de tu cuenta.", {
        code: "CLIENT_ACCOUNT_DELETION_EXECUTION_TOKEN_EXPIRED",
      });
    }
  }

  if (estadoCodigo !== "completada") {
    await client.query(
      `
        UPDATE app_private.solicitudes_eliminacion_cuenta
        SET execution_token_last_used_at = NOW(),
            request_id = $2::text,
            updated_at = NOW()
        WHERE id_solicitud = $1::uuid
          AND execution_token_hash IS NOT NULL
          AND estado_codigo <> 'completada'
      `,
      [row.id_solicitud, traceRequestId]
    );
  }

  return context;
}

function assertAccountDeletionExecutionStateValid(context) {
  if (EXECUTION_TOKEN_START_STATES.includes(context.estadoCodigo)) return;
  throw new AppError(409, "La solicitud no se encuentra en un estado valido para ejecucion.", {
    code: "CLIENT_ACCOUNT_DELETION_EXECUTION_STATE_INVALID",
  });
}

export async function orchestrateClientAccountDeletion(app, {
  reference,
  executionToken,
  traceRequestId,
  stageRunners = {},
} = {}) {
  let lastContext;
  let initialState = null;
  const runInternal = stageRunners.internal || runClientAccountDeletionInternal;
  const runAnonymization = stageRunners.anonymization || runClientAccountDeletionAnonymization;
  const runStorage = stageRunners.storage || runClientAccountDeletionStorageCleanup;
  const runAuth = stageRunners.auth || runClientAccountDeletionAuthCleanup;

  for (let iteration = 0; iteration < MAX_ACCOUNT_DELETION_ORCHESTRATION_ITERATIONS; iteration += 1) {
    const client = await app.db.connect();
    try {
      lastContext = await loadAccountDeletionExecutionContext(client, {
        reference,
        executionToken,
        traceRequestId,
      });
    } finally {
      client.release();
    }

    if (!initialState) initialState = lastContext.estadoCodigo;
    assertAccountDeletionExecutionStateValid(lastContext);

    if (lastContext.estadoCodigo === "completada") {
      return withHttpStatus(
        buildAccountDeletionCompletionResponse(lastContext, { idempotentReplay: initialState === "completada" }),
        200
      );
    }

    if (lastContext.estadoCodigo === "evaluada") {
      try {
        const result = await runInternal(app, {
          deletionRequestId: lastContext.deletionRequestId,
          clienteId: lastContext.clienteId,
          personaId: lastContext.personaId,
          usuarioId: lastContext.usuarioId,
          authenticatedAt: lastContext.reautenticadoAt,
          traceRequestId,
        });

        if (result?.processed === false && result?.request_state === "bloqueada") {
          throw new AppError(409, "La cuenta ya no puede eliminarse mientras existan operaciones pendientes.", {
            code: "CLIENT_ACCOUNT_DELETION_BLOCKED",
            details: { blocking_reasons: sanitizeBlockingReasons(result.blocking_reasons) },
          });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING") {
          const client = await app.db.connect();
          try {
            await clearAccountDeletionExecutionToken(client, {
              deletionRequestId: lastContext.deletionRequestId,
              traceRequestId,
            });
          } finally {
            client.release();
          }
          throw new AppError(401, "Debes confirmar nuevamente la eliminacion de tu cuenta.", {
            code: "CLIENT_ACCOUNT_DELETION_REAUTH_REQUIRED",
          });
        }
        throw error;
      }
      continue;
    }

    if (lastContext.estadoCodigo === "procesando") {
      await runAnonymization(app, {
        deletionRequestId: lastContext.deletionRequestId,
        clienteId: lastContext.clienteId,
        personaId: lastContext.personaId,
        usuarioId: lastContext.usuarioId,
        traceRequestId,
      });
      continue;
    }

    if (lastContext.estadoCodigo === "storage_pendiente") {
      const result = await runStorage(app, {
        deletionRequestId: lastContext.deletionRequestId,
        clienteId: lastContext.clienteId,
        personaId: lastContext.personaId,
        usuarioId: lastContext.usuarioId,
        traceRequestId,
      });

      if (result?.storage_processed === false) {
        return buildAccountDeletionRetryableResponse(lastContext);
      }
      continue;
    }

    if (lastContext.estadoCodigo === "auth_pendiente") {
      try {
        await runAuth(app, {
          deletionRequestId: lastContext.deletionRequestId,
          clienteId: lastContext.clienteId,
          personaId: lastContext.personaId,
          usuarioId: lastContext.usuarioId,
          traceRequestId,
        });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 503) {
          return buildAccountDeletionRetryableResponse(lastContext);
        }
        throw error;
      }
      continue;
    }
  }

  throw new AppError(500, "No fue posible completar correctamente el proceso de eliminacion.", {
    code: "CLIENT_ACCOUNT_DELETION_ORCHESTRATION_LIMIT_REACHED",
  });
}

export async function verifyRecentAccountDeletionReauthentication(app, {
  reauthToken,
  expectedUserId,
} = {}) {
  const token = String(reauthToken || "").trim();
  if (!token) {
    throw new AppError(401, "Debes volver a autenticarte antes de confirmar la eliminación.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_INVALID",
    });
  }

  if (!app?.supabaseAdmin) {
    throw new AppError(500, "No fue posible validar nuevamente la identidad.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_UNAVAILABLE",
    });
  }

  const authResult = await app.supabaseAdmin.auth.getUser(token);
  const authUser = authResult?.data?.user;
  if (authResult?.error || !authUser?.id) {
    throw new AppError(401, "Debes volver a autenticarte antes de confirmar la eliminación.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_INVALID",
    });
  }

  const authUserId = String(authUser.id || "").trim();
  if (authUserId !== String(expectedUserId || "").trim()) {
    throw new AppError(403, "La reautenticación no corresponde a la cuenta actual.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_SUBJECT_MISMATCH",
    });
  }

  const payload = decodeJwtPayload(token);
  const issuedAt = Number(payload?.iat);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw new AppError(401, "Debes volver a autenticarte antes de confirmar la eliminación.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_INVALID",
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAt - nowSeconds > REAUTH_FUTURE_TOLERANCE_SECONDS) {
    throw new AppError(401, "Debes volver a autenticarte antes de confirmar la eliminación.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_INVALID",
    });
  }
  if (nowSeconds - issuedAt > REAUTH_MAX_AGE_SECONDS) {
    throw new AppError(401, "La reautenticación expiró. Vuelve a confirmar tu identidad.", {
      code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED",
    });
  }

  return {
    authUserId,
    authenticatedAt: new Date(issuedAt * 1000).toISOString(),
  };
}

const ADMIN_ACCOUNT_DELETION_READ_ROLES = ["admin", "root", "security_admin", "security_auditor", "super_admin"];
const ADMIN_ACCOUNT_DELETION_APPROVAL_PHRASE = "APROBAR ELIMINACION DE CUENTA";
const ADMIN_ACCOUNT_DELETION_ROLE_RANK = {
  cliente: 0,
  barbero: 20,
  security_auditor: 30,
  admin: 50,
  security_admin: 80,
  super_admin: 90,
  root: 100,
};
const ADMIN_ACCOUNT_DELETION_STATUS_VALUES = [
  "pendiente_aprobacion",
  "aprobada",
  "rechazada",
  "procesando",
  "storage_pendiente",
  "auth_pendiente",
  "completada",
  "fallida",
  "cancelada",
  "evaluada",
  "bloqueada",
  "pendiente_confirmacion",
];
const ADMIN_TECHNICAL_RETRY_STATES = ["procesando", "storage_pendiente", "auth_pendiente"];
const ADMIN_INTERNAL_RETRY_STATES = ["aprobada", ...ADMIN_TECHNICAL_RETRY_STATES, "completada"];
const ADMIN_CLIENT_RETRY_STATES = [...ADMIN_TECHNICAL_RETRY_STATES, "completada"];

function mapAdminSerializationConflict(error) {
  if (String(error?.code || "").trim() !== "40001") return error;
  return new AppError(409, "La solicitud cambio durante el procesamiento. Intenta nuevamente.", {
    code: "ADMIN_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED",
  });
}

function sanitizeAdminComment(value, { required = false, min = 0 } = {}) {
  const comment = String(value || "").trim().replace(/\s+/g, " ");
  if (required && comment.length < min) {
    throw new AppError(400, "Debes indicar un motivo claro.", {
      code: "ADMIN_ACCOUNT_DELETION_COMMENT_REQUIRED",
    });
  }
  if (comment.length > 500) {
    throw new AppError(400, "El comentario excede la longitud permitida.", {
      code: "ADMIN_ACCOUNT_DELETION_COMMENT_TOO_LONG",
    });
  }
  return comment || null;
}

export function validateAdminAccountDeletionApprovalBody(body = {}) {
  if (String(body?.confirmation_phrase ?? "") !== ADMIN_ACCOUNT_DELETION_APPROVAL_PHRASE) {
    throw new AppError(400, "Debes escribir exactamente APROBAR ELIMINACION DE CUENTA para continuar.", {
      code: "ADMIN_ACCOUNT_DELETION_CONFIRMATION_PHRASE_INVALID",
    });
  }
  if (body?.acknowledge_irreversible_action !== true) {
    throw new AppError(400, "Debes aceptar que la aprobacion es irreversible.", {
      code: "ADMIN_ACCOUNT_DELETION_ACKNOWLEDGEMENT_REQUIRED",
    });
  }
  sanitizeAdminComment(body?.comment, { required: false });
}

export function validateAdminAccountDeletionRejectBody(body = {}) {
  sanitizeAdminComment(body?.comment, { required: true, min: 10 });
}

function getHighestRoleRank(roles = []) {
  return normalizeStringList(roles).reduce((max, role) => Math.max(max, ADMIN_ACCOUNT_DELETION_ROLE_RANK[role] ?? 0), 0);
}

function getAdminActorContext(request = {}) {
  const roles = uniqueStringList(request.claims?.roles || request.auth?.roles || []);
  return {
    usuarioId: request.claims?.user?.id_usuario || request.auth?.sub || null,
    personaId: request.claims?.user?.id_persona || null,
    roles,
    highestRank: getHighestRoleRank(roles),
  };
}

function serializeAdminRequestRow(row) {
  if (!row) return null;
  return {
    id_solicitud: row.id_solicitud ?? null,
    referencia_publica: row.referencia_publica ?? null,
    tipo_sujeto: row.tipo_sujeto ?? null,
    estado_codigo: row.estado_codigo ?? null,
    requiere_aprobacion: row.requiere_aprobacion === true,
    solicitado_at: toIsoString(row.solicitado_at),
    decision_codigo: row.decision_codigo ?? null,
    decision_at: toIsoString(row.decision_at),
    comentario_decision: row.comentario_decision ?? null,
    procesando_at: toIsoString(row.procesando_at),
    completado_at: toIsoString(row.completado_at),
  };
}

function genericDeletedDisplayName(row) {
  if (row?.estado_codigo !== "completada") return null;
  if (row?.tipo_sujeto === "cliente") return "Cliente eliminado";
  if (row?.tipo_sujeto === "personal") return "Empleado eliminado";
  return null;
}

function buildDisplayName(row) {
  const generic = genericDeletedDisplayName(row);
  if (generic) return generic;
  const fullName = [row?.nombres, row?.apellidos].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  if (fullName) return fullName;
  return row?.tipo_sujeto === "cliente" ? "Cliente eliminado" : "Empleado eliminado";
}

function parseAdminPagination(query = {}) {
  const page = Math.max(1, Number.parseInt(String(query.page || "1"), 10) || 1);
  const requestedLimit = Number.parseInt(String(query.limit || "20"), 10) || 20;
  const limit = [10, 20, 30, 50].includes(requestedLimit) ? requestedLimit : 20;
  return { page, limit, offset: (page - 1) * limit };
}

function normalizeAdminFilters(query = {}) {
  const subject = ["all", "cliente", "personal"].includes(String(query.subject || "all")) ? String(query.subject || "all") : "all";
  const status = ["all", ...ADMIN_ACCOUNT_DELETION_STATUS_VALUES].includes(String(query.status || "all")) ? String(query.status || "all") : "all";
  return {
    subject,
    status,
    search: String(query.search || "").trim().slice(0, 120),
    ...parseAdminPagination(query),
  };
}

function buildAdminDependencySummary(row) {
  const impact = normalizeJsonObject(row?.resumen_impacto, {}) || {};
  const personal = normalizeJsonObject(impact.personal_request, {}) || {};
  const internal = normalizeJsonObject(impact.internal_execution, {}) || {};
  return {
    future_operational_appointments: toNumber(row?.future_operational_appointments ?? personal.future_operational_appointments, 0),
    active_employee_service_rates: toNumber(row?.active_employee_service_rates ?? personal.employee_service_rates, 0),
    active_promotion_references: toNumber(row?.active_promotion_references ?? personal.promotion_references, 0),
    storage_assets_pending: toNumber(internal.storage_assets_pending, 0),
  };
}

function buildTechnicalInfo(row) {
  const estado = String(row?.estado_codigo || "");
  return {
    retryable: ADMIN_TECHNICAL_RETRY_STATES.includes(estado) || estado === "fallida",
    error_code: row?.error_codigo ?? null,
    last_attempt_at: toIsoString(row?.fallido_at || row?.updated_at || row?.procesando_at),
  };
}

function sanitizeAdminBlockingReasons(reasons) {
  return sanitizeBlockingReasons(reasons).map((reason) => ({
    code: reason.code,
    message: reason.message,
  }));
}

async function loadAdminRequestBase(client, requestId, { forUpdate = false } = {}) {
  const result = await client.query(
    `
      SELECT
        s.id_solicitud,
        s.referencia_publica,
        s.tipo_sujeto,
        s.id_persona,
        s.id_usuario,
        s.id_cliente,
        s.id_empleado,
        s.modo_proceso,
        s.requiere_aprobacion,
        s.origen_codigo,
        s.estado_codigo,
        s.resumen_impacto,
        s.bloqueos_detectados,
        s.decision_codigo,
        s.decision_por,
        s.decision_at,
        s.comentario_decision,
        s.reautenticado_at,
        s.request_id,
        s.error_codigo,
        s.solicitado_at,
        s.procesando_at,
        s.completado_at,
        s.cancelado_at,
        s.fallido_at,
        s.created_at,
        s.updated_at,
        p.nombres,
        p.apellidos,
        u.estado AS usuario_estado,
        u.estado_acceso,
        u.deleted_at AS usuario_deleted_at,
        e.estado AS empleado_estado,
        e.deleted_at AS empleado_deleted_at,
        COALESCE(roles.roles, ARRAY[]::text[]) AS active_roles,
        COALESCE(branches.branches, ARRAY[]::text[]) AS branch_labels
      FROM app_private.solicitudes_eliminacion_cuenta s
      LEFT JOIN public.personas p ON p.id_persona = s.id_persona
      LEFT JOIN public.usuarios u ON u.id_usuario = s.id_usuario
      LEFT JOIN public.empleados e ON e.id_empleado = s.id_empleado
      LEFT JOIN LATERAL (
        SELECT COALESCE(array_agg(DISTINCT r.nombre ORDER BY r.nombre), ARRAY[]::text[]) AS roles
        FROM public.roles_usuarios ru
        JOIN public.roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = s.id_usuario
          AND ru.activo IS TRUE
      ) roles ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(array_agg(DISTINCT su.nombre ORDER BY su.nombre), ARRAY[]::text[]) AS branches
        FROM public.empleados ee
        LEFT JOIN public.sucursales su ON su.id_sucursal = ee.id_sucursal
        WHERE ee.id_persona = s.id_persona
      ) branches ON TRUE
      WHERE s.id_solicitud = $1::uuid
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF s" : ""}
    `,
    [requestId]
  );
  return result.rows?.[0] || null;
}

async function isAdminProtectedAccount(client, usuarioId) {
  if (!usuarioId) return false;
  const result = await client.query(
    `
      SELECT 1
      FROM public.app_protected_users
      WHERE id_usuario = $1::uuid
        AND activo IS TRUE
      LIMIT 1
    `,
    [usuarioId]
  );
  return result.rowCount > 0;
}

function computeAdminPermissions(row, actor, { protectedAccount = false } = {}) {
  const estado = String(row?.estado_codigo || "");
  const subjectRoles = normalizeStringList(row?.active_roles);
  const subjectHighestRank = getHighestRoleRank(subjectRoles);
  const actorRoles = normalizeStringList(actor?.roles);
  let reasonCode = null;
  const readOnly = actorRoles.includes("security_auditor") && actorRoles.every((role) => role === "security_auditor");
  const isSelf = String(row?.id_usuario || "") && String(row?.id_usuario) === String(actor?.usuarioId || "");
  const protectedByRole = subjectRoles.some((role) => INTERNAL_PROTECTED_ROLES.includes(role));

  if (readOnly) reasonCode = "ADMIN_ACCOUNT_DELETION_AUDITOR_READ_ONLY";
  else if (isSelf) reasonCode = "ADMIN_ACCOUNT_DELETION_SELF_DECISION_FORBIDDEN";
  else if (protectedByRole || protectedAccount) reasonCode = "ADMIN_ACCOUNT_DELETION_PROTECTED_ACCOUNT";
  else if (Number(actor?.highestRank || 0) <= subjectHighestRank) reasonCode = "ADMIN_ACCOUNT_DELETION_INSUFFICIENT_RANK";

  const canDecide = !reasonCode && estado === "pendiente_aprobacion";
  const canRetry = !reasonCode
    && (
      row?.tipo_sujeto === "personal"
        ? ADMIN_INTERNAL_RETRY_STATES.includes(estado)
        : ADMIN_CLIENT_RETRY_STATES.includes(estado)
    );

  return {
    can_approve: canDecide && row?.tipo_sujeto === "personal",
    can_reject: canDecide && row?.tipo_sujeto === "personal",
    can_retry: canRetry,
    reason_code: reasonCode,
  };
}

async function loadEmployeeIdsForPerson(client, personaId) {
  const result = await client.query(
    `
      SELECT id_empleado
      FROM public.empleados
      WHERE id_persona = $1::uuid
      ORDER BY created_at ASC NULLS LAST, id_empleado ASC
    `,
    [personaId]
  );
  return result.rows.map((row) => row.id_empleado).filter(Boolean);
}

export async function evaluateAdminInternalAccountDeletionDependencies(client, {
  deletionRequestId,
  personaId,
  usuarioId,
  empleadoId,
} = {}) {
  void deletionRequestId;
  void usuarioId;
  const employeeIds = await loadEmployeeIdsForPerson(client, personaId);
  if (empleadoId && !employeeIds.map(String).includes(String(empleadoId))) {
    employeeIds.push(empleadoId);
  }
  if (!employeeIds.length) {
    return {
      future_operational_appointments: 0,
      active_weekly_schedules: 0,
      future_agenda_blocks: 0,
      public_barber_profiles: 0,
      active_employee_service_rates: 0,
      active_promotion_references: 0,
      blocking_reasons: [],
      employee_ids: [],
    };
  }

  const { rows } = await client.query(
    `
      WITH employee_ids AS (
        SELECT unnest($1::uuid[]) AS id_empleado
      ),
      future_citas AS (
        SELECT COUNT(*)::int AS count
        FROM public.citas c
        JOIN employee_ids e ON e.id_empleado = c.id_empleado_barbero
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= NOW()
          AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
      ),
      weekly_schedules AS (
        SELECT COUNT(*)::int AS count
        FROM public.horarios_semanales_empleados h
        JOIN employee_ids e ON e.id_empleado = h.id_empleado
        WHERE h.activo IS TRUE
      ),
      agenda_blocks AS (
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT abe.id_bloqueo_empleado::text AS id
          FROM public.agenda_bloqueos_empleados abe
          JOIN employee_ids e ON e.id_empleado = abe.id_empleado
          UNION
          SELECT ba.id_bloqueo::text AS id
          FROM public.bloqueos_agenda ba
          JOIN employee_ids e ON e.id_empleado = ba.id_empleado
        ) src
      ),
      public_profiles AS (
        SELECT COUNT(*)::int AS count
        FROM public.barberos_perfiles_publicos p
        JOIN employee_ids e ON e.id_empleado = p.id_empleado
        WHERE p.deleted_at IS NULL
          AND p.visible_en_landing IS TRUE
      ),
      service_rates AS (
        SELECT COUNT(*)::int AS count
        FROM public.servicios_tarifas st
        JOIN employee_ids e ON e.id_empleado = st.id_empleado
        WHERE st.activo IS TRUE
          AND st.deleted_at IS NULL
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      ),
      promotion_cupos AS (
        SELECT COUNT(*)::int AS count
        FROM public.promociones_reglas_cupos prc
        JOIN employee_ids e ON e.id_empleado = prc.id_empleado_barbero
        WHERE COALESCE(prc.activo, TRUE) IS TRUE
      ),
      promotion_restrictions AS (
        SELECT COUNT(*)::int AS count
        FROM public.promociones_restricciones_agendamiento pra
        JOIN employee_ids e ON e.id_empleado = pra.id_empleado_barbero
        WHERE (pra.vigencia_desde IS NULL OR pra.vigencia_desde <= CURRENT_DATE)
          AND (pra.vigencia_hasta IS NULL OR pra.vigencia_hasta >= CURRENT_DATE)
      )
      SELECT
        COALESCE((SELECT count FROM future_citas), 0) AS future_operational_appointments,
        COALESCE((SELECT count FROM weekly_schedules), 0) AS active_weekly_schedules,
        COALESCE((SELECT count FROM agenda_blocks), 0) AS future_agenda_blocks,
        COALESCE((SELECT count FROM public_profiles), 0) AS public_barber_profiles,
        COALESCE((SELECT count FROM service_rates), 0) AS active_employee_service_rates,
        COALESCE((SELECT count FROM promotion_cupos), 0) + COALESCE((SELECT count FROM promotion_restrictions), 0) AS active_promotion_references
    `,
    [employeeIds]
  );
  const row = rows?.[0] || {};
  const dependencies = {
    future_operational_appointments: toNumber(row.future_operational_appointments, 0),
    active_weekly_schedules: toNumber(row.active_weekly_schedules, 0),
    future_agenda_blocks: toNumber(row.future_agenda_blocks, 0),
    public_barber_profiles: toNumber(row.public_barber_profiles, 0),
    active_employee_service_rates: toNumber(row.active_employee_service_rates, 0),
    active_promotion_references: toNumber(row.active_promotion_references, 0),
    employee_ids: employeeIds,
  };
  const blockingReasons = [];
  if (dependencies.future_operational_appointments > 0) {
    blockingReasons.push({
      code: "INTERNAL_ACCOUNT_DELETION_FUTURE_APPOINTMENTS_PENDING",
      message: "Existen citas futuras que deben reasignarse o resolverse antes de aprobar.",
    });
  }
  if (dependencies.active_employee_service_rates > 0) {
    blockingReasons.push({
      code: "INTERNAL_ACCOUNT_DELETION_ACTIVE_SERVICE_RATES",
      message: "Existen tarifas activas asociadas con el empleado que deben resolverse.",
    });
  }
  if (dependencies.active_promotion_references > 0) {
    blockingReasons.push({
      code: "INTERNAL_ACCOUNT_DELETION_ACTIVE_PROMOTION_REFERENCES",
      message: "Existen promociones activas asociadas con el empleado que deben resolverse.",
    });
  }
  return {
    ...dependencies,
    blocking_reasons: blockingReasons,
  };
}

export async function listAdminAccountDeletionRequests(app, query = {}) {
  const client = await app.db.connect();
  try {
    const filters = normalizeAdminFilters(query);
    const where = [];
    const params = [];
    if (filters.subject !== "all") {
      params.push(filters.subject);
      where.push(`s.tipo_sujeto = $${params.length}::text`);
    }
    if (filters.status !== "all") {
      params.push(filters.status);
      where.push(`s.estado_codigo = $${params.length}::text`);
    }
    if (filters.search) {
      params.push(`%${filters.search.toLowerCase()}%`);
      where.push(`(lower(s.referencia_publica) LIKE $${params.length}::text OR lower(COALESCE(p.nombres, '') || ' ' || COALESCE(p.apellidos, '')) LIKE $${params.length}::text)`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countResult = await client.query(
      `
        SELECT COUNT(*)::int AS total
        FROM app_private.solicitudes_eliminacion_cuenta s
        LEFT JOIN public.personas p ON p.id_persona = s.id_persona
        ${whereSql}
      `,
      params
    );
    const total = toNumber(countResult.rows?.[0]?.total, 0);
    const listParams = [...params, filters.limit, filters.offset];
    const itemsResult = await client.query(
      `
        SELECT
          s.id_solicitud,
          s.referencia_publica,
          s.tipo_sujeto,
          s.estado_codigo,
          s.requiere_aprobacion,
          s.solicitado_at,
          s.decision_at,
          s.completado_at,
          s.resumen_impacto,
          p.nombres,
          p.apellidos,
          COALESCE(roles.roles, ARRAY[]::text[]) AS role_labels,
          COALESCE(branches.branches, ARRAY[]::text[]) AS branch_labels
        FROM app_private.solicitudes_eliminacion_cuenta s
        LEFT JOIN public.personas p ON p.id_persona = s.id_persona
        LEFT JOIN LATERAL (
          SELECT COALESCE(array_agg(DISTINCT r.nombre ORDER BY r.nombre), ARRAY[]::text[]) AS roles
          FROM public.roles_usuarios ru
          JOIN public.roles r ON r.id_rol = ru.id_rol
          WHERE ru.id_usuario = s.id_usuario
            AND ru.activo IS TRUE
        ) roles ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(array_agg(DISTINCT su.nombre ORDER BY su.nombre), ARRAY[]::text[]) AS branches
          FROM public.empleados ee
          LEFT JOIN public.sucursales su ON su.id_sucursal = ee.id_sucursal
          WHERE ee.id_persona = s.id_persona
        ) branches ON TRUE
        ${whereSql}
        ORDER BY s.solicitado_at DESC NULLS LAST, s.created_at DESC NULLS LAST
        LIMIT $${listParams.length - 1}::int OFFSET $${listParams.length}::int
      `,
      listParams
    );
    const summaryResult = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE tipo_sujeto = 'personal' AND estado_codigo = 'pendiente_aprobacion')::int AS personal_pending_approval,
        COUNT(*) FILTER (WHERE estado_codigo IN ('procesando', 'storage_pendiente', 'auth_pendiente'))::int AS technical_pending,
        COUNT(*) FILTER (WHERE estado_codigo = 'completada')::int AS completed,
        COUNT(*) FILTER (WHERE estado_codigo = 'rechazada')::int AS rejected
      FROM app_private.solicitudes_eliminacion_cuenta
    `);

    return {
      items: itemsResult.rows.map((row) => ({
        id_solicitud: row.id_solicitud,
        referencia_publica: row.referencia_publica,
        tipo_sujeto: row.tipo_sujeto,
        estado_codigo: row.estado_codigo,
        requiere_aprobacion: row.requiere_aprobacion === true,
        display_name: buildDisplayName(row),
        role_labels: normalizeStringList(row.role_labels),
        branch_labels: normalizeStringList(row.branch_labels),
        solicitado_at: toIsoString(row.solicitado_at),
        decision_at: toIsoString(row.decision_at),
        completado_at: toIsoString(row.completado_at),
        dependency_summary: buildAdminDependencySummary(row),
        technical_pending: ADMIN_TECHNICAL_RETRY_STATES.includes(String(row.estado_codigo || "")),
      })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / filters.limit)),
      },
      summary: {
        personal_pending_approval: toNumber(summaryResult.rows?.[0]?.personal_pending_approval, 0),
        technical_pending: toNumber(summaryResult.rows?.[0]?.technical_pending, 0),
        completed: toNumber(summaryResult.rows?.[0]?.completed, 0),
        rejected: toNumber(summaryResult.rows?.[0]?.rejected, 0),
      },
    };
  } finally {
    client.release();
  }
}

export async function getAdminAccountDeletionRequestDetail(app, {
  requestId,
  actor,
} = {}) {
  const client = await app.db.connect();
  try {
    const row = await loadAdminRequestBase(client, requestId);
    if (!row) {
      throw new AppError(404, "Solicitud no encontrada.", {
        code: "ADMIN_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
      });
    }
    const dependencies = row.tipo_sujeto === "personal"
      ? await evaluateAdminInternalAccountDeletionDependencies(client, {
        deletionRequestId: row.id_solicitud,
        personaId: row.id_persona,
        usuarioId: row.id_usuario,
        empleadoId: row.id_empleado,
      })
      : {
        future_operational_appointments: 0,
        active_weekly_schedules: 0,
        future_agenda_blocks: 0,
        public_barber_profiles: 0,
        active_employee_service_rates: 0,
        active_promotion_references: 0,
        blocking_reasons: [],
      };
    const protectedAccount = await isAdminProtectedAccount(client, row.id_usuario);
    const permissions = computeAdminPermissions(row, actor, { protectedAccount });
    return {
      request: serializeAdminRequestRow(row),
      subject: {
        display_name: buildDisplayName(row),
        active_roles: normalizeStringList(row.active_roles),
        branches: normalizeStringList(row.branch_labels),
        account_active: row.usuario_estado === true && !row.usuario_deleted_at,
        employee_active: row.empleado_estado === true && !row.empleado_deleted_at,
      },
      dependencies: {
        future_operational_appointments: toNumber(dependencies.future_operational_appointments, 0),
        active_weekly_schedules: toNumber(dependencies.active_weekly_schedules, 0),
        future_agenda_blocks: toNumber(dependencies.future_agenda_blocks, 0),
        public_barber_profiles: toNumber(dependencies.public_barber_profiles, 0),
        active_employee_service_rates: toNumber(dependencies.active_employee_service_rates, 0),
        active_promotion_references: toNumber(dependencies.active_promotion_references, 0),
      },
      blocking_reasons: sanitizeAdminBlockingReasons(dependencies.blocking_reasons),
      technical: buildTechnicalInfo(row),
      permissions,
    };
  } finally {
    client.release();
  }
}

export async function verifyRecentAdminAccountDeletionReauthentication(app, {
  reauthToken,
  expectedUserId,
} = {}) {
  try {
    return await verifyRecentInternalAccountDeletionReauthentication(app, {
      reauthToken,
      expectedUserId,
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const codeMap = {
      INTERNAL_ACCOUNT_DELETION_REAUTH_REQUIRED: "ADMIN_ACCOUNT_DELETION_REAUTH_REQUIRED",
      INTERNAL_ACCOUNT_DELETION_REAUTH_USER_MISMATCH: "ADMIN_ACCOUNT_DELETION_REAUTH_USER_MISMATCH",
      INTERNAL_ACCOUNT_DELETION_REAUTH_EXPIRED: "ADMIN_ACCOUNT_DELETION_REAUTH_EXPIRED",
    };
    throw new AppError(error.statusCode, error.message, {
      code: codeMap[error.code] || "ADMIN_ACCOUNT_DELETION_REAUTH_REQUIRED",
    });
  }
}

async function withAdminAccountDeletionTransaction(app, callback) {
  const client = await app.db.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const result = await callback(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva el motivo funcional.
      }
    }
    throw mapAdminSerializationConflict(error);
  } finally {
    client.release();
  }
}

function assertAdminCanDecide(row, permissions) {
  if (permissions?.can_approve || permissions?.can_reject) return;
  throw new AppError(403, "No tienes permisos para decidir esta solicitud.", {
    code: permissions?.reason_code || "ADMIN_ACCOUNT_DELETION_DECISION_FORBIDDEN",
    details: { request: mapActiveRequestDetails(row) },
  });
}

function assertAdminCanRetry(row, permissions) {
  if (permissions?.can_retry) return;
  throw new AppError(403, "No tienes permisos para reintentar esta solicitud.", {
    code: permissions?.reason_code || "ADMIN_ACCOUNT_DELETION_RETRY_FORBIDDEN",
  });
}

export async function approveAdminAccountDeletionRequest(app, {
  requestId,
  actor,
  reauthToken,
  comment,
  traceRequestId,
} = {}) {
  const cleanComment = sanitizeAdminComment(comment, { required: false });
  const approved = await withAdminAccountDeletionTransaction(app, async (client) => {
    const row = await loadAdminRequestBase(client, requestId, { forUpdate: true });
    if (!row) {
      throw new AppError(404, "Solicitud no encontrada.", {
        code: "ADMIN_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
      });
    }
    await acquireAccountDeletionUserLock(client, row.id_usuario);
    const protectedAccount = await isAdminProtectedAccount(client, row.id_usuario);
    const permissions = computeAdminPermissions(row, actor, { protectedAccount });
    assertAdminCanDecide(row, permissions);
    if (row.tipo_sujeto !== "personal" || row.modo_proceso !== "requiere_aprobacion" || row.requiere_aprobacion !== true) {
      throw new AppError(409, "Solo se pueden aprobar solicitudes de personal.", {
        code: "ADMIN_ACCOUNT_DELETION_ONLY_PERSONAL_CAN_BE_APPROVED",
      });
    }
    if (row.estado_codigo !== "pendiente_aprobacion" || row.decision_codigo) {
      throw new AppError(409, "La solicitud ya tiene una decision administrativa.", {
        code: "ADMIN_ACCOUNT_DELETION_DECISION_ALREADY_TAKEN",
      });
    }
    const dependencies = await evaluateAdminInternalAccountDeletionDependencies(client, {
      deletionRequestId: row.id_solicitud,
      personaId: row.id_persona,
      usuarioId: row.id_usuario,
      empleadoId: row.id_empleado,
    });
    if (dependencies.blocking_reasons.length > 0) {
      await client.query(
        `
          UPDATE app_private.solicitudes_eliminacion_cuenta
          SET bloqueos_detectados = $2::jsonb,
              request_id = $3::text,
              updated_at = NOW()
          WHERE id_solicitud = $1::uuid
        `,
        [row.id_solicitud, JSON.stringify(sanitizeAdminBlockingReasons(dependencies.blocking_reasons)), traceRequestId]
      );
      throw new AppError(409, "Existen dependencias que deben resolverse antes de aprobar.", {
        code: dependencies.blocking_reasons[0].code,
        details: { blocking_reasons: sanitizeAdminBlockingReasons(dependencies.blocking_reasons) },
      });
    }
    await verifyRecentAdminAccountDeletionReauthentication(app, {
      reauthToken,
      expectedUserId: actor.usuarioId,
    });
    const updated = await client.query(
      `
        UPDATE app_private.solicitudes_eliminacion_cuenta
        SET estado_codigo = 'aprobada',
            decision_codigo = 'aprobada',
            decision_por = $2::uuid,
            decision_at = NOW(),
            comentario_decision = $3::text,
            bloqueos_detectados = '[]'::jsonb,
            error_codigo = NULL,
            error_detalle_tecnico = NULL,
            request_id = $4::text,
            updated_at = NOW()
        WHERE id_solicitud = $1::uuid
        RETURNING id_solicitud, referencia_publica, estado_codigo, decision_codigo, decision_at, solicitado_at, requiere_aprobacion
      `,
      [row.id_solicitud, actor.usuarioId, cleanComment, traceRequestId]
    );
    return updated.rows?.[0];
  });

  const execution = await orchestrateApprovedInternalAccountDeletion(app, {
    deletionRequestId: approved.id_solicitud,
    actorUsuarioId: actor.usuarioId,
    traceRequestId,
  });
  return {
    approved: true,
    request: serializeAdminRequestRow({ ...approved, ...execution?.request }),
    execution,
  };
}

export async function rejectAdminAccountDeletionRequest(app, {
  requestId,
  actor,
  comment,
  traceRequestId,
} = {}) {
  const cleanComment = sanitizeAdminComment(comment, { required: true, min: 10 });
  return withAdminAccountDeletionTransaction(app, async (client) => {
    const row = await loadAdminRequestBase(client, requestId, { forUpdate: true });
    if (!row) {
      throw new AppError(404, "Solicitud no encontrada.", {
        code: "ADMIN_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
      });
    }
    await acquireAccountDeletionUserLock(client, row.id_usuario);
    const protectedAccount = await isAdminProtectedAccount(client, row.id_usuario);
    const permissions = computeAdminPermissions(row, actor, { protectedAccount });
    assertAdminCanDecide(row, permissions);
    if (row.tipo_sujeto !== "personal") {
      throw new AppError(409, "Solo se pueden rechazar solicitudes de personal pendientes.", {
        code: "ADMIN_ACCOUNT_DELETION_ONLY_PERSONAL_CAN_BE_REJECTED",
      });
    }
    if (row.estado_codigo === "rechazada") {
      return {
        rejected: true,
        idempotent_replay: true,
        request: serializeAdminRequestRow(row),
      };
    }
    if (row.estado_codigo !== "pendiente_aprobacion" || row.decision_codigo || row.decision_at) {
      throw new AppError(409, "La solicitud ya tiene una decision administrativa.", {
        code: "ADMIN_ACCOUNT_DELETION_DECISION_ALREADY_TAKEN",
      });
    }
    const updated = await client.query(
      `
        UPDATE app_private.solicitudes_eliminacion_cuenta
        SET estado_codigo = 'rechazada',
            decision_codigo = 'rechazada',
            decision_por = $2::uuid,
            decision_at = NOW(),
            comentario_decision = $3::text,
            request_id = $4::text,
            updated_at = NOW()
        WHERE id_solicitud = $1::uuid
        RETURNING id_solicitud, referencia_publica, tipo_sujeto, estado_codigo, requiere_aprobacion, solicitado_at, decision_codigo, decision_at, comentario_decision
      `,
      [row.id_solicitud, actor.usuarioId, cleanComment, traceRequestId]
    );
    return {
      rejected: true,
      idempotent_replay: false,
      request: serializeAdminRequestRow(updated.rows?.[0]),
    };
  });
}

async function loadApprovedInternalExecutionRequest(client, deletionRequestId, expectedState) {
  const row = await loadAdminRequestBase(client, deletionRequestId, { forUpdate: true });
  if (!row) {
    throw new AppError(404, "Solicitud no encontrada.", {
      code: "ADMIN_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
    });
  }
  if (row.tipo_sujeto !== "personal" || row.decision_codigo !== "aprobada" || !row.decision_at || !row.decision_por) {
    throw new AppError(409, "La solicitud no tiene una aprobacion administrativa valida.", {
      code: "ADMIN_ACCOUNT_DELETION_APPROVAL_REQUIRED",
    });
  }
  if (expectedState && row.estado_codigo !== expectedState) {
    throw new AppError(409, "La solicitud no se encuentra en el estado esperado.", {
      code: "ADMIN_ACCOUNT_DELETION_STATE_INVALID",
      details: mapActiveRequestDetails(row),
    });
  }
  return row;
}

function mergeAdminInternalSummary(resumenImpacto, key, value) {
  return {
    ...normalizeJsonObject(resumenImpacto, {}),
    [key]: {
      ...(normalizeJsonObject(normalizeJsonObject(resumenImpacto, {})?.[key], {}) || {}),
      ...value,
    },
  };
}

export async function executeApprovedInternalAccountDeletionInternal(client, {
  deletionRequestId,
  actorUsuarioId,
  traceRequestId,
} = {}) {
  const row = await loadApprovedInternalExecutionRequest(client, deletionRequestId, "aprobada");
  await acquireAccountDeletionUserLock(client, row.id_usuario);
  const dependencies = await evaluateAdminInternalAccountDeletionDependencies(client, {
    deletionRequestId: row.id_solicitud,
    personaId: row.id_persona,
    usuarioId: row.id_usuario,
    empleadoId: row.id_empleado,
  });
  if (dependencies.blocking_reasons.length > 0) {
    await client.query(
      `
        UPDATE app_private.solicitudes_eliminacion_cuenta
        SET bloqueos_detectados = $2::jsonb,
            error_codigo = 'ADMIN_ACCOUNT_DELETION_DEPENDENCIES_REAPPEARED',
            error_detalle_tecnico = NULL,
            request_id = $3::text,
            updated_at = NOW()
        WHERE id_solicitud = $1::uuid
      `,
      [row.id_solicitud, JSON.stringify(sanitizeAdminBlockingReasons(dependencies.blocking_reasons)), traceRequestId]
    );
    throw new AppError(409, "Reaparecieron dependencias que deben resolverse antes de ejecutar.", {
      code: "ADMIN_ACCOUNT_DELETION_DEPENDENCIES_REAPPEARED",
      details: { blocking_reasons: sanitizeAdminBlockingReasons(dependencies.blocking_reasons) },
    });
  }

  const employeeIds = dependencies.employee_ids || [];
  const storageResult = await client.query(
    `
      SELECT COALESCE(array_agg(DISTINCT sa.id_asset ORDER BY sa.id_asset), ARRAY[]::uuid[]) AS asset_ids
      FROM public.storage_assets sa
      LEFT JOIN public.personas p ON p.id_persona = $1::uuid
      WHERE sa.deleted_at IS NULL
        AND sa.status <> 'eliminado'
        AND (
          sa.owner_user_id = $2::uuid
          OR sa.entity_id = ANY($3::uuid[])
          OR sa.id_asset = p.foto_perfil_asset_id
        )
    `,
    [row.id_persona, row.id_usuario, [row.id_persona, row.id_usuario, ...employeeIds]]
  );
  const storageAssetIds = storageResult.rows?.[0]?.asset_ids || [];

  await client.query(
    `
      UPDATE public.empleados
      SET estado = FALSE,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_persona = $1::uuid
    `,
    [row.id_persona]
  );
  await client.query(
    `
      UPDATE public.horarios_semanales_empleados
      SET activo = FALSE,
          updated_at = NOW()
      WHERE id_empleado = ANY($1::uuid[])
    `,
    [employeeIds]
  );
  await client.query(
    `
      UPDATE public.barberos_perfiles_publicos
      SET visible_en_landing = FALSE,
          alias_publico = NULL,
          resumen_publico = NULL,
          certificaciones_titulos = ARRAY[]::text[],
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_empleado = ANY($1::uuid[])
    `,
    [employeeIds]
  );
  await client.query(
    "UPDATE public.agenda_bloqueos_empleados SET motivo = NULL, updated_at = NOW() WHERE id_empleado = ANY($1::uuid[])",
    [employeeIds]
  );
  await client.query(
    "UPDATE public.bloqueos_agenda SET motivo = NULL, updated_at = NOW() WHERE id_empleado = ANY($1::uuid[])",
    [employeeIds]
  );
  await client.query("UPDATE public.roles_usuarios SET activo = FALSE, updated_at = NOW() WHERE id_usuario = $1::uuid", [row.id_usuario]);
  await client.query(
    `
      UPDATE public.seguridad_sesiones
      SET estado = 'revocada',
          revocada_at = NOW(),
          cierre_at = COALESCE(cierre_at, NOW()),
          cerrada_por = $2::uuid,
          motivo_cierre = 'eliminacion_cuenta',
          request_id = $3::text
      WHERE id_usuario = $1::uuid
        AND estado = 'activa'
    `,
    [row.id_usuario, actorUsuarioId, traceRequestId]
  );
  await client.query(
    `
      UPDATE public.usuarios
      SET estado = FALSE,
          estado_acceso = 'inactivo',
          password_hash = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
    `,
    [row.id_usuario]
  );

  const summary = mergeAdminInternalSummary(row.resumen_impacto, "internal_execution", {
    processed_at: new Date().toISOString(),
    employee_ids_count: employeeIds.length,
    storage_asset_ids: storageAssetIds,
    storage_assets_pending: storageAssetIds.length,
    employees_deactivated: true,
    roles_disabled: true,
    sessions_revoked: true,
    user_disabled: true,
  });
  const updated = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'procesando',
          procesando_at = COALESCE(procesando_at, NOW()),
          auth_user_id_pendiente = $2::uuid,
          resumen_impacto = $3::jsonb,
          bloqueos_detectados = '[]'::jsonb,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          request_id = $4::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo, procesando_at
    `,
    [row.id_solicitud, row.id_usuario, JSON.stringify(summary), traceRequestId]
  );
  return {
    processed: true,
    request: updated.rows?.[0],
    storage_asset_ids: storageAssetIds,
  };
}

export async function runApprovedInternalAccountDeletionInternal(app, {
  deletionRequestId,
  actorUsuarioId,
  traceRequestId,
} = {}) {
  return withAdminAccountDeletionTransaction(app, (client) => executeApprovedInternalAccountDeletionInternal(client, {
    deletionRequestId,
    actorUsuarioId,
    traceRequestId,
  }));
}

export async function anonymizeApprovedInternalAccountDeletion(client, {
  deletionRequestId,
  traceRequestId,
} = {}) {
  const row = await loadApprovedInternalExecutionRequest(client, deletionRequestId, "procesando");
  const emails = await client.query(
    "SELECT id_correo, direccion_correo FROM public.correos WHERE id_persona = $1::uuid AND direccion_correo IS NOT NULL",
    [row.id_persona]
  );
  const tombstonePrefix = String(row.id_solicitud).replace(/-/g, "").slice(0, 16);
  for (const emailRow of emails.rows || []) {
    await client.query(
      `
        UPDATE public.correos
        SET direccion_correo = $2::text,
            es_principal = FALSE,
            verificado = FALSE,
            deleted_at = COALESCE(deleted_at, NOW()),
            updated_at = NOW()
        WHERE id_correo = $1::uuid
      `,
      [emailRow.id_correo, `${tombstonePrefix}-${String(emailRow.id_correo).replace(/-/g, "").slice(0, 8)}@anon.masterfade.invalid`]
    );
  }
  await client.query(
    `
      UPDATE public.personas
      SET nombres = 'Empleado',
          apellidos = 'eliminado',
          fecha_nacimiento = NULL,
          genero_codigo = NULL,
          dni = NULL,
          rtn = NULL,
          telefono_principal = NULL,
          direccion_texto = NULL,
          observaciones = NULL,
          foto_perfil_asset_id = NULL,
          foto_perfil_path = NULL,
          updated_at = NOW()
      WHERE id_persona = $1::uuid
    `,
    [row.id_persona]
  );
  await client.query(
    `
      UPDATE public.seguridad_audit_logs
      SET ip = NULL,
          metadata = COALESCE(metadata, '{}'::jsonb) - 'email' - 'telefono' - 'dni' - 'rtn'
      WHERE id_usuario = $1::uuid
    `,
    [row.id_usuario]
  );
  await client.query(
    `
      UPDATE public.bitacoras
      SET datos_antes = NULL,
          datos_despues = NULL
      WHERE id_usuario = $1::uuid
         OR registro_id IN ($2::uuid, $3::uuid)
    `,
    [row.id_usuario, row.id_persona, row.id_empleado]
  );
  const impact = normalizeJsonObject(row.resumen_impacto, {});
  const internalExecution = normalizeJsonObject(impact.internal_execution, {}) || {};
  const storageAssetIds = Array.isArray(internalExecution.storage_asset_ids) ? internalExecution.storage_asset_ids : [];
  const nextState = storageAssetIds.length > 0 ? "storage_pendiente" : "auth_pendiente";
  const summary = mergeAdminInternalSummary(row.resumen_impacto, "internal_anonymization", {
    processed_at: new Date().toISOString(),
    pii_anonymized: true,
    emails_tombstoned: true,
    storage_asset_ids: storageAssetIds,
    storage_assets_pending: storageAssetIds.length,
  });
  const updated = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = $2::text,
          resumen_impacto = $3::jsonb,
          auth_user_id_pendiente = $4::uuid,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          request_id = $5::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo
    `,
    [row.id_solicitud, nextState, JSON.stringify(summary), row.id_usuario, traceRequestId]
  );
  return {
    anonymized: true,
    request: updated.rows?.[0],
  };
}

export async function runApprovedInternalAccountDeletionAnonymization(app, {
  deletionRequestId,
  traceRequestId,
} = {}) {
  return withAdminAccountDeletionTransaction(app, (client) => anonymizeApprovedInternalAccountDeletion(client, {
    deletionRequestId,
    traceRequestId,
  }));
}

async function loadInternalStorageRequest(client, deletionRequestId) {
  const row = await loadApprovedInternalExecutionRequest(client, deletionRequestId, "storage_pendiente");
  const impact = normalizeJsonObject(row.resumen_impacto, {});
  const internal = normalizeJsonObject(impact.internal_anonymization, {}) || normalizeJsonObject(impact.internal_execution, {}) || {};
  const assetIds = Array.isArray(internal.storage_asset_ids) ? internal.storage_asset_ids : [];
  return { row, assetIds };
}

export async function finalizeApprovedInternalAccountDeletionStorage(client, {
  deletionRequestId,
  traceRequestId,
} = {}) {
  const { row, assetIds } = await loadInternalStorageRequest(client, deletionRequestId);
  await client.query(
    `
      UPDATE public.storage_assets
      SET status = 'eliminado',
          public_url = NULL,
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW()
      WHERE id_asset = ANY($1::uuid[])
    `,
    [assetIds]
  );
  const summary = mergeAdminInternalSummary(row.resumen_impacto, "storage_cleanup", {
    processed_at: new Date().toISOString(),
    storage_processed: true,
    asset_count: assetIds.length,
  });
  const updated = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'auth_pendiente',
          resumen_impacto = $2::jsonb,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          request_id = $3::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo
    `,
    [row.id_solicitud, JSON.stringify(summary), traceRequestId]
  );
  return {
    storage_processed: true,
    request: updated.rows?.[0],
  };
}

export async function runApprovedInternalAccountDeletionStorageCleanup(app, {
  deletionRequestId,
  traceRequestId,
} = {}) {
  return withAdminAccountDeletionTransaction(app, (client) => finalizeApprovedInternalAccountDeletionStorage(client, {
    deletionRequestId,
    traceRequestId,
  }));
}

export async function finalizeApprovedInternalAccountDeletionAuthCleanup(client, {
  deletionRequestId,
  traceRequestId,
  authUserAlreadyAbsent = false,
} = {}) {
  const row = await loadApprovedInternalExecutionRequest(client, deletionRequestId, "auth_pendiente");
  const summary = mergeAdminInternalSummary(row.resumen_impacto, "auth_cleanup", {
    processed_at: new Date().toISOString(),
    auth_user_deleted: true,
    auth_user_already_absent: Boolean(authUserAlreadyAbsent),
    auth_processed: true,
  });
  const updated = await client.query(
    `
      UPDATE app_private.solicitudes_eliminacion_cuenta
      SET estado_codigo = 'completada',
          auth_user_id_pendiente = NULL,
          completado_at = COALESCE(completado_at, NOW()),
          resumen_impacto = $2::jsonb,
          error_codigo = NULL,
          error_detalle_tecnico = NULL,
          request_id = $3::text,
          updated_at = NOW()
      WHERE id_solicitud = $1::uuid
      RETURNING id_solicitud, referencia_publica, estado_codigo, completado_at
    `,
    [row.id_solicitud, JSON.stringify(summary), traceRequestId]
  );
  return {
    completed: true,
    auth_processed: true,
    request: updated.rows?.[0],
  };
}

export async function runApprovedInternalAccountDeletionAuthCleanup(app, {
  deletionRequestId,
  traceRequestId,
} = {}) {
  assertAccountDeletionAuthAvailable(app);
  const client = await app.db.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    const row = await loadApprovedInternalExecutionRequest(client, deletionRequestId, "auth_pendiente");
    await client.query("COMMIT");
    transactionStarted = false;

    const authUserId = row.auth_user_id_pendiente || row.id_usuario;
    let authUserAlreadyAbsent = false;
    try {
      const lookup = await findAuthUserById(app, authUserId);
      authUserAlreadyAbsent = !lookup.exists;
      if (lookup.exists) {
        const deleted = await deleteAuthUserById(app, authUserId);
        if (!deleted.deleted) {
          const absent = await verifyAuthUserAbsent(app, authUserId);
          if (!absent) {
            throw new AppError(503, "No fue posible completar la eliminacion de Auth. Intenta nuevamente.", {
              code: "ADMIN_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 503) {
        await withAdminAccountDeletionTransaction(app, async (failureClient) => {
          await failureClient.query(
            `
              UPDATE app_private.solicitudes_eliminacion_cuenta
              SET estado_codigo = 'auth_pendiente',
                  error_codigo = $2::text,
                  error_detalle_tecnico = NULL,
                  request_id = $3::text,
                  updated_at = NOW()
              WHERE id_solicitud = $1::uuid
            `,
            [deletionRequestId, error.code || "ADMIN_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE", traceRequestId]
          );
        });
      }
      throw error;
    }

    return withAdminAccountDeletionTransaction(app, (finalClient) => finalizeApprovedInternalAccountDeletionAuthCleanup(finalClient, {
      deletionRequestId,
      traceRequestId,
      authUserAlreadyAbsent,
    }));
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La excepcion original conserva el motivo funcional.
      }
    }
    throw mapAdminSerializationConflict(error);
  } finally {
    client.release();
  }
}

async function loadAdminOrchestrationContext(app, deletionRequestId) {
  const client = await app.db.connect();
  try {
    const row = await loadAdminRequestBase(client, deletionRequestId);
    if (!row) {
      throw new AppError(404, "Solicitud no encontrada.", {
        code: "ADMIN_ACCOUNT_DELETION_REQUEST_NOT_FOUND",
      });
    }
    return row;
  } finally {
    client.release();
  }
}

function buildAdminExecutionResponse(row, { idempotentReplay = false } = {}) {
  const completed = row?.estado_codigo === "completada";
  return withHttpStatus({
    completed,
    retryable: !completed && ADMIN_TECHNICAL_RETRY_STATES.includes(String(row?.estado_codigo || "")),
    idempotent_replay: Boolean(idempotentReplay),
    request: {
      id_solicitud: row?.id_solicitud ?? null,
      referencia_publica: row?.referencia_publica ?? null,
      estado_codigo: row?.estado_codigo ?? null,
      completado_at: toIsoString(row?.completado_at),
    },
  }, completed ? 200 : 202);
}

export async function orchestrateApprovedInternalAccountDeletion(app, {
  deletionRequestId,
  actorUsuarioId,
  traceRequestId,
  stageRunners = {},
} = {}) {
  const runInternal = stageRunners.internal || runApprovedInternalAccountDeletionInternal;
  const runAnonymization = stageRunners.anonymization || runApprovedInternalAccountDeletionAnonymization;
  const runStorage = stageRunners.storage || runApprovedInternalAccountDeletionStorageCleanup;
  const runAuth = stageRunners.auth || runApprovedInternalAccountDeletionAuthCleanup;
  let initialState = null;
  let lastContext;

  for (let iteration = 0; iteration < MAX_ACCOUNT_DELETION_ORCHESTRATION_ITERATIONS; iteration += 1) {
    lastContext = await loadAdminOrchestrationContext(app, deletionRequestId);
    if (!initialState) initialState = lastContext.estado_codigo;
    if (lastContext.tipo_sujeto !== "personal") {
      throw new AppError(409, "La solicitud no corresponde a personal.", {
        code: "ADMIN_ACCOUNT_DELETION_PERSONAL_REQUIRED",
      });
    }
    if (lastContext.estado_codigo === "completada") {
      return buildAdminExecutionResponse(lastContext, { idempotentReplay: initialState === "completada" });
    }
    if (lastContext.estado_codigo === "aprobada") {
      await runInternal(app, { deletionRequestId, actorUsuarioId, traceRequestId });
      continue;
    }
    if (lastContext.estado_codigo === "procesando") {
      await runAnonymization(app, { deletionRequestId, actorUsuarioId, traceRequestId });
      continue;
    }
    if (lastContext.estado_codigo === "storage_pendiente") {
      const result = await runStorage(app, { deletionRequestId, actorUsuarioId, traceRequestId });
      if (result?.storage_processed === false) return buildAdminExecutionResponse(lastContext);
      continue;
    }
    if (lastContext.estado_codigo === "auth_pendiente") {
      try {
        await runAuth(app, { deletionRequestId, actorUsuarioId, traceRequestId });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 503) return buildAdminExecutionResponse(lastContext);
        throw error;
      }
      continue;
    }
    throw new AppError(409, "La solicitud no se encuentra en un estado reintentable.", {
      code: "ADMIN_ACCOUNT_DELETION_RETRY_STATE_INVALID",
      details: mapActiveRequestDetails(lastContext),
    });
  }
  throw new AppError(500, "No fue posible completar correctamente el proceso de eliminacion.", {
    code: "ADMIN_ACCOUNT_DELETION_ORCHESTRATION_LIMIT_REACHED",
  });
}

export async function retryAdminAccountDeletionRequest(app, {
  requestId,
  actor,
  traceRequestId,
} = {}) {
  const row = await loadAdminOrchestrationContext(app, requestId);
  const client = await app.db.connect();
  try {
    const protectedAccount = await isAdminProtectedAccount(client, row.id_usuario);
    const permissions = computeAdminPermissions(row, actor, { protectedAccount });
    assertAdminCanRetry(row, permissions);
  } finally {
    client.release();
  }

  if (row.tipo_sujeto === "personal") {
    return orchestrateApprovedInternalAccountDeletion(app, {
      deletionRequestId: requestId,
      actorUsuarioId: actor.usuarioId,
      traceRequestId,
    });
  }

  if (row.tipo_sujeto === "cliente") {
    if (!ADMIN_CLIENT_RETRY_STATES.includes(String(row.estado_codigo || ""))) {
      throw new AppError(409, "La solicitud cliente no puede iniciarse desde este estado.", {
        code: "ADMIN_ACCOUNT_DELETION_CLIENT_RETRY_STATE_INVALID",
      });
    }
    const result = await orchestrateClientAccountDeletion(app, {
      reference: row.referencia_publica,
      executionToken: "admin-retry-bypass",
      traceRequestId,
      stageRunners: {
        internal: async () => ({ processed: true }),
      },
    }).catch(async (error) => {
      if (error instanceof AppError && error.code === "CLIENT_ACCOUNT_DELETION_EXECUTION_CREDENTIAL_INVALID") {
        if (row.estado_codigo === "procesando") {
          await runClientAccountDeletionAnonymization(app, {
            deletionRequestId: row.id_solicitud,
            clienteId: row.id_cliente,
            personaId: row.id_persona,
            usuarioId: row.id_usuario,
            traceRequestId,
          });
        } else if (row.estado_codigo === "storage_pendiente") {
          await runClientAccountDeletionStorageCleanup(app, {
            deletionRequestId: row.id_solicitud,
            clienteId: row.id_cliente,
            personaId: row.id_persona,
            usuarioId: row.id_usuario,
            traceRequestId,
          });
        } else if (row.estado_codigo === "auth_pendiente") {
          await runClientAccountDeletionAuthCleanup(app, {
            deletionRequestId: row.id_solicitud,
            clienteId: row.id_cliente,
            personaId: row.id_persona,
            usuarioId: row.id_usuario,
            traceRequestId,
          });
        }
        const next = await loadAdminOrchestrationContext(app, requestId);
        return buildAdminExecutionResponse(next);
      }
      throw error;
    });
    return result;
  }

  throw new AppError(409, "Tipo de solicitud no reintentable.", {
    code: "ADMIN_ACCOUNT_DELETION_RETRY_SUBJECT_INVALID",
  });
}

export const ADMIN_ACCOUNT_DELETION_ADMIN_ROLES = ADMIN_ACCOUNT_DELETION_READ_ROLES;
export { getAdminActorContext };
