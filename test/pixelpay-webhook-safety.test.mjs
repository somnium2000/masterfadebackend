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
  );
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
