import assert from "node:assert/strict";
import test from "node:test";
import {
  TodoPagoHttpClient,
  TodoPagoHttpClientError,
} from "../src/services/payments/todopago/TodoPagoHttpClient.js";

function jsonResponse({ status = 200, body = "{}", contentType = "application/json" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    async text() {
      return body;
    },
  };
}

test("cliente HTTP usa POST JSON sin realizar reintentos", async () => {
  const calls = [];
  const client = new TodoPagoHttpClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ body: '{"ok":true}' });
    },
  });

  const result = await client.postJson("https://api.example.test/session", { amount: "1.00" });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
});

test("cliente HTTP rechaza URLs no HTTPS", async () => {
  const client = new TodoPagoHttpClient({ fetchImpl: async () => jsonResponse() });
  await assert.rejects(
    client.postJson("http://api.example.test/session", {}),
    (error) => error.code === "TODOPAGO_HTTP_URL_INVALID"
  );
});

test("cliente HTTP maneja timeout con AbortController", async () => {
  const client = new TodoPagoHttpClient({
    timeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      void resolve;
      signal.addEventListener("abort", () => reject(new Error("aborted-with-secret-value")), { once: true });
    }),
  });

  await assert.rejects(
    client.postJson("https://api.example.test/session", {}),
    (error) => error.code === "TODOPAGO_HTTP_TIMEOUT"
      && !error.message.includes("secret-value")
  );
});

test("cliente HTTP rechaza JSON invalido", async () => {
  const client = new TodoPagoHttpClient({
    fetchImpl: async () => jsonResponse({ body: "not-json" }),
  });
  await assert.rejects(
    client.postJson("https://api.example.test/session", {}),
    (error) => error.code === "TODOPAGO_HTTP_JSON_INVALID"
  );
});

for (const status of [400, 401, 500, 503]) {
  test(`cliente HTTP maneja respuesta ${status} sin filtrar cuerpo`, async () => {
    const secret = `secret-response-${status}`;
    const client = new TodoPagoHttpClient({
      fetchImpl: async () => jsonResponse({ status, body: `{"detail":"${secret}"}` }),
    });

    await assert.rejects(
      client.postJson("https://api.example.test/session", {}),
      (error) => {
        assert.equal(error instanceof TodoPagoHttpClientError, true);
        assert.equal(error.code, "TODOPAGO_HTTP_STATUS_ERROR");
        assert.equal(error.status, status);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.stack.includes(secret), false);
        return true;
      }
    );
  });
}

test("cliente HTTP no incluye secretos de errores de red", async () => {
  const secret = "network-password-secret";
  const client = new TodoPagoHttpClient({
    fetchImpl: async () => {
      throw new Error(`socket failed with ${secret}`);
    },
  });

  await assert.rejects(
    client.postJson("https://api.example.test/session", {}, {
      headers: { Authorization: "Bearer secret-token" },
    }),
    (error) => {
      assert.equal(error.code, "TODOPAGO_HTTP_NETWORK_ERROR");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("secret-token"), false);
      assert.equal(error.stack.includes(secret), false);
      return true;
    }
  );
});

test("cliente HTTP valida Content-Type JSON", async () => {
  const client = new TodoPagoHttpClient({
    fetchImpl: async () => jsonResponse({ contentType: "text/html", body: "<html></html>" }),
  });
  await assert.rejects(
    client.postJson("https://api.example.test/session", {}),
    (error) => error.code === "TODOPAGO_HTTP_CONTENT_TYPE_INVALID"
  );
});
