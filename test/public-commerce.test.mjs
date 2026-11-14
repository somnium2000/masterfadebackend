import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "jsonwebtoken";
import auth from "../src/plugins/auth.js";
import gate, { resolvePublicCommerceConfig } from "../src/plugins/privateCommerce.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const SECRET = crypto.randomBytes(40).toString("hex");
const BOOKING = [
  "/v1/citas/hold", "/v1/citas/hold/:id_grupo_cita/confirmar", "/v1/citas/pendiente/:id_grupo_cita/retomar",
  "/v1/pagos/reservas/crear-intent", "/v1/pagos/reservas/pixelpay/sale",
  "/v1/pagos/reservas/pixelpay/status", "/v1/pagos/reservas/estado", "/v1/public/citas/validar-contactos",
];
const VIP = ["/v1/cliente/planes/orden", "/v1/cliente/planes/pago-intent", "/v1/cliente/planes/confirmar-pago",
  "/v1/cliente/planes/pago-intent/:id_payment_intent/estado"];
const CLOSED = ["/v1/public/citas/hold", "/v1/public/pagos/crear-intent", "/v1/public/pagos/pixelpay/sale",
  "/v1/public/pagos/mock-completar", "/v1/public/pagos/simulator/event", "/v1/pagos/reservas/mock-completar",
  "/v1/cliente/planes/simulator/event", "/v1/admin/citas/hold", "/v1/admin/membresias/clientes/:id_cliente/asignar",
  "/v1/citas", "/v1/citas/probe"];
const actual = path => path.replace(/:[a-z_]+/g, CLIENT);

async function fixture(t, options = {}) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const app = Fastify();
  const state = { admitted: 0, identityReads: 0 };
  app.decorate("db", { query: async (sql, params) => {
    if (sql.includes("FROM public.seguridad_sesiones")) return { rows: options.revoked ? [] : [{
      estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 60000),
    }] };
    if (sql.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (sql.includes("WITH base_user")) return { rows: [{ id_usuario: params[0], id_persona: PERSON,
      cliente_id: options.missingClient ? null : CLIENT, roles: options.roles || ["cliente"] }] };
    if (sql.includes("SELECT c.id_cliente")) {
      state.identityReads++;
      assert.deepEqual(params, [CLIENT, USER, PERSON]);
      return { rows: options.inactive ? [] : [{ id_cliente: CLIENT }] };
    }
    throw new Error("Unexpected database query");
  } });
  await app.register(fp(async a => a.decorate("config", {
    paymentProvider: options.provider || "pixelpay", adminDataEntryMode: options.adminMode === true,
    publicCommerce: { bookingEnabled: options.booking === true, vipPurchaseEnabled: options.vip === true },
    privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] },
  }), { name: "env-plugin" }));
  await app.register(cookie);
  await app.register(auth);
  await app.register(gate);
  for (const path of [...BOOKING, ...VIP, ...CLOSED]) app.post(path, async () => { state.admitted++; return { admitted: true }; });
  app.post("/v1/pagos/webhook/:proveedor", async () => ({ callbackGuardReached: true }));
  app.post("/v1/cliente/pagos/:id_intent/conciliar", { preHandler: app.requireRoles(["cliente"]) },
    async () => ({ recoveryGuardReached: true }));
  t.after(() => app.close());
  const token = jwt.sign({ sub: USER, sid: PERSON, jti: CLIENT, token_type: "app" }, SECRET,
    { issuer: "masterfade-api", audience: "masterfade-app", expiresIn: "1h" });
  const headers = { cookie: `mf_session=${token}; mf_csrf=synthetic-csrf`, "x-csrf-token": "synthetic-csrf" };
  return { app, state, headers };
}

test("public flags are independent, strict and disabled by default", () => {
  assert.deepEqual(resolvePublicCommerceConfig({}), { bookingEnabled: false, vipPurchaseEnabled: false });
  assert.deepEqual(resolvePublicCommerceConfig({ PUBLIC_BOOKING_ENABLED: "true" }),
    { bookingEnabled: true, vipPurchaseEnabled: false });
  assert.deepEqual(resolvePublicCommerceConfig({ PUBLIC_VIP_PURCHASE_ENABLED: "true" }),
    { bookingEnabled: false, vipPurchaseEnabled: true });
  for (const key of ["PUBLIC_BOOKING_ENABLED", "PUBLIC_VIP_PURCHASE_ENABLED"]) {
    for (const value of ["1", "yes", "enabled", "invalid"]) assert.throws(() => resolvePublicCommerceConfig({ [key]: value }), new RegExp(key));
  }
});

test("visitors discover public booking but cannot mutate without a client session", async t => {
  const f = await fixture(t, { booking: true });
  const response = await f.app.inject({ url: "/v1/commerce/eligibility" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, { booking: false, vipPurchase: false, publicBooking: true, publicVipPurchase: false });
  assert.match(response.headers["cache-control"], /no-store/);
  for (const path of BOOKING) assert.equal((await f.app.inject({ method: "POST", url: actual(path), payload: {} })).statusCode, 403);
  assert.deepEqual(f.state, { admitted: 0, identityReads: 0 });
});

test("booking opens only the exact authenticated flow, with no pilot or allowed IP", async t => {
  const f = await fixture(t, { booking: true });
  const response = await f.app.inject({ url: "/v1/commerce/eligibility", headers: f.headers, remoteAddress: "198.51.100.99" });
  assert.deepEqual(response.json().data, { booking: true, vipPurchase: false, publicBooking: true, publicVipPurchase: false });
  for (const path of BOOKING) {
    const result = await f.app.inject({ method: "POST", url: actual(path), headers: f.headers, payload: {}, remoteAddress: "198.51.100.99" });
    assert.equal(result.statusCode, 200, `${path}: ${result.body}`);
  }
  for (const path of [...VIP, ...CLOSED]) {
    const result = await f.app.inject({ method: "POST", url: actual(path), headers: f.headers, payload: {} });
    assert.equal(result.statusCode, 403, `${path}: ${result.body}`);
  }
  assert.equal(f.state.admitted, BOOKING.length);
});

test("VIP is independent of public booking and never grants booking or admin routes", async t => {
  const f = await fixture(t, { vip: true });
  const response = await f.app.inject({ url: "/v1/commerce/eligibility", headers: f.headers });
  assert.deepEqual(response.json().data, { booking: false, vipPurchase: true, publicBooking: false, publicVipPurchase: true });
  for (const path of VIP) assert.equal((await f.app.inject({ method: "POST", url: actual(path), headers: f.headers, payload: {} })).statusCode, 200);
  for (const path of [...BOOKING, ...CLOSED]) assert.equal((await f.app.inject({ method: "POST", url: actual(path), headers: f.headers, payload: {} })).statusCode, 403);
});

for (const [name, options, expected] of [
  ["disabled", {}, 403], ["revoked", { booking: true, revoked: true }, 401],
  ["wrong role", { booking: true, roles: ["super_admin"] }, 403],
  ["unlinked client", { booking: true, missingClient: true }, 403],
  ["inactive client", { booking: true, inactive: true }, 403],
]) {
  test(`public booking denies ${name} before its business handler`, async t => {
    const f = await fixture(t, options);
    const response = await f.app.inject({ method: "POST", url: "/v1/citas/hold", headers: f.headers, payload: {} });
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(f.state.admitted, 0);
  });
}

test("public admission preserves CSRF and invalid JWT rejection", async t => {
  const f = await fixture(t, { booking: true });
  const csrf = await f.app.inject({ method: "POST", url: "/v1/citas/hold", headers: { ...f.headers, "x-csrf-token": "other" }, payload: {} });
  assert.equal(csrf.statusCode, 403, csrf.body);
  assert.equal(csrf.json().error.code, "CSRF_TOKEN_INVALID");
  const invalid = await f.app.inject({ method: "POST", url: "/v1/citas/hold",
    headers: { ...f.headers, cookie: f.headers.cookie.replace("mf_session=", "mf_session=tampered") }, payload: {} });
  assert.equal(invalid.statusCode, 401, invalid.body);
  assert.equal(f.state.admitted, 0);
});

for (const options of [{ provider: "mock" }, { provider: "todopago" }, { provider: "disabled" }, { adminMode: true }]) {
  test(`public flags cannot open incompatible provider/mode ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, { booking: true, vip: true, ...options });
    const response = await f.app.inject({ url: "/v1/commerce/eligibility" });
    assert.deepEqual(response.json().data, { booking: false, vipPurchase: false, publicBooking: false, publicVipPurchase: false });
    assert.equal((await f.app.inject({ method: "POST", url: "/v1/citas/hold", headers: f.headers, payload: {} })).statusCode, 403);
    assert.equal(f.state.admitted, 0);
  });
}

test("rolling public flags off does not block callbacks or the independent recovery router", async t => {
  const f = await fixture(t);
  const callback = await f.app.inject({ method: "POST", url: "/v1/pagos/webhook/pixelpay", payload: {} });
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.json().callbackGuardReached, true);
  const recovery = await f.app.inject({ method: "POST", url: `/v1/cliente/pagos/${CLIENT}/conciliar`, headers: f.headers, payload: {} });
  assert.equal(recovery.statusCode, 200);
  assert.equal(recovery.json().recoveryGuardReached, true);
  assert.equal(f.state.admitted, 0);
});
