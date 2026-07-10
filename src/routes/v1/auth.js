import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getAuthClaims } from "../../utils/authClaims.js";
import { sendOk } from "../../utils/response.js";
import { sendError } from "../../utils/errors.js";
import { generateRecoveryActionLink } from "../../services/authRecovery.js";
import {
  applyProgressiveLoginDelay,
  checkUserTemporaryLock,
  closeActiveSession,
  createActiveSession,
  getLoginProtectionState,
  inferFailedLoginReason,
  logLoginAttempt,
  registerFailedLoginAttempt,
  registerSuccessfulLogin,
} from "../../services/securityService.js";

const AUTH_SESSION_COOKIE = "mf_session";
const AUTH_CSRF_COOKIE = "mf_csrf";

const loginBodySchema = {
  type: "object",
  properties: {
    identifier: { type: "string", minLength: 1 },
    nombre_usuario: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", minLength: 1 },
    contrasena: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    remember: { type: "boolean" },
    replace_active_session: { type: "boolean" },
  },
  anyOf: [
    { required: ["identifier"] },
    { required: ["email"] },
    { required: ["nombre_usuario"] },
    { required: ["username"] },
  ],
};

const exchangeBodySchema = {
  type: ["object", "null"],
  properties: {
    supabase_token: { type: "string", minLength: 1 },
    access_token: { type: "string", minLength: 1 },
    token: { type: "string", minLength: 1 },
  },
  additionalProperties: true,
};

const socialConfirmBodySchema = {
  type: "object",
  properties: {
    social_confirm_token: { type: "string", minLength: 16 },
  },
  required: ["social_confirm_token"],
  additionalProperties: false,
};

const registerBodySchema = {
  type: "object",
  properties: {
    nombres: { type: "string", minLength: 1, maxLength: 120 },
    apellidos: { type: "string", minLength: 1, maxLength: 120 },
    email: { type: "string", minLength: 5, maxLength: 160 },
    contrasena: { type: "string", minLength: 8, maxLength: 120 },
    confirmar_contrasena: { type: "string", minLength: 8, maxLength: 120 },
    acepta_terminos: { type: "boolean" },
    consentimiento_marketing: { type: "boolean" },
    id_sucursal_origen: { type: ["string", "null"], format: "uuid" },
  },
  required: [
    "nombres",
    "apellidos",
    "email",
    "contrasena",
    "confirmar_contrasena",
    "acepta_terminos",
  ],
  additionalProperties: false,
};

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

const loginResponseSchema = {
  200: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          user: { type: "object", additionalProperties: true },
          csrf_token: { type: "string" },
          session: {
            type: "object",
            properties: {
              authenticated: { type: "boolean" },
            },
            required: ["authenticated"],
            additionalProperties: false,
          },
        },
        required: ["user", "csrf_token", "session"],
        additionalProperties: true,
      },
      requestId: requestIdSchema,
    },
    required: ["ok", "data"],
    additionalProperties: true,
  },
  409: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
      requires_session_replacement: { type: "boolean" },
      requestId: requestIdSchema,
    },
    required: ["ok", "error", "requires_session_replacement"],
    additionalProperties: true,
  },
};

const exchangeResponseSchema = {
  ...loginResponseSchema,
  202: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          pending_social_confirmation: { type: "boolean" },
          message: { type: "string" },
          email_masked: { type: ["string", "null"] },
        },
        required: ["pending_social_confirmation", "message", "email_masked"],
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
  409: errorResponseSchema,
  500: errorResponseSchema,
};

const socialConfirmResponseSchema = {
  ...loginResponseSchema,
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  409: errorResponseSchema,
  500: errorResponseSchema,
};

const registerResponseSchema = {
  201: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id_usuario: { type: "string", format: "uuid" },
              id_persona: { type: "string", format: "uuid" },
              id_cliente: { type: "string", format: "uuid" },
              email: { type: "string" },
              nombres: { type: "string" },
              apellidos: { type: "string" },
              estado_acceso: { type: "string" },
            },
            required: [
              "id_usuario",
              "id_persona",
              "id_cliente",
              "email",
              "nombres",
              "apellidos",
              "estado_acceso",
            ],
            additionalProperties: false,
          },
          cliente: {
            type: "object",
            properties: {
              id_cliente: { type: "string", format: "uuid" },
              id_sucursal_origen: { type: ["string", "null"], format: "uuid" },
              estado: { type: "boolean" },
            },
            required: ["id_cliente", "id_sucursal_origen", "estado"],
            additionalProperties: false,
          },
          consentimientos: {
            type: "object",
            properties: {
              acepta_terminos: { type: "boolean" },
              acepta_terminos_at: { type: ["string", "null"] },
              consentimiento_marketing: { type: "boolean" },
              consentimiento_marketing_at: { type: ["string", "null"] },
            },
            required: [
              "acepta_terminos",
              "acepta_terminos_at",
              "consentimiento_marketing",
              "consentimiento_marketing_at",
            ],
            additionalProperties: false,
          },
        },
        required: ["user", "cliente", "consentimientos"],
        additionalProperties: false,
      },
      requestId: requestIdSchema,
    },
    required: ["ok", "data"],
    additionalProperties: true,
  },
  400: errorResponseSchema,
  409: errorResponseSchema,
  500: errorResponseSchema,
};

const meResponseSchema = {
  200: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id_usuario: { type: "string", format: "uuid" },
              id_persona: { type: ["string", "null"], format: "uuid" },
              email: { type: ["string", "null"] },
              nombres: { type: ["string", "null"] },
              apellidos: { type: ["string", "null"] },
              telefono_principal: { type: ["string", "null"] },
            },
            required: ["id_usuario", "id_persona", "email", "nombres", "apellidos", "telefono_principal"],
            additionalProperties: false,
          },
          roles: { type: "array", items: { type: "string" } },
          branch_ids: { type: "array", items: { type: "string", format: "uuid" } },
          empresa_id: { type: ["string", "null"], format: "uuid" },
          empleado_id: { type: ["string", "null"], format: "uuid" },
          cliente_id: { type: ["string", "null"], format: "uuid" },
        },
        required: ["user", "roles", "branch_ids", "empresa_id", "empleado_id", "cliente_id"],
        additionalProperties: false,
      },
      requestId: requestIdSchema,
    },
    required: ["ok", "data"],
    additionalProperties: true,
  },
  401: errorResponseSchema,
  500: errorResponseSchema,
};

const csrfResponseSchema = {
  200: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      data: {
        type: "object",
        properties: {
          csrf_token: { type: "string" },
        },
        required: ["csrf_token"],
        additionalProperties: false,
      },
      requestId: requestIdSchema,
    },
    required: ["ok", "data", "requestId"],
    additionalProperties: true,
  },
  401: errorResponseSchema,
  500: errorResponseSchema,
};

const RESET_MAX_ATTEMPTS = Number(process.env.RESET_MAX_ATTEMPTS || 3);
const RESET_WINDOW_MS = Number(process.env.RESET_WINDOW_MS || 15 * 60_000);
const RESET_BLOCK_MS = Number(process.env.RESET_BLOCK_MS || 30 * 60_000);
const resetAttemptsByEmail = new Map();
const ACCESS_STATUS = {
  PENDING_PASSWORD: "pendiente_password",
  ACTIVE: "activo",
  BLOCKED: "bloqueado",
  INACTIVE: "inactivo",
};
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let clientsConsentColumnsCache = null;
const SOCIAL_CONFIRM_TOKEN_TYPE = "social_confirm";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeRequiredText(value) {
  return String(value || "").normalize("NFC").trim();
}

async function resolvePasswordRecipientFullNameByEmail(app, email) {
  if (!app.db) return null;

  const { rows } = await app.db.query(
    `
      SELECT
        concat_ws(' ', NULLIF(btrim(p.nombres), ''), NULLIF(btrim(p.apellidos), '')) AS full_name
      FROM public.correos c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
      WHERE LOWER(c.direccion_correo::text) = LOWER($1)
      ORDER BY c.es_principal DESC NULLS LAST
      LIMIT 1
    `,
    [email]
  );

  const fullName = String(rows?.[0]?.full_name || "").trim();
  return fullName || null;
}

function isSupabaseDuplicateError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "email_exists" || code === "user_already_exists" || message.includes("already registered");
}

function validatePublicPassword(password) {
  if (password.length < 8) return "La contrasena debe tener al menos 8 caracteres.";
  if (!PASSWORD_COMPLEXITY_REGEX.test(password)) {
    return "La contrasena debe incluir mayuscula, minuscula y numero.";
  }
  return null;
}

async function ensureRegisterEmailAvailability(client, email) {
  const correoResult = await client.query(
    `
      SELECT 1
      FROM public.correos
      WHERE LOWER(direccion_correo::text) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );
  if (correoResult.rowCount) {
    throw {
      statusCode: 409,
      message: "El correo ya esta registrado.",
      code: "AUTH_REGISTER_EMAIL_EXISTS",
    };
  }

  const authResult = await client.query(
    `
      SELECT 1
      FROM auth.users
      WHERE LOWER(email::text) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );
  if (authResult.rowCount) {
    throw {
      statusCode: 409,
      message: "El correo ya esta registrado.",
      code: "AUTH_REGISTER_EMAIL_EXISTS",
    };
  }
}

async function getClienteRoleId(client) {
  const roleResult = await client.query(
    `
      SELECT id_rol
      FROM public.roles
      WHERE nombre = 'cliente'
      LIMIT 1
    `
  );
  if (!roleResult.rowCount) {
    throw {
      statusCode: 500,
      message: "No existe el rol cliente en la configuracion interna.",
      code: "AUTH_REGISTER_CLIENT_ROLE_MISSING",
    };
  }
  return roleResult.rows[0].id_rol;
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

async function insertClientWithConsents(client, params) {
  const {
    idPersona,
    authUserId,
    branchId,
    consentimientoMarketing,
    aceptaTerminos,
    aceptaTerminosAt,
    consentimientoMarketingAt,
  } = params;

  const hasConsentTimestampColumns = await hasClientsConsentTimestampColumns(client);
  if (hasConsentTimestampColumns) {
    const insertWithTimestamps = await client.query(
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
          CURRENT_DATE,
          $3::uuid,
          TRUE,
          $4::boolean,
          $5::boolean,
          $6::timestamptz,
          $7::timestamptz
        )
        RETURNING id_cliente
      `,
      [
        idPersona,
        authUserId,
        branchId,
        consentimientoMarketing,
        aceptaTerminos,
        consentimientoMarketingAt,
        aceptaTerminosAt,
      ]
    );
    return insertWithTimestamps.rows[0].id_cliente;
  }

  // AM: Compatibilidad temporal por si aun no aplican la migracion de trazabilidad de consentimientos.
  const insertLegacy = await client.query(
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
        CURRENT_DATE,
        $3::uuid,
        TRUE,
        $4::boolean,
        $5::boolean
      )
      RETURNING id_cliente
    `,
    [idPersona, authUserId, branchId, consentimientoMarketing, aceptaTerminos]
  );
  return insertLegacy.rows[0].id_cliente;
}

async function enforceExchangeClientConsents(client, authUserId) {
  const safeAuthUserId = String(authUserId || "").trim();
  if (!safeAuthUserId) return;

  const hasConsentTimestampColumns = await hasClientsConsentTimestampColumns(client);
  if (hasConsentTimestampColumns) {
    await client.query(
      `
        UPDATE public.clientes
        SET
          acepta_terminos = TRUE,
          consentimiento_marketing = TRUE,
          acepta_terminos_at = COALESCE(acepta_terminos_at, NOW()),
          consentimiento_marketing_at = COALESCE(consentimiento_marketing_at, NOW())
        WHERE id_usuario = $1::uuid
          AND deleted_at IS NULL
      `,
      [safeAuthUserId]
    );
    return;
  }

  await client.query(
    `
      UPDATE public.clientes
      SET
        acepta_terminos = TRUE,
        consentimiento_marketing = TRUE
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
    `,
    [safeAuthUserId]
  );
}

function registerResetAttempt(emailKey) {
  const now = Date.now();
  let record = resetAttemptsByEmail.get(emailKey);

  if (!record) {
    record = { count: 0, windowStart: now, blockedUntil: 0 };
  }

  const windowSeconds = Math.ceil(RESET_WINDOW_MS / 1000);
  const blockSeconds = Math.ceil(RESET_BLOCK_MS / 1000);

  if (record.blockedUntil && now < record.blockedUntil) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1000),
      rateLimit: {
        max: RESET_MAX_ATTEMPTS,
        remaining: 0,
        windowSeconds,
        resetInSeconds: Math.ceil((record.windowStart + RESET_WINDOW_MS - now) / 1000),
        blockSeconds,
      },
    };
  }

  if (now - record.windowStart > RESET_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }

  record.count += 1;

  if (record.count > RESET_MAX_ATTEMPTS) {
    record.blockedUntil = now + RESET_BLOCK_MS;
    resetAttemptsByEmail.set(emailKey, record);

    return {
      blocked: true,
      retryAfterSeconds: blockSeconds,
      rateLimit: {
        max: RESET_MAX_ATTEMPTS,
        remaining: 0,
        windowSeconds,
        resetInSeconds: windowSeconds,
        blockSeconds,
      },
    };
  }

  resetAttemptsByEmail.set(emailKey, record);

  return {
    blocked: false,
    rateLimit: {
      max: RESET_MAX_ATTEMPTS,
      remaining: Math.max(0, RESET_MAX_ATTEMPTS - record.count),
      windowSeconds,
      resetInSeconds: Math.max(0, Math.ceil((record.windowStart + RESET_WINDOW_MS - now) / 1000)),
      blockSeconds,
    },
  };
}

function signAppToken(payload, jwtSecret, { sid, jti } = {}) {
  if (!UUID_REGEX.test(String(sid || "")) || !UUID_REGEX.test(String(jti || ""))) {
    throw new Error("AUTH_TOKEN_SESSION_IDS_INVALID");
  }

  return jwt.sign(payload, jwtSecret, {
    expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "12h",
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
    jwtid: jti,
    header: { typ: "JWT" },
    mutatePayload: false,
    noTimestamp: false,
    algorithm: "HS256",
  });
}

function decodeJwtExpiryUnix(token) {
  const decoded = jwt.decode(token);
  const expUnix = Number(decoded?.exp || 0);
  if (!Number.isFinite(expUnix) || expUnix <= 0) {
    return null;
  }
  return expUnix;
}

async function issueManagedAppSession(app, request, { jwtSecret, claims, email, roles, branchIds, remember = false, replaceActiveSession = false, identifier = null, provider = "supabase_password" }) {
  const sid = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const token = signAppToken(
    {
      sub: String(claims.user.id_usuario),
      sid,
      email: email ?? null,
      "mf:roles": Array.isArray(roles) ? roles : [],
      "mf:branch_ids": Array.isArray(branchIds) ? branchIds : [],
      token_type: "app",
    },
    jwtSecret,
    { sid, jti }
  );

  const expUnix = decodeJwtExpiryUnix(token);
  if (!expUnix) {
    throw {
      statusCode: 500,
      message: "No se pudo crear la sesion de autenticacion",
      code: "AUTH_SESSION_EXP_INVALID",
    };
  }

  const persisted = await createActiveSession(app, request, {
    id_usuario: String(claims.user.id_usuario),
    sid,
    jti,
    exp_unix: expUnix,
    roles,
    replace_active_session: replaceActiveSession === true,
    identifier,
    provider,
    metadata: {
      auth_stage: "app_session",
      remember: remember === true,
    },
  });

  if (!persisted.ok) {
    if (persisted.code === "AUTH_SESSION_LIMIT_REACHED") {
      throw {
        statusCode: 409,
        message: "Ya existe una sesion activa para esta cuenta. Puedes cerrar la sesion anterior y continuar.",
        code: "AUTH_SESSION_LIMIT_REACHED",
        requires_session_replacement: persisted.requiresSessionReplacement === true,
      };
    }
    throw {
      statusCode: 500,
      message: "No se pudo crear la sesion de autenticacion",
      code: "AUTH_SESSION_CREATE_ERROR",
    };
  }

  return { token, sid, jti };
}

function getCookieSecureFlag(app) {
  if (typeof app.config?.cookieSecure === "boolean") {
    return app.config.cookieSecure;
  }
  const raw = String(process.env.AUTH_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (raw) return ["1", "true", "yes", "on"].includes(raw);
  return String(process.env.NODE_ENV || process.env.ENTORNO || "").toLowerCase() === "production";
}

function buildCookieOptions(app, { remember = false } = {}) {
  const sameSite = app.config?.cookieSameSite || "lax";
  const secure = getCookieSecureFlag(app);
  const domain = String(process.env.AUTH_COOKIE_DOMAIN || "").trim() || undefined;
  const ttlSeconds = Math.max(900, Number(app.config?.sessionTtlSeconds || process.env.AUTH_SESSION_TTL_SECONDS || 43200));

  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite,
    ...(domain ? { domain } : {}),
    ...(remember ? { maxAge: ttlSeconds } : {}),
  };
}

function buildCsrfCookieOptions(app, { remember = false } = {}) {
  const base = buildCookieOptions(app, { remember });
  return {
    ...base,
    httpOnly: false,
  };
}

function issueSessionCookies(app, reply, token, { remember = false } = {}) {
  const csrfToken = jwt.sign(
    { type: "csrf", nonce: crypto.randomUUID() },
    app.config?.csrfSecret || process.env.CSRF_SECRET,
    { expiresIn: "12h" }
  );

  reply.setCookie(AUTH_SESSION_COOKIE, token, buildCookieOptions(app, { remember }));
  reply.setCookie(AUTH_CSRF_COOKIE, csrfToken, buildCsrfCookieOptions(app, { remember }));
  return csrfToken;
}

function clearSessionCookies(app, reply) {
  const options = buildCookieOptions(app, { remember: false });
  reply.clearCookie(AUTH_SESSION_COOKIE, options);
  reply.clearCookie(AUTH_CSRF_COOKIE, { ...options, httpOnly: false });
}

function signSocialConfirmToken(payload, jwtSecret) {
  return jwt.sign(payload, jwtSecret, {
    expiresIn: process.env.AUTH_SOCIAL_CONFIRM_EXPIRES_IN?.trim() || "30m",
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
  });
}

function verifySocialConfirmToken(token, jwtSecret) {
  const decoded = jwt.verify(token, jwtSecret, {
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
  });

  if (decoded?.token_type !== SOCIAL_CONFIRM_TOKEN_TYPE) {
    throw new Error("SOCIAL_CONFIRM_TOKEN_TYPE_INVALID");
  }

  return decoded;
}

function getFrontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").trim().replace(/\/+$/, "");
}

function buildSocialConfirmFrontendUrl(token) {
  const frontendBase = getFrontendBaseUrl();
  const query = new URLSearchParams({ social_confirm_token: token }).toString();
  return `${frontendBase}/auth/callback?${query}`;
}

function maskEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return null;
  const [localPart, domain] = normalized.split("@");
  if (!localPart || !domain) return null;
  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}*@${domain}`;
  }
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function extractSupabaseToken(request) {
  const body = request.body || {};
  const bodyToken = String(
    body.supabase_token ?? body.access_token ?? body.token ?? ""
  ).trim();
  if (bodyToken) return bodyToken;
  return null;
}

function extractEmailFromSupabaseUser(user) {
  const directEmail = normalizeEmail(user?.email);
  if (directEmail) return directEmail;

  const metadataEmail = normalizeEmail(user?.user_metadata?.email);
  if (metadataEmail) return metadataEmail;

  const identities = Array.isArray(user?.identities) ? user.identities : [];
  for (const identity of identities) {
    const identityEmail = normalizeEmail(identity?.identity_data?.email);
    if (identityEmail) return identityEmail;
  }

  return "";
}

function normalizePgErrorText(value) {
  return String(value || "").trim().toLowerCase();
}

function isEmailConflictError(error) {
  const detail = normalizePgErrorText(error?.detail);
  const constraint = normalizePgErrorText(error?.constraint);
  return (
    detail.includes("direccion_correo") ||
    detail.includes("(email)") ||
    constraint.includes("correo")
  );
}

function isUserIdConflictError(error) {
  const detail = normalizePgErrorText(error?.detail);
  const constraint = normalizePgErrorText(error?.constraint);
  return detail.includes("(id_usuario)") || constraint.includes("usuarios_pkey");
}

function buildSocialPersonaNames(supabaseUser) {
  const metadata = supabaseUser?.user_metadata || {};
  const givenName = normalizeRequiredText(metadata.given_name);
  const familyName = normalizeRequiredText(metadata.family_name);
  const fullName = normalizeRequiredText(
    metadata.full_name || metadata.name || `${givenName} ${familyName}`.trim()
  );

  let nombres = givenName;
  let apellidos = familyName;

  if (!nombres && fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      nombres = parts[0];
      apellidos = "Cliente";
    } else {
      nombres = parts.shift() || "Cliente";
      apellidos = parts.join(" ") || "Cliente";
    }
  }

  if (!nombres) nombres = "Cliente";
  if (!apellidos) apellidos = "Google";

  return { nombres, apellidos };
}

async function ensureExchangeEmailAvailability(client, email, authUserId) {
  const conflict = await client.query(
    `
      SELECT 1
      FROM public.correos c
      JOIN public.usuarios u
        ON u.id_persona = c.id_persona
      WHERE LOWER(c.direccion_correo::text) = LOWER($1)
        AND u.deleted_at IS NULL
        AND u.id_usuario <> $2::uuid
      LIMIT 1
    `,
    [email, authUserId]
  );

  if (conflict.rowCount) {
    throw {
      statusCode: 409,
      message: "El correo ya esta vinculado a otra cuenta interna.",
      code: "AUTH_EXCHANGE_EMAIL_EXISTS",
    };
  }
}

async function hasInternalUserByAuthId(db, authUserId) {
  const existing = await db.query(
    `
      SELECT 1
      FROM public.usuarios
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [authUserId]
  );
  return existing.rowCount > 0;
}

async function findActiveInternalUserByConfirmedEmail(db, email) {
  const existing = await db.query(
    `
      SELECT u.id_usuario
      FROM public.correos c
      JOIN public.usuarios u
        ON u.id_persona = c.id_persona
      WHERE LOWER(c.direccion_correo::text) = LOWER($1)
        AND c.verificado IS TRUE
        AND u.deleted_at IS NULL
        AND u.estado IS TRUE
      ORDER BY c.es_principal DESC NULLS LAST, c.id_correo ASC
      LIMIT 1
    `,
    [email]
  );

  return existing.rows?.[0]?.id_usuario || null;
}

async function ensureExchangeInternalUser(app, supabaseUser) {
  const authUserId = String(supabaseUser?.id || "").trim();
  if (!authUserId) {
    throw {
      statusCode: 401,
      message: "Token de Supabase invalido",
      code: "AUTH_SUPABASE_INVALID",
    };
  }

  const existing = await app.db.query(
    `
      SELECT id_usuario
      FROM public.usuarios
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [authUserId]
  );
  if (existing.rowCount) {
    await enforceExchangeClientConsents(app.db, authUserId);
    return { created: false, authUserId, email: null, fullName: null };
  }

  const email = extractEmailFromSupabaseUser(supabaseUser);
  if (!email || !isValidEmail(email)) {
    throw {
      statusCode: 400,
      message: "No se pudo resolver un correo valido desde la identidad social.",
      code: "AUTH_EXCHANGE_EMAIL_REQUIRED",
    };
  }

  const { nombres, apellidos } = buildSocialPersonaNames(supabaseUser);
  const client = await app.db.connect();
  let transactionStarted = false;

  try {
    const clienteRoleId = await getClienteRoleId(client);
    await ensureExchangeEmailAvailability(client, email, authUserId);

    await client.query("BEGIN");
    transactionStarted = true;

    const personaInsert = await client.query(
      `
        INSERT INTO public.personas (nombres, apellidos)
        VALUES ($1, $2)
        RETURNING id_persona
      `,
      [nombres, apellidos]
    );
    const idPersona = personaInsert.rows[0].id_persona;

    await client.query(
      `
        INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
        VALUES ($1::uuid, $2, TRUE, TRUE)
      `,
      [idPersona, email]
    );

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
        VALUES ($1::uuid, $2::uuid, TRUE, $3, NOW(), NULL)
      `,
      [authUserId, idPersona, ACCESS_STATUS.ACTIVE]
    );

    await client.query(
      `
        INSERT INTO public.roles_usuarios (
          id_rol,
          id_usuario,
          id_sucursal,
          activo
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE)
      `,
      [clienteRoleId, authUserId, null]
    );

    await insertClientWithConsents(client, {
      idPersona,
      authUserId,
      branchId: null,
      consentimientoMarketing: true,
      aceptaTerminos: true,
      aceptaTerminosAt: new Date().toISOString(),
      consentimientoMarketingAt: new Date().toISOString(),
    });

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      created: true,
      authUserId,
      email,
      fullName: `${nombres} ${apellidos}`.trim() || null,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error?.code === "23505") {
      if (isEmailConflictError(error)) {
        throw {
          statusCode: 409,
          message: "El correo de Google ya esta vinculado a otra cuenta de MasterFade. Usa tu login actual o contacta soporte.",
          code: "AUTH_EXCHANGE_EMAIL_EXISTS",
        };
      }

      if (isUserIdConflictError(error)) {
        const userNowExists = await app.db.query(
          `
            SELECT 1
            FROM public.usuarios
            WHERE id_usuario = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [authUserId]
        );

        if (userNowExists.rowCount) {
          await enforceExchangeClientConsents(app.db, authUserId);
          return { created: false, authUserId, email: null, fullName: null };
        }
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function syncAccessStateAfterLogin(app, userId) {
  const stateResult = await app.db.query(
    `
      SELECT estado_acceso, credenciales_completadas_at
      FROM public.usuarios
      WHERE id_usuario = $1::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [userId]
  );

  if (!stateResult.rowCount) {
    return { ok: false, code: "AUTH_USER_NOT_ONBOARDED" };
  }

  const currentState = stateResult.rows[0].estado_acceso;
  if (currentState === ACCESS_STATUS.BLOCKED || currentState === ACCESS_STATUS.INACTIVE) {
    return { ok: false, code: "AUTH_ACCESS_BLOCKED", estado_acceso: currentState };
  }

  // AM: Login exitoso actualiza trazabilidad y promueve pendiente_password -> activo.
  const updateResult = await app.db.query(
    `
      UPDATE public.usuarios
      SET estado_acceso = CASE WHEN estado_acceso = $2 THEN $3 ELSE estado_acceso END,
          credenciales_completadas_at = COALESCE(credenciales_completadas_at, NOW()),
          ultimo_login_at = NOW(),
          updated_at = NOW()
      WHERE id_usuario = $1::uuid
      RETURNING estado_acceso, credenciales_completadas_at, ultimo_login_at
    `,
    [userId, ACCESS_STATUS.PENDING_PASSWORD, ACCESS_STATUS.ACTIVE]
  );

  return { ok: true, state: updateResult.rows[0] };
}

export default async function authRoutes(app) {
  app.get("/login", async (request, reply) => {
    return sendOk(
      reply,
      {
        message: "Login endpoint. Usa POST para autenticarte.",
        method: "GET",
      },
      { requestId: request.id }
    );
  });

  app.get(
    "/csrf",
    {
      preHandler: app.authenticate,
      schema: {
        response: csrfResponseSchema,
      },
    },
    async (request, reply) => {
      try {
        let csrfToken = String(request.cookies?.[AUTH_CSRF_COOKIE] || "").trim();
        if (!csrfToken) {
          csrfToken = jwt.sign(
            { type: "csrf", nonce: crypto.randomUUID() },
            app.config?.csrfSecret || process.env.CSRF_SECRET,
            { expiresIn: "12h" }
          );
          reply.setCookie(AUTH_CSRF_COOKIE, csrfToken, buildCsrfCookieOptions(app, { remember: false }));
        }

        return sendOk(reply, { csrf_token: csrfToken }, { requestId: request.id });
      } catch (error) {
        request.log.error({ err: error }, "Auth CSRF token error");
        return sendError(reply, 500, "No se pudo obtener el token CSRF", {
          code: "AUTH_CSRF_ERROR",
          requestId: request.id,
        });
      }
    }
  );

  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        response: meResponseSchema,
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      try {
        const claims = await getAuthClaims(app, request.auth.sub);

        if (!claims) {
          return sendError(reply, 401, "El usuario autenticado no esta vinculado a un usuario interno de Masterfade", {
            code: "AUTH_SESSION_NOT_FOUND",
          });
        }

        return sendOk(reply, claims);
      } catch (error) {
        request.log.error({ err: error }, "Auth /me error");
        return sendError(reply, 500, "No se pudo obtener la sesion actual", {
          code: "AUTH_ME_ERROR",
          details: error instanceof Error ? error.message : "Unknown auth/me error",
        });
      }
    }
  );

  app.post(
    "/exchange",
    {
      config: {
        rateLimit: {
          max: Number(process.env.AUTH_EXCHANGE_RATE_LIMIT_MAX || 20),
          timeWindow: process.env.AUTH_EXCHANGE_RATE_LIMIT_WINDOW || "1 minute",
        },
      },
      schema: {
        body: exchangeBodySchema,
        response: exchangeResponseSchema,
      },
    },
    async (request, reply) => {
      const supabaseToken = extractSupabaseToken(request);
      const replaceActiveSession = request.body?.replace_active_session === true;
      if (!supabaseToken) {
        return sendError(reply, 400, "Debes enviar el token de Supabase para realizar el exchange.", {
          code: "AUTH_MISSING_TOKEN",
        });
      }

      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      if (!app.supabaseAdmin) {
        return sendError(reply, 500, "Supabase Admin no esta configurado en el backend", {
          code: "SUPABASE_ADMIN_NOT_CONFIGURED",
        });
      }

      const jwtSecret = process.env.JWT_SECRET?.trim();
      if (!jwtSecret) {
        return sendError(reply, 500, "Falta JWT_SECRET en la configuracion del servidor", {
          code: "JWT_SECRET_MISSING",
        });
      }

      try {
        const authResult = await app.supabaseAdmin.auth.getUser(supabaseToken);
        const supabaseUser = authResult.data?.user;
        if (authResult.error || !supabaseUser?.id) {
          return sendError(reply, 401, "Token de Supabase invalido o expirado.", {
            code: "AUTH_SUPABASE_INVALID",
            details: authResult.error?.message || "SUPABASE_GET_USER_FAILED",
          });
        }

        const socialAuthUserId = String(supabaseUser.id || "").trim();
        const internalUserExists = await hasInternalUserByAuthId(app.db, socialAuthUserId);
        if (!internalUserExists) {
          const socialEmail = extractEmailFromSupabaseUser(supabaseUser);
          if (!socialEmail || !isValidEmail(socialEmail)) {
            return sendError(reply, 400, "No se pudo resolver un correo valido desde la identidad social.", {
              code: "AUTH_EXCHANGE_EMAIL_REQUIRED",
            });
          }

          if (!app.mailer?.configured) {
            return sendError(reply, 500, "No se pudo iniciar la confirmacion social por correo.", {
              code: "AUTH_SOCIAL_CONFIRM_MAILER_UNAVAILABLE",
              details: "Configura SMTP en backend para enviar confirmaciones de seguridad.",
            });
          }

          const socialNames = buildSocialPersonaNames(supabaseUser);
          const socialConfirmToken = signSocialConfirmToken(
            {
              sub: socialAuthUserId,
              token_type: SOCIAL_CONFIRM_TOKEN_TYPE,
              email: socialEmail,
              nombres: socialNames.nombres,
              apellidos: socialNames.apellidos,
              provider: "google",
            },
            jwtSecret
          );
          const socialConfirmUrl = buildSocialConfirmFrontendUrl(socialConfirmToken);
          const delivery = await app.mailer.sendSocialProvisionConfirmationEmail({
            to: socialEmail,
            actionLink: socialConfirmUrl,
            fullName: `${socialNames.nombres} ${socialNames.apellidos}`.trim() || null,
          });

          if (!delivery?.sent) {
            request.log.error(
              {
                email: socialEmail,
                reason: delivery?.message || "SOCIAL_CONFIRM_EMAIL_NOT_SENT",
              },
              "No se pudo enviar correo de confirmacion para alta social"
            );
            return sendError(reply, 500, "No se pudo enviar el correo de confirmacion de seguridad.", {
              code: "AUTH_SOCIAL_CONFIRM_EMAIL_SEND_FAILED",
            });
          }

          return sendOk(
            reply,
            {
              pending_social_confirmation: true,
              message: "Te enviamos un correo de seguridad para confirmar la creacion de tu perfil.",
              email_masked: maskEmail(socialEmail),
            },
            { statusCode: 202 }
          );
        }

        const provision = await ensureExchangeInternalUser(app, supabaseUser);

        const claims = await getAuthClaims(app, supabaseUser.id);
        if (!claims) {
          return sendError(reply, 403, "Usuario autenticado sin perfil interno activo en Masterfade", {
            code: "AUTH_USER_NOT_ONBOARDED",
          });
        }

        const accessSync = await syncAccessStateAfterLogin(app, claims.user.id_usuario);
        if (!accessSync.ok) {
          if (accessSync.code === "AUTH_ACCESS_BLOCKED") {
            return sendError(reply, 403, "Tu acceso esta bloqueado o inactivo. Contacta al administrador.", {
              code: "AUTH_ACCESS_BLOCKED",
              details: { estado_acceso: accessSync.estado_acceso },
            });
          }
          return sendError(reply, 403, "Usuario autenticado sin perfil interno activo en Masterfade", {
            code: "AUTH_USER_NOT_ONBOARDED",
          });
        }

        if (provision?.created && app.mailer?.configured) {
          try {
            const to = normalizeEmail(provision.email || extractEmailFromSupabaseUser(supabaseUser));
            if (to) {
              const welcomeDelivery = await app.mailer.sendUserWelcomeEmail({
                to,
                fullName: provision.fullName || null,
              });
              if (!welcomeDelivery?.sent) {
                request.log.warn(
                  { email: to, reason: welcomeDelivery?.message || "WELCOME_EMAIL_NOT_SENT_OAUTH" },
                  "Alta OAuth creada sin confirmacion de correo de bienvenida"
                );
              }
            }
          } catch (welcomeError) {
            request.log.warn(
              { err: welcomeError, userId: claims.user.id_usuario },
              "No se pudo enviar correo de bienvenida tras OAuth Google"
            );
          }
        }

        const user = {
          ...claims.user,
          roles: claims.roles,
          branch_ids: claims.branch_ids,
          empresa_id: claims.empresa_id,
          empleado_id: claims.empleado_id,
          cliente_id: claims.cliente_id,
          estado_acceso: accessSync.state?.estado_acceso ?? null,
          credenciales_completadas_at: accessSync.state?.credenciales_completadas_at ?? null,
          ultimo_login_at: accessSync.state?.ultimo_login_at ?? null,
        };

        const session = await issueManagedAppSession(app, request, {
          jwtSecret,
          claims,
          email: user.email ?? extractEmailFromSupabaseUser(supabaseUser) ?? null,
          roles: claims.roles || [],
          branchIds: claims.branch_ids || [],
          remember: true,
          replaceActiveSession,
        });

        const csrfToken = issueSessionCookies(app, reply, session.token, { remember: true });
        return sendOk(reply, { user, csrf_token: csrfToken, session: { authenticated: true } });
      } catch (error) {
        if (error?.statusCode === 409 && error?.code === "AUTH_SESSION_LIMIT_REACHED") {
          return reply.code(409).send({
            ok: false,
            error: {
              code: "AUTH_SESSION_LIMIT_REACHED",
              message: "Ya existe una sesion activa para esta cuenta. Puedes cerrar la sesion anterior y continuar.",
            },
            requires_session_replacement: error?.requires_session_replacement === true,
            requestId: request.id,
          });
        }
        if (error?.statusCode && error?.code) {
          return sendError(reply, error.statusCode, error.message, {
            code: error.code,
            details: error.details,
          });
        }

        request.log.error({ err: error }, "Auth exchange error");
        return sendError(reply, 500, "No se pudo completar el exchange de autenticacion", {
          code: "AUTH_EXCHANGE_ERROR",
        });
      }
    }
  );

  app.post(
    "/social/confirm",
    {
      config: {
        rateLimit: {
          max: Number(process.env.AUTH_SOCIAL_CONFIRM_RATE_LIMIT_MAX || 15),
          timeWindow: process.env.AUTH_SOCIAL_CONFIRM_RATE_LIMIT_WINDOW || "1 minute",
        },
      },
      schema: {
        body: socialConfirmBodySchema,
        response: socialConfirmResponseSchema,
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      if (!app.supabaseAdmin) {
        return sendError(reply, 500, "Supabase Admin no esta configurado en el backend", {
          code: "SUPABASE_ADMIN_NOT_CONFIGURED",
        });
      }

      const jwtSecret = process.env.JWT_SECRET?.trim();
      if (!jwtSecret) {
        return sendError(reply, 500, "Falta JWT_SECRET en la configuracion del servidor", {
          code: "JWT_SECRET_MISSING",
        });
      }

      try {
        const rawToken = String(request.body?.social_confirm_token || "").trim();
        if (!rawToken) {
          return sendError(reply, 400, "Token de confirmacion social requerido.", {
            code: "AUTH_SOCIAL_CONFIRM_TOKEN_REQUIRED",
          });
        }

        let decoded = null;
        try {
          decoded = verifySocialConfirmToken(rawToken, jwtSecret);
        } catch (verifyError) {
          const verifyMessage = String(verifyError?.message || "").trim();
          const isExpired = verifyMessage.includes("jwt expired");
          return sendError(
            reply,
            401,
            isExpired ? "El enlace de confirmacion expiro. Inicia de nuevo con Google." : "Token de confirmacion invalido.",
            {
              code: isExpired ? "AUTH_SOCIAL_CONFIRM_TOKEN_EXPIRED" : "AUTH_SOCIAL_CONFIRM_TOKEN_INVALID",
            }
          );
        }

        const authUserId = String(decoded?.sub || "").trim();
        if (!authUserId || !UUID_REGEX.test(authUserId)) {
          return sendError(reply, 400, "Token de confirmacion social invalido.", {
            code: "AUTH_SOCIAL_CONFIRM_SUB_INVALID",
          });
        }

        const authLookup = await app.supabaseAdmin.auth.admin.getUserById(authUserId);
        const supabaseUser = authLookup?.data?.user;
        if (authLookup?.error || !supabaseUser?.id) {
          return sendError(reply, 401, "No se pudo validar la identidad social para confirmar.", {
            code: "AUTH_SOCIAL_CONFIRM_USER_NOT_FOUND",
          });
        }

        const tokenEmail = normalizeEmail(decoded?.email || "");
        const socialEmail = extractEmailFromSupabaseUser(supabaseUser);
        if (!socialEmail || !isValidEmail(socialEmail)) {
          return sendError(reply, 400, "No se pudo resolver un correo valido de la identidad social.", {
            code: "AUTH_SOCIAL_CONFIRM_EMAIL_REQUIRED",
          });
        }
        if (tokenEmail && tokenEmail !== socialEmail) {
          return sendError(reply, 409, "El correo del token no coincide con la identidad social actual.", {
            code: "AUTH_SOCIAL_CONFIRM_EMAIL_MISMATCH",
          });
        }

        let claimsUserId = authUserId;
        let provision = null;

        const internalUserExists = await hasInternalUserByAuthId(app.db, authUserId);
        if (internalUserExists) {
          provision = await ensureExchangeInternalUser(app, supabaseUser);
        } else {
          const existingUserId = await findActiveInternalUserByConfirmedEmail(app.db, socialEmail);
          if (existingUserId) {
            // AM: El enlace social ya confirmo control del correo; reutiliza la cuenta interna existente.
            claimsUserId = existingUserId;
            provision = { created: false, authUserId: existingUserId, email: socialEmail, fullName: null };
            request.log.info(
              { authUserId, id_usuario: existingUserId, email: socialEmail },
              "Confirmacion social resuelta contra usuario interno existente por correo verificado"
            );
          } else {
            provision = await ensureExchangeInternalUser(app, supabaseUser);
          }
        }

        const claims = await getAuthClaims(app, claimsUserId);
        if (!claims) {
          return sendError(reply, 403, "No se pudo completar la creacion del perfil interno.", {
            code: "AUTH_USER_NOT_ONBOARDED",
          });
        }

        const accessSync = await syncAccessStateAfterLogin(app, claims.user.id_usuario);
        if (!accessSync.ok) {
          if (accessSync.code === "AUTH_ACCESS_BLOCKED") {
            return sendError(reply, 403, "Tu acceso esta bloqueado o inactivo. Contacta al administrador.", {
              code: "AUTH_ACCESS_BLOCKED",
              details: { estado_acceso: accessSync.estado_acceso },
            });
          }
          return sendError(reply, 403, "No se pudo completar tu acceso en MasterFade.", {
            code: "AUTH_USER_NOT_ONBOARDED",
          });
        }

        if (provision?.created && app.mailer?.configured) {
          try {
            const to = normalizeEmail(provision.email || socialEmail);
            if (to) {
              const welcomeDelivery = await app.mailer.sendUserWelcomeEmail({
                to,
                fullName: provision.fullName || null,
              });
              if (!welcomeDelivery?.sent) {
                request.log.warn(
                  { email: to, reason: welcomeDelivery?.message || "WELCOME_EMAIL_NOT_SENT_SOCIAL_CONFIRM" },
                  "Confirmacion social completada sin envio de bienvenida"
                );
              }
            }
          } catch (welcomeError) {
            request.log.warn({ err: welcomeError, authUserId }, "No se pudo enviar correo de bienvenida tras confirmacion social");
          }
        }

        const user = {
          ...claims.user,
          roles: claims.roles,
          branch_ids: claims.branch_ids,
          empresa_id: claims.empresa_id,
          empleado_id: claims.empleado_id,
          cliente_id: claims.cliente_id,
          estado_acceso: accessSync.state?.estado_acceso ?? null,
          credenciales_completadas_at: accessSync.state?.credenciales_completadas_at ?? null,
          ultimo_login_at: accessSync.state?.ultimo_login_at ?? null,
        };

        const session = await issueManagedAppSession(app, request, {
          jwtSecret,
          claims,
          email: user.email ?? socialEmail ?? null,
          roles: claims.roles || [],
          branchIds: claims.branch_ids || [],
          remember: true,
        });

        const csrfToken = issueSessionCookies(app, reply, session.token, { remember: true });
        return sendOk(reply, { user, csrf_token: csrfToken, session: { authenticated: true } });
      } catch (error) {
        if (error?.statusCode && error?.code) {
          return sendError(reply, error.statusCode, error.message, {
            code: error.code,
            details: error.details,
          });
        }

        request.log.error({ err: error }, "Auth social confirm error");
        return sendError(reply, 500, "No se pudo confirmar el acceso social.", {
          code: "AUTH_SOCIAL_CONFIRM_ERROR",
        });
      }
    }
  );

  app.post(
    "/register",
    {
      schema: {
        body: registerBodySchema,
        response: registerResponseSchema,
      },
    },
    async (request, reply) => {
      const body = request.body || {};
      const nombres = normalizeRequiredText(body.nombres);
      const apellidos = normalizeRequiredText(body.apellidos);
      const email = normalizeEmail(body.email);
      const contrasena = String(body.contrasena || "");
      const confirmarContrasena = String(body.confirmar_contrasena || "");
      const consentimientoMarketing = Boolean(body.consentimiento_marketing);
      const aceptaTerminos = body.acepta_terminos === true;
      const aceptaTerminosAt = new Date().toISOString();
      const consentimientoMarketingAt = consentimientoMarketing ? aceptaTerminosAt : null;

      if (!nombres || !apellidos) {
        return sendError(reply, 400, "Nombre y apellido son obligatorios.", {
          code: "AUTH_REGISTER_REQUIRED_NAME",
        });
      }
      if (!email || !isValidEmail(email)) {
        return sendError(reply, 400, "Debes ingresar un correo valido.", {
          code: "AUTH_REGISTER_INVALID_EMAIL",
        });
      }
      const passwordValidationError = validatePublicPassword(contrasena);
      if (passwordValidationError) {
        return sendError(reply, 400, passwordValidationError, {
          code: "AUTH_REGISTER_WEAK_PASSWORD",
        });
      }
      if (contrasena !== confirmarContrasena) {
        return sendError(reply, 400, "La confirmacion de contrasena no coincide.", {
          code: "AUTH_REGISTER_PASSWORD_MISMATCH",
        });
      }
      if (!aceptaTerminos) {
        return sendError(reply, 400, "Debes aceptar terminos y condiciones para crear la cuenta.", {
          code: "AUTH_REGISTER_TERMS_REQUIRED",
        });
      }
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }
      if (!app.supabaseAdmin) {
        return sendError(reply, 500, "Supabase Admin no esta configurado en el backend", {
          code: "SUPABASE_ADMIN_NOT_CONFIGURED",
        });
      }

      const client = await app.db.connect();
      let authUserId = null;
      let transactionStarted = false;

      try {
        await ensureRegisterEmailAvailability(client, email);
        const clienteRoleId = await getClienteRoleId(client);

        const authCreateResult = await app.supabaseAdmin.auth.admin.createUser({
          email,
          password: contrasena,
          email_confirm: true,
          user_metadata: {
            full_name: `${nombres} ${apellidos}`.trim(),
            source: "public_register",
          },
        });

        if (authCreateResult.error || !authCreateResult.data?.user?.id) {
          if (isSupabaseDuplicateError(authCreateResult.error)) {
            return sendError(reply, 409, "El correo ya esta registrado.", {
              code: "AUTH_REGISTER_EMAIL_EXISTS",
            });
          }
          return sendError(reply, 500, "No se pudo crear la identidad de autenticacion.", {
            code: "AUTH_REGISTER_AUTH_CREATE_ERROR",
            details: authCreateResult.error?.message || "AUTH_CREATE_FAILED",
          });
        }

        authUserId = authCreateResult.data.user.id;

        await client.query("BEGIN");
        transactionStarted = true;

        const personaInsert = await client.query(
          `
            INSERT INTO public.personas (nombres, apellidos)
            VALUES ($1, $2)
            RETURNING id_persona
          `,
          [nombres, apellidos]
        );
        const idPersona = personaInsert.rows[0].id_persona;

        await client.query(
          `
            INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
            VALUES ($1::uuid, $2, TRUE, TRUE)
          `,
          [idPersona, email]
        );

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
            VALUES ($1::uuid, $2::uuid, TRUE, $3, NOW(), NULL)
          `,
          [authUserId, idPersona, ACCESS_STATUS.ACTIVE]
        );

        await client.query(
          `
            INSERT INTO public.roles_usuarios (
              id_rol,
              id_usuario,
              id_sucursal,
              activo
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE)
          `,
          [clienteRoleId, authUserId, null]
        );

        const idCliente = await insertClientWithConsents(client, {
          idPersona,
          authUserId,
          branchId: null,
          consentimientoMarketing,
          aceptaTerminos,
          aceptaTerminosAt,
          consentimientoMarketingAt,
        });

        await client.query("COMMIT");
        transactionStarted = false;

        if (app.mailer?.configured) {
          try {
            const fullName = `${nombres} ${apellidos}`.trim() || null;
            const welcomeDelivery = await app.mailer.sendUserWelcomeEmail({
              to: email,
              fullName,
            });
            if (!welcomeDelivery?.sent) {
              request.log.warn(
                { email, reason: welcomeDelivery?.message || "WELCOME_EMAIL_NOT_SENT" },
                "Registro publico creado sin confirmacion de correo de bienvenida"
              );
            }
          } catch (welcomeError) {
            request.log.warn({ err: welcomeError, email }, "No se pudo enviar correo de bienvenida tras registro publico");
          }
        }

        return sendOk(
          reply,
          {
            user: {
              id_usuario: authUserId,
              id_persona: idPersona,
              id_cliente: idCliente,
              email,
              nombres,
              apellidos,
              estado_acceso: ACCESS_STATUS.ACTIVE,
            },
            cliente: {
              id_cliente: idCliente,
              id_sucursal_origen: null,
              estado: true,
            },
            consentimientos: {
              acepta_terminos: true,
              acepta_terminos_at: aceptaTerminosAt,
              consentimiento_marketing: consentimientoMarketing,
              consentimiento_marketing_at: consentimientoMarketingAt,
            },
          },
          { statusCode: 201, requestId: request.id }
        );
      } catch (error) {
        if (transactionStarted) {
          await client.query("ROLLBACK").catch(() => { });
        }
        if (authUserId) {
          // AM: Compensacion segura para no dejar auth.users huerfano si falla el dominio interno.
          const rollback = await app.supabaseAdmin.auth.admin.deleteUser(authUserId);
          if (rollback.error) {
            request.log.error(
              { err: rollback.error, authUserId },
              "Compensacion de auth.users fallo durante registro publico"
            );
          }
        }

        if (error?.statusCode && error?.code) {
          return sendError(reply, error.statusCode, error.message, {
            code: error.code,
            details: error.details,
          });
        }

        if (error?.code === "23505") {
          return sendError(reply, 409, "El correo ya esta registrado.", {
            code: "AUTH_REGISTER_EMAIL_EXISTS",
          });
        }

        request.log.error({ err: error }, "Public register error");
        return sendError(reply, 500, "No se pudo completar el registro de cliente.", {
          code: "AUTH_REGISTER_ERROR",
          details: error instanceof Error ? error.message : "Unknown register error",
        });
      } finally {
        client.release();
      }
    }
  );

  app.post("/forgot-password", {
    config: {
      rateLimit: {
        max: Number(process.env.AUTH_FORGOT_RATE_LIMIT_MAX || 10),
        timeWindow: process.env.AUTH_FORGOT_RATE_LIMIT_WINDOW || "1 minute",
      },
    },
  }, async (request, reply) => {
    const email = normalizeEmail(request.body?.email);

    if (!email || !email.includes("@")) {
      return sendError(reply, 400, "Correo invalido", {
        code: "AUTH_INVALID_EMAIL",
      });
    }

    const rateLimitState = registerResetAttempt(email);

    if (rateLimitState.blocked) {
      reply.header("Retry-After", String(rateLimitState.retryAfterSeconds));
      request.log.warn({ event: "auth_forgot_password_rate_limited", email }, "Forgot-password rate limited");

      return sendError(reply, 429, "Demasiados intentos para este correo. Intenta mas tarde.", {
        code: "AUTH_RESET_RATE_LIMIT",
        details: {
          retryAfterSeconds: rateLimitState.retryAfterSeconds,
          rateLimit: rateLimitState.rateLimit,
        },
      });
    }

    if (!app.supabaseAdmin) {
      return sendError(reply, 500, "Supabase Admin no esta configurado en el backend", {
        code: "SUPABASE_ADMIN_NOT_CONFIGURED",
      });
    }

    if (!app.mailer?.configured) {
      return sendError(reply, 500, "Servicio SMTP no configurado en backend", {
        code: "MAILER_NOT_CONFIGURED",
      });
    }

    try {
      // AM: Flujo Opcion 2: generar recovery link con Supabase Admin y enviar correo desde backend SMTP.
      const recovery = await generateRecoveryActionLink(app, email);
      if (recovery.found) {
        let fullName = null;
        try {
          fullName = await resolvePasswordRecipientFullNameByEmail(app, email);
        } catch (lookupError) {
          request.log.warn({ err: lookupError, email }, "No se pudo resolver fullName para correo de recuperacion");
        }

        const delivery = await app.mailer.sendPasswordRecoveryEmail({
          to: email,
          actionLink: recovery.action_link,
          fullName,
          kind: "reset",
        });

        if (!delivery.sent) {
          request.log.error({ email, delivery }, "No se pudo enviar recovery email por SMTP");
        }
      }
    } catch (error) {
      request.log.error({ err: error, email }, "No se pudo procesar forgot-password");
      return sendError(reply, 500, "No se pudo iniciar la recuperacion de contrasena", {
        code: "AUTH_RESET_ERROR",
        details: error instanceof Error ? error.message : "Unknown forgot-password error",
      });
    }

    return sendOk(reply, {
      message: "Si el correo existe, recibiras un enlace para restablecer tu contrasena.",
      rateLimit: rateLimitState.rateLimit,
    });
  });

  app.post(
    "/login",
    {
      config: {
        rateLimit: {
          max: Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX || 20),
          timeWindow: process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW || "15 minutes",
        },
      },
      schema: {
        body: loginBodySchema,
        response: loginResponseSchema,
      },
    },
    async (request, reply) => {
      const body = request.body || {};
      // AM: Alias de compatibilidad temporal, pero la credencial oficial de Fase 1 es correo.
      const identifier = normalizeEmail(
        body.identifier ?? body.email ?? body.nombre_usuario ?? body.username ?? ""
      );
      const contrasena = String(body.contrasena ?? body.password ?? "");
      const remember = body.remember === true;
      const replaceActiveSession = body.replace_active_session === true;

      if (!identifier || !contrasena) {
        return sendError(reply, 400, "Faltan credenciales: se requiere correo y contrasena", {
          code: "AUTH_MISSING_CREDENTIALS",
        });
      }

      if (!isValidEmail(identifier)) {
        return sendError(reply, 400, "El login de esta etapa requiere un correo valido", {
          code: "AUTH_IDENTIFIER_EMAIL_REQUIRED",
        });
      }

      const jwtSecret = process.env.JWT_SECRET?.trim();
      if (!jwtSecret) {
        return sendError(reply, 500, "Falta JWT_SECRET en la configuracion del servidor", {
          code: "JWT_SECRET_MISSING",
        });
      }

      try {
        if (!app.db) {
          return sendError(reply, 500, "Base de datos no configurada", {
            code: "DB_NOT_CONFIGURED",
          });
        }

        const protectionState = await getLoginProtectionState(app, request, { identifier });
        if (protectionState.blocked) {
          await logLoginAttempt(app, request, {
            id_usuario: null,
            identifier,
            provider: "supabase_password",
            resultado: "blocked",
            motivo_codigo: "LOGIN_RATE_LIMITED",
            metadata: {
              auth_stage: "password_login",
            },
          });
          return sendError(reply, 429, "No fue posible iniciar sesion en este momento. Intenta nuevamente mas tarde.", {
            code: "AUTH_LOGIN_RATE_LIMITED",
          });
        }

        await applyProgressiveLoginDelay(protectionState.delayMs || 0);

        if (!app.supabase) {
          return sendError(reply, 500, "Supabase Auth no esta configurado en el backend", {
            code: "SUPABASE_NOT_CONFIGURED",
            details: "Configura SUPABASE_URL y SUPABASE_ANON_KEY en el entorno del backend.",
          });
        }

        const { data, error } = await app.supabase.auth.signInWithPassword({
          email: identifier,
          password: contrasena,
        });

        if (error || !data?.user?.id) {
          const reason = inferFailedLoginReason(error);
          await registerFailedLoginAttempt(app, request, {
            identifier,
            provider: "supabase_password",
            motivo_codigo: reason,
          });
          request.log.warn({ event: "auth_login_failed", reason }, "Login failed");
          return sendError(reply, 401, "Credenciales invalidas o acceso no permitido.", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        // AM: Validacion de autorizacion interna: no emitimos APP JWT si no existe usuario activo en public.usuarios.
        const claims = await getAuthClaims(app, data.user.id);
        if (!claims) {
          return sendError(reply, 401, "Credenciales invalidas o acceso no permitido.", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        const accessSync = await syncAccessStateAfterLogin(app, claims.user.id_usuario);
        if (!accessSync.ok) {
          return sendError(reply, 401, "Credenciales invalidas o acceso no permitido.", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        const tempLock = await checkUserTemporaryLock(app, { idUsuario: claims.user.id_usuario });
        if (tempLock.ok && tempLock.blocked) {
          await logLoginAttempt(app, request, {
            id_usuario: claims.user.id_usuario,
            identifier,
            provider: "supabase_password",
            resultado: "blocked",
            motivo_codigo: "LOGIN_TEMPORARILY_LOCKED",
            metadata: {
              auth_stage: "password_login",
            },
          });
          return sendError(reply, 429, "No fue posible iniciar sesion en este momento. Intenta nuevamente mas tarde.", {
            code: "AUTH_USER_TEMPORARILY_LOCKED",
          });
        }

        await registerSuccessfulLogin(app, request, { idUsuario: claims.user.id_usuario });

        const user = {
          ...claims.user,
          roles: claims.roles,
          branch_ids: claims.branch_ids,
          empresa_id: claims.empresa_id,
          empleado_id: claims.empleado_id,
          cliente_id: claims.cliente_id,
          estado_acceso: accessSync.state?.estado_acceso ?? null,
          credenciales_completadas_at: accessSync.state?.credenciales_completadas_at ?? null,
          ultimo_login_at: accessSync.state?.ultimo_login_at ?? null,
        };

        const session = await issueManagedAppSession(app, request, {
          jwtSecret,
          claims,
          email: user.email ?? data.user.email ?? null,
          roles: claims.roles || [],
          branchIds: claims.branch_ids || [],
          remember,
          replaceActiveSession,
          identifier,
          provider: "supabase_password",
        });

        const csrfToken = issueSessionCookies(app, reply, session.token, { remember });
        await logLoginAttempt(app, request, {
          id_usuario: claims.user.id_usuario,
          identifier,
          provider: "supabase_password",
          resultado: "success",
          motivo_codigo: "LOGIN_SUCCESS",
          metadata: {
            auth_stage: "password_login",
          },
        });
        request.log.info({ event: "auth_login_success", userId: claims.user.id_usuario }, "Login success");
        return sendOk(reply, { user, csrf_token: csrfToken, session: { authenticated: true } });
      } catch (error) {
        if (error?.statusCode === 409 && error?.code === "AUTH_SESSION_LIMIT_REACHED") {
          return reply.code(409).send({
            ok: false,
            error: {
              code: "AUTH_SESSION_LIMIT_REACHED",
              message: "Ya existe una sesion activa para esta cuenta. Puedes cerrar la sesion anterior y continuar.",
            },
            requires_session_replacement: error?.requires_session_replacement === true,
            requestId: request.id,
          });
        }
        const message = error instanceof Error ? error.message : "Unknown login error";
        await logLoginAttempt(app, request, {
          id_usuario: null,
          identifier,
          provider: "supabase_password",
          resultado: "error",
          motivo_codigo: "LOGIN_INTERNAL_ERROR",
          metadata: {
            auth_stage: "password_login",
          },
        });
        request.log.error({ event: "auth_login_error", code: "AUTH_LOGIN_ERROR" }, "Login error");

        return sendError(reply, 500, "Error al procesar login", {
          code: "AUTH_LOGIN_ERROR",
          details: message,
        });
      }
    }
  );

  app.post(
    "/logout",
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  logged_out: { type: "boolean" },
                },
                required: ["logged_out"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      clearSessionCookies(app, reply);
      const closed = await closeActiveSession(app, request, {
        sid: String(request.auth?.sid || ""),
        id_usuario: String(request.auth?.sub || ""),
        cerrada_por: String(request.auth?.sub || ""),
        motivo_cierre: "logout_usuario",
      });
      if (!closed.ok) {
        request.log.error(
          { event: "auth_logout_session_close_failed", code: closed.code || "AUTH_SESSION_CLOSE_ERROR" },
          "Logout session close failed"
        );
      }
      request.log.info({ event: "auth_logout", userId: request.auth?.sub || null }, "Logout success");
      return sendOk(reply, { logged_out: true }, { requestId: request.id });
    }
  );
}

