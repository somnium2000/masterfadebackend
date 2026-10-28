import test from "node:test";
import assert from "node:assert/strict";

import { evaluateClientAccountDeletion } from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-10T12:00:00.000Z";

function baseRow(overrides = {}) {
  return {
    context_found: true,
    active_roles: ["cliente"],
    has_active_employee: false,
    is_protected: false,
    blocking_appointments: {
      count: 0,
      items: [],
    },
    active_holds: {
      count: 0,
      nearest_expiration_at: null,
    },
    pending_payments: {
      intent_count: 0,
      payment_count: 0,
    },
    masterpoints_balance: 0,
    active_membership: null,
    pending_membership_order_count: 0,
    retained_history: {
      appointments_count: 0,
      payments_count: 0,
      subscriptions_count: 0,
      points_transactions_count: 0,
    },
    evaluated_at: NOW,
    ...overrides,
  };
}

function createClient(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] };
    },
  };
}

async function evaluate(row) {
  const client = createClient(row);
  const preview = await evaluateClientAccountDeletion(client, {
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
  });
  return { client, preview };
}

function codes(items) {
  return items.map((item) => item.code);
}

test("cliente limpio puede eliminar de forma autonoma", async () => {
  const { client, preview } = await evaluate(baseRow());

  assert.equal(preview.can_delete, true);
  assert.equal(preview.account_mode, "autonomo");
  assert.equal(preview.requires_approval, false);
  assert.deepEqual(preview.blocking_reasons, []);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params.slice(0, 3), [CLIENTE_ID, PERSONA_ID, USUARIO_ID]);
  assert.doesNotMatch(client.calls[0].sql, /\b(INSERT|UPDATE|DELETE|CALL)\b/i);
});

test("cita pendiente bloquea la eliminacion", async () => {
  const { preview } = await evaluate(baseRow({
    blocking_appointments: {
      count: 1,
      items: [
        {
          id_cita: "44444444-4444-4444-8444-444444444444",
          estado_cita_codigo: "confirmada",
          inicio_at: "2026-07-11T14:00:00.000Z",
          fin_at: "2026-07-11T14:45:00.000Z",
          id_sucursal: "55555555-5555-4555-8555-555555555555",
          id_empleado_barbero: "66666666-6666-4666-8666-666666666666",
        },
      ],
    },
  }));

  assert.equal(preview.can_delete, false);
  assert.ok(codes(preview.blocking_reasons).includes("CLIENT_ACCOUNT_PENDING_APPOINTMENTS"));
  assert.equal(preview.blocking_appointments.count, 1);
});

test("rol interno o empleado requiere aprobacion", async () => {
  const { preview } = await evaluate(baseRow({
    active_roles: ["barbero", "cliente"],
    has_active_employee: true,
  }));

  assert.equal(preview.can_delete, false);
  assert.equal(preview.account_mode, "requiere_aprobacion");
  assert.equal(preview.requires_approval, true);
  assert.ok(
    codes(preview.blocking_reasons).includes("CLIENT_ACCOUNT_INTERNAL_ACCESS_REQUIRES_APPROVAL")
  );
});

test("masterpuntos y membresia activa son consecuencias no bloqueantes", async () => {
  const { preview } = await evaluate(baseRow({
    masterpoints_balance: 42,
    active_membership: {
      id_suscripcion: "77777777-7777-4777-8777-777777777777",
      id_plan: "88888888-8888-4888-8888-888888888888",
      nombre_plan: "Plan Gold",
      inicio_at: "2026-07-01T00:00:00.000Z",
      fin_at: "2026-08-01T00:00:00.000Z",
      renovacion_auto: true,
      cancelada_al_fin: false,
      id_sucursal_contratada: "99999999-9999-4999-8999-999999999999",
    },
  }));

  assert.equal(preview.can_delete, true);
  assert.equal(preview.masterpoints.will_forfeit, true);
  assert.equal(preview.membership.will_cancel, true);
  assert.ok(
    codes(preview.consequences).includes("CLIENT_ACCOUNT_MASTERPOINTS_WILL_BE_FORFEITED")
  );
  assert.ok(
    codes(preview.consequences).includes("CLIENT_ACCOUNT_MEMBERSHIP_WILL_BE_CANCELLED")
  );
});

test("pago pendiente bloquea la eliminacion", async () => {
  const { preview } = await evaluate(baseRow({
    pending_payments: {
      intent_count: 1,
      payment_count: 1,
    },
  }));

  assert.equal(preview.can_delete, false);
  assert.equal(preview.pending_payments.total_count, 2);
  assert.ok(codes(preview.blocking_reasons).includes("CLIENT_ACCOUNT_PENDING_PAYMENTS"));
});

test("contexto inexistente lanza error controlado", async () => {
  const client = createClient(baseRow({ context_found: false }));

  await assert.rejects(
    () => evaluateClientAccountDeletion(client, {
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
    }),
    (error) => {
      assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_CONTEXT_NOT_FOUND");
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
});
