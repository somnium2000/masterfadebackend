import assert from "node:assert/strict";
import test from "node:test";
import {
  getTodoPagoConfigDiagnostic,
  resolveTodoPagoConfig,
} from "../src/services/payments/todopago/todoPagoConfig.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

function realConfig(overrides = {}) {
  return {
    PAYMENT_PROVIDER: "todopago",
    TODOPAGO_MODE: "preprod_real",
    TODOPAGO_BASE_URL: "https://api.example.test",
    TODOPAGO_AUTH_URL: "https://api.example.test/auth",
    TODOPAGO_MODAL_URL: "https://checkout.example.test/modal",
    TODOPAGO_USERNAME: "sensitive-user",
    TODOPAGO_PASSWORD: "sensitive-password",
    TODOPAGO_COMMERCE_ID: "commerce-123",
    TODOPAGO_TENANT: "tenant-123",
    TODOPAGO_TERMINAL: "terminal-123",
    TODOPAGO_ENCRYPTION_KEY: "sensitive-encryption-key",
    TODOPAGO_ALLOWED_MESSAGE_ORIGIN: "https://checkout.example.test/messages/path",
    TODOPAGO_HTTP_TIMEOUT_MS: "10000",
    ...overrides,
  };
}

test("configuracion simulada funciona sin secretos", () => {
  const config = resolveTodoPagoConfig({
    PAYMENT_PROVIDER: "todopago",
    TODOPAGO_MODE: "preprod_simulated",
  });

  assert.equal(config.mode, "preprod_simulated");
  assert.equal(config.username, "");
  assert.equal(config.password, "");
  assert.equal(config.encryptionKey, "");
  assert.equal(config.httpTimeoutMs, 10000);
  assert.equal(Object.isFrozen(config), true);
});

for (const requiredName of [
  "TODOPAGO_USERNAME",
  "TODOPAGO_PASSWORD",
  "TODOPAGO_COMMERCE_ID",
  "TODOPAGO_TENANT",
  "TODOPAGO_TERMINAL",
  "TODOPAGO_ENCRYPTION_KEY",
]) {
  test(`configuracion real incompleta rechaza ${requiredName} sin exponer valores`, () => {
    const source = realConfig({ [requiredName]: "" });
    assert.throws(
      () => resolveTodoPagoConfig(source),
      (error) => {
        assert.equal(error.code, "TODOPAGO_CONFIG_REQUIRED");
        assert.equal(error.message.includes("sensitive-user"), false);
        assert.equal(error.message.includes("sensitive-password"), false);
        assert.equal(error.message.includes("sensitive-encryption-key"), false);
        return true;
      }
    );
  });
}

for (const urlName of [
  "TODOPAGO_BASE_URL",
  "TODOPAGO_AUTH_URL",
  "TODOPAGO_MODAL_URL",
  "TODOPAGO_ALLOWED_MESSAGE_ORIGIN",
]) {
  test(`${urlName} rechaza HTTP`, () => {
    assert.throws(
      () => resolveTodoPagoConfig(realConfig({ [urlName]: "http://api.example.test" })),
      (error) => error.code === "TODOPAGO_URL_INVALID"
    );
  });
}

test("allowedMessageOrigin se normaliza unicamente al origin", () => {
  const config = resolveTodoPagoConfig(realConfig());
  assert.equal(config.allowedMessageOrigin, "https://checkout.example.test");
});

for (const invalidTimeout of ["999", "30001", "1000.5", "invalid"]) {
  test(`timeout invalido es rechazado: ${invalidTimeout}`, () => {
    assert.throws(
      () => resolveTodoPagoConfig(realConfig({ TODOPAGO_HTTP_TIMEOUT_MS: invalidTimeout })),
      (error) => error.code === "TODOPAGO_HTTP_TIMEOUT_INVALID"
    );
  });
}

test("diagnostico sanitiza credenciales y llave", () => {
  const config = resolveTodoPagoConfig(realConfig());
  const diagnostic = getTodoPagoConfigDiagnostic(config);
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.username, "[REDACTED]");
  assert.equal(diagnostic.password, "[REDACTED]");
  assert.equal(diagnostic.encryptionKey, "[REDACTED]");
  assert.equal(serialized.includes("sensitive-user"), false);
  assert.equal(serialized.includes("sensitive-password"), false);
  assert.equal(serialized.includes("sensitive-encryption-key"), false);
  assert.equal(Object.isFrozen(diagnostic), true);
});

for (const mode of ["preprod_real", "prod_real"]) {
  test(`factory continua bloqueando ${mode}`, () => {
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
