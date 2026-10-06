import assert from "node:assert/strict";
import test from "node:test";
import { runPixelPaySandboxSaleProbe } from "../scripts/pixelpay-sandbox-sale-probe.mjs";

function probeEnv(overrides = {}) {
  return {
    PIXELPAY_ENV: "sandbox",
    PIXELPAY_ENDPOINT: "https://pixelpay.dev",
    PIXELPAY_APP_URL: "https://pixelpay.dev",
    PIXELPAY_KEY_ID: "probe-key-not-real",
    PIXELPAY_SECRET_KEY: "probe-secret-not-real",
    PIXELPAY_PROBE_CARD_NUMBER: `4${"1".repeat(15)}`,
    PIXELPAY_PROBE_CARD_CVV: "9".repeat(3),
    PIXELPAY_PROBE_CARD_EXPIRE_MONTH: "12",
    PIXELPAY_PROBE_CARD_EXPIRE_YEAR: "28",
    PIXELPAY_PROBE_DRY_RUN: "true",
    ...overrides,
  };
}

function approvedResult(overrides = {}) {
  return {
    response_approved: true,
    response_incomplete: false,
    payment_uuid: "payment-uuid-not-real",
    transaction_id: "transaction-id-not-real",
    payment_hash: "payment-hash-not-real",
    transaction_amount: 1,
    transaction_approved_amount: 1,
    ...overrides,
  };
}

function sdkResponse({ status = 200, success = true, useGetStatus = false } = {}) {
  if (!useGetStatus) return { status, success, data: {} };
  return new (class SuccessResponse {
    constructor() {
      this.success = success;
      this.data = {};
    }
    getStatus() { return status; }
  })();
}

function fakeProbeSdk({
  response = sdkResponse({ status: 520, success: false }),
  result = null,
  responseValid = false,
  paymentHashValid = false,
  saleError = null,
} = {}) {
  const calls = {
    settings: 0,
    order: 0,
    card: 0,
    billing: 0,
    saleTransaction: 0,
    setOrder: 0,
    setCard: 0,
    setBilling: 0,
    transaction: 0,
    sale: 0,
    verifyPaymentHash: 0,
    setupSandbox: 0,
  };
  class Settings {
    constructor() { calls.settings += 1; }
    setupSandbox() { calls.setupSandbox += 1; }
    setupHeaders() {}
  }
  class Order { constructor() { calls.order += 1; } }
  class Card { constructor() { calls.card += 1; } }
  class Billing { constructor() { calls.billing += 1; } }
  class SaleTransaction {
    constructor() { calls.saleTransaction += 1; }
    setOrder(value) { calls.setOrder += 1; this.order = value; }
    setCard(value) { calls.setCard += 1; this.card = value; }
    setBilling(value) { calls.setBilling += 1; this.billing = value; }
  }
  class Transaction {
    constructor() { calls.transaction += 1; }
    async doSale() {
      calls.sale += 1;
      if (saleError) throw saleError;
      return response;
    }
    verifyPaymentHash() {
      calls.verifyPaymentHash += 1;
      return paymentHashValid;
    }
  }
  class TransactionResult {
    static validateResponse() { return responseValid; }
    static fromResponse() { return result; }
  }
  return {
    calls,
    sdk: {
      Models: { Settings, Order, Card, Billing },
      Requests: { SaleTransaction },
      Services: { Transaction },
      Entities: { TransactionResult },
    },
  };
}

async function runSimulatedSale(fake) {
  const output = outputCollector();
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_PROBE_DRY_RUN: "false" }),
    sdk: fake.sdk,
    write: output.write,
  });
  return { result, output, afterSale: output.lines.find((entry) => entry.event === "AFTER_SALE") };
}

function outputCollector() {
  const lines = [];
  return { lines, write(line) { lines.push(JSON.parse(line)); } };
}

test("probe dry-run construye y enlaza todos los modelos sin Transaction ni red", async () => {
  const fake = fakeProbeSdk();
  const output = outputCollector();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("HTTP_NOT_ALLOWED_IN_DRY_RUN");
  };
  try {
    const result = await runPixelPaySandboxSaleProbe({
      env: probeEnv(),
      sdk: fake.sdk,
      write: output.write,
      randomUUID: () => "11111111-2222-4333-8444-666666666666",
      createService: () => { throw new Error("TRANSACTION_NOT_ALLOWED_IN_DRY_RUN"); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.saleCount, 0);
    assert.deepEqual({
      settings: fake.calls.settings,
      order: fake.calls.order,
      card: fake.calls.card,
      billing: fake.calls.billing,
      saleTransaction: fake.calls.saleTransaction,
      setupSandbox: fake.calls.setupSandbox,
      setOrder: fake.calls.setOrder,
      setCard: fake.calls.setCard,
      setBilling: fake.calls.setBilling,
    }, {
      settings: 1,
      order: 1,
      card: 1,
      billing: 1,
      saleTransaction: 1,
      setupSandbox: 1,
      setOrder: 1,
      setCard: 1,
      setBilling: 1,
    });
    assert.equal(fake.calls.transaction, 0);
    assert.equal(fake.calls.sale, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(output.lines.map((entry) => entry.event), ["PROBE_START", "DRY_RUN_OK"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DRY_RUN_OK no se emite cuando falla la construccion de modelos", async () => {
  const fake = fakeProbeSdk();
  const output = outputCollector();
  fake.sdk.Models.Card = class Card {
    constructor() { throw new TypeError("invalid card model"); }
  };
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv(), sdk: fake.sdk, write: output.write,
    createService: () => { throw new Error("TRANSACTION_NOT_ALLOWED_IN_DRY_RUN"); },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.saleCount, 0);
  assert.equal(fake.calls.transaction, 0);
  assert.equal(fake.calls.sale, 0);
  assert.deepEqual(output.lines.map((entry) => entry.event), ["PROBE_START", "SALE_ERROR"]);
});

test("probe aborta inmediatamente fuera de sandbox", async () => {
  const fake = fakeProbeSdk();
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_ENV: "production" }), sdk: fake.sdk, write: () => {},
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.saleCount, 0);
  assert.equal(fake.calls.setupSandbox, 0);
  assert.equal(fake.calls.transaction, 0);
});

test("probe aborta si endpoint no es pixelpay.dev", async () => {
  const fake = fakeProbeSdk();
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_ENDPOINT: "https://example.invalid" }), sdk: fake.sdk, write: () => {},
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.saleCount, 0);
  assert.equal(fake.calls.setupSandbox, 0);
  assert.equal(fake.calls.transaction, 0);
});

test("probe invoca doSale como maximo una vez con servicio simulado", async () => {
  const fake = fakeProbeSdk();
  const output = outputCollector();
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_PROBE_DRY_RUN: "false" }),
    sdk: fake.sdk,
    write: output.write,
    createService: () => new fake.sdk.Services.Transaction(),
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.saleCount, 1);
  assert.equal(fake.calls.sale, 1);
  assert.deepEqual(output.lines.map((entry) => entry.event), ["PROBE_START", "BEFORE_SALE", "AFTER_SALE"]);
});

test("AFTER_SALE usa response.status y conserva telemetria estrictamente permitida", async () => {
  const fake = fakeProbeSdk({
    response: sdkResponse({ status: 201 }),
    result: approvedResult(),
    responseValid: true,
    paymentHashValid: true,
  });
  const { result, afterSale } = await runSimulatedSale(fake);
  assert.equal(result.outcome, "APPROVED");
  assert.equal(afterSale.statusCode, 201);
  assert.deepEqual(Object.keys(afterSale).sort(), [
    "amount", "approvedAmountMatches", "currency", "event", "orderId", "outcome",
    "paymentHashPresent", "paymentHashValid", "paymentUuidPresent", "probeId",
    "responseApproved", "responseClass", "responseIncomplete", "statusCode", "success",
    "timestamp", "transactionAmountMatches", "transactionIdPresent",
    "transactionResultParsed", "transactionResultValid",
  ].sort());
  assert.doesNotMatch(JSON.stringify(afterSale), /payment-hash-not-real|payment_hash/i);
  assert.equal(fake.calls.sale, 1);
});

test("SuccessResponse con getStatus reporta 200 y hash valido queda APPROVED", async () => {
  const fake = fakeProbeSdk({
    response: sdkResponse({ status: 200, useGetStatus: true }),
    result: approvedResult(),
    responseValid: true,
    paymentHashValid: true,
  });
  const { result, afterSale } = await runSimulatedSale(fake);
  assert.equal(result.outcome, "APPROVED");
  assert.equal(result.exitCode, 0);
  assert.equal(afterSale.responseClass, "SuccessResponse");
  assert.equal(afterSale.statusCode, 200);
  assert.equal(afterSale.paymentHashPresent, true);
  assert.equal(afterSale.paymentHashValid, true);
  assert.equal(fake.calls.verifyPaymentHash, 1);
  assert.equal(fake.calls.sale, 1);
});

for (const scenario of [
  {
    name: "payment_hash ausente",
    result: approvedResult({ payment_hash: null }),
    paymentHashValid: true,
    expected: { paymentHashPresent: false, paymentHashValid: false },
  },
  {
    name: "payment_hash invalido",
    result: approvedResult(),
    paymentHashValid: false,
    expected: { paymentHashPresent: true, paymentHashValid: false },
  },
  {
    name: "response_incomplete true",
    result: approvedResult({ response_incomplete: true }),
    paymentHashValid: true,
    expected: { responseIncomplete: true },
  },
  {
    name: "status 500 aunque datos parezcan aprobados",
    response: sdkResponse({ status: 500 }),
    result: approvedResult(),
    paymentHashValid: true,
    expected: { statusCode: 500 },
  },
  {
    name: "transaction_amount diferente",
    result: approvedResult({ transaction_amount: 1.01 }),
    paymentHashValid: true,
    expected: { transactionAmountMatches: false },
  },
  {
    name: "transaction_approved_amount diferente",
    result: approvedResult({ transaction_approved_amount: 0.99 }),
    paymentHashValid: true,
    expected: { approvedAmountMatches: false },
  },
]) {
  test(`${scenario.name} queda UNCERTAIN sin retry`, async () => {
    const fake = fakeProbeSdk({
      response: scenario.response || sdkResponse({ status: 200 }),
      result: scenario.result,
      responseValid: true,
      paymentHashValid: scenario.paymentHashValid,
    });
    const { result, afterSale } = await runSimulatedSale(fake);
    assert.equal(result.outcome, "UNCERTAIN");
    assert.equal(result.exitCode, 3);
    assert.equal(afterSale.outcome, "UNCERTAIN");
    assert.deepEqual(
      Object.fromEntries(Object.keys(scenario.expected).map((key) => [key, afterSale[key]])),
      scenario.expected
    );
    assert.equal(fake.calls.sale, 1);
  });
}

test("probe sanitiza name y message cuando falla la unica Sale", async () => {
  const fake = fakeProbeSdk();
  const output = outputCollector();
  fake.sdk.Services.Transaction.prototype.doSale = async function doSale() {
    fake.calls.sale += 1;
    throw Object.assign(new Error("CVV 999 secret probe-secret-not-real"), { name: "NetworkError" });
  };
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_PROBE_DRY_RUN: "false" }), sdk: fake.sdk, write: output.write,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(fake.calls.sale, 1);
  assert.deepEqual(output.lines.map((entry) => entry.event), ["PROBE_START", "BEFORE_SALE", "SALE_ERROR"]);
  assert.equal(output.lines.at(-1).errorName, "NetworkError");
  assert.equal(output.lines.at(-1).errorMessage, "REDACTED");
  assert.doesNotMatch(JSON.stringify(output.lines), /999|probe-secret-not-real/);
});

test("probe captura fallo de preparacion en nivel superior sin Sale", async () => {
  const fake = fakeProbeSdk();
  const output = outputCollector();
  fake.sdk.Models.Settings.prototype.setupSandbox = () => { throw new TypeError("invalid setup"); };
  const result = await runPixelPaySandboxSaleProbe({
    env: probeEnv({ PIXELPAY_PROBE_DRY_RUN: "false" }), sdk: fake.sdk, write: output.write,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.saleCount, 0);
  assert.equal(fake.calls.sale, 0);
  assert.equal(output.lines.at(-1).event, "SALE_ERROR");
  assert.equal(output.lines.at(-1).errorName, "TypeError");
  assert.equal(output.lines.at(-1).errorMessage, "invalid setup");
});
