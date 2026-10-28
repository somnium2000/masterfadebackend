import test from "node:test";
import assert from "node:assert/strict";

import {
  executeClientAccountDeletionInternal,
  runClientAccountDeletionInternal,
} from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const TRACE_ID = "req-exec-001";

function freshIso() {
  return new Date().toISOString();
}

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
    evaluated_at: freshIso(),
    ...overrides,
  };
}

function requestRow(overrides = {}) {
  const now = freshIso();
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: "DEL-ABCDEF123456",
    estado_codigo: "evaluada",
    reautenticado_at: now,
    resumen_impacto: { existing: true },
    procesando_at: null,
    ...overrides,
  };
}

function createExecutionClient({
  request = requestRow(),
  preview = basePreviewRow(),
  balances = [0, 0],
  activeCycleId = null,
  rowCounts = {},
  throwOn = null,
} = {}) {
  const calls = [];
  const released = { value: false };
  const counters = {
    pointsInserts: 0,
    queryIndex: 0,
  };
  const defaultRowCounts = {
    subscriptions: 0,
    orders: 0,
    cycles: 0,
    sessions: 0,
    roles: 0,
    user: 1,
    client: 1,
    request: 1,
    finalSummary: 1,
    ...rowCounts,
  };

  return {
    calls,
    counters,
    get released() {
      return released.value;
    },
    release() {
      released.value = true;
      calls.push({ sql: "RELEASE", params: [] });
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      counters.queryIndex += 1;

      if (throwOn?.(text, params, counters.queryIndex)) {
        const error = new Error("forced");
        if (typeof throwOn.code === "string") error.code = throwOn.code;
        throw error;
      }

      if (/^BEGIN ISOLATION LEVEL SERIALIZABLE$/i.test(text)) return { rows: [] };
      if (/^COMMIT$/i.test(text)) return { rows: [] };
      if (/^ROLLBACK$/i.test(text)) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("WITH params AS")) return { rows: [preview] };
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("FOR UPDATE")) {
        return { rows: request ? [request] : [] };
      }
      if (text.includes("SET estado_codigo = 'bloqueada'")) {
        return { rowCount: defaultRowCounts.request, rows: [] };
      }
      if (text.includes("SET estado_codigo = 'procesando'")) {
        return {
          rowCount: defaultRowCounts.request,
          rows: [{
            id_solicitud: REQUEST_ID,
            referencia_publica: "DEL-ABCDEF123456",
            estado_codigo: "procesando",
            procesando_at: freshIso(),
            resumen_impacto: request?.resumen_impacto ?? {},
          }],
        };
      }
      if (text.includes("FROM public.vw_points_balance")) {
        return { rows: [{ balance_puntos: balances.length ? balances.shift() : 0 }] };
      }
      if (text.includes("FROM public.points_cycles") && text.includes("LIMIT 1")) {
        return { rows: activeCycleId ? [{ id_cycle: activeCycleId }] : [] };
      }
      if (text.includes("INSERT INTO public.points_transactions")) {
        counters.pointsInserts += 1;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("UPDATE public.subscriptions")) return { rowCount: defaultRowCounts.subscriptions, rows: [] };
      if (text.includes("UPDATE public.membership_purchase_orders")) return { rowCount: defaultRowCounts.orders, rows: [] };
      if (text.includes("UPDATE public.points_cycles")) return { rowCount: defaultRowCounts.cycles, rows: [] };
      if (text.includes("UPDATE public.seguridad_sesiones")) return { rowCount: defaultRowCounts.sessions, rows: [] };
      if (text.includes("UPDATE public.roles_usuarios")) return { rowCount: defaultRowCounts.roles, rows: [] };
      if (text.includes("UPDATE public.usuarios")) return { rowCount: defaultRowCounts.user, rows: [] };
      if (text.includes("UPDATE public.clientes")) return { rowCount: defaultRowCounts.client, rows: [] };
      if (text.includes("SET resumen_impacto")) return { rowCount: defaultRowCounts.finalSummary, rows: [] };

      return { rowCount: 0, rows: [] };
    },
  };
}

function execute(client, overrides = {}) {
  return executeClientAccountDeletionInternal(client, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: freshIso(),
    traceRequestId: TRACE_ID,
    ...overrides,
  });
}

function makeApp(client) {
  return {
    db: {
      async connect() {
        return client;
      },
    },
  };
}

test("solicitud evaluada sin bloqueos pasa a procesando y ejecuta cierre interno", async () => {
  const client = createExecutionClient({
    balances: [25, 0],
    activeCycleId: "55555555-5555-4555-8555-555555555555",
    rowCounts: {
      subscriptions: 1,
      orders: 1,
      cycles: 1,
      sessions: 1,
      roles: 1,
    },
  });

  const result = await execute(client);

  assert.equal(result.processed, true);
  assert.equal(result.ready_for_anonymization, true);
  assert.equal(result.idempotent_replay, false);
  assert.equal(result.request.estado_codigo, "procesando");
  assert.deepEqual(result.internal_execution, {
    subscriptions_cancelled: 1,
    membership_orders_cancelled: 1,
    points_balance_before: 25,
    points_forfeited: 25,
    points_balance_after: 0,
    points_cycles_closed: 1,
    sessions_revoked: 1,
    roles_disabled: 1,
    user_disabled: true,
    client_disabled: true,
  });
});

test("solicitud con bloqueos vuelve a bloqueada sin desactivar cuenta", async () => {
  const client = createExecutionClient({
    preview: basePreviewRow({
      pending_payments: { intent_count: 1, payment_count: 0 },
    }),
  });

  const result = await execute(client);

  assert.equal(result.processed, false);
  assert.equal(result.request_state, "bloqueada");
  assert.ok(result.blocking_reasons.some((item) => item.code === "CLIENT_ACCOUNT_PENDING_PAYMENTS"));
  assert.ok(!client.calls.some((call) => call.sql.includes("UPDATE public.usuarios")));
  assert.ok(!client.calls.some((call) => call.sql.includes("UPDATE public.clientes")));
});

test("cuenta que ahora requiere aprobacion queda bloqueada", async () => {
  const client = createExecutionClient({
    preview: basePreviewRow({
      active_roles: ["cliente", "admin"],
    }),
  });

  const result = await execute(client);

  assert.equal(result.processed, false);
  assert.equal(result.request_state, "bloqueada");
  assert.ok(result.blocking_reasons.some(
    (item) => item.code === "CLIENT_ACCOUNT_INTERNAL_ACCESS_REQUIRES_APPROVAL"
  ));
});

test("solicitud inexistente devuelve error controlado", async () => {
  const client = createExecutionClient({ request: null });

  await assert.rejects(execute(client), (error) => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND");
    return true;
  });
});

test("estado invalido es rechazado", async () => {
  const client = createExecutionClient({
    request: requestRow({ estado_codigo: "pendiente_confirmacion", reautenticado_at: null }),
  });

  await assert.rejects(execute(client), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_REQUEST_STATE_INVALID");
    return true;
  });
});

test("replay de solicitud procesando no repite operaciones", async () => {
  const client = createExecutionClient({
    request: requestRow({ estado_codigo: "procesando", procesando_at: freshIso() }),
  });

  const result = await execute(client);

  assert.deepEqual(result, {
    processed: true,
    ready_for_anonymization: true,
    idempotent_replay: true,
  });
  assert.ok(!client.calls.some((call) => /UPDATE public\./.test(call.sql)));
  assert.equal(client.counters.pointsInserts, 0);
});

test("membresia activa se cancela con eliminacion_cuenta", async () => {
  const client = createExecutionClient({ rowCounts: { subscriptions: 2 } });
  const result = await execute(client);
  const sql = client.calls.find((call) => call.sql.includes("UPDATE public.subscriptions")).sql;

  assert.equal(result.internal_execution.subscriptions_cancelled, 2);
  assert.match(sql, /estado_suscripcion_codigo = 'cancelada'/);
  assert.match(sql, /motivo_fin_codigo = 'eliminacion_cuenta'/);
});

test("orden pendiente se cancela", async () => {
  const client = createExecutionClient({ rowCounts: { orders: 3 } });
  const result = await execute(client);
  const sql = client.calls.find((call) => call.sql.includes("UPDATE public.membership_purchase_orders")).sql;

  assert.equal(result.internal_execution.membership_orders_cancelled, 3);
  assert.match(sql, /estado_orden_codigo = 'pendiente_pago'/);
  assert.match(sql, /estado_orden_codigo = 'cancelada'/);
});

test("saldo positivo genera ajuste_resta", async () => {
  const client = createExecutionClient({ balances: [12, 0] });

  await execute(client);

  const insert = client.calls.find((call) => call.sql.includes("INSERT INTO public.points_transactions"));
  assert.ok(insert);
  assert.equal(insert.params[1], 12);
  assert.match(insert.sql, /'ajuste_resta'/);
  assert.match(insert.sql, /'sistema'/);
});

test("saldo final debe ser cero", async () => {
  const client = createExecutionClient({ balances: [7, 0] });

  const result = await execute(client);

  assert.equal(result.internal_execution.points_balance_after, 0);
});

test("saldo cero no genera movimiento", async () => {
  const client = createExecutionClient({ balances: [0, 0] });

  const result = await execute(client);

  assert.equal(result.internal_execution.points_forfeited, 0);
  assert.equal(client.counters.pointsInserts, 0);
});

test("ciclo activo se cierra", async () => {
  const client = createExecutionClient({ rowCounts: { cycles: 2 } });
  const result = await execute(client);

  assert.equal(result.internal_execution.points_cycles_closed, 2);
  assert.ok(client.calls.some((call) => call.sql.includes("estado_ciclo_codigo = 'cerrado'")));
});

test("sesiones activas se revocan", async () => {
  const client = createExecutionClient({ rowCounts: { sessions: 4 } });
  const result = await execute(client);
  const sql = client.calls.find((call) => call.sql.includes("UPDATE public.seguridad_sesiones")).sql;

  assert.equal(result.internal_execution.sessions_revoked, 4);
  assert.match(sql, /estado = 'activa'/);
  assert.match(sql, /estado = 'revocada'/);
  assert.match(sql, /motivo_cierre = 'eliminacion_cuenta'/);
});

test("roles activos se desactivan", async () => {
  const client = createExecutionClient({ rowCounts: { roles: 1 } });
  const result = await execute(client);

  assert.equal(result.internal_execution.roles_disabled, 1);
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE public.roles_usuarios")));
});

test("usuario queda inactivo y con password_hash null", async () => {
  const client = createExecutionClient();
  await execute(client);
  const sql = client.calls.find((call) => call.sql.includes("UPDATE public.usuarios")).sql;

  assert.match(sql, /estado = FALSE/);
  assert.match(sql, /estado_acceso = 'inactivo'/);
  assert.match(sql, /password_hash = NULL/);
});

test("cliente queda inactivo pero anonimizado permanece false", async () => {
  const client = createExecutionClient();
  await execute(client);
  const sql = client.calls.find((call) => call.sql.includes("UPDATE public.clientes")).sql;

  assert.match(sql, /estado = FALSE/);
  assert.match(sql, /consentimiento_marketing = FALSE/);
  assert.doesNotMatch(sql, /\banonimizado\s*=/i);
  assert.match(sql, /COALESCE\(anonimizado, FALSE\) IS FALSE/);
});

test("error de reconciliacion de puntos provoca rollback", async () => {
  const client = createExecutionClient({ balances: [7, 3] });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionInternal(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      authenticatedAt: freshIso(),
      traceRequestId: TRACE_ID,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_POINTS_RECONCILIATION_FAILED" }
  );
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql === "COMMIT"));
});

test("error intermedio provoca rollback", async () => {
  const throwOn = (sql) => sql.includes("UPDATE public.seguridad_sesiones");
  const client = createExecutionClient({ throwOn });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionInternal(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      authenticatedAt: freshIso(),
      traceRequestId: TRACE_ID,
    }),
    /forced/
  );
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql === "COMMIT"));
});

test("conexion siempre se libera", async () => {
  const client = createExecutionClient();
  const app = makeApp(client);

  await runClientAccountDeletionInternal(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: freshIso(),
    traceRequestId: TRACE_ID,
  });

  assert.equal(client.released, true);
});

test("40001 se transforma en error funcional controlado", async () => {
  const throwOn = (sql) => sql.includes("FROM app_private.solicitudes_eliminacion_cuenta");
  throwOn.code = "40001";
  const client = createExecutionClient({ throwOn });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionInternal(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      authenticatedAt: freshIso(),
      traceRequestId: TRACE_ID,
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "CLIENT_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED");
      return true;
    }
  );
  assert.equal(client.released, true);
});

test("wrapper usa transaccion serializable y advisory lock", async () => {
  const client = createExecutionClient();
  const app = makeApp(client);

  await runClientAccountDeletionInternal(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: freshIso(),
    traceRequestId: TRACE_ID,
  });

  assert.equal(client.calls[0].sql, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.ok(client.calls[1].sql.includes("pg_advisory_xact_lock"));
  assert.equal(client.calls[1].params[0], USUARIO_ID);
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
});

test("consultas no modifican tablas PII prohibidas", async () => {
  const client = createExecutionClient({ balances: [8, 0] });
  await execute(client);
  const joinedSql = client.calls.map((call) => call.sql).join("\n");

  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.personas\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.correos\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.citas\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.citas_integrantes\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.citas_grupos\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.facturas\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.comprobantes_agendamiento\b/i);
  assert.doesNotMatch(joinedSql, /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.storage_assets\b/i);
  assert.doesNotMatch(joinedSql, /\bauth\.users\b/i);
});
