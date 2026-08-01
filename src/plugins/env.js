import dotenv from "dotenv";
import fp from "fastify-plugin";
import { parseStrictBooleanEnv } from "../config/bookingConfig.js";
import { resolveTodoPagoConfig } from "../services/payments/todopago/todoPagoConfig.js";

function normalizeNodeEnv(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["production", "prod"].includes(value)) return "production";
  if (["staging", "preprod"].includes(value)) return "staging";
  if (["test", "testing"].includes(value)) return "test";
  return "development";
}

function parseBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseRequiredBoolean(value, name, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["true", "false"].includes(raw)) return raw === "true";
  throw new Error(`${name} invalido. Usa true o false.`);
}

function parseIntegerInRange(value, name, { fallback, min, max }) {
  const raw = String(value ?? "").trim();
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} invalido. Debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

function readRequired(name, { minLength = 1 } = {}) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minLength) {
    throw new Error(`ENV requerida faltante o invalida: ${name}`);
  }
  return value;
}

export function resolveBookingReleaseTokenSecret(nodeEnv) {
  const normalizedNodeEnv = normalizeNodeEnv(nodeEnv);
  const configured = String(process.env.BOOKING_RELEASE_TOKEN_SECRET || "").trim();

  if (normalizedNodeEnv === "test" && !configured) {
    return "masterfade-test-release-token-secret-32";
  }

  if (configured.length < 32) {
    throw new Error("BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres.");
  }

  return configured;
}

function assertSecureProductionConfig(config) {
  if (config.nodeEnv !== "production" && config.nodeEnv !== "staging") return;

  if (!config.frontendUrl.startsWith("https://")) {
    throw new Error("FRONTEND_URL debe usar HTTPS en produccion/staging.");
  }

  if (config.paymentProvider === "mock") {
    throw new Error("PAYMENT_PROVIDER=mock esta prohibido en produccion/staging.");
  }

  if (!config.cookieSecure) {
    throw new Error("AUTH_COOKIE_SECURE debe estar activo en produccion/staging.");
  }

  if (!config.bookingReleaseTokenSecret || config.bookingReleaseTokenSecret.length < 32) {
    throw new Error("BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres.");
  }
}

function parseCorsOrigins(rawValue, fallback = "http://localhost:5173") {
  const raw = String(rawValue || fallback);
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function envPlugin(app) {
  dotenv.config();

  const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV || process.env.ENTORNO);
  const paymentProvider = String(process.env.PAYMENT_PROVIDER || "mock").trim().toLowerCase();
  if (!["mock", "todopago"].includes(paymentProvider)) {
    throw new Error("PAYMENT_PROVIDER invalido. Usa mock o todopago.");
  }
  const frontendUrl = readRequired("FRONTEND_URL");
  const jwtSecret = readRequired("JWT_SECRET", { minLength: 24 });
  const cookieSecret = readRequired("COOKIE_SECRET", { minLength: 24 });
  const csrfSecret = readRequired("CSRF_SECRET", { minLength: 24 });
  const todoPago = resolveTodoPagoConfig(process.env, {
    active: paymentProvider === "todopago",
    nodeEnv,
  });
  
  const isProdOrStaging = nodeEnv === "production" || nodeEnv === "staging";

  const config = {
    nodeEnv,
    isProduction: isProdOrStaging,
    frontendUrl,
    jwtSecret,
    cookieSecret,
    csrfSecret,
    bookingReleaseTokenSecret: resolveBookingReleaseTokenSecret(nodeEnv),
    paymentProvider,
    todoPago,
    trustProxy: parseBoolean(process.env.TRUST_PROXY, isProdOrStaging),
    cookieSecure: parseBoolean(process.env.AUTH_COOKIE_SECURE, isProdOrStaging),
    cookieSameSite: String(process.env.AUTH_COOKIE_SAMESITE || "lax").trim().toLowerCase() || "lax",
    sessionTtlSeconds: Math.max(900, Number(process.env.AUTH_SESSION_TTL_SECONDS || 43200)),
    corsOrigins: parseCorsOrigins(
      process.env.CORS_ORIGENES || process.env.CORS_ORIGINS || process.env.CORS_ORIGIN
    ),
    serviceBarberAssignmentsEnabled: parseBoolean(
      process.env.SERVICE_BARBER_ASSIGNMENTS_ENABLED,
      false
    ),
    bookingIsvEnabled: parseStrictBooleanEnv(process.env.BOOKING_ISV_ENABLED, {
      name: "BOOKING_ISV_ENABLED",
      defaultValue: false,
    }),
    agendaSse: {
      enabled: parseRequiredBoolean(process.env.AGENDA_SSE_ENABLED, "AGENDA_SSE_ENABLED", true),
      heartbeatMs: parseIntegerInRange(process.env.AGENDA_SSE_HEARTBEAT_MS, "AGENDA_SSE_HEARTBEAT_MS", {
        fallback: 20000,
        min: 10000,
        max: 60000,
      }),
      pollMs: parseIntegerInRange(process.env.AGENDA_EVENTS_POLL_MS, "AGENDA_EVENTS_POLL_MS", {
        fallback: 750,
        min: 250,
        max: 5000,
      }),
      batchSize: parseIntegerInRange(process.env.AGENDA_EVENTS_BATCH_SIZE, "AGENDA_EVENTS_BATCH_SIZE", {
        fallback: 500,
        min: 1,
        max: 1000,
      }),
      maxConnectionsPerIp: parseIntegerInRange(
        process.env.AGENDA_SSE_MAX_CONNECTIONS_PER_IP,
        "AGENDA_SSE_MAX_CONNECTIONS_PER_IP",
        { fallback: 3, min: 1, max: 20 }
      ),
      maxConnectionsGlobal: parseIntegerInRange(
        process.env.AGENDA_SSE_MAX_CONNECTIONS_GLOBAL,
        "AGENDA_SSE_MAX_CONNECTIONS_GLOBAL",
        { fallback: 1000, min: 1, max: 10000 }
      ),
      retryMs: parseIntegerInRange(process.env.AGENDA_SSE_RETRY_MS, "AGENDA_SSE_RETRY_MS", {
        fallback: 5000,
        min: 1000,
        max: 30000,
      }),
      clientBufferMax: parseIntegerInRange(
        process.env.AGENDA_SSE_CLIENT_BUFFER_MAX,
        "AGENDA_SSE_CLIENT_BUFFER_MAX",
        { fallback: 100, min: 10, max: 1000 }
      ),
      replayBatchSize: parseIntegerInRange(
        process.env.AGENDA_SSE_REPLAY_BATCH_SIZE,
        "AGENDA_SSE_REPLAY_BATCH_SIZE",
        { fallback: 500, min: 1, max: 1000 }
      ),
      replayMaxEvents: parseIntegerInRange(
        process.env.AGENDA_SSE_REPLAY_MAX_EVENTS,
        "AGENDA_SSE_REPLAY_MAX_EVENTS",
        { fallback: 5000, min: 100, max: 50000 }
      ),
    },
  };

  if (!["strict", "lax", "none"].includes(config.cookieSameSite)) {
    throw new Error("AUTH_COOKIE_SAMESITE invalido. Usa strict, lax o none.");
  }

  assertSecureProductionConfig(config);
  app.decorate("config", config);
}

export default fp(envPlugin, { name: "env-plugin" });
