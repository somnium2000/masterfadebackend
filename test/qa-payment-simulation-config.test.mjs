import assert from "node:assert/strict";
import test from "node:test";
import { resolveQaPaymentSimulationConfig } from "../src/config/qaPaymentSimulation.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { TodoPagoPreprodSimulatedProvider } from "../src/services/payments/TodoPagoPreprodSimulatedProvider.js";

function authorizedQa(overrides = {}) {
  return {
    NODE_ENV: "development",
    ENTORNO: "qa",
    PAYMENT_PROVIDER: "todopago",
    TODOPAGO_MODE: "preprod_simulated",
    TODOPAGO_SIMULATED_ENABLED: "true",
    ENABLE_QA_PAYMENT_SIMULATION: "true",
    ...overrides,
  };
}

test("habilita TodoPago simulado solo con la configuracion QA completa", () => {
  assert.deepEqual(resolveQaPaymentSimulationConfig(authorizedQa()), { enabled: true });
});

for (const [name, value] of [
  ["NODE_ENV", "test"],
  ["ENTORNO", "development"],
  ["PAYMENT_PROVIDER", "pixelpay"],
  ["TODOPAGO_MODE", "preprod_real"],
  ["TODOPAGO_SIMULATED_ENABLED", "false"],
]) {
  test(`rechaza autorizacion QA incompleta: ${name}`, () => {
    assert.throws(
      () => resolveQaPaymentSimulationConfig(authorizedQa({ [name]: value })),
      /ENABLE_QA_PAYMENT_SIMULATION requiere/
    );
  });
}

test("QA no puede seleccionar TodoPago simulado sin autorizacion explicita", () => {
  assert.throws(
    () => resolveQaPaymentSimulationConfig(authorizedQa({ ENABLE_QA_PAYMENT_SIMULATION: "false" })),
    /requiere ENABLE_QA_PAYMENT_SIMULATION=true/
  );
});

for (const overrides of [
  { NODE_ENV: "production" },
  { NODE_ENV: "development", ENTORNO: "production" },
  { NODE_ENV: "staging", ENTORNO: "qa" },
]) {
  test(`produccion o staging rechazan simulacion: ${JSON.stringify(overrides)}`, () => {
    assert.throws(
      () => resolveQaPaymentSimulationConfig(authorizedQa(overrides)),
      /prohibido en produccion\/staging/
    );
  });
}

test("PixelPay permanece sin excepcion cuando el flag QA esta apagado", () => {
  assert.deepEqual(resolveQaPaymentSimulationConfig({
    NODE_ENV: "development",
    ENTORNO: "qa",
    PAYMENT_PROVIDER: "pixelpay",
    ENABLE_QA_PAYMENT_SIMULATION: "false",
  }), { enabled: false });
});

test("la fabrica QA selecciona TodoPago simulado sin construir PixelPay", () => {
  const previous = Object.fromEntries(Object.keys(authorizedQa()).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, authorizedQa());
    PaymentProviderFactory.reset();
    const provider = PaymentProviderFactory.create();
    assert.equal(provider instanceof TodoPagoPreprodSimulatedProvider, true);
  } finally {
    PaymentProviderFactory.reset();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("la fabrica rechaza TodoPago simulado si NODE_ENV es production", () => {
  const env = authorizedQa({ NODE_ENV: "production" });
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, env);
    PaymentProviderFactory.reset();
    assert.throws(
      () => PaymentProviderFactory.create(),
      /prohibido en produccion\/staging/
    );
  } finally {
    PaymentProviderFactory.reset();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
