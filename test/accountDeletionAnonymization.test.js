import test from "node:test";
import assert from "node:assert/strict";

import {
  anonymizeClientAccountDeletionInternal,
  runClientAccountDeletionAnonymization,
} from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const TRACE_ID = "req-anon-001";

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: "DEL-ABCDEF123456",
    estado_codigo: "procesando",
    resumen_impacto: { existing: true },
    procesando_at: new Date().toISOString(),
    auth_user_id_pendiente: USUARIO_ID,
    ...overrides,
  };
}

function preconditions(overrides = {}) {
  return {
    user_ready: true,
    client_ready: true,
    roles_ready: true,
    memberships_ready: true,
    points_ready: true,
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    person_redacted: true,
    client_redacted: true,
    original_emails_absent: true,
    appointments_redacted: true,
    members_redacted: true,
    receipts_redacted: true,
    orders_redacted: true,
    notifications_redacted: true,
    communications_redacted: true,
    sessions_redacted: true,
    login_logs_redacted: true,
    audit_logs_redacted: true,
    bitacoras_redacted: true,
    ...overrides,
  };
}

function createClient({
  request = requestRow(),
  clientAnonymized = true,
  preconditionRow = preconditions(),
  verifyRow = verification(),
  storageAssets = [],
  throwOn = null,
} = {}) {
  const calls = [];
  const released = { value: false };
  return {
    calls,
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

      if (throwOn?.(text, params)) {
        const error = new Error("forced");
        if (typeof throwOn.code === "string") error.code = throwOn.code;
        throw error;
      }

      if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE") return { rows: [] };
      if (text === "COMMIT") return { rows: [] };
      if (text === "ROLLBACK") return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("FOR UPDATE")) {
        return { rows: request ? [request] : [] };
      }
      if (text.includes("SELECT COALESCE(c.anonimizado, FALSE) AS anonimizado")) {
        return { rows: [{ anonimizado: clientAnonymized }] };
      }
      if (text.includes("AS user_ready") && text.includes("AS points_ready")) {
        return { rows: [preconditionRow] };
      }
      if (text.includes("array_agg(id_asset")) {
        return { rows: [{ asset_ids: storageAssets, asset_count: storageAssets.length }] };
      }
      if (text.includes("SELECT COUNT(*)::int AS count FROM mf_ad_facturas_emitidas")) {
        return { rows: [{ count: 2 }] };
      }
      if (text.includes("AS person_redacted") && text.includes("AS bitacoras_redacted")) {
        return { rows: [verifyRow] };
      }
      if (text.includes("RETURNING id_solicitud, referencia_publica, estado_codigo")) {
        return {
          rowCount: 1,
          rows: [{
            id_solicitud: REQUEST_ID,
            referencia_publica: "DEL-ABCDEF123456",
            estado_codigo: storageAssets.length > 0 ? "storage_pendiente" : "auth_pendiente",
          }],
        };
      }
      if (text.includes("UPDATE public.personas")) return { rowCount: 1, rows: [] };
      if (text.includes("UPDATE public.clientes")) return { rowCount: 1, rows: [] };
      if (text.includes("UPDATE public.usuarios")) return { rowCount: 1, rows: [] };
      if (text.includes("INSERT INTO mf_ad_bitacora_targets")) return { rowCount: 1, rows: [] };
      if (/UPDATE public\./.test(text)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
}

function runInternal(client, overrides = {}) {
  return anonymizeClientAccountDeletionInternal(client, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
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

function allSql(client) {
  return client.calls.map((call) => call.sql).join("\n");
}

test("solicitud procesando valida se anonimiza", async () => {
  const client = createClient();
  const result = await runInternal(client);

  assert.equal(result.anonymized, true);
  assert.equal(result.idempotent_replay, false);
  assert.equal(result.request.estado_codigo, "auth_pendiente");
  assert.equal(result.ready_for_auth_cleanup, true);
});

test("solicitud inexistente devuelve 404 controlado", async () => {
  const client = createClient({ request: null });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND" });
});

test("estado invalido se rechaza", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "evaluada" }) });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_ANONYMIZATION_STATE_INVALID" });
});

test("replay storage_pendiente no modifica tablas", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "storage_pendiente" }) });
  const result = await runInternal(client);

  assert.equal(result.idempotent_replay, true);
  assert.ok(!/UPDATE public\./.test(allSql(client)));
});

test("replay auth_pendiente no modifica tablas", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "auth_pendiente" }) });
  const result = await runInternal(client);

  assert.equal(result.idempotent_replay, true);
  assert.ok(!/UPDATE public\./.test(allSql(client)));
});

test("usuario no desactivado rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ user_ready: false }) });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED" });
});

test("cliente no desactivado rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ client_ready: false }) });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED" });
});

test("roles activos rechazan", async () => {
  const client = createClient({ preconditionRow: preconditions({ roles_ready: false }) });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED" });
});

test("membresia activa rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ memberships_ready: false }) });
  await assert.rejects(runInternal(client), { code: "CLIENT_ACCOUNT_DELETION_INTERNAL_PRECONDITION_FAILED" });
});

test("persona queda como Cliente eliminado", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /UPDATE public\.personas[\s\S]*nombres = 'Cliente'[\s\S]*apellidos = 'eliminado'/);
});

test("cliente queda anonimizado true", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /UPDATE public\.clientes[\s\S]*anonimizado = TRUE/);
});

test("usuario conserva fila historica", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /UPDATE public\.usuarios/);
  assert.doesNotMatch(allSql(client), /DELETE FROM public\.usuarios/i);
});

test("correos reciben tombstones unicos", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /deleted\+correo-[\s\S]*@anon\.masterfade\.invalid/);
});

test("correo original queda liberado", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /original_emails_absent/);
});

test("citas preservan historia y limpian contacto", async () => {
  const client = createClient();
  await runInternal(client);
  const sql = allSql(client);
  assert.match(sql, /UPDATE public\.citas/);
  assert.match(sql, /contacto_nombre = 'Cliente eliminado'/);
  assert.doesNotMatch(sql, /estado_cita_codigo\s*=/);
});

test("solo integrantes relacionados se anonimizan", async () => {
  const client = createClient();
  await runInternal(client);
  const sql = allSql(client);
  assert.match(sql, /mf_ad_integrantes/);
  assert.match(sql, /UPDATE public\.citas_integrantes/);
});

test("grupos limpian tokens", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /release_token = NULL[\s\S]*release_token_hash = NULL/);
});

test("comprobantes no fiscales se anonimizan", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /tipo_comprobante_codigo = 'agendamiento_no_fiscal'/);
});

test("destinatarios no relacionados permanecen intactos", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /tipo_destinatario_codigo = 'titular'[\s\S]*lower\(cad\.email_destinatario_snapshot\)/);
});

test("ordenes usan helper JSON", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /membership_purchase_orders[\s\S]*fn_redact_account_pii_jsonb_v1\(cliente_snapshot\)/);
});

test("facturas emitidas se conservan", async () => {
  const client = createClient();
  await runInternal(client);
  const sql = allSql(client);
  const invoiceUpdate = client.calls.find((call) => call.sql.includes("UPDATE public.facturas f"))?.sql ?? "";
  assert.match(sql, /mf_ad_facturas_emitidas/);
  assert.match(invoiceUpdate, /mf_ad_facturas_no_emitidas/);
  assert.doesNotMatch(invoiceUpdate, /mf_ad_facturas_emitidas/);
});

test("facturas no emitidas se anonimizan", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /UPDATE public\.facturas f[\s\S]*mf_ad_facturas_no_emitidas/);
});

test("notificaciones pendientes se cancelan", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /estado_notificacion_codigo IN \('pendiente', 'procesando'\) THEN 'cancelada'/);
});

test("comunicaciones pendientes se omiten", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /estado_envio IN \('pendiente', 'enviando'\) THEN 'omitido'/);
});

test("seguridad pierde IP email user-agent", async () => {
  const client = createClient();
  await runInternal(client);
  const sql = allSql(client);
  assert.match(sql, /seguridad_sesiones[\s\S]*ip_inicio = NULL[\s\S]*user_agent = NULL/);
  assert.match(sql, /seguridad_login_logs[\s\S]*email_masked = NULL[\s\S]*user_agent = NULL/);
});

test("bitacoras se redactan", async () => {
  const client = createClient();
  await runInternal(client);
  assert.match(allSql(client), /UPDATE public\.bitacoras[\s\S]*fn_redact_account_pii_jsonb_v1/);
});

test("activos Storage producen storage_pendiente", async () => {
  const client = createClient({ storageAssets: ["55555555-5555-4555-8555-555555555555"] });
  const result = await runInternal(client);

  assert.equal(result.request.estado_codigo, "storage_pendiente");
  assert.equal(result.ready_for_storage_cleanup, true);
});

test("sin activos produce auth_pendiente", async () => {
  const client = createClient({ storageAssets: [] });
  const result = await runInternal(client);

  assert.equal(result.request.estado_codigo, "auth_pendiente");
  assert.equal(result.ready_for_auth_cleanup, true);
});

test("no se modifica storage_assets", async () => {
  const client = createClient();
  await runInternal(client);
  assert.doesNotMatch(allSql(client), /\b(UPDATE|DELETE FROM)\s+public\.storage_assets\b/i);
});

test("no se modifica Auth", async () => {
  const client = createClient();
  await runInternal(client);
  const sql = allSql(client);
  assert.doesNotMatch(sql, /auth\.users/i);
  assert.doesNotMatch(sql, /deleteUser/i);
});

test("error de verificacion produce rollback", async () => {
  const client = createClient({ verifyRow: verification({ person_redacted: false }) });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionAnonymization(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      traceRequestId: TRACE_ID,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_ANONYMIZATION_VERIFICATION_FAILED" }
  );
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
});

test("error intermedio produce rollback", async () => {
  const throwOn = (sql) => sql.includes("UPDATE public.comunicaciones_envios");
  const client = createClient({ throwOn });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionAnonymization(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      traceRequestId: TRACE_ID,
    }),
    /forced/
  );
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
});

test("conexion siempre se libera", async () => {
  const client = createClient();
  const app = makeApp(client);

  await runClientAccountDeletionAnonymization(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    traceRequestId: TRACE_ID,
  });

  assert.equal(client.released, true);
});

test("error 40001 se mapea correctamente", async () => {
  const throwOn = (sql) => sql.includes("FROM app_private.solicitudes_eliminacion_cuenta");
  throwOn.code = "40001";
  const client = createClient({ throwOn });
  const app = makeApp(client);

  await assert.rejects(
    runClientAccountDeletionAnonymization(app, {
      deletionRequestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      traceRequestId: TRACE_ID,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED" }
  );
});

test("wrapper usa serializable y advisory lock", async () => {
  const client = createClient();
  const app = makeApp(client);

  await runClientAccountDeletionAnonymization(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    traceRequestId: TRACE_ID,
  });

  assert.equal(client.calls[0].sql, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  assert.ok(client.calls[1].sql.includes("pg_advisory_xact_lock"));
  assert.equal(client.calls[1].params[0], USUARIO_ID);
});
