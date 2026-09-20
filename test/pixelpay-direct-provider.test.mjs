import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  createPixelPayPaymentHash,
  createPixelPaySaleSignature,
  createPixelPayStatusSignature,
  hashPixelPaySecret,
  normalizePixelPaySaleResponse,
  normalizePixelPayStatusResponse,
  PIXELPAY_SALE_OUTCOME,
  PixelPayDirectProvider,
} from "../src/services/payments/PixelPayDirectProvider.js";

const SECRET = "qa-secret-not-real";
const KEY_ID = "qa-key-not-real";
const APP_URL = "https://pixelpay.dev";
const ORDER_ID = "MF-PIXELPAY-ABC123";
const PAYMENT_UUID = "11111111-2222-4333-8444-555555555555";

function expectedHmac(message) {
  return crypto.createHmac("sha3-512", SECRET).update(message, "utf8").digest("hex");
}

function makeProvider(payload, { ok = true, status = 200 } = {}) {
  return new PixelPayDirectProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    appUrl: APP_URL,
    timeoutMs: 1000,
    fetchImpl: async () => ({ ok, status, json: async () => payload }),
  });
}

function approvedPayload(overrides = {}) {
  const dataOverrides = overrides.data || {};
  return {
    success: true,
    message: "Transacción completada exitosamente",
    ...overrides,
    data: {
      transaction_type: "sale",
      transaction_approved_amount: 115,
      transaction_amount: 115,
      transaction_id: "1f694eee-4715-45b8-a545-000000000000",
      response_approved: true,
      response_incomplete: false,
      response_code: "00",
      payment_uuid: PAYMENT_UUID,
      payment_hash: createPixelPayPaymentHash({ orderId: ORDER_ID, keyId: KEY_ID, secretKey: SECRET }),
      ...dataOverrides,
    },
  };
}

const saleInput = {
  orderId: ORDER_ID,
  currency: "HNL",
  amount: 115,
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  billing: { address: "QA 1", country: "HN", state: "HN-FM", city: "TGU", phone: "99999999" },
  card: { number: "4111 1111 1111 1111", holder: "ADA LOVELACE", expire: "3012", cvv: "123" },
};

test("firma sale con HMAC-SHA3-512 sobre app_key|order_id|app_url", () => {
  assert.equal(
    createPixelPaySaleSignature({ secretKey: SECRET, appKey: KEY_ID, orderId: ORDER_ID, appUrl: APP_URL }),
    expectedHmac(`${KEY_ID}|${ORDER_ID}|${APP_URL}`)
  );
});

test("firma status con HMAC-SHA3-512 sobre app_key|payment_uuid|app_url", () => {
  assert.equal(
    createPixelPayStatusSignature({ secretKey: SECRET, appKey: KEY_ID, paymentUuid: PAYMENT_UUID, appUrl: APP_URL }),
    expectedHmac(`${KEY_ID}|${PAYMENT_UUID}|${APP_URL}`)
  );
});

test("Sandbox exige app_url documental https://pixelpay.dev", () => {
  assert.throws(
    () => new PixelPayDirectProvider({
      endpoint: "https://pixelpay.dev",
      env: "sandbox",
      keyId: KEY_ID,
      secretKey: SECRET,
      appUrl: "https://qa.masterfade.example",
      timeoutMs: 1000,
      fetchImpl: async () => null,
    }),
    /solo esta habilitado para sandbox QA/
  );
});

test("x-auth-hash es SHA-512 hexadecimal de Secret Key", () => {
  assert.equal(hashPixelPaySecret(SECRET), crypto.createHash("sha512").update(SECRET).digest("hex"));
});

test("sale aprobado exige todos los indicadores, hash y monto", async () => {
  const result = await makeProvider(approvedPayload()).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.APPROVED);
  assert.equal(result.approved, true);
  assert.equal(result.paymentHashValid, true);
  assert.equal(result.amountMatches, true);
  assert.equal(result.transactionAmountMatches, true);
  assert.equal(result.approvedAmountMatches, true);
});

test("decline oficial HTTP 402 es definitivo aun sin hash ni montos", async () => {
  const result = await makeProvider({
    success: false,
    message: "Transacción declinada",
  }, { ok: false, status: 402 }).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED);
  assert.equal(result.approved, false);
  assert.equal(result.definitive, true);
  assert.equal(result.paymentHashValid, false);
  assert.equal(result.amountMatches, false);
});

test("response_approved=false en HTTP 200 no se adivina como decline definitivo", async () => {
  const result = await makeProvider(approvedPayload({ data: { response_approved: false } })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("approved con payment_hash invalido queda incierto y nunca se confirma", async () => {
  const result = await makeProvider(approvedPayload({ data: { payment_hash: "invalid" } })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.paymentHashValid, false);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("transaction_amount distinto nunca se aprueba", async () => {
  const result = await makeProvider(approvedPayload({ data: { transaction_amount: 114.99 } })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.transactionAmountMatches, false);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("transaction_approved_amount distinto nunca se aprueba", async () => {
  const result = await makeProvider(approvedPayload({ data: { transaction_approved_amount: 114.99 } })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.approvedAmountMatches, false);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("response_incomplete=true permanece no aprobada e incierta", async () => {
  const result = await makeProvider(approvedPayload({ data: { response_incomplete: true } })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.definitive, false);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("HTTP 500 con success=false siempre queda incierto", async () => {
  const result = await makeProvider({ success: false, message: "Error general del Sistema" }, {
    ok: false,
    status: 500,
  }).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  assert.equal(result.definitive, false);
});

test("HTTP 408 y decline incompleto siempre quedan inciertos", async () => {
  const timeoutResponse = await makeProvider({ success: false, message: "Error Timed Out" }, {
    ok: false,
    status: 408,
  }).sale(saleInput);
  const incompleteDecline = await makeProvider({
    success: false,
    message: "Transacción declinada",
    data: { response_incomplete: true },
  }, { ok: false, status: 402 }).sale(saleInput);
  assert.equal(timeoutResponse.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  assert.equal(incompleteDecline.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
});

test("HTTP 422 contractual es definitivo segun la tabla documental", async () => {
  const result = await makeProvider({ success: false, message: "Error de validación" }, {
    ok: false,
    status: 422,
  }).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE);
});

test("timeout produce error incierto y no filtra el secreto", async () => {
  const provider = new PixelPayDirectProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    appUrl: APP_URL,
    timeoutMs: 1000,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  });
  provider.timeoutMs = 1;
  await assert.rejects(
    provider.sale(saleInput),
    (error) => error.code === "PIXELPAY_TIMEOUT"
      && error.uncertain === true
      && !JSON.stringify(error).includes(SECRET)
  );
});

test("error de red produce error incierto", async () => {
  const provider = new PixelPayDirectProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    appUrl: APP_URL,
    timeoutMs: 1000,
    fetchImpl: async () => { throw new TypeError("network unavailable"); },
  });
  await assert.rejects(
    provider.sale(saleInput),
    (error) => error.code === "PIXELPAY_NETWORK_ERROR" && error.uncertain === true
  );
});

test("sale usa form-urlencoded sin PAN ni CVV en query string", async () => {
  let captured;
  const provider = new PixelPayDirectProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    appUrl: APP_URL,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, json: async () => approvedPayload() };
    },
  });
  await provider.sale(saleInput);
  assert.equal(captured.url, "https://pixelpay.dev/api/v2/transaction/sale");
  assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(captured.url.includes("4111111111111111"), false);
  assert.equal(captured.url.includes("123"), false);
  assert.equal(captured.options.body.get("card_number"), "4111111111111111");
  assert.equal(captured.options.body.get("card_expire"), "3012");
  assert.equal(captured.options.body.get("billing_state"), "HN-FM");
});

test("sale rechaza un codigo de departamento inexistente", async () => {
  await assert.rejects(
    () => makeProvider(approvedPayload()).sale({
      ...saleInput,
      billing: { ...saleInput.billing, state: "HN-ZZ" },
    }),
    (error) => error.code === "PIXELPAY_BILLING_STATE_INVALID"
  );
});

test("status usa form-urlencoded, payment_uuid y su firma especifica", async () => {
  let captured;
  const provider = new PixelPayDirectProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    appUrl: APP_URL,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: "Información obtenida con exito", data: { status: "paid" } }),
      };
    },
  });
  const result = await provider.queryPaymentStatus(PAYMENT_UUID);
  assert.equal(captured.url, "https://pixelpay.dev/api/v2/transaction/status");
  assert.equal(captured.options.body.get("payment_uuid"), PAYMENT_UUID);
  assert.equal(captured.options.body.get("env"), "sandbox");
  assert.equal(
    captured.options.headers["x-client-signature"],
    createPixelPayStatusSignature({ secretKey: SECRET, appKey: KEY_ID, paymentUuid: PAYMENT_UUID, appUrl: APP_URL })
  );
  assert.equal(result.status, "PAID");
});

test("normaliza los envelopes oficiales de sale y status", () => {
  const sale = normalizePixelPaySaleResponse(approvedPayload());
  const status = normalizePixelPayStatusResponse({ success: true, data: { status: "paid" } });
  assert.deepEqual(sale.data, {
    transactionApprovedAmount: 115,
    transactionAmount: 115,
    transactionId: "1f694eee-4715-45b8-a545-000000000000",
    responseApproved: true,
    responseIncomplete: false,
    responseCode: "00",
    paymentUuid: PAYMENT_UUID,
    paymentHash: createPixelPayPaymentHash({ orderId: ORDER_ID, keyId: KEY_ID, secretKey: SECRET }),
  });
  assert.equal(status.data.status, "PAID");
});
