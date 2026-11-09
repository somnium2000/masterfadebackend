const SAFE_STATUS_ERROR_FIELDS = new Set([
  "env",
  "from",
  "lang",
  "payment_uuid",
  "sdk_version",
]);

const SAFE_PROVIDER_CODES = new Set([
  "INVALID_SIGNATURE",
  "PRECONDITION_FAILED",
  "SIGNATURE_MISMATCH",
]);

const SAFE_PROVIDER_MESSAGE_CODES = new Map([
  ["Invalid signature", "INVALID_SIGNATURE"],
  ["Precondition failed", "PRECONDITION_FAILED"],
  ["Signature mismatch", "SIGNATURE_MISMATCH"],
]);
const SAFE_PROVIDER_MESSAGE_CODE_VALUES = new Set(SAFE_PROVIDER_MESSAGE_CODES.values());

function safeStatusCode(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeResponseClass(value) {
  const name = String(value ?? "").trim();
  return ["AxiosError", "PreconditionalResponse", "Response"].includes(name) ? name : null;
}

function safeProviderCode(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return SAFE_PROVIDER_CODES.has(normalized) ? normalized : null;
}

function safeProviderAction(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["sale", "status", "void"].includes(normalized) ? normalized : null;
}

function safeProviderMessageCode(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (SAFE_PROVIDER_MESSAGE_CODE_VALUES.has(normalized)) return normalized;
  return SAFE_PROVIDER_MESSAGE_CODES.get(normalized) || null;
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
    providerMessageCode: safeProviderMessageCode(
      diagnostics.providerMessageCode ?? diagnostics.providerMessage
    ),
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
    providerMessage: response?.message,
    providerAction: safeProviderAction(response?.action),
    errorFields: errorFields.fields,
    unknownErrorFieldCount: errorFields.unknownCount,
  });
}

export function buildSafePixelPayStatus412ExceptionDiagnostics(error) {
  const response = error?.response;
  const statusCode = safeStatusCode(response?.status ?? error?.statusCode ?? error?.status);
  if (statusCode !== 412 || !response || typeof response !== "object") return null;

  const responseData = response?.data;
  const hasAxiosEnvelope = responseData
    && typeof responseData === "object"
    && !Array.isArray(responseData)
    && ["action", "data", "errors", "message", "success"]
      .some((field) => Object.prototype.hasOwnProperty.call(responseData, field));
  const payload = hasAxiosEnvelope ? responseData : response;
  const errorFields = safeErrorFields(payload?.errors);

  return sanitizePixelPayStatus412Diagnostics({
    statusCode,
    responseClass: safeResponseClass(
      hasAxiosEnvelope ? error?.name ?? error?.constructor?.name : response?.constructor?.name
    ),
    providerCode: payload?.data?.code ?? payload?.code,
    providerMessage: payload?.message,
    providerAction: payload?.action,
    errorFields: errorFields.fields,
    unknownErrorFieldCount: errorFields.unknownCount,
  });
}
