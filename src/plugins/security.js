import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyRawBody from "fastify-raw-body";

const CSRF_HEADER = "x-csrf-token";
const SESSION_COOKIE_NAME = "mf_session";
const CSRF_COOKIE_NAME = "mf_csrf";
const CSRF_EXEMPT_PATHS = [
  "/v1/auth/login",
  "/v1/auth/exchange",
  "/v1/auth/social/confirm",
  "/v1/auth/register",
  "/v1/auth/forgot-password",
  "/v1/auth/reset-password",
  "/v1/pagos/webhook/mock",
  "/v1/pagos/webhook/banpais",
];

function parseBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function isUnsafeMethod(method) {
  const normalized = String(method || "").toUpperCase();
  return ["POST", "PUT", "PATCH", "DELETE"].includes(normalized);
}

function isCsrfExemptPath(pathname) {
  const path = String(pathname || "");
  return CSRF_EXEMPT_PATHS.some((allowed) => path === allowed || path.endsWith(allowed));
}

async function securityPlugin(app) {
  // Lee CORS_ORIGENES (nombre canónico del proyecto) con fallback a CORS_ORIGINS y default local
  const rawOrigins =
    process.env.CORS_ORIGENES ||
    process.env.CORS_ORIGINS ||
    process.env.CORS_ORIGIN ||
    "http://localhost:5173";

  const allowedOrigins = rawOrigins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: (origin, cb) => {
      // Postman/curl no mandan Origin -> permitir
      if (!origin) return cb(null, true);

      // Permitir solo los configurados
      if (allowedOrigins.includes(origin)) return cb(null, true);

      // Bloquear lo demás
      return cb(null, false);
    },
    // Declarar TODOS los métodos que la API utiliza para que el preflight (OPTIONS) los autorice
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-CSRF-Token"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    credentials: true,
    // Permitir el preflight cacheado por 1 hora en el browser
    maxAge: 3600,
  });

  await app.register(helmet);

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX || 200),
    timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute",
    keyGenerator: (request) => `${request.ip}:${request.routerPath || request.url}`,
    errorResponseBuilder: (request) => ({
      ok: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Demasiadas solicitudes. Intenta mas tarde.",
      },
      requestId: request.id,
    }),
  });

  await app.register(cookie, {
    secret: app.config?.cookieSecret || process.env.COOKIE_SECRET,
    hook: "onRequest",
    parseOptions: {
      httpOnly: true,
      secure: parseBoolean(process.env.AUTH_COOKIE_SECURE, app.config?.isProduction),
      sameSite: app.config?.cookieSameSite || "lax",
      path: "/",
    },
  });
  await app.register(formbody);
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!isUnsafeMethod(request.method)) return;

    const routePath = String(request.routerPath || request.routeOptions?.url || "");
    if (isCsrfExemptPath(routePath)) return;

    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionCookie) return;

    const csrfCookie = request.cookies?.[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers?.[CSRF_HEADER];
    const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;

    if (!csrfCookie || !csrfToken || csrfCookie !== csrfToken) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: "CSRF_TOKEN_INVALID",
          message: "Solicitud invalida.",
        },
        requestId: request.id,
      });
    }
  });
}

// Esto hace el plugin GLOBAL (sin encapsulación)
export default fp(securityPlugin, { name: "security-plugin" });

