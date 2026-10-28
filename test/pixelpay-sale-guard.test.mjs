import assert from "node:assert/strict";
import test from "node:test";
import { resolvePixelPayCustomerErrorCode } from "../src/services/payments/PixelPayDirectProvider.js";
import {
  assertPixelPayCardAllowedForEnvironment,
  assertPixelPaySandboxCardAllowed,
  buildPixelPaySaleRateLimitConfig,
  canStartPixelPaySale,
  resolvePixelPaySaleFailureState,
} from "../src/routes/v1/public/pagos.js";

test("doble submit no puede iniciar otro sale cuando el intent ya fue reclamado", () => {
  assert.equal(canStartPixelPaySale("link_generado"), true);
  assert.equal(canStartPixelPaySale("pendiente_confirmacion"), false);
  assert.equal(canStartPixelPaySale("confirmado"), false);
  assert.equal(canStartPixelPaySale("fallido"), false);
  assert.equal(canStartPixelPaySale("expirado"), false);
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

test("live acepta tarjetas reales y bloquea las tarjetas oficiales de Sandbox", () => {
  assert.equal(
    assertPixelPayCardAllowedForEnvironment("4000 0000 0000 0002", "live"),
    "4000000000000002"
  );
  assert.throws(
    () => assertPixelPayCardAllowedForEnvironment("4111111111111111", "live"),
    (error) => error.code === "PIXELPAY_TEST_CARD_FORBIDDEN_IN_LIVE"
  );
  assert.throws(
    () => assertPixelPayCardAllowedForEnvironment("4000000000000002", "sandbox"),
    (error) => error.code === "PIXELPAY_SANDBOX_CARD_NOT_ALLOWED"
  );
  assert.throws(
    () => assertPixelPayCardAllowedForEnvironment("4000000000000002", "production"),
    (error) => error.code === "PIXELPAY_ENV_INVALID"
  );
});

test("decline y error contractual definitivos pasan a fallido; incierto conserva pendiente", () => {
  assert.deepEqual(resolvePixelPaySaleFailureState("payment_declined"), {
    keepPending: false,
    intentState: "fallido",
  });
  assert.deepEqual(resolvePixelPaySaleFailureState("request_error_definitive"), {
    keepPending: false,
    intentState: "fallido",
  });
  assert.deepEqual(resolvePixelPaySaleFailureState("uncertain"), {
    keepPending: true,
    intentState: "pendiente_confirmacion",
  });
});

test("clasifica mensajes seguros para rechazo, datos, precondicion e incertidumbre", () => {
  assert.equal(resolvePixelPayCustomerErrorCode({ outcome: "payment_declined", statusCode: 402 }), "PIXELPAY_PAYMENT_DECLINED");
  assert.equal(resolvePixelPayCustomerErrorCode({ outcome: "request_error_definitive", statusCode: 422 }), "PIXELPAY_PAYMENT_DATA_INVALID");
  assert.equal(resolvePixelPayCustomerErrorCode({ outcome: "request_error_definitive", statusCode: 412 }), "PIXELPAY_PRECONDITION_FAILED");
  assert.equal(resolvePixelPayCustomerErrorCode({ outcome: "uncertain", statusCode: 408 }), "PIXELPAY_PAYMENT_PENDING");
});
