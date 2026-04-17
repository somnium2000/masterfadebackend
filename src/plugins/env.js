import dotenv from "dotenv";

function normalizeNodeEnv(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["production", "prod"].includes(value)) return "production";
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
  if (config.nodeEnv !== "production") return;

  if (!config.frontendUrl.startsWith("https://")) {
    throw new Error("FRONTEND_URL debe usar HTTPS en produccion.");
  }

  if (config.paymentProvider === "mock") {
    throw new Error("PAYMENT_PROVIDER=mock esta prohibido en produccion.");
  }

  if (!config.cookieSecure) {
    throw new Error("AUTH_COOKIE_SECURE debe estar activo en produccion.");
  }
}

export default async function envPlugin(app) {
  dotenv.config();

  const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV || process.env.ENTORNO);
  const paymentProvider = String(process.env.PAYMENT_PROVIDER || "mock").trim().toLowerCase();
  const frontendUrl = readRequired("FRONTEND_URL");
  const jwtSecret = readRequired("JWT_SECRET", { minLength: 24 });
  const cookieSecret = readRequired("COOKIE_SECRET", { minLength: 24 });
  const csrfSecret = readRequired("CSRF_SECRET", { minLength: 24 });

  const config = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    frontendUrl,
    jwtSecret,
    cookieSecret,
    csrfSecret,
    paymentProvider,
    trustProxy: parseBoolean(process.env.TRUST_PROXY, nodeEnv === "production"),
    cookieSecure: parseBoolean(process.env.AUTH_COOKIE_SECURE, nodeEnv === "production"),
    cookieSameSite: String(process.env.AUTH_COOKIE_SAMESITE || "lax").trim().toLowerCase() || "lax",
    sessionTtlSeconds: Math.max(900, Number(process.env.AUTH_SESSION_TTL_SECONDS || 43200)),
  };

  if (!["strict", "lax", "none"].includes(config.cookieSameSite)) {
    throw new Error("AUTH_COOKIE_SAMESITE invalido. Usa strict, lax o none.");
  }

  assertSecureProductionConfig(config);

  app.decorate("config", config);
}
