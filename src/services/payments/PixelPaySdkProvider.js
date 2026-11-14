import PixelPaySdk from "@pixelpay/sdk-core";
import { createPixelPayNodeSaleTransaction, classifyPixelPaySaleRuntimeError, sanitizePixelPaySaleRuntimeDiagnostics } from "./pixelPaySaleRuntime.js";
import { capturePixelPayStatusShape, emitPixelPayStatusShape } from "./pixelPayStatusShapeProbe.js";
import { createHash } from "node:crypto";
import { PaymentProvider } from "./PaymentProvider.js";
import {
  createPixelPaySaleAttempt,
  emitPixelPaySaleEvent,
  PIXELPAY_SALE_EVENT,
  readPixelPayInputErrors,
  readPixelPayHttpMetadata,
  safePixelPayProviderResponseCode,
} from "./pixelPaySaleTelemetry.js";
import {
  buildSafePixelPayStatus412Diagnostics,
  buildSafePixelPayStatus412ExceptionDiagnostics,
} from "./pixelPayStatusDiagnostics.js";
import {
  createPixelPaySaleSignature,
  createPixelPayStatusSignature,
  classifyPixelPaySaleResult,
  HONDURAS_ISO_3166_2_CODES,
  normalizePixelPayStatusResponse,
  PIXELPAY_SALE_OUTCOME,
} from "./PixelPayDirectProvider.js";

const HONDURAS_ISO_3166_2_CODE_SET = new Set(HONDURAS_ISO_3166_2_CODES);
const PIXELPAY_BILLING_ADDRESS_PLACEHOLDERS = new Set([
  "QA",
  "TEST",
  "PRUEBA",
  "N/A",
  "NA",
  "NONE",
  "NULL",
]);
const PIXELPAY_SANDBOX_URL = "https://pixelpay.dev";
const PIXELPAY_ENVIRONMENTS = new Set(["sandbox", "live"]);
const PIXELPAY_STATUS_VALUES = new Set([
  "COMPLETED", "DECLINED", "VOIDED", "PENDING", "UNKNOWN", "TIMEOUT",
]);

const SDK_FAILURE_MESSAGE_CODES = new Map([
  ["Could not obtain necessary credentials for transaction.", "SDK_PUBLIC_KEY_UNAVAILABLE"],
  ["Could not process transaction without merchant public key.", "SDK_PUBLIC_KEY_UNAVAILABLE"],
  ["Could not process encryption, please try again.", "SDK_ENCRYPTION_FAILED"],
  ["Encryption process encountered an unexpected error.", "SDK_ENCRYPTION_FAILED"],
  ["timeout of 60000ms exceeded", "SDK_HTTP_TIMEOUT"],
  ["Network Error", "SDK_NETWORK_ERROR"],
  ["Invalid URL", "SDK_REQUEST_CONFIG_ERROR"],
  ["The merchant credentials are not definied (key/hash).", "SDK_REQUEST_CONFIG_ERROR"],
]);

export const STATUS_RECONCILIATION_BLOCKED_BY_PROVIDER_CONTRACT =
  "STATUS_RECONCILIATION_BLOCKED_BY_PROVIDER_CONTRACT";

export function classifyPixelPayStatusEvidence(status = {}) {
  const normalizedStatus = text(status.status).toUpperCase();
  const paymentUuidMatches = Boolean(status.paymentUuid)
    && (!status.resultPaymentUuid || status.resultPaymentUuid === status.paymentUuid);
  const officialStatus = PIXELPAY_STATUS_VALUES.has(normalizedStatus);
  const responseAuthenticated = status.providerContractValid === true;
  const financialEvidenceComplete = responseAuthenticated
    && paymentUuidMatches
    && status.paymentHashValid === true
    && status.amountMatches === true;
  return {
    status: normalizedStatus,
    officialStatus,
    terminal: ["COMPLETED", "DECLINED", "VOIDED"].includes(normalizedStatus),
    approved: false,
    providerApproved: normalizedStatus === "COMPLETED" && status.providerApproved === true,
    rejected: normalizedStatus === "DECLINED",
    voided: normalizedStatus === "VOIDED",
    uncertain: ["PENDING", "UNKNOWN", "TIMEOUT"].includes(normalizedStatus),
    responseAuthenticated,
    paymentUuidMatches,
    financialEvidenceComplete,
    // AM: getStatus no habilita confirmacion hasta validar su evidencia real en PR08.
    autoApprovalEligible: false,
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeClassName(value) {
  return safeIdentifier(value?.constructor?.name);
}

function safeIdentifier(value) {
  const name = text(value);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name.slice(0, 80) : null;
}

function valuePresent(value) {
  return value !== null && value !== undefined && text(value) !== "";
}

function normalizeHttpsUrl(value, name) {
  const normalized = text(value).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} debe ser una URL HTTPS valida.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} debe ser una URL HTTPS valida.`);
  }
  return normalized;
}

export function validatePixelPaySdkConfig({ endpoint, env, keyId, secretKey, authHash, appUrl } = {}) {
  const normalizedEnv = text(env).toLowerCase();
  const normalizedEndpoint = normalizeHttpsUrl(endpoint, "PIXELPAY_ENDPOINT");
  const normalizedAppUrl = normalizeHttpsUrl(appUrl, "PIXELPAY_APP_URL");
  const normalizedKeyId = text(keyId);
  const normalizedSecretKey = text(secretKey);
  const normalizedAuthHash = text(authHash);

  if (!PIXELPAY_ENVIRONMENTS.has(normalizedEnv)) {
    throw new Error("PIXELPAY_ENV invalido. Usa sandbox o live.");
  }
  if (!normalizedKeyId) throw new Error("Configuracion PixelPay SDK incompleta: PIXELPAY_KEY_ID.");
  if (!normalizedSecretKey) throw new Error("Configuracion PixelPay SDK incompleta: PIXELPAY_SECRET_KEY.");
  if (!normalizedAuthHash) throw new Error("Configuracion PixelPay SDK incompleta: PIXELPAY_AUTH_HASH.");

  if (normalizedEnv === "sandbox") {
    if (normalizedEndpoint !== PIXELPAY_SANDBOX_URL) {
      throw new Error("PIXELPAY_ENDPOINT Sandbox debe ser https://pixelpay.dev.");
    }
    if (normalizedAppUrl !== PIXELPAY_SANDBOX_URL) {
      throw new Error("PIXELPAY_APP_URL Sandbox debe ser https://pixelpay.dev.");
    }
  } else {
    if (normalizedEndpoint === PIXELPAY_SANDBOX_URL) {
      throw new Error("PIXELPAY_ENDPOINT live no puede usar el endpoint Sandbox.");
    }
    if (normalizedAppUrl === PIXELPAY_SANDBOX_URL) {
      throw new Error("PIXELPAY_APP_URL live no puede usar la URL Sandbox.");
    }
  }

  return {
    endpoint: normalizedEndpoint,
    env: normalizedEnv,
    keyId: normalizedKeyId,
    secretKey: normalizedSecretKey,
    authHash: normalizedAuthHash,
    appUrl: normalizedAppUrl,
  };
}

export function inspectPixelPayCardExpire(value, referenceDate = new Date()) {
  const normalized = text(value);
  const formatValid = /^[0-9]{2}(0[1-9]|1[0-2])$/.test(normalized);
  if (!formatValid) return { normalized, formatValid: false, future: false };

  const currentYear = referenceDate.getUTCFullYear();
  const currentMonth = referenceDate.getUTCMonth() + 1;
  const expireYear = 2000 + Number(normalized.slice(0, 2));
  const expireMonth = Number(normalized.slice(2, 4));
  return {
    normalized,
    formatValid: true,
    future: expireYear > currentYear || (expireYear === currentYear && expireMonth >= currentMonth),
  };
}

export function isPixelPayBillingAddressPlaceholder(value) {
  return PIXELPAY_BILLING_ADDRESS_PLACEHOLDERS.has(text(value).toUpperCase());
}

function inspectPixelPaySaleInput(input, referenceDate) {
  const cardExpire = inspectPixelPayCardExpire(input?.card?.expire, referenceDate);
  return {
    cardExpireFormatValid: cardExpire.formatValid,
    cardExpireFuture: cardExpire.future,
    billingAddressLength: text(input?.billing?.address).length,
  };
}

function normalizeCardExpire(value, referenceDate) {
  const inspection = inspectPixelPayCardExpire(value, referenceDate);
  if (!inspection.formatValid) {
    throw new PixelPaySdkError(
      "PIXELPAY_CARD_EXPIRE_INVALID",
      "La fecha de expiracion no tiene el formato YYMM requerido por PixelPay.",
      { cardExpireFormatValid: false, cardExpireFuture: false }
    );
  }
  if (!inspection.future) {
    throw new PixelPaySdkError(
      "PIXELPAY_CARD_EXPIRED",
      "La tarjeta se encuentra vencida.",
      { cardExpireFormatValid: true, cardExpireFuture: false }
    );
  }
  return inspection.normalized;
}

function normalizeBillingCountry(value) {
  const normalized = text(value).toUpperCase();
  if (normalized !== "HN") {
    throw new PixelPaySdkError(
      "PIXELPAY_BILLING_COUNTRY_INVALID",
      "El pais de facturacion debe ser HN."
    );
  }
  return normalized;
}

function normalizeBillingState(value) {
  const normalized = text(value).toUpperCase();
  if (!HONDURAS_ISO_3166_2_CODE_SET.has(normalized)) {
    throw new PixelPaySdkError(
      "PIXELPAY_BILLING_STATE_INVALID",
      "El departamento debe utilizar un codigo ISO 3166-2 de Honduras."
    );
  }
  return normalized;
}

function responseStatus(response) {
  const raw = typeof response?.getStatus === "function"
    ? response.getStatus()
    : response?.status;
  const normalized = Number(raw);
  return Number.isInteger(normalized) ? normalized : null;
}

function responseSuccess(response) {
  return typeof response?.success === "boolean" ? response.success : null;
}

function readSafeSaleHttpMetadata(source, execution) {
  // AM: Un null de una respuesta observada es definitivo; el fallback legacy tambien pasa por la allowlist.
  const metadata = readPixelPayHttpMetadata(source);
  const safe = sanitizePixelPaySaleRuntimeDiagnostics(execution?.httpResponseReceived === true ? execution : {
    statusCode: source?.statusCode ?? metadata.statusCode,
    upstreamContentType: source?.upstreamContentType ?? metadata.contentType,
    cfRay: source?.cfRay ?? metadata.cfRay,
  });
  return { statusCode: safe.statusCode, contentType: safe.upstreamContentType, cfRay: safe.cfRay };
}

function strictStatusText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function strictStatusAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function strictResponseApproved(value) {
  if (value === true || value === "1") return { valid: true, value: true };
  if (value === false || value === "0") return { valid: true, value: false };
  return { valid: false, value: null };
}

function emptyPixelPayStatusContract() {
  return {
    normalizedStatus: "UNKNOWN",
    transactionId: null,
    transactionAuthPresent: false,
    responseApproved: null,
    responseCode: null,
    transactionAmountMatches: false,
    approvedAmountMatches: false,
    amountMatches: false,
    transactionIdMatches: false,
    providerContractValid: false,
    providerApproved: false,
  };
}

export function extractPixelPayStatusContract(response, expected = {}, sdkEnvelopeValid = false) {
  try {
    const envelope = objectOrNull(response?.data);
    const lastResponse = objectOrNull(envelope?.last_response);
    const financial = objectOrNull(lastResponse?.data);
    const rawStatus = strictStatusText(envelope?.status)?.toUpperCase() || "";
    const normalizedStatus = rawStatus === "PAID" ? "COMPLETED" : rawStatus;
    const statusCode = responseStatus(response);
    const transactionId = strictStatusText(financial?.transaction_id);
    const transactionAuth = strictStatusText(financial?.transaction_auth);
    const transactionAmount = strictStatusAmount(financial?.transaction_amount);
    const approvedAmount = strictStatusAmount(financial?.transaction_approved_amount);
    const responseApproved = strictResponseApproved(financial?.response_approved);
    const rawResponseCode = strictStatusText(financial?.response_code);
    const responseCode = rawResponseCode
      && safePixelPayProviderResponseCode(rawResponseCode) === rawResponseCode
      ? rawResponseCode
      : null;
    const expectedTransactionId = strictStatusText(expected?.transactionId);
    const expectedPaymentUuid = strictStatusText(expected?.paymentUuid);
    const paymentUuidMatches = Boolean(financial)
      && (!Object.hasOwn(financial, "payment_uuid")
        || (typeof financial.payment_uuid === "string" && financial.payment_uuid === expectedPaymentUuid));
    const expectedAmount = strictStatusAmount(expected?.amount);
    const transactionAmountMatches = transactionAmount !== null
      && expectedAmount !== null
      && money(transactionAmount) === money(expectedAmount);
    const approvedAmountMatches = approvedAmount !== null
      && expectedAmount !== null
      && money(approvedAmount) === money(expectedAmount);
    const amountMatches = transactionAmountMatches
      && approvedAmountMatches
      && money(transactionAmount) === money(approvedAmount);
    const transactionIdMatches = Boolean(transactionId)
      && Boolean(expectedTransactionId)
      && transactionId === expectedTransactionId;
    const approvedCode = responseCode === "00";
    const approvalSignalsAgree = responseApproved.valid
      && responseApproved.value === approvedCode;
    // AM: Si Status incluye la senal de interrupcion, solo false es coherente con una respuesta completa.
    const incompleteSignalValid = Boolean(financial)
      && (!Object.hasOwn(financial, "response_incomplete") || financial.response_incomplete === false);
    const statusSignalsAgree = normalizedStatus === "COMPLETED"
      ? responseApproved.value === true && approvedCode
      : responseApproved.value === false && !approvedCode;
    const providerContractValid = sdkEnvelopeValid === true
      && statusCode != null
      && statusCode >= 200
      && statusCode < 300
      && responseSuccess(response) === true
      && PIXELPAY_STATUS_VALUES.has(normalizedStatus)
      && Boolean(lastResponse)
      && Boolean(financial)
      && Boolean(transactionId)
      && Boolean(transactionAuth)
      && transactionAmount !== null
      && approvedAmount !== null
      && responseApproved.valid
      && Boolean(responseCode)
      && amountMatches
      && transactionIdMatches
      && paymentUuidMatches
      && incompleteSignalValid
      && approvalSignalsAgree
      && statusSignalsAgree;

    return {
      normalizedStatus: providerContractValid ? normalizedStatus : "UNKNOWN",
      transactionId,
      transactionAuthPresent: Boolean(transactionAuth),
      responseApproved: responseApproved.value,
      responseCode,
      transactionAmountMatches,
      approvedAmountMatches,
      amountMatches,
      transactionIdMatches,
      providerContractValid,
      providerApproved: providerContractValid && normalizedStatus === "COMPLETED",
    };
  } catch {
    return emptyPixelPayStatusContract();
  }
}

export function classifySdkFailureMessage(response) {
  if (responseStatus(response) === 408 || safeClassName(response) === "TimeoutResponse") {
    return "SDK_UPSTREAM_TIMEOUT";
  }
  const message = typeof response?.message === "string" ? response.message : "";
  if (!message) return "SDK_MESSAGE_ABSENT";
  return SDK_FAILURE_MESSAGE_CODES.get(message) || "SDK_EXCEPTION_OTHER";
}

function assertSdkShape(sdk) {
  const requiredConstructors = [
    sdk?.Models?.Settings,
    sdk?.Models?.Order,
    sdk?.Models?.Item,
    sdk?.Models?.Card,
    sdk?.Models?.Billing,
    sdk?.Requests?.SaleTransaction,
    sdk?.Requests?.StatusTransaction,
    sdk?.Requests?.VoidTransaction,
    sdk?.Services?.Transaction,
    sdk?.Entities?.TransactionResult,
  ];
  if (requiredConstructors.some((value) => typeof value !== "function")) {
    throw new Error("@pixelpay/sdk-core no expone el contrato requerido.");
  }
  if (typeof sdk?.Services?.Transaction?.withConcurrency !== "function") {
    throw new Error("@pixelpay/sdk-core no expone la configuracion Sandbox requerida.");
  }
  const settingsPrototype = sdk.Models.Settings.prototype;
  if (
    typeof settingsPrototype?.setupSandbox !== "function"
    || typeof settingsPrototype?.setupEndpoint !== "function"
    || typeof settingsPrototype?.setupCredentials !== "function"
    || typeof settingsPrototype?.setupPlatformUser !== "function"
    || typeof settingsPrototype?.setupEnvironment !== "function"
    || typeof settingsPrototype?.setupHeaders !== "function"
  ) {
    throw new Error("@pixelpay/sdk-core no expone los metodos Settings requeridos.");
  }
}

export class PixelPaySdkError extends Error {
  constructor(code, message, {
    uncertain = false,
    paymentUuid = null,
    statusCode = null,
    sdkErrorName = null,
    errorName = null,
    errorConstructorName = null,
    responseClass = null,
    safeMessageCode = null,
    upstreamContentType = null,
    cfRay = null,
    paymentAttemptId = null,
    cardExpireFormatValid = null,
    cardExpireFuture = null,
    billingAddressLength = null,
    providerDiagnostics = null,
    runtimeDiagnostics = null,
  } = {}) {
    super(message);
    this.name = "PixelPaySdkError";
    this.code = code;
    this.uncertain = uncertain;
    this.paymentUuid = text(paymentUuid) || null;
    this.statusCode = statusCode != null && Number.isInteger(Number(statusCode))
      ? Number(statusCode)
      : null;
    this.sdkErrorName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text(sdkErrorName))
      ? text(sdkErrorName).slice(0, 80)
      : null;
    this.errorName = safeIdentifier(errorName);
    this.errorConstructorName = safeIdentifier(errorConstructorName);
    this.responseClass = safeIdentifier(responseClass);
    this.safeMessageCode = text(safeMessageCode).slice(0, 120) || null;
    this.upstreamContentType = text(upstreamContentType).replace(/[\r\n]+/g, " ").slice(0, 160) || null;
    this.cfRay = text(cfRay).replace(/[\r\n]+/g, " ").slice(0, 120) || null;
    this.paymentAttemptId = text(paymentAttemptId).slice(0, 80) || null;
    this.cardExpireFormatValid = typeof cardExpireFormatValid === "boolean" ? cardExpireFormatValid : null;
    this.cardExpireFuture = typeof cardExpireFuture === "boolean" ? cardExpireFuture : null;
    this.billingAddressLength = Number.isSafeInteger(billingAddressLength) && billingAddressLength >= 0
      ? billingAddressLength
      : null;
    this.providerDiagnostics = providerDiagnostics;
    this.runtimeDiagnostics = runtimeDiagnostics;
  }
}

export class PixelPaySdkProvider extends PaymentProvider {
  constructor({
    endpoint,
    env,
    keyId,
    secretKey,
    authHash,
    appUrl,
    sdk = PixelPaySdk,
    now = () => new Date(),
  } = {}) {
    super();
    const config = validatePixelPaySdkConfig({ endpoint, env, keyId, secretKey, authHash, appUrl });
    this.endpoint = config.endpoint;
    this.env = config.env;
    this.keyId = config.keyId;
    this.secretKey = config.secretKey;
    this.authHash = config.authHash;
    this.appUrl = config.appUrl;
    this.sdk = sdk;
    this.now = now;

    assertSdkShape(this.sdk);
    if (typeof this.now !== "function") throw new Error("Reloj PixelPay invalido.");

    // El SDK bloquea globalmente transacciones concurrentes por defecto. MasterFade
    // ya serializa cada intent con advisory lock y debe permitir intents distintos.
    this.sdk.Services.Transaction.withConcurrency();
  }

  createTransaction(signature, { sale = false } = {}) {
    const settings = new this.sdk.Models.Settings();
    if (this.env === "sandbox") {
      settings.setupSandbox();
      // AM: setupSandbox fija el ambiente pero sus credenciales genericas deben
      // sobrescribirse con las credenciales autenticadas del comercio.
      settings.setupCredentials(this.keyId, this.authHash);
    } else {
      settings.setupEndpoint(this.endpoint);
      settings.setupCredentials(this.keyId, this.authHash);
      settings.setupEnvironment("live");
    }
    settings.setupHeaders({ "x-client-signature": signature });
    return sale ? createPixelPayNodeSaleTransaction(this.sdk, settings)
      : new this.sdk.Services.Transaction(settings);
  }

  static sha512(value) {
    return createHash("sha512").update(text(value), "utf8").digest("hex");
  }

  async voidPayment({ paymentUuid, orderId, authorizedEmail, reason = "VOID" } = {}) {
    const normalizedPaymentUuid = text(paymentUuid);
    const normalizedOrderId = text(orderId);
    const normalizedEmail = text(authorizedEmail).toLowerCase();
    if (!normalizedPaymentUuid || !normalizedOrderId || !normalizedEmail) {
      throw new PixelPaySdkError(
        "PIXELPAY_VOID_INPUT_INVALID",
        "La anulacion PixelPay requiere payment_uuid, order_id y usuario autorizado."
      );
    }
    const settings = new this.sdk.Models.Settings();
    if (this.env === "sandbox") settings.setupSandbox();
    else {
      settings.setupEndpoint(this.endpoint);
      settings.setupEnvironment("live");
    }
    settings.setupCredentials(this.keyId, this.authHash);
    settings.setupPlatformUser(PixelPaySdkProvider.sha512(normalizedEmail));
    const transaction = new this.sdk.Services.Transaction(settings);
    const request = new this.sdk.Requests.VoidTransaction();
    request.payment_uuid = normalizedPaymentUuid;
    request.void_reason = text(reason) || "VOID";
    request.void_signature = PixelPaySdkProvider.sha512(
      `${normalizedEmail}|${normalizedOrderId}|${this.secretKey}`
    );
    return transaction.doVoid(request);
  }

  buildSaleRequest({ orderId, currency, amount, items, customer, billing, card, callbackUrl } = {}, referenceDate = this.now()) {
    const normalizedExpire = normalizeCardExpire(card?.expire, referenceDate);
    const normalizedBillingAddress = text(billing?.address);
    if (isPixelPayBillingAddressPlaceholder(normalizedBillingAddress)) {
      throw new PixelPaySdkError(
        "PIXELPAY_BILLING_ADDRESS_INVALID",
        "Ingresa una direccion de facturacion valida.",
        {
          cardExpireFormatValid: true,
          cardExpireFuture: true,
          billingAddressLength: normalizedBillingAddress.length,
        }
      );
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new PixelPaySdkError(
        "PIXELPAY_ORDER_ITEMS_INVALID",
        "La orden PixelPay no contiene items canonicos."
      );
    }

    const order = new this.sdk.Models.Order();
    order.id = text(orderId);
    order.currency = text(currency).toUpperCase();
    order.customer_name = text(customer?.name);
    order.customer_email = text(customer?.email);
    const normalizedCallbackUrl = text(callbackUrl);
    if (normalizedCallbackUrl) {
      order.callback_url = normalizedCallbackUrl;
    }

    for (const source of items) {
      const code = text(source?.code);
      const title = text(source?.title);
      const price = Number(source?.price);
      const qty = Number(source?.qty);
      if (!code || !title || !Number.isFinite(price) || price < 0 || !Number.isInteger(qty) || qty < 1) {
        throw new PixelPaySdkError(
          "PIXELPAY_ORDER_ITEMS_INVALID",
          "La orden PixelPay contiene un item canonico invalido."
        );
      }
      const item = new this.sdk.Models.Item();
      item.code = code;
      item.title = title;
      item.price = price;
      item.qty = qty;
      order.addItem(item);
    }
    if (money(order.amount) !== money(amount)) {
      throw new PixelPaySdkError(
        "PIXELPAY_ORDER_AMOUNT_MISMATCH",
        "La suma de items PixelPay no coincide con el monto canonico."
      );
    }

    const paymentCard = new this.sdk.Models.Card();
    paymentCard.number = text(card?.number).replace(/\D+/g, "");
    paymentCard.cvv2 = text(card?.cvv).replace(/\D+/g, "");
    paymentCard.expire_year = 2000 + Number(normalizedExpire.slice(0, 2));
    paymentCard.expire_month = Number(normalizedExpire.slice(2, 4));
    paymentCard.cardholder = text(card?.holder);

    const paymentBilling = new this.sdk.Models.Billing();
    paymentBilling.address = normalizedBillingAddress;
    paymentBilling.country = normalizeBillingCountry(billing?.country);
    paymentBilling.state = normalizeBillingState(billing?.state);
    paymentBilling.city = text(billing?.city);
    paymentBilling.phone = text(billing?.phone);

    const saleRequest = new this.sdk.Requests.SaleTransaction();
    saleRequest.setOrder(order);
    saleRequest.setCard(paymentCard);
    saleRequest.setBilling(paymentBilling);
    return saleRequest;
  }

  verifyPaymentHash(paymentHash, orderId) {
    const normalizedHash = text(paymentHash);
    const normalizedOrderId = text(orderId);
    if (!normalizedHash || !normalizedOrderId) return false;
    try {
      const transaction = this.createTransaction();
      return transaction.verifyPaymentHash(
        normalizedHash,
        normalizedOrderId,
        this.secretKey
      ) === true;
    } catch {
      return false;
    }
  }

  readTransactionResult(response, onParseError) {
    const TransactionResult = this.sdk.Entities.TransactionResult;
    const valid = TransactionResult.validateResponse(response) === true;
    const dataPresent = Boolean(objectOrNull(response?.data));
    if (!valid || !dataPresent) {
      return { result: null, valid, dataPresent, parsed: false };
    }
    try {
      const result = objectOrNull(TransactionResult.fromResponse(response));
      return { result, valid, dataPresent, parsed: Boolean(result) };
    } catch (error) {
      onParseError?.(error);
      return { result: null, valid, dataPresent, parsed: false };
    }
  }

  async sale(input = {}, telemetryContext = {}) {
    const attempt = createPixelPaySaleAttempt({ ...input, ...telemetryContext, env: this.env });
    const logger = telemetryContext.logger;
    const startedAt = Date.now();
    const referenceDate = this.now();
    const inputDiagnostics = inspectPixelPaySaleInput(input, referenceDate);
    emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.ATTEMPT_STARTED, attempt, inputDiagnostics);

    let response;
    let transaction;
    let sdkInvoked = false;
    try {
      const signature = createPixelPaySaleSignature({
        secretKey: this.secretKey,
        appKey: this.keyId,
        orderId: input.orderId,
        appUrl: this.appUrl,
      });
      transaction = this.createTransaction(signature, { sale: true });
      const saleRequest = this.buildSaleRequest(input, referenceDate);
      emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.HTTP_STARTED, attempt, {
        durationMs: Date.now() - startedAt,
        ...inputDiagnostics,
      });
      sdkInvoked = true;
      response = await transaction.doSale(saleRequest);
      return this.completeSaleResponse(input, attempt, logger, startedAt, inputDiagnostics, transaction, response);
    } catch (error) {
      const execution = sdkInvoked ? transaction?.getSaleExecutionDiagnostics?.() : {
          executionPhase: "request_construction", httpResponseReceived: false, requestMayHaveBeenSent: false,
        };
      const metadata = readSafeSaleHttpMetadata(error, execution);
      const runtimeDiagnostics = classifyPixelPaySaleRuntimeError(error, execution);
      const { errorConstructorName, errorName } = runtimeDiagnostics;
      const safeMessageCode = error instanceof PixelPaySdkError
        ? error.code
        : runtimeDiagnostics.safeMessageCode;
      const details = {
        ...runtimeDiagnostics,
        durationMs: Date.now() - startedAt,
        statusCode: runtimeDiagnostics.statusCode ?? error?.statusCode ?? metadata.statusCode,
        responseClass: error?.responseClass,
        errorName,
        errorConstructorName,
        sdkErrorName: error?.sdkErrorName ?? errorConstructorName,
        safeMessageCode,
        outcome: error instanceof PixelPaySdkError && error.uncertain === false && !sdkInvoked
          ? PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE
          : PIXELPAY_SALE_OUTCOME.UNCERTAIN,
        contentType: metadata.contentType,
        cfRay: metadata.cfRay,
        cardExpireFormatValid: error?.cardExpireFormatValid ?? inputDiagnostics.cardExpireFormatValid,
        cardExpireFuture: error?.cardExpireFuture ?? inputDiagnostics.cardExpireFuture,
        billingAddressLength: error?.billingAddressLength ?? inputDiagnostics.billingAddressLength,
      };
      emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.FAILED, attempt, details);
      if (details.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN) {
        emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.UNCERTAIN, attempt, details);
      }
      if (error instanceof PixelPaySdkError) {
        if (sdkInvoked) error.uncertain = true;
        error.runtimeDiagnostics = runtimeDiagnostics;
        error.upstreamContentType = metadata.contentType;
        error.cfRay = metadata.cfRay;
        error.paymentAttemptId = attempt.paymentAttemptId;
        error.cardExpireFormatValid ??= inputDiagnostics.cardExpireFormatValid;
        error.cardExpireFuture ??= inputDiagnostics.cardExpireFuture;
        error.billingAddressLength ??= inputDiagnostics.billingAddressLength;
        throw error;
      }
      throw new PixelPaySdkError("PIXELPAY_NETWORK_ERROR", "No fue posible confirmar la respuesta de PixelPay.", {
        uncertain: true,
        statusCode: details.statusCode,
        sdkErrorName: errorConstructorName,
        errorName,
        errorConstructorName,
        responseClass: safeClassName(error?.response),
        safeMessageCode,
        upstreamContentType: details.contentType,
        cfRay: details.cfRay,
        paymentAttemptId: attempt.paymentAttemptId,
        runtimeDiagnostics,
        ...inputDiagnostics,
      });
    }
  }

  completeSaleResponse(input, attempt, logger, startedAt, inputDiagnostics, transaction, response) {
    const statusCode = responseStatus(response);
    const execution = transaction?.getSaleExecutionDiagnostics?.();
    const upstreamFailure = execution?.httpResponseReceived === true && statusCode >= 400
      ? classifyPixelPaySaleRuntimeError(null, execution) : null;
    let parseFailure;
    const transactionResult = this.readTransactionResult(response, (error) => {
      parseFailure = classifyPixelPaySaleRuntimeError(error, transaction?.getSaleExecutionDiagnostics?.());
    });
    const result = transactionResult.result;
    const paymentUuid = text(result?.payment_uuid) || null;
    const transactionId = text(result?.transaction_id) || null;
    const transactionReference = text(result?.transaction_reference) || null;
    const hasPaymentHash = Boolean(text(result?.payment_hash));
    let paymentHashValid = false;
    if (hasPaymentHash) {
      try {
        paymentHashValid = transaction.verifyPaymentHash(
          result.payment_hash,
          text(input.orderId),
          this.secretKey
        ) === true;
      } catch {
        paymentHashValid = false;
      }
    }
    const transactionAmountPresent = valuePresent(result?.transaction_amount);
    const approvedAmountPresent = valuePresent(result?.transaction_approved_amount);
    const transactionAmountMatches = transactionAmountPresent
      && money(result?.transaction_amount) === money(input.amount);
    const approvedAmountMatches = approvedAmountPresent
      && money(result?.transaction_approved_amount) === money(input.amount);
    const amountMatches = transactionAmountMatches && approvedAmountMatches;
    const normalizedResponse = {
      success: responseSuccess(response),
      data: {
        transactionApprovedAmount: result?.transaction_approved_amount,
        transactionAmount: result?.transaction_amount,
        transactionId,
        responseApproved: typeof result?.response_approved === "boolean" ? result.response_approved : null,
        responseIncomplete: typeof result?.response_incomplete === "boolean" ? result.response_incomplete : null,
        responseCode: text(result?.response_code) || null,
        paymentUuid,
      },
    };
    const outcome = classifyPixelPaySaleResult({
      statusCode,
      payload: normalizedResponse,
      paymentHashValid,
      amountMatches,
      paymentUuid,
      transactionId,
    });
    const inputErrors = readPixelPayInputErrors(response?.errors);
    const responseMetadata = readSafeSaleHttpMetadata(response, execution);
    const diagnostics = {
      paymentAttemptId: attempt.paymentAttemptId,
      sdkResponseClass: safeClassName(response),
      statusCode,
      responseSuccess: responseSuccess(response),
      safeMessageCode: parseFailure?.safeMessageCode ?? upstreamFailure?.safeMessageCode ?? classifySdkFailureMessage(response),
      transactionResultValid: transactionResult.valid,
      transactionResultDataPresent: transactionResult.dataPresent,
      transactionResultParsed: transactionResult.parsed,
      responseApproved: normalizedResponse.data.responseApproved,
      responseIncomplete: normalizedResponse.data.responseIncomplete,
      responseCodePresent: Boolean(normalizedResponse.data.responseCode),
      providerResponseCode: safePixelPayProviderResponseCode(normalizedResponse.data.responseCode),
      hasPaymentUuid: Boolean(paymentUuid),
      hasTransactionId: Boolean(transactionId),
      hasPaymentHash,
      paymentHashValid,
      transactionAmountPresent,
      approvedAmountPresent,
      transactionAmountMatches,
      approvedAmountMatches,
      amountMatches,
      ...inputErrors,
      ...inputDiagnostics,
      outcome,
      durationMs: Date.now() - startedAt,
      cfRay: responseMetadata.cfRay,
    };

    const telemetryDetails = {
      ...transaction?.getSaleExecutionDiagnostics?.(),
      ...parseFailure,
      durationMs: Date.now() - startedAt,
      responseClass: diagnostics.sdkResponseClass,
      statusCode,
      safeMessageCode: diagnostics.safeMessageCode,
      outcome,
      contentType: responseMetadata.contentType,
      cfRay: responseMetadata.cfRay,
      paymentUuidPresent: diagnostics.hasPaymentUuid,
      transactionIdPresent: diagnostics.hasTransactionId,
      transactionResultValid: diagnostics.transactionResultValid,
      transactionResultParsed: diagnostics.transactionResultParsed,
      inputErrorFields: inputErrors.inputErrorFields,
      inputErrorUnknownCount: inputErrors.inputErrorUnknownCount,
      ...inputDiagnostics,
    };
    emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.RESPONSE_RECEIVED, attempt, telemetryDetails);
    if (outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN) {
      emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.UNCERTAIN, attempt, telemetryDetails);
    }

    return {
      outcome,
      approved: outcome === PIXELPAY_SALE_OUTCOME.APPROVED,
      definitive: outcome === PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED
        || outcome === PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE,
      incomplete: normalizedResponse.data.responseIncomplete === true,
      paymentUuid,
      transactionId,
      transactionReference,
      paymentHashValid,
      amountMatches,
      transactionAmountMatches,
      approvedAmountMatches,
      statusCode,
      response: normalizedResponse,
      diagnostics,
      paymentAttemptId: attempt.paymentAttemptId,
    };
  }

  async queryPaymentStatus(paymentUuid, expected = {}, shapeProbe = {}) {
    const normalizedUuid = text(paymentUuid);
    if (!normalizedUuid) {
      throw new PixelPaySdkError(
        "PIXELPAY_PAYMENT_UUID_MISSING",
        "No existe payment_uuid para consultar PixelPay."
      );
    }
    const signature = createPixelPayStatusSignature({
      secretKey: this.secretKey,
      appKey: this.keyId,
      paymentUuid: normalizedUuid,
      appUrl: this.appUrl,
    });
    const transaction = this.createTransaction(signature);
    const statusRequest = new this.sdk.Requests.StatusTransaction();
    statusRequest.payment_uuid = normalizedUuid;

    let response;
    try {
      response = await transaction.getStatus(statusRequest);
    } catch (error) {
      const metadata = readPixelPayHttpMetadata(error);
      if (metadata.statusCode === 412 || Number(error?.statusCode) === 412) {
        throw new PixelPaySdkError(
          "PIXELPAY_STATUS_PRECONDITION_FAILED",
          "PixelPay no pudo procesar la consulta de estado en este momento.",
          {
            statusCode: 412,
            providerDiagnostics: buildSafePixelPayStatus412ExceptionDiagnostics(error),
          }
        );
      }
      throw new PixelPaySdkError(
        "PIXELPAY_NETWORK_ERROR",
        "No fue posible confirmar el estado en PixelPay.",
        { uncertain: true, paymentUuid: normalizedUuid }
      );
    }

    const statusCode = responseStatus(response);
    if (statusCode === 412) {
      throw new PixelPaySdkError(
        "PIXELPAY_STATUS_PRECONDITION_FAILED",
        "PixelPay no pudo procesar la consulta de estado en este momento.",
        {
          statusCode: 412,
          providerDiagnostics: buildSafePixelPayStatus412Diagnostics(response),
        }
      );
    }
    const beforeShape = capturePixelPayStatusShape(this, shapeProbe, response?.data);
    let sdkEnvelopeValid;
    try {
      sdkEnvelopeValid = this.sdk.Entities.TransactionResult.validateResponse(response) === true;
    } catch {
      sdkEnvelopeValid = false;
    }
    const contract = extractPixelPayStatusContract(response, {
      ...expected, paymentUuid: normalizedUuid,
    }, sdkEnvelopeValid);
    emitPixelPayStatusShape(
      shapeProbe,
      beforeShape,
      beforeShape
        ? capturePixelPayStatusShape(this, shapeProbe, response?.data?.last_response?.data)
        : null
    );
    const providerContractValid = contract.providerContractValid;
    const normalizedStatus = contract.normalizedStatus;
    const payload = normalizePixelPayStatusResponse({
      success: responseSuccess(response),
      data: providerContractValid
        ? { status: normalizedStatus }
        : {},
    });
    const status = providerContractValid ? normalizedStatus : "UNKNOWN";
    return {
      ok: statusCode != null && statusCode >= 200 && statusCode < 300,
      statusCode,
      success: payload.success,
      paymentUuid: normalizedUuid,
      status,
      terminal: ["COMPLETED", "DECLINED", "VOIDED"].includes(status),
      uncertain: ["PENDING", "UNKNOWN", "TIMEOUT"].includes(status),
      approved: false,
      providerApproved: contract.providerApproved,
      rejected: status === "DECLINED",
      voided: status === "VOIDED",
      incomplete: providerContractValid !== true,
      definitiveRejected: providerContractValid === true && status === "DECLINED",
      transactionId: contract.transactionId,
      resultPaymentUuid: null,
      resultOrderId: null,
      resultCurrency: null,
      paymentHashValid: false,
      paymentHashEvidenceAvailable: false,
      transactionAuthPresent: contract.transactionAuthPresent,
      responseApproved: contract.responseApproved,
      responseCode: contract.responseCode,
      transactionIdMatches: contract.transactionIdMatches,
      transactionAmountMatches: contract.transactionAmountMatches,
      approvedAmountMatches: contract.approvedAmountMatches,
      amountMatches: contract.amountMatches,
      providerContractValid,
      response: payload,
    };
  }
}
