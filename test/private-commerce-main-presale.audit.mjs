import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import fp from "fastify-plugin";
import adminDataEntry from "../src/plugins/adminDataEntry.js";
import gate from "../src/plugins/privateCommerce.js";

// AM: Route admission only; no registration, Auth network, database write or provider operation.
test("main presale admission survives administrative mode and disabled pilot", async t => {
  const app = Fastify();
  await app.register(fp(async a => {
    a.decorate("config", { adminDataEntryMode: true, paymentProvider: "disabled",
      privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] } });
    a.decorate("requireRoles", () => async () => { throw new Error("Unexpected authentication"); });
    a.decorate("db", { query: async () => { throw new Error("Unexpected SQL"); } });
  }, { name: "env-plugin" }));
  await app.register(adminDataEntry);
  await app.register(gate);
  t.after(() => app.close());
  const publicRoutes = [
    ["POST", "/v1/auth/register"], ["POST", "/v1/auth/register/confirm"],
    ["POST", "/v1/auth/register/resend"], ["POST", "/v1/auth/login"],
    ["POST", "/v1/auth/exchange"], ["POST", "/v1/auth/social/confirm"],
    ...["sucursales", "servicios", "paquetes", "promociones", "busqueda", "planes"]
      .map(name => ["GET", "/v1/public/catalog/" + name]),
    ["GET", "/v1/public/agenda/barberos"],
  ];
  for (const [method, url] of publicRoutes) app.route({ method, url, handler: async () => ({ reached: true }) });
  let commerce = 0;
  for (const url of ["/v1/public/citas/hold", "/v1/public/pagos/crear-intent", "/v1/cliente/planes/orden"]) {
    app.post(url, async () => { commerce++; return { unexpected: true }; });
  }
  for (const [method, url] of publicRoutes) {
    const result = await app.inject({ method, url, remoteAddress: "198.51.100.20" });
    assert.equal(result.statusCode, 200, url + ": " + result.body);
    assert.equal(result.json().reached, true);
  }
  for (const url of ["/v1/public/citas/hold", "/v1/public/pagos/crear-intent", "/v1/cliente/planes/orden"]) {
    assert.equal((await app.inject({ method: "POST", url })).statusCode, 403);
  }
  assert.equal(commerce, 0);
});
