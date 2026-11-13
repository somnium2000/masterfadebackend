import test from "node:test";
import assert from "node:assert/strict";
import PixelPay from "@pixelpay/sdk-core";
import { createHash } from "node:crypto";
import { resolvePixelPayStatusShapeProbeEnabled } from "../src/plugins/env.js";
import { PixelPaySdkProvider } from "../src/services/payments/PixelPaySdkProvider.js";

// SYNTHETIC transport fixtures. These are not captured PixelPay responses.
const syntheticFinancial = {
  payment_uuid: "SYNTHETIC-UUID", transaction_id: "SYNTHETIC-TX",
  payment_hash: createHash("md5").update("SYNTHETIC-ORDER|qa-key-not-real|qa-secret-not-real").digest("hex"), transaction_amount: 1,
  transaction_approved_amount: 1, transaction_auth: "123456", response_approved: "1",
  response_code: "00",
  response_incomplete: false, status: "COMPLETED", order_id: "SYNTHETIC-ORDER",
  transaction_currency: "HNL", order_currency: "HNL",
};
const synthetic = { status: "paid", last_response: { data: syntheticFinancial } };

async function run(data, { enabled = true, loggerFails = false } = {}) {
  const provider = new PixelPaySdkProvider({
    endpoint: "https://pixelpay.dev", env: "sandbox", keyId: "qa-key-not-real",
    secretKey: "qa-secret-not-real", authHash: "qa-auth-hash-not-real",
    appUrl: "https://pixelpay.dev",
  });
  const logs = [];
  let calls = 0;
  let parses = 0;
  const response = new PixelPay.Responses.SuccessResponse();
  response.setStatus(200);
  response.success = true;
  response.data = data;
  const create = provider.createTransaction.bind(provider);
  provider.createTransaction = signature => {
    const transaction = create(signature);
    // Simulate only transport; getStatus and both TransactionResult methods are real.
    transaction.post = async () => { calls += 1; return response; };
    return transaction;
  };
  const read = provider.readTransactionResult.bind(provider);
  provider.readTransactionResult = value => { parses += 1; return read(value); };
  const result = await provider.queryPaymentStatus("SYNTHETIC-UUID", {
    orderId: "SYNTHETIC-ORDER", amount: 1, transactionId: "SYNTHETIC-TX",
  }, {
    enabled, requestId: "req-synthetic",
    logger: { info(value) { if (loggerFails) throw new Error("logger failed"); logs.push(value); } },
  });
  return { result, logs, calls, parses };
}

test("SYNTHETIC real SDK shape probe: safety, parser, guards and equivalence", async t => {
  const oldEnv = process.env.ENTORNO;
  const oldNode = process.env.NODE_ENV;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.ENTORNO; else process.env.ENTORNO = oldEnv;
    if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
  });
  process.env.ENTORNO = "qa";
  process.env.NODE_ENV = "test";
  const cases = [synthetic, {}, { status: null, last_response: null }, {
    status: "paid",
    last_response: { data: {
      ...syntheticFinancial, payment_uuid: [], transaction_id: {}, payment_hash: 42,
      transaction_amount: "1", response_approved: "true", response_incomplete: false,
    } },
  }, { status: "COMPLETED", last_response: { data: { ...syntheticFinancial } } },
  { status: "paid", last_response: { data: { ...syntheticFinancial, payment_uuid: undefined } } }];
  for (const data of cases) {
    const off = await run(data, { enabled: false });
    const on = await run(data);
    const brokenLogger = await run(data, { loggerFails: true });
    assert.deepEqual(on.result, off.result);
    if (data === synthetic) {
      assert.equal(on.result.paymentHashValid, false);
      assert.equal(on.result.amountMatches, true);
      assert.equal(on.result.providerApproved, true);
      assert.equal(on.result.approved, false);
      assert.equal(on.result.resultPaymentUuid, null);
      assert.equal(on.result.transactionId, syntheticFinancial.transaction_id);
      assert.equal(JSON.stringify(on.logs).includes(syntheticFinancial.payment_hash), false);
    }
    assert.deepEqual(brokenLogger.result, off.result);
    assert.equal(on.calls, 1);
    assert.equal(off.calls, 1);
    assert.equal(on.parses, 0);
    assert.equal(off.parses, 0);
    assert.equal(off.logs.length, 0);
    assert.equal(on.logs.length, 1);
    const shape = on.logs[0].pixelPayStatusShapeProbe;
    assert.deepEqual(shape.response_data.last_response,
      Object.hasOwn(data, "last_response") ? {
        present: true, type: data.last_response === null ? "null" : "object",
      } : { present: false, type: "missing" });
    assert.equal(Object.keys(shape.response_data).length, 14);
    assert.equal(Object.keys(shape.last_response_data).length, 14);
    assert.doesNotMatch(JSON.stringify(on.logs), /SYNTHETIC-UUID|SYNTHETIC-TX|SYNTHETIC-HASH|qa-secret|nested|HNL/);
  }
  const absent = (await run({})).logs[0].pixelPayStatusShapeProbe;
  assert.deepEqual(absent.response_data.payment_uuid, { present: false, type: "missing" });
  assert.deepEqual(absent.last_response_data.payment_uuid, { present: false, type: "missing" });
  for (const [value, type] of [[null, "null"], [false, "boolean"], ["secret-fictitious", "string"],
    [12, "number"], [{ child: "secret-fictitious" }, "object"], [["secret-fictitious"], "array"],
    [undefined, "missing"]]) {
    const diagnostic = (await run({
      status: "paid",
      last_response: { data: { ...syntheticFinancial, payment_uuid: value } },
    })).logs[0].pixelPayStatusShapeProbe;
    assert.deepEqual(diagnostic.response_data.payment_uuid, { present: false, type: "missing" });
    assert.deepEqual(diagnostic.last_response_data.payment_uuid, { present: true, type });
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret-fictitious|child/);
  }
  const parserFailure = new Proxy({ status: "COMPLETED" }, { ownKeys() { throw new Error("parser failure"); } });
  const failed = await run(parserFailure);
  assert.equal(failed.result.providerContractValid, false);
  assert.deepEqual(failed.result, (await run(parserFailure, { enabled: false })).result);
  assert.equal(failed.calls, 1);
  for (const [env, node] of [["produccion", "production"], ["qa", "production"], ["dev", "test"]]) {
    process.env.ENTORNO = env; process.env.NODE_ENV = node;
    assert.equal((await run(synthetic)).logs.length, 0);
  }
});

test("Status shape server configuration is strict, independent and default off", () => {
  const env = { ENTORNO: "qa", NODE_ENV: "development", PIXELPAY_ENV: "sandbox",
    PIXELPAY_ENDPOINT: "https://pixelpay.dev" };
  assert.equal(resolvePixelPayStatusShapeProbeEnabled(env), false);
  assert.equal(resolvePixelPayStatusShapeProbeEnabled({ ...env, PIXELPAY_CALLBACK_PROBE_ENABLED: "true" }), false);
  assert.equal(resolvePixelPayStatusShapeProbeEnabled({ ...env, PIXELPAY_STATUS_SHAPE_PROBE_ENABLED: "false" }), false);
  assert.equal(resolvePixelPayStatusShapeProbeEnabled({ ...env, PIXELPAY_STATUS_SHAPE_PROBE_ENABLED: "true" }), true);
  assert.throws(() => resolvePixelPayStatusShapeProbeEnabled({ ...env, PIXELPAY_STATUS_SHAPE_PROBE_ENABLED: "1" }));
  for (const override of [{ ENTORNO: "produccion" }, { NODE_ENV: "production" },
    { PIXELPAY_ENV: "live" }, { PIXELPAY_ENDPOINT: "https://other.invalid" }]) {
    assert.throws(() => resolvePixelPayStatusShapeProbeEnabled({ ...env, ...override, PIXELPAY_STATUS_SHAPE_PROBE_ENABLED: "true" }));
  }
});
