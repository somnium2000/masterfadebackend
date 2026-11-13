import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import auth from "../src/plugins/auth.js";
import privateCommerce from "../src/plugins/privateCommerce.js";
import { buildTrustProxy } from "../src/utils/trustProxy.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const IP = "203.0.113.10";
const PROXY = "10.0.0.2";
const SECRET = randomBytes(40).toString("hex");
const previousSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = SECRET; });
after(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

async function fixture(t, diagnosticFlag, options = {}) {
  const logs = [];
  const state = { sessionChecks: 0, claimsReads: 0, business: 0 };
  const app = Fastify({
    trustProxy: buildTrustProxy("true"),
    genReqId: () => "req-eligibility-test",
    logger: { stream: { write(line) {
      const entry = JSON.parse(line);
      if (entry.privateCommerceEligibility) logs.push(entry);
    } } },
  });
  t.after(() => app.close());
  app.decorate("db", { query: async (sql, params) => {
    if (sql.includes("FROM public.seguridad_sesiones")) {
      state.sessionChecks++;
      return { rows: options.revoked ? [] : [{ estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 60000) }] };
    }
    if (sql.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (sql.includes("WITH base_user")) {
      state.claimsReads++;
      return { rows: options.missingClaims ? [] : [{
        id_usuario: options.claimsSubject || params[0],
        cliente_id: options.clientId === undefined ? CLIENT : options.clientId,
        roles: options.roles || ["cliente"],
      }] };
    }
    throw new Error("Unexpected database operation");
  } });
  await app.register(fp(async a => a.decorate("config", {
    adminDataEntryMode: false, paymentProvider: "pixelpay",
    privateCommercePilot: { enabled: true, userIds: [USER], ips: [IP], proxies: [PROXY], ...options.pilot },
    ...options.config,
  }), { name: "env-plugin" }));
  await app.register(cookie);
  await app.register(auth);
  if (options.authThrows) app.authenticate = async () => { throw new Error("synthetic-auth-error"); };
  if (options.loggerFails) app.addHook("onRequest", async request => {
    const info = request.log.info.bind(request.log);
    request.log.info = (data, ...args) => {
      if (data?.privateCommerceEligibility) throw new Error("synthetic-logger-error");
      return info(data, ...args);
    };
  });
  const previousFlag = process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED;
  try {
    if (diagnosticFlag === undefined) delete process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED;
    else process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED = diagnosticFlag;
    await app.register(privateCommerce);
    app.post("/v1/citas/probe", async () => { state.business++; return { ok: true }; });
    app.get("/v1/health", async () => ({ ok: true }));
    await app.ready();
  } finally {
    if (previousFlag === undefined) delete process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED;
    else process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED = previousFlag;
  }
  const token = jwt.sign({ sub: options.userId || USER, sid: USER, jti: OTHER, token_type: "app" }, SECRET, {
    issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
    audience: process.env.APP_JWT_AUDIENCE || "masterfade-app", expiresIn: "1h",
  });
  const headers = {
    "x-forwarded-for": IP,
    cookie: `mf_session=${token}; mf_csrf=synthetic-csrf`,
    "x-csrf-token": "synthetic-csrf",
    ...options.headers,
  };
  if (options.noCookie) delete headers.cookie;
  if (options.noCsrf) delete headers["x-csrf-token"];
  const response = await app.inject({
    url: "/v1/commerce/eligibility", remoteAddress: PROXY, headers, ...options.request,
  });
  return { app, logs, state, response, token };
}

const scenarios = [
  { name: "allowed proxy", reason: "ALLOWED", allowed: true, authenticated: true },
  { name: "pilot disabled", pilot: { enabled: false }, reason: "PILOT_DISABLED" },
  { name: "first failure wins", pilot: { enabled: false }, config: { adminDataEntryMode: true, paymentProvider: "disabled" },
    noCookie: true, request: { remoteAddress: "198.51.100.2" }, reason: "PILOT_DISABLED" },
  { name: "administrative mode", config: { adminDataEntryMode: true }, reason: "ADMIN_DATA_ENTRY_MODE" },
  { name: "wrong provider", config: { paymentProvider: "disabled" }, reason: "PAYMENT_PROVIDER_NOT_PIXELPAY" },
  { name: "different internal TCP peer", request: { remoteAddress: "10.0.0.3" }, reason: "PROXY_PEER_NOT_ALLOWED" },
  { name: "public TCP peer with forged XFF", request: { remoteAddress: "198.51.100.2" }, reason: "PROXY_PEER_NOT_ALLOWED" },
  { name: "missing forwarded hop", headers: { "x-forwarded-for": "" }, reason: "PROXY_HOP_COUNT_INVALID" },
  { name: "wrong resolved client IP", headers: { "x-forwarded-for": "198.51.100.2" }, reason: "CLIENT_IP_NOT_ALLOWED" },
  { name: "forged leftmost IP", headers: { "x-forwarded-for": `${IP}, 198.51.100.2` }, reason: "CLIENT_IP_NOT_ALLOWED" },
  { name: "direct wrong IP", pilot: { proxies: [] }, reason: "DIRECT_IP_NOT_ALLOWED" },
  { name: "direct allowed IP", pilot: { proxies: [] }, request: { remoteAddress: IP }, reason: "ALLOWED", allowed: true, authenticated: true },
  { name: "IPv4 mapped peer", request: { remoteAddress: `::ffff:${PROXY}` }, reason: "ALLOWED", allowed: true, authenticated: true },
  { name: "cookie absent", noCookie: true, reason: "SESSION_COOKIE_MISSING" },
  { name: "invalid token", headers: { cookie: "mf_session=synthetic-invalid-token" }, reason: "AUTH_GUARD_REPLIED", status: 401 },
  { name: "revoked session", revoked: true, reason: "AUTH_GUARD_REPLIED", status: 401 },
  { name: "claims absent", missingClaims: true, reason: "AUTH_GUARD_REPLIED", status: 401 },
  { name: "auth error", authThrows: true, reason: "AUTH_VERIFICATION_ERROR", status: 500 },
  { name: "different UUID", userId: OTHER, reason: "USER_UUID_NOT_ALLOWED", authenticated: true },
  { name: "claims subject mismatch", claimsSubject: OTHER, reason: "CLAIMS_SUBJECT_MISMATCH", authenticated: true },
  { name: "inactive or missing client", clientId: null, reason: "ACTIVE_CLIENT_NOT_RESOLVED", authenticated: true },
  { name: "invalid client identity", clientId: "invalid-client", reason: "ACTIVE_CLIENT_NOT_RESOLVED", authenticated: true },
  { name: "client role absent", roles: ["admin"], reason: "CLIENT_ROLE_MISSING", authenticated: true },
];

test("diagnostics preserve HTTP results and auth work for every eligibility branch", async t => {
  for (const scenario of scenarios) await t.test(scenario.name, async sub => {
    const off = await fixture(sub, "false", scenario);
    const on = await fixture(sub, "true", scenario);
    assert.equal(on.response.statusCode, scenario.status || 200);
    if (!scenario.status) assert.deepEqual(on.response.json().data, {
      booking: scenario.allowed === true, vipPurchase: scenario.allowed === true,
    });
    assert.equal(on.response.statusCode, off.response.statusCode);
    assert.equal(on.response.body, off.response.body);
    assert.equal(on.response.headers["cache-control"], off.response.headers["cache-control"]);
    assert.deepEqual(on.state, off.state);
    assert.equal(off.logs.length, 0);
    assert.equal(on.logs.length, 1);
    assert.equal(on.logs[0].privateCommerceEligibility.reason, scenario.reason);
    assert.equal(on.logs[0].privateCommerceEligibility.identity_evaluated, scenario.authenticated === true);
    assert.equal(on.state.business, 0);
  });
});

test("diagnostics are disabled by default and only the server flag true enables them", async t => {
  for (const value of [undefined, "false", "1", "yes", "TRUE", ""]) {
    const f = await fixture(t, value, {
      request: { url: "/v1/commerce/eligibility?PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED=true" },
      headers: { "x-private-commerce-diagnostics-enabled": "true" },
    });
    assert.equal(f.logs.length, 0);
    assert.deepEqual(f.response.json().data, { booking: true, vipPurchase: true });
  }
});

test("diagnostics whitelist IPs, counts, booleans and a fixed reason without sensitive data", async t => {
  const f = await fixture(t, "true", { headers: {
    authorization: "Bearer synthetic-authorization-secret",
    "x-user-id": "synthetic-forged-user", "x-real-ip": "synthetic-untrusted-ip",
  } });
  assert.deepEqual(f.logs[0].privateCommerceEligibility, {
    reason: "ALLOWED", tcp_peer: PROXY, request_ip: IP, request_ips_count: 2,
    proxy_peer_allowed: true, tcp_peer_ip_allowed: false, request_ip_allowed: true,
    session_cookie_present: true, identity_evaluated: true, user_uuid_allowed: true,
    claims_subject_matches: true, active_client_resolved: true, client_role_present: true,
  });
  const serialized = JSON.stringify(f.logs);
  for (const sensitive of [f.token, SECRET, USER, OTHER, CLIENT, "synthetic-csrf", "synthetic-authorization-secret", "synthetic-forged-user", "synthetic-untrusted-ip"]) {
    assert.equal(serialized.includes(sensitive), false);
  }
  assert.deepEqual(f.response.json(), { ok: true, data: { booking: true, vipPurchase: true } });
});

test("rejected peer logs network mismatch without authenticating or guessing identity", async t => {
  const f = await fixture(t, "true", { request: { remoteAddress: "10.0.0.3" } });
  assert.deepEqual(f.logs[0].privateCommerceEligibility, {
    reason: "PROXY_PEER_NOT_ALLOWED", tcp_peer: "10.0.0.3", request_ip: IP, request_ips_count: 2,
    proxy_peer_allowed: false, tcp_peer_ip_allowed: false, request_ip_allowed: true,
    session_cookie_present: true, identity_evaluated: false, user_uuid_allowed: false,
    claims_subject_matches: false, active_client_resolved: false, client_role_present: false,
  });
  assert.deepEqual(f.state, { sessionChecks: 0, claimsReads: 0, business: 0 });
});

test("invalid resolved IPs cannot inject header content into diagnostic logs", async t => {
  for (const value of ["synthetic-secret-not-an-ip", "fe80::1%synthetic-secret-zone"]) {
    const f = await fixture(t, "true", { headers: { "x-forwarded-for": value } });
    assert.equal(f.logs[0].privateCommerceEligibility.reason, "CLIENT_IP_NOT_ALLOWED");
    assert.equal(f.logs[0].privateCommerceEligibility.request_ip, null);
    assert.equal(JSON.stringify(f.logs).includes(value), false);
  }
});

test("diagnostics do not observe unrelated endpoints or request bodies", async t => {
  const health = await fixture(t, "true", { request: { url: "/v1/health" } });
  assert.equal(health.logs.length, 0);
  assert.deepEqual(health.state, { sessionChecks: 0, claimsReads: 0, business: 0 });
  const body = { card: { number: "synthetic-pan-marker", cvv: "synthetic-cvv-marker" }, secret: "synthetic-body-secret" };
  const f = await fixture(t, "true", { request: { method: "POST", url: "/v1/citas/probe", payload: body } });
  assert.equal(f.response.statusCode, 200);
  assert.equal(f.logs.length, 1);
  for (const value of [body.card.number, body.card.cvv, body.secret]) assert.equal(JSON.stringify(f.logs).includes(value), false);
});

test("logger failures preserve both grants and rejections including auth responses", async t => {
  for (const scenario of [{}, { request: { remoteAddress: "10.0.0.3" } }, { revoked: true }]) {
    const normal = await fixture(t, "false", scenario);
    const broken = await fixture(t, "true", { ...scenario, loggerFails: true });
    assert.equal(broken.response.statusCode, normal.response.statusCode);
    assert.equal(broken.response.body, normal.response.body);
    assert.deepEqual(broken.state, normal.state);
    assert.equal(broken.logs.length, 0);
  }
});

test("protected mutations retain CSRF and account guards with diagnostics enabled", async t => {
  for (const [options, status, business, reason] of [
    [{}, 200, 1, "ALLOWED"],
    [{ noCsrf: true }, 403, 0, "ALLOWED"],
    [{ userId: OTHER }, 403, 0, "USER_UUID_NOT_ALLOWED"],
  ]) {
    const f = await fixture(t, "true", { ...options, request: { method: "POST", url: "/v1/citas/probe" } });
    assert.equal(f.response.statusCode, status);
    assert.equal(f.state.business, business);
    assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0].privateCommerceEligibility.reason, reason);
    if (options.noCsrf) assert.equal(f.response.json().error.code, "CSRF_TOKEN_INVALID");
    assert.equal(f.response.body.includes("privateCommerceEligibility"), false);
  }
});
