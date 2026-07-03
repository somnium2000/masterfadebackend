import dotenv from "dotenv";
import fp from "fastify-plugin";
import { parseStrictBooleanEnv } from "../config/bookingConfig.js";

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

function normalizeTodoPagoMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "preprod_simulated";
  if (["preprod_simulated", "preprod_real", "prod_real"].includes(value)) return value;
  throw new Error("TODOPAGO_MODE invalido. Usa preprod_simulated, preprod_real o prod_real.");
}

function assertTodoPagoConfig(config) {
  if (config.paymentProvider !== "todopago") return;

  if (config.todoPago.mode === "preprod_simulated") {
    if (config.nodeEnv === "production" || config.nodeEnv === "staging") {
      throw new Error("TODOPAGO_MODE=preprod_simulated no esta permitido en produccion/staging.");
    }
    return;
  }

  const requiredFields = [
    "baseUrl",
    "username",
    "password",
    "commerceId",
    "tenant",
    "terminal",
  ];
  for (const field of requiredFields) {
    if (!String(config.todoPago[field] || "").trim()) {
      throw new Error(`Configuracion TodoPago incompleta: ${field}`);
    }
  }
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
  const todoPagoMode = normalizeTodoPagoMode(process.env.TODOPAGO_MODE);
  
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
    todoPago: {
      mode: todoPagoMode,
      simulatedEnabled: parseBoolean(process.env.TODOPAGO_SIMULATED_ENABLED, todoPagoMode === "preprod_simulated"),
      baseUrl: String(process.env.TODOPAGO_BASE_URL || "").trim(),
      username: String(process.env.TODOPAGO_USERNAME || "").trim(),
      password: String(process.env.TODOPAGO_PASSWORD || "").trim(),
      commerceId: String(process.env.TODOPAGO_COMMERCE_ID || "").trim(),
      tenant: String(process.env.TODOPAGO_TENANT || "").trim(),
      terminal: String(process.env.TODOPAGO_TERMINAL || "").trim(),
    },
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
  };

  if (!["strict", "lax", "none"].includes(config.cookieSameSite)) {
    throw new Error("AUTH_COOKIE_SAMESITE invalido. Usa strict, lax o none.");
  }

  assertSecureProductionConfig(config);
  assertTodoPagoConfig(config);

  app.decorate("config", config);
}

export default fp(envPlugin, { name: "env-plugin" });
