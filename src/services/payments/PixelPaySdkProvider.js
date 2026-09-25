import PixelPaySdk from "@pixelpay/sdk-core";
import { PaymentProvider } from "./PaymentProvider.js";
import {
  createPixelPaySaleSignature,
  createPixelPayStatusSignature,
  classifyPixelPaySaleResult,
  HONDURAS_ISO_3166_2_CODES,
  PIXELPAY_SALE_OUTCOME,
} from "./PixelPayDirectProvider.js";

const HONDURAS_ISO_3166_2_CODE_SET = new Set(HONDURAS_ISO_3166_2_CODES);

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

function normalizeCardExpire(value) {
  const normalized = text(value);
  if (!/^[0-9]{2}(0[1-9]|1[0-2])$/.test(normalized)) {
    throw new PixelPaySdkError(
      "PIXELPAY_CARD_EXPIRE_INVALID",
      "La fecha de expiracion no tiene el formato YYMM requerido por PixelPay."
    );
  }
  return normalized;
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

function assertSdkShape(sdk) {
  const requiredConstructors = [
    sdk?.Models?.Settings,
    sdk?.Models?.Order,
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
  if (
    typeof sdk?.Services?.Transaction?.withConcurrency !== "function"
    || !sdk?.Resources?.Environment?.SANDBOX
  ) {
    throw new Error("@pixelpay/sdk-core no expone la configuracion Sandbox requerida.");
  }
}

export class PixelPaySdkError extends Error {
  constructor(code, message, {
    uncertain = false,
    paymentUuid = null,
    statusCode = null,
  } = {}) {
    super(message);
    this.name = "PixelPaySdkError";
    this.code = code;
    this.uncertain = uncertain;
    this.paymentUuid = text(paymentUuid) || null;
    this.statusCode = statusCode != null && Number.isInteger(Number(statusCode))
      ? Number(statusCode)
      : null;
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
  } = {}) {
    super();
    this.endpoint = text(endpoint).replace(/\/+$/, "");
    this.env = text(env).toLowerCase();
    this.keyId = text(keyId);
    this.secretKey = text(secretKey);
    this.authHash = text(authHash);
    this.appUrl = text(appUrl).replace(/\/+$/, "");
    this.sdk = sdk;

    if (
      this.env !== "sandbox"
      || this.endpoint !== "https://pixelpay.dev"
      || this.appUrl !== "https://pixelpay.dev"
    ) {
      throw new Error("PixelPay SDK solo esta habilitado para sandbox QA.");
    }
    if (!this.keyId || !this.secretKey || !this.authHash || !this.appUrl) {
      throw new Error("Configuracion PixelPay SDK incompleta.");
    }
    assertSdkShape(this.sdk);

    // El SDK bloquea globalmente transacciones concurrentes por defecto. MasterFade
    // ya serializa cada intent con advisory lock y debe permitir intents distintos.
    this.sdk.Services.Transaction.withConcurrency();
  }

  createTransaction(signature) {
    const settings = new this.sdk.Models.Settings();
    settings.setupEndpoint(this.endpoint);
    settings.setupCredentials(this.keyId, this.authHash);
    settings.setupEnvironment(this.sdk.Resources.Environment.SANDBOX);
    settings.setupHeaders({ "x-client-signature": signature });
    return new this.sdk.Services.Transaction(settings);
  }

  buildSaleRequest({ orderId, currency, amount, customer, billing, card } = {}) {
    const normalizedExpire = normalizeCardExpire(card?.expire);

    const order = new this.sdk.Models.Order();
    order.id = text(orderId);
    order.currency = text(currency).toUpperCase();
    order.amount = Number(amount);
    order.customer_name = text(customer?.name);
    order.customer_email = text(customer?.email);

    const paymentCard = new this.sdk.Models.Card();
    paymentCard.number = text(card?.number).replace(/\D+/g, "");
    paymentCard.cvv2 = text(card?.cvv).replace(/\D+/g, "");
    paymentCard.expire_year = 2000 + Number(normalizedExpire.slice(0, 2));
    paymentCard.expire_month = Number(normalizedExpire.slice(2, 4));
    paymentCard.cardholder = text(card?.holder);

    const paymentBilling = new this.sdk.Models.Billing();
    paymentBilling.address = text(billing?.address);
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
    if (!TransactionResult.validateResponse(response) || !objectOrNull(response?.data)) {
      return null;
    }
    try {
      return TransactionResult.fromResponse(response);
    } catch {
      return null;
    }
  }

  async sale(input = {}) {
    const signature = createPixelPaySaleSignature({
      secretKey: this.secretKey,
      appKey: this.keyId,
      orderId: input.orderId,
      appUrl: this.appUrl,
    });
    const transaction = this.createTransaction(signature);
    const saleRequest = this.buildSaleRequest(input);

    let response;
    try {
      response = await transaction.doSale(saleRequest);
    } catch {
      throw new PixelPaySdkError(
        "PIXELPAY_NETWORK_ERROR",
        "No fue posible confirmar la respuesta de PixelPay.",
        { uncertain: true }
      );
    }

    const statusCode = responseStatus(response);
    const result = this.readTransactionResult(response);
    const paymentUuid = text(result?.payment_uuid) || null;
    const transactionId = text(result?.transaction_id) || null;
    let paymentHashValid = false;
    if (text(result?.payment_hash)) {
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
    const transactionAmountMatches = money(result?.transaction_amount) === money(input.amount);
    const approvedAmountMatches = money(result?.transaction_approved_amount) === money(input.amount);
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
    const result = this.readTransactionResult(response);
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
