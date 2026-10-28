import assert from "node:assert/strict";
import test from "node:test";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { buildTrustProxy } from "../src/utils/trustProxy.js";

async function buildControlApp() {
  const app = Fastify({ logger: false, trustProxy: buildTrustProxy("true") });
  await app.register(rateLimit, { global: false });
  app.get("/rate-limit-control", {
    config: {
      rateLimit: {
        max: 2,
        timeWindow: "1 minute",
        keyGenerator: (request) => request.ip,
      },
    },
  }, async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

test("solo confia en el Traefik interno inmediato y no en XFF arbitrario", async (t) => {
  const app = await buildControlApp();
  t.after(() => app.close());

  const proxyAddress = "172.18.0.5";
  const realClientA = "203.0.113.40";
  const first = await app.inject({
    method: "GET",
    url: "/rate-limit-control",
    remoteAddress: proxyAddress,
    headers: { "x-forwarded-for": `198.51.100.10, ${realClientA}` },
  });
  const second = await app.inject({
    method: "GET",
    url: "/rate-limit-control",
    remoteAddress: proxyAddress,
    headers: { "x-forwarded-for": `192.0.2.20, ${realClientA}` },
  });
  const blocked = await app.inject({
    method: "GET",
    url: "/rate-limit-control",
    remoteAddress: proxyAddress,
    headers: { "x-forwarded-for": `198.51.100.30, ${realClientA}` },
  });
  const differentClient = await app.inject({
    method: "GET",
    url: "/rate-limit-control",
    remoteAddress: proxyAddress,
    headers: { "x-forwarded-for": "198.51.100.10, 203.0.113.41" },
  });

  assert.equal(first.json().ip, realClientA);
  assert.equal(second.json().ip, realClientA);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(blocked.statusCode, 429);
  assert.equal(differentClient.statusCode, 200);
});

test("una conexion publica directa no puede hacer confiable X-Forwarded-For", async (t) => {
  const app = await buildControlApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/rate-limit-control",
    remoteAddress: "203.0.113.90",
    headers: { "x-forwarded-for": "198.51.100.90" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ip, "203.0.113.90");
});
