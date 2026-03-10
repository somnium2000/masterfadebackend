import jwt from "jsonwebtoken";
import { getAuthClaims } from "../../utils/authClaims.js";
import { sendOk } from "../../utils/response.js";
import { sendError } from "../../utils/errors.js";
import { generateRecoveryActionLink } from "../../services/authRecovery.js";

const loginBodySchema = {
  type: "object",
  properties: {
    identifier: { type: "string", minLength: 1 },
    nombre_usuario: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", minLength: 1 },
    contrasena: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
  },
  anyOf: [
    { required: ["identifier"] },
    { required: ["email"] },
    { required: ["nombre_usuario"] },
    { required: ["username"] },
  ],
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
          token: { type: "string" },
          user: { type: "object", additionalProperties: true },
        },
        required: ["token", "user"],
        additionalProperties: true,
      },
      requestId: requestIdSchema,
    },
    required: ["ok", "data"],
    additionalProperties: true,
  },
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
            },
            required: ["id_usuario", "id_persona", "email", "nombres", "apellidos"],
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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
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

function signAppToken(payload, jwtSecret) {
  return jwt.sign(payload, jwtSecret, {
    expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "12h",
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
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
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        headers: {
          type: "object",
          properties: {
            authorization: { type: "string" },
          },
        },
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

  app.post("/forgot-password", async (request, reply) => {
    const email = normalizeEmail(request.body?.email);

    if (!email || !email.includes("@")) {
      return sendError(reply, 400, "Correo invalido", {
        code: "AUTH_INVALID_EMAIL",
      });
    }

    const rateLimitState = registerResetAttempt(email);

    if (rateLimitState.blocked) {
      reply.header("Retry-After", String(rateLimitState.retryAfterSeconds));

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
        const delivery = await app.mailer.sendPasswordRecoveryEmail({
          to: email,
          actionLink: recovery.action_link,
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
      const contrasena = String(body.contrasena ?? body.password ?? "").trim();

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
          return sendError(reply, 401, error?.message || "Credenciales invalidas", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        // AM: Validacion de autorizacion interna: no emitimos APP JWT si no existe usuario activo en public.usuarios.
        const claims = await getAuthClaims(app, data.user.id);
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

        const token = signAppToken(
          {
            sub: String(claims.user.id_usuario),
            email: user.email ?? data.user.email ?? null,
            "mf:roles": claims.roles || [],
            "mf:branch_ids": claims.branch_ids || [],
            token_type: "app",
          },
          jwtSecret
        );

        return sendOk(reply, { token, user });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown login error";
        request.log.error({ err: error }, "Login error");

        return sendError(reply, 500, "Error al procesar login", {
          code: "AUTH_LOGIN_ERROR",
          details: message,
        });
      }
    }
  );
}
