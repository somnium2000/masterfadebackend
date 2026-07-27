export const PAYMENT_LAUNCH_TYPES = Object.freeze({
  REDIRECT: "redirect",
  IFRAME_POST: "iframe_post",
});

export const PAYMENT_LAUNCH_METHODS = Object.freeze({
  GET: "GET",
  POST: "POST",
});

const VALID_LAUNCH_TYPES = new Set(Object.values(PAYMENT_LAUNCH_TYPES));
const VALID_LAUNCH_METHODS = new Set(Object.values(PAYMENT_LAUNCH_METHODS));

export class PaymentProviderContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaymentProviderContractError";
    this.code = code;
  }
}

function requiredText(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_REQUIRED_FIELD",
      `[PaymentProvider] ${fieldName} es obligatorio.`
    );
  }
  return normalized;
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeHttpUrl(value, fieldName, { nullable = false, originOnly = false } = {}) {
  const normalized = optionalText(value);
  if (!normalized && nullable) return null;
  if (!normalized) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_URL_REQUIRED",
      `[PaymentProvider] ${fieldName} es obligatorio.`
    );
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_URL_INVALID",
      `[PaymentProvider] ${fieldName} debe ser una URL absoluta valida.`
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_URL_PROTOCOL_INVALID",
      `[PaymentProvider] ${fieldName} debe usar HTTP o HTTPS.`
    );
  }

  return originOnly ? parsed.origin : parsed.toString();
}

function normalizeFields(fields) {
  if (fields == null) return {};
  if (typeof fields !== "object" || Array.isArray(fields)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_FIELDS_INVALID",
      "[PaymentProvider] launch.fields debe ser un objeto."
    );
  }

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      requiredText(key, "launch.fields key"),
      String(value ?? ""),
    ])
  );
}

function normalizeLaunch(launch) {
  if (launch == null) return null;
  if (typeof launch !== "object" || Array.isArray(launch)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_LAUNCH_INVALID",
      "[PaymentProvider] launch debe ser un objeto o null."
    );
  }

  const type = requiredText(launch.type, "launch.type").toLowerCase();
  if (!VALID_LAUNCH_TYPES.has(type)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_LAUNCH_TYPE_INVALID",
      `[PaymentProvider] launch.type invalido: ${type}.`
    );
  }

  const method = requiredText(launch.method, "launch.method").toUpperCase();
  if (!VALID_LAUNCH_METHODS.has(method)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_LAUNCH_METHOD_INVALID",
      `[PaymentProvider] launch.method invalido: ${method}.`
    );
  }

  return {
    type,
    action: normalizeHttpUrl(launch.action, "launch.action"),
    method,
    fields: normalizeFields(launch.fields),
    allowedMessageOrigin: normalizeHttpUrl(
      launch.allowedMessageOrigin,
      "launch.allowedMessageOrigin",
      { nullable: true, originOnly: true }
    ),
    expiresAt: optionalText(launch.expiresAt),
  };
}

export function normalizeCreateIntentResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_RESULT_INVALID",
      "[PaymentProvider] createIntent debe devolver un objeto."
    );
  }

  const raw = result.raw == null ? {} : result.raw;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PaymentProviderContractError(
      "PAYMENT_PROVIDER_RAW_INVALID",
      "[PaymentProvider] raw debe ser un objeto."
    );
  }

  return {
    providerIntentId: requiredText(result.providerIntentId, "providerIntentId"),
    paymentUrl: normalizeHttpUrl(result.paymentUrl, "paymentUrl", { nullable: true }),
    launch: normalizeLaunch(result.launch),
    raw,
  };
}
