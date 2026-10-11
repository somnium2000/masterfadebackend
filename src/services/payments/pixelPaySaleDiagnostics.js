import { PIXELPAY_SALE_OUTCOME } from "./PixelPayDirectProvider.js";
import { safePixelPayHeader, safePixelPayInputErrorFields, safePixelPayUuid } from "./pixelPaySaleTelemetry.js";

export const SAFE_PIXELPAY_SDK_MESSAGE_CODES = new Set([
  "SDK_PUBLIC_KEY_UNAVAILABLE", "SDK_ENCRYPTION_FAILED", "SDK_HTTP_TIMEOUT",
  "SDK_NETWORK_ERROR", "SDK_REQUEST_CONFIG_ERROR", "SDK_EXCEPTION_OTHER", "SDK_MESSAGE_ABSENT",
]);

export const SAFE_PIXELPAY_ERROR_CODES = new Set([
  "PIXELPAY_CARD_EXPIRE_INVALID", "PIXELPAY_CARD_EXPIRED", "PIXELPAY_BILLING_ADDRESS_INVALID",
  "PIXELPAY_BILLING_COUNTRY_INVALID", "PIXELPAY_BILLING_STATE_INVALID", "PIXELPAY_ORDER_ITEMS_INVALID",
  "PIXELPAY_ORDER_AMOUNT_MISMATCH", "PIXELPAY_NETWORK_ERROR", "PIXELPAY_TIMEOUT", "PIXELPAY_RESPONSE_INVALID",
]);

// AM: Nombres del SDK 2.5.8 y excepciones locales; nunca aceptar nombres arbitrarios.
export const SAFE_PIXELPAY_DIAGNOSTIC_NAMES = new Set([
  "Response", "Object", "ErrorResponse", "FailureResponse", "InputErrorResponse", "TimeoutResponse",
  "SuccessResponse", "PreconditionalResponse", "PaymentDeclinedResponse", "PayloadResponse",
  "NotFoundResponse", "NoAccessResponse", "NetworkFailureResponse", "Error", "TypeError",
  "RangeError", "SyntaxError", "URIError", "AbortError", "TimeoutError", "AxiosError",
  "PixelPaySdkError", "PixelPayDirectError", "AppError",
]);

function safeName(value) {
  return SAFE_PIXELPAY_DIAGNOSTIC_NAMES.has(value) ? value : null;
}

function safeInteger(value, max = 2147483647) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function safeStatus(value) {
  if (value == null) return null;
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

export function safePixelPayRequestId(value) {
  return typeof value === "string" ? safePixelPayHeader(value, 120) : null;
}

export function safePixelPayCfRay(value) {
  const normalized = typeof value === "string" ? safePixelPayHeader(value, 120) : null;
  return normalized && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.test(normalized)
    && /[a-f]/i.test(normalized.slice(0, 16)) ? normalized : null;
}

export function buildSafeProviderErrorDiagnostic(error, requestId) {
  return {
    requestId: safePixelPayRequestId(requestId),
    paymentAttemptId: safePixelPayUuid(error?.paymentAttemptId),
    errorCode: SAFE_PIXELPAY_ERROR_CODES.has(error?.code) ? error.code : null,
    errorName: safeName(error?.name),
    sdkErrorName: safeName(error?.sdkErrorName),
    upstreamStatusCode: safeStatus(error?.statusCode),
    upstreamContentType: typeof error?.upstreamContentType === "string"
      ? safePixelPayHeader(error.upstreamContentType, 160) : null,
    upstreamContentLength: safeInteger(error?.upstreamContentLength),
    cfRay: safePixelPayCfRay(error?.cfRay),
    responseClass: safeName(error?.responseClass),
    safeMessageCode: SAFE_PIXELPAY_SDK_MESSAGE_CODES.has(error?.safeMessageCode) ? error.safeMessageCode : null,
    errorConstructorName: safeName(error?.errorConstructorName),
    uncertain: error?.uncertain === true,
    cardExpireFormatValid: safeBoolean(error?.cardExpireFormatValid),
    cardExpireFuture: safeBoolean(error?.cardExpireFuture),
    billingAddressLength: safeInteger(error?.billingAddressLength, 180),
  };
}

export function buildSafePixelPaySdkDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
  const inputErrorFields = safePixelPayInputErrorFields(diagnostics.inputErrorFields);
  return {
    paymentAttemptId: safePixelPayUuid(diagnostics.paymentAttemptId),
    sdkResponseClass: safeName(diagnostics.sdkResponseClass),
    statusCode: safeStatus(diagnostics.statusCode),
    responseSuccess: safeBoolean(diagnostics.responseSuccess),
    safeMessageCode: SAFE_PIXELPAY_SDK_MESSAGE_CODES.has(diagnostics.safeMessageCode) ? diagnostics.safeMessageCode : null,
    transactionResultValid: safeBoolean(diagnostics.transactionResultValid),
    transactionResultDataPresent: safeBoolean(diagnostics.transactionResultDataPresent),
    transactionResultParsed: safeBoolean(diagnostics.transactionResultParsed),
    responseApproved: safeBoolean(diagnostics.responseApproved),
    responseIncomplete: safeBoolean(diagnostics.responseIncomplete),
    responseCodePresent: safeBoolean(diagnostics.responseCodePresent),
    hasPaymentUuid: safeBoolean(diagnostics.hasPaymentUuid),
    hasTransactionId: safeBoolean(diagnostics.hasTransactionId),
    hasPaymentHash: safeBoolean(diagnostics.hasPaymentHash),
    paymentHashValid: safeBoolean(diagnostics.paymentHashValid),
    transactionAmountPresent: safeBoolean(diagnostics.transactionAmountPresent),
    approvedAmountPresent: safeBoolean(diagnostics.approvedAmountPresent),
    transactionAmountMatches: safeBoolean(diagnostics.transactionAmountMatches),
    approvedAmountMatches: safeBoolean(diagnostics.approvedAmountMatches),
    amountMatches: safeBoolean(diagnostics.amountMatches),
    inputErrorFields,
    inputErrorCount: inputErrorFields.length,
    inputErrorUnknownCount: safeInteger(diagnostics.inputErrorUnknownCount) ?? 0,
    cardExpireFormatValid: safeBoolean(diagnostics.cardExpireFormatValid),
    cardExpireFuture: safeBoolean(diagnostics.cardExpireFuture),
    billingAddressLength: safeInteger(diagnostics.billingAddressLength, 180),
    outcome: Object.values(PIXELPAY_SALE_OUTCOME).includes(diagnostics.outcome) ? diagnostics.outcome : null,
    durationMs: safeInteger(diagnostics.durationMs),
    cfRay: safePixelPayCfRay(diagnostics.cfRay),
  };
}
