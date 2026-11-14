import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import security from "../src/plugins/security.js";
import auth from "../src/plugins/auth.js";
import privateCommerce from "../src/plugins/privateCommerce.js";
import recovery from "../src/routes/v1/paymentRecovery.js";
import publicPayments from "../src/routes/v1/public/pagos.js";
import publicCitas from "../src/routes/v1/public/citas.js";
import cliente from "../src/routes/v1/cliente.js";
import payments from "../src/routes/v1/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const ids = Object.fromEntries(["user", "person", "client", "intent", "group", "cita", "hold", "provider", "other"]
  .map((key, index) => [key, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
const secret = crypto.randomBytes(40).toString("hex");
const baseUrl = `/v1/cliente/pagos/${ids.intent}`;

async function fixture(t, options = {}) {
  const previous = { JWT_SECRET: process.env.JWT_SECRET, CSRF_SECRET: process.env.CSRF_SECRET };
  process.env.JWT_SECRET = secret;
  process.env.CSRF_SECRET = secret;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const state = { accountQueries: 0, ownershipQueries: 0, recoveryQueries: 0,
    connections: 0, releases: 0, providerInitializations: 0, sql: [] };
  const intent = { id_intent: ids.intent, id_provider: ids.provider, id_cita: ids.cita,
    id_hold: ids.hold, id_grupo_cita: options.membership ? null : ids.group, id_membership_order: options.membership ? ids.other : null,
    origen_pago_codigo: options.membership ? "membership" : "cita", origen_codigo: "cliente_autenticado",
    estado_intent_codigo: "pendiente_confirmacion",
    monto_hnl: "1.00", moneda_codigo: "HNL", paid_at: null, expires_at: "2099-01-01T00:00:00Z",
    created_by_usuario_id: ids.user,
    provider_session_id: "S-synthetic-existing", referencia_externa: "synthetic-acquirer-transaction",
    provider_code: options.wrongProvider ? "todopago" : "pixelpay", titular_email: "existing@example.invalid",
    id_cliente_titular: options.otherOwner ? ids.other : ids.client,
    id_persona_titular: ids.person, id_usuario_titular: ids.user,
    membership_cliente_id: options.otherOwner ? ids.other : ids.client, membership_usuario_id: ids.user,
    direccion_correo: "existing@example.invalid",
    ...(options.mismatchedOwnerField ? { [options.mismatchedOwnerField]: ids.other } : {}) };
  const group = { id_grupo_cita: ids.group, estado_grupo_codigo: "cancelado", origen_codigo: "cliente_autenticado",
    id_cliente_titular: ids.client, id_persona_titular: ids.person, id_usuario_titular: ids.user,
    id_cita: ids.cita, orden_integrante: 1, estado_cita_codigo: "expirada", total_pagar_hnl: "1.00",
    id_hold: ids.hold, estado_hold_codigo: "expirado", expires_at: "2099-01-01T00:00:00Z",
    id_persona_cliente: ids.person, cita_cliente_id: ids.client, contacto_email: "existing@example.invalid",
    primary_email_count: "1", direccion_correo: "existing@example.invalid" };
  const query = async (sql, params = []) => {
    const text = String(sql?.text || sql);
    if (text.includes("FROM public.seguridad_sesiones")) return { rows: options.revoked ? []
      : [{ estado: "activa", ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 600000) }] };
    if (text.includes("UPDATE public.seguridad_sesiones")) return { rows: [] };
    if (text.includes("WITH base_user")) return { rows: [{ id_usuario: ids.user, id_persona: options.missingPerson ? null : ids.person,
      cliente_id: options.missingClient ? null : ids.client, roles: options.roles || ["cliente"] }] };
    state.sql.push({ text, params });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    if (text.includes("AS deletion_identity_lock")) return { rows: [{ deletion_identity_lock: true }] };
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("WITH approved_attempts AS") || text.includes("WITH valid_membership_events AS")) {
      state.recoveryQueries++;
      return { rows: [] };
    }
    if (text.includes("FROM public.citas_grupos cg") && text.includes("primary_email_count")) return { rows: [group] };
    if (text.includes("FOR UPDATE OF h")) return { rows: [{ id_hold: ids.hold, id_cita: ids.cita,
      estado_hold_codigo: "expirado", expires_at: group.expires_at }] };
    if (text.includes("FOR UPDATE OF c")) return { rows: [{ id_cita: ids.cita }] };
    if (text.includes("SELECT id_grupo_cita FROM public.citas_grupos")) return { rows: [{ id_grupo_cita: ids.group }] };
    if (text.includes("FROM public.payment_intents pi") && text.includes("FOR UPDATE OF pi")) return { rows: [intent] };
    if (text.includes("FROM public.clientes c")) {
      state.accountQueries++;
      return { rows: options.inactiveClient || (options.accountUnavailableDuringRecovery && state.accountQueries > 1) ? []
        : [{ id_cliente: ids.client, id_persona: ids.person, id_usuario: ids.user }] };
    }
    if (text.includes("FROM public.payment_intents")) {
      state.ownershipQueries++;
      return { rows: options.unknownIntent ? [] : [intent] };
    }
    throw new Error(`Unexpected fixture query: ${text}`);
  };
  const db = { query, async connect() {
    state.connections++;
    return { query, release() { state.releases++; } };
  } };
  const app = Fastify();
  app.decorate("db", db);
  await app.register(fp(async a => a.decorate("config", { paymentProvider: "pixelpay", adminDataEntryMode: false,
    privateCommercePilot: { enabled: false, userIds: [], ips: [], proxies: [] } }), { name: "env-plugin" }));
  await app.register(security);
  await app.register(auth);
  await app.register(privateCommerce);
  await app.register(recovery, { prefix: "/v1/cliente/pagos" });
  await app.register(publicPayments, { prefix: "/v1/public/pagos" });
  await app.register(publicCitas, { prefix: "/v1/public/citas" });
  await app.register(cliente, { prefix: "/v1/cliente" });
  await app.register(payments, { prefix: "/v1/pagos" });
  const originalCreate = PaymentProviderFactory.create;
  PaymentProviderFactory.create = () => { state.providerInitializations++; throw new Error("Provider prohibited in DB-only recovery"); };
  t.after(() => { PaymentProviderFactory.create = originalCreate; });
  t.after(() => app.close());
  const token = jwt.sign({ sub: options.tokenSubject || ids.user, sid: crypto.randomUUID(), jti: crypto.randomUUID(), token_type: "app" }, secret,
    { issuer: "masterfade-api", audience: "masterfade-app", expiresIn: "1h" });
  const headers = { cookie: `mf_session=${token}; mf_csrf=synthetic-csrf`, "x-csrf-token": "synthetic-csrf" };
  return { app, state, headers };
}

test("piloto suspendido: consulta autorizada de pago existente no inicializa proveedor", async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ url: baseUrl, headers: f.headers, remoteAddress: "198.51.100.99" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.id_intent, ids.intent);
  assert.match(response.headers["cache-control"], /no-store/);
  assert.equal(f.state.providerInitializations, 0);
  assert.equal(f.state.recoveryQueries, 0);
});

for (const membership of [false, true]) {
  test(`conciliacion ${membership ? "VIP" : "reserva"} sin evidencia queda manual sin Sale ni Status`, async t => {
    const f = await fixture(t, { membership });
    const response = await f.app.inject({ method: "POST", url: `${baseUrl}/conciliar`, headers: f.headers, payload: {} });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().data.manual_reconciliation_required, true);
    assert.equal(f.state.recoveryQueries, 1);
    assert.equal(f.state.providerInitializations, 0);
    assert.equal(f.state.connections, f.state.releases);
    assert.doesNotMatch(f.state.sql.map(entry => entry.text).join("\n"), /(?:INSERT INTO|UPDATE) public\.(?:payments|subscriptions|payment_intents)/i);
  });
}

for (const [name, options, status] of [["sin sesion", {}, 401], ["sesion revocada", { revoked: true }, 401],
  ["rol ajeno", { roles: ["barbero"] }, 403], ["sin cliente", { missingClient: true }, 403],
  ["sin persona", { missingPerson: true }, 403], ["cliente inactivo", { inactiveClient: true }, 403],
  ["subject distinto de claims", { tokenSubject: ids.other }, 403]]) {
  test(`seguridad rechaza ${name} antes de consultar operaciones`, async t => {
    const f = await fixture(t, options);
    for (const method of ["GET", "POST"]) {
      const response = await f.app.inject({ method, url: method === "GET" ? baseUrl : `${baseUrl}/conciliar`,
        headers: name === "sin sesion" ? {} : f.headers, ...(method === "POST" ? { payload: {} } : {}) });
      assert.equal(response.statusCode, status, response.body);
    }
    assert.equal(f.state.ownershipQueries, 0);
    assert.equal(f.state.recoveryQueries, 0);
    assert.equal(f.state.providerInitializations, 0);
  });
}

for (const [name, token] of [["ausente", undefined], ["incorrecto", "wrong-csrf"]]) {
  test(`CSRF ${name} no permite recuperar ni consultar datos financieros`, async t => {
    const f = await fixture(t);
    const headers = { ...f.headers };
    if (token === undefined) delete headers["x-csrf-token"]; else headers["x-csrf-token"] = token;
    const response = await f.app.inject({ method: "POST", url: `${baseUrl}/conciliar`, headers, payload: {} });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "CSRF_TOKEN_INVALID");
    assert.equal(f.state.ownershipQueries, 0);
    assert.equal(f.state.recoveryQueries, 0);
  });
}

for (const [name, options] of [["operacion ajena", { otherOwner: true }], ["intent inexistente", { unknownIntent: true }],
  ["proveedor diferente", { wrongProvider: true }],
  ["persona de otro titular", { mismatchedOwnerField: "id_persona_titular" }],
  ["usuario de otro titular", { mismatchedOwnerField: "id_usuario_titular" }],
  ["creador de otro usuario", { mismatchedOwnerField: "created_by_usuario_id" }],
  ["orden VIP de otro cliente", { membership: true, mismatchedOwnerField: "membership_cliente_id" }],
  ["orden VIP de otro usuario", { membership: true, mismatchedOwnerField: "membership_usuario_id" }]]) {
  test(`consulta y recuperacion rechazan ${name}`, async t => {
    const f = await fixture(t, options);
    for (const method of ["GET", "POST"]) {
      const response = await f.app.inject({ method, url: method === "GET" ? baseUrl : `${baseUrl}/conciliar`,
        headers: f.headers, ...(method === "POST" ? { payload: {} } : {}) });
      assert.ok([403, 404].includes(response.statusCode), response.body);
    }
    assert.equal(f.state.recoveryQueries, 0);
    assert.equal(f.state.providerInitializations, 0);
  });
}

test("nuevas compras siguen bloqueadas y no se abre el prefijo financiero publico", async t => {
  const f = await fixture(t);
  for (const url of ["/v1/public/citas/hold", "/v1/public/pagos/crear-intent", "/v1/public/pagos/pixelpay/sale",
    "/v1/public/pagos/pixelpay/status", "/v1/cliente/planes/orden", "/v1/cliente/planes/pago-intent",
    "/v1/cliente/planes/confirmar-pago"]) {
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: {} });
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    assert.equal(response.json().error.code, "PRIVATE_COMMERCE_RESTRICTED");
  }
  assert.equal(f.state.ownershipQueries, 0);
  assert.equal(f.state.recoveryQueries, 0);
  assert.equal(f.state.providerInitializations, 0);
});

test("el caller no puede suministrar monto, UUID ni paid_at para conciliacion", async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: "POST", url: `${baseUrl}/conciliar`, headers: f.headers,
    payload: { amount: 1, payment_uuid: "forged", paid_at: "2026-01-01T00:00:00Z" } });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(f.state.ownershipQueries, 0);
  assert.equal(f.state.recoveryQueries, 0);
});

for (const membership of [false, true]) {
  test(`cuenta revocada entre consulta y recovery ${membership ? "VIP" : "reserva"} hace rollback`, async t => {
    const f = await fixture(t, { membership, accountUnavailableDuringRecovery: true });
    const response = await f.app.inject({ method: "POST", url: `${baseUrl}/conciliar`, headers: f.headers, payload: {} });
    assert.ok([403, 409].includes(response.statusCode), response.body);
    assert.equal(f.state.recoveryQueries, 0);
    assert.ok(f.state.sql.some(entry => entry.text.trim() === "ROLLBACK"));
    assert.equal(f.state.connections, f.state.releases);
    assert.equal(f.state.providerInitializations, 0);
  });
}

test("consulta y conciliacion mantienen limites reales de frecuencia", async t => {
  const f = await fixture(t);
  for (const [method, limit] of [["GET", 10], ["POST", 3]]) {
    for (let count = 0; count < limit; count++) {
      const response = await f.app.inject({ method, url: (method === "GET" ? baseUrl : `${baseUrl}/conciliar`) + `?probe=${count}`,
        headers: f.headers, ...(method === "POST" ? { payload: {} } : {}) });
      assert.equal(response.statusCode, method === "POST" ? 202 : 200, response.body);
    }
    const alternateUrl = `/v1/cliente/pagos/${ids.other}` + (method === "POST" ? "/conciliar" : "");
    const response = await f.app.inject({ method, url: `${alternateUrl}?probe=bypass`,
      headers: f.headers, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.json().error.code, "RATE_LIMIT_EXCEEDED");
  }
  assert.equal(f.state.providerInitializations, 0);
});
