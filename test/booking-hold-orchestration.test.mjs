import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalHoldResponse,
  createBookingHold,
} from "../src/services/booking/bookingHoldOrchestrationService.js";

test("buildCanonicalHoldResponse normaliza respuesta comun y conserva extensiones publicas", () => {
  const response = buildCanonicalHoldResponse({
    requestId: "request-1",
    canonicalResult: {
      id_grupo_cita: "group-1",
      estado_grupo_codigo: "activo",
      expires_at: "2026-07-10T10:05:00.000Z",
    },
    totals: {
      subtotal_hnl: "250.125",
      descuento_hnl: "25",
      total_hnl: "225",
    },
    blocks: [{ orden_integrante: 1 }],
    extensions: {
      release_token: "release-token",
      promociones_aplicadas: [],
    },
  });

  assert.equal(response.request_id, "request-1");
  assert.equal(response.id_grupo_cita, "group-1");
  assert.equal(response.subtotal_hnl, 250.13);
  assert.equal(response.descuento_total_hnl, 25);
  assert.equal(response.total_pagar_hnl, 225);
  assert.equal(response.extras_a_pagar_hnl, 225);
  assert.equal(response.release_token, "release-token");
  assert.deepEqual(response.bloques, [{ orden_integrante: 1 }]);
});

test("buildCanonicalHoldResponse conserva campos autenticados especificos", () => {
  const response = buildCanonicalHoldResponse({
    requestId: "request-2",
    canonicalResult: { id_grupo_cita: "group-2" },
    totals: { subtotal_hnl: 100, descuento_hnl: 80, total_hnl: 20 },
    extensions: {
      descuento_membresia_hnl: 50,
      descuento_recompensa_hnl: 30,
      extras_pendientes_hnl: 20,
      membresia: { cobertura_activa: true },
      recompensa: { aplicada: true },
    },
  });

  assert.equal(response.descuento_membresia_hnl, 50);
  assert.equal(response.descuento_recompensa_hnl, 30);
  assert.equal(response.extras_pendientes_hnl, 20);
  assert.equal(response.extras_a_pagar_hnl, 20);
  assert.deepEqual(response.membresia, { cobertura_activa: true });
  assert.deepEqual(response.recompensa, { aplicada: true });
});

test("createBookingHold controla BEGIN y COMMIT", async () => {
  const calls = [];
  const dbClient = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
  };
  const result = await createBookingHold({
    dbClient,
    operation: async () => "ok",
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["BEGIN", "COMMIT"]);
});

test("createBookingHold ejecuta ROLLBACK ante error", async () => {
  const calls = [];
  const dbClient = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(
    createBookingHold({
      dbClient,
      operation: async () => {
        throw new Error("boom");
      },
    }),
    /boom/
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
});
