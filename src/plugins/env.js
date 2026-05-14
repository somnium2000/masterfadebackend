import dotenv from "dotenv";
import fp from "fastify-plugin";
import {
  assertPaymentProviderConfig,
  normalizePaymentProviderCode,
  parsePaymentBoolean,
} from "../services/payments/paymentRuntimeGuard.js";

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

function readRequired(name, { minLength = 1 } = {}) {
  const value = String(process.env[name] || "").trim();
  if (!value || value.length < minLength) {
    throw new Error(`ENV requerida faltante o invalida: ${name}`);
  }
  return value;
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
  const paymentProvider = normalizePaymentProviderCode(readRequired("PAYMENT_PROVIDER"));
  assertPaymentProviderConfig(process.env);
  const frontendUrl = readRequired("FRONTEND_URL");
  const jwtSecret = readRequired("JWT_SECRET", { minLength: 24 });
  const cookieSecret = readRequired("COOKIE_SECRET", { minLength: 24 });
  const csrfSecret = readRequired("CSRF_SECRET", { minLength: 24 });
  
  const isProdOrStaging = nodeEnv === "production" || nodeEnv === "staging";

  const config = {
    nodeEnv,
    isProduction: isProdOrStaging,
    frontendUrl,
    jwtSecret,
    cookieSecret,
    csrfSecret,
    paymentProvider,
    paymentSimulatorEnabled: parsePaymentBoolean(process.env.ENABLE_PAYMENT_SIMULATOR, false),
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
  };

  if (!["strict", "lax", "none"].includes(config.cookieSameSite)) {
    throw new Error("AUTH_COOKIE_SAMESITE invalido. Usa strict, lax o none.");
  }

  assertSecureProductionConfig(config);

  app.decorate("config", config);
}

export default fp(envPlugin, { name: "env-plugin" });
