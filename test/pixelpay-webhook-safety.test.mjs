import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  assertPaymentWebhookContract,
  default as pagosRoutes,
  processPixelPayOrderCallback,
} from "../src/routes/v1/pagos.js";
import {
  ACTIVE_PAYMENT_INTENT_STATES,
  expireStaleAppointmentReservations,
} from "../src/services/agendaService.js";
import { resolvePixelPayOrderCallbackUrl } from "../src/plugins/env.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

test("PixelPay webhook permanece deshabilitado por defecto", () => {
  assert.throws(
    () => assertPaymentWebhookContract({ config: {} }, "pixelpay"),
    (error) => error?.statusCode === 503 && error?.code === "PIXELPAY_WEBHOOK_DISABLED"
  );
});

test("habilitar el flag permite evaluar el contrato SDK order_callback", () => {
  assert.doesNotThrow(
    () => assertPaymentWebhookContract({ config: { pixelPayWebhookEnabled: true } }, "pixelpay")
  );
});

test("callback URL solo se materializa con flag y endpoint HTTPS exacto", () => {
  assert.equal(resolvePixelPayOrderCallbackUrl("", false), null);
  assert.equal(
    resolvePixelPayOrderCallbackUrl(
      "https://api.example.test/v1/pagos/webhook/pixelpay",
      true
    ),
    "https://api.example.test/v1/pagos/webhook/pixelpay"
  );
  assert.throws(
    () => resolvePixelPayOrderCallbackUrl("http://api.example.test/v1/pagos/webhook/pixelpay", true),
    /HTTPS/
  );
});

function callbackFixture({ duplicate = false, status = {}, statusError = null, intentOverrides = {} } = {}) {
  const queries = [];
  const intent = {
    id_intent: "11111111-1111-4111-8111-111111111111",
    id_provider: "22222222-2222-4222-8222-222222222222",
    orden_compra: "ORDER-1",
    provider_session_id: "P-1",
    monto_hnl: "100.00",
    moneda_codigo: "HNL",
    estado_intent_codigo: "pendiente_confirmacion",
    ...intentOverrides,
  };
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text.includes("FROM public.payment_intents pi")) return { rows: [intent] };
      if (text.includes("INSERT INTO public.payment_events")) {
        return { rows: duplicate ? [] : [{ id_event: "33333333-3333-4333-8333-333333333333" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = {
    async connect() { return client; },
    async query(sql, params = []) { queries.push({ text: String(sql), params }); return { rows: [] }; },
  };
  const provider = {
    verifyPaymentHash(hash, orderId) { return hash === "valid-hash" && orderId === "ORDER-1"; },
    async queryPaymentStatus() {
      if (statusError) throw statusError;
      return {
        ok: true,
        success: true,
        providerContractValid: true,
        paymentHashValid: true,
        amountMatches: true,
        resultPaymentUuid: "P-1",
        status: "COMPLETED",
        statusCode: 200,
        ...status,
      };
    },
  };
  return { db, provider, queries };
}

const validCallback = {
  order_id: "ORDER-1",
  payment_uuid: "P-1",
  payment_hash: "valid-hash",
};

test("callback valido verifica Status pero conserva pendiente", async () => {
  const fixture = callbackFixture();
  const result = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-valid",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.processed, false);
  assert.equal(result.extension_pending, true);
  assert.equal(fixture.queries.some(({ text }) => text.includes("INSERT INTO public.payments")), false);
  assert.equal(fixture.queries.some(({ text }) => text.includes("confirmar_reserva_pagada")), false);
});

test("callback falsificado se rechaza antes de abrir PostgreSQL", async () => {
  let connects = 0;
  const fixture = callbackFixture();
  fixture.db.connect = async () => { connects += 1; throw new Error("no debe conectar"); };
  await assert.rejects(
    processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: { ...validCallback, payment_hash: "forged" },
      requestId: "req-forged",
    }),
    (error) => error?.statusCode === 401 && error?.code === "PIXELPAY_CALLBACK_PAYMENT_HASH_INVALID"
  );
  assert.equal(connects, 0);
});

test("callback duplicado responde idempotente sin repetir Status", async () => {
  const fixture = callbackFixture({ duplicate: true });
  let statusCalls = 0;
  fixture.provider.queryPaymentStatus = async () => { statusCalls += 1; throw new Error("no debe consultar"); };
  const result = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-duplicate",
  });
  assert.equal(result.duplicate, true);
  assert.equal(statusCalls, 0);
});

test("Status 412 y monto incorrecto permanecen pendientes", async (t) => {
  await t.test("Status 412", async () => {
    const fixture = callbackFixture({
      statusError: Object.assign(new Error("precondition"), {
        code: "PIXELPAY_STATUS_PRECONDITION_FAILED",
        statusCode: 412,
      }),
    });
    const result = await processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: validCallback,
      requestId: "req-412",
    });
    assert.equal(result.status, "pending");
    assert.equal(result.processed, false);
    assert.equal(fixture.queries.some(({ params }) => params?.includes("precondicion_fallida")), true);
  });
  await t.test("monto incorrecto", async () => {
    const fixture = callbackFixture({ status: { amountMatches: false } });
    const result = await processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: validCallback,
      requestId: "req-amount",
    });
    assert.equal(result.processed, false);
    assert.equal(fixture.queries.some(({ params }) => params?.includes("respuesta_invalida")), true);
  });
});

test("callback tardio conserva intent expirado sin promoverlo", async () => {
  const fixture = callbackFixture({ intentOverrides: { estado_intent_codigo: "expirado" } });
  const result = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-late",
  });
  assert.equal(result.processed, false);
  assert.equal(result.extension_pending, true);
  assert.equal(fixture.queries.some(({ text }) => /UPDATE public\.payment_intents/i.test(text)), false);
});

test("callback exige nombres canonicos SDK y no campos Hosted", async () => {
  const fixture = callbackFixture();
  await assert.rejects(
    processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: { order: "ORDER-1", uuid: "P-1", payment_hash: "valid-hash" },
      requestId: "req-hosted-shape",
    }),
    (error) => error?.code === "PIXELPAY_CALLBACK_REQUIRED_FIELDS_MISSING"
  );
  assert.equal(fixture.queries.length, 0);
});

test("receptor SDK responde HTTP 200 a callback aceptado sin headers Hosted", async (t) => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousAdminMode = process.env.ADMIN_DATA_ENTRY_MODE;
  const fixture = callbackFixture();
  process.env.PAYMENT_PROVIDER = "pixelpay";
  process.env.ADMIN_DATA_ENTRY_MODE = "false";
  PaymentProviderFactory._instance = fixture.provider;
  const app = Fastify();
  app.decorate("config", { pixelPayWebhookEnabled: true });
  app.decorate("db", fixture.db);
  app.decorate("requireRoles", () => async () => {});
  await app.register(pagosRoutes, { prefix: "/v1/pagos" });
  t.after(async () => {
    await app.close();
    PaymentProviderFactory.reset();
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
    if (previousAdminMode === undefined) delete process.env.ADMIN_DATA_ENTRY_MODE;
    else process.env.ADMIN_DATA_ENTRY_MODE = previousAdminMode;
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/pagos/webhook/pixelpay",
    payload: validCallback,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.processed, false);
  assert.equal(response.json().data.extension_pending, true);
});

test("el expirador delega la proteccion a evidencia durable y conserva otros proveedores", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    },
  };

  await expireStaleAppointmentReservations(client, { now: new Date("2026-11-06T12:00:00.000Z") });

  const intentExpiry = calls.find(({ sql }) => sql.includes("WITH target_intents AS"));
  assert.ok(intentExpiry);
  assert.deepEqual(ACTIVE_PAYMENT_INTENT_STATES, ["creado", "link_generado", "pendiente_confirmacion"]);
  assert.deepEqual(intentExpiry.params[1], ACTIVE_PAYMENT_INTENT_STATES);
  assert.match(intentExpiry.sql, /NOT app_private\.pixelpay_intent_has_uncertain_sale_v1\(pi\.id_intent\)/);
});
