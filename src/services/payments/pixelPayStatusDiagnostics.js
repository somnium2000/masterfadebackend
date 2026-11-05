const SAFE_STATUS_ERROR_FIELDS = new Set([
  "env",
  "from",
  "lang",
  "payment_uuid",
  "sdk_version",
]);

function safeStatusCode(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeResponseClass(value) {
  const name = String(value ?? "").trim();
  return ["PreconditionalResponse", "Response"].includes(name) ? name : null;
}

function safeProviderCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(normalized) ? normalized : null;
}

function safeProviderAction(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["sale", "status", "void"].includes(normalized) ? normalized : null;
}

function safeProviderMessage(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  // AM: Solo texto humano sin numeros ni separadores de secretos/URLs.
  if (!/^[\p{L} .,;:()]+$/u.test(normalized)) return null;
  return normalized;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 32 ? value : 0;
}

export function sanitizePixelPayStatus412Diagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
  const errorFields = Array.isArray(diagnostics.errorFields)
    ? [...new Set(diagnostics.errorFields.filter((field) => SAFE_STATUS_ERROR_FIELDS.has(field)))].sort()
    : [];
  return Object.freeze({
    statusCode: safeStatusCode(diagnostics.statusCode),
    responseClass: safeResponseClass(diagnostics.responseClass),
    providerCode: safeProviderCode(diagnostics.providerCode),
    providerMessage: safeProviderMessage(diagnostics.providerMessage),
    providerAction: safeProviderAction(diagnostics.providerAction),
    errorFields,
    unknownErrorFieldCount: safeCount(diagnostics.unknownErrorFieldCount),
  });
}

function safeErrorFields(errors) {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) {
    return { fields: [], unknownCount: 0 };
  }
  const prototype = Object.getPrototypeOf(errors);
  if (prototype !== Object.prototype && prototype !== null) {
    return { fields: [], unknownCount: 0 };
  }
  const keys = Object.keys(errors);
  return {
    fields: [...new Set(keys.filter((key) => SAFE_STATUS_ERROR_FIELDS.has(key)))].sort(),
    unknownCount: keys.filter((key) => !SAFE_STATUS_ERROR_FIELDS.has(key)).length,
  };
}

export function buildSafePixelPayStatus412Diagnostics(response) {
  const errorFields = safeErrorFields(response?.errors);
  return sanitizePixelPayStatus412Diagnostics({
    statusCode: safeStatusCode(
      typeof response?.getStatus === "function" ? response.getStatus() : response?.status
    ),
    responseClass: safeResponseClass(response?.constructor?.name),
    providerCode: safeProviderCode(response?.data?.code ?? response?.code),
    providerMessage: safeProviderMessage(response?.message),
    providerAction: safeProviderAction(response?.action),
    errorFields: errorFields.fields,
    unknownErrorFieldCount: errorFields.unknownCount,
  });
}
