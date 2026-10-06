import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import { PixelPayDirectProvider, PIXELPAY_SALE_OUTCOME } from "../src/services/payments/PixelPayDirectProvider.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import {
  classifySdkFailureMessage,
  PixelPaySdkProvider,
} from "../src/services/payments/PixelPaySdkProvider.js";
import { classifyPixelPayStatusResult } from "../src/routes/v1/public/pagos.js";
import envPlugin from "../src/plugins/env.js";
import { PIXELPAY_SALE_EVENT } from "../src/services/payments/pixelPaySaleTelemetry.js";

const KEY_ID = "qa-key-not-real";
const SECRET = "qa-secret-not-real";
const AUTH_HASH = "qa-auth-hash-not-real";
const ORDER_ID = "MF-SDK-ORDER-1";
const PAYMENT_UUID = "11111111-2222-4333-8444-555555555555";

const saleInput = {
  orderId: ORDER_ID,
  currency: "HNL",
  amount: 1,
  items: [{ code: "service-qa", title: "Servicio QA", price: 1, qty: 1 }],
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

function makeFakeSdk({
  saleResponse,
  statusResponse,
  saleError,
  statusError,
  transactionResult,
  transactionResultError,
} = {}) {
  const calls = {
    concurrency: 0,
    sale: 0,
    status: 0,
    settings: [],
    setupSandbox: 0,
    setupEndpoint: 0,
    setupCredentials: 0,
    setupEnvironment: 0,
    setupHeaders: [],
    items: [],
    addItem: 0,
    saleRequest: null,
    statusRequest: null,
    hash: [],
    validateResponse: 0,
    fromResponse: 0,
  };

  class Settings {
    setupSandbox() {
      calls.setupSandbox += 1;
      this.endpoint = "https://pixelpay.dev";
      this.auth_key = "1234567890";
      this.auth_hash = "official-sandbox-auth-hash";
      this.environment = "sandbox";
    }
    setupEndpoint(value) { calls.setupEndpoint += 1; this.endpoint = value; }
    setupCredentials(key, hash) { calls.setupCredentials += 1; this.auth_key = key; this.auth_hash = hash; }
    setupEnvironment(value) { calls.setupEnvironment += 1; this.environment = value; }
    setupHeaders(value) { calls.setupHeaders.push(value); this.headers = value; }
  }
  class Item {
    constructor() {
      calls.items.push(this);
    }
    totalize() {
      this.total = this.price * this.qty;
      return this;
    }
  }
  class Order {
    constructor() { this.content = []; }
    addItem(item) {
      calls.addItem += 1;
      this.content.push(item);
      this.amount = this.content.reduce((sum, entry) => sum + (entry.price * entry.qty), 0);
      return this;
    }
  }
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
    static validateResponse(response) {
      calls.validateResponse += 1;
      return response?.transactionResultValid === true;
    }
    static fromResponse(response) {
      calls.fromResponse += 1;
      if (transactionResultError) throw transactionResultError;
      return transactionResult === undefined ? { ...response.data } : transactionResult;
    }
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
      Models: { Settings, Order, Item, Card, Billing },
      Requests: { SaleTransaction, StatusTransaction },
      Services: { Transaction },
      Entities: { TransactionResult },
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
    appUrl: "https://pixelpay.dev",
    sdk: fake.sdk,
  });
}

function makeTelemetryLogger() {
  const events = [];
  return {
    events,
    info(payload) { events.push(payload); },
    warn(payload) { events.push(payload); },
  };
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
  assert.deepEqual(result.diagnostics, {
    paymentAttemptId: result.paymentAttemptId,
    sdkResponseClass: "Object",
    statusCode: 200,
    responseSuccess: true,
    safeMessageCode: "SDK_MESSAGE_ABSENT",
    transactionResultValid: true,
    transactionResultDataPresent: true,
    transactionResultParsed: true,
    responseApproved: true,
    responseIncomplete: false,
    responseCodePresent: true,
    hasPaymentUuid: true,
    hasTransactionId: true,
    hasPaymentHash: true,
    paymentHashValid: true,
    transactionAmountPresent: true,
    approvedAmountPresent: true,
    transactionAmountMatches: true,
    approvedAmountMatches: true,
    amountMatches: true,
    outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
  });
  assert.equal(fake.calls.sale, 1);
  assert.equal(fake.calls.concurrency, 1);
  assert.equal(fake.calls.saleRequest.order.id, ORDER_ID);
  assert.equal(fake.calls.saleRequest.order.amount, 1);
  assert.equal(fake.calls.saleRequest.order.constructor.name, "Order");
  assert.equal(fake.calls.saleRequest.order.content.length, 1);
  assert.equal(fake.calls.saleRequest.order.content[0].constructor.name, "Item");
  assert.deepEqual({
    code: fake.calls.saleRequest.order.content[0].code,
    title: fake.calls.saleRequest.order.content[0].title,
    price: fake.calls.saleRequest.order.content[0].price,
    qty: fake.calls.saleRequest.order.content[0].qty,
  }, saleInput.items[0]);
  assert.equal(fake.calls.addItem, 1);
  assert.equal(fake.calls.saleRequest.constructor.name, "SaleTransaction");
  assert.equal(fake.calls.saleRequest.card.constructor.name, "Card");
  assert.deepEqual({
    number: fake.calls.saleRequest.card.number,
    cardholder: fake.calls.saleRequest.card.cardholder,
    expire_month: fake.calls.saleRequest.card.expire_month,
    expire_year: fake.calls.saleRequest.card.expire_year,
    cvv2: fake.calls.saleRequest.card.cvv2,
  }, {
    number: "4111111111111111",
    cardholder: "CLIENTE QA",
    expire_month: 7,
    expire_year: 2028,
    cvv2: "999",
  });
  assert.equal(fake.calls.saleRequest.card.getExpireFormat(), "2807");
  assert.equal(fake.calls.saleRequest.billing.constructor.name, "Billing");
  assert.deepEqual({
    address: fake.calls.saleRequest.billing.address,
    country: fake.calls.saleRequest.billing.country,
    state: fake.calls.saleRequest.billing.state,
    city: fake.calls.saleRequest.billing.city,
    phone: fake.calls.saleRequest.billing.phone,
  }, saleInput.billing);
  assert.equal(fake.calls.settings[0].endpoint, "https://pixelpay.dev");
  assert.equal(fake.calls.settings[0].environment, "sandbox");
  assert.equal(fake.calls.settings[0].auth_key, "1234567890");
  assert.equal(fake.calls.settings[0].auth_hash, "official-sandbox-auth-hash");
  assert.match(fake.calls.settings[0].headers["x-client-signature"], /^[a-f0-9]{128}$/);
  assert.equal(fake.calls.setupSandbox, 1);
  assert.equal(fake.calls.setupEndpoint, 0);
  assert.equal(fake.calls.setupCredentials, 0);
  assert.equal(fake.calls.setupEnvironment, 0);
  assert.equal(fake.calls.setupHeaders.length, 1);
});

test("telemetria correlaciona STARTED, HTTP_STARTED y RESPONSE_RECEIVED en Sale simulada", async () => {
  const logger = makeTelemetryLogger();
  const fake = makeFakeSdk({ saleResponse: sdkResponse(200, { data: approvedData() }) });
  const result = await makeProvider(fake).sale(saleInput, {
    requestId: "req-telemetry-ok",
    idIntent: "intent-telemetry-ok",
    logger,
  });
  assert.deepEqual(logger.events.map((entry) => entry.event), [
    PIXELPAY_SALE_EVENT.ATTEMPT_STARTED,
    PIXELPAY_SALE_EVENT.HTTP_STARTED,
    PIXELPAY_SALE_EVENT.RESPONSE_RECEIVED,
  ]);
  assert.ok(result.paymentAttemptId);
  assert.ok(logger.events.every((entry) => entry.paymentAttemptId === result.paymentAttemptId));
  assert.ok(logger.events.every((entry) => entry.requestId === "req-telemetry-ok"));
  assert.ok(logger.events.every((entry) => entry.idIntent === "intent-telemetry-ok"));
  assert.equal(fake.calls.sale, 1);
});

test("telemetria registra FAILED y UNCERTAIN cuando doSale lanza antes de responder", async () => {
  const logger = makeTelemetryLogger();
  const failure = Object.assign(new Error("sensitive provider detail"), {
    response: { status: 503, headers: { "content-type": "text/html", "cf-ray": "safe-ray" } },
  });
  const fake = makeFakeSdk({ saleError: failure });
  await assert.rejects(
    makeProvider(fake).sale(saleInput, { requestId: "req-failed", idIntent: "intent-failed", logger }),
    (error) => error.code === "PIXELPAY_NETWORK_ERROR"
      && error.statusCode === 503
      && error.cfRay === "safe-ray"
  );
  assert.deepEqual(logger.events.map((entry) => entry.event), [
    PIXELPAY_SALE_EVENT.ATTEMPT_STARTED,
    PIXELPAY_SALE_EVENT.HTTP_STARTED,
    PIXELPAY_SALE_EVENT.FAILED,
    PIXELPAY_SALE_EVENT.UNCERTAIN,
  ]);
  assert.equal(new Set(logger.events.map((entry) => entry.paymentAttemptId)).size, 1);
  assert.equal(fake.calls.sale, 1);
});

test("respuesta incierta registra RESPONSE_RECEIVED y UNCERTAIN sin segunda Sale", async () => {
  const logger = makeTelemetryLogger();
  const fake = makeFakeSdk({ saleResponse: sdkResponse(520, { success: false, data: null, valid: false }) });
  const result = await makeProvider(fake).sale(saleInput, { logger });
  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  assert.deepEqual(logger.events.map((entry) => entry.event), [
    PIXELPAY_SALE_EVENT.ATTEMPT_STARTED,
    PIXELPAY_SALE_EVENT.HTTP_STARTED,
    PIXELPAY_SALE_EVENT.RESPONSE_RECEIVED,
    PIXELPAY_SALE_EVENT.UNCERTAIN,
  ]);
  assert.equal(fake.calls.sale, 1);
});

test("telemetria PixelPay nunca registra datos sensibles ni objetos completos", async () => {
  const logger = makeTelemetryLogger();
  const fake = makeFakeSdk({ saleResponse: sdkResponse(200, { data: approvedData() }) });
  await makeProvider(fake).sale(saleInput, { logger });
  const serialized = JSON.stringify(logger.events);
  assert.doesNotMatch(serialized, new RegExp(saleInput.card.number.replace(/\D+/g, "")));
  assert.doesNotMatch(serialized, new RegExp(saleInput.card.cvv));
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, new RegExp(AUTH_HASH));
  assert.doesNotMatch(serialized, /cardholder|billing|auth_key|auth_hash|secretKey|publicKey|valid-hash|x-client-signature|payment_hash|Authorization/i);
});

test("SDK rechaza items ausentes o monto distinto antes de doSale", async () => {
  const fake = makeFakeSdk({ saleResponse: sdkResponse(200, { data: approvedData() }) });
  const provider = makeProvider(fake);

  await assert.rejects(
    provider.sale({ ...saleInput, items: [] }),
    (error) => error.code === "PIXELPAY_ORDER_ITEMS_INVALID"
  );
  await assert.rejects(
    provider.sale({ ...saleInput, amount: 2 }),
    (error) => error.code === "PIXELPAY_ORDER_AMOUNT_MISMATCH"
  );
  assert.equal(fake.calls.sale, 0);
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
    assert.equal(result.diagnostics.transactionResultValid, false);
    assert.equal(result.diagnostics.transactionResultDataPresent, true);
    assert.equal(result.diagnostics.transactionResultParsed, false);
    assert.equal(fake.calls.sale, 1);
  });

  await t.test("respuesta validada sin data de TransactionResult", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { success: true, data: null, valid: true }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.diagnostics.transactionResultValid, true);
    assert.equal(result.diagnostics.transactionResultDataPresent, false);
    assert.equal(result.diagnostics.transactionResultParsed, false);
    assert.equal(fake.calls.fromResponse, 0);
  });
});

test("diagnostico SDK distingue parse fallido sin exponer la excepcion", async () => {
  const sensitive = `${SECRET} ${AUTH_HASH}`;
  const fake = makeFakeSdk({
    saleResponse: sdkResponse(200, { data: approvedData() }),
    transactionResultError: new TypeError(sensitive),
  });
  const result = await makeProvider(fake).sale(saleInput);

  assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
  assert.equal(result.diagnostics.transactionResultValid, true);
  assert.equal(result.diagnostics.transactionResultDataPresent, true);
  assert.equal(result.diagnostics.transactionResultParsed, false);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(result.diagnostics), new RegExp(AUTH_HASH));
});

test("clasifica FailureResponse 520 sin conservar el mensaje del SDK", async (t) => {
  for (const scenario of [
    {
      name: "public key no disponible",
      message: "Could not obtain necessary credentials for transaction.",
      expected: "SDK_PUBLIC_KEY_UNAVAILABLE",
    },
    {
      name: "timeout Axios configurado por el SDK",
      message: "timeout of 60000ms exceeded",
      expected: "SDK_HTTP_TIMEOUT",
    },
    {
      name: "network error Axios",
      message: "Network Error",
      expected: "SDK_NETWORK_ERROR",
    },
    {
      name: "mensaje desconocido",
      message: `unknown ${saleInput.card.number} ${saleInput.card.cvv} ${SECRET}`,
      expected: "SDK_EXCEPTION_OTHER",
    },
    {
      name: "mensaje ausente",
      message: "",
      expected: "SDK_MESSAGE_ABSENT",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const response = {
        ...sdkResponse(520, { success: false, data: null, valid: false }),
        message: scenario.message,
      };
      assert.equal(classifySdkFailureMessage(response), scenario.expected);

      const result = await makeProvider(makeFakeSdk({ saleResponse: response })).sale(saleInput);
      const serialized = JSON.stringify(result.diagnostics);
      assert.equal(result.diagnostics.safeMessageCode, scenario.expected);
      assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
      assert.equal(result.statusCode, 520);
      assert.doesNotMatch(serialized, new RegExp(saleInput.card.number.replace(/\D+/g, "")));
      assert.doesNotMatch(serialized, new RegExp(saleInput.card.cvv));
      assert.doesNotMatch(serialized, new RegExp(SECRET));
      if (scenario.message) assert.equal(serialized.includes(scenario.message), false);
    });
  }
});

test("SDK nunca aprueba hash invalido, amount mismatch ni payment_uuid ausente", async (t) => {
  await t.test("hash invalido", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ payment_hash: "invalid-hash" }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.paymentHashValid, false);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.diagnostics.hasPaymentHash, true);
    assert.equal(result.diagnostics.paymentHashValid, false);
  });

  await t.test("amount mismatch", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ transaction_amount: 2 }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.amountMatches, false);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.diagnostics.transactionAmountMatches, false);
    assert.equal(result.diagnostics.approvedAmountMatches, true);
  });

  await t.test("payment_uuid ausente", async () => {
    const fake = makeFakeSdk({
      saleResponse: sdkResponse(200, { data: approvedData({ payment_uuid: null }) }),
    });
    const result = await makeProvider(fake).sale(saleInput);
    assert.equal(result.paymentUuid, null);
    assert.equal(result.outcome, PIXELPAY_SALE_OUTCOME.UNCERTAIN);
    assert.equal(result.diagnostics.hasPaymentUuid, false);
  });
});

test("diagnostico SDK identifica campos ausentes, montos y flags de respuesta", async (t) => {
  for (const scenario of [
    {
      name: "transaction_id ausente",
      data: { transaction_id: null },
      expected: { hasTransactionId: false },
    },
    {
      name: "payment_hash ausente",
      data: { payment_hash: null },
      expected: { hasPaymentHash: false, paymentHashValid: false },
    },
    {
      name: "transaction_approved_amount mismatch",
      data: { transaction_approved_amount: 2 },
      expected: { transactionAmountMatches: true, approvedAmountMatches: false, amountMatches: false },
    },
    {
      name: "response_approved false",
      data: { response_approved: false },
      expected: { responseApproved: false },
    },
    {
      name: "response_incomplete true",
      data: { response_incomplete: true },
      expected: { responseIncomplete: true },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fake = makeFakeSdk({
        saleResponse: sdkResponse(200, { data: approvedData(scenario.data) }),
      });
      const result = await makeProvider(fake).sale(saleInput);
      for (const [key, value] of Object.entries(scenario.expected)) {
        assert.equal(result.diagnostics[key], value);
      }
      assert.equal(fake.calls.sale, 1);
    });
  }
});

test("SDK Status valido usa TransactionResult y devuelve PAID", async () => {
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { data: { status: "raw-no-confiable" }, valid: true }),
    transactionResult: { status: "paid" },
  });
  const provider = makeProvider(fake);
  const result = await provider.queryPaymentStatus(PAYMENT_UUID);

  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.status, "PAID");
  assert.equal(result.paymentUuid, PAYMENT_UUID);
  assert.equal(fake.calls.status, 1);
  assert.equal(fake.calls.validateResponse, 1);
  assert.equal(fake.calls.fromResponse, 1);
  assert.equal(fake.calls.statusRequest.payment_uuid, PAYMENT_UUID);
  assert.match(fake.calls.settings[0].headers["x-client-signature"], /^[a-f0-9]{128}$/);
});

test("SDK Status con validateResponse=false devuelve UNKNOWN", async () => {
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { success: true, data: {}, valid: false }),
  });
  const result = await makeProvider(fake).queryPaymentStatus(PAYMENT_UUID);

  assert.equal(result.ok, true);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.response.data.status, "UNKNOWN");
  assert.equal(classifyPixelPayStatusResult(result), "respuesta_invalida");
  assert.equal(fake.calls.status, 1);
  assert.equal(fake.calls.validateResponse, 1);
  assert.equal(fake.calls.fromResponse, 0);
});

test("SDK Status HTTP 200 invalido conserva ok pero nunca confia en success ni payload crudo", async () => {
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { success: true, data: { status: "paid" }, valid: false }),
  });
  const result = await makeProvider(fake).queryPaymentStatus(PAYMENT_UUID);

  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.response.data.status, "UNKNOWN");
  assert.equal(classifyPixelPayStatusResult(result), "respuesta_invalida");
  assert.equal(fake.calls.status, 1);
  assert.equal(fake.calls.fromResponse, 0);
});

test("SDK Status con fromResponse fallido devuelve UNKNOWN sin filtrar payload", async () => {
  const sensitive = [saleInput.card.number.replace(/\D+/g, ""), saleInput.card.cvv, SECRET, AUTH_HASH].join(" ");
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { success: true, data: { status: "paid", raw: sensitive }, valid: true }),
    transactionResultError: new Error(sensitive),
  });
  const result = await makeProvider(fake).queryPaymentStatus(PAYMENT_UUID);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(classifyPixelPayStatusResult(result), "respuesta_invalida");
  assert.equal(fake.calls.status, 1);
  assert.equal(fake.calls.validateResponse, 1);
  assert.equal(fake.calls.fromResponse, 1);
  assert.doesNotMatch(serialized, new RegExp(saleInput.card.number.replace(/\D+/g, "")));
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, new RegExp(AUTH_HASH));
});

test("SDK Status exige payment_uuid y nunca invoca getStatus mas de una vez", async () => {
  const fake = makeFakeSdk({
    statusResponse: sdkResponse(200, { data: { status: "paid" }, valid: true }),
    transactionResult: { status: "paid" },
  });
  const provider = makeProvider(fake);

  await assert.rejects(
    provider.queryPaymentStatus(""),
    (error) => error.code === "PIXELPAY_PAYMENT_UUID_MISSING" && error.uncertain === false
  );
  assert.equal(fake.calls.status, 0);

  const result = await provider.queryPaymentStatus(PAYMENT_UUID);
  assert.equal(result.status, "PAID");
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
      assert.equal(error.sdkErrorName, "Error");
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

test("diagnostics contiene solo metadata y nunca valores sensibles ni payload crudo", async () => {
  const fake = makeFakeSdk({ saleResponse: sdkResponse(200, { data: approvedData() }) });
  const result = await makeProvider(fake).sale(saleInput);
  const serialized = JSON.stringify(result.diagnostics);

  assert.deepEqual(Object.keys(result.diagnostics).sort(), [
    "amountMatches",
    "approvedAmountMatches",
    "approvedAmountPresent",
    "hasPaymentHash",
    "hasPaymentUuid",
    "hasTransactionId",
    "outcome",
    "paymentAttemptId",
    "paymentHashValid",
    "responseApproved",
    "responseCodePresent",
    "responseIncomplete",
    "responseSuccess",
    "safeMessageCode",
    "sdkResponseClass",
    "statusCode",
    "transactionAmountMatches",
    "transactionAmountPresent",
    "transactionResultDataPresent",
    "transactionResultParsed",
    "transactionResultValid",
  ].sort());
  assert.doesNotMatch(serialized, new RegExp(saleInput.card.number.replace(/\D+/g, "")));
  assert.doesNotMatch(serialized, new RegExp(saleInput.card.cvv));
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, new RegExp(AUTH_HASH));
  assert.doesNotMatch(serialized, /valid-hash|transaction-sdk-qa|11111111-2222-4333-8444-555555555555/i);
  assert.doesNotMatch(serialized, /payment_uuid|transaction_id|payment_hash|x-client-signature|authorization|response\.data/i);
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
    delete process.env.PIXELPAY_AUTH_HASH;
    PaymentProviderFactory.reset();
    const sdkProvider = PaymentProviderFactory.create();
    assert.ok(sdkProvider instanceof PixelPaySdkProvider);
    assert.equal(Object.hasOwn(sdkProvider, "authHash"), false);

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

test("configuracion QA SDK no requiere PIXELPAY_AUTH_HASH y Direct lo conserva obligatorio", async () => {
  const names = [
    "NODE_ENV", "FRONTEND_URL", "JWT_SECRET", "COOKIE_SECRET", "CSRF_SECRET",
    "PAYMENT_PROVIDER", "PIXELPAY_IMPLEMENTATION", "PIXELPAY_ENV", "PIXELPAY_ENDPOINT",
    "PIXELPAY_APP_URL", "PIXELPAY_KEY_ID", "PIXELPAY_SECRET_KEY", "PIXELPAY_AUTH_HASH",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    NODE_ENV: "test",
    FRONTEND_URL: "http://localhost:5173",
    JWT_SECRET: "test-jwt-secret-at-least-24",
    COOKIE_SECRET: "test-cookie-secret-at-least-24",
    CSRF_SECRET: "test-csrf-secret-at-least-24",
    PAYMENT_PROVIDER: "pixelpay",
    PIXELPAY_IMPLEMENTATION: "sdk",
    PIXELPAY_ENV: "sandbox",
    PIXELPAY_ENDPOINT: "https://pixelpay.dev",
    PIXELPAY_APP_URL: "https://pixelpay.dev",
    PIXELPAY_KEY_ID: KEY_ID,
    PIXELPAY_SECRET_KEY: SECRET,
    PIXELPAY_AUTH_HASH: "",
  });

  try {
    const sdkApp = Fastify();
    sdkApp.register(envPlugin);
    await sdkApp.ready();
    await sdkApp.close();

    process.env.PIXELPAY_IMPLEMENTATION = "direct";
    const directApp = Fastify();
    directApp.register(envPlugin);
    await assert.rejects(directApp.ready(), /PIXELPAY_AUTH_HASH/);
    await directApp.close();
  } finally {
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
  assert.equal(typeof provider.sdk.Entities.TransactionResult.validateResponse, "function");
  assert.equal(typeof provider.sdk.Entities.TransactionResult.fromResponse, "function");
});
