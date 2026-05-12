const LOCAL_ENTORNOS = new Set(["local", "development", "dev"]);
const SIMULATOR_ALLOWED_ENTORNOS = new Set(["local", "qa", "test", "staging", "sandbox"]);
const PRODUCTION_MARKERS = new Set(["production", "prod"]);
const KNOWN_PROVIDER_CODES = new Set(["mock", "simulator", "payment-simulator", "banpais"]);
const PRODUCTION_HOSTS = new Set(["masterfadeapp.com", "www.masterfadeapp.com", "api.masterfadeapp.com"]);

function safeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

export function parsePaymentBoolean(value, fallback = false) {
  const raw = safeText(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function normalizePaymentProviderCode(value) {
  const provider = safeText(value).toLowerCase();
  if (provider === "payment-simulator") return "simulator";
  return provider;
}

function normalizeRuntimeName(value) {
  return safeText(value).toLowerCase();
}

function hostFromValue(value) {
  const raw = safeText(value).toLowerCase();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase();
  }
}

function isProductionHost(value) {
  const host = hostFromValue(value);
  return Boolean(host && PRODUCTION_HOSTS.has(host));
}

export function getPaymentRuntimeSnapshot(env = process.env) {
  const nodeEnv = normalizeRuntimeName(env.NODE_ENV);
  const entorno = normalizeRuntimeName(env.ENTORNO || env.APP_ENV || env.ENVIRONMENT);
  const provider = normalizePaymentProviderCode(env.PAYMENT_PROVIDER);
  const simulatorEnabled = parsePaymentBoolean(env.ENABLE_PAYMENT_SIMULATOR, false);
  const qaSimulationEnabled = parsePaymentBoolean(env.ENABLE_QA_PAYMENT_SIMULATION, false);
  const productionHost = [
    env.FRONTEND_URL,
    env.PUBLIC_WEB_URL,
    env.FRONTEND_PUBLIC_URL,
    env.API_PUBLIC_URL,
    env.PUBLIC_API_URL,
    env.BACKEND_PUBLIC_URL,
    env.API_URL,
    env.APP_URL,
    env.HOST,
  ].some(isProductionHost);

  return {
    nodeEnv,
    entorno,
    provider,
    simulatorEnabled,
    qaSimulationEnabled,
    productionHost,
    productionRuntime: PRODUCTION_MARKERS.has(nodeEnv) || PRODUCTION_MARKERS.has(entorno) || productionHost,
  };
}

export function assertPaymentProviderConfig(env = process.env) {
  const snapshot = getPaymentRuntimeSnapshot(env);
  const rawProvider = safeText(env.PAYMENT_PROVIDER);
  if (!rawProvider) {
    throw new Error("PAYMENT_PROVIDER_REQUIRED");
  }
  if (!KNOWN_PROVIDER_CODES.has(rawProvider.toLowerCase())) {
    throw new Error(`PAYMENT_PROVIDER_UNSUPPORTED: ${rawProvider}`);
  }
  if (snapshot.provider === "banpais") {
    throw new Error("PAYMENT_PROVIDER_BANPAIS_NOT_IMPLEMENTED");
  }
  if (snapshot.provider === "mock") {
    const mockAllowed = !snapshot.productionRuntime
      && LOCAL_ENTORNOS.has(snapshot.entorno || snapshot.nodeEnv || "development");
    if (!mockAllowed) {
      throw new Error("PAYMENT_PROVIDER_MOCK_FORBIDDEN_OUTSIDE_LOCAL");
    }
  }
  if (snapshot.provider === "simulator") {
    assertPaymentSimulatorUsable(env);
  }
  return snapshot.provider;
}

export function assertPaymentSimulatorUsable(env = process.env) {
  const snapshot = getPaymentRuntimeSnapshot(env);
  const runtimeName = snapshot.entorno || snapshot.nodeEnv;
  if (snapshot.provider !== "simulator") {
    throw new Error("PAYMENT_SIMULATOR_PROVIDER_REQUIRED");
  }
  if (!snapshot.simulatorEnabled) {
    throw new Error("PAYMENT_SIMULATOR_DISABLED");
  }
  if (
    snapshot.productionRuntime
    || snapshot.nodeEnv === "production"
    || PRODUCTION_MARKERS.has(snapshot.entorno)
  ) {
    throw new Error("PAYMENT_SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  }
  if (["qa", "staging"].includes(runtimeName) && !snapshot.qaSimulationEnabled) {
    throw new Error("PAYMENT_QA_SIMULATION_DISABLED");
  }
  if (!SIMULATOR_ALLOWED_ENTORNOS.has(runtimeName)) {
    throw new Error("PAYMENT_SIMULATOR_ENTORNO_NOT_ALLOWED");
  }
  if (["qa", "staging"].includes(runtimeName) && !safeText(env.PAYMENT_SIMULATOR_WEBHOOK_SECRET)) {
    throw new Error("PAYMENT_SIMULATOR_SECRET_REQUIRED");
  }
  return snapshot;
}
