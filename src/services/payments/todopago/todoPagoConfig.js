const TODO_PAGO_MODES = Object.freeze([
  "preprod_simulated",
  "preprod_real",
  "prod_real",
]);

const REAL_MODES = new Set(["preprod_real", "prod_real"]);
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const MIN_HTTP_TIMEOUT_MS = 1_000;
const MAX_HTTP_TIMEOUT_MS = 30_000;
const REDACTED = "[REDACTED]";

export class TodoPagoConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TodoPagoConfigError";
    this.code = code;
  }
}

function readText(source, name) {
  return String(source?.[name] ?? "").trim();
}

function normalizeMode(value) {
  const mode = String(value || "preprod_simulated").trim().toLowerCase();
  if (!TODO_PAGO_MODES.includes(mode)) {
    throw new TodoPagoConfigError(
      "TODOPAGO_MODE_INVALID",
      "TODOPAGO_MODE invalido. Usa preprod_simulated, preprod_real o prod_real."
    );
  }
  return mode;
}

function normalizeBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeHttpsUrl(value, name, { required = false, originOnly = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    if (!required) return null;
    throw new TodoPagoConfigError(
      "TODOPAGO_CONFIG_REQUIRED",
      `Configuracion TodoPago incompleta: ${name}.`
    );
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TodoPagoConfigError(
      "TODOPAGO_URL_INVALID",
      `${name} debe ser una URL HTTPS absoluta.`
    );
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TodoPagoConfigError(
      "TODOPAGO_URL_INVALID",
      `${name} debe ser una URL HTTPS absoluta.`
    );
  }

  return originOnly ? parsed.origin : parsed.toString();
}

function normalizeTimeout(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return DEFAULT_HTTP_TIMEOUT_MS;
  if (!/^\d+$/.test(normalized)) {
    throw new TodoPagoConfigError(
      "TODOPAGO_HTTP_TIMEOUT_INVALID",
      `TODOPAGO_HTTP_TIMEOUT_MS debe ser un entero entre ${MIN_HTTP_TIMEOUT_MS} y ${MAX_HTTP_TIMEOUT_MS}.`
    );
  }

  const timeoutMs = Number(normalized);
  if (timeoutMs < MIN_HTTP_TIMEOUT_MS || timeoutMs > MAX_HTTP_TIMEOUT_MS) {
    throw new TodoPagoConfigError(
      "TODOPAGO_HTTP_TIMEOUT_INVALID",
      `TODOPAGO_HTTP_TIMEOUT_MS debe ser un entero entre ${MIN_HTTP_TIMEOUT_MS} y ${MAX_HTTP_TIMEOUT_MS}.`
    );
  }
  return timeoutMs;
}

function requireField(value, name) {
  if (!value) {
    throw new TodoPagoConfigError(
      "TODOPAGO_CONFIG_REQUIRED",
      `Configuracion TodoPago incompleta: ${name}.`
    );
  }
}

export function resolveTodoPagoConfig(source = process.env, {
  active = String(source?.PAYMENT_PROVIDER || "").trim().toLowerCase() === "todopago",
  nodeEnv = String(source?.NODE_ENV || source?.ENTORNO || "development").trim().toLowerCase(),
} = {}) {
  const mode = normalizeMode(source?.TODOPAGO_MODE);
  const realMode = REAL_MODES.has(mode);
  const requireRealConfig = active && realMode;

  if (active && mode === "preprod_simulated" && ["production", "prod", "staging", "preprod"].includes(nodeEnv)) {
    throw new TodoPagoConfigError(
      "TODOPAGO_SIMULATED_ENV_FORBIDDEN",
      "TODOPAGO_MODE=preprod_simulated no esta permitido en produccion/staging."
    );
  }

  const config = {
    mode,
    simulatedEnabled: normalizeBoolean(
      source?.TODOPAGO_SIMULATED_ENABLED,
      mode === "preprod_simulated"
    ),
    baseUrl: normalizeHttpsUrl(source?.TODOPAGO_BASE_URL, "TODOPAGO_BASE_URL", {
      required: requireRealConfig,
    }),
    authUrl: normalizeHttpsUrl(source?.TODOPAGO_AUTH_URL, "TODOPAGO_AUTH_URL", {
      required: requireRealConfig,
    }),
    modalUrl: normalizeHttpsUrl(source?.TODOPAGO_MODAL_URL, "TODOPAGO_MODAL_URL", {
      required: requireRealConfig,
    }),
    username: readText(source, "TODOPAGO_USERNAME"),
    password: readText(source, "TODOPAGO_PASSWORD"),
    commerceId: readText(source, "TODOPAGO_COMMERCE_ID"),
    tenant: readText(source, "TODOPAGO_TENANT"),
    terminal: readText(source, "TODOPAGO_TERMINAL"),
    encryptionKey: readText(source, "TODOPAGO_ENCRYPTION_KEY"),
    allowedMessageOrigin: normalizeHttpsUrl(
      source?.TODOPAGO_ALLOWED_MESSAGE_ORIGIN,
      "TODOPAGO_ALLOWED_MESSAGE_ORIGIN",
      { required: requireRealConfig, originOnly: true }
    ),
    httpTimeoutMs: normalizeTimeout(source?.TODOPAGO_HTTP_TIMEOUT_MS),
  };

  if (requireRealConfig) {
    requireField(config.username, "TODOPAGO_USERNAME");
    requireField(config.password, "TODOPAGO_PASSWORD");
    requireField(config.commerceId, "TODOPAGO_COMMERCE_ID");
    requireField(config.tenant, "TODOPAGO_TENANT");
    requireField(config.terminal, "TODOPAGO_TERMINAL");
    requireField(config.encryptionKey, "TODOPAGO_ENCRYPTION_KEY");
  }

  return Object.freeze(config);
}

export function getTodoPagoConfigDiagnostic(config) {
  return Object.freeze({
    mode: config.mode,
    simulatedEnabled: config.simulatedEnabled,
    baseUrl: config.baseUrl,
    authUrl: config.authUrl,
    modalUrl: config.modalUrl,
    username: config.username ? REDACTED : null,
    password: config.password ? REDACTED : null,
    commerceId: config.commerceId,
    tenant: config.tenant,
    terminal: config.terminal,
    encryptionKey: config.encryptionKey ? REDACTED : null,
    allowedMessageOrigin: config.allowedMessageOrigin,
    httpTimeoutMs: config.httpTimeoutMs,
  });
}
