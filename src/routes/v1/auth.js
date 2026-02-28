import { sendOk } from "../../utils/response.js";
import { sendError } from "../../utils/errors.js";

// ── JSON Schemas (Fastify usa Ajv internamente) ──

const loginBodySchema = {
  type: "object",
  properties: {
    nombre_usuario: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    email: { type: "string", minLength: 1 },
    contrasena: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
  },
  // Al menos uno de los campos de usuario y uno de password
  anyOf: [
    { required: ["nombre_usuario"] },
    { required: ["username"] },
    { required: ["email"] },
  ],
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
          user: { type: "object" },
        },
      },
      requestId: { type: "string" },
    },
  },
};
// ── Rate limit por email para recuperación de contraseña ──
const RESET_MAX_ATTEMPTS = Number(process.env.RESET_MAX_ATTEMPTS || 3);       // intentos permitidos
const RESET_WINDOW_MS = Number(process.env.RESET_WINDOW_MS || 15 * 60_000);   // ventana (15 min)
const RESET_BLOCK_MS = Number(process.env.RESET_BLOCK_MS || 30 * 60_000);     // bloqueo (30 min)

const resetAttemptsByEmail = new Map();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function registerResetAttempt(emailKey) {
  const now = Date.now();
  let rec = resetAttemptsByEmail.get(emailKey);

  if (!rec) {
    rec = { count: 0, windowStart: now, blockedUntil: 0 };
  }

  const windowSeconds = Math.ceil(RESET_WINDOW_MS / 1000);
  const blockSeconds = Math.ceil(RESET_BLOCK_MS / 1000);

  // Si está bloqueado
  if (rec.blockedUntil && now < rec.blockedUntil) {
    const retryAfterSeconds = Math.ceil((rec.blockedUntil - now) / 1000);
    return {
      blocked: true,
      retryAfterSeconds,
      rateLimit: {
        max: RESET_MAX_ATTEMPTS,
        remaining: 0,
        windowSeconds,
        resetInSeconds: Math.ceil((rec.windowStart + RESET_WINDOW_MS - now) / 1000),
        blockSeconds,
      },
    };
  }

  // Si se pasó la ventana, reinicia conteo
  if (now - rec.windowStart > RESET_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }

  rec.count += 1;

  // Si excede, bloquea
  if (rec.count > RESET_MAX_ATTEMPTS) {
    rec.blockedUntil = now + RESET_BLOCK_MS;
    resetAttemptsByEmail.set(emailKey, rec);

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

  resetAttemptsByEmail.set(emailKey, rec);

  const remaining = Math.max(0, RESET_MAX_ATTEMPTS - rec.count);
  const resetInSeconds = Math.max(
    0,
    Math.ceil((rec.windowStart + RESET_WINDOW_MS - now) / 1000)
  );

  return {
    blocked: false,
    rateLimit: {
      max: RESET_MAX_ATTEMPTS,
      remaining,
      windowSeconds,
      resetInSeconds,
      blockSeconds,
    },
  };
}

export default async function authRoutes(app) {
  // GET placeholder (compatibilidad)
  app.get("/login", async (request) => {
    return {
      ok: true,
      message: "Login endpoint — usa POST para autenticarte",
      method: "GET",
      requestId: request.id,
    };
  });
  // ── POST /v1/auth/forgot-password ──
  app.post("/forgot-password", async (request, reply) => {
    const email = normalizeEmail(request.body?.email);

    if (!email || !email.includes("@")) {
      return sendError(reply, 400, "Correo inválido", {
        code: "AUTH_INVALID_EMAIL",
      });
    }

    // 1) Rate limit por correo (bloquea solo el que spamea)
    const emailKey = email;
    const rl = registerResetAttempt(emailKey);

if (rl.blocked) {
  reply.header("Retry-After", String(rl.retryAfterSeconds));

  return sendError(
    reply,
    429,
    "Demasiados intentos para este correo. Intenta más tarde.",
    {
      code: "AUTH_RESET_RATE_LIMIT",
      details: {
        retryAfterSeconds: rl.retryAfterSeconds,
        rateLimit: rl.rateLimit,
      },
    }
  );
}

    // 2) Llamada a Supabase (envía email)
    if (!app.supabase) {
      return sendError(reply, 500, "Supabase Auth no está configurado en el backend", {
        code: "SUPABASE_NOT_CONFIGURED",
      });
    }

    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim();
    const redirectTo = `${frontendUrl}/login`;

    const { error } = await app.supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    // 3) Si Supabase rate-limiteó (global), te lo digo claro
    if (error) {
      const msg = error.message || "Error desconocido";
      if (msg.toLowerCase().includes("rate limit")) {
        return sendError(reply, 429, "Rate limit del proveedor de correo alcanzado. Intenta más tarde.", {
          code: "SUPABASE_EMAIL_RATE_LIMIT",
        });
      }
      return sendError(reply, 500, "No se pudo iniciar la recuperación de contraseña", {
        code: "AUTH_RESET_ERROR",
        details: msg,
      });
    }

    // 4) Respuesta segura (no revela si el email existe o no)
    return sendOk(reply, {
      message: "Si el correo existe, recibirás un enlace para restablecer tu contraseña.",
      rateLimit: rl.rateLimit,
    });
  });
  // ── POST /v1/auth/login ──
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

      const nombreUsuario = String(
        body.nombre_usuario ?? body.username ?? body.email ?? ""
      ).trim();

      const contrasena = String(
        body.contrasena ?? body.password ?? ""
      ).trim();

      if (!nombreUsuario || !contrasena) {
        return sendError(reply, 400, "Faltan credenciales: se requiere usuario y contraseña", {
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
        return sendError(reply, 500, "Falta JWT_SECRET en la configuración del servidor", {
          code: "JWT_SECRET_MISSING",
        });
      }

            try {
        // ✅ 1) Si parece email, autenticamos con Supabase Auth (email+password)
        const isEmail = nombreUsuario.includes("@");

        if (isEmail) {
          if (!app.supabase) {
            return sendError(reply, 500, "Supabase Auth no está configurado en el backend", {
              code: "SUPABASE_NOT_CONFIGURED",
              details: "Configura SUPABASE_URL y SUPABASE_ANON_KEY en el .env del backend.",
            });
          }

          const { data, error } = await app.supabase.auth.signInWithPassword({
            email: nombreUsuario,
            password: contrasena,
          });

          if (error || !data?.user) {
            return sendError(reply, 401, error?.message || "Credenciales inválidas", {
              code: "AUTH_INVALID_CREDENTIALS",
            });
          }

          const sbUser = data.user;

          const jwtModule = await import("jsonwebtoken");
          const jwt = jwtModule.default;

          const token = jwt.sign(
            {
              sub: String(sbUser.id),
              email: sbUser.email,
              token_type: "app",
              // Claims para evitar colisión con Supabase JWT
              "mf:roles": [], // luego lo conectamos con tu tabla roles si quieres
            },
            jwtSecret,
            {
              expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "12h",
              issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
              audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
            }
          );

          return sendOk(reply, {
            token,
            user: {
              id_usuario: sbUser.id,
              email: sbUser.email,
            },
          });
        }

        // ✅ 2) Si NO es email, usa tu flow legacy con función SQL (username/password interno)
        const { rows } = await app.db.query(
          "SELECT public.fn_login_usuario($1, $2) AS result",
          [nombreUsuario, contrasena]
        );

        const result = rows?.[0]?.result;

        if (!result || result.ok !== true) {
          return sendError(reply, 401, result?.message || "Credenciales inválidas", {
            code: "AUTH_INVALID_CREDENTIALS",
          });
        }

        const user = result.user;

        const jwtModule = await import("jsonwebtoken");
        const jwt = jwtModule.default;

        const token = jwt.sign(
          {
            sub: String(user.id_usuario),
            nombre_usuario: user.nombre_usuario,
            "mf:roles": user.roles || [],
            "mf:branch_ids": user.branch_ids || [],
            token_type: "app",
          },
          jwtSecret,
          {
            expiresIn: process.env.JWT_EXPIRES_IN?.trim() || "12h",
            issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
            audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
          }
        );

        return sendOk(reply, { token, user });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Error desconocido en login";
        request.log.error({ err: error }, "Login error");

        return sendError(reply, 500, "Error al procesar login", {
          code: "AUTH_LOGIN_ERROR",
          details:
            msg.includes("fn_login_usuario")
              ? "La función public.fn_login_usuario no existe."
              : msg,
        });
      }
    }
  );
}
