import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import security from "../src/plugins/security.js";

const ALLOWED_ORIGIN = "http://localhost:5173";
const BLOCKED_ORIGIN = "https://sitio-no-autorizado.example";

async function buildCorsTestApp() {
  const app = Fastify({ logger: false });
  app.decorate("config", {
    corsOrigins: [ALLOWED_ORIGIN, "http://127.0.0.1:5173"],
    cookieSecret: "test-cookie-secret-with-enough-length",
    cookieSameSite: "lax",
    isProduction: false,
  });
  await app.register(security);

  const holdBodySchema = {
    type: "object",
    required: ["id_sucursal"],
    properties: {
      id_sucursal: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  };

  const holdHandler = async (request, reply) => reply
    .code(201)
    .header("X-Idempotency-Key", request.headers["x-idempotency-key"] || "")
    .send({
      ok: true,
      data: {
        request_id: "req-test",
        id_grupo_cita: "11111111-1111-4111-8111-111111111111",
        release_token: "release-test",
      },
    });

  app.post("/v1/public/citas/hold", { schema: { body: holdBodySchema } }, holdHandler);
  app.post("/v1/citas/hold", { schema: { body: holdBodySchema } }, holdHandler);

  await app.ready();
  return app;
}

function splitHeader(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function assertPreflightAllowsIdempotency(response) {
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.ok(splitHeader(response.headers["access-control-allow-methods"]).includes("post"));
  const allowedHeaders = splitHeader(response.headers["access-control-allow-headers"]);
  assert.ok(allowedHeaders.includes("content-type"));
  assert.ok(allowedHeaders.includes("x-idempotency-key"));
  assert.ok(splitHeader(response.headers["access-control-expose-headers"]).includes("x-idempotency-key"));
}

test("CORS preflight autoriza X-Idempotency-Key para hold publico y autenticado", async (t) => {
  const app = await buildCorsTestApp();
  t.after(() => app.close());

  const publicPreflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/public/citas/hold",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-idempotency-key",
    },
  });
  assertPreflightAllowsIdempotency(publicPreflight);

  const authenticatedPreflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/citas/hold",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,X-Idempotency-Key",
    },
  });
  assertPreflightAllowsIdempotency(authenticatedPreflight);
});

test("CORS no autoriza origen bloqueado", async (t) => {
  const app = await buildCorsTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/public/citas/hold",
    headers: {
      Origin: BLOCKED_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-idempotency-key",
    },
  });

  assert.notEqual(response.headers["access-control-allow-origin"], BLOCKED_ORIGIN);
});

test("POST invalido con X-Idempotency-Key llega a Fastify y responde JSON controlado", async (t) => {
  const app = await buildCorsTestApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Content-Type": "application/json",
      "X-Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    },
    payload: {},
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.headers["content-type"], /application\/json/i);
  assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.ok(splitHeader(response.headers["access-control-expose-headers"]).includes("x-idempotency-key"));
  assert.doesNotThrow(() => JSON.parse(response.body));
});
