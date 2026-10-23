import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import clienteRoutes from "../src/routes/v1/cliente.js";
import {
  acquireMembershipPlan,
  confirmMembershipPaymentAndActivateSubscription,
  createMembershipOrderPaymentIntent,
  processMembershipSimulatorEvent,
} from "../src/services/membershipService.js";

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

test("rutas de adquisicion y confirmacion rechazan antes de abrir BD", async (t) => {
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
  assert.equal(confirm.statusCode, 409);
  assert.equal(confirm.json().error.code, "MEMBERSHIP_PAYMENT_VERIFICATION_REQUIRED");
  assert.equal(getConnects(), 0);
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

test("PixelPay no invoca createIntent ni produce escrituras parciales", async () => {
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
      throw new Error(`Unexpected provider or DB operation: ${text.slice(0, 100)}`);
    },
  };
  try {
    await assert.rejects(createMembershipOrderPaymentIntent(client, {
      idOrder: ORDER,
      clienteId: CLIENT,
      usuarioId: USER,
    }), { statusCode: 409, code: "MEMBERSHIP_PIXELPAY_CHECKOUT_NOT_AVAILABLE" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith("SELECT"));
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previous;
  }
});
