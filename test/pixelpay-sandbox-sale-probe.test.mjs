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

function fakeProbeSdk() {
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
    async doSale() { calls.sale += 1; return { status: 520, success: false }; }
  }
  class TransactionResult {
    static validateResponse() { return false; }
    static fromResponse() { return null; }
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
