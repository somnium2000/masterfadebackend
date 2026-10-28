import assert from "node:assert/strict";
import test from "node:test";
import { getTodoPagoResponseCode } from "../src/services/payments/todopago/todoPagoResponseCodes.js";

test("codigo 00 se normaliza como PAID", () => {
  const result = getTodoPagoResponseCode("00");
  assert.equal(result.normalizedStatus, "PAID");
  assert.equal(result.known, true);
});

test("codigo TO se normaliza como TIMEOUT", () => {
  const result = getTodoPagoResponseCode("to");
  assert.equal(result.normalizedStatus, "TIMEOUT");
  assert.equal(result.known, true);
});

test("codigo desconocido se maneja de forma segura sin confirmar pago", () => {
  const result = getTodoPagoResponseCode("ZZ");
  assert.deepEqual(result, {
    code: "ZZ",
    description: "Codigo de respuesta TodoPago no reconocido.",
    normalizedStatus: "REVIEW",
    known: false,
  });
});
