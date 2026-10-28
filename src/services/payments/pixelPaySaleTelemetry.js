import crypto from "node:crypto";

export const PIXELPAY_SALE_EVENT = Object.freeze({
  ATTEMPT_STARTED: "PIXELPAY_SALE_ATTEMPT_STARTED",
  HTTP_STARTED: "PIXELPAY_SALE_HTTP_STARTED",
  RESPONSE_RECEIVED: "PIXELPAY_SALE_RESPONSE_RECEIVED",
  FAILED: "PIXELPAY_SALE_FAILED",
  UNCERTAIN: "PIXELPAY_SALE_UNCERTAIN",
});

export const SAFE_PIXELPAY_INPUT_ERROR_FIELDS = new Set([
  "authentication_request",
  "billing_address",
  "billing_city",
  "billing_country",
  "billing_phone",
  "billing_state",
  "card_cvv",
  "card_expire",
  "card_holder",
  "card_number",
  "customer_email",
  "customer_name",
  "from",
  "lang",
  "order_amount",
  "order_content",
  "order_currency",
  "order_extras",
  "order_id",
  "sdk_version",
]);

function text(value, maxLength = 255) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeClassName(value) {
  const normalized = text(value, 80);
  return normalized && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized) ? normalized : null;
}

function safeStatusCode(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 100 && normalized <= 599
    ? normalized
    : null;
}

function safeDuration(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? Math.round(normalized) : null;
}

function safeAmount(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Number(normalized.toFixed(2)) : null;
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeLength(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function safePixelPayInputErrorFields(value, maxFields = 32) {
  if (!Array.isArray(value)) return [];
  const normalizedLimit = Number.isInteger(maxFields) && maxFields > 0 ? Math.min(maxFields, 32) : 32;
  return [...new Set(value
    .filter((field) => typeof field === "string" && SAFE_PIXELPAY_INPUT_ERROR_FIELDS.has(field)))]
    .sort()
    .slice(0, normalizedLimit);
}

export function readPixelPayInputErrors(errors, maxFields = 32) {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) {
    return { inputErrorFields: [], inputErrorCount: 0, inputErrorUnknownCount: 0 };
  }
  const prototype = Object.getPrototypeOf(errors);
  if (prototype !== Object.prototype && prototype !== null) {
    return { inputErrorFields: [], inputErrorCount: 0, inputErrorUnknownCount: 0 };
  }
  const keys = Object.keys(errors);
  const inputErrorFields = safePixelPayInputErrorFields(keys, maxFields);
  return {
    inputErrorFields,
    inputErrorCount: inputErrorFields.length,
    inputErrorUnknownCount: keys.filter((field) => !SAFE_PIXELPAY_INPUT_ERROR_FIELDS.has(field)).length,
  };
}

export function safePixelPayHeader(value, maxLength = 160) {
  return text(value, maxLength)?.replace(/[\r\n]+/g, " ") || null;
}

export function readPixelPayHttpMetadata(source) {
  const headers = source?.headers || source?.response?.headers;
  const readHeader = (name) => {
    if (typeof headers?.get === "function") return headers.get(name);
    return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
  };
  return {
    statusCode: safeStatusCode(source?.status ?? source?.response?.status),
    contentType: safePixelPayHeader(readHeader("content-type")),
    cfRay: safePixelPayHeader(readHeader("cf-ray"), 120),
  };
}

export function createPixelPaySaleAttempt(input = {}, { randomUUID = crypto.randomUUID } = {}) {
  const paymentAttemptId = input.paymentAttemptId === undefined ? randomUUID() : input.paymentAttemptId;
  if (!safePixelPayUuid(paymentAttemptId)) throw new TypeError("PixelPay paymentAttemptId invalido.");
  return Object.freeze({
    paymentAttemptId,
    requestId: text(input.requestId, 120),
    idIntent: text(input.idIntent, 120),
    orderId: text(input.orderId, 180),
    provider: "pixelpay",
    env: "sandbox",
    amount: safeAmount(input.amount),
    currency: text(input.currency, 12)?.toUpperCase() || null,
  });
}

export function safePixelPayUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function safePixelPayProviderResponseCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,15}$/.test(normalized)) return null;
  return /^\d{13,19}$/.test(normalized) ? null : normalized;
}

export function buildPixelPaySaleEvent(event, attempt, details = {}) {
  const inputErrorFields = safePixelPayInputErrorFields(details.inputErrorFields);
  return {
    event,
    timestamp: new Date().toISOString(),
    paymentAttemptId: attempt.paymentAttemptId,
    requestId: attempt.requestId,
    idIntent: attempt.idIntent,
    orderId: attempt.orderId,
    provider: attempt.provider,
    env: attempt.env,
    amount: attempt.amount,
    currency: attempt.currency,
    durationMs: safeDuration(details.durationMs),
    responseClass: safeClassName(details.responseClass),
    statusCode: safeStatusCode(details.statusCode),
    errorName: safeClassName(details.errorName),
    errorConstructorName: safeClassName(details.errorConstructorName),
    sdkErrorName: safeClassName(details.sdkErrorName),
    safeMessageCode: text(details.safeMessageCode, 120),
    outcome: text(details.outcome, 80),
    contentType: safePixelPayHeader(details.contentType),
    cfRay: safePixelPayHeader(details.cfRay, 120),
    paymentUuidPresent: safeBoolean(details.paymentUuidPresent),
    transactionIdPresent: safeBoolean(details.transactionIdPresent),
    transactionResultValid: safeBoolean(details.transactionResultValid),
    transactionResultParsed: safeBoolean(details.transactionResultParsed),
    inputErrorFields,
    inputErrorCount: inputErrorFields.length,
    inputErrorUnknownCount: safeCount(details.inputErrorUnknownCount),
    cardExpireFormatValid: safeBoolean(details.cardExpireFormatValid),
    cardExpireFuture: safeBoolean(details.cardExpireFuture),
    billingAddressLength: safeLength(details.billingAddressLength),
  };
}

export function emitPixelPaySaleEvent(logger, event, attempt, details = {}) {
  const payload = buildPixelPaySaleEvent(event, attempt, details);
  const method = event === PIXELPAY_SALE_EVENT.FAILED || event === PIXELPAY_SALE_EVENT.UNCERTAIN
    ? "warn"
    : "info";
  if (typeof logger?.[method] === "function") logger[method](payload, event);
  return payload;
}
