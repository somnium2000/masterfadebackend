import test from "node:test";
import assert from "node:assert/strict";

import {
  finalizeClientAccountDeletionAuthCleanup,
  runClientAccountDeletionAuthCleanup,
} from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const TRACE_ID = "req-auth-001";

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: "DEL-ABCDEF123456",
    estado_codigo: "auth_pendiente",
    resumen_impacto: {
      existing: true,
      internal_anonymization: {
        pii_anonymized: true,
        storage_asset_ids: [],
        storage_assets_pending: 0,
        storage_processed: true,
        auth_processed: false,
      },
    },
    procesando_at: new Date().toISOString(),
    completado_at: null,
    auth_user_id_pendiente: USUARIO_ID,
    ...overrides,
  };
}

function preconditions(overrides = {}) {
  return {
    user_ready: true,
    client_ready: true,
    person_ready: true,
    roles_ready: true,
    protected_ready: true,
    emails_ready: true,
    storage_ready: true,
    memberships_ready: true,
    points_ready: true,
    ...overrides,
  };
}

function notFoundError(overrides = {}) {
  return { status: 404, code: "user_not_found", message: "User not found", ...overrides };
}

function makeAuth({
  getResults = [{ user: true }, { error: notFoundError() }],
  deleteResults = [{ error: null }],
} = {}) {
  const calls = [];
  const getQueue = [...getResults];
  const deleteQueue = [...deleteResults];
  return {
    calls,
    admin: {
      async getUserById(id) {
        calls.push({ type: "getUserById", id });
        const next = getQueue.length ? getQueue.shift() : { error: notFoundError() };
        if (next.error) return { data: { user: null }, error: next.error };
        return { data: { user: next.user === false ? null : { id: next.id || id, email: "hidden@example.invalid" } }, error: null };
      },
      async deleteUser(id, shouldSoftDelete) {
        calls.push({ type: "deleteUser", id, shouldSoftDelete });
        const next = deleteQueue.length ? deleteQueue.shift() : { error: null };
        return { data: {}, error: next.error || null };
      },
    },
  };
}

function makeSupabase(auth = makeAuth()) {
  const storageCalls = [];
  return {
    auth,
    storage: {
      from(bucket) {
        storageCalls.push({ type: "from", bucket });
        return {
          async remove(paths) {
            storageCalls.push({ type: "remove", paths });
            return { data: [], error: null };
          },
        };
      },
    },
    storageCalls,
  };
}

function createClient({
  request = requestRow(),
  preconditionRow = preconditions(),
  throwOn = null,
} = {}) {
  const calls = [];
  let released = false;
  const counters = { queryIndex: 0 };
  return {
    calls,
    counters,
    get released() {
      return released;
    },
    release() {
      released = true;
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
      if (text.includes("pg_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("FOR UPDATE")) {
        if (text.includes("SELECT resumen_impacto")) {
          return { rows: request ? [{ resumen_impacto: request.resumen_impacto }] : [] };
        }
        return { rows: request ? [request] : [] };
      }
      if (text.includes("AS user_ready") && text.includes("AS points_ready")) {
        return { rows: [preconditionRow] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) {
        const completed = text.includes("estado_codigo = 'completada'");
        return {
          rowCount: 1,
          rows: completed
            ? [{
                id_solicitud: REQUEST_ID,
                referencia_publica: "DEL-ABCDEF123456",
                estado_codigo: "completada",
                completado_at: new Date().toISOString(),
              }]
            : [],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function makeApp(client, supabase = makeSupabase()) {
  return {
    db: {
      async connect() {
        return client;
      },
    },
    supabaseAdmin: supabase,
  };
}

function cleanup(client, app = makeApp(client), overrides = {}) {
  return runClientAccountDeletionAuthCleanup(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    traceRequestId: TRACE_ID,
    ...overrides,
  });
}

function finalize(client, overrides = {}) {
  return finalizeClientAccountDeletionAuthCleanup(client, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    traceRequestId: TRACE_ID,
    authUserAlreadyAbsent: false,
    ...overrides,
  });
}

function allSql(client) {
  return client.calls.map((call) => call.sql).join("\n");
}

function authCalls(supabase, type) {
  return supabase.auth.calls.filter((call) => call.type === type);
}

test("solicitud auth_pendiente valida completa", async () => {
  const client = createClient();
  const result = await cleanup(client);
  assert.equal(result.completed, true);
  assert.equal(result.request.estado_codigo, "completada");
});

test("solicitud inexistente devuelve 404", async () => {
  const client = createClient({ request: null });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND" });
});

test("estado invalido se rechaza", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "storage_pendiente" }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_STATE_INVALID" });
});

test("replay completada devuelve idempotente", async () => {
  const client = createClient({
    request: requestRow({ estado_codigo: "completada", completado_at: new Date().toISOString(), auth_user_id_pendiente: null }),
  });
  const result = await cleanup(client);
  assert.equal(result.idempotent_replay, true);
});

test("replay no llama Auth", async () => {
  const client = createClient({
    request: requestRow({ estado_codigo: "completada", completado_at: new Date().toISOString(), auth_user_id_pendiente: null }),
  });
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.equal(supabase.auth.calls.length, 0);
});

test("app.supabaseAdmin ausente rechaza", async () => {
  const client = createClient();
  await assert.rejects(cleanup(client, { db: { async connect() { return client; } } }), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_UNAVAILABLE",
  });
  assert.equal(client.calls.length, 0);
});

test("getUserById ausente rechaza", async () => {
  const client = createClient();
  await assert.rejects(cleanup(client, { db: { async connect() { return client; } }, supabaseAdmin: { auth: { admin: { deleteUser() {} } } } }), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_UNAVAILABLE",
  });
});

test("deleteUser ausente rechaza", async () => {
  const client = createClient();
  await assert.rejects(cleanup(client, { db: { async connect() { return client; } }, supabaseAdmin: { auth: { admin: { getUserById() {} } } } }), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_UNAVAILABLE",
  });
});

test("UUID pendiente no coincide rechaza", async () => {
  const client = createClient({ request: requestRow({ auth_user_id_pendiente: "99999999-9999-4999-8999-999999999999" }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_IDENTITY_MISMATCH" });
});

test("usuario interno activo rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ user_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("usuario sin deleted_at rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ user_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("cliente no anonimizado rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ client_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("persona aun contiene PII rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ person_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("rol activo rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ roles_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("usuario protegido rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ protected_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("correo interno activo rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ emails_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("activo Storage pendiente rechaza", async () => {
  const client = createClient({
    request: requestRow({
      resumen_impacto: { internal_anonymization: { storage_asset_ids: [ASSET_ID], storage_assets_pending: 0 } },
    }),
    preconditionRow: preconditions({ storage_ready: false }),
  });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("activo Storage fallido rechaza", async () => {
  const client = createClient({
    request: requestRow({
      resumen_impacto: { internal_anonymization: { storage_asset_ids: [ASSET_ID], storage_assets_pending: 1 } },
    }),
  });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("membresia activa rechaza", async () => {
  const client = createClient({ preconditionRow: preconditions({ memberships_ready: false }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_AUTH_PRECONDITION_FAILED" });
});

test("identidad Auth existente se elimina con false", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.equal(authCalls(supabase, "deleteUser")[0].shouldSoftDelete, false);
});

test("deleteUser recibe exactamente UUID esperado", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.equal(authCalls(supabase, "deleteUser")[0].id, USUARIO_ID);
});

test("no se envia correo a deleteUser", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.notEqual(authCalls(supabase, "deleteUser")[0].id, "hidden@example.invalid");
});

test("Auth ya inexistente se trata como exito", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: notFoundError() }] }));
  const result = await cleanup(client, makeApp(client, supabase));
  assert.equal(result.completed, true);
  assert.equal(authCalls(supabase, "deleteUser").length, 0);
});

test("error 404 se clasifica como inexistente", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: { status: 404, message: "missing" } }] }));
  const result = await cleanup(client, makeApp(client, supabase));
  assert.equal(result.completed, true);
});

test("error Auth generico no se clasifica como inexistente", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: { status: 500, code: "server_error" } }] }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
  });
});

test("deleteUser exitoso exige verificacion posterior", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.equal(authCalls(supabase, "getUserById").length, 2);
});

test("deleteUser devuelve error pero Auth ya no existe", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({
    getResults: [{ user: true }, { error: notFoundError() }, { error: notFoundError() }],
    deleteResults: [{ error: { status: 503, code: "timeout" } }],
  }));
  const result = await cleanup(client, makeApp(client, supabase));
  assert.equal(result.completed, true);
});

test("deleteUser devuelve error y Auth continua existiendo", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({
    getResults: [{ user: true }, { user: true }],
    deleteResults: [{ error: { status: 503, code: "timeout" } }],
  }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE",
  });
});

test("verificacion devuelve todavia usuario", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ user: true }, { user: true }] }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)), {
    code: "CLIENT_ACCOUNT_DELETION_AUTH_VERIFICATION_FAILED",
  });
});

test("fallo mantiene auth_pendiente", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: { status: 500 } }] }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)));
  assert.match(allSql(client), /SET estado_codigo = 'auth_pendiente'/);
});

test("fallo conserva auth_user_id_pendiente", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: { status: 500 } }] }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)));
  assert.match(allSql(client), /auth_user_id_pendiente = \$2::uuid/);
});

test("fallo no establece fallido_at", async () => {
  const client = createClient();
  const supabase = makeSupabase(makeAuth({ getResults: [{ error: { status: 500 } }] }));
  await assert.rejects(cleanup(client, makeApp(client, supabase)));
  assert.doesNotMatch(allSql(client), /fallido_at\s*=/);
});

test("exito cambia a completada", async () => {
  const client = createClient();
  await cleanup(client);
  assert.match(allSql(client), /estado_codigo = 'completada'/);
});

test("exito establece completado_at", async () => {
  const client = createClient();
  const result = await cleanup(client);
  assert.ok(result.request.completado_at);
});

test("exito limpia auth_user_id_pendiente", async () => {
  const client = createClient();
  await cleanup(client);
  assert.match(allSql(client), /auth_user_id_pendiente = NULL/);
});

test("exito limpia errores tecnicos", async () => {
  const client = createClient();
  await cleanup(client);
  assert.match(allSql(client), /error_codigo = NULL[\s\S]*error_detalle_tecnico = NULL/);
});

test("resumen conserva contenido anterior", async () => {
  const client = createClient();
  await cleanup(client);
  const update = client.calls.find((call) => String(call.sql).includes("estado_codigo = 'completada'"));
  const resumen = JSON.parse(update.params[2]);
  assert.equal(resumen.existing, true);
  assert.equal(resumen.auth_cleanup.auth_processed, true);
});

test("respuesta no contiene UUID Auth", async () => {
  const client = createClient();
  const result = await cleanup(client);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(USUARIO_ID, "i"));
});

test("no elimina ninguna fila interna", async () => {
  const client = createClient();
  await cleanup(client);
  assert.doesNotMatch(allSql(client), /DELETE FROM public\.(usuarios|personas|clientes|correos)/i);
});

test("no llama Storage API", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));
  assert.equal(supabase.storageCalls.length, 0);
});

test("advisory lock siempre se libera", async () => {
  const client = createClient();
  await cleanup(client);
  assert.match(allSql(client), /pg_advisory_unlock/);
});

test("conexion siempre se libera", async () => {
  const client = createClient();
  await cleanup(client);
  assert.equal(client.released, true);
});

test("error intermedio no deja transaccion abierta", async () => {
  const throwOn = (sql) => String(sql).includes("estado_codigo = 'completada'");
  const client = createClient({ throwOn });
  await assert.rejects(cleanup(client));
  assert.match(allSql(client), /ROLLBACK/);
});

test("40001 se mapea correctamente", async () => {
  const throwOn = (sql) => String(sql).includes("AS user_ready");
  throwOn.code = "40001";
  const client = createClient({ throwOn });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED" });
});

test("estado terminal no se actualiza en replay", async () => {
  const client = createClient({
    request: requestRow({ estado_codigo: "completada", completado_at: new Date().toISOString(), auth_user_id_pendiente: null }),
  });
  await cleanup(client);
  assert.doesNotMatch(allSql(client), /UPDATE app_private\.solicitudes_eliminacion_cuenta/);
});

test("finalizacion exportada no llama Auth", async () => {
  const client = createClient();
  const result = await finalize(client);
  assert.equal(result.completed, true);
  assert.doesNotMatch(allSql(client), /BEGIN|COMMIT|ROLLBACK/);
});
