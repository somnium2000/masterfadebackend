import jwt from "jsonwebtoken";
import { getAuthClaims } from "../../utils/authClaims.js";
import { sendOk } from "../../utils/response.js";
import { sendError } from "../../utils/errors.js";

const loginBodySchema = {
  type: "object",
  properties: {
    nombre_usuario: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", minLength: 1 },
    contrasena: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
  },
  anyOf: [{ required: ["nombre_usuario"] }, { required: ["username"] }, { required: ["email"] }],
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

    if (!app.supabase) {
      return sendError(reply, 500, "Supabase Auth no esta configurado en el backend", {
        code: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim();
    const redirectTo = `${frontendUrl}/login`;
    const { error } = await app.supabase.auth.resetPasswordForEmail(email, { redirectTo });

    if (error) {
      const message = error.message || "Unknown reset password error";

      if (message.toLowerCase().includes("rate limit")) {
        return sendError(reply, 429, "Rate limit del proveedor de correo alcanzado. Intenta mas tarde.", {
          code: "SUPABASE_EMAIL_RATE_LIMIT",
        });
      }

      return sendError(reply, 500, "No se pudo iniciar la recuperacion de contrasena", {
        code: "AUTH_RESET_ERROR",
        details: message,
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
      const nombreUsuario = String(body.nombre_usuario ?? body.username ?? body.email ?? "").trim();
      const contrasena = String(body.contrasena ?? body.password ?? "").trim();

      if (!nombreUsuario || !contrasena) {
        return sendError(reply, 400, "Faltan credenciales: se requiere usuario y contrasena", {
          code: "AUTH_MISSING_CREDENTIALS",
        });
      }

      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      const jwtSecret = process.env.JWT_SECRET?.trim();
      if (!jwtSecret) {
        return sendError(reply, 500, "Falta JWT_SECRET en la configuracion del servidor", {
          code: "JWT_SECRET_MISSING",
        });
      }

      try {
        const isEmail = nombreUsuario.includes("@");

        if (isEmail) {
          if (!app.supabase) {
            return sendError(reply, 500, "Supabase Auth no esta configurado en el backend", {
              code: "SUPABASE_NOT_CONFIGURED",
              details: "Configura SUPABASE_URL y SUPABASE_ANON_KEY en el entorno del backend.",
            });
          }

          const { data, error } = await app.supabase.auth.signInWithPassword({
            email: nombreUsuario,
            password: contrasena,
          });

          if (error || !data?.user) {
            return sendError(reply, 401, error?.message || "Credenciales invalidas", {
              code: "AUTH_INVALID_CREDENTIALS",
            });
          }

          const supabaseUser = data.user;
          const token = signAppToken(
            {
              sub: String(supabaseUser.id),
              email: supabaseUser.email,
              token_type: "app",
              "mf:roles": [],
            },
            jwtSecret
          );

          return sendOk(reply, {
            token,
            user: {
              id_usuario: supabaseUser.id,
              email: supabaseUser.email,
            },
          });
        }

        const { rows } = await app.db.query("SELECT public.fn_login_usuario($1, $2) AS result", [
          nombreUsuario,
          contrasena,
        ]);

        const result = rows?.[0]?.result;

        if (!result || result.ok !== true) {
          return sendError(reply, 401, result?.message || "Credenciales invalidas", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        const user = result.user;
        const token = signAppToken(
          {
            sub: String(user.id_usuario),
            nombre_usuario: user.nombre_usuario,
            "mf:roles": user.roles || [],
            "mf:branch_ids": user.branch_ids || [],
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
          details: message.includes("fn_login_usuario")
            ? "La funcion public.fn_login_usuario no existe."
            : message,
        });
      }
    }
  );
}
