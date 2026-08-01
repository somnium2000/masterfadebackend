import assert from "node:assert/strict";
import test from "node:test";
import { TodoPagoAuthClient } from "../src/services/payments/todopago/TodoPagoAuthClient.js";
import { TodoPagoHttpClient } from "../src/services/payments/todopago/TodoPagoHttpClient.js";

const AUTH_URL = "https://test-intercom-apitm.azurewebsites.net/api/v1/Auth/Manager/Login";

function jsonResponse({ status = 200, body = "{}" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    async text() {
      return body;
    },
  };
}

function createAuthClient(fetchImpl, timeoutMs = 1_000) {
  const httpClient = new TodoPagoHttpClient({ fetchImpl, timeoutMs });
  return new TodoPagoAuthClient({ httpClient, authUrl: AUTH_URL });
}

test("autenticacion TodoPago exitosa envia el payload exacto y retorna el contrato interno", async () => {
  const calls = [];
  const client = createAuthClient(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      body: JSON.stringify({ data: { token: "opaque-token" }, idTransaccion: "transaction-123" }),
    });
  });

  const result = await client.authenticate({
    username: "private-user",
    password: "private-password",
  });

  assert.deepEqual(result, { token: "opaque-token", idTransaccion: "transaction-123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, AUTH_URL);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    userName: "private-user",
    password: "private-password",
  });
});

test("autenticacion TodoPago rechaza token faltante", async () => {
  const client = createAuthClient(async () => jsonResponse({
    body: JSON.stringify({ data: {}, idTransaccion: "transaction-123" }),
  }));
  await assert.rejects(
    client.authenticate({ username: "private-user", password: "private-password" }),
    (error) => error.code === "TODOPAGO_AUTH_TOKEN_MISSING"
  );
});

test("autenticacion TodoPago rechaza idTransaccion faltante", async () => {
  const client = createAuthClient(async () => jsonResponse({
    body: JSON.stringify({ data: { token: "opaque-token" } }),
  }));
  await assert.rejects(
    client.authenticate({ username: "private-user", password: "private-password" }),
    (error) => error.code === "TODOPAGO_AUTH_TRANSACTION_ID_MISSING"
  );
});

test("autenticacion TodoPago rechaza una respuesta que no es objeto", async () => {
  const client = createAuthClient(async () => jsonResponse({ body: "[]" }));
  await assert.rejects(
    client.authenticate({ username: "private-user", password: "private-password" }),
    (error) => error.code === "TODOPAGO_AUTH_RESPONSE_INVALID"
  );
});

test("autenticacion TodoPago propaga un error HTTP sanitizado", async () => {
  const client = createAuthClient(async () => jsonResponse({
    status: 401,
    body: JSON.stringify({ detail: "private-response" }),
  }));
  await assert.rejects(
    client.authenticate({ username: "private-user", password: "private-password" }),
    (error) => error.code === "TODOPAGO_HTTP_STATUS_ERROR"
      && error.status === 401
      && !error.message.includes("private-response")
  );
});

test("autenticacion TodoPago maneja timeout sin reintentar", async () => {
  let calls = 0;
  const client = createAuthClient(async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-timeout")), { once: true });
    });
  });

  await assert.rejects(
    client.authenticate({ username: "private-user", password: "private-password" }),
    (error) => error.code === "TODOPAGO_HTTP_TIMEOUT"
  );
  assert.equal(calls, 1);
});

test("errores de autenticacion no incluyen usuario, contrasena ni token", async () => {
  const secrets = ["sensitive-user", "sensitive-password", "sensitive-token"];
  const client = createAuthClient(async () => jsonResponse({
    body: JSON.stringify({ data: { token: "" }, idTransaccion: "sensitive-token" }),
  }));

  await assert.rejects(
    client.authenticate({ username: secrets[0], password: secrets[1] }),
    (error) => {
      const serialized = `${error.message}\n${error.stack}`;
      assert.equal(secrets.some((secret) => serialized.includes(secret)), false);
      return true;
    }
  );
});
