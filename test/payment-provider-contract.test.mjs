import assert from "node:assert/strict";
import test from "node:test";
import { MockPaymentProvider } from "../src/services/payments/MockPaymentProvider.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { TodoPagoPreprodSimulatedProvider } from "../src/services/payments/TodoPagoPreprodSimulatedProvider.js";
import {
  normalizeCreateIntentResult,
  PaymentProviderContractError,
} from "../src/services/payments/paymentProviderContract.js";

const CALLBACK_URL = "https://example.com/pagos/resultado";

function normalize(overrides = {}) {
  return normalizeCreateIntentResult({
    providerIntentId: "provider-123",
    paymentUrl: CALLBACK_URL,
    launch: null,
    raw: {},
    ...overrides,
  });
}

test("normaliza correctamente un launch redirect", () => {
  const result = normalize({
    launch: {
      type: "redirect",
      action: CALLBACK_URL,
      method: "get",
      fields: null,
      allowedMessageOrigin: null,
      expiresAt: null,
    },
  });

  assert.deepEqual(result.launch, {
    type: "redirect",
    action: CALLBACK_URL,
    method: "GET",
    fields: {},
    allowedMessageOrigin: null,
    expiresAt: null,
  });
});

test("normaliza correctamente un launch iframe_post", () => {
  const result = normalize({
    paymentUrl: null,
    launch: {
      type: "iframe_post",
      action: "https://preprod.example.com/checkout",
      method: "POST",
      fields: { token: 123, empty: null },
      allowedMessageOrigin: "https://preprod.example.com/path",
      expiresAt: "2026-07-27T12:00:00.000Z",
    },
  });

  assert.deepEqual(result.launch, {
    type: "iframe_post",
    action: "https://preprod.example.com/checkout",
    method: "POST",
    fields: { token: "123", empty: "" },
    allowedMessageOrigin: "https://preprod.example.com",
    expiresAt: "2026-07-27T12:00:00.000Z",
  });
});

test("rechaza providerIntentId vacio", () => {
  assert.throws(
    () => normalize({ providerIntentId: " " }),
    (error) => error instanceof PaymentProviderContractError
      && error.code === "PAYMENT_PROVIDER_REQUIRED_FIELD"
  );
});

test("rechaza un tipo de launch invalido", () => {
  assert.throws(
    () => normalize({
      launch: { type: "popup", action: CALLBACK_URL, method: "GET", fields: {} },
    }),
    (error) => error.code === "PAYMENT_PROVIDER_LAUNCH_TYPE_INVALID"
  );
});

test("rechaza un metodo HTTP invalido", () => {
  assert.throws(
    () => normalize({
      launch: { type: "redirect", action: CALLBACK_URL, method: "PUT", fields: {} },
    }),
    (error) => error.code === "PAYMENT_PROVIDER_LAUNCH_METHOD_INVALID"
  );
});

test("MockPaymentProvider conserva paymentUrl y devuelve launch redirect", async () => {
  const provider = new MockPaymentProvider({ mockResult: "PAID" });
  const result = await provider.createIntent({
    idempotencyKey: "mock-key",
    montoHnl: 100,
    descripcion: "Prueba",
    callbackUrl: CALLBACK_URL,
    metadata: {},
  });

  assert.match(result.paymentUrl, /mock_result=PAID/);
  assert.equal(result.launch.type, "redirect");
  assert.equal(result.launch.action, result.paymentUrl);
  assert.equal(result.launch.method, "GET");
});

test("TodoPagoPreprodSimulatedProvider conserva su comportamiento redirect", async () => {
  const provider = new TodoPagoPreprodSimulatedProvider();
  const result = await provider.createIntent({
    idempotencyKey: "todo-key",
    montoHnl: 100,
    moneda: "HNL",
    descripcion: "Prueba",
    callbackUrl: CALLBACK_URL,
    metadata: {},
  });

  assert.match(result.providerIntentId, /^todopago_sim_todo-key_amt_100_00$/);
  assert.match(result.paymentUrl, /todopago_simulated=1/);
  assert.equal(result.raw.simulated, true);
  assert.equal(result.launch.type, "redirect");
  assert.equal(result.launch.action, result.paymentUrl);
});

for (const mode of ["preprod_real", "prod_real"]) {
  test(`TodoPago real continua bloqueado para ${mode}`, () => {
    const previousProvider = process.env.PAYMENT_PROVIDER;
    const previousMode = process.env.TODOPAGO_MODE;
    try {
      PaymentProviderFactory.reset();
      process.env.PAYMENT_PROVIDER = "todopago";
      process.env.TODOPAGO_MODE = mode;
      assert.throws(
        () => PaymentProviderFactory.create(),
        /TodoPago real aun no esta implementado/
      );
    } finally {
      PaymentProviderFactory.reset();
      if (previousProvider == null) delete process.env.PAYMENT_PROVIDER;
      else process.env.PAYMENT_PROVIDER = previousProvider;
      if (previousMode == null) delete process.env.TODOPAGO_MODE;
      else process.env.TODOPAGO_MODE = previousMode;
    }
  });
}
