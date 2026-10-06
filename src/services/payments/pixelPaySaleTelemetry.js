import crypto from "node:crypto";

export const PIXELPAY_SALE_EVENT = Object.freeze({
  ATTEMPT_STARTED: "PIXELPAY_SALE_ATTEMPT_STARTED",
  HTTP_STARTED: "PIXELPAY_SALE_HTTP_STARTED",
  RESPONSE_RECEIVED: "PIXELPAY_SALE_RESPONSE_RECEIVED",
  FAILED: "PIXELPAY_SALE_FAILED",
  UNCERTAIN: "PIXELPAY_SALE_UNCERTAIN",
});

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
  return Object.freeze({
    paymentAttemptId: randomUUID(),
    requestId: text(input.requestId, 120),
    idIntent: text(input.idIntent, 120),
    orderId: text(input.orderId, 180),
    provider: "pixelpay",
    env: "sandbox",
    amount: safeAmount(input.amount),
    currency: text(input.currency, 12)?.toUpperCase() || null,
  });
}

export function buildPixelPaySaleEvent(event, attempt, details = {}) {
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
