import crypto from "node:crypto";
import { PaymentProvider } from "./PaymentProvider.js";

const SALE_PATH = "/api/v2/transaction/sale";
const STATUS_PATH = "/api/v2/transaction/status";

function text(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

export function hashPixelPaySecret(secretKey) {
  return crypto.createHash("sha512").update(text(secretKey), "utf8").digest("hex");
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

function timingSafeHexEqual(actual, expected) {
  const left = Buffer.from(text(actual).toLowerCase(), "utf8");
  const right = Buffer.from(text(expected).toLowerCase(), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
  constructor({ endpoint, env, keyId, secretKey, appUrl, timeoutMs = 12000, fetchImpl = globalThis.fetch } = {}) {
    super();
    this.endpoint = text(endpoint).replace(/\/+$/, "");
    this.env = text(env).toLowerCase();
    this.keyId = text(keyId);
    this.secretKey = text(secretKey);
    this.appUrl = text(appUrl).replace(/\/+$/, "");
    this.timeoutMs = Number(timeoutMs);
    this.fetchImpl = fetchImpl;

    if (this.env !== "sandbox" || this.endpoint !== "https://pixelpay.dev") {
      throw new Error("PixelPay Direct solo esta habilitado para sandbox QA.");
    }
    if (!this.keyId || !this.secretKey || !this.appUrl || typeof this.fetchImpl !== "function") {
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
      "x-auth-hash": hashPixelPaySecret(this.secretKey),
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
      card_expire: text(card?.expire).replace(/\D+/g, ""),
      card_cvv: text(card?.cvv).replace(/\D+/g, ""),
      billing_address: text(billing?.address),
      billing_country: text(billing?.country),
      billing_state: text(billing?.state),
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
    const payload = result.payload && typeof result.payload === "object" ? result.payload : {};
    const paymentUuid = text(payload.payment_uuid) || null;
    const transactionId = text(payload.transaction_id) || null;
    const approved = result.ok
      && payload.success === true
      && payload.response_approved === true
      && payload.response_incomplete !== true
      && Boolean(paymentUuid)
      && Boolean(transactionId);
    const paymentHashValid = timingSafeHexEqual(
      payload.payment_hash,
      createPixelPayPaymentHash({ orderId, keyId: this.keyId, secretKey: this.secretKey })
    );
    const amountMatches = money(payload.order_amount ?? payload.amount) === money(amount);

    return {
      approved: approved && paymentHashValid && amountMatches,
      definitive: (result.statusCode >= 400 && result.statusCode < 500)
        || payload.response_approved === false
        || payload.success === false,
      incomplete: payload.response_incomplete === true,
      paymentUuid,
      transactionId,
      paymentHashValid,
      amountMatches,
      statusCode: result.statusCode,
      raw: payload,
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
    return {
      ok: result.ok,
      paymentUuid: normalizedUuid,
      status: text(result.payload?.status).toUpperCase() || "UNKNOWN",
      raw: result.payload,
    };
  }
}
