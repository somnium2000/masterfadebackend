import test from "node:test";
import assert from "node:assert/strict";

import { assertPaymentWebhookContract } from "../src/routes/v1/pagos.js";
import {
  EXPIRABLE_PAYMENT_INTENT_STATES,
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

test("el expirador libera la reserva sin cerrar un pago incierto", async () => {
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
  assert.deepEqual(EXPIRABLE_PAYMENT_INTENT_STATES, ["creado", "link_generado"]);
  assert.deepEqual(intentExpiry.params[1], ["creado", "link_generado"]);
  assert.equal(intentExpiry.params[1].includes("pendiente_confirmacion"), false);
});
