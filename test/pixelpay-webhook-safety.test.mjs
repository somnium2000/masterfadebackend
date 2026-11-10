import test from "node:test";
import assert from "node:assert/strict";

import { assertPaymentWebhookContract } from "../src/routes/v1/pagos.js";
import {
  ACTIVE_PAYMENT_INTENT_STATES,
  expireStaleAppointmentReservations,
} from "../src/services/agendaService.js";

test("PixelPay webhook permanece deshabilitado por defecto", () => {
  assert.throws(
    () => assertPaymentWebhookContract({ config: {} }, "pixelpay"),
    (error) => error?.statusCode === 503 && error?.code === "PIXELPAY_WEBHOOK_DISABLED"
  );
});

test("habilitar el flag no omite el contrato oficial bloqueado", () => {
  assert.throws(
    () => assertPaymentWebhookContract({ config: { pixelPayWebhookEnabled: true } }, "pixelpay"),
    (error) => error?.statusCode === 503
      && error?.code === "PIXELPAY_WEBHOOK_PROVIDER_CONTRACT_BLOCKED"
      && error?.details?.integration === "sdk_do_sale"
      && error?.details?.sdkRemoteCallbackDeclared === true
      && error?.details?.hostedCallbackContractApplicable === false
      && error?.details?.remoteCallbackAuthenticated === false
  );
});

test("notificaciones PixelPay no confirmadas se bloquean antes de persistir", () => {
  const notifications = [
    {
      name: "aparentemente valida",
      body: {
        order: "orden-123",
        payment_uuid: "550e8400-e29b-41d4-a716-446655440000",
        status: "paid",
        amount: 100,
        currency: "HNL",
        payment_hash: "hash-aparentemente-valido",
      },
    },
    { name: "falsificada", body: { status: "paid", payment_hash: "forjado" } },
    { name: "duplicada", body: { status: "paid", payment_hash: "repetido" } },
    { name: "tardia", body: { status: "paid", payment_hash: "tardio" } },
    { name: "monto incorrecto", body: { status: "paid", amount: 0.01, currency: "HNL" } },
  ];
  let persistenceAttempts = 0;

  for (const notification of notifications) {
    assert.ok(notification.body);
    assert.throws(
      () => {
        assertPaymentWebhookContract({ config: { pixelPayWebhookEnabled: true } }, "pixelpay");
        persistenceAttempts += 1;
      },
      (error) => error?.statusCode === 503
        && error?.code === "PIXELPAY_WEBHOOK_PROVIDER_CONTRACT_BLOCKED",
      notification.name
    );
  }

  assert.equal(persistenceAttempts, 0);
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
