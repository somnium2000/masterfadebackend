// AM: Casos constantes sustituidos por regresiones productivas en accountDeletionRemaining.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  orchestrateApprovedInternalAccountDeletion,
} from "../src/services/accountDeletionService.js";

function appWithStates(states) {
  let index = 0;
  return {
    db: {
      connect: async () => ({
        query: async () => ({
          rows: [states[Math.min(index++, states.length - 1)]],
          rowCount: 1,
        }),
        release: () => {},
      }),
    },
  };
}

const base = {
  id_solicitud: "11111111-1111-4111-8111-111111111111",
  referencia_publica: "DEL-ABCDEF123456",
  tipo_sujeto: "personal",
  id_persona: "22222222-2222-4222-8222-222222222222",
  id_usuario: "33333333-3333-4333-8333-333333333333",
  id_empleado: "44444444-4444-4444-8444-444444444444",
  decision_codigo: "aprobada",
  decision_at: new Date(),
  decision_por: "55555555-5555-4555-8555-555555555555",
};

test("solo solicitud aprobada puede iniciar", async () => {
  await assert.rejects(() => orchestrateApprovedInternalAccountDeletion(appWithStates([{ ...base, estado_codigo: "pendiente_aprobacion" }]), { deletionRequestId: base.id_solicitud }), /estado/);
});

test("replay completado", async () => {
  const result = await orchestrateApprovedInternalAccountDeletion(appWithStates([{ ...base, estado_codigo: "completada", completado_at: new Date() }]), { deletionRequestId: base.id_solicitud });
  assert.equal(result.completed, true);
});
