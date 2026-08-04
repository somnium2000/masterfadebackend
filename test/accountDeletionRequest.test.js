import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmClientAccountDeletionRequest,
  createClientAccountDeletionRequest,
  validateClientAccountDeletionConfirmationBody,
  verifyRecentAccountDeletionReauthentication,
} from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_TRACE_ID = "req-test-001";
const IDEMPOTENCY_KEY = "account-delete:test-key-001";
const NOW = "2026-07-10T12:00:00.000Z";

function basePreviewRow(overrides = {}) {
  return {
    context_found: true,
    active_roles: ["cliente"],
    has_active_employee: false,
    is_protected: false,
    blocking_appointments: { count: 0, items: [] },
    active_holds: { count: 0, nearest_expiration_at: null },
    pending_payments: { intent_count: 0, payment_count: 0 },
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

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: "DEL-ABCDEF123456",
    estado_codigo: "pendiente_confirmacion",
    idempotency_key: IDEMPOTENCY_KEY,
    solicitado_at: NOW,
    reautenticado_at: null,
    execution_token_hash: null,
    execution_token_issued_at: null,
    execution_token_expires_at: null,
    execution_token_last_used_at: null,
    ...overrides,
  };
}

function createClient({ previewRow = basePreviewRow(), activeRow = null, insertRow = requestRow(), updateRow = requestRow() } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("WITH params AS")) return { rows: [previewRow] };
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("FOR UPDATE")) {
        return { rows: activeRow ? [activeRow] : [] };
      }
      if (text.includes("INSERT INTO app_private.solicitudes_eliminacion_cuenta")) {
        return { rows: [insertRow] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) {
        return { rows: [updateRow] };
      }
      return { rows: [] };
    },
  };
}

async function createRequest(client) {
  return createClientAccountDeletionRequest(client, {
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: REQUEST_TRACE_ID,
  });
}

async function confirmRequest(client) {
  return confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: REQUEST_TRACE_ID,
  });
}

function makeJwt({ sub = USUARIO_ID, iat = Math.floor(Date.now() / 1000) } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub, iat })}.signature`;
}

test("crea solicitud pendiente de confirmacion cuando no hay bloqueos", async () => {
  const client = createClient();
  const result = await createRequest(client);

  assert.equal(result.request.estado_codigo, "pendiente_confirmacion");
  assert.equal(result.request.can_confirm, true);
  assert.equal(result.idempotent_replay, false);
  assert.ok(client.calls.some((call) => call.sql.includes("INSERT INTO app_private.solicitudes_eliminacion_cuenta")));
});

test("crea solicitud bloqueada cuando el preview tiene bloqueos", async () => {
  const client = createClient({
    previewRow: basePreviewRow({
      blocking_appointments: { count: 1, items: [] },
    }),
    insertRow: requestRow({ estado_codigo: "bloqueada" }),
  });
  const result = await createRequest(client);

  assert.equal(result.request.estado_codigo, "bloqueada");
  assert.equal(result.request.can_confirm, false);
});

test("idempotencia con la misma clave devuelve la solicitud activa sin insertar", async () => {
  const client = createClient({ activeRow: requestRow() });
  const result = await createRequest(client);

  assert.equal(result.idempotent_replay, true);
  assert.equal(result.request.id_solicitud, REQUEST_ID);
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO app_private.solicitudes_eliminacion_cuenta")));
});

test("solicitud activa con clave diferente lanza conflicto", async () => {
  const client = createClient({
    activeRow: requestRow({ idempotency_key: "account-delete:other-key" }),
  });

  await assert.rejects(createRequest(client), (error) => {
    assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REQUEST_ALREADY_ACTIVE");
    return true;
  });
});

test("cuenta que requiere aprobacion no inserta solicitud autonoma", async () => {
  const client = createClient({
    previewRow: basePreviewRow({
      active_roles: ["admin", "cliente"],
      has_active_employee: true,
    }),
  });

  await assert.rejects(createRequest(client), (error) => {
    assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REQUIRES_APPROVAL");
    return true;
  });
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO app_private.solicitudes_eliminacion_cuenta")));
});

test("reauthenticacion valida verifica token, usuario e iat reciente", async () => {
  const token = makeJwt();
  const app = {
    supabaseAdmin: {
      auth: {
        async getUser(receivedToken) {
          assert.equal(receivedToken, token);
          return { data: { user: { id: USUARIO_ID } }, error: null };
        },
      },
    },
  };

  const result = await verifyRecentAccountDeletionReauthentication(app, {
    reauthToken: token,
    expectedUserId: USUARIO_ID,
  });

  assert.equal(result.authUserId, USUARIO_ID);
  assert.ok(result.authenticatedAt);
});

test("reauthenticacion antigua lanza expiracion", async () => {
  const token = makeJwt({ iat: Math.floor(Date.now() / 1000) - 600 });
  const app = {
    supabaseAdmin: {
      auth: {
        async getUser() {
          return { data: { user: { id: USUARIO_ID } }, error: null };
        },
      },
    },
  };

  await assert.rejects(
    verifyRecentAccountDeletionReauthentication(app, { reauthToken: token, expectedUserId: USUARIO_ID }),
    (error) => {
      assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED");
      return true;
    }
  );
});

test("reauthenticacion de otro usuario lanza mismatch", async () => {
  const token = makeJwt({ sub: "55555555-5555-4555-8555-555555555555" });
  const app = {
    supabaseAdmin: {
      auth: {
        async getUser() {
          return { data: { user: { id: "55555555-5555-4555-8555-555555555555" } }, error: null };
        },
      },
    },
  };

  await assert.rejects(
    verifyRecentAccountDeletionReauthentication(app, { reauthToken: token, expectedUserId: USUARIO_ID }),
    (error) => {
      assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REAUTH_SUBJECT_MISMATCH");
      return true;
    }
  );
});

test("confirmacion sin bloqueos actualiza a evaluada", async () => {
  const client = createClient({
    activeRow: requestRow(),
    updateRow: requestRow({
      estado_codigo: "evaluada",
      reautenticado_at: NOW,
      execution_token_expires_at: "2026-07-10T12:10:00.000Z",
    }),
  });
  const result = await confirmRequest(client);

  assert.equal(result.request.estado_codigo, "evaluada");
  assert.equal(result.ready_for_processing, true);
  assert.match(result.execution.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(result.execution.expires_at, "2026-07-10T12:10:00.000Z");
  const update = client.calls.find((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta"));
  assert.equal(update.params[1], "evaluada");
  assert.match(update.params[6], /^[0-9a-f]{64}$/);
  assert.notEqual(update.params[6], result.execution.token);
});

test("bloqueo detectado al confirmar actualiza a bloqueada y limpia reauth", async () => {
  const client = createClient({
    activeRow: requestRow(),
    previewRow: basePreviewRow({
      pending_payments: { intent_count: 1, payment_count: 0 },
    }),
    updateRow: requestRow({ estado_codigo: "bloqueada", reautenticado_at: null }),
  });
  const result = await confirmRequest(client);

  assert.equal(result.request.estado_codigo, "bloqueada");
  assert.equal(result.ready_for_processing, false);
  const update = client.calls.find((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta"));
  assert.equal(update.params[1], "bloqueada");
  assert.equal(update.params[2], null);
  assert.equal(update.params[6], null);
});

test("replay de confirmacion evaluada rota token", async () => {
  const client = createClient({
    activeRow: requestRow({ estado_codigo: "evaluada", reautenticado_at: NOW }),
    updateRow: requestRow({
      estado_codigo: "evaluada",
      reautenticado_at: NOW,
      execution_token_expires_at: "2026-07-10T12:10:00.000Z",
    }),
  });
  const result = await confirmRequest(client);

  assert.equal(result.idempotent_replay, true);
  assert.equal(result.ready_for_processing, true);
  assert.match(result.execution.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")));
});

test("frase o aceptaciones invalidas se rechazan antes de escribir", () => {
  assert.throws(
    () => validateClientAccountDeletionConfirmationBody({
      confirmacion_texto: "ELIMINAR",
      acepta_perder_masterpuntos: true,
      acepta_cancelar_membresia: true,
      acepta_historial_anonimizado: true,
      acepta_irreversibilidad: true,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_CONFIRMATION_TEXT_INVALID" }
  );

  assert.throws(
    () => validateClientAccountDeletionConfirmationBody({
      confirmacion_texto: "ELIMINAR MI CUENTA",
      acepta_perder_masterpuntos: true,
      acepta_cancelar_membresia: false,
      acepta_historial_anonimizado: true,
      acepta_irreversibilidad: true,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_ACCEPTANCES_REQUIRED" }
  );
});
