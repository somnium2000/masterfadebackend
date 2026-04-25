import {
  buildIdentifierHash,
  buildTokenJtiHash,
  maskEmail,
  normalizeIdentifier,
} from "../utils/securityHash.js";
import { getRequestMeta, maskIpAddress, shortenUserAgent } from "../utils/requestMeta.js";

const RESULT_SET = new Set(["success", "failed", "error", "session_limit"]);
const REASON_SET = new Set([
  "LOGIN_SUCCESS",
  "LOGIN_INVALID_CREDENTIALS",
  "LOGIN_PROVIDER_ERROR",
  "LOGIN_INTERNAL_ERROR",
  "LOGIN_SESSION_LIMIT",
]);
const PROVIDER_MAX_LENGTH = 48;
const REASON_MAX_LENGTH = 64;
const METADATA_MAX_LENGTH = 2048;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_STATUS_ACTIVE = "activa";
const SESSION_TOUCH_THROTTLE_SECONDS = Math.max(
  30,
  Number(process.env.AUTH_SESSION_TOUCH_THROTTLE_SECONDS || 60)
);
const ALERT_DEDUP_MINUTES = Math.max(1, Number(process.env.AUTH_SESSION_LIMIT_ALERT_DEDUP_MINUTES || 5));
const LOGIN_WINDOW_MINUTES = Math.max(1, Number(process.env.AUTH_LOGIN_WINDOW_MINUTES || 15));
const LOGIN_RATE_LIMIT_IP_MAX = Math.max(1, Number(process.env.AUTH_LOGIN_RATE_LIMIT_IP_MAX || 20));
const LOGIN_RATE_LIMIT_IDENTIFIER_MAX = Math.max(1, Number(process.env.AUTH_LOGIN_RATE_LIMIT_IDENTIFIER_MAX || 5));
const LOGIN_RATE_LIMIT_IP_IDENTIFIER_MAX = Math.max(
  1,
  Number(process.env.AUTH_LOGIN_RATE_LIMIT_IP_IDENTIFIER_MAX || 8)
);
const LOGIN_FAILED_LOCK_THRESHOLD = Math.max(1, Number(process.env.AUTH_LOGIN_FAILED_LOCK_THRESHOLD || 5));
const LOGIN_LOCK_MINUTES = Math.max(1, Number(process.env.AUTH_LOGIN_LOCK_MINUTES || 30));
const LOGIN_DELAY_FAIL3_MS = Math.max(0, Number(process.env.AUTH_LOGIN_DELAY_FAIL3_MS || 1000));
const LOGIN_DELAY_FAIL4_MS = Math.max(0, Number(process.env.AUTH_LOGIN_DELAY_FAIL4_MS || 2000));
const LOGIN_ALERT_DEDUP_MINUTES = Math.max(1, Number(process.env.AUTH_LOGIN_ALERT_DEDUP_MINUTES || 5));
const DEFAULT_SESSION_POLICY = {
  maxActiveSessions: 5,
  collisionAction: "allow",
};
const ADMIN_PAGE_SIZE_MAX = 100;

function normalizeLimitedText(value, maxLength) {
  const normalized = String(value || "").normalize("NFC").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function buildMetadata(rawMetadata = {}) {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(rawMetadata)) {
    if (!key) continue;
    if (typeof value === "string") {
      safe[key] = value.slice(0, 180);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (value === null) {
      safe[key] = null;
    }
  }

  const serialized = JSON.stringify(safe);
  if (serialized.length <= METADATA_MAX_LENGTH) return safe;
  return { truncated: true };
}

export function inferFailedLoginReason(error = null) {
  const code = String(error?.code || "").toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || "").toLowerCase();

  const invalidCredentialsByCode = new Set([
    "INVALID_LOGIN_CREDENTIALS",
    "EMAIL_NOT_CONFIRMED",
    "AUTH_INVALID_CREDENTIALS",
  ]);

  if (invalidCredentialsByCode.has(code) || status === 400 || status === 401) {
    return "LOGIN_INVALID_CREDENTIALS";
  }
  if (message.includes("invalid login credentials")) {
    return "LOGIN_INVALID_CREDENTIALS";
  }
  return "LOGIN_PROVIDER_ERROR";
}

export async function logLoginAttempt(app, request, payload) {
  try {
    if (!app?.db) return false;

    const result = RESULT_SET.has(payload?.resultado) ? payload.resultado : "error";
    const reason = REASON_SET.has(payload?.motivo_codigo)
      ? payload.motivo_codigo
      : "LOGIN_INTERNAL_ERROR";
    const userIdRaw = normalizeLimitedText(payload?.id_usuario, 64);
    const userId = userIdRaw && UUID_REGEX.test(userIdRaw) ? userIdRaw : null;
    const provider = normalizeLimitedText(payload?.provider || "supabase_password", PROVIDER_MAX_LENGTH);
    const identifier = normalizeIdentifier(payload?.identifier);
    const meta = getRequestMeta(request);
    const { hash, weakSecret } = buildIdentifierHash(identifier, request?.log);

    const metadata = buildMetadata({
      weak_hash_secret: weakSecret || false,
      ...buildMetadata(payload?.metadata || {}),
    });

    await app.db.query(
      `
        INSERT INTO public.seguridad_login_logs (
          id_usuario,
          identificador_hash,
          email_masked,
          provider,
          resultado,
          motivo_codigo,
          ip,
          user_agent,
          request_id,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::text,
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::inet,
          $8::text,
          $9::text,
          $10::jsonb
        )
      `,
      [
        userId || null,
        hash,
        maskEmail(identifier),
        provider,
        result,
        normalizeLimitedText(reason, REASON_MAX_LENGTH),
        meta.ip,
        meta.userAgent,
        meta.requestId,
        JSON.stringify(metadata),
      ]
    );

    return true;
  } catch (error) {
    request?.log?.error(
      {
        event: "security_login_log_failed",
        code: "SECURITY_LOGIN_LOG_INSERT_FAILED",
      },
      "Could not persist seguridad_login_logs record"
    );
    return false;
  }
}

function isValidUuid(value) {
  return UUID_REGEX.test(String(value || "").trim());
}

function normalizeMetadataForSession(rawMetadata = {}) {
  return buildMetadata(rawMetadata);
}

export async function createActiveSession(app, request, payload) {
  const userId = String(payload?.id_usuario || "").trim();
  const sid = String(payload?.sid || "").trim();
  const jti = String(payload?.jti || "").trim();
  const expUnix = Number(payload?.exp_unix || 0);
  const motivo = normalizeLimitedText(payload?.motivo_cierre, REASON_MAX_LENGTH);
  const replaceActiveSession = payload?.replace_active_session === true;
  const roles = Array.isArray(payload?.roles) ? payload.roles.filter(Boolean).map((r) => String(r)) : [];
  const provider = normalizeLimitedText(payload?.provider || "supabase_password", PROVIDER_MAX_LENGTH);
  const identifier = normalizeIdentifier(payload?.identifier);

  if (!app?.db) return { ok: false, code: "DB_NOT_CONFIGURED" };
  if (!isValidUuid(userId) || !isValidUuid(sid) || !isValidUuid(jti) || !Number.isFinite(expUnix) || expUnix <= 0) {
    return { ok: false, code: "AUTH_SESSION_PAYLOAD_INVALID" };
  }

  const meta = getRequestMeta(request);
  const { hash: tokenJtiHash } = buildTokenJtiHash(jti, request?.log);
  const { hash: identifierHash } = buildIdentifierHash(identifier, request?.log);
  const maskedEmail = maskEmail(identifier);
  if (!tokenJtiHash) {
    return { ok: false, code: "AUTH_SESSION_JTI_HASH_UNAVAILABLE" };
  }

  function resolvePolicy(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { ...DEFAULT_SESSION_POLICY };
    const maxActiveSessions = rows.reduce((min, row) => {
      const value = Number(row.max_active_sessions || 0);
      if (!Number.isFinite(value) || value <= 0) return min;
      return Math.min(min, value);
    }, Number.MAX_SAFE_INTEGER);

    const actions = new Set(rows.map((row) => String(row.collision_action || "").trim()));
    let collisionAction = "allow";
    if (actions.has("confirm_replace")) collisionAction = "confirm_replace";
    else if (actions.has("block")) collisionAction = "block";

    return {
      maxActiveSessions:
        maxActiveSessions === Number.MAX_SAFE_INTEGER ? DEFAULT_SESSION_POLICY.maxActiveSessions : maxActiveSessions,
      collisionAction,
    };
  }

  async function readPolicyRows(client) {
    if (!roles.length) return [];
    const { rows } = await client.query(
      `
        SELECT p.max_active_sessions, p.collision_action, r.nombre AS role_name
        FROM public.seguridad_session_policy p
        JOIN public.roles r
          ON r.id_rol = p.id_rol
        WHERE r.nombre = ANY($1::text[])
      `,
      [roles]
    );
    return rows || [];
  }

  async function insertLoginLogWithClient(client, { resultado, motivoCodigo, extraMetadata = {} }) {
    const safeResult = RESULT_SET.has(resultado) ? resultado : "error";
    const safeReason = REASON_SET.has(motivoCodigo) ? motivoCodigo : "LOGIN_INTERNAL_ERROR";
    const metadata = buildMetadata({
      ...buildMetadata(payload?.metadata || {}),
      ...buildMetadata(extraMetadata),
    });

    await client.query(
      `
        INSERT INTO public.seguridad_login_logs (
          id_usuario,
          identificador_hash,
          email_masked,
          provider,
          resultado,
          motivo_codigo,
          ip,
          user_agent,
          request_id,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::text,
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::inet,
          $8::text,
          $9::text,
          $10::jsonb
        )
      `,
      [
        userId,
        identifierHash,
        maskedEmail,
        provider,
        safeResult,
        safeReason,
        meta.ip,
        meta.userAgent,
        meta.requestId,
        JSON.stringify(metadata),
      ]
    );
  }

  async function insertAuditLogWithClient(client, { accion, resultado = "ok", motivoCodigo, metadata = {} }) {
    await client.query(
      `
        INSERT INTO public.seguridad_audit_logs (
          id_usuario,
          accion,
          entidad,
          entidad_id,
          resultado,
          motivo_codigo,
          ip,
          request_id,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::text,
          'seguridad_sesiones',
          $3::text,
          $4::text,
          $5::text,
          $6::inet,
          $7::text,
          $8::jsonb
        )
      `,
      [
        userId,
        normalizeLimitedText(accion, 100) || "AUTH_SESSION_EVENT",
        userId,
        normalizeLimitedText(resultado, 16) || "ok",
        normalizeLimitedText(motivoCodigo, REASON_MAX_LENGTH),
        meta.ip,
        meta.requestId,
        JSON.stringify(buildMetadata(metadata)),
      ]
    );
  }

  async function insertLimitAlertIfNeeded(client, { activeSessions, maxActiveSessions }) {
    const existing = await client.query(
      `
        SELECT 1
        FROM public.seguridad_alertas
        WHERE tipo = 'cliente_intenta_nueva_sesion'
          AND id_usuario = $1::uuid
          AND estado IN ('abierta', 'en_revision')
          AND detectada_at >= (NOW() - make_interval(mins => $2::int))
        LIMIT 1
      `,
      [userId, ALERT_DEDUP_MINUTES]
    );
    if (existing.rowCount) return;

    await client.query(
      `
        INSERT INTO public.seguridad_alertas (
          tipo,
          severidad,
          estado,
          id_usuario,
          ip,
          resumen,
          detalle,
          detectada_at
        )
        VALUES (
          'cliente_intenta_nueva_sesion',
          'media',
          'abierta',
          $1::uuid,
          $2::inet,
          $3::text,
          $4::jsonb,
          NOW()
        )
      `,
      [
        userId,
        meta.ip,
        "Intento de nueva sesion con limite activo",
        JSON.stringify(
          buildMetadata({
            active_sessions: Number(activeSessions || 0),
            max_active_sessions: Number(maxActiveSessions || 1),
          })
        ),
      ]
    );
  }

  const client = await app.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [userId]);

    await client.query(
      `
        UPDATE public.seguridad_sesiones
        SET
          estado = 'expirada',
          cierre_at = COALESCE(cierre_at, NOW()),
          motivo_cierre = COALESCE(motivo_cierre, 'sesion_expirada')
        WHERE id_usuario = $1::uuid
          AND estado = 'activa'
          AND expira_at <= NOW()
      `,
      [userId]
    );

    const policyRows = await readPolicyRows(client);
    const policy = resolvePolicy(policyRows);

    const activeRowsResult = await client.query(
      `
        SELECT id_sesion
        FROM public.seguridad_sesiones
        WHERE id_usuario = $1::uuid
          AND estado = 'activa'
          AND cierre_at IS NULL
          AND revocada_at IS NULL
          AND expira_at > NOW()
        ORDER BY inicio_at ASC
        FOR UPDATE
      `,
      [userId]
    );
    const activeRows = activeRowsResult.rows || [];
    const activeCount = activeRows.length;

    const hasCollision = activeCount >= policy.maxActiveSessions;
    const shouldCheckLimit = policy.collisionAction !== "allow" && Number.isFinite(policy.maxActiveSessions);
    const requiresReplacement = policy.collisionAction === "confirm_replace";

    if (hasCollision && shouldCheckLimit) {
      if (requiresReplacement && replaceActiveSession) {
        await client.query(
          `
            UPDATE public.seguridad_sesiones
            SET
              estado = 'revocada',
              revocada_at = NOW(),
              cierre_at = COALESCE(cierre_at, NOW()),
              cerrada_por = $2::uuid,
              motivo_cierre = 'reemplazo_sesion_cliente',
              ultimo_uso_at = NOW(),
              ip_ultimo_uso = COALESCE($3::inet, ip_ultimo_uso),
              request_id = COALESCE($4::text, request_id)
            WHERE id_usuario = $1::uuid
              AND estado = 'activa'
          `,
          [userId, userId, meta.ip, meta.requestId]
        );

        await insertAuditLogWithClient(client, {
          accion: "AUTH_SESSION_REPLACED",
          resultado: "ok",
          motivoCodigo: "AUTH_SESSION_REPLACED",
          metadata: {
            previous_active_sessions: activeCount,
            collision_action: policy.collisionAction,
          },
        });
      } else {
        await insertLoginLogWithClient(client, {
          resultado: "session_limit",
          motivoCodigo: "LOGIN_SESSION_LIMIT",
          extraMetadata: {
            collision_action: policy.collisionAction,
            max_active_sessions: policy.maxActiveSessions,
            active_sessions: activeCount,
          },
        });
        await insertAuditLogWithClient(client, {
          accion: "AUTH_SESSION_LIMIT_REACHED",
          resultado: "denegado",
          motivoCodigo: "AUTH_SESSION_LIMIT_REACHED",
          metadata: {
            collision_action: policy.collisionAction,
            max_active_sessions: policy.maxActiveSessions,
            active_sessions: activeCount,
          },
        });

        if (requiresReplacement) {
          await insertLimitAlertIfNeeded(client, {
            activeSessions: activeCount,
            maxActiveSessions: policy.maxActiveSessions,
          });
        }

        await client.query("COMMIT");
        return {
          ok: false,
          code: "AUTH_SESSION_LIMIT_REACHED",
          requiresSessionReplacement: requiresReplacement,
        };
      }
    }

    await client.query(
      `
        INSERT INTO public.seguridad_sesiones (
          id_sesion,
          id_usuario,
          token_jti_hash,
          estado,
          inicio_at,
          ultimo_uso_at,
          expira_at,
          motivo_cierre,
          ip_inicio,
          ip_ultimo_uso,
          user_agent,
          request_id,
          metadata
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          NOW(),
          NOW(),
          to_timestamp($5::double precision),
          $6::text,
          $7::inet,
          $8::inet,
          $9::text,
          $10::text,
          $11::jsonb
        )
      `,
      [
        sid,
        userId,
        tokenJtiHash,
        SESSION_STATUS_ACTIVE,
        expUnix,
        motivo,
        meta.ip,
        meta.ip,
        meta.userAgent,
        meta.requestId,
        JSON.stringify(normalizeMetadataForSession(payload?.metadata || {})),
      ]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (_error) {
    await client.query("ROLLBACK").catch(() => {});
    request?.log?.error(
      { event: "security_session_create_failed", code: "AUTH_SESSION_CREATE_ERROR" },
      "Could not create active session"
    );
    return { ok: false, code: "AUTH_SESSION_CREATE_ERROR" };
  } finally {
    client.release();
  }
}

export async function validateActiveSession(app, request, payload) {
  if (!app?.db) return { ok: false, statusCode: 500, code: "DB_NOT_CONFIGURED" };

  const userId = String(payload?.id_usuario || "").trim();
  const sid = String(payload?.sid || "").trim();
  const jti = String(payload?.jti || "").trim();
  if (!isValidUuid(userId) || !isValidUuid(sid) || !isValidUuid(jti)) {
    return { ok: false, statusCode: 401, code: "AUTH_SESSION_INVALID" };
  }

  const { hash: tokenJtiHash } = buildTokenJtiHash(jti, request?.log);
  if (!tokenJtiHash) {
    return { ok: false, statusCode: 500, code: "AUTH_SESSION_HASH_ERROR" };
  }

  const meta = getRequestMeta(request);

  try {
    const lookup = await app.db.query(
      `
        SELECT
          id_sesion,
          estado,
          ultimo_uso_at,
          expira_at,
          cierre_at,
          revocada_at
        FROM public.seguridad_sesiones
        WHERE id_sesion = $1::uuid
          AND id_usuario = $2::uuid
          AND token_jti_hash = $3::text
        LIMIT 1
      `,
      [sid, userId, tokenJtiHash]
    );

    const row = lookup.rows?.[0];
    if (!row) {
      return { ok: false, statusCode: 401, code: "AUTH_SESSION_INVALID" };
    }

    const estado = String(row.estado || "");
    const expired = row.expira_at ? new Date(row.expira_at).getTime() <= Date.now() : true;
    const closed = Boolean(row.cierre_at);
    const revoked = Boolean(row.revocada_at);

    if (estado !== SESSION_STATUS_ACTIVE || expired || closed || revoked) {
      if (expired && estado === SESSION_STATUS_ACTIVE) {
        await app.db
          .query(
            `
              UPDATE public.seguridad_sesiones
              SET
                estado = 'expirada',
                cierre_at = COALESCE(cierre_at, NOW()),
                motivo_cierre = COALESCE(motivo_cierre, 'sesion_expirada')
              WHERE id_sesion = $1::uuid
            `,
            [sid]
          )
          .catch(() => {});
      }
      return { ok: false, statusCode: 401, code: "AUTH_SESSION_INVALID" };
    }

    await app.db
      .query(
        `
          UPDATE public.seguridad_sesiones
          SET
            ultimo_uso_at = NOW(),
            ip_ultimo_uso = COALESCE($2::inet, ip_ultimo_uso),
            user_agent = COALESCE($3::text, user_agent),
            request_id = COALESCE($4::text, request_id)
          WHERE id_sesion = $1::uuid
            AND estado = 'activa'
            AND ultimo_uso_at < (NOW() - make_interval(secs => $5::int))
        `,
        [sid, meta.ip, meta.userAgent, meta.requestId, SESSION_TOUCH_THROTTLE_SECONDS]
      )
      .catch(() => {});

    return { ok: true };
  } catch (_error) {
    request?.log?.error(
      { event: "security_session_validate_failed", code: "AUTH_SESSION_VALIDATE_ERROR" },
      "Could not validate active session"
    );
    return { ok: false, statusCode: 500, code: "AUTH_SESSION_VALIDATE_ERROR" };
  }
}

export async function closeActiveSession(app, request, payload) {
  if (!app?.db) return { ok: false, code: "DB_NOT_CONFIGURED" };

  const sid = String(payload?.sid || "").trim();
  const userId = String(payload?.id_usuario || "").trim();
  const closedBy = String(payload?.cerrada_por || "").trim();
  const motivo = normalizeLimitedText(payload?.motivo_cierre || "logout_usuario", REASON_MAX_LENGTH);
  if (!isValidUuid(sid) || !isValidUuid(userId) || (closedBy && !isValidUuid(closedBy))) {
    return { ok: false, code: "AUTH_SESSION_CLOSE_PAYLOAD_INVALID" };
  }

  const meta = getRequestMeta(request);

  try {
    await app.db.query(
      `
        UPDATE public.seguridad_sesiones
        SET
          estado = 'cerrada',
          cierre_at = COALESCE(cierre_at, NOW()),
          revocada_at = NULL,
          cerrada_por = COALESCE($3::uuid, cerrada_por),
          motivo_cierre = COALESCE($4::text, motivo_cierre, 'logout_usuario'),
          ultimo_uso_at = NOW(),
          ip_ultimo_uso = COALESCE($5::inet, ip_ultimo_uso),
          user_agent = COALESCE($6::text, user_agent),
          request_id = COALESCE($7::text, request_id)
        WHERE id_sesion = $1::uuid
          AND id_usuario = $2::uuid
          AND estado = 'activa'
      `,
      [sid, userId, closedBy || null, motivo, meta.ip, meta.userAgent, meta.requestId]
    );
    return { ok: true };
  } catch (_error) {
    request?.log?.error(
      { event: "security_session_close_failed", code: "AUTH_SESSION_CLOSE_ERROR" },
      "Could not close active session"
    );
    return { ok: false, code: "AUTH_SESSION_CLOSE_ERROR" };
  }
}

function delayForFailures(failureCount) {
  if (failureCount >= 4) return LOGIN_DELAY_FAIL4_MS;
  if (failureCount >= 3) return LOGIN_DELAY_FAIL3_MS;
  return 0;
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertSecurityAlertDedup(client, {
  tipo,
  severidad = "media",
  idUsuario = null,
  ip = null,
  resumen,
  detalle = {},
  dedupMinutes = LOGIN_ALERT_DEDUP_MINUTES,
}) {
  const exists = await client.query(
    `
      SELECT 1
      FROM public.seguridad_alertas
      WHERE tipo = $1::text
        AND (
          ($2::uuid IS NULL AND id_usuario IS NULL)
          OR id_usuario = $2::uuid
        )
        AND (
          ($3::inet IS NULL AND ip IS NULL)
          OR ip = $3::inet
        )
        AND estado IN ('abierta', 'en_revision')
        AND detectada_at >= (NOW() - make_interval(mins => $4::int))
      LIMIT 1
    `,
    [tipo, idUsuario, ip, Math.max(1, Number(dedupMinutes || 1))]
  );
  if (exists.rowCount) return false;

  await client.query(
    `
      INSERT INTO public.seguridad_alertas (
        tipo,
        severidad,
        estado,
        id_usuario,
        ip,
        resumen,
        detalle,
        detectada_at
      )
      VALUES (
        $1::text,
        $2::text,
        'abierta',
        $3::uuid,
        $4::inet,
        $5::text,
        $6::jsonb,
        NOW()
      )
    `,
    [tipo, severidad, idUsuario, ip, resumen, JSON.stringify(buildMetadata(detalle))]
  );
  return true;
}

export async function getLoginProtectionState(app, request, { identifier }) {
  if (!app?.db) {
    return {
      ok: false,
      code: "DB_NOT_CONFIGURED",
      blocked: true,
      delayMs: 0,
    };
  }

  const safeIdentifier = normalizeIdentifier(identifier);
  const meta = getRequestMeta(request);
  const { hash: identifierHash } = buildIdentifierHash(safeIdentifier, request?.log);

  let ipAttempts = 0;
  let identifierFailures = 0;
  let ipIdentifierAttempts = 0;

  try {
    if (meta.ip) {
      const ipCount = await app.db.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.seguridad_login_logs
          WHERE created_at >= (NOW() - make_interval(mins => $2::int))
            AND ip = $1::inet
        `,
        [meta.ip, LOGIN_WINDOW_MINUTES]
      );
      ipAttempts = Number(ipCount.rows?.[0]?.total || 0);
    }

    if (identifierHash) {
      const identifierCount = await app.db.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.seguridad_login_logs
          WHERE created_at >= (NOW() - make_interval(mins => $2::int))
            AND identificador_hash = $1::text
            AND resultado IN ('failed', 'error', 'session_limit')
        `,
        [identifierHash, LOGIN_WINDOW_MINUTES]
      );
      identifierFailures = Number(identifierCount.rows?.[0]?.total || 0);
    }

    if (meta.ip && identifierHash) {
      const comboCount = await app.db.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.seguridad_login_logs
          WHERE created_at >= (NOW() - make_interval(mins => $3::int))
            AND ip = $1::inet
            AND identificador_hash = $2::text
        `,
        [meta.ip, identifierHash, LOGIN_WINDOW_MINUTES]
      );
      ipIdentifierAttempts = Number(comboCount.rows?.[0]?.total || 0);
    }

    const blockedByIp = ipAttempts >= LOGIN_RATE_LIMIT_IP_MAX;
    const blockedByIdentifier = identifierFailures >= LOGIN_RATE_LIMIT_IDENTIFIER_MAX;
    const blockedByIpIdentifier = ipIdentifierAttempts >= LOGIN_RATE_LIMIT_IP_IDENTIFIER_MAX;

    if (blockedByIp && meta.ip) {
      const client = await app.db.connect();
      try {
        await insertSecurityAlertDedup(client, {
          tipo: "muchos_fallos_misma_ip",
          severidad: "media",
          ip: meta.ip,
          resumen: "Patron de intentos elevados desde una misma IP",
          detalle: {
            ip_attempts: ipAttempts,
            login_window_minutes: LOGIN_WINDOW_MINUTES,
          },
        });
      } finally {
        client.release();
      }
    }

    return {
      ok: true,
      blocked: blockedByIp || blockedByIdentifier || blockedByIpIdentifier,
      code: blockedByIp || blockedByIdentifier || blockedByIpIdentifier ? "AUTH_LOGIN_RATE_LIMITED" : null,
      delayMs: delayForFailures(identifierFailures),
      counts: {
        ipAttempts,
        identifierFailures,
        ipIdentifierAttempts,
      },
    };
  } catch (_error) {
    request?.log?.error(
      { event: "security_login_protection_state_failed", code: "AUTH_LOGIN_PROTECTION_ERROR" },
      "Could not evaluate login protection state"
    );
    return {
      ok: false,
      blocked: true,
      code: "AUTH_LOGIN_RATE_LIMITED",
      delayMs: 0,
    };
  }
}

export async function applyProgressiveLoginDelay(delayMs) {
  await sleep(delayMs);
}

async function resolveAccessUserByIdentifier(app, identifier) {
  if (!app?.db) return null;
  const safeIdentifier = normalizeIdentifier(identifier);
  if (!safeIdentifier) return null;

  const result = await app.db.query(
    `
      SELECT
        u.id_usuario,
        COALESCE(sua.failed_login_count, 0) AS failed_login_count,
        sua.last_failed_login_at,
        sua.locked_until_at,
        EXISTS (
          SELECT 1
          FROM public.roles_usuarios ru
          JOIN public.roles r
            ON r.id_rol = ru.id_rol
          WHERE ru.id_usuario = u.id_usuario
            AND ru.activo IS TRUE
            AND r.nombre = 'super_admin'
        ) AS is_super_admin
      FROM public.correos c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      JOIN public.usuarios u
        ON u.id_persona = p.id_persona
      LEFT JOIN public.seguridad_usuarios_acceso sua
        ON sua.id_usuario = u.id_usuario
      WHERE LOWER(c.direccion_correo::text) = LOWER($1)
        AND u.deleted_at IS NULL
      ORDER BY c.es_principal DESC NULLS LAST, c.id_correo ASC
      LIMIT 1
    `,
    [safeIdentifier]
  );

  return result.rows?.[0] || null;
}

export async function checkUserTemporaryLock(app, { idUsuario }) {
  if (!app?.db || !isValidUuid(idUsuario)) {
    return { ok: false, blocked: false };
  }

  try {
    const result = await app.db.query(
      `
        SELECT locked_until_at
        FROM public.seguridad_usuarios_acceso
        WHERE id_usuario = $1::uuid
        LIMIT 1
      `,
      [idUsuario]
    );
    const lockedUntil = result.rows?.[0]?.locked_until_at;
    const blocked = Boolean(lockedUntil) && new Date(lockedUntil).getTime() > Date.now();
    return { ok: true, blocked, lockedUntil: lockedUntil || null };
  } catch (_error) {
    return { ok: false, blocked: false };
  }
}

export async function registerFailedLoginAttempt(app, request, payload) {
  const identifier = normalizeIdentifier(payload?.identifier);
  const provider = normalizeLimitedText(payload?.provider || "supabase_password", PROVIDER_MAX_LENGTH);
  const reason = normalizeLimitedText(payload?.motivo_codigo || "LOGIN_INVALID_CREDENTIALS", REASON_MAX_LENGTH);
  const meta = getRequestMeta(request);

  try {
    const user = await resolveAccessUserByIdentifier(app, identifier);

    await logLoginAttempt(app, request, {
      id_usuario: user?.id_usuario || null,
      identifier,
      provider,
      resultado: "failed",
      motivo_codigo: reason,
      metadata: {
        auth_stage: "password_login",
      },
    });

    if (!user?.id_usuario || !isValidUuid(user.id_usuario)) {
      return { ok: true, blockedNow: false };
    }

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [String(user.id_usuario)]);

      const current = await client.query(
        `
          SELECT failed_login_count, last_failed_login_at
          FROM public.seguridad_usuarios_acceso
          WHERE id_usuario = $1::uuid
          FOR UPDATE
        `,
        [user.id_usuario]
      );

      let nextCount = 1;
      if (current.rowCount) {
        const prevCount = Number(current.rows[0].failed_login_count || 0);
        const prevAt = current.rows[0].last_failed_login_at;
        const inWindow = prevAt
          ? new Date(prevAt).getTime() >= Date.now() - LOGIN_WINDOW_MINUTES * 60_000
          : false;
        nextCount = inWindow ? prevCount + 1 : 1;
      }

      const shouldLock = nextCount >= LOGIN_FAILED_LOCK_THRESHOLD;
      const lockUntilDate = shouldLock ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) : null;

      await client.query(
        `
          INSERT INTO public.seguridad_usuarios_acceso (
            id_usuario,
            failed_login_count,
            last_failed_login_at,
            locked_until_at,
            updated_at
          )
          VALUES (
            $1::uuid,
            $2::int,
            NOW(),
            $3::timestamptz,
            NOW()
          )
          ON CONFLICT (id_usuario)
          DO UPDATE SET
            failed_login_count = EXCLUDED.failed_login_count,
            last_failed_login_at = NOW(),
            locked_until_at = EXCLUDED.locked_until_at,
            updated_at = NOW()
        `,
        [user.id_usuario, nextCount, lockUntilDate ? lockUntilDate.toISOString() : null]
      );

      if (nextCount >= LOGIN_FAILED_LOCK_THRESHOLD) {
        await insertSecurityAlertDedup(client, {
          tipo: "muchos_fallos_mismo_usuario",
          severidad: "alta",
          idUsuario: user.id_usuario,
          ip: meta.ip,
          resumen: "Multiples fallos de autenticacion contra una cuenta",
          detalle: {
            failed_attempts: nextCount,
            login_window_minutes: LOGIN_WINDOW_MINUTES,
          },
        });
      }

      if (shouldLock) {
        await insertSecurityAlertDedup(client, {
          tipo: "usuario_bloqueado",
          severidad: "alta",
          idUsuario: user.id_usuario,
          ip: meta.ip,
          resumen: "Cuenta bloqueada temporalmente por fallos repetidos",
          detalle: {
            lock_minutes: LOGIN_LOCK_MINUTES,
            failed_attempts: nextCount,
          },
        });
      }

      if (user.is_super_admin) {
        await insertSecurityAlertDedup(client, {
          tipo: "intentos_contra_super_admin",
          severidad: "critica",
          idUsuario: user.id_usuario,
          ip: meta.ip,
          resumen: "Intentos fallidos sobre cuenta super_admin",
          detalle: {
            failed_attempts: nextCount,
          },
        });
      }

      await client.query("COMMIT");
      return { ok: true, blockedNow: shouldLock };
    } catch (_error) {
      await client.query("ROLLBACK").catch(() => {});
      return { ok: false, blockedNow: false };
    } finally {
      client.release();
    }
  } catch (_error) {
    return { ok: false, blockedNow: false };
  }
}

export async function registerSuccessfulLogin(app, request, { idUsuario }) {
  if (!app?.db || !isValidUuid(idUsuario)) return { ok: false };

  const meta = getRequestMeta(request);
  try {
    await app.db.query(
      `
        INSERT INTO public.seguridad_usuarios_acceso (
          id_usuario,
          failed_login_count,
          last_failed_login_at,
          locked_until_at,
          last_login_at,
          last_login_ip,
          updated_at
        )
        VALUES (
          $1::uuid,
          0,
          NULL,
          NULL,
          NOW(),
          $2::inet,
          NOW()
        )
        ON CONFLICT (id_usuario)
        DO UPDATE SET
          failed_login_count = 0,
          last_failed_login_at = NULL,
          locked_until_at = NULL,
          last_login_at = NOW(),
          last_login_ip = EXCLUDED.last_login_ip,
          updated_at = NOW()
      `,
      [idUsuario, meta.ip]
    );
    return { ok: true };
  } catch (_error) {
    return { ok: false };
  }
}

function toSafePage(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function toSafeLimit(value, fallback = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(ADMIN_PAGE_SIZE_MAX, Math.max(1, Math.trunc(parsed)));
}

function normalizeOrderDirection(value) {
  return String(value || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function buildPagination(total, page, limit) {
  const safeTotal = Math.max(0, Number(total || 0));
  const totalPages = Math.max(1, Math.ceil(safeTotal / limit));
  return {
    page,
    limit,
    total: safeTotal,
    total_pages: totalPages,
  };
}

async function insertAdminAuditLog(app, {
  client = null,
  actorUserId,
  accion,
  entidad,
  entidadId = null,
  resultado = "ok",
  motivoCodigo = null,
  request = null,
  metadata = {},
}) {
  if (!app?.db || !isValidUuid(actorUserId)) return;
  const run = client || app.db;
  const meta = getRequestMeta(request);
  await run.query(
    `
      INSERT INTO public.seguridad_audit_logs (
        id_usuario,
        accion,
        entidad,
        entidad_id,
        resultado,
        motivo_codigo,
        ip,
        request_id,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::inet,
        $8::text,
        $9::jsonb
      )
    `,
    [
      actorUserId,
      normalizeLimitedText(accion, 100) || "SECURITY_ADMIN_ACTION",
      normalizeLimitedText(entidad, 100) || "seguridad",
      normalizeLimitedText(entidadId, 120),
      normalizeLimitedText(resultado, 16) || "ok",
      normalizeLimitedText(motivoCodigo, REASON_MAX_LENGTH),
      meta.ip,
      meta.requestId,
      JSON.stringify(buildMetadata(metadata)),
    ]
  );
}

export async function listAdminSecurityLoginLogs(app, options = {}) {
  if (!app?.db) return { items: [], pagination: buildPagination(0, 1, 20) };

  const page = toSafePage(options.page, 1);
  const limit = toSafeLimit(options.limit, 20);
  const offset = (page - 1) * limit;
  const sortMap = {
    created_at: "ll.created_at",
    resultado: "ll.resultado",
    provider: "ll.provider",
  };
  const sortBy = sortMap[String(options.sort_by || "created_at")] || sortMap.created_at;
  const sortDirection = normalizeOrderDirection(options.sort_dir);

  const params = [];
  const where = ["1=1"];
  if (options.resultado) {
    params.push(String(options.resultado));
    where.push(`ll.resultado = $${params.length}::text`);
  }
  if (options.id_usuario && isValidUuid(options.id_usuario)) {
    params.push(String(options.id_usuario));
    where.push(`ll.id_usuario = $${params.length}::uuid`);
  }
  if (options.provider) {
    params.push(String(options.provider));
    where.push(`ll.provider = $${params.length}::text`);
  }
  if (options.from_at) {
    params.push(String(options.from_at));
    where.push(`ll.created_at >= $${params.length}::timestamptz`);
  }
  if (options.to_at) {
    params.push(String(options.to_at));
    where.push(`ll.created_at <= $${params.length}::timestamptz`);
  }

  const whereSql = where.join(" AND ");
  const countQuery = await app.db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.seguridad_login_logs ll
      WHERE ${whereSql}
    `,
    params
  );
  const total = Number(countQuery.rows?.[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const rowsQuery = await app.db.query(
    `
      SELECT
        ll.id_login_log,
        ll.id_usuario,
        ll.email_masked,
        ll.provider,
        ll.resultado,
        ll.motivo_codigo,
        ll.ip,
        ll.user_agent,
        ll.request_id,
        ll.created_at
      FROM public.seguridad_login_logs ll
      WHERE ${whereSql}
      ORDER BY ${sortBy} ${sortDirection}
      LIMIT $${dataParams.length - 1}::int
      OFFSET $${dataParams.length}::int
    `,
    dataParams
  );

  const items = (rowsQuery.rows || []).map((row) => ({
    id_login_log: row.id_login_log,
    id_usuario: row.id_usuario ?? null,
    email_masked: row.email_masked ?? null,
    provider: row.provider ?? null,
    resultado: row.resultado,
    motivo_codigo: row.motivo_codigo ?? null,
    ip: maskIpAddress(row.ip),
    user_agent_hint: shortenUserAgent(row.user_agent, 56),
    request_id: row.request_id ?? null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));

  return {
    items,
    pagination: buildPagination(total, page, limit),
  };
}

export async function listAdminSecuritySessions(app, options = {}) {
  if (!app?.db) return { items: [], pagination: buildPagination(0, 1, 20) };

  const page = toSafePage(options.page, 1);
  const limit = toSafeLimit(options.limit, 20);
  const offset = (page - 1) * limit;

  const sortMap = {
    inicio_at: "s.inicio_at",
    ultimo_uso_at: "s.ultimo_uso_at",
    expira_at: "s.expira_at",
    estado: "s.estado",
  };
  const sortBy = sortMap[String(options.sort_by || "inicio_at")] || sortMap.inicio_at;
  const sortDirection = normalizeOrderDirection(options.sort_dir);

  const params = [];
  const where = ["1=1"];
  if (options.estado) {
    params.push(String(options.estado));
    where.push(`s.estado = $${params.length}::text`);
  }
  if (options.id_usuario && isValidUuid(options.id_usuario)) {
    params.push(String(options.id_usuario));
    where.push(`s.id_usuario = $${params.length}::uuid`);
  }
  if (options.from_at) {
    params.push(String(options.from_at));
    where.push(`s.inicio_at >= $${params.length}::timestamptz`);
  }
  if (options.to_at) {
    params.push(String(options.to_at));
    where.push(`s.inicio_at <= $${params.length}::timestamptz`);
  }
  const whereSql = where.join(" AND ");

  const countQuery = await app.db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.seguridad_sesiones s
      WHERE ${whereSql}
    `,
    params
  );
  const total = Number(countQuery.rows?.[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const rowsQuery = await app.db.query(
    `
      SELECT
        s.id_sesion,
        s.id_usuario,
        s.estado,
        s.inicio_at,
        s.ultimo_uso_at,
        s.expira_at,
        s.cierre_at,
        s.revocada_at,
        s.motivo_cierre,
        s.ip_inicio,
        s.ip_ultimo_uso,
        s.user_agent,
        s.request_id
      FROM public.seguridad_sesiones s
      WHERE ${whereSql}
      ORDER BY ${sortBy} ${sortDirection}
      LIMIT $${dataParams.length - 1}::int
      OFFSET $${dataParams.length}::int
    `,
    dataParams
  );

  const items = (rowsQuery.rows || []).map((row) => ({
    id_sesion: row.id_sesion,
    id_usuario: row.id_usuario,
    estado: row.estado,
    inicio_at: row.inicio_at ? new Date(row.inicio_at).toISOString() : null,
    ultimo_uso_at: row.ultimo_uso_at ? new Date(row.ultimo_uso_at).toISOString() : null,
    expira_at: row.expira_at ? new Date(row.expira_at).toISOString() : null,
    cierre_at: row.cierre_at ? new Date(row.cierre_at).toISOString() : null,
    revocada_at: row.revocada_at ? new Date(row.revocada_at).toISOString() : null,
    motivo_cierre: row.motivo_cierre ?? null,
    ip_inicio: maskIpAddress(row.ip_inicio),
    ip_ultimo_uso: maskIpAddress(row.ip_ultimo_uso),
    user_agent_hint: shortenUserAgent(row.user_agent, 56),
    request_id: row.request_id ?? null,
  }));

  return {
    items,
    pagination: buildPagination(total, page, limit),
  };
}

export async function revokeAdminSecuritySession(app, request, {
  idSesion,
  actorUserId,
  actorSessionId,
}) {
  if (!app?.db || !isValidUuid(idSesion) || !isValidUuid(actorUserId)) {
    return { ok: false, code: "SECURITY_SESSION_REVOKE_INVALID" };
  }
  if (actorSessionId && String(actorSessionId) === String(idSesion)) {
    return { ok: false, code: "SECURITY_SESSION_REVOKE_SELF_FORBIDDEN" };
  }

  const meta = getRequestMeta(request);
  const result = await app.db.query(
    `
      UPDATE public.seguridad_sesiones
      SET
        estado = 'revocada',
        revocada_at = COALESCE(revocada_at, NOW()),
        cierre_at = COALESCE(cierre_at, NOW()),
        cerrada_por = $2::uuid,
        motivo_cierre = COALESCE(motivo_cierre, 'riesgo_seguridad'),
        ip_ultimo_uso = COALESCE($3::inet, ip_ultimo_uso),
        request_id = COALESCE($4::text, request_id),
        ultimo_uso_at = NOW()
      WHERE id_sesion = $1::uuid
        AND estado = 'activa'
      RETURNING id_sesion, id_usuario
    `,
    [idSesion, actorUserId, meta.ip, meta.requestId]
  );

  if (!result.rowCount) {
    return { ok: false, code: "SECURITY_SESSION_NOT_FOUND" };
  }

  await insertAdminAuditLog(app, {
    actorUserId,
    accion: "SECURITY_SESSION_REVOKE",
    entidad: "seguridad_sesiones",
    entidadId: idSesion,
    resultado: "ok",
    motivoCodigo: "SECURITY_SESSION_REVOKED",
    request,
    metadata: { id_usuario_objetivo: result.rows[0].id_usuario },
  });

  return {
    ok: true,
    id_sesion: result.rows[0].id_sesion,
  };
}

export async function listAdminSecurityUsers(app, options = {}) {
  if (!app?.db) return { items: [], pagination: buildPagination(0, 1, 20) };

  const page = toSafePage(options.page, 1);
  const limit = toSafeLimit(options.limit, 20);
  const offset = (page - 1) * limit;
  const sortMap = {
    updated_at: "COALESCE(sua.updated_at, u.updated_at, u.created_at)",
    failed_login_count: "COALESCE(sua.failed_login_count, 0)",
    last_login_at: "sua.last_login_at",
  };
  const sortBy = sortMap[String(options.sort_by || "updated_at")] || sortMap.updated_at;
  const sortDirection = normalizeOrderDirection(options.sort_dir);

  const params = [];
  const where = ["u.deleted_at IS NULL"];
  if (options.estado_acceso) {
    params.push(String(options.estado_acceso));
    where.push(`u.estado_acceso = $${params.length}::text`);
  }
  if (options.q) {
    params.push(`%${String(options.q || "").trim().toLowerCase()}%`);
    const idx = params.length;
    where.push(`
      (
        lower(COALESCE(au.email::text, '')) LIKE $${idx}
        OR lower(COALESCE(p.nombres, '')) LIKE $${idx}
        OR lower(COALESCE(p.apellidos, '')) LIKE $${idx}
      )
    `);
  }
  const whereSql = where.join(" AND ");

  const countQuery = await app.db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.usuarios u
      LEFT JOIN auth.users au
        ON au.id = u.id_usuario
      LEFT JOIN public.personas p
        ON p.id_persona = u.id_persona
      WHERE ${whereSql}
    `,
    params
  );
  const total = Number(countQuery.rows?.[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const rowsQuery = await app.db.query(
    `
      SELECT
        u.id_usuario,
        u.estado_acceso,
        u.estado,
        au.email::text AS email,
        p.nombres,
        p.apellidos,
        COALESCE(sua.failed_login_count, 0) AS failed_login_count,
        sua.last_failed_login_at,
        sua.locked_until_at,
        sua.last_login_at,
        sua.last_login_ip,
        sua.updated_at,
        COALESCE(
          array_agg(DISTINCT r.nombre ORDER BY r.nombre) FILTER (WHERE r.nombre IS NOT NULL),
          ARRAY[]::text[]
        ) AS roles
      FROM public.usuarios u
      LEFT JOIN auth.users au
        ON au.id = u.id_usuario
      LEFT JOIN public.personas p
        ON p.id_persona = u.id_persona
      LEFT JOIN public.seguridad_usuarios_acceso sua
        ON sua.id_usuario = u.id_usuario
      LEFT JOIN public.roles_usuarios ru
        ON ru.id_usuario = u.id_usuario
        AND ru.activo IS TRUE
      LEFT JOIN public.roles r
        ON r.id_rol = ru.id_rol
      WHERE ${whereSql}
      GROUP BY
        u.id_usuario,
        u.estado_acceso,
        u.estado,
        au.email,
        p.nombres,
        p.apellidos,
        sua.failed_login_count,
        sua.last_failed_login_at,
        sua.locked_until_at,
        sua.last_login_at,
        sua.last_login_ip,
        sua.updated_at
      ORDER BY ${sortBy} ${sortDirection}
      LIMIT $${dataParams.length - 1}::int
      OFFSET $${dataParams.length}::int
    `,
    dataParams
  );

  const items = (rowsQuery.rows || []).map((row) => ({
    id_usuario: row.id_usuario,
    estado_acceso: row.estado_acceso,
    estado: Boolean(row.estado),
    email_masked: maskEmail(normalizeIdentifier(row.email || "")),
    nombres: row.nombres ?? null,
    apellidos: row.apellidos ?? null,
    roles: Array.isArray(row.roles) ? row.roles : [],
    failed_login_count: Number(row.failed_login_count || 0),
    last_failed_login_at: row.last_failed_login_at ? new Date(row.last_failed_login_at).toISOString() : null,
    locked_until_at: row.locked_until_at ? new Date(row.locked_until_at).toISOString() : null,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    last_login_ip: maskIpAddress(row.last_login_ip),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));

  return {
    items,
    pagination: buildPagination(total, page, limit),
  };
}

async function countActiveSuperAdmins(client) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.usuarios u
      JOIN public.roles_usuarios ru
        ON ru.id_usuario = u.id_usuario
        AND ru.activo IS TRUE
      JOIN public.roles r
        ON r.id_rol = ru.id_rol
      WHERE r.nombre = 'super_admin'
        AND u.deleted_at IS NULL
        AND u.estado IS TRUE
        AND COALESCE(u.estado_acceso, 'activo') NOT IN ('bloqueado', 'inactivo')
    `
  );
  return Number(result.rows?.[0]?.total || 0);
}

export async function updateAdminUserAccessState(app, request, {
  idUsuario,
  estadoAcceso,
  actorUserId,
}) {
  if (!app?.db || !isValidUuid(idUsuario) || !isValidUuid(actorUserId)) {
    return { ok: false, code: "SECURITY_USER_ACCESS_INVALID" };
  }

  const nextState = String(estadoAcceso || "").trim().toLowerCase();
  const disableStates = new Set(["bloqueado", "inactivo"]);
  const isDisabling = disableStates.has(nextState);
  const client = await app.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [idUsuario]);

    const targetResult = await client.query(
      `
        SELECT
          u.id_usuario,
          u.estado_acceso,
          EXISTS (
            SELECT 1
            FROM public.roles_usuarios ru
            JOIN public.roles r
              ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = u.id_usuario
              AND ru.activo IS TRUE
              AND r.nombre = 'super_admin'
          ) AS is_super_admin,
          EXISTS (
            SELECT 1
            FROM public.roles_usuarios ru
            JOIN public.roles r
              ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = u.id_usuario
              AND ru.activo IS TRUE
              AND r.nombre IN ('super_admin', 'security_admin')
          ) AS is_critical_access
        FROM public.usuarios u
        WHERE u.id_usuario = $1::uuid
          AND u.deleted_at IS NULL
        LIMIT 1
      `,
      [idUsuario]
    );

    const target = targetResult.rows?.[0];
    if (!target) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SECURITY_USER_NOT_FOUND" };
    }

    if (String(actorUserId) === String(idUsuario) && isDisabling && target.is_critical_access) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SECURITY_SELF_CRITICAL_ACCESS_FORBIDDEN" };
    }

    if (target.is_super_admin && isDisabling) {
      const activeSuperAdmins = await countActiveSuperAdmins(client);
      if (activeSuperAdmins <= 1) {
        await client.query("ROLLBACK");
        return { ok: false, code: "SECURITY_LAST_SUPER_ADMIN_FORBIDDEN" };
      }
    }

    await client.query(
      `
        UPDATE public.usuarios
        SET
          estado_acceso = $2::text,
          updated_at = NOW()
        WHERE id_usuario = $1::uuid
      `,
      [idUsuario, nextState]
    );

    await client.query(
      `
        INSERT INTO public.seguridad_usuarios_acceso (
          id_usuario,
          failed_login_count,
          locked_until_at,
          updated_at,
          updated_by
        )
        VALUES (
          $1::uuid,
          CASE WHEN $2::text = 'activo' THEN 0 ELSE 0 END,
          CASE
            WHEN $2::text = 'bloqueado' THEN (NOW() + make_interval(mins => 30))
            WHEN $2::text = 'activo' THEN NULL
            ELSE NULL
          END,
          NOW(),
          $3::uuid
        )
        ON CONFLICT (id_usuario)
        DO UPDATE SET
          failed_login_count = CASE WHEN $2::text = 'activo' THEN 0 ELSE public.seguridad_usuarios_acceso.failed_login_count END,
          locked_until_at = CASE
            WHEN $2::text = 'bloqueado' THEN (NOW() + make_interval(mins => 30))
            WHEN $2::text = 'activo' THEN NULL
            ELSE public.seguridad_usuarios_acceso.locked_until_at
          END,
          updated_at = NOW(),
          updated_by = $3::uuid
      `,
      [idUsuario, nextState, actorUserId]
    );

    await insertAdminAuditLog(app, {
      client,
      actorUserId,
      accion: "SECURITY_USER_ACCESS_UPDATE",
      entidad: "usuarios",
      entidadId: idUsuario,
      resultado: "ok",
      motivoCodigo: "SECURITY_USER_ACCESS_UPDATED",
      request,
      metadata: { estado_acceso: nextState },
    });

    await client.query("COMMIT");
    return {
      ok: true,
      id_usuario: idUsuario,
      estado_acceso: nextState,
    };
  } catch (_error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, code: "SECURITY_USER_ACCESS_UPDATE_ERROR" };
  } finally {
    client.release();
  }
}

export async function listAdminSecurityAlerts(app, options = {}) {
  if (!app?.db) return { items: [], pagination: buildPagination(0, 1, 20) };

  const page = toSafePage(options.page, 1);
  const limit = toSafeLimit(options.limit, 20);
  const offset = (page - 1) * limit;

  const sortMap = {
    detectada_at: "a.detectada_at",
    severidad: "a.severidad",
    estado: "a.estado",
  };
  const sortBy = sortMap[String(options.sort_by || "detectada_at")] || sortMap.detectada_at;
  const sortDirection = normalizeOrderDirection(options.sort_dir);

  const params = [];
  const where = ["1=1"];
  if (options.estado) {
    params.push(String(options.estado));
    where.push(`a.estado = $${params.length}::text`);
  }
  if (options.severidad) {
    params.push(String(options.severidad));
    where.push(`a.severidad = $${params.length}::text`);
  }
  if (options.tipo) {
    params.push(String(options.tipo));
    where.push(`a.tipo = $${params.length}::text`);
  }
  if (options.id_usuario && isValidUuid(options.id_usuario)) {
    params.push(String(options.id_usuario));
    where.push(`a.id_usuario = $${params.length}::uuid`);
  }
  if (options.from_at) {
    params.push(String(options.from_at));
    where.push(`a.detectada_at >= $${params.length}::timestamptz`);
  }
  if (options.to_at) {
    params.push(String(options.to_at));
    where.push(`a.detectada_at <= $${params.length}::timestamptz`);
  }
  const whereSql = where.join(" AND ");

  const countQuery = await app.db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.seguridad_alertas a
      WHERE ${whereSql}
    `,
    params
  );
  const total = Number(countQuery.rows?.[0]?.total || 0);

  const dataParams = [...params, limit, offset];
  const rowsQuery = await app.db.query(
    `
      SELECT
        a.id_alerta,
        a.tipo,
        a.severidad,
        a.estado,
        a.id_usuario,
        a.ip,
        a.resumen,
        a.detectada_at,
        a.resuelta_at,
        a.resuelta_por
      FROM public.seguridad_alertas a
      WHERE ${whereSql}
      ORDER BY ${sortBy} ${sortDirection}
      LIMIT $${dataParams.length - 1}::int
      OFFSET $${dataParams.length}::int
    `,
    dataParams
  );

  const items = (rowsQuery.rows || []).map((row) => ({
    id_alerta: row.id_alerta,
    tipo: row.tipo,
    severidad: row.severidad,
    estado: row.estado,
    id_usuario: row.id_usuario ?? null,
    ip: maskIpAddress(row.ip),
    resumen: row.resumen ?? null,
    detectada_at: row.detectada_at ? new Date(row.detectada_at).toISOString() : null,
    resuelta_at: row.resuelta_at ? new Date(row.resuelta_at).toISOString() : null,
    resuelta_por: row.resuelta_por ?? null,
  }));

  return {
    items,
    pagination: buildPagination(total, page, limit),
  };
}

export async function updateAdminAlertState(app, request, {
  idAlerta,
  estado,
  actorUserId,
}) {
  if (!app?.db || !isValidUuid(idAlerta) || !isValidUuid(actorUserId)) {
    return { ok: false, code: "SECURITY_ALERT_STATE_INVALID" };
  }

  const nextState = String(estado || "").trim();
  const resolvedAt = nextState === "resuelta" || nextState === "descartada" ? "NOW()" : "NULL";
  const resolvedBy = nextState === "resuelta" || nextState === "descartada" ? "$3::uuid" : "NULL";

  const result = await app.db.query(
    `
      UPDATE public.seguridad_alertas
      SET
        estado = $2::text,
        resuelta_at = ${resolvedAt},
        resuelta_por = ${resolvedBy}
      WHERE id_alerta = $1::uuid
      RETURNING id_alerta, estado
    `,
    [idAlerta, nextState, actorUserId]
  );

  if (!result.rowCount) {
    return { ok: false, code: "SECURITY_ALERT_NOT_FOUND" };
  }

  await insertAdminAuditLog(app, {
    actorUserId,
    accion: "SECURITY_ALERT_STATE_UPDATE",
    entidad: "seguridad_alertas",
    entidadId: idAlerta,
    resultado: "ok",
    motivoCodigo: "SECURITY_ALERT_UPDATED",
    request,
    metadata: { estado: nextState },
  });

  return {
    ok: true,
    id_alerta: result.rows[0].id_alerta,
    estado: result.rows[0].estado,
  };
}
