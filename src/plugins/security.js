import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";

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
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    credentials: true,
    // Permitir el preflight cacheado por 1 hora en el browser
    maxAge: 3600,
  });

  await app.register(helmet);

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX || 200),
    timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute"
  });

  await app.register(cookie);
  await app.register(formbody);
}

// Esto hace el plugin GLOBAL (sin encapsulación)
export default fp(securityPlugin, { name: "security-plugin" });

