import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { AppError } from "../src/utils/errors.js";
import { registerHostedBookingRoutes } from "../src/routes/v1/public/pixelPayHosted.js";
import { resolvePixelPayHostedConfig } from "../src/services/payments/pixelPayHosted.js";

const groupId = "22222222-2222-4333-8444-555555555555";
const idIntent = "11111111-2222-4333-8444-555555555555";
const payload = { id_grupo_cita: groupId, id_intent: idIntent, titular_email: "fixture@example.invalid" };
const config = resolvePixelPayHostedConfig({ PIXELPAY_HOSTED_ENABLED: "true", ENTORNO: "qa", PIXELPAY_ENV: "sandbox", PAYMENT_PROVIDER: "pixelpay",
  FRONTEND_URL: "https://qa.masterfadeapp.com", PIXELPAY_HOSTED_KEY_ID: "1234567890", PIXELPAY_HOSTED_SECRET_KEY: "hosted-fixture-secret",
  PIXELPAY_HOSTED_APP_URL: "https://pixelpay.app", PIXELPAY_HOSTED_CALLBACK_URL: "https://qa.masterfadeapp.com/v1/pagos/pixelpay/hosted/callback" });
const checkout = "https://pixelpay.app/sandbox/abc123/checkout/example?payload=fixture";

async function setup({ authenticated = false, enabled = true, sdkAttempts = false } = {}) {
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  const state = { intent: { id_intent: idIntent, id_grupo_cita: groupId, payment_channel: "sdk", provider_code: "pixelpay", estado_intent_codigo: "link_generado",
    moneda_codigo: "HNL", monto_hnl: 100, orden_compra: "MF-PIXELPAY-11111111222243338444555555555555", expires_at: expiresAt },
    groupRows: [{ estado_grupo_codigo: "activo", estado_cita_codigo: "pendiente_pago", estado_hold_codigo: "activo", expires_at: expiresAt,
      titular_nombres: "Cliente", titular_apellidos: "Prueba" }], session: null, sdkAttempts, sql: [] };
  let lockTail = Promise.resolve();
  const query = async (sql, values) => {
    state.sql.push(sql);
    if (sql.startsWith("SELECT * FROM app_private.pixelpay_hosted_sessions")) return { rows: state.session ? [structuredClone(state.session)] : [] };
    if (sql.includes("FROM app_private.pixelpay_sale_attempts")) return { rows: state.sdkAttempts ? [{ exists: 1 }] : [] };
    if (sql.includes("proteger_reserva_pago_v1")) { state.intent.estado_intent_codigo = "pendiente_confirmacion"; return { rows: [{ expires_at: expiresAt }] }; }
    if (sql.includes("INSERT INTO app_private.pixelpay_hosted_sessions")) {
      assert.equal(state.session, null);
      state.session = { id_intent: values[0], id_grupo_cita: values[1], order_id: values[2], amount_hnl: values[3], currency: values[4], expires_at: values[5], creation_state: "creating" };
      return { rows: [structuredClone(state.session)] };
    }
    if (sql.startsWith("UPDATE public.payment_intents")) { state.intent.payment_channel = "hosted"; return { rows: [] }; }
    if (sql.startsWith("UPDATE app_private.pixelpay_hosted_sessions")) {
      if (sql.includes("checkout_ready")) Object.assign(state.session, { creation_state: "checkout_ready", checkout_url: values[1] });
      else state.session.creation_state = values[1];
      return { rows: [structuredClone(state.session)] };
    }
    return { rows: [] };
  };
  const app = Fastify();
  app.decorate("config", { pixelPayHosted: enabled ? config : { enabled: false } });
  app.decorate("db", { query, async connect() {
    let releaseLock;
    let snapshot;
    return { async query(sql, values) {
      if (sql.includes("pg_advisory_xact_lock")) {
        const previous = lockTail;
        lockTail = new Promise(resolve => { releaseLock = resolve; });
        await previous;
        snapshot = structuredClone({ intent: state.intent, session: state.session });
      }
      if (sql === "ROLLBACK" && snapshot) Object.assign(state, snapshot);
      const result = await query(sql, values);
      if (["COMMIT", "ROLLBACK"].includes(sql) && releaseLock) { releaseLock(); releaseLock = null; }
      return result;
    }, release() { if (releaseLock) releaseLock(); } };
  } });
  const helpers = {
    routeGuard: authenticated ? { preHandler: async (request, reply) => {
      if (request.headers["x-fixture-owner"] !== "owner") return reply.code(403).send({ ok: false });
    } } : {},
    paymentAccess: () => ({ mode: authenticated ? "authenticated" : "public" }),
    async loadPublicIntentForGroup(_db, args) {
      if (args.groupId !== groupId || args.idIntent !== idIntent || args.titularEmail !== payload.titular_email) {
        throw new AppError(403, "No tienes permisos para operar esta reserva", { code: "PUBLIC_PAGOS_GROUP_FORBIDDEN" });
      }
      return structuredClone({ intent: state.intent, groupRows: state.groupRows });
    },
    assertPublicGroupPayable(rows) {
      if (rows.some(row => row.estado_grupo_codigo !== "activo" || !["pendiente_pago", "en_espera"].includes(row.estado_cita_codigo))) {
        throw new AppError(409, "Reserva no disponible", { code: "PUBLIC_PAGOS_GROUP_STATE_INVALID" });
      }
    },
    resolveGroupExpiresAt(rows) {
      if (rows.some(row => new Date(row.expires_at).getTime() <= Date.now())) throw new AppError(409, "Reserva vencida", { code: "PUBLIC_PAGOS_HOLD_EXPIRED" });
      return expiresAt;
    },
    async recalculateGroupPromotionsForPayment() { return { total_hnl: 100, items: [{ code: "CORTE", title: "Corte de cabello", price: 100, qty: 1 }] }; },
  };
  registerHostedBookingRoutes(app, helpers);
  await app.ready();
  return { app, state };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("Hosted off no reclama orden ni llama proveedor; capabilities no promete confirmacion", async () => {
  const { app, state } = await setup({ enabled: false });
  try {
    const caps = (await app.inject({ method: "GET", url: "/pixelpay/hosted/capabilities" })).json().data;
    assert.equal(caps.available, false);
    assert.equal(caps.automatic_confirmation, false);
    const response = await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload });
    assert.equal(response.statusCode, 503);
    assert.equal(state.sql.length, 0);
  } finally { await app.close(); }
});

test("doble start concurrente solo crea una sesion y hace un POST Sandbox", async () => {
  const { app, state } = await setup();
  let calls = 0;
  try {
    await withFetch(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { status: 200, json: async () => ({ success: true, url: checkout }) }; }, async () => {
      const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload })));
      assert.ok(responses.every(response => response.statusCode < 300));
      assert.equal(calls, 1);
      assert.equal(state.intent.payment_channel, "hosted");
      assert.equal(state.session.creation_state, "checkout_ready");
      assert.equal(responses.some(response => response.json().data.checkout_url === checkout), true);
      const status = (await app.inject({ method: "POST", url: "/pixelpay/hosted/status", payload })).json().data;
      assert.equal(status.booking_confirmed, false);
      assert.equal(status.pending_confirmation, true);
      assert.equal(calls, 1);
    });
    assert.equal(state.sql.some(sql => /INSERT INTO public\.payments|payment_events|confirmar_reserva|pixelpay\.sale\.approved_verified/.test(sql)), false);
  } finally { await app.close(); }
});

test("timeout mantiene claim durable y recarga no repite Hosted ni permite SDK", async () => {
  const { app, state } = await setup();
  let calls = 0;
  try {
    await withFetch(async () => { calls++; throw new Error("private-network-error"); }, async () => {
      const first = await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload });
      assert.equal(first.statusCode, 202);
      assert.equal(first.json().data.hosted_state, "creation_uncertain");
      const second = await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload });
      assert.equal(second.json().data.checkout_url, null);
      assert.equal(calls, 1);
      assert.equal(state.intent.estado_intent_codigo, "pendiente_confirmacion");
      assert.equal(state.intent.payment_channel, "hosted");
    });
  } finally { await app.close(); }
});

test("sesion anterior SDK incluso de otro intent del grupo bloquea Hosted antes de POST", async () => {
  const { app, state } = await setup({ sdkAttempts: true });
  try {
    const result = await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, "PIXELPAY_HOSTED_PREVIOUS_ATTEMPT_EXISTS");
    assert.equal(state.session, null);
    assert.equal(state.intent.payment_channel, "sdk");
  } finally { await app.close(); }
});

test("propietario incorrecto, orden ajena y reserva vencida no reclaman canal", async () => {
  const { app, state } = await setup();
  try {
    for (const change of [{ titular_email: "otro@example.invalid" }, { id_intent: "33333333-2222-4333-8444-555555555555" }, { id_grupo_cita: "33333333-2222-4333-8444-555555555555" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload: { ...payload, ...change } })).statusCode, 403);
    }
    state.groupRows[0].expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload })).statusCode, 409);
    assert.equal(state.session, null);
  } finally { await app.close(); }
});

test("rutas autenticadas conservan el mismo guard de cliente/propietario", async () => {
  const { app, state } = await setup({ authenticated: true });
  try {
    for (const path of ["start", "status"]) assert.equal((await app.inject({ method: "POST", url: `/pixelpay/hosted/${path}`, payload })).statusCode, 403);
    assert.equal(state.sql.length, 0);
  } finally { await app.close(); }
});

test("cancelacion durante llamada externa conserva URL interna pero no la ofrece al cliente", async () => {
  const { app, state } = await setup();
  try {
    await withFetch(async () => { state.groupRows[0].estado_grupo_codigo = "cancelado"; return { status: 200, json: async () => ({ success: true, url: checkout }) }; }, async () => {
      const result = await app.inject({ method: "POST", url: "/pixelpay/hosted/start", payload });
      assert.equal(result.statusCode, 201);
      assert.equal(result.json().data.checkout_url, null);
      assert.equal(state.session.checkout_url, checkout);
      assert.equal((await app.inject({ method: "POST", url: "/pixelpay/hosted/status", payload })).json().data.checkout_url, null);
    });
  } finally { await app.close(); }
});
