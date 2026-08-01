import assert from "node:assert/strict";
import test from "node:test";
import {
  runTodoPagoAuthSmoke,
  TODOPAGO_PREPROD_AUTH_URL,
  TODOPAGO_SMOKE_CONFIRM_VALUE,
} from "../scripts/todopago-auth-smoke.js";

function validSource(overrides = {}) {
  return {
    TODOPAGO_AUTH_URL: TODOPAGO_PREPROD_AUTH_URL,
    TODOPAGO_USERNAME: "private-user",
    TODOPAGO_PASSWORD: "private-password",
    TODOPAGO_HTTP_TIMEOUT_MS: "1000",
    TODOPAGO_SMOKE_CONFIRM: TODOPAGO_SMOKE_CONFIRM_VALUE,
    ...overrides,
  };
}

test("smoke exige confirmacion manual exacta sin llamar fetch", async () => {
  let calls = 0;
  const result = await runTodoPagoAuthSmoke({
    source: validSource({ TODOPAGO_SMOKE_CONFIRM: "" }),
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "TODOPAGO_SMOKE_CONFIRM_REQUIRED");
  assert.equal(result.httpStatus, null);
  assert.equal(calls, 0);
});

test("smoke rechaza la URL productiva sin llamar fetch", async () => {
  let calls = 0;
  const result = await runTodoPagoAuthSmoke({
    source: validSource({
      TODOPAGO_AUTH_URL: "https://intercom-apitm.azurewebsites.net/api/v1/Auth/Manager/Login",
    }),
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "TODOPAGO_SMOKE_AUTH_URL_FORBIDDEN");
  assert.equal(calls, 0);
});

test("smoke rechaza cualquier URL distinta de la preproduccion permitida", async () => {
  let calls = 0;
  const result = await runTodoPagoAuthSmoke({
    source: validSource({ TODOPAGO_AUTH_URL: "https://example.test/api/auth" }),
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "TODOPAGO_SMOKE_AUTH_URL_FORBIDDEN");
  assert.equal(calls, 0);
});

test("salida del smoke exitoso contiene solo diagnostico seguro", async () => {
  const fixedDate = new Date("2026-08-01T12:00:00.000Z");
  const result = await runTodoPagoAuthSmoke({
    source: validSource(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async text() {
        return JSON.stringify({
          data: { token: "sensitive-token" },
          idTransaccion: "sensitive-transaction",
        });
      },
    }),
    now: () => fixedDate,
  });

  assert.deepEqual(result, {
    test: "todopago_auth_preprod",
    success: true,
    authHost: "test-intercom-apitm.azurewebsites.net",
    tokenPresent: true,
    tokenLength: 15,
    transactionIdPresent: true,
    transactionIdLength: 21,
    executedAt: fixedDate.toISOString(),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sensitive-token"), false);
  assert.equal(serialized.includes("sensitive-transaction"), false);
  assert.equal(serialized.includes("private-user"), false);
  assert.equal(serialized.includes("private-password"), false);
});
