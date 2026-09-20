import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  createPixelPayPaymentHash,
  createPixelPaySaleSignature,
  createPixelPayStatusSignature,
  hashPixelPaySecret,
  PixelPayDirectProvider,
} from "../src/services/payments/PixelPayDirectProvider.js";

const SECRET = "qa-secret-not-real";
const KEY_ID = "qa-key-not-real";
const APP_URL = "https://qa.masterfade.example";
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
  return {
    success: true,
    response_approved: true,
    response_incomplete: false,
    payment_uuid: PAYMENT_UUID,
    transaction_id: "tx-qa-123",
    payment_hash: createPixelPayPaymentHash({ orderId: ORDER_ID, keyId: KEY_ID, secretKey: SECRET }),
    order_amount: "115.00",
    ...overrides,
  };
}

const saleInput = {
  orderId: ORDER_ID,
  currency: "HNL",
  amount: 115,
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  billing: { address: "QA 1", country: "HN", state: "FM", city: "TGU", phone: "99999999" },
  card: { number: "4111 1111 1111 1111", holder: "ADA LOVELACE", expire: "12/30", cvv: "123" },
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

test("x-auth-hash es SHA-512 hexadecimal de Secret Key", () => {
  assert.equal(hashPixelPaySecret(SECRET), crypto.createHash("sha512").update(SECRET).digest("hex"));
});

test("sale aprobado exige todos los indicadores, hash y monto", async () => {
  const result = await makeProvider(approvedPayload()).sale(saleInput);
  assert.equal(result.approved, true);
  assert.equal(result.paymentHashValid, true);
  assert.equal(result.amountMatches, true);
});

test("sale rechazado es definitivo", async () => {
  const result = await makeProvider({ success: false, response_approved: false }).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.definitive, true);
});

test("response_approved=false nunca se aprueba", async () => {
  const result = await makeProvider(approvedPayload({ response_approved: false })).sale(saleInput);
  assert.equal(result.approved, false);
});

test("payment_hash invalido nunca se aprueba", async () => {
  const result = await makeProvider(approvedPayload({ payment_hash: "invalid" })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.paymentHashValid, false);
});

test("monto distinto nunca se aprueba", async () => {
  const result = await makeProvider(approvedPayload({ order_amount: "114.99" })).sale(saleInput);
  assert.equal(result.approved, false);
  assert.equal(result.amountMatches, false);
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
      return { ok: true, status: 200, json: async () => ({ status: "paid" }) };
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
