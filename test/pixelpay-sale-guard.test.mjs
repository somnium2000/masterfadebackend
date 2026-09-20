import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPixelPaySandboxCardAllowed,
  buildPixelPaySaleRateLimitConfig,
  canStartPixelPaySale,
} from "../src/routes/v1/public/pagos.js";

test("doble submit no puede iniciar otro sale cuando el intent ya fue reclamado", () => {
  assert.equal(canStartPixelPaySale("link_generado"), true);
  assert.equal(canStartPixelPaySale("pendiente_confirmacion"), false);
  assert.equal(canStartPixelPaySale("confirmado"), false);
  assert.equal(canStartPixelPaySale("fallido"), false);
});

test("sale aplica rate limit por IP con ventana acotada", () => {
  const config = buildPixelPaySaleRateLimitConfig();
  assert.equal(config.max, 5);
  assert.equal(config.timeWindow, "15 minutes");
  assert.equal(config.groupId, "pixelpay-sale");
  assert.equal(config.keyGenerator({ ip: "203.0.113.10" }), "203.0.113.10");
});

test("solo permite tarjetas documentadas para PixelPay Sandbox", () => {
  assert.equal(assertPixelPaySandboxCardAllowed("4111 1111 1111 1111"), "4111111111111111");
  assert.throws(
    () => assertPixelPaySandboxCardAllowed("4000000000000002"),
    (error) => error.code === "PIXELPAY_SANDBOX_CARD_NOT_ALLOWED"
  );
});
