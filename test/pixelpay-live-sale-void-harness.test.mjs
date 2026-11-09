import assert from "node:assert/strict";
import test from "node:test";
import { runPixelPayLiveSaleVoidHarness } from "../scripts/pixelpay-live-sale-void-harness.mjs";

test("harness Live ejecuta una Sale L1 seguida de un Void con mocks", async () => {
  const calls = [];
  const provider = {
    env: "live",
    async sale(input) {
      calls.push(["sale", input.amount]);
      return { approved: true, paymentUuid: "payment-uuid-mock" };
    },
    async voidPayment(input) {
      calls.push(["void", input.paymentUuid, input.orderId]);
      return { success: true };
    },
  };
  const result = await runPixelPayLiveSaleVoidHarness({
    provider,
    saleInput: { orderId: "MF-LIVE-CONTROLLED", amount: 1 },
    authorizedEmail: "authorized@example.com",
  });
  assert.equal(result.voidResponse.success, true);
  assert.deepEqual(calls, [
    ["sale", 1],
    ["void", "payment-uuid-mock", "MF-LIVE-CONTROLLED"],
  ]);
});

test("harness rechaza Sandbox y montos distintos de L1 antes de Sale", async () => {
  let saleCalls = 0;
  const provider = { env: "sandbox", async sale() { saleCalls += 1; } };
  await assert.rejects(
    runPixelPayLiveSaleVoidHarness({ provider, saleInput: { amount: 1 } }),
    /LIVE_PROVIDER_REQUIRED/
  );
  provider.env = "live";
  await assert.rejects(
    runPixelPayLiveSaleVoidHarness({ provider, saleInput: { amount: 2 } }),
    /AMOUNT_MUST_BE_1/
  );
  assert.equal(saleCalls, 0);
});
