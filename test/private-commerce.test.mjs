import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "jsonwebtoken";
import auth from "../src/plugins/auth.js";
import adminDataEntry from "../src/plugins/adminDataEntry.js";
import gate, { resolvePrivateCommerceConfig } from "../src/plugins/privateCommerce.js";
import { buildTrustProxy } from "../src/utils/trustProxy.js";
import publicCitas from "../src/routes/v1/public/citas.js";
import publicPagos from "../src/routes/v1/public/pagos.js";
import cliente from "../src/routes/v1/cliente.js";
import citas from "../src/routes/v1/citas.js";
import pagos from "../src/routes/v1/pagos.js";
import adminCitas from "../src/routes/v1/admin/citas.js";
import adminMembresias from "../src/routes/v1/admin/membresias.js";
import { installPrivatePilot } from "./helpers/privatePilotApp.mjs";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const USER = crypto.randomUUID(), OTHER = crypto.randomUUID();
const SECRET = crypto.randomBytes(40).toString("hex");
const IP = "203.0.113.10";
const protectedPaths = ["/v1/public/citas/hold", "/v1/public/citas/validar-contactos",
  "/v1/public/pagos/crear-intent", "/v1/public/pagos/pixelpay/sale", "/v1/public/pagos/pixelpay/status",
  "/v1/public/pagos/estado", "/v1/public/pagos/mock-completar", "/v1/public/pagos/simulator/event",
  "/v1/cliente/planes/orden", "/v1/cliente/planes/pago-intent", "/v1/cliente/planes/confirmar-pago",
  "/v1/cliente/planes/adquirir", "/v1/cliente/planes/pago-intent/" + USER + "/estado"];

async function fixture(t, options = {}) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PRIVATE_COMMERCE_")) delete process.env[key];
  Object.assign(process.env, { JWT_SECRET: SECRET, CSRF_SECRET: SECRET, TRUST_PROXY: "true",
    PRIVATE_COMMERCE_PILOT_ENABLED: "true", PRIVATE_COMMERCE_USER_IDS: USER, PRIVATE_COMMERCE_IPS: IP,
    ...options.env });
  for (const [key, value] of Object.entries(options.env || {})) if (value === undefined) delete process.env[key];
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const app = Fastify({ trustProxy: buildTrustProxy("true") });
  const state = { business: 0, unexpectedSql: 0 };
  app.decorate("db", { query: async (sql, params) => {
    if (sql.includes("FROM public.seguridad_sesiones")) return { rows: options.revoked ? [] : [{ estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 60000) }] };
    if (sql.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (sql.includes("WITH base_user")) return { rows: [{ id_usuario: params[0], cliente_id: options.clientId === undefined ? OTHER : options.clientId, roles: options.roles || ["super_admin", "cliente"] }] };
    state.unexpectedSql++; throw Error("Unexpected business SQL");
  }, connect: async () => { state.unexpectedSql++; throw Error("Business connection prohibited"); } });
  await app.register(fp(async a => a.decorate("config", { paymentProvider: "pixelpay", adminDataEntryMode: false, ...options.config }), { name: "env-plugin" }));
  await app.register(cookie);
  await app.register(auth);
  await app.register(adminDataEntry);
  await app.register(gate);
  await app.register(publicCitas, { prefix: "/v1/public/citas" });
  await app.register(publicPagos, { prefix: "/v1/public/pagos" });
  await app.register(cliente, { prefix: "/v1/cliente" });
  await app.register(citas, { prefix: "/v1/citas" });
  await app.register(pagos, { prefix: "/v1/pagos" });
  await app.register(publicPagos, { prefix: "/v1/pagos/reservas", authenticated: true });
  await app.register(adminCitas, { prefix: "/v1/admin/citas" });
  await app.register(adminMembresias, { prefix: "/v1/admin/membresias" });
  app.post("/v1/citas/probe", async () => { state.business++; return { ok: true }; });
  app.post("/v1/auth/register", async () => ({ presaleReached: true }));
  app.post("/v1/auth/login", async () => ({ presaleReached: true }));
  app.get("/v1/public/catalog/planes", async () => ({ catalogReached: true }));
  t.after(() => app.close());
  const headers = (id = USER) => ({ "x-csrf-token": "synthetic-csrf", cookie: "mf_csrf=synthetic-csrf; mf_session=" + jwt.sign({ sub: id, sid: USER, jti: OTHER, token_type: "app" }, SECRET,
    { issuer: "masterfade-api", audience: "masterfade-app", expiresIn: "1h" }) });
  return { app, state, headers };
}

for (const scenario of ["guest", "other-user", "wrong-ip", "forged-headers", "tampered-cookie", "disabled", "missing", "revoked", "admin-mode", "wrong-provider"]) {
  test(`API deny before any business query: ${scenario}`, async t => {
    const options = scenario === "disabled" ? { env: { PRIVATE_COMMERCE_PILOT_ENABLED: "false" } }
      : scenario === "missing" ? { env: { PRIVATE_COMMERCE_PILOT_ENABLED: undefined, PRIVATE_COMMERCE_USER_IDS: undefined, PRIVATE_COMMERCE_IPS: undefined } }
      : scenario === "revoked" ? { revoked: true } : scenario === "admin-mode" ? { config: { adminDataEntryMode: true } }
      : scenario === "wrong-provider" ? { config: { paymentProvider: "disabled" } } : {};
    const f = await fixture(t, options);
    for (const url of [...protectedPaths, "/v1/citas/hold", "/v1/pagos/reservas/pixelpay/sale", "/v1/admin/citas/hold"]) {
      const headers = scenario === "guest" || scenario === "forged-headers" ? {} : f.headers(scenario === "other-user" ? OTHER : USER);
      if (scenario === "tampered-cookie") headers.cookie += "tampered";
      Object.assign(headers, { "x-forwarded-for": IP, "x-real-ip": IP, "x-user-id": USER, "x-pilot-enabled": "true" });
      const r = await f.app.inject({ method: "POST", url, remoteAddress: ["wrong-ip", "forged-headers"].includes(scenario) ? "198.51.100.2" : IP, headers, payload: {} });
      assert.ok([401, 403].includes(r.statusCode), `${url}: ${r.statusCode} ${r.body}`);
    }
    assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
  });
}

test("authorized session and direct IP reach guarded handler; roles alone cannot grant access", async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: "POST", url: "/v1/citas/probe", remoteAddress: IP, headers: f.headers() });
  assert.equal(response.statusCode, 200);
  assert.equal(f.state.business, 1);
  const eligibility = await f.app.inject({ url: "/v1/commerce/eligibility", remoteAddress: IP, headers: f.headers() });
  assert.deepEqual(eligibility.json().data, { booking: true, vipPurchase: true });
  assert.match(eligibility.headers["cache-control"], /no-store/);
  const validation = await f.app.inject({ method: "POST", url: "/v1/public/pagos/pixelpay/sale", remoteAddress: IP, headers: f.headers(), payload: {} });
  assert.equal(validation.statusCode, 400);
  assert.equal(f.state.unexpectedSql, 0);
});

test("explicit proxy: rightmost hop wins; forwarded chains and untrusted peers cannot impersonate owner", async t => {
  const f = await fixture(t, { env: { PRIVATE_COMMERCE_PROXY_IPS: "10.0.0.2" } });
  for (const [peer, forwarded, expected] of [
    ["10.0.0.2", IP, 200], ["10.0.0.3", IP, 403], ["198.51.100.2", IP, 403],
    ["10.0.0.2", `${IP}, 198.51.100.2`, 403], ["10.0.0.2", "bad", 403],
  ]) {
    const r = await f.app.inject({ method: "POST", url: "/v1/citas/probe", remoteAddress: peer, headers: { ...f.headers(), "x-forwarded-for": forwarded } });
    assert.equal(r.statusCode, expected, r.body);
  }
});

test("eligibility is false for guests, other accounts and owners without a valid client identity", async t => {
  for (const scenario of ["guest", "other-user", "missing-client", "invalid-client", "admin-only"]) {
    await t.test(scenario, async sub => {
      const f = await fixture(sub, scenario === "missing-client" ? { clientId: null }
        : scenario === "invalid-client" ? { clientId: "unverified" }
        : scenario === "admin-only" ? { roles: ["super_admin"] } : {});
      const response = await f.app.inject({ url: "/v1/commerce/eligibility", remoteAddress: IP,
        headers: scenario === "guest" ? {} : f.headers(scenario === "other-user" ? OTHER : USER) });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().data, { booking: false, vipPurchase: false });
      assert.match(response.headers["cache-control"], /no-store/);
      const denial = await f.app.inject({ method: "POST", url: "/v1/public/pagos/crear-intent", remoteAddress: IP,
        headers: scenario === "guest" ? {} : f.headers(scenario === "other-user" ? OTHER : USER), payload: {} });
      assert.ok([401, 403].includes(denial.statusCode), denial.body);
      assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
    });
  }
});

test("proxy eligibility probe never creates business data and ignores spoofed external addresses", async t => {
  let providerCalls = 0;
  const originalCreate = PaymentProviderFactory.create;
  PaymentProviderFactory.create = () => { providerCalls++; throw new Error("Provider prohibited during eligibility probe"); };
  t.after(() => { PaymentProviderFactory.create = originalCreate; });
  const f = await fixture(t, { env: { PRIVATE_COMMERCE_PROXY_IPS: "10.0.0.2" } });
  for (const [peer, forwarded, owner, expected] of [
    ["10.0.0.2", IP, true, true], ["10.0.0.2", IP, false, false],
    ["198.51.100.2", IP, true, false], ["10.0.0.3", IP, true, false],
    ["10.0.0.2", `${IP}, 198.51.100.2`, true, false],
  ]) {
    const response = await f.app.inject({ url: "/v1/commerce/eligibility", remoteAddress: peer,
      headers: { ...f.headers(owner ? USER : OTHER), "x-forwarded-for": forwarded, "x-real-ip": IP, forwarded: `for=${IP}` } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, { booking: expected, vipPurchase: expected });
  }
  const guest = await f.app.inject({ url: "/v1/commerce/eligibility", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": IP } });
  assert.equal(guest.statusCode, 200, guest.body);
  assert.deepEqual(guest.json().data, { booking: false, vipPurchase: false });
  assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
  assert.equal(providerCalls, 0);
});

test("presale and callbacks remain independent of owner IP/session and pilot switch", async t => {
  const f = await fixture(t, { env: { PRIVATE_COMMERCE_PILOT_ENABLED: "false" } });
  for (const [method, url, property] of [["POST", "/v1/auth/register", "presaleReached"], ["POST", "/v1/auth/login", "presaleReached"], ["GET", "/v1/public/catalog/planes", "catalogReached"]]) {
    const r = await f.app.inject({ method, url, remoteAddress: "198.51.100.2" });
    assert.equal(r.statusCode, 200); assert.equal(r.json()[property], true);
  }
  const callback = await f.app.inject({ method: "POST", url: "/v1/pagos/webhook/pixelpay", remoteAddress: "198.51.100.2", payload: {} });
  assert.equal(callback.statusCode, 503);
  assert.equal(callback.json().error.code, "PIXELPAY_WEBHOOK_DISABLED");
  assert.equal(f.state.unexpectedSql, 0);
});

test("callback reaches its own financial guard even in administrative mode", async t => {
  const f = await fixture(t, { env: { PRIVATE_COMMERCE_PILOT_ENABLED: "false" }, config: { adminDataEntryMode: true } });
  const callback = await f.app.inject({ method: "POST", url: "/v1/pagos/webhook/pixelpay", remoteAddress: "198.51.100.2", payload: {} });
  assert.equal(callback.statusCode, 503);
  assert.equal(callback.json().error.code, "PIXELPAY_WEBHOOK_DISABLED");
  assert.equal(f.state.unexpectedSql, 0);
});

test("pilot off: maintenance and existing membership cancellations retain auth and role guards", async t => {
  const app = Fastify();
  app.decorate("config", { paymentProvider: "pixelpay", adminDataEntryMode: false });
  app.decorate("db", {});
  const request = await installPrivatePilot(app, t, { userId: USER, clientId: OTHER, enabled: false, roles: ["cliente", "admin"] });
  t.after(() => app.close());
  let maintained = 0, created = 0;
  const maintenance = [
    ["POST", "/v1/cliente/planes/cancelar", "/v1/cliente/planes/cancelar", "cliente"],
    ["PATCH", "/v1/cliente/planes/:id_suscripcion/cancelar", `/v1/cliente/planes/${OTHER}/cancelar`, "cliente"],
    ["POST", "/v1/admin/membresias/clientes/:id_cliente/cancelar", `/v1/admin/membresias/clientes/${OTHER}/cancelar`, "admin"],
    ["PUT", "/v1/admin/citas/horarios/:id_empleado", `/v1/admin/citas/horarios/${OTHER}`, "admin"],
    ["PATCH", "/v1/admin/citas/:id_cita/estado", `/v1/admin/citas/${OTHER}/estado`, "admin"],
  ];
  for (const [method, url, , role] of maintenance) app.route({ method, url, preHandler: app.requireRoles([role]), handler: async () => { maintained++; return { ok: true }; } });
  for (const url of ["/v1/admin/citas/hold", "/v1/cliente/planes/orden", "/v1/pagos/crear-intent"]) app.post(url, async () => { created++; return { ok: true }; });
  for (const [method, , url] of maintenance) {
    assert.equal((await app.inject({ ...request, remoteAddress: "198.51.100.20", method, url })).statusCode, 200);
    assert.equal((await app.inject({ method, url })).statusCode, 401);
  }
  for (const url of ["/v1/admin/citas/hold", "/v1/cliente/planes/orden", "/v1/pagos/crear-intent"]) assert.equal((await app.inject({ ...request, method: "POST", url })).statusCode, 403);
  assert.equal(maintained, maintenance.length);
  assert.equal(created, 0);
});

test("invalid or incomplete enabled configuration fails startup; absent defaults closed", () => {
  assert.equal(resolvePrivateCommerceConfig({}).enabled, false);
  for (const env of [{ PRIVATE_COMMERCE_PILOT_ENABLED: "yes" }, { PRIVATE_COMMERCE_PILOT_ENABLED: "true" },
    { PRIVATE_COMMERCE_USER_IDS: "email@example.test" }, { PRIVATE_COMMERCE_IPS: "0.0.0.0/0" }]) {
    assert.throws(() => resolvePrivateCommerceConfig(env));
  }
});

test("eligible session still requires CSRF on commercial mutations", async t => {
  const f = await fixture(t);
  const headers = f.headers(); delete headers["x-csrf-token"];
  const response = await f.app.inject({ method: "POST", url: "/v1/public/citas/hold", remoteAddress: IP, headers, payload: {} });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "CSRF_TOKEN_INVALID");
  assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
});
