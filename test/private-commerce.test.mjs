import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "jsonwebtoken";
import auth from "../src/plugins/auth.js";
import adminDataEntry from "../src/plugins/adminDataEntry.js";
import gate, { resolvePrivateCommerceConfig, resolveQaSandboxBookingConfig } from "../src/plugins/privateCommerce.js";
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
import { sendError } from "../src/utils/errors.js";
import { createQaCommerceDiagnostic } from '../src/utils/qaCommerceDiagnostic.js';
import { validateActiveSession } from '../src/services/securityService.js';

const USER = crypto.randomUUID(), OTHER = crypto.randomUUID();
const SECRET = crypto.randomBytes(40).toString("hex");
const IP = "203.0.113.10";
const protectedPaths = ["/v1/public/citas/hold", "/v1/public/citas/validar-contactos",
  "/v1/public/pagos/crear-intent", "/v1/public/pagos/pixelpay/sale", "/v1/public/pagos/pixelpay/status",
  "/v1/public/pagos/estado", "/v1/public/pagos/mock-completar", "/v1/public/pagos/simulator/event",
  "/v1/cliente/planes/orden", "/v1/cliente/planes/pago-intent", "/v1/cliente/planes/confirmar-pago",
  "/v1/cliente/planes/adquirir", "/v1/cliente/planes/pago-intent/" + USER + "/estado",
  "/v1/citas/hold/" + USER + "/confirmar"];

async function fixture(t, options = {}) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PRIVATE_COMMERCE_")) delete process.env[key];
  Object.assign(process.env, { JWT_SECRET: SECRET, CSRF_SECRET: SECRET, TRUST_PROXY: "true",
    PRIVATE_COMMERCE_PILOT_ENABLED: "true", PRIVATE_COMMERCE_USER_IDS: USER, PRIVATE_COMMERCE_IPS: IP,
    ...options.env });
  for (const [key, value] of Object.entries(options.env || {})) if (value === undefined) delete process.env[key];
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const app = Fastify({ trustProxy: buildTrustProxy("true") });
  app.setErrorHandler((error, request, reply) => sendError(reply, error.statusCode || 500, 'Solicitud invalida', { code: error.code }));
  const state = { business: 0, unexpectedSql: 0 };
  app.decorate("db", { query: async (sql, params) => {
    if (sql.includes("FROM public.seguridad_sesiones")) return { rows: options.revoked ? [] : [{ estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 60000) }] };
    if (sql.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (sql.includes("WITH base_user")) return { rows: options.noClaims ? [] : [{ id_usuario: options.claimsMismatch ? OTHER : params[0], cliente_id: options.clientId === undefined ? OTHER : options.clientId, roles: options.roles || ["super_admin", "cliente"] }] };
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

test("QA simulation opens only booking and TodoPago simulator routes", async t => {
  const app = Fastify();
  app.decorate("config", {
    paymentProvider: "todopago",
    adminDataEntryMode: false,
    privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] },
    qaPaymentSimulation: { enabled: true },
  });
  app.decorate("requireRoles", () => async () => {});
  await app.register(fp(async () => {}, { name: "env-plugin" }));
  await app.register(gate);
  t.after(() => app.close());

  const allowed = [
    "/v1/public/citas/validar-contactos",
    "/v1/public/citas/validar-titular",
    "/v1/public/citas/hold",
    "/v1/citas/hold",
    "/v1/public/pagos/crear-intent",
    "/v1/public/pagos/estado",
    "/v1/public/pagos/simulator/event",
    "/v1/pagos/reservas/crear-intent",
    "/v1/pagos/reservas/estado",
    "/v1/pagos/reservas/simulator/event",
  ];
  const denied = [
    "/v1/public/pagos/mock-completar",
    "/v1/public/pagos/pixelpay/sale",
    "/v1/cliente/planes/orden",
    "/v1/admin/citas/hold",
  ];
  for (const url of [...allowed, ...denied]) {
    app.post(url, async () => ({ reached: true }));
  }
  app.post("/v1/citas/hold/:id_grupo_cita/confirmar", async () => ({ reached: true }));
  app.post("/v1/citas/hold/:id_grupo_cita/confirmar-pago", async () => ({ reached: true }));
  app.patch("/v1/citas/hold/:id_grupo_cita/confirmar", async () => ({ reached: true }));

  for (const url of allowed) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(response.json().reached, true);
  }
  for (const url of denied) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    assert.equal(response.json().error.code, "PRIVATE_COMMERCE_RESTRICTED");
  }

  const zeroTotalConfirmation = await app.inject({
    method: "POST",
    url: `/v1/citas/hold/${USER}/confirmar`,
    payload: {},
  });
  assert.equal(zeroTotalConfirmation.statusCode, 200, zeroTotalConfirmation.body);
  assert.equal(zeroTotalConfirmation.json().reached, true);
  for (const request of [
    { method: "POST", url: `/v1/citas/hold/${USER}/confirmar-pago` },
    { method: "PATCH", url: `/v1/citas/hold/${USER}/confirmar` },
  ]) {
    const response = await app.inject({ ...request, payload: {} });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
    assert.equal(response.json().error.code, "PRIVATE_COMMERCE_RESTRICTED");
  }

  const eligibility = await app.inject({ url: "/v1/commerce/eligibility" });
  assert.deepEqual(eligibility.json().data, { booking: true, vipPurchase: false });
});

test("QA VIP switch opens only the simulated membership flow and safe status read", async t => {
  const app = Fastify();
  app.decorate("config", {
    paymentProvider: "todopago",
    adminDataEntryMode: false,
    privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] },
    qaPaymentSimulation: { enabled: true },
    qaVipPurchaseSimulation: { enabled: true },
  });
  app.decorate("requireRoles", () => async () => {});
  await app.register(fp(async () => {}, { name: "env-plugin" }));
  await app.register(gate);
  t.after(() => app.close());

  const allowedRoutes = [
    ["/v1/cliente/planes/orden", "/v1/cliente/planes/orden"],
    ["/v1/cliente/planes/pago-intent", "/v1/cliente/planes/pago-intent"],
    ["/v1/cliente/planes/simulator/event", "/v1/cliente/planes/simulator/event"],
    [
      "/v1/cliente/planes/pago-intent/:id_payment_intent/estado",
      `/v1/cliente/planes/pago-intent/${USER}/estado`,
    ],
  ];
  const denied = [
    "/v1/cliente/planes/confirmar-pago",
    "/v1/cliente/planes/adquirir",
    "/v1/admin/membresias/clientes/probe",
  ];
  for (const [route] of allowedRoutes) app.post(route, async () => ({ reached: true }));
  for (const route of denied) app.post(route, async () => ({ reached: true }));

  for (const [, url] of allowedRoutes) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(response.json().reached, true);
  }
  for (const url of denied) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    assert.equal(response.json().error.code, "PRIVATE_COMMERCE_RESTRICTED");
  }

  const eligibility = await app.inject({ url: "/v1/commerce/eligibility" });
  assert.deepEqual(eligibility.json().data, { booking: true, vipPurchase: true });
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

const QA_SDK = { ENTORNO: 'qa', NODE_ENV: 'development', PAYMENT_PROVIDER: 'pixelpay',
  PIXELPAY_IMPLEMENTATION: 'sdk', PIXELPAY_ENV: 'sandbox' };

test('QA pilot grants booking only and blocks all VIP and Sale aliases before handlers', async t => {
  let providerCalls = 0;
  const originalCreate = PaymentProviderFactory.create;
  PaymentProviderFactory.create = () => { providerCalls++; throw new Error('Provider forbidden'); };
  t.after(() => { PaymentProviderFactory.create = originalCreate; });
  const f = await fixture(t, { env: QA_SDK });
  assert.deepEqual((await f.app.inject({ url: '/v1/commerce/eligibility', remoteAddress: IP, headers: f.headers() })).json().data,
    { booking: true, vipPurchase: false });
  for (const url of ['/v1/public/citas/hold', '/v1/citas/hold', '/v1/public/pagos/crear-intent', '/v1/pagos/reservas/crear-intent',
    '/v1/public/pagos/estado', '/v1/pagos/reservas/estado', '/v1/public/pagos/pixelpay/status', '/v1/pagos/reservas/pixelpay/status',
    '/v1/cliente/planes/pago-intent/invalid/estado']) {
    const r = await f.app.inject({ method: 'POST', url, remoteAddress: IP, headers: f.headers(), payload: {} });
    assert.equal(r.statusCode, 400, `${url}: original schema must reject empty input: ${r.body}`);
  }
  for (const url of ['/v1/cliente/planes/orden', '/v1/cliente/planes/pago-intent', '/v1/cliente/planes/adquirir',
    '/v1/cliente/planes/confirmar-pago', '/v1/cliente/planes/simulator/event', '/v1/citas/probe',
    '/v1/public/pagos/pixelpay/sale', '/v1/pagos/reservas/pixelpay/sale', '/v1/pagos/crear-intent',
    '/v1/public/pagos/mock-completar', '/v1/public/pagos/simulator/event']) {
    assert.equal((await f.app.inject({ method: 'POST', url, remoteAddress: IP, headers: f.headers(), payload: {} })).statusCode, 403, url);
  }
  assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
  assert.equal(providerCalls, 0);
});

test('QA explicit immediate proxy preserves independent booking eligibility', async t => {
  const f = await fixture(t, { env: { ...QA_SDK, PRIVATE_COMMERCE_PROXY_IPS: '10.0.0.2' } });
  const response = await f.app.inject({ url: '/v1/commerce/eligibility', remoteAddress: '10.0.0.2',
    headers: { ...f.headers(), 'x-forwarded-for': IP } });
  assert.deepEqual(response.json().data, { booking: true, vipPurchase: false });
});

for (const scenario of ['disabled', 'other', 'guest', 'admin', 'inactive', 'mismatch', 'ip', 'proxy', 'chain', 'csrf-missing', 'csrf-wrong']) {
  test(`QA booking isolation: ${scenario}`, async t => {
    const f = await fixture(t, { env: { ...QA_SDK, ...(scenario === 'disabled' ? { PRIVATE_COMMERCE_PILOT_ENABLED: 'false' } : {}),
      ...(['proxy', 'chain'].includes(scenario) ? { PRIVATE_COMMERCE_PROXY_IPS: '10.0.0.2' } : {}) },
      ...(scenario === 'inactive' ? { clientId: null } : {}), ...(scenario === 'admin' ? { roles: ['super_admin'] } : {}),
      claimsMismatch: scenario === 'mismatch' });
    const headers = scenario === 'guest' ? {} : f.headers(scenario === 'other' ? OTHER : USER);
    if (scenario === 'csrf-missing') delete headers['x-csrf-token'];
    if (scenario === 'csrf-wrong') headers['x-csrf-token'] = 'incorrect';
    headers['x-forwarded-for'] = scenario === 'chain' ? `${IP}, 198.51.100.2` : IP;
    const remoteAddress = scenario === 'chain' ? '10.0.0.2' : ['ip', 'proxy'].includes(scenario) ? '198.51.100.2' : IP;
    const r = await f.app.inject({ method: 'POST', url: '/v1/public/citas/hold', headers, remoteAddress, payload: {} });
    assert.ok([401, 403].includes(r.statusCode), r.body);
    assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
  });
}

test('QA Sale opt-in is independent, default false, and never grants VIP', async t => {
  assert.equal(resolvePrivateCommerceConfig(QA_SDK).saleEnabled, false);
  for (const env of [{ QA_PRIVATE_COMMERCE_SALE_ENABLED: 'true' }, { ...QA_SDK, QA_PRIVATE_COMMERCE_SALE_ENABLED: 'yes' },
    { ...QA_SDK, PIXELPAY_ENV: 'live', QA_PRIVATE_COMMERCE_SALE_ENABLED: 'true' }]) assert.throws(() => resolvePrivateCommerceConfig(env));
  const f = await fixture(t, { env: { ...QA_SDK, QA_PRIVATE_COMMERCE_SALE_ENABLED: 'true' } });
  for (const url of ['/v1/public/pagos/pixelpay/sale', '/v1/pagos/reservas/pixelpay/sale']) {
    assert.equal((await f.app.inject({ method: 'POST', url, remoteAddress: IP, headers: f.headers(), payload: {} })).statusCode, 400);
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/cliente/planes/orden', remoteAddress: IP, headers: f.headers(), payload: {} })).statusCode, 403);
  assert.deepEqual(f.state, { business: 0, unexpectedSql: 0 });
});

test('QA configuration rejects invalid UUIDs, multiple owners and incompatible proxy trust', () => {
  const valid = { ...QA_SDK, PRIVATE_COMMERCE_PILOT_ENABLED: 'true', PRIVATE_COMMERCE_USER_IDS: USER, PRIVATE_COMMERCE_IPS: IP };
  for (const patch of [{ PRIVATE_COMMERCE_USER_IDS: `${USER},${OTHER}` }, { PRIVATE_COMMERCE_USER_IDS: 'google-provider-id' },
    { PRIVATE_COMMERCE_PROXY_IPS: '10.0.0.2', TRUST_PROXY: 'false' }]) assert.throws(() => resolvePrivateCommerceConfig({ ...valid, ...patch }));
});

test('QA diagnostic: real auth, no response change or session write with pilot disabled', async t => {
  const f = await fixture(t, { env: { NODE_ENV: 'development', ENTORNO: 'qa', PRIVATE_COMMERCE_PILOT_ENABLED: 'false', PRIVATE_COMMERCE_PROXY_IPS: '10.0.0.2', QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED: 'true', QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL: new Date(Date.now()+60000).toISOString() } });
  const logs = [], queries = [];
  f.app.log.info = data => { if (data.event === 'QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC') logs.push(data); };
  const original = f.app.db.query;
  f.app.db.query = async (sql, params) => { queries.push(sql); return original(sql, params); };
  const headers = { ...f.headers(), 'x-forwarded-for': IP };
  const r = await f.app.inject({ url: '/v1/commerce/eligibility', remoteAddress: '10.0.0.2', headers });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().data, { booking: false, vipPurchase: false });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, 'PILOT_DISABLED');
  assert.equal(logs[0].ipsLength, 2);
  assert.equal(logs[0].fastifyTrustsPeer, true);
  assert.equal(logs[0].peerAllowlisted, true);
  assert.equal(logs[0].clientAllowlisted, true);
  assert.equal(queries.filter(sql => /UPDATE|INSERT|DELETE/.test(sql)).length, 0);
  const serialized = JSON.stringify(logs);
  for (const secret of [IP, '10.0.0.2', USER, OTHER, headers.cookie, SECRET]) assert.ok(!serialized.includes(secret));
  assert.equal(f.state.business, 0);
  const bad = await f.app.inject({ url: '/v1/commerce/eligibility', headers: { cookie: 'mf_session=invalid' } });
  assert.deepEqual(bad.json().data, { booking: false, vipPurchase: false });
  assert.equal(logs.length, 1);
});

for (const scope of [{}, { NODE_ENV: 'production', ENTORNO: 'qa' }, { NODE_ENV: 'development', ENTORNO: 'production' }]) {
  test('diagnostic off or outside QA emits nothing '+JSON.stringify(scope), async t => {
    const f = await fixture(t, { env: { PRIVATE_COMMERCE_PILOT_ENABLED: 'false', QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED: Object.keys(scope).length ? 'true' : 'false', QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL: new Date(Date.now()+60000).toISOString(), ...scope } });
    const logs=[]; f.app.log.info = data => { if (data.event === 'QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC') logs.push(data); };
    await f.app.inject({url:'/v1/commerce/eligibility',headers:f.headers()});
    assert.equal(logs.length,0);
  });
}

test('diagnostic fixed expiry, restart expiry, cap, concurrency, route scope and no untrusted strings', async () => {
  let now=1000000, tick=0, calls=0; const logs=[];
  const env={NODE_ENV:'development', ENTORNO:'qa', QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED:'true', QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL:new Date(now+60000).toISOString()};
  const app={initialConfig:{trustProxy:buildTrustProxy('true')}, log:{info:x=>logs.push(x)}, authenticate:async (r,_reply,opts)=>{ assert.equal(opts.readOnly,true); calls++; r.auth={sub:USER}; }};
  const config={ips:[IP],proxies:['10.0.0.2']};
  const request={method:'GET',routeOptions:{url:'/v1/commerce/eligibility'},cookies:{mf_session:'synthetic'},raw:{socket:{remoteAddress:'10.0.0.2'}},ip:IP,ips:['10.0.0.2',IP], id:USER};
  const create=()=>createQaCommerceDiagnostic(app,config,env,()=>now,()=>tick);
  const diag=create();
  await diag({...request,method:'POST'},'ELIGIBLE');
  await diag({...request,routeOptions:{url:'/other'}},'ELIGIBLE');
  await diag({...request,cookies:{}},'ELIGIBLE');
  assert.equal(calls,0);
  await Promise.all(Array.from({length:10},()=>diag(request,'untrusted-secret')));
  assert.equal(calls,5); assert.equal(logs.length,5);
  assert.equal(logs[0].requestId,'[request masked]'); assert.equal(logs[0].reason,'UNKNOWN');
  now+=60000; await create()(request,'ELIGIBLE'); assert.equal(calls,5);
  now=1000000; const monotonicDiag=create(); tick=600000; await monotonicDiag(request,'ELIGIBLE'); assert.equal(calls,5);
  tick=0; env.QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL=new Date(now+600001).toISOString(); await create()(request,'ELIGIBLE'); assert.equal(calls,5);
  for (const scope of [{NODE_ENV:'production',ENTORNO:'qa'},{NODE_ENV:'development',ENTORNO:'production'}]) {
    env.QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL=new Date(now+60000).toISOString();
    await createQaCommerceDiagnostic(app,config,{...env,...scope},()=>now,()=>tick)(request,'ELIGIBLE');
  }
  assert.equal(calls,5);
});

for (const mode of ['active','expired','idle','revoked']) test('diagnostic read-only session validator: '+mode, async t => {
  const f=await fixture(t); const sqls=[];
  f.app.db.query=async sql=> {sqls.push(sql); return {rows:[{estado:mode==='revoked'?'revocada':'activa', ultimo_uso_at:new Date(mode==='idle'?0:Date.now()),expira_at:new Date(mode==='expired'?0:Date.now()+60000)}]};};
  const r=await validateActiveSession(f.app,{log:{warn(){},error(){}}},{id_usuario:USER,sid:USER,jti:OTHER},{readOnly:true});
  assert.equal(r.ok,mode==='active'); assert.equal(sqls.length,1); assert.match(sqls[0],/SELECT/);
});

test('QA diagnostic observes real chains and spoofing without granting VIP or Sale', async t => {
  const f=await fixture(t,{env:{NODE_ENV:'development',ENTORNO:'qa',PRIVATE_COMMERCE_PROXY_IPS:'10.0.0.2',QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED:'true',QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL:new Date(Date.now()+60000).toISOString()}});
  const logs=[]; f.app.log.info=data=>{if(data.event==='QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC')logs.push(data);};
  for (const [peer,xff,reason,length] of [['10.0.0.2',IP,'ELIGIBLE',2],['10.0.0.2',null,'PROXY_CHAIN_LENGTH',1],['198.51.100.2',IP,'PROXY_PEER_NOT_ALLOWED',1],['10.0.0.2',IP+', 198.51.100.2','CLIENT_IP_NOT_ALLOWED',2]]) {
    const headers=f.headers(); if(xff)headers['x-forwarded-for']=xff;
    const r=await f.app.inject({url:'/v1/commerce/eligibility',remoteAddress:peer,headers});
    assert.deepEqual(r.json().data,{booking:reason==='ELIGIBLE',vipPurchase:false});
    assert.equal(logs.at(-1).reason,reason); assert.equal(logs.at(-1).ipsLength,length);
  }
  for(const url of ['/v1/public/pagos/pixelpay/sale','/v1/cliente/planes/orden']) {
    const r=await f.app.inject({method:'POST',url,remoteAddress:'10.0.0.2',headers:{...f.headers(),'x-forwarded-for':IP},payload:{}});
    assert.equal(r.statusCode,403);
  }
  assert.equal(logs.length,4); assert.equal(f.state.business,0); assert.equal(f.state.unexpectedSql,0);
});

test('revoked session emits no QA diagnostic even with pilot off', async t=>{
  const f=await fixture(t,{revoked:true,env:{NODE_ENV:'development',ENTORNO:'qa',PRIVATE_COMMERCE_PILOT_ENABLED:'false',QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED:'true',QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL:new Date(Date.now()+60000).toISOString()}});
  const logs=[]; f.app.log.info=data=>{if(data.event==='QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC')logs.push(data);};
  const r=await f.app.inject({url:'/v1/commerce/eligibility',headers:f.headers()});
  assert.deepEqual(r.json().data,{booking:false,vipPurchase:false}); assert.equal(logs.length,0);
});

const QA_BOOKING_IDENTITY = { ...QA_SDK, PIXELPAY_ENDPOINT: 'https://pixelpay.dev', PIXELPAY_APP_URL: 'https://pixelpay.dev',
  QA_PRIVATE_COMMERCE_BOOKING_ENABLED: 'true', QA_PRIVATE_COMMERCE_USER_ID: USER,
  PRIVATE_COMMERCE_PILOT_ENABLED: 'false', PRIVATE_COMMERCE_USER_IDS: undefined, PRIVATE_COMMERCE_IPS: undefined,
  PRIVATE_COMMERCE_PROXY_IPS: undefined, QA_PRIVATE_COMMERCE_SALE_ENABLED: 'false' };

test('QA identity booking defaults closed and rejects unsafe startup configuration', () => {
  assert.equal(resolveQaSandboxBookingConfig({}).enabled, false);
  assert.deepEqual(resolveQaSandboxBookingConfig(QA_BOOKING_IDENTITY).userIds, [USER]);
  for (const patch of [
    { QA_PRIVATE_COMMERCE_BOOKING_ENABLED:'yes' }, { QA_PRIVATE_COMMERCE_USER_ID:'' },
    { QA_PRIVATE_COMMERCE_USER_ID:USER+','+OTHER }, { QA_PRIVATE_COMMERCE_USER_ID:'external-provider-id' },
    { NODE_ENV:'production' }, { NODE_ENV:'staging' }, { ENTORNO:'production' },
    { PIXELPAY_ENV:'live' }, { PIXELPAY_ENDPOINT:'https://pixelpay.app' }, { PIXELPAY_APP_URL:'https://pixelpay.app' },
    { PAYMENT_PROVIDER:'todopago' }, { PIXELPAY_IMPLEMENTATION:'direct' },
    { PRIVATE_COMMERCE_PILOT_ENABLED:'true' }, { QA_PRIVATE_COMMERCE_SALE_ENABLED:'true' },
    { ENABLE_QA_PAYMENT_SIMULATION:'true' }, { ENABLE_QA_VIP_PURCHASE_SIMULATION:'true' },
  ]) assert.throws(()=>resolveQaSandboxBookingConfig({...QA_BOOKING_IDENTITY,...patch}));
});

test('QA identity booking grants only verified owner, independently of TCP and forwarded headers', async t => {
  const f=await fixture(t,{env:QA_BOOKING_IDENTITY});
  for(const [remoteAddress,extra] of [
    ['198.51.100.23',{}], ['10.0.0.99',{'x-forwarded-for':'invalid'}],
    ['10.0.0.99',{'x-forwarded-for':'192.0.2.99, 198.51.100.42','x-real-ip':'192.0.2.100',forwarded:'for=192.0.2.1'}],
  ]) {
    const headers={...f.headers(),...extra};
    const r=await f.app.inject({url:'/v1/commerce/eligibility',remoteAddress,headers});
    assert.equal(r.statusCode,200); assert.deepEqual(r.json().data,{booking:true,vipPurchase:false,pixelpaySale:false});
    for(const url of ['/v1/public/citas/hold','/v1/citas/hold','/v1/public/pagos/crear-intent','/v1/pagos/reservas/crear-intent','/v1/public/pagos/estado','/v1/pagos/reservas/estado']) {
      const invalid=await f.app.inject({method:'POST',url,remoteAddress,headers,payload:{}});
      assert.equal(invalid.statusCode,400,url+': original input validation remains');
    }
    for(const url of ['/v1/public/pagos/pixelpay/sale','/v1/pagos/reservas/pixelpay/sale','/v1/pagos/crear-intent',
      '/v1/cliente/planes/orden','/v1/cliente/planes/pago-intent','/v1/cliente/planes/adquirir',
      '/v1/cliente/planes/pago-intent/'+OTHER+'/estado','/v1/public/pagos/simulator/event','/v1/public/pagos/mock-completar',
      '/v1/admin/citas/hold','/v1/citas/probe']) {
      const denied=await f.app.inject({method:'POST',url,remoteAddress,headers,payload:{}});
      assert.equal(denied.statusCode,403,url+': original guard must reject before handler');
    }
  }
  assert.deepEqual(f.state,{business:0,unexpectedSql:0});
});

for(const scenario of ['guest','other','tampered','revoked','no-client','invalid-client','no-role','identity-mismatch','inactive-user','csrf-missing','csrf-wrong','admin-mode']) {
  test('QA identity booking rejects '+scenario, async t=>{
    const f=await fixture(t,{env:QA_BOOKING_IDENTITY,revoked:scenario==='revoked',clientId:scenario==='no-client'?null:scenario==='invalid-client'?'invalid':OTHER,
      roles:scenario==='no-role'?['super_admin']:['cliente'], claimsMismatch:scenario==='identity-mismatch',noClaims:scenario==='inactive-user',config:scenario==='admin-mode'?{adminDataEntryMode:true}:{}});
    const headers=scenario==='guest'?{}:f.headers(scenario==='other'?OTHER:USER);
    if(scenario==='tampered')headers.cookie+='tampered';
    if(scenario==='csrf-missing')delete headers['x-csrf-token'];
    if(scenario==='csrf-wrong')headers['x-csrf-token']='wrong';
    Object.assign(headers,{'x-forwarded-for':IP,'x-real-ip':IP,'x-user-id':USER});
    const denied=await f.app.inject({method:'POST',url:'/v1/public/citas/hold',remoteAddress:'10.0.0.99',headers,payload:{}});
    assert.ok([401,403].includes(denied.statusCode),denied.body);
    if(!scenario.startsWith('csrf-')) {
      const r=await f.app.inject({url:'/v1/commerce/eligibility',remoteAddress:'10.0.0.99',headers});
      if(r.statusCode===200)assert.deepEqual(r.json().data,{booking:false,vipPurchase:false,pixelpaySale:false});
      else assert.equal(r.statusCode,401);
    }
    assert.deepEqual(f.state,{business:0,unexpectedSql:0});
  });
}

test('QA identity rollback returns to closed legacy mode and preserves default response shape', async t=>{
  const f=await fixture(t,{env:{...QA_BOOKING_IDENTITY,QA_PRIVATE_COMMERCE_BOOKING_ENABLED:'false'}});
  const r=await f.app.inject({url:'/v1/commerce/eligibility',headers:f.headers()});
  assert.deepEqual(r.json().data,{booking:false,vipPurchase:false});
});
