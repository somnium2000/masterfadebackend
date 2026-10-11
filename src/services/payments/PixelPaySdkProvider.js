import PixelPaySdk from "@pixelpay/sdk-core";
import { PaymentProvider } from "./PaymentProvider.js";
import {
  createPixelPaySaleAttempt,
  emitPixelPaySaleEvent,
  PIXELPAY_SALE_EVENT,
  readPixelPayInputErrors,
  readPixelPayHttpMetadata,
} from "./pixelPaySaleTelemetry.js";
import {
  createPixelPaySaleSignature,
  createPixelPayStatusSignature,
  classifyPixelPaySaleResult,
  HONDURAS_ISO_3166_2_CODES,
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
      "El pais de facturacion no es valido para QA."
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

export function classifySdkFailureMessage(response) {
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
    || typeof settingsPrototype?.setupHeaders !== "function"
  ) {
    throw new Error("@pixelpay/sdk-core no expone Settings Sandbox requerido.");
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
  }
}

export class PixelPaySdkProvider extends PaymentProvider {
  constructor({
    endpoint,
    env,
    keyId,
    secretKey,
    appUrl,
    sdk = PixelPaySdk,
    now = () => new Date(),
  } = {}) {
    super();
    this.endpoint = text(endpoint).replace(/\/+$/, "");
    this.env = text(env).toLowerCase();
    this.keyId = text(keyId);
    this.secretKey = text(secretKey);
    this.appUrl = text(appUrl).replace(/\/+$/, "");
    this.sdk = sdk;
    this.now = now;

    if (
      this.env !== "sandbox"
      || this.endpoint !== "https://pixelpay.dev"
      || this.appUrl !== "https://pixelpay.dev"
    ) {
      throw new Error("PixelPay SDK solo esta habilitado para sandbox QA.");
    }
    if (!this.keyId || !this.secretKey || !this.appUrl) {
      throw new Error("Configuracion PixelPay SDK incompleta.");
    }
    assertSdkShape(this.sdk);
    if (typeof this.now !== "function") throw new Error("Reloj PixelPay invalido.");

    // El SDK bloquea globalmente transacciones concurrentes por defecto. MasterFade
    // ya serializa cada intent con advisory lock y debe permitir intents distintos.
    this.sdk.Services.Transaction.withConcurrency();
  }

  createTransaction(signature) {
    const settings = new this.sdk.Models.Settings();
    settings.setupSandbox();
    settings.setupHeaders({ "x-client-signature": signature });
    return new this.sdk.Services.Transaction(settings);
  }

  buildSaleRequest({ orderId, currency, amount, items, customer, billing, card } = {}, referenceDate = this.now()) {
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

  readTransactionResult(response) {
    const TransactionResult = this.sdk.Entities.TransactionResult;
    const valid = TransactionResult.validateResponse(response) === true;
    const dataPresent = Boolean(objectOrNull(response?.data));
    if (!valid || !dataPresent) {
      return { result: null, valid, dataPresent, parsed: false };
    }
    try {
      const result = objectOrNull(TransactionResult.fromResponse(response));
      return { result, valid, dataPresent, parsed: Boolean(result) };
    } catch {
      return { result: null, valid, dataPresent, parsed: false };
    }
  }

  async sale(input = {}, telemetryContext = {}) {
    const attempt = createPixelPaySaleAttempt({ ...input, ...telemetryContext });
    const logger = telemetryContext.logger;
    const startedAt = Date.now();
    const referenceDate = this.now();
    const inputDiagnostics = inspectPixelPaySaleInput(input, referenceDate);
    emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.ATTEMPT_STARTED, attempt, inputDiagnostics);

    let response;
    let transaction;
    try {
      const signature = createPixelPaySaleSignature({
        secretKey: this.secretKey,
        appKey: this.keyId,
        orderId: input.orderId,
        appUrl: this.appUrl,
      });
      transaction = this.createTransaction(signature);
      const saleRequest = this.buildSaleRequest(input, referenceDate);
      emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.HTTP_STARTED, attempt, {
        durationMs: Date.now() - startedAt,
        ...inputDiagnostics,
      });
      response = await transaction.doSale(saleRequest);
    } catch (error) {
      const metadata = readPixelPayHttpMetadata(error);
      const errorConstructorName = safeClassName(error);
      const errorName = safeIdentifier(error?.name);
      const safeMessageCode = error instanceof PixelPaySdkError
        ? error.code
        : "SDK_NETWORK_ERROR";
      const details = {
        durationMs: Date.now() - startedAt,
        statusCode: error?.statusCode ?? metadata.statusCode,
        responseClass: error?.responseClass,
        errorName,
        errorConstructorName,
        sdkErrorName: error?.sdkErrorName ?? errorConstructorName,
        safeMessageCode,
        outcome: error?.uncertain === false
          ? PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE
          : PIXELPAY_SALE_OUTCOME.UNCERTAIN,
        contentType: error?.upstreamContentType ?? metadata.contentType,
        cfRay: error?.cfRay ?? metadata.cfRay,
        cardExpireFormatValid: error?.cardExpireFormatValid ?? inputDiagnostics.cardExpireFormatValid,
        cardExpireFuture: error?.cardExpireFuture ?? inputDiagnostics.cardExpireFuture,
        billingAddressLength: error?.billingAddressLength ?? inputDiagnostics.billingAddressLength,
      };
      emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.FAILED, attempt, details);
      if (details.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN) {
        emitPixelPaySaleEvent(logger, PIXELPAY_SALE_EVENT.UNCERTAIN, attempt, details);
      }
      if (error instanceof PixelPaySdkError) {
        error.paymentAttemptId = attempt.paymentAttemptId;
        error.cardExpireFormatValid ??= inputDiagnostics.cardExpireFormatValid;
        error.cardExpireFuture ??= inputDiagnostics.cardExpireFuture;
        error.billingAddressLength ??= inputDiagnostics.billingAddressLength;
        throw error;
      }
      throw new PixelPaySdkError("PIXELPAY_NETWORK_ERROR", "No fue posible confirmar la respuesta de PixelPay.", {
        uncertain: true,
        statusCode: metadata.statusCode,
        sdkErrorName: errorConstructorName,
        errorName,
        errorConstructorName,
        responseClass: safeClassName(error?.response),
        safeMessageCode,
        upstreamContentType: metadata.contentType,
        cfRay: metadata.cfRay,
        paymentAttemptId: attempt.paymentAttemptId,
        ...inputDiagnostics,
      });
    }

    const statusCode = responseStatus(response);
    const transactionResult = this.readTransactionResult(response);
    const result = transactionResult.result;
    const paymentUuid = text(result?.payment_uuid) || null;
    const transactionId = text(result?.transaction_id) || null;
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
    const responseMetadata = readPixelPayHttpMetadata(response);
    const diagnostics = {
      paymentAttemptId: attempt.paymentAttemptId,
      sdkResponseClass: safeClassName(response),
      statusCode,
      responseSuccess: responseSuccess(response),
      safeMessageCode: classifySdkFailureMessage(response),
      transactionResultValid: transactionResult.valid,
      transactionResultDataPresent: transactionResult.dataPresent,
      transactionResultParsed: transactionResult.parsed,
      responseApproved: normalizedResponse.data.responseApproved,
      responseIncomplete: normalizedResponse.data.responseIncomplete,
      responseCodePresent: Boolean(normalizedResponse.data.responseCode),
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

  async queryPaymentStatus(paymentUuid) {
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
    } catch {
      throw new PixelPaySdkError(
        "PIXELPAY_NETWORK_ERROR",
        "No fue posible confirmar el estado en PixelPay.",
        { uncertain: true, paymentUuid: normalizedUuid }
      );
    }

    const statusCode = responseStatus(response);
    const transactionResult = this.readTransactionResult(response);
    const result = transactionResult.result;
    const status = text(result?.status).toUpperCase() || "UNKNOWN";
    return {
      ok: statusCode != null && statusCode >= 200 && statusCode < 300,
      statusCode,
      success: responseSuccess(response),
      paymentUuid: normalizedUuid,
      status,
      response: {
        success: responseSuccess(response),
        data: { status },
      },
    };
  }
}
