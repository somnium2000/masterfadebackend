import test from "node:test";
import assert from "node:assert/strict";

import { runClientAccountDeletionStorageCleanup } from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const ASSET_ID_2 = "66666666-6666-4666-8666-666666666666";
const TRACE_ID = "req-storage-001";

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: "DEL-ABCDEF123456",
    estado_codigo: "storage_pendiente",
    resumen_impacto: {
      internal_anonymization: {
        storage_asset_ids: [ASSET_ID],
        storage_assets_pending: 1,
      },
    },
    procesando_at: new Date().toISOString(),
    auth_user_id_pendiente: USUARIO_ID,
    ...overrides,
  };
}

function assetRow(overrides = {}) {
  return {
    id_asset: ASSET_ID,
    bucket_name: "imagenes_privadas",
    object_path: "clientes/avatar.png",
    status: "activo",
    deleted_at: null,
    owner_cliente_id: CLIENTE_ID,
    owner_user_id: USUARIO_ID,
    entity_id: PERSONA_ID,
    ...overrides,
  };
}

function makeSupabase({ removeError = null } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      admin: {
        async deleteUser() {
          calls.push({ type: "deleteUser" });
        },
      },
    },
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            calls.push({ type: "remove", bucket, paths });
            return removeError ? { data: null, error: removeError } : { data: [], error: null };
          },
        };
      },
    },
  };
}

function createClient({
  request = requestRow(),
  clientAnonymized = true,
  preconditions = { client_ready: true, user_ready: true },
  assets = [assetRow()],
  objectAbsent = [false, true],
  throwOn = null,
} = {}) {
  const calls = [];
  const updatedAssets = [];
  const counters = {
    absent: 0,
    queryIndex: 0,
  };
  let released = false;

  return {
    calls,
    updatedAssets,
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
        return { rows: request ? [request] : [] };
      }
      if (text.includes("SELECT COALESCE(c.anonimizado, FALSE) AS anonimizado")) {
        return { rows: [{ anonimizado: clientAnonymized }] };
      }
      if (text.includes("AS client_ready") && text.includes("AS user_ready")) {
        return { rows: [preconditions] };
      }
      if (text.includes("FROM public.storage_assets") && text.includes("FOR UPDATE")) {
        return { rows: assets };
      }
      if (text.includes("FROM storage.objects")) {
        const value = objectAbsent[Math.min(counters.absent, objectAbsent.length - 1)];
        counters.absent += 1;
        return { rows: [{ object_absent: value }] };
      }
      if (text.includes("UPDATE public.storage_assets") && text.includes("status = 'eliminado'")) {
        updatedAssets.push({ status: "eliminado", params, sql: text });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("UPDATE public.storage_assets") && text.includes("status = 'fallido'")) {
        updatedAssets.push({ status: "fallido", params, sql: text });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) {
        const estado = text.includes("SET estado_codigo = 'auth_pendiente'") ? "auth_pendiente" : params[1];
        return {
          rowCount: 1,
          rows: [{
            id_solicitud: REQUEST_ID,
            referencia_publica: "DEL-ABCDEF123456",
            estado_codigo: estado,
          }],
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
  return runClientAccountDeletionStorageCleanup(app, {
    deletionRequestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    traceRequestId: TRACE_ID,
    ...overrides,
  });
}

function allSql(client) {
  return client.calls.map((call) => call.sql).join("\n");
}

test("solicitud storage_pendiente valida procesa Storage", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.storage_processed, true);
  assert.equal(result.ready_for_auth_cleanup, true);
  assert.equal(supabase.calls.filter((call) => call.type === "remove").length, 1);
});

test("solicitud inexistente devuelve 404", async () => {
  const client = createClient({ request: null });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_REQUEST_NOT_FOUND" });
});

test("estado invalido se rechaza", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "procesando" }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_STATE_INVALID" });
});

test("replay auth_pendiente devuelve idempotente", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "auth_pendiente" }) });
  const supabase = makeSupabase();
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.idempotent_replay, true);
  assert.equal(supabase.calls.filter((call) => call.type === "remove").length, 0);
});

test("cliente no anonimizado rechaza", async () => {
  const client = createClient({ preconditions: { client_ready: false, user_ready: true } });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_PRECONDITION_FAILED" });
});

test("usuario no inactivo rechaza", async () => {
  const client = createClient({ preconditions: { client_ready: true, user_ready: false } });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_PRECONDITION_FAILED" });
});

test("app.supabaseAdmin ausente rechaza antes de conectar", async () => {
  const client = createClient();
  await assert.rejects(cleanup(client, { db: { async connect() { return client; } } }), {
    code: "CLIENT_ACCOUNT_DELETION_STORAGE_UNAVAILABLE",
  });
  assert.equal(client.calls.length, 0);
});

test("arreglo de activos vacio pasa a auth_pendiente sin llamar Storage", async () => {
  const client = createClient({
    request: requestRow({ resumen_impacto: { internal_anonymization: { storage_asset_ids: [] } } }),
    assets: [],
  });
  const supabase = makeSupabase();
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.storage_processed, true);
  assert.equal(result.storage_cleanup.total_assets, 0);
  assert.equal(supabase.calls.length, 0);
});

test("JSON de IDs invalido rechaza", async () => {
  const client = createClient({ request: requestRow({ resumen_impacto: { internal_anonymization: {} } }) });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_REFERENCES_INVALID" });
});

test("UUID duplicado rechaza", async () => {
  const client = createClient({
    request: requestRow({ resumen_impacto: { internal_anonymization: { storage_asset_ids: [ASSET_ID, ASSET_ID] } } }),
  });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_REFERENCES_INVALID" });
});

test("activo inexistente en storage_assets rechaza", async () => {
  const client = createClient({ assets: [] });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_ASSET_NOT_FOUND" });
});

test("activo ajeno rechaza sin llamar Storage", async () => {
  const client = createClient({ assets: [assetRow({ owner_cliente_id: null, owner_user_id: null, entity_id: null })] });
  const supabase = makeSupabase();
  await assert.rejects(cleanup(client, makeApp(client, supabase)), {
    code: "CLIENT_ACCOUNT_DELETION_STORAGE_ASSET_OWNERSHIP_INVALID",
  });
  assert.equal(supabase.calls.length, 0);
});

test("bucket invalido rechaza", async () => {
  const client = createClient({ assets: [assetRow({ bucket_name: "otro_bucket" })] });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_BUCKET_INVALID" });
});

test("path vacio rechaza", async () => {
  const client = createClient({ assets: [assetRow({ object_path: "" })] });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_PATH_INVALID" });
});

test("path con protocolo rechaza", async () => {
  const client = createClient({ assets: [assetRow({ object_path: "https://example.com/a.png" })] });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_PATH_INVALID" });
});

test("path con traversal rechaza", async () => {
  const client = createClient({ assets: [assetRow({ object_path: "clientes/../secret.png" })] });
  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_PATH_INVALID" });
});

test("objeto ya ausente se considera exito", async () => {
  const client = createClient({ objectAbsent: [true] });
  const supabase = makeSupabase();
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.storage_processed, true);
  assert.equal(supabase.calls.length, 0);
});

test("activo ya eliminado se omite y cuenta already_deleted", async () => {
  const client = createClient({ assets: [assetRow({ status: "eliminado", deleted_at: new Date().toISOString() })] });
  const supabase = makeSupabase();
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.storage_cleanup.already_deleted_assets, 1);
  assert.equal(supabase.calls.length, 0);
});

test("eliminacion externa exitosa", async () => {
  const client = createClient({ objectAbsent: [false, true] });
  const result = await cleanup(client);

  assert.equal(result.storage_cleanup.deleted_assets, 1);
});

test("API devuelve error pero objeto ausente es exito", async () => {
  const client = createClient({ objectAbsent: [false, true] });
  const supabase = makeSupabase({ removeError: { code: "ProviderError" } });
  const result = await cleanup(client, makeApp(client, supabase));

  assert.equal(result.storage_processed, true);
});

test("API devuelve exito pero objeto permanece genera fallo", async () => {
  const client = createClient({ objectAbsent: [false, false] });
  const result = await cleanup(client);

  assert.equal(result.storage_processed, false);
  assert.equal(result.retryable, true);
  assert.equal(result.failed_assets, 1);
});

test("activo exitoso pasa a eliminado", async () => {
  const client = createClient();
  await cleanup(client);

  assert.equal(client.updatedAssets[0].status, "eliminado");
});

test("path se reemplaza por tombstone", async () => {
  const client = createClient();
  await cleanup(client);

  assert.match(client.updatedAssets[0].sql, /object_path = 'deleted\/account-deletion\/' \|\| replace/);
});

test("propietarios se limpian tras exito", async () => {
  const client = createClient();
  await cleanup(client);

  assert.match(client.updatedAssets[0].sql, /owner_user_id = NULL[\s\S]*owner_cliente_id = NULL[\s\S]*entity_id = NULL/);
});

test("activo fallido conserva path para reintento", async () => {
  const client = createClient({ objectAbsent: [false, false] });
  await cleanup(client);

  assert.equal(client.updatedAssets[0].status, "fallido");
  assert.doesNotMatch(client.updatedAssets[0].sql, /object_path\s*=/);
});

test("fallo parcial mantiene storage_pendiente", async () => {
  const client = createClient({ objectAbsent: [false, false] });
  const result = await cleanup(client);

  assert.equal(result.request.estado_codigo, "storage_pendiente");
});

test("exito total pasa a auth_pendiente", async () => {
  const client = createClient();
  const result = await cleanup(client);

  assert.equal(result.request.estado_codigo, "auth_pendiente");
});

test("auth_user_id_pendiente se conserva", async () => {
  const client = createClient();
  await cleanup(client);

  assert.match(allSql(client), /auth_user_id_pendiente = \$5::uuid/);
});

test("no se llama Auth API", async () => {
  const client = createClient();
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));

  assert.equal(supabase.calls.some((call) => call.type === "deleteUser"), false);
});

test("no modifica persona cliente citas o facturas", async () => {
  const client = createClient();
  await cleanup(client);
  const sql = allSql(client);

  assert.doesNotMatch(sql, /UPDATE public\.(personas|clientes|citas|facturas)\b/i);
});

test("replay no vuelve a llamar Storage", async () => {
  const client = createClient({ request: requestRow({ estado_codigo: "auth_pendiente" }) });
  const supabase = makeSupabase();
  await cleanup(client, makeApp(client, supabase));

  assert.equal(supabase.calls.length, 0);
});

test("advisory lock se libera", async () => {
  const client = createClient();
  await cleanup(client);

  assert.match(allSql(client), /pg_advisory_unlock/);
});

test("conexion se libera", async () => {
  const client = createClient();
  await cleanup(client);

  assert.equal(client.released, true);
});

test("error intermedio no deja transaccion abierta", async () => {
  const throwOn = (sql) => String(sql).includes("UPDATE public.storage_assets");
  const client = createClient({ throwOn });

  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_STORAGE_TEMPORARY_FAILURE" });
  assert.match(allSql(client), /ROLLBACK/);
  assert.match(allSql(client), /pg_advisory_unlock/);
});

test("error 40001 se mapea correctamente", async () => {
  const throwOn = (sql) => String(sql).includes("FROM public.storage_assets") && String(sql).includes("FOR UPDATE");
  throwOn.code = "40001";
  const client = createClient({ throwOn });

  await assert.rejects(cleanup(client), { code: "CLIENT_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED" });
});

test("no devuelve ids buckets paths ni urls", async () => {
  const client = createClient();
  const result = await cleanup(client);
  const payload = JSON.stringify(result);

  assert.doesNotMatch(payload, /clientes\/avatar\.png|imagenes_privadas|55555555|public_url/i);
});

test("procesa solo IDs de la solicitud privada", async () => {
  const client = createClient({
    request: requestRow({
      resumen_impacto: { internal_anonymization: { storage_asset_ids: [ASSET_ID, ASSET_ID_2] } },
    }),
    assets: [assetRow(), assetRow({ id_asset: ASSET_ID_2, object_path: "clientes/otro.png" })],
    objectAbsent: [true, true],
  });
  await cleanup(client);
  const storageQuery = client.calls.find((call) => String(call.sql).includes("FROM public.storage_assets"));

  assert.deepEqual(storageQuery.params[0], [ASSET_ID, ASSET_ID_2]);
});
