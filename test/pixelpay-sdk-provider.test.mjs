import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PixelPayDirectProvider, PIXELPAY_SALE_OUTCOME } from "../src/services/payments/PixelPayDirectProvider.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { PixelPaySdkProvider } from "../src/services/payments/PixelPaySdkProvider.js";

const KEY_ID = "qa-key-not-real";
const SECRET = "qa-secret-not-real";
const AUTH_HASH = "qa-auth-hash-not-real";
const ORDER_ID = "MF-SDK-ORDER-1";
const PAYMENT_UUID = "11111111-2222-4333-8444-555555555555";

const saleInput = {
  orderId: ORDER_ID,
  currency: "HNL",
  amount: 1,
  customer: { name: "Cliente QA", email: "qa@example.com" },
  billing: { address: "QA 1", country: "HN", state: "HN-CR", city: "SPS", phone: "99999999" },
  card: { number: "4111 1111 1111 1111", holder: "CLIENTE QA", expire: "2807", cvv: "999" },
};

function approvedData(overrides = {}) {
  return {
    transaction_approved_amount: 1,
    transaction_amount: 1,
    transaction_id: "transaction-sdk-qa",
    response_approved: true,
    response_incomplete: false,
    response_code: "00",
    payment_uuid: PAYMENT_UUID,
    payment_hash: "valid-hash",
    ...overrides,
  };
}

function makeFakeSdk({ saleResponse, statusResponse, saleError, statusError } = {}) {
  const calls = {
    concurrency: 0,
    sale: 0,
    status: 0,
    settings: [],
    saleRequest: null,
    statusRequest: null,
    hash: [],
  };

  class Settings {
    setupEndpoint(value) { this.endpoint = value; }
    setupCredentials(key, hash) { this.auth_key = key; this.auth_hash = hash; }
    setupEnvironment(value) { this.environment = value; }
    setupHeaders(value) { this.headers = value; }
  }
  class Order {}
  class Card {
    getExpireFormat() {
      return `${String(this.expire_year).slice(-2)}${String(this.expire_month).padStart(2, "0")}`;
    }
  }
  class Billing {}
  class SaleTransaction {
    setOrder(value) { this.order = value; }
    setCard(value) { this.card = value; }
    setBilling(value) { this.billing = value; }
  }
  class StatusTransaction {}
  class TransactionResult {
    static validateResponse(response) { return response?.transactionResultValid === true; }
    static fromResponse(response) { return { ...response.data }; }
  }
  class Transaction {
    static withConcurrency() { calls.concurrency += 1; }
    constructor(settings) { this.settings = settings; calls.settings.push(settings); }
    async doSale(request) {
      calls.sale += 1;
      calls.saleRequest = request;
      if (saleError) throw saleError;
      return saleResponse;
    }
    async getStatus(request) {
      calls.status += 1;
      calls.statusRequest = request;
      if (statusError) throw statusError;
      return statusResponse;
    }
    verifyPaymentHash(hash, orderId, secret) {
      calls.hash.push({ hash, orderId, secret });
      return hash === "valid-hash" && orderId === ORDER_ID && secret === SECRET;
    }
  }

  return {
    calls,
    sdk: {
      Models: { Settings, Order, Card, Billing },
      Requests: { SaleTransaction, StatusTransaction },
      Services: { Transaction },
      Entities: { TransactionResult },
      Resources: { Environment: { SANDBOX: "sandbox" } },
    },
  };
}

function sdkResponse(status, { success = status >= 200 && status < 300, data = null, valid = true } = {}) {
  return {
    status,
    success,
    data,
    transactionResultValid: valid,
    getStatus() { return this.status; },
  };
}

function makeProvider(fake) {
  return new PixelPaySdkProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    authHash: AUTH_HASH,
    appUrl: "https://pixelpay.dev",
    sdk: fake.sdk,
  });
}

test("SDK aprobado valido se adapta al contrato MasterFade", async () => {
  const fake = makeFakeSdk({ saleResponse: sdkResponse(200, { data: approvedData() }) });
  const result = await makeProvider(fake).sale(saleInput);

  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.APPROVED);
  assert.equal(result.approved, true);
  assert.equal(result.definitive, false);
  assert.equal(result.paymentUuid, PAYMENT_UUID);
  assert.equal(result.transactionId, "transaction-sdk-qa");
  assert.equal(result.paymentHashValid, true);
  assert.equal(result.amountMatches, true);
  assert.equal(result.statusCode, 200);
  assert.equal(fake.calls.sale, 1);
  assert.equal(fake.calls.concurrency, 1);
  assert.equal(fake.calls.saleRequest.order.id, ORDER_ID);
  assert.equal(fake.calls.saleRequest.order.amount, 1);
  assert.equal(fake.calls.saleRequest.card.getExpireFormat(), "2807");
  assert.equal(fake.calls.saleRequest.billing.state, "HN-CR");
  assert.equal(fake.calls.settings[0].endpoint, "https://pixelpay.dev");
  assert.equal(fake.calls.settings[0].environment, "sandbox");
  assert.equal(fake.calls.settings[0].auth_key, KEY_ID);
  assert.equal(fake.calls.settings[0].auth_hash, AUTH_HASH);
  assert.match(fake.calls.settings[0].headers["x-client-signature"], /^[a-f0-9]{128}$/);
});

test("SDK declined HTTP 402 es definitivo", async () => {
  const fake = makeFakeSdk({
    saleResponse: sdkResponse(402, { success: false, data: {}, valid: true }),
  });
  const result = await makeProvider(fake).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED);
  assert.equal(result.approved, false);
  assert.equal(result.definitive, true);
});

test("SDK error contractual HTTP 422 es definitivo", async () => {
  const fake = makeFakeSdk({
    saleResponse: sdkResponse(422, { success: false, data: {}, valid: false }),
  });
  const result = await makeProvider(fake).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.REQUEST_ERROR_DEFINITIVE);
  assert.equal(result.definitive, true);
});

test("SDK timeout, network y respuesta invalida permanecen uncertain sin retry de Sale", async (t) => {
  await t.test("timeout HTTP 408", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(408, { success: false, data: {}, valid: true }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.definitive, false);
    assert.equal(fake.calls.sale, 1);
  });

  await t.test("network exception", async () => {
    const fake = makeFakeSdk({ saleError: new Error("network unavailable") });
    await assert.rejects(
      makeProvider(fake).sale(saleInput),
      (error) => error.code === "PIXELPAY_NETWORK_ERROR" && error.uncertain === true
    );
    assert.equal(fake.calls.sale, 1);
  });

  await t.test("network FailureResponse HTTP 520", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(520, { success: false, data: null, valid: false }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.definitive, false);
    assert.equal(result.statusCode, 520);
    assert.equal(fake.calls.sale, 1);
  });

  await t.test("respuesta no validada por TransactionResult", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { success: true, data: approvedData(), valid: false }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.paymentUuid, null);
    assert.equal(fake.calls.sale, 1);
  });
});

test("SDK nunca aprueba hash invalido, amount mismatch ni payment_uuid ausente", async (t) => {
  await t.test("hash invalido", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ payment_hash: "invalid-hash" }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.paymentHashValid, false);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  });

  await t.test("amount mismatch", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ transaction_amount: 2 }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.amountMatches, false);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  });

  await t.test("payment_uuid ausente", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ payment_uuid: null }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.paymentUuid, null);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  });
});

test("SDK Status usa getStatus solo cuando existe payment_uuid", async () => {
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { data: { status: "paid" }, valid: false }),
  });
  const provider = makeProvider(fake);
  const result = await provider.queryPaymentStatus(PAYMENT_UUID);

  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.status, "PAID");
  assert.equal(result.paymentUuid, PAYMENT_UUID);
  assert.equal(fake.calls.status, 1);
  assert.equal(fake.calls.statusRequest.payment_uuid, PAYMENT_UUID);
  assert.match(fake.calls.settings[0].headers["x-client-signature"], /^[a-f0-9]{128}$/);

  await assert.rejects(
    provider.queryPaymentStatus(""),
    (error) => error.code === "PIXELPAY_PAYMENT_UUID_MISSING" && error.uncertain === false
  );
  assert.equal(fake.calls.status, 1);
});

test("SDK sanitiza excepciones y no expone PAN, CVV ni credenciales", async () => {
  const sensitiveMessage = [saleInput.card.number.replace(/\D+/g, ""), saleInput.card.cvv, SECRET, AUTH_HASH].join(" ");
  const fake = makeFakeSdk({ saleError: new Error(sensitiveMessage) });

  await assert.rejects(
    makeProvider(fake).sale(saleInput),
    (error) => {
      const serialized = JSON.stringify(error);
      assert.equal(error.code, "PIXELPAY_NETWORK_ERROR");
      assert.equal(error.uncertain, true);
      assert.doesNotMatch(serialized, new RegExp(saleInput.card.number.replace(/\D+/g, "")));
      assert.doesNotMatch(serialized, new RegExp(SECRET));
      assert.doesNotMatch(serialized, new RegExp(AUTH_HASH));
      assert.doesNotMatch(serialized, /CVV|Authorization|x-client-signature/i);
      return true;
    }
  );
  assert.equal(fake.calls.sale, 1);

  const responseFake = makeFakeSdk({
    saleResponse: {
      ...sdkResponse(520, { success: false, data: null, valid: false }),
      message: sensitiveMessage,
    },
  });
  const result = await makeProvider(responseFake).sale(saleInput);
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(saleInput.card.number.replace(/\D+/g, "")));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(AUTH_HASH));
});

test("PaymentProviderFactory conserva direct por default y permite sdk explicito", () => {
  const names = [
    "PAYMENT_PROVIDER",
    "PIXELPAY_IMPLEMENTATION",
    "PIXELPAY_ENDPOINT",
    "PIXELPAY_ENV",
    "PIXELPAY_KEY_ID",
    "PIXELPAY_SECRET_KEY",
    "PIXELPAY_AUTH_HASH",
    "PIXELPAY_APP_URL",
    "PIXELPAY_HTTP_TIMEOUT_MS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    Object.assign(process.env, {
      PAYMENT_PROVIDER: "pixelpay",
      PIXELPAY_ENDPOINT: "https://pixelpay.dev",
      PIXELPAY_ENV: "sandbox",
      PIXELPAY_KEY_ID: KEY_ID,
      PIXELPAY_SECRET_KEY: SECRET,
      PIXELPAY_AUTH_HASH: AUTH_HASH,
      PIXELPAY_APP_URL: "https://pixelpay.dev",
      PIXELPAY_HTTP_TIMEOUT_MS: "1000",
    });

    delete process.env.PIXELPAY_IMPLEMENTATION;
    PaymentProviderFactory.reset();
    assert.ok(PaymentProviderFactory.create() instanceof PixelPayDirectProvider);

    process.env.PIXELPAY_IMPLEMENTATION = "sdk";
    PaymentProviderFactory.reset();
    assert.ok(PaymentProviderFactory.create() instanceof PixelPaySdkProvider);

    process.env.PIXELPAY_IMPLEMENTATION = "invalid";
    PaymentProviderFactory.reset();
    assert.throws(() => PaymentProviderFactory.create(), /PIXELPAY_IMPLEMENTATION invalido/);
  } finally {
    PaymentProviderFactory.reset();
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("dependencia SDK y variable de seleccion quedan declaradas sin secretos", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.equal(packageJson.dependencies["@pixelpay/sdk-core"], "2.5.8");
  assert.match(envExample, /^PIXELPAY_IMPLEMENTATION=direct$/m);
  assert.match(envExample, /^PIXELPAY_SECRET_KEY=$/m);
  assert.match(envExample, /^PIXELPAY_AUTH_HASH=$/m);
});

test("SDK oficial carga en ESM y construye sus modelos sin ejecutar red", () => {
  const provider = new PixelPaySdkProvider({
    endpoint: "https://pixelpay.dev",
    env: "sandbox",
    keyId: KEY_ID,
    secretKey: SECRET,
    authHash: AUTH_HASH,
    appUrl: "https://pixelpay.dev",
  });
  const request = provider.buildSaleRequest(saleInput);
  assert.equal(request.constructor.name, "SaleTransaction");
  assert.equal(request.order_id, ORDER_ID);
  assert.equal(request.order_currency, "HNL");
  assert.equal(request.order_amount, "1");
  assert.equal(request.card_expire, "2807");
  assert.equal(request.billing_country, "HN");
  assert.equal(request.billing_state, "HN-CR");
});
