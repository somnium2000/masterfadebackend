import crypto from "node:crypto";
import { PaymentProvider } from "./PaymentProvider.js";

const SALE_PATH = "/api/v2/transaction/sale";
const STATUS_PATH = "/api/v2/transaction/status";
export const PIXELPAY_SALE_OUTCOME = Object.freeze({
  APPROVED: "approved",
  PAYMENT_DECLINED: "payment_declined",
  REQUEST_ERROR_DEFINITIVE: "request_error_definitive",
  UNCERTAIN: "uncertain",
});
const PIXELPAY_DEFINITIVE_REQUEST_ERROR_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 406, 412, 418, 422]);
export const HONDURAS_ISO_3166_2_CODES = Object.freeze([
  "HN-AT", "HN-CH", "HN-CL", "HN-CM", "HN-CP", "HN-CR", "HN-EP", "HN-FM", "HN-GD",
  "HN-IB", "HN-IN", "HN-LE", "HN-LP", "HN-OC", "HN-OL", "HN-SB", "HN-VA", "HN-YO",
]);
const HONDURAS_ISO_3166_2_CODE_SET = new Set(HONDURAS_ISO_3166_2_CODES);

function text(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeCardExpire(value) {
  const normalized = text(value);
  if (!/^[0-9]{2}(0[1-9]|1[0-2])$/.test(normalized)) {
    throw new PixelPayDirectError(
      "PIXELPAY_CARD_EXPIRE_INVALID",
      "La fecha de expiracion no tiene el formato YYMM requerido por PixelPay."
    );
  }
  return normalized;
}

function normalizeBillingCountry(value) {
  const normalized = text(value).toUpperCase();
  if (normalized !== "HN") {
    throw new PixelPayDirectError("PIXELPAY_BILLING_COUNTRY_INVALID", "El pais de facturacion no es valido para QA.");
  }
  return normalized;
}

function normalizeBillingState(value) {
  const normalized = text(value).toUpperCase();
  if (!HONDURAS_ISO_3166_2_CODE_SET.has(normalized)) {
    throw new PixelPayDirectError(
      "PIXELPAY_BILLING_STATE_INVALID",
      "El departamento debe utilizar un codigo ISO 3166-2 de Honduras."
    );
  }
  return normalized;
}

function signPixelPay(secretKey, parts) {
  return crypto.createHmac("sha3-512", text(secretKey)).update(parts.join("|"), "utf8").digest("hex");
}

export function createPixelPaySaleSignature({ secretKey, appKey, orderId, appUrl }) {
  return signPixelPay(secretKey, [text(appKey), text(orderId), text(appUrl)]);
}

export function createPixelPayStatusSignature({ secretKey, appKey, paymentUuid, appUrl }) {
  return signPixelPay(secretKey, [text(appKey), text(paymentUuid), text(appUrl)]);
}

export function createPixelPayPaymentHash({ orderId, keyId, secretKey }) {
  return crypto.createHash("md5").update(`${text(orderId)}|${text(keyId)}|${text(secretKey)}`, "utf8").digest("hex");
}

export function normalizePixelPaySaleResponse(payload) {
  const envelope = objectOrEmpty(payload);
  const data = objectOrEmpty(envelope.data);
  return {
    success: typeof envelope.success === "boolean" ? envelope.success : null,
    message: text(envelope.message) || null,
    data: {
      transactionApprovedAmount: data.transaction_approved_amount,
      transactionAmount: data.transaction_amount,
      transactionId: text(data.transaction_id) || null,
      responseApproved: typeof data.response_approved === "boolean" ? data.response_approved : null,
      responseIncomplete: typeof data.response_incomplete === "boolean" ? data.response_incomplete : null,
      responseCode: text(data.response_code) || null,
      paymentUuid: text(data.payment_uuid) || null,
      paymentHash: text(data.payment_hash) || null,
    },
  };
}

export function normalizePixelPayStatusResponse(payload) {
  const envelope = objectOrEmpty(payload);
  const data = objectOrEmpty(envelope.data);
  return {
    success: typeof envelope.success === "boolean" ? envelope.success : null,
    message: text(envelope.message) || null,
    data: {
      status: text(data.status).toUpperCase() || "UNKNOWN",
    },
  };
}

function timingSafeHexEqual(actual, expected) {
  const left = Buffer.from(text(actual).toLowerCase(), "utf8");
  const right = Buffer.from(text(expected).toLowerCase(), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function classifyPixelPaySaleResult({
  statusCode,
  payload,
  paymentHashValid,
  amountMatches,
  paymentUuid,
  transactionId,
}) {
  const normalizedStatus = Number(statusCode);
  const incomplete = payload?.data?.responseIncomplete === true;
  if (incomplete || normalizedStatus === 408 || normalizedStatus >= 500) {
    return PIXELPAY_SALE_OUTCOME.UNCERTAIN;
  }

  const approved = normalizedStatus >= 200
    && normalizedStatus < 300
    && payload?.success === true
    && payload?.data?.responseApproved === true
    && payload?.data?.responseIncomplete === false
    && Boolean(paymentUuid)
    && Boolean(transactionId)
    && paymentHashValid === true
    && amountMatches === true;
  if (approved) return PIXELPAY_SALE_OUTCOME.APPROVED;

  if (normalizedStatus === 402) {
    return PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED;
  }

  if (PIXELPAY_DEFINITIVE_REQUEST_ERROR_HTTP_STATUSES.has(normalizedStatus)) {
    return PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE;
  }

  return PIXELPAY_SALE_OUTCOME.UNCERTAIN;
}

export class PixelPayDirectError extends Error {
  constructor(code, message, { uncertain = false, paymentUuid = null, statusCode = null } = {}) {
    super(message);
    this.name = "PixelPayDirectError";
    this.code = code;
    this.uncertain = uncertain;
    this.paymentUuid = text(paymentUuid) || null;
    this.statusCode = statusCode;
  }
}

export class PixelPayDirectProvider extends PaymentProvider {
  constructor({ endpoint, env, keyId, secretKey, authHash, appUrl, timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) {
    super();
    this.endpoint = text(endpoint).replace(/\/+$/, "");
    this.env = text(env).toLowerCase();
    this.keyId = text(keyId);
    this.secretKey = text(secretKey);
    this.authHash = text(authHash);
    this.appUrl = text(appUrl).replace(/\/+$/, "");
    this.timeoutMs = Number(timeoutMs);
    this.fetchImpl = fetchImpl;

    if (
      this.env !== "sandbox"
      || this.endpoint !== "https://pixelpay.dev"
      || this.appUrl !== "https://pixelpay.dev"
    ) {
      throw new Error("PixelPay Direct solo esta habilitado para sandbox QA.");
    }
    if (!this.keyId || !this.secretKey || !this.authHash || !this.appUrl || typeof this.fetchImpl !== "function") {
      throw new Error("Configuracion PixelPay Direct incompleta.");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 60000) {
      throw new Error("PIXELPAY_HTTP_TIMEOUT_MS invalido.");
    }
  }

  headers(signature) {
    return {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-auth-key": this.keyId,
      "x-auth-hash": this.authHash,
      "x-client-signature": signature,
    };
  }

  async post(path, body, signature) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method: "POST",
        headers: this.headers(signature),
        body,
        signal: controller.signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new PixelPayDirectError("PIXELPAY_RESPONSE_INVALID", "PixelPay devolvio una respuesta invalida.", {
          uncertain: response.ok,
          statusCode: response.status,
        });
      }
      return { ok: response.ok, statusCode: response.status, payload };
    } catch (error) {
      if (error instanceof PixelPayDirectError) throw error;
      const timeout = error?.name === "AbortError";
      throw new PixelPayDirectError(
        timeout ? "PIXELPAY_TIMEOUT" : "PIXELPAY_NETWORK_ERROR",
        timeout ? "PixelPay no respondio dentro del tiempo esperado." : "No fue posible confirmar la respuesta de PixelPay.",
        { uncertain: true }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async sale({ orderId, currency, amount, customer, billing, card } = {}) {
    const body = new URLSearchParams({
      customer_name: text(customer?.name),
      customer_email: text(customer?.email),
      card_number: text(card?.number).replace(/\D+/g, ""),
      card_holder: text(card?.holder),
      card_expire: normalizeCardExpire(card?.expire),
      card_cvv: text(card?.cvv).replace(/\D+/g, ""),
      billing_address: text(billing?.address),
      billing_country: normalizeBillingCountry(billing?.country),
      billing_state: normalizeBillingState(billing?.state),
      billing_city: text(billing?.city),
      billing_phone: text(billing?.phone),
      order_id: text(orderId),
      order_currency: text(currency).toUpperCase(),
      order_amount: money(amount),
      env: this.env,
    });
    const signature = createPixelPaySaleSignature({
      secretKey: this.secretKey,
      appKey: this.keyId,
      orderId,
      appUrl: this.appUrl,
    });
    const result = await this.post(SALE_PATH, body, signature);
    const payload = normalizePixelPaySaleResponse(result.payload);
    const paymentUuid = payload.data.paymentUuid;
    const transactionId = payload.data.transactionId;
    const paymentHashValid = timingSafeHexEqual(
      payload.data.paymentHash,
      createPixelPayPaymentHash({ orderId, keyId: this.keyId, secretKey: this.secretKey })
    );
    const transactionAmountMatches = money(payload.data.transactionAmount) === money(amount);
    const approvedAmountMatches = money(payload.data.transactionApprovedAmount) === money(amount);
    const amountMatches = transactionAmountMatches && approvedAmountMatches;
    const outcome = classifyPixelPaySaleResult({
      statusCode: result.statusCode,
      payload,
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
      incomplete: payload.data.responseIncomplete === true,
      paymentUuid,
      transactionId,
      paymentHashValid,
      amountMatches,
      transactionAmountMatches,
      approvedAmountMatches,
      statusCode: result.statusCode,
      response: payload,
    };
  }

  async queryPaymentStatus(paymentUuid) {
    const normalizedUuid = text(paymentUuid);
    const body = new URLSearchParams({ payment_uuid: normalizedUuid, env: this.env });
    const signature = createPixelPayStatusSignature({
      secretKey: this.secretKey,
      appKey: this.keyId,
      paymentUuid: normalizedUuid,
      appUrl: this.appUrl,
    });
    const result = await this.post(STATUS_PATH, body, signature);
    const payload = normalizePixelPayStatusResponse(result.payload);
    return {
      ok: result.ok,
      success: payload.success,
      paymentUuid: normalizedUuid,
      status: payload.data.status,
      response: payload,
    };
  }
}
