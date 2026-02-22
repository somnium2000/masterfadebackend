import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";

async function securityPlugin(app) {
  // Permite 1 origen (CORS_ORIGIN) o varios (CORS_ORIGINS separados por coma)
  const rawOrigins =
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
    credentials: true
  });

  await app.register(helmet);

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX || 200),
    timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute"
  });

  await app.register(cookie);
  await app.register(formbody);
}

// ✅ Esto hace el plugin GLOBAL (sin encapsulación)
export default fp(securityPlugin, { name: "security-plugin" });
