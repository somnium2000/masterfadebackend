import assert from "node:assert/strict";
import test from "node:test";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { resolvePublicCitasHoldRateLimit } from "../src/config/publicCitasRateLimitConfig.js";
import publicCitasRoutes from "../src/routes/v1/public/citas.js";

test("rate limit de hold usa defaults seguros", () => {
  assert.deepEqual(resolvePublicCitasHoldRateLimit({}), {
    max: 5,
    timeWindow: "15 minutes",
  });
});

test("rate limit de hold acepta configuracion ENV valida", () => {
  assert.deepEqual(resolvePublicCitasHoldRateLimit({
    PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX: "30",
    PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW: "15 minutes",
  }), {
    max: 30,
    timeWindow: "15 minutes",
  });
});

test("rate limit de hold usa fallback seguro ante valores invalidos", () => {
  for (const env of [
    { PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX: "0", PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW: "never" },
    { PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX: "3.5", PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW: "" },
    { PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX: "10001", PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW: "-1 minute" },
  ]) {
    assert.deepEqual(resolvePublicCitasHoldRateLimit(env), {
      max: 5,
      timeWindow: "15 minutes",
    });
  }
});

test("solo /citas/hold usa el nuevo limite configurable", async (t) => {
  const names = ["PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX", "PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX = "2";
  process.env.PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW = "15 minutes";

  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  await app.register(publicCitasRoutes, { prefix: "/v1/public/citas" });
  await app.ready();
  t.after(async () => {
    await app.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  const holdStatuses = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/citas/hold",
      payload: {},
    });
    holdStatuses.push(response.statusCode);
  }
  assert.notEqual(holdStatuses[0], 429);
  assert.notEqual(holdStatuses[1], 429);
  assert.equal(holdStatuses[2], 429);

  const unrelatedStatuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/citas/validar-contactos",
      payload: { contactos: [] },
    });
    unrelatedStatuses.push(response.statusCode);
  }
  assert.equal(unrelatedStatuses.includes(429), false);
});
