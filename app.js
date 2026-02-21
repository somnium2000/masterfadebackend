import Fastify from "fastify";
import dotenv from "dotenv";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
dotenv.config();

const app = Fastify({
  logger: true
});

// CORS para Vite (React)
await app.register(cors, {
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  credentials: true
});

// Headers de seguridad
await app.register(helmet);

// Rate limit global 
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX || 200),
  timeWindow: process.env.RATE_LIMIT_WINDOW || "1 minute"
});

//  Cookies 
await app.register(cookie);

// para recibir form-data urlencoded (formularios)
await app.register(formbody);

// health check
app.get("/health", async () => ({ ok: true }));

const PORT = Number(process.env.PORT || 3002);

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}