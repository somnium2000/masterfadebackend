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

function callbackFixture({
  duplicate = false,
  eventResult = null,
  status = {},
  statusError = null,
  intentOverrides = {},
} = {}) {
  const queries = [];
  const event = { exists: duplicate, result: eventResult, claimedAt: null };
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
        if (event.exists) return { rows: [] };
        event.exists = true;
        return { rows: [{ id_event: "33333333-3333-4333-8333-333333333333" }] };
      }
      if (text.includes("status_consulta_en_curso")) {
        const retryable = event.result == null || [
          "status_consulta_en_curso",
          "status_412_pendiente",
          "status_error_red_pendiente",
          "status_incierto_pendiente",
        ].includes(event.result);
        const cooldownMs = Number(params[2] || 0) * 1000;
        if (!retryable
          || (event.claimedAt != null && (Date.now() - event.claimedAt) < cooldownMs)) {
          return { rows: [] };
        }
        event.result = "status_consulta_en_curso";
        event.claimedAt = Date.now();
        return { rows: [{ id_event: "33333333-3333-4333-8333-333333333333" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = {
    async connect() { return client; },
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text.includes("UPDATE public.payment_events") && params[2]) event.result = params[2];
      return { rows: [] };
    },
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
        approved: true,
        incomplete: false,
        transactionId: "TX-1",
        ...status,
      };
    },
  };
  return { db, provider, queries, event };
}

const validCallback = {
  amount: 100,
  attach_url: null,
  billing_address: "[REDACTED]",
  billing_city: "[REDACTED]",
  billing_country: "HN",
  billing_state: "[REDACTED]",
  billing_zip: "[REDACTED]",
  card_account: "[REDACTED]",
  card_brand: "[SANITIZED]",
  card_type: "[SANITIZED]",
  category: "[SANITIZED]",
  client_device: "[SANITIZED]",
  client_ip: "[REDACTED]",
  company_key: "[REDACTED]",
  company_name: "[REDACTED]",
  company_slug: "[REDACTED]",
  created_at: "2026-11-10T00:00:00.000Z",
  currency: "HNL",
  customer_email: "[REDACTED]",
  customer_name: "[REDACTED]",
  customer_phone: "[REDACTED]",
  description: "[SANITIZED]",
  extra: [],
  is_overdue: false,
  items: [],
  note: "[SANITIZED]",
  order: "ORDER-1",
  paid_at: "2026-11-10T00:00:00.000Z",
  payment_hash: "valid-hash",
  payment_url: "[REDACTED]",
  ref: "[SANITIZED]",
  status: "COMPLETED",
  tax_amount: 0,
  transaction_id: "TX-1",
  uuid: "P-1",
};

const observedCallbackShape = {
  amount: "number",
  attach_url: "null",
  billing_address: "string",
  billing_city: "string",
  billing_country: "string",
  billing_state: "string",
  billing_zip: "string",
  card_account: "string",
  card_brand: "string",
  card_type: "string",
  category: "string",
  client_device: "string",
  client_ip: "string",
  company_key: "string",
  company_name: "string",
  company_slug: "string",
  created_at: "string",
  currency: "string",
  customer_email: "string",
  customer_name: "string",
  customer_phone: "string",
  description: "string",
  extra: "array",
  is_overdue: "boolean",
  items: "array",
  note: "string",
  order: "string",
  paid_at: "string",
  payment_hash: "string",
  payment_url: "string",
  ref: "string",
  status: "string",
  tax_amount: "number",
  transaction_id: "string",
  uuid: "string",
};

function payloadShape(payload) {
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
  ]));
}

test("fixture reproduce exactamente los 35 nombres y tipos observados", () => {
  assert.deepEqual(payloadShape(validCallback), observedCallbackShape);
  assert.equal(Object.hasOwn(validCallback, "order_id"), false);
  assert.equal(Object.hasOwn(validCallback, "payment_uuid"), false);
});

test("callback real con order/uuid verifica Status pero conserva pendiente", async () => {
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
  assert.equal(
    fixture.queries.some(({ text }) => text.includes("pixelpay.order_callback.received")),
    true
  );
  assert.equal(
    fixture.queries.some(({ text }) => text.includes("pixelpay.order_callback.status_verified")),
    true
  );
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

test("callback real rechaza orden, UUID, monto, moneda y transaccion inconsistentes", async (t) => {
  await t.test("orden incorrecta", async () => {
    const fixture = callbackFixture();
    await assert.rejects(
      processPixelPayOrderCallback({
        db: fixture.db,
        provider: fixture.provider,
        body: { ...validCallback, order: "ORDER-OTHER" },
        requestId: "req-order-mismatch",
      }),
      (error) => error?.code === "PIXELPAY_CALLBACK_PAYMENT_HASH_INVALID"
    );
  });
  await t.test("UUID incorrecto", async () => {
    const fixture = callbackFixture();
    await assert.rejects(
      processPixelPayOrderCallback({
        db: fixture.db,
        provider: fixture.provider,
        body: { ...validCallback, uuid: "P-OTHER" },
        requestId: "req-uuid-mismatch",
      }),
      (error) => error?.code === "PIXELPAY_CALLBACK_PAYMENT_UUID_MISMATCH"
    );
  });
  await t.test("monto incorrecto", async () => {
    const fixture = callbackFixture();
    await assert.rejects(
      processPixelPayOrderCallback({
        db: fixture.db,
        provider: fixture.provider,
        body: { ...validCallback, amount: 99 },
        requestId: "req-callback-amount-mismatch",
      }),
      (error) => error?.code === "PIXELPAY_CALLBACK_AMOUNT_MISMATCH"
    );
  });
  await t.test("moneda incorrecta", async () => {
    const fixture = callbackFixture();
    await assert.rejects(
      processPixelPayOrderCallback({
        db: fixture.db,
        provider: fixture.provider,
        body: { ...validCallback, currency: "USD" },
        requestId: "req-callback-currency-mismatch",
      }),
      (error) => error?.code === "PIXELPAY_CALLBACK_CURRENCY_MISMATCH"
    );
  });
  await t.test("transaction ID distinto de Status queda incierto", async () => {
    const fixture = callbackFixture();
    const result = await processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: { ...validCallback, transaction_id: "TX-OTHER" },
      requestId: "req-transaction-mismatch",
    });
    assert.equal(result.processed, false);
    assert.equal(fixture.event.result, "status_incierto_pendiente");
  });
});

test("callback ya verificado responde idempotente sin repetir Status", async () => {
  const fixture = callbackFixture({
    duplicate: true,
    eventResult: "status_verificado_pendiente_conciliacion",
  });
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

test("duplicado pendiente recupera despues de Status 412", async () => {
  const fixture = callbackFixture({
    statusError: Object.assign(new Error("precondition"), {
      code: "PIXELPAY_STATUS_PRECONDITION_FAILED",
      statusCode: 412,
    }),
  });
  let statusCalls = 0;
  const originalStatus = fixture.provider.queryPaymentStatus;
  fixture.provider.queryPaymentStatus = async (...args) => {
    statusCalls += 1;
    return originalStatus(...args);
  };
  const first = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-412-first",
  });
  assert.equal(first.status, "pending");
  assert.equal(fixture.event.result, "status_412_pendiente");

  fixture.provider.queryPaymentStatus = async () => {
    statusCalls += 1;
    return {
      ok: true,
      success: true,
      providerContractValid: true,
      paymentHashValid: true,
      amountMatches: true,
      resultPaymentUuid: "P-1",
      status: "COMPLETED",
      statusCode: 200,
      approved: true,
      incomplete: false,
      transactionId: "TX-1",
    };
  };
  const recovered = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-412-retry",
    retryCooldownSeconds: 0,
  });
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.processed, false);
  assert.equal(fixture.event.result, "status_verificado_pendiente_conciliacion");
  assert.equal(statusCalls, 2);
  assert.equal(fixture.queries.some(({ text }) => text.includes("INSERT INTO public.payments")), false);
});

test("callbacks concurrentes reclaman una sola consulta Status", async () => {
  const fixture = callbackFixture();
  let statusCalls = 0;
  let releaseStatus;
  let statusStarted;
  const started = new Promise((resolve) => { statusStarted = resolve; });
  const release = new Promise((resolve) => { releaseStatus = resolve; });
  fixture.provider.queryPaymentStatus = async () => {
    statusCalls += 1;
    statusStarted();
    await release;
    return {
      ok: true,
      success: true,
      providerContractValid: true,
      paymentHashValid: true,
      amountMatches: true,
      resultPaymentUuid: "P-1",
      status: "COMPLETED",
      statusCode: 200,
      approved: true,
      incomplete: false,
      transactionId: "TX-1",
    };
  };

  const firstPromise = processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-concurrent-1",
  });
  await started;
  const second = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-concurrent-2",
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.processed, false);
  assert.equal(statusCalls, 1);
  releaseStatus();
  await firstPromise;
  assert.equal(statusCalls, 1);
});

test("moneda del callback distinta de la orden se rechaza antes de Status", async () => {
  const fixture = callbackFixture({ intentOverrides: { moneda_codigo: "USD" } });
  await assert.rejects(
    processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: validCallback,
      requestId: "req-currency",
    }),
    (error) => error?.code === "PIXELPAY_CALLBACK_CURRENCY_MISMATCH"
  );
  assert.equal(fixture.queries.some(({ text }) => text.includes("INSERT INTO public.payments")), false);
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

test("callback de intent confirmado no duplica pago ni modifica paid_at", async () => {
  const fixture = callbackFixture({ intentOverrides: { estado_intent_codigo: "confirmado" } });
  const result = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: validCallback,
    requestId: "req-confirmed",
  });
  assert.equal(result.processed, false);
  assert.equal(fixture.queries.some(({ text }) => /INSERT INTO public\.payments/i.test(text)), false);
  assert.equal(fixture.queries.some(({ text }) => /UPDATE public\.payment_intents/i.test(text)), false);
  assert.equal(fixture.queries.some(({ text }) => /paid_at/i.test(text)), false);
});

test("callback conserva compatibilidad independiente con aliases anteriores", async () => {
  const fixture = callbackFixture();
  const { order, uuid, ...callbackWithoutRealIdentifiers } = validCallback;
  const result = await processPixelPayOrderCallback({
    db: fixture.db,
    provider: fixture.provider,
    body: {
      ...callbackWithoutRealIdentifiers,
      order_id: order,
      payment_uuid: uuid,
    },
    requestId: "req-legacy-aliases",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.processed, false);
});

test("callback rechaza aliases contradictorios antes de PostgreSQL", async () => {
  const fixture = callbackFixture();
  await assert.rejects(
    processPixelPayOrderCallback({
      db: fixture.db,
      provider: fixture.provider,
      body: { ...validCallback, order_id: "ORDER-OTHER" },
      requestId: "req-conflicting-alias",
    }),
    (error) => error?.code === "PIXELPAY_CALLBACK_IDENTIFIER_CONFLICT"
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
