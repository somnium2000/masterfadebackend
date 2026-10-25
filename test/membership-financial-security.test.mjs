import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import clienteRoutes from "../src/routes/v1/cliente.js";
import {
  acquireMembershipPlan,
  confirmMembershipPaymentAndActivateSubscription,
  createMembershipOrderPaymentIntent,
  processMembershipPixelPaySale,
  processMembershipSimulatorEvent,
  recoverMembershipPixelPayApproval,
  reconcileMembershipPixelPayStatus,
} from "../src/services/membershipService.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { PIXELPAY_SALE_OUTCOME } from "../src/services/payments/PixelPayDirectProvider.js";

const CLIENT = "41111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "42222222-2222-4222-8222-222222222222";
const USER = "51111111-1111-4111-8111-111111111111";
const INTENT = "61111111-1111-4111-8111-111111111111";
const ORDER = "71111111-1111-4111-8111-111111111111";
const PLAN = "81111111-1111-4111-8111-111111111111";
const OFFER = "91111111-1111-4111-8111-111111111111";
const BRANCH = "a1111111-1111-4111-8111-111111111111";

function intentRow(state = "pendiente_confirmacion", owner = CLIENT) {
  return {
    id_intent: INTENT,
    id_provider: "b1111111-1111-4111-8111-111111111111",
    id_membership_order: ORDER,
    origen_pago_codigo: "membership",
    estado_intent_codigo: state,
    monto_hnl: 800,
    moneda_codigo: "HNL",
    referencia_externa: null,
    created_by_usuario_id: USER,
    id_order: ORDER,
    id_cliente: owner,
    id_usuario: USER,
    id_plan: PLAN,
    id_plan_sucursal: OFFER,
    id_sucursal: BRANCH,
    estado_orden_codigo: "pendiente_pago",
    total_hnl: 800,
    order_moneda_codigo: "HNL",
    id_suscripcion: null,
    periodo_membresia_codigo: "mensual",
    beneficios: { version: 1, items: [] },
  };
}

function readOnlyIntentClient(row) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push(text);
      if (text.includes("FROM public.payment_intents pi")) return { rows: [row], rowCount: 1 };
      throw new Error(`Unexpected write or query: ${text.slice(0, 100)}`);
    },
  };
}

async function buildRouteApp(t) {
  let connects = 0;
  const app = Fastify();
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { roles: ["cliente"], cliente_id: CLIENT, user: { id_usuario: USER } };
  });
  app.decorate("db", { connect: async () => { connects += 1; throw new Error("DB must not be reached"); } });
  app.decorate("config", {
    nodeEnv: "production",
    paymentProvider: "pixelpay",
    todoPago: { mode: "preprod_simulated", simulatedEnabled: true },
  });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.ready();
  t.after(() => app.close());
  return { app, getConnects: () => connects };
}

test("adquisicion directa se bloquea y los contratos HTTP fallan cerrado antes de abrir BD", async (t) => {
  const { app, getConnects } = await buildRouteApp(t);
  const acquire = await app.inject({
    method: "POST",
    url: "/v1/cliente/planes/adquirir",
    payload: { id_plan: PLAN, id_sucursal: BRANCH },
  });
  assert.equal(acquire.statusCode, 409);
  assert.equal(acquire.json().error.code, "MEMBERSHIP_PURCHASE_REQUIRES_VERIFIED_PAYMENT");

  const confirm = await app.inject({
    method: "POST",
    url: "/v1/cliente/planes/confirmar-pago",
    payload: { id_payment_intent: INTENT },
  });
  assert.equal(confirm.statusCode, 400);

  const simulator = await app.inject({
    method: "POST",
    url: "/v1/cliente/planes/simulator/event",
    payload: { id_payment_intent: INTENT, monto_prueba_hnl: 1.23 },
  });
  assert.equal(simulator.statusCode, 409);
  assert.equal(simulator.json().error.code, "CLIENTE_MEMBERSHIP_SIMULATOR_DISABLED");
  assert.equal(getConnects(), 0);
});

test("HTTP estado VIP rechaza usuario no autenticado antes de consultar BD", async (t) => {
  let connects = 0;
  const app = Fastify();
  app.decorate("requireRoles", () => async (_request, reply) => reply.code(401).send({
    ok: false, error: { code: "AUTH_REQUIRED", message: "Autenticacion requerida" },
  }));
  app.decorate("db", { connect: async () => { connects += 1; throw new Error("DB must not be reached"); } });
  app.decorate("config", { nodeEnv: "test", paymentProvider: "pixelpay", todoPago: {} });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.ready();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: `/v1/cliente/planes/pago-intent/${INTENT}/estado`,
    payload: {},
  });
  assert.equal(response.statusCode, 401);
  assert.equal(connects, 0);
});

test("servicio de adquisicion directa falla cerrado sin consultar ni escribir", async () => {
  const client = { query() { throw new Error("DB must not be reached"); } };
  await assert.rejects(acquireMembershipPlan(client, {
    clienteId: CLIENT, usuarioId: USER, idPlan: PLAN, idSucursal: BRANCH,
  }), { statusCode: 409, code: "MEMBERSHIP_PURCHASE_REQUIRES_VERIFIED_PAYMENT" });
});

for (const state of ["creado", "pendiente_confirmacion", "fallido", "expirado"]) {
  test(`intent ${state} sin evidencia no activa ni escribe`, async () => {
    const client = readOnlyIntentClient(intentRow(state));
    await assert.rejects(confirmMembershipPaymentAndActivateSubscription(client, {
      idPaymentIntent: INTENT,
      clienteId: CLIENT,
    }), { statusCode: 409, code: state === "creado" || state === "pendiente_confirmacion"
      ? "MEMBERSHIP_PAYMENT_VERIFICATION_REQUIRED"
      : "MEMBERSHIP_PAYMENT_INTENT_STATE_INVALID" });
    assert.equal(client.calls.length, 1);
  });
}

test("repetir confirmacion sin evidencia no crea pagos ni suscripciones", async () => {
  const client = readOnlyIntentClient(intentRow());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(confirmMembershipPaymentAndActivateSubscription(client, {
      idPaymentIntent: INTENT,
      clienteId: CLIENT,
    }), { code: "MEMBERSHIP_PAYMENT_VERIFICATION_REQUIRED" });
  }
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls.every((sql) => sql.startsWith("SELECT")));
});

test("un cliente no puede confirmar la orden de otro cliente", async () => {
  const client = readOnlyIntentClient(intentRow("pendiente_confirmacion", OTHER_CLIENT));
  await assert.rejects(confirmMembershipPaymentAndActivateSubscription(client, {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  }), { statusCode: 403, code: "MEMBERSHIP_PAYMENT_CONFIRM_FORBIDDEN" });
  assert.equal(client.calls.length, 1);
});

test("simulador rechaza PixelPay y entornos no locales antes de consultar BD", async () => {
  const client = { query() { throw new Error("DB must not be reached"); } };
  for (const serverContext of [
    { paymentProvider: "pixelpay", mode: "preprod_simulated", simulatedEnabled: true, explicitlyEnabled: true, nodeEnv: "test" },
    { paymentProvider: "todopago", mode: "preprod_simulated", simulatedEnabled: true, explicitlyEnabled: true, nodeEnv: "staging" },
    { paymentProvider: "todopago", mode: "preprod_simulated", simulatedEnabled: true, explicitlyEnabled: false, nodeEnv: "development" },
  ]) {
    await assert.rejects(processMembershipSimulatorEvent(client, {
      idPaymentIntent: INTENT,
      clienteId: CLIENT,
      serverContext,
    }), { statusCode: 409, code: "MEMBERSHIP_PAYMENT_SIMULATOR_DISABLED" });
  }
});

test("PixelPay reutiliza el mismo intent de la orden sin invocar createIntent", async () => {
  const previous = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = "pixelpay";
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push(text);
      if (text.includes("FROM public.membership_purchase_orders mpo")) {
        return { rows: [{
          id_order: ORDER,
          id_cliente: CLIENT,
          id_usuario: USER,
          id_plan: PLAN,
          id_plan_sucursal: OFFER,
          id_sucursal: BRANCH,
          estado_orden_codigo: "pendiente_pago",
          total_hnl: 800,
          moneda_codigo: "HNL",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }], rowCount: 1 };
      }
      if (text.includes("FROM public.payment_providers")) {
        return { rows: [{ id_provider: "b1111111-1111-4111-8111-111111111111", codigo: "pixelpay", activo: true }] };
      }
      if (text.includes("FROM public.payment_intents") && text.includes("idempotency_key")) {
        return { rows: [{
          id_intent: INTENT,
          id_membership_order: ORDER,
          origen_pago_codigo: "membership",
          monto_hnl: 800,
          moneda_codigo: "HNL",
          referencia_externa: null,
          estado_intent_codigo: "link_generado",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }] };
      }
      throw new Error(`Unexpected provider or DB operation: ${text.slice(0, 100)}`);
    },
  };
  try {
    const result = await createMembershipOrderPaymentIntent(client, {
      idOrder: ORDER,
      clienteId: CLIENT,
      usuarioId: USER,
    });
    assert.equal(result.id_payment_intent, INTENT);
    assert.equal(result.reused, true);
    assert.equal(calls.filter((sql) => sql.startsWith("INSERT")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previous;
  }
});

function pixelPayProcessHarness({
  owner = CLIENT,
  providerCode = "pixelpay",
  provider,
  failSubscriptionPayment = false,
  paymentLate = false,
  expired = false,
  paymentProviderTxConflict = false,
  pendingScopeIntent = null,
  planSnapshot = null,
  initialIntentState = "link_generado",
  durableEvidence = null,
  durableVerifiedAt = null,
  providerSessionId = null,
  amount = 800,
} = {}) {
  const state = {
    intentState: initialIntentState, saleCalls: 0, commits: 0, rollbacks: 0,
    orderState: "pendiente_pago", idSubscription: null,
    subscriptions: 0, payments: 0, subscriptionPayments: 0,
    verifiedEvidenceEvents: 0, verifiedReferenceWrites: 0, subscriptionInsertParams: null,
    statusClaimed: false, dynamicDurableEvidence: null, dynamicVerifiedAt: null,
    paymentProviderTxIds: [], paymentAmounts: [], paymentPaidAts: [],
  };
  const row = {
    ...intentRow("link_generado", owner),
    monto_hnl: amount,
    total_hnl: amount,
    provider_code: "pixelpay",
    provider_session_id: providerSessionId,
    intent_expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
    order_expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
    plan_snapshot: planSnapshot || {
      nombre_plan: "VIP QA",
      periodo_membresia_codigo: "mensual",
      beneficios: { version: 1, items: [] },
    },
    cliente_snapshot: { nombre_completo: "Cliente QA", email: "qa@example.com" },
  };
  const client = {
    async query(sql, values = []) {
      const text = String(sql?.text || sql).replace(/\s+/g, " ").trim();
      if (text === "BEGIN" || text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (text === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (text === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (text.includes("pi.id_intent <> $4::uuid")) {
        return { rows: pendingScopeIntent ? [{ id_intent: pendingScopeIntent }] : [] };
      }
      if (text.includes("FROM public.payment_intents pi") && text.includes("JOIN public.payment_events pe")) {
        const currentEvidence = durableEvidence || state.dynamicDurableEvidence;
        return { rows: currentEvidence ? [{
          id_intent: INTENT,
          id_provider: row.id_provider,
          id_membership_order: ORDER,
          id_cliente: owner,
          provider_code: providerCode,
          estado_intent_codigo: state.intentState,
          monto_hnl: row.monto_hnl,
          moneda_codigo: row.moneda_codigo,
          intent_expires_at: row.intent_expires_at,
          order_expires_at: row.order_expires_at,
          estado_orden_codigo: state.orderState,
          id_suscripcion: state.idSubscription,
          payload_esencial: currentEvidence,
          verified_at: durableVerifiedAt || state.dynamicVerifiedAt,
        }] : [] };
      }
      if (text.includes("FROM public.payment_intents pi")) {
        return { rows: [{ ...row, estado_intent_codigo: state.intentState,
          estado_orden_codigo: state.orderState, id_suscripcion: state.idSubscription }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO app_private.pixelpay_sale_attempts")) {
        return { rows: [{ id_sale_attempt: crypto.randomUUID() }] };
      }
      if (text.includes("SET estado_intent_codigo = 'pendiente_confirmacion'")) {
        if (state.intentState !== "link_generado") return { rows: [] };
        state.intentState = "pendiente_confirmacion";
        return { rows: [{ id_intent: INTENT }] };
      }
      if (text.startsWith("INSERT INTO public.payment_events")) {
        if (text.includes("membership.pixelpay.approved_verified")) state.verifiedEvidenceEvents += 1;
        if (values[2]?.payment_hash_valid === true) {
          state.dynamicDurableEvidence = values[2];
          state.dynamicVerifiedAt = new Date().toISOString();
        }
        return { rows: [{ id_event: crypto.randomUUID() }] };
      }
      if (text.includes("SET last_verified_at = now()")) {
        if (state.statusClaimed) return { rows: [] };
        state.statusClaimed = true;
        return { rows: [{ id_intent: INTENT }] };
      }
      if (text.includes("SET referencia_externa = $2::text")) {
        state.verifiedReferenceWrites += 1;
        return { rows: [{ id_intent: INTENT }] };
      }
      if (text.includes("to_regclass('public.subscriptions')")) return { rows: [{
        has_subscriptions: true,
        has_membership_plans: true,
        has_membership_plans_sucursal: true,
        has_subscription_consumptions: true,
        has_subscription_alert_events: true,
        has_subscription_payments: true,
        has_points_transactions: true,
      }] };
      if (text.includes("FROM information_schema.columns")) return { rows: [
        { table_name: "subscriptions", column_name: "beneficios_snapshot" },
        { table_name: "subscriptions", column_name: "id_sucursal_contratada" },
        { table_name: "subscriptions", column_name: "motivo_fin_codigo" },
      ] };
      if (text.startsWith("UPDATE public.membership_purchase_orders")) {
        if (text.includes("estado_orden_codigo = 'pagada'")) state.orderState = "pagada";
        if (text.includes("SET id_suscripcion")) state.idSubscription = values[1];
        return { rows: [{ id_order: ORDER }] };
      }
      if (text.startsWith("UPDATE public.subscriptions")) return { rows: [] };
      if (text.startsWith("INSERT INTO public.subscriptions")) {
        state.subscriptions += 1;
        state.subscriptionInsertParams = values;
        return { rows: [{ id_suscripcion: "c1111111-1111-4111-8111-111111111111", estado_suscripcion_codigo: "activa" }] };
      }
      if (text.includes("SET estado_intent_codigo = 'confirmado'")) {
        state.intentState = "confirmado";
        return { rows: [{ id_intent: INTENT }] };
      }
      if (text.startsWith("INSERT INTO public.payments")) {
        state.payments += 1;
        state.paymentProviderTxIds.push(values[1]);
        state.paymentAmounts.push(values[2]);
        state.paymentPaidAts.push(values[5]);
        if (paymentProviderTxConflict) return { rows: [] };
        return { rows: [{ id_payment: "d1111111-1111-4111-8111-111111111111", pago_tardio: paymentLate }] };
      }
      if (text.startsWith("INSERT INTO public.subscription_payments")) {
        if (failSubscriptionPayment) throw new Error("forced subscription_payments failure");
        state.subscriptionPayments += 1;
        return { rows: [{ id_subscription_payment: crypto.randomUUID() }] };
      }
      if (text.includes("SET estado_intent_codigo=$2::text")) {
        state.intentState = values[1];
        return { rows: [{ id_intent: INTENT }] };
      }
      throw new Error(`Unexpected process query: ${text.slice(0, 140)}`);
    },
    release() {},
  };
  const db = {
    connect: async () => client,
    async query(query) {
      const text = String(query?.text || query);
      if (text.includes("UPDATE app_private.pixelpay_sale_attempts")) return { rows: [{ id_sale_attempt: crypto.randomUUID() }] };
      if (text.includes("SET estado_intent_codigo='fallido'")) {
        state.intentState = "fallido";
        return { rows: [{ id_intent: INTENT }] };
      }
      throw new Error(`Unexpected pool query: ${text.slice(0, 120)}`);
    },
  };
  PaymentProviderFactory._instance = {
    async sale(...args) {
      state.saleCalls += 1;
      return provider.sale(...args);
    },
    async queryPaymentStatus(...args) {
      state.statusCalls = (state.statusCalls || 0) + 1;
      return provider.queryPaymentStatus?.(...args);
    },
  };
  return { app: { db }, state };
}

const validCard = { number: "4111111111111111", holder: "Cliente QA", expire: "3012", cvv: "123" };
const validBilling = { address: "Calle 1", country: "HN", state: "HN-FM", city: "Tegucigalpa", phone: "99999999" };

async function buildPixelPayRouteApp(t, harnessOptions) {
  const harness = pixelPayProcessHarness(harnessOptions);
  const server = Fastify();
  server.decorate("requireRoles", () => async (request) => {
    request.claims = { roles: ["cliente"], cliente_id: CLIENT, user: { id_usuario: USER } };
  });
  server.decorate("db", harness.app.db);
  server.decorate("config", {
    nodeEnv: "test",
    paymentProvider: "pixelpay",
    todoPago: { mode: "disabled", simulatedEnabled: false },
  });
  await server.register(clienteRoutes, { prefix: "/v1/cliente" });
  await server.ready();
  t.after(async () => {
    await server.close();
    PaymentProviderFactory.reset();
  });
  return { server, state: harness.state };
}

test("HTTP confirmar-pago conserva card y billing hasta el servicio y responde 200 sin PAN/CVV", async (t) => {
  let receivedTransaction;
  const { server, state } = await buildPixelPayRouteApp(t, { provider: { sale: async (transaction) => {
    receivedTransaction = transaction;
    return {
      outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
      approved: true,
      paymentHashValid: true,
      amountMatches: true,
      paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      transactionId: "pixelpay-http-approved",
      diagnostics: {},
    };
  } } });
  const response = await server.inject({
    method: "POST",
    url: "/v1/cliente/planes/confirmar-pago",
    payload: { id_payment_intent: INTENT, card: validCard, billing: validBilling },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(state.saleCalls, 1);
  assert.deepEqual(receivedTransaction.card, validCard);
  assert.deepEqual(receivedTransaction.billing, validBilling);
  assert.equal(response.body.includes(validCard.number), false);
  assert.equal(response.body.includes(validCard.cvv), false);
  assert.equal(response.body.includes('"card"'), false);
  assert.equal(response.body.includes('"cvv"'), false);
});

test("HTTP confirmar-pago pendiente responde 202 sin PAN/CVV", async (t) => {
  const { server, state } = await buildPixelPayRouteApp(t, { provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.UNCERTAIN,
    approved: false,
    paymentHashValid: false,
    amountMatches: true,
    diagnostics: {},
  }) } });
  const response = await server.inject({
    method: "POST",
    url: "/v1/cliente/planes/confirmar-pago",
    payload: { id_payment_intent: INTENT, card: validCard, billing: validBilling },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.pending_confirmation, true);
  assert.equal(state.saleCalls, 1);
  assert.equal(response.body.includes(validCard.number), false);
  assert.equal(response.body.includes(validCard.cvv), false);
  assert.equal(response.body.includes('"card"'), false);
  assert.equal(response.body.includes('"cvv"'), false);
});

for (const missingField of ["card", "billing"]) {
  test(`HTTP confirmar-pago sin ${missingField} devuelve 400 y no invoca proveedor`, async (t) => {
    const { server, state } = await buildPixelPayRouteApp(t, { provider: { sale: async () => {
      throw new Error("provider must not be called");
    } } });
    const payload = { id_payment_intent: INTENT, card: validCard, billing: validBilling };
    delete payload[missingField];
    const response = await server.inject({
      method: "POST",
      url: "/v1/cliente/planes/confirmar-pago",
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(state.saleCalls, 0);
    assert.equal(response.body.includes(validCard.number), false);
    assert.equal(response.body.includes(validCard.cvv), false);
  });
}

test("rechazo definitivo no activa y persiste estado fallido", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED,
    approved: false,
    paymentHashValid: true,
    amountMatches: true,
    diagnostics: {},
  }) } });
  const result = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-declined",
  });
  assert.equal(result.estado_intent_codigo, "fallido");
  assert.equal(state.intentState, "fallido");
  assert.equal(state.saleCalls, 1);
});

test("hash invalido queda pendiente y nunca activa", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.UNCERTAIN,
    approved: false,
    paymentHashValid: false,
    amountMatches: true,
    paymentUuid: "observed-untrusted",
    transactionId: "observed-tx",
    diagnostics: {},
  }) } });
  const result = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-hash",
  });
  assert.equal(result.pending_confirmation, true);
  assert.equal(state.intentState, "pendiente_confirmacion");
});

test("timeout sin UUID confiable queda pendiente y no ejecuta Status", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  let statusCalls = 0;
  const error = Object.assign(new Error("timeout"), { uncertain: true, paymentUuid: "observed-untrusted" });
  const { app, state } = pixelPayProcessHarness({ provider: {
    sale: async () => { throw error; },
    queryPaymentStatus: async () => { statusCalls += 1; },
  } });
  const result = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-timeout",
  });
  assert.equal(result.pending_confirmation, true);
  assert.equal(state.intentState, "pendiente_confirmacion");
  assert.equal(statusCalls, 0);
});

test("reintento concurrente no inicia un segundo Sale", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  let releaseSale;
  const pendingSale = new Promise((resolve) => { releaseSale = resolve; });
  const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => pendingSale } });
  const first = processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-first",
  });
  while (state.saleCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-second",
  }), { statusCode: 409, code: "MEMBERSHIP_PIXELPAY_SALE_ALREADY_IN_PROGRESS" });
  releaseSale({ outcome: PIXELPAY_SALE_OUTCOME.PAYMENT_DECLINED, approved: false, diagnostics: {} });
  await first;
  assert.equal(state.saleCalls, 1);
});

test("Sale rechaza la orden de otro cliente antes de invocar proveedor", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ owner: OTHER_CLIENT, provider: { sale: async () => ({}) } });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), { statusCode: 403, code: "MEMBERSHIP_PAYMENT_CONFIRM_FORBIDDEN" });
  assert.equal(state.saleCalls, 0);
});

test("aprobado con hash, monto y moneda validos activa y contabiliza una vez", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
    approved: true,
    paymentHashValid: true,
    amountMatches: true,
    paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    transactionId: "pixelpay-tx-approved",
    diagnostics: {},
  }) } });
  const result = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-approved",
  });
  assert.equal(result.processed, true);
  assert.equal(state.intentState, "confirmado");
  assert.equal(state.subscriptions, 1);
  assert.equal(state.payments, 1);
  assert.equal(state.subscriptionPayments, 1);
  assert.deepEqual(state.paymentProviderTxIds, ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);

  const duplicate = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling, requestId: "req-duplicate",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.saleCalls, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.payments, 1);
  assert.equal(state.subscriptionPayments, 1);
});

test("monto no coincidente no activa la membresia", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.UNCERTAIN,
    approved: false,
    paymentHashValid: true,
    amountMatches: false,
    diagnostics: {},
  }) } });
  const result = await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  });
  assert.equal(result.pending_confirmation, true);
  assert.equal(state.subscriptions, 0);
  assert.equal(state.payments, 0);
});

test("error contable provoca rollback de la activacion atomica", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    failSubscriptionPayment: true,
    provider: { sale: async () => ({
      outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
      approved: true,
      paymentHashValid: true,
      amountMatches: true,
      paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      transactionId: "pixelpay-tx-rollback",
      diagnostics: {},
    }) },
  });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), /forced subscription_payments failure/);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.commits, 2, "claim y evidencia verificada se confirman; la activacion se revierte");
  assert.equal(state.verifiedReferenceWrites, 1);
  assert.equal(state.verifiedEvidenceEvents, 1);
});

test("intent u orden vencidos bloquean Sale antes del proveedor", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ expired: true, provider: { sale: async () => { throw new Error("Sale must not run"); } } });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), { statusCode: 409, code: "MEMBERSHIP_PAYMENT_INTENT_EXPIRED" });
  assert.equal(state.saleCalls, 0);
});

test("clasificacion tardia del trigger revierte toda la activacion", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ paymentLate: true, provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
    approved: true,
    paymentHashValid: true,
    amountMatches: true,
    paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    transactionId: "pixelpay-tx-late",
    diagnostics: {},
  }) } });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), { statusCode: 409, code: "MEMBERSHIP_PAYMENT_LATE_RECONCILIATION_REQUIRED" });
  assert.equal(state.rollbacks, 1);
  assert.equal(state.subscriptionPayments, 0);
  assert.equal(state.verifiedReferenceWrites, 1);
  assert.equal(state.verifiedEvidenceEvents, 1);
});

test("payment_uuid de otro intent se rechaza sin vincular su pago", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({ paymentProviderTxConflict: true, provider: { sale: async () => ({
    outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
    approved: true,
    paymentHashValid: true,
    amountMatches: true,
    paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    transactionId: "provider-tx-owned-by-another-intent",
    diagnostics: {},
  }) } });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), { statusCode: 409, code: "MEMBERSHIP_PAYMENT_PROVIDER_TX_CONFLICT" });
  assert.equal(state.subscriptionPayments, 0);
});

test("dos aprobaciones Sandbox con transaction_id repetido usan payment_uuid distintos", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const transactionId = "1f694eee-4715-45b8-a545-000000000000";
  const paymentUuids = [
    "e1111111-1111-4111-8111-111111111111",
    "e2222222-2222-4222-8222-222222222222",
  ];
  const persistedKeys = [];
  for (const paymentUuid of paymentUuids) {
    const { app, state } = pixelPayProcessHarness({ provider: { sale: async () => ({
      outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
      approved: true,
      paymentHashValid: true,
      amountMatches: true,
      paymentUuid,
      transactionId,
      diagnostics: {},
    }) } });
    await processMembershipPixelPaySale(app, {
      idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
    });
    persistedKeys.push(...state.paymentProviderTxIds);
    assert.equal(state.payments, 1);
    assert.equal(state.subscriptionPayments, 1);
  }
  assert.deepEqual(persistedKeys, paymentUuids);
});

test("importe comercial L 300 se conserva sin sustituirlo por L 1", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  let providerAmount;
  const { app, state } = pixelPayProcessHarness({ amount: 300, provider: { sale: async (transaction) => {
    providerAmount = transaction.amount;
    return {
      outcome: PIXELPAY_SALE_OUTCOME.APPROVED,
      approved: true,
      paymentHashValid: true,
      amountMatches: true,
      paymentUuid: "e4444444-4444-4444-8444-444444444444",
      transactionId: "commercial-300",
      diagnostics: {},
    };
  } } });
  await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  });
  assert.equal(providerAmount, 300);
  assert.deepEqual(state.paymentAmounts, [300]);
});

test("recuperacion durable activa sin ejecutar un segundo Sale", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const durableEvidence = {
    id_order: ORDER,
    id_intent: INTENT,
    provider: "pixelpay",
    payment_uuid: "e3333333-3333-4333-8333-333333333333",
    transaction_id: "1f694eee-4715-45b8-a545-000000000000",
    amount: 800,
    currency: "HNL",
    payment_hash_valid: true,
    amount_matches: true,
  };
  const verifiedAt = new Date(Date.now() - 120_000).toISOString();
  const { app, state } = pixelPayProcessHarness({
    expired: true,
    initialIntentState: "pendiente_confirmacion",
    durableEvidence,
    durableVerifiedAt: verifiedAt,
    provider: { sale: async () => { throw new Error("Sale must not run during recovery"); } },
  });
  const recoveryClient = await app.db.connect();
  const result = await recoverMembershipPixelPayApproval(recoveryClient, {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  });
  assert.equal(result.estado, "activa");
  assert.equal(state.saleCalls, 0);
  assert.deepEqual(state.paymentProviderTxIds, [durableEvidence.payment_uuid]);
  assert.deepEqual(state.paymentPaidAts, [verifiedAt]);

  const duplicate = await recoverMembershipPixelPayApproval(recoveryClient, {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.payments, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.subscriptionPayments, 1);
});

test("recuperacion protegida acepta intent expirado solo con evidencia durable previa", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const verifiedAt = new Date(Date.now() - 120_000).toISOString();
  const { app, state } = pixelPayProcessHarness({
    expired: true,
    initialIntentState: "expirado",
    durableVerifiedAt: verifiedAt,
    durableEvidence: {
      id_order: ORDER,
      id_intent: INTENT,
      provider: "pixelpay",
      payment_uuid: "e6666666-6666-4666-8666-666666666666",
      transaction_id: "expired-durable-approved",
      amount: 800,
      currency: "HNL",
      payment_hash_valid: true,
      amount_matches: true,
    },
    provider: { sale: async () => { throw new Error("Sale must not run during recovery"); } },
  });
  const result = await recoverMembershipPixelPayApproval(await app.db.connect(), {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  });
  assert.equal(result.estado, "activa");
  assert.equal(state.saleCalls, 0);
  assert.deepEqual(state.paymentPaidAts, [verifiedAt]);
  assert.equal(state.payments, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.subscriptionPayments, 1);
});

test("recuperacion duplicate vuelve a validar cliente y proveedor persistidos", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const durableEvidence = {
    id_order: ORDER,
    id_intent: INTENT,
    provider: "pixelpay",
    payment_uuid: "e3333333-3333-4333-8333-333333333333",
    transaction_id: "duplicate-provider-owner",
    amount: 800,
    currency: "HNL",
    payment_hash_valid: true,
    amount_matches: true,
  };
  const verifiedAt = new Date(Date.now() - 120_000).toISOString();
  const wrongOwner = pixelPayProcessHarness({
    owner: "f9999999-9999-4999-8999-999999999999",
    initialIntentState: "confirmado",
    durableEvidence,
    durableVerifiedAt: verifiedAt,
    provider: { sale: async () => { throw new Error("Sale must not run during recovery"); } },
  });
  wrongOwner.state.orderState = "pagada";
  wrongOwner.state.idSubscription = "c1111111-1111-4111-8111-111111111111";
  await assert.rejects(recoverMembershipPixelPayApproval(await wrongOwner.app.db.connect(), {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  }), { statusCode: 403, code: "MEMBERSHIP_PAYMENT_CONFIRM_FORBIDDEN" });

  const wrongProvider = pixelPayProcessHarness({
    providerCode: "otro_proveedor",
    initialIntentState: "confirmado",
    durableEvidence,
    durableVerifiedAt: verifiedAt,
    provider: { sale: async () => { throw new Error("Sale must not run during recovery"); } },
  });
  wrongProvider.state.orderState = "pagada";
  wrongProvider.state.idSubscription = "c1111111-1111-4111-8111-111111111111";
  await assert.rejects(recoverMembershipPixelPayApproval(await wrongProvider.app.db.connect(), {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  }), { statusCode: 409, code: "MEMBERSHIP_PAYMENT_PROVIDER_MISMATCH" });
  assert.equal(wrongOwner.state.saleCalls + wrongProvider.state.saleCalls, 0);
});

test("recuperacion rechaza evidencia verificada despues del vencimiento", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    expired: true,
    initialIntentState: "pendiente_confirmacion",
    durableVerifiedAt: new Date().toISOString(),
    durableEvidence: {
      id_order: ORDER,
      id_intent: INTENT,
      provider: "pixelpay",
      payment_uuid: "e5555555-5555-4555-8555-555555555555",
      transaction_id: "late-verification",
      amount: 800,
      currency: "HNL",
      payment_hash_valid: true,
      amount_matches: true,
    },
    provider: { sale: async () => { throw new Error("Sale must not run during recovery"); } },
  });
  const recoveryClient = await app.db.connect();
  await assert.rejects(recoverMembershipPixelPayApproval(recoveryClient, {
    idPaymentIntent: INTENT,
    clienteId: CLIENT,
  }), { statusCode: 409, code: "MEMBERSHIP_PIXELPAY_RECOVERY_VERIFIED_AFTER_EXPIRY" });
  assert.equal(state.saleCalls, 0);
  assert.equal(state.payments, 0);
  assert.equal(state.subscriptions, 0);
});

test("consulta VIP sin payment_uuid permanece pendiente y nunca llama Status", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    initialIntentState: "pendiente_confirmacion",
    provider: { queryPaymentStatus: async () => { throw new Error("Status must not run"); } },
  });
  const result = await reconcileMembershipPixelPayStatus(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT,
  });
  assert.equal(result.normalized_status, "PENDIENTE");
  assert.equal(result.reconciliation_required, true);
  assert.equal(state.statusCalls || 0, 0);
});

test("consulta VIP rechaza IDOR antes de consultar PixelPay", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    owner: "f9999999-9999-4999-8999-999999999999",
    providerSessionId: "P-11111111-1111-4111-8111-111111111111",
    provider: { queryPaymentStatus: async () => ({ status: "PAID" }) },
  });
  await assert.rejects(reconcileMembershipPixelPayStatus(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT,
  }), { statusCode: 403, code: "MEMBERSHIP_PAYMENT_CONFIRM_FORBIDDEN" });
  assert.equal(state.statusCalls || 0, 0);
});

test("dos consultas simultaneas ejecutan un solo Status y conservan pendiente", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    initialIntentState: "pendiente_confirmacion",
    providerSessionId: "P-11111111-1111-4111-8111-111111111111",
    provider: { queryPaymentStatus: async () => ({ ok: true, success: true, status: "PENDING" }) },
  });
  const results = await Promise.all([
    reconcileMembershipPixelPayStatus(app, { idPaymentIntent: INTENT, clienteId: CLIENT }),
    reconcileMembershipPixelPayStatus(app, { idPaymentIntent: INTENT, clienteId: CLIENT }),
  ]);
  assert.deepEqual(results.map((item) => item.normalized_status), ["PENDIENTE", "PENDIENTE"]);
  assert.equal(state.statusCalls, 1);
});

test("Status aprobado con evidencia completa contabiliza una sola vez", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const paymentUuid = "P-22222222-2222-4222-8222-222222222222";
  const { app, state } = pixelPayProcessHarness({
    initialIntentState: "pendiente_confirmacion",
    providerSessionId: paymentUuid,
    provider: { queryPaymentStatus: async () => ({
      ok: true, success: true, status: "PAID", approved: true, incomplete: false,
      paymentHashValid: true, amountMatches: true, resultPaymentUuid: paymentUuid,
      transactionId: "status-approved-transaction",
    }) },
  });
  const result = await reconcileMembershipPixelPayStatus(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT,
  });
  assert.equal(result.normalized_status, "PAGADO");
  assert.equal(state.statusCalls, 1);
  assert.equal(state.payments, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.subscriptionPayments, 1);
});

test("Status rechazado definitivo marca RECHAZADO; UNKNOWN permanece PENDIENTE", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const rejected = pixelPayProcessHarness({
    initialIntentState: "pendiente_confirmacion",
    providerSessionId: "P-33333333-3333-4333-8333-333333333333",
    provider: { queryPaymentStatus: async () => ({
      ok: true, success: true, status: "DECLINED", definitiveRejected: true,
    }) },
  });
  assert.equal((await reconcileMembershipPixelPayStatus(rejected.app, {
    idPaymentIntent: INTENT, clienteId: CLIENT,
  })).normalized_status, "RECHAZADO");

  const unknown = pixelPayProcessHarness({
    initialIntentState: "pendiente_confirmacion",
    providerSessionId: "P-44444444-4444-4444-8444-444444444444",
    provider: { queryPaymentStatus: async () => ({ ok: true, success: true, status: "UNKNOWN" }) },
  });
  assert.equal((await reconcileMembershipPixelPayStatus(unknown.app, {
    idPaymentIntent: INTENT, clienteId: CLIENT,
  })).normalized_status, "PENDIENTE");
});

test("operacion pendiente de otra orden del mismo cliente y sucursal bloquea Sale", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const { app, state } = pixelPayProcessHarness({
    pendingScopeIntent: "62222222-2222-4222-8222-222222222222",
    provider: { sale: async () => { throw new Error("Sale must not run"); } },
  });
  await assert.rejects(processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  }), { statusCode: 409, code: "MEMBERSHIP_PIXELPAY_PENDING_SCOPE_CONFLICT" });
  assert.equal(state.saleCalls, 0);
});

test("activacion usa beneficios y periodo del snapshot aunque cambie el catalogo", async (t) => {
  t.after(() => PaymentProviderFactory.reset());
  const snapshotBenefits = {
    version: 1,
    items: [{ tipo: "servicio", id_servicio: "f1111111-1111-4111-8111-111111111111", cantidad: 4 }],
  };
  const { app, state } = pixelPayProcessHarness({
    planSnapshot: { nombre_plan: "VIP Original", periodo_membresia_codigo: "anual", beneficios: snapshotBenefits },
    provider: { sale: async () => ({
      outcome: PIXELPAY_SALE_OUTCOME.APPROVED, approved: true, paymentHashValid: true, amountMatches: true,
      paymentUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", transactionId: "snapshot-tx", diagnostics: {},
    }) },
  });
  await processMembershipPixelPaySale(app, {
    idPaymentIntent: INTENT, clienteId: CLIENT, card: validCard, billing: validBilling,
  });
  const [startAt, endAt] = state.subscriptionInsertParams.slice(2, 4).map((value) => new Date(value));
  assert.ok(endAt.getTime() - startAt.getTime() > 300 * 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(state.subscriptionInsertParams.at(-1)), {
    version: 1,
    items: [{
      tipo: "servicio",
      id_servicio: "f1111111-1111-4111-8111-111111111111",
      id_cortesia: null,
      codigo: null,
      nombre: "Servicio",
      cantidad: 4,
    }],
  });
});
