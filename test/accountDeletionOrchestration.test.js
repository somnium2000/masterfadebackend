import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";

import publicAccountDeletionRoutes from "../src/routes/v1/public/accountDeletion.js";
import publicRoutes from "../src/routes/v1/public/index.js";
import clienteRoutes from "../src/routes/v1/cliente.js";
import { AppError } from "../src/utils/errors.js";
import {
  confirmClientAccountDeletionRequest,
  generateAccountDeletionExecutionToken,
  hashAccountDeletionExecutionToken,
  loadAccountDeletionExecutionContext,
  orchestrateClientAccountDeletion,
  verifyAccountDeletionExecutionToken,
} from "../src/services/accountDeletionService.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE = "DEL-ABCDEF123456";
const TRACE_ID = "req-orchestration-001";
const NOW = "2026-07-11T12:00:00.000Z";

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: REFERENCE,
    estado_codigo: "evaluada",
    id_cliente: CLIENTE_ID,
    id_persona: PERSONA_ID,
    id_usuario: USUARIO_ID,
    reautenticado_at: NOW,
    solicitado_at: NOW,
    completado_at: null,
    resumen_impacto: {},
    idempotency_key: "account-delete:test-key-001",
    execution_token_hash: null,
    execution_token_issued_at: NOW,
    execution_token_expires_at: "2999-01-01T00:00:00.000Z",
    execution_token_last_used_at: null,
    ...overrides,
  };
}

function previewRow(overrides = {}) {
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

function createRequestClient({ activeRow = requestRow(), updateRow = requestRow(), preview = previewRow() } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("WITH params AS")) return { rows: [preview] };
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("FOR UPDATE")) {
        return { rows: activeRow ? [activeRow] : [] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) {
        return { rowCount: 1, rows: [updateRow] };
      }
      return { rows: [] };
    },
  };
}

function createExecutionClient({ states, token, reference = REFERENCE } = {}) {
  const calls = [];
  let selectIndex = 0;
  const tokenHash = hashAccountDeletionExecutionToken(token);
  const rows = states.map((state) => requestRow({
    estado_codigo: state.estado || state,
    completado_at: state.completedAt ?? (state.estado === "completada" || state === "completada" ? NOW : null),
    execution_token_hash: state.hash ?? tokenHash,
    execution_token_expires_at: state.expiresAt ?? "2999-01-01T00:00:00.000Z",
    referencia_publica: reference,
  }));
  return {
    calls,
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("referencia_publica")) {
        const row = rows[Math.min(selectIndex, rows.length - 1)];
        selectIndex += 1;
        return { rows: row ? [row] : [] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };
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

function makeRunners(calls, overrides = {}) {
  return {
    internal: overrides.internal || (async (_app, args) => {
      calls.push({ stage: "internal", args });
      return { processed: true };
    }),
    anonymization: overrides.anonymization || (async (_app, args) => {
      calls.push({ stage: "anonymization", args });
      return { anonymized: true };
    }),
    storage: overrides.storage || (async (_app, args) => {
      calls.push({ stage: "storage", args });
      return { storage_processed: true };
    }),
    auth: overrides.auth || (async (_app, args) => {
      calls.push({ stage: "auth", args });
      return { completed: true };
    }),
  };
}

function makeJwt({ sub = USUARIO_ID, iat = Math.floor(Date.now() / 1000) } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub, iat })}.signature`;
}

async function orchestrateWith({ states, token = generateAccountDeletionExecutionToken(), runners = null } = {}) {
  const client = createExecutionClient({ states, token });
  const stageCalls = [];
  const result = await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: runners || makeRunners(stageCalls),
  });
  return { result, client, stageCalls, token };
}

test("token generado usa 32 bytes en base64url", () => {
  const token = generateAccountDeletionExecutionToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
});

test("hash SHA-256 tiene 64 caracteres hexadecimales", () => {
  assert.match(hashAccountDeletionExecutionToken("token-opaco"), /^[0-9a-f]{64}$/);
});

test("comparacion constante acepta token valido", () => {
  const token = generateAccountDeletionExecutionToken();
  assert.equal(verifyAccountDeletionExecutionToken(token, hashAccountDeletionExecutionToken(token)), true);
});

test("comparacion constante rechaza token invalido", () => {
  const token = generateAccountDeletionExecutionToken();
  assert.equal(verifyAccountDeletionExecutionToken(`${token}x`, hashAccountDeletionExecutionToken(token)), false);
});

test("comparacion constante rechaza longitudes distintas", () => {
  assert.equal(verifyAccountDeletionExecutionToken("token", "abc"), false);
});

test("confirmacion exitosa emite token y guarda solo hash", async () => {
  const client = createRequestClient({
    activeRow: requestRow({ estado_codigo: "pendiente_confirmacion" }),
    updateRow: requestRow({ estado_codigo: "evaluada", execution_token_expires_at: "2026-07-11T12:10:00.000Z" }),
  });
  const result = await confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: TRACE_ID,
  });
  const update = client.calls.find((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta"));
  assert.match(result.execution.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.match(update.params[6], /^[0-9a-f]{64}$/);
  assert.notEqual(update.params[6], result.execution.token);
  assert.match(update.sql, /execution_token_issued_at/);
  assert.match(update.sql, /execution_token_expires_at/);
});

test("replay evaluada rota token e invalida el anterior funcionalmente", async () => {
  const oldToken = generateAccountDeletionExecutionToken();
  const client = createRequestClient({
    activeRow: requestRow({
      estado_codigo: "evaluada",
      reautenticado_at: NOW,
      execution_token_hash: hashAccountDeletionExecutionToken(oldToken),
    }),
    updateRow: requestRow({ estado_codigo: "evaluada", execution_token_expires_at: "2026-07-11T12:10:00.000Z" }),
  });
  const result = await confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: TRACE_ID,
  });
  const update = client.calls.find((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta"));
  assert.equal(result.idempotent_replay, true);
  assert.notEqual(update.params[6], hashAccountDeletionExecutionToken(oldToken));
});

test("confirmacion no emite token si ya esta procesando", async () => {
  const client = createRequestClient({ activeRow: requestRow({ estado_codigo: "procesando" }) });
  await assert.rejects(
    confirmClientAccountDeletionRequest(client, {
      requestId: REQUEST_ID,
      clienteId: CLIENTE_ID,
      personaId: PERSONA_ID,
      usuarioId: USUARIO_ID,
      authenticatedAt: NOW,
      traceRequestId: TRACE_ID,
    }),
    { code: "CLIENT_ACCOUNT_DELETION_REQUEST_STATE_INVALID" }
  );
});

test("solicitud bloqueada limpia hash y expiracion", async () => {
  const client = createRequestClient({
    activeRow: requestRow({ estado_codigo: "pendiente_confirmacion" }),
    preview: previewRow({ pending_payments: { intent_count: 1, payment_count: 0 } }),
    updateRow: requestRow({ estado_codigo: "bloqueada" }),
  });
  const result = await confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: TRACE_ID,
  });
  const update = client.calls.find((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta"));
  assert.equal(result.execution, undefined);
  assert.match(update.sql, /execution_token_hash = CASE/);
  assert.equal(update.params[6], null);
});

test("loader rechaza solicitud inexistente y token incorrecto de forma indistinguible", async () => {
  const token = generateAccountDeletionExecutionToken();
  const missing = createExecutionClient({ states: [], token });
  await assert.rejects(loadAccountDeletionExecutionContext(missing, {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
  }), { code: "CLIENT_ACCOUNT_DELETION_EXECUTION_CREDENTIAL_INVALID" });

  const wrong = createExecutionClient({ states: ["evaluada"], token });
  await assert.rejects(loadAccountDeletionExecutionContext(wrong, {
    reference: REFERENCE,
    executionToken: generateAccountDeletionExecutionToken(),
    traceRequestId: TRACE_ID,
  }), { code: "CLIENT_ACCOUNT_DELETION_EXECUTION_CREDENTIAL_INVALID" });
});

test("referencia invalida y body extra quedan cubiertos por schema de ruta", async () => {
  const app = Fastify();
  await app.register(publicAccountDeletionRoutes, { prefix: "/v1/public/account-deletion" });
  const response = await app.inject({
    method: "POST",
    url: "/v1/public/account-deletion/requests/bad/execute",
    payload: { execution_token: generateAccountDeletionExecutionToken(), extra: true },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test("ruta exacta publica esta registrada sin requireRoles", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  const indexSource = await readFile(new URL("../src/routes/v1/public/index.js", import.meta.url), "utf8");
  assert.match(source, /"\/requests\/:reference\/execute"/);
  assert.doesNotMatch(source, /requireRoles|authenticate/);
  assert.match(indexSource, /prefix: "\/account-deletion"/);
});

test("rate limit publico usa ip y referencia, no token", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  const keyGeneratorLine = source.split("\n").find((line) => line.includes("keyGenerator")) || "";
  assert.match(source, /max: 5/);
  assert.match(source, /timeWindow: "15 minutes"/);
  assert.match(keyGeneratorLine, /request\.ip/);
  assert.match(keyGeneratorLine, /request\.params\?\.reference/);
  assert.doesNotMatch(keyGeneratorLine, /execution_token/);
});

test("token no aparece en logs", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  const logLines = source.split("\n").filter((line) => /log\.(error|warn|info|debug)/.test(line)).join("\n");
  assert.doesNotMatch(logLines, /execution_token/);
  assert.doesNotMatch(logLines, /request\.body/);
});

test("token vencido en evaluada se rechaza y limpia", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: [{ estado: "evaluada", expiresAt: "2000-01-01T00:00:00.000Z" }], token });
  await assert.rejects(loadAccountDeletionExecutionContext(client, {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
  }), { code: "CLIENT_ACCOUNT_DELETION_EXECUTION_TOKEN_EXPIRED" });
  assert.ok(client.calls.some((call) => String(call.sql).includes("execution_token_hash = NULL")));
});

test("token nominalmente vencido permite procesando y completada", async () => {
  const token = generateAccountDeletionExecutionToken();
  for (const estado of ["procesando", "completada"]) {
    const client = createExecutionClient({ states: [{ estado, expiresAt: "2000-01-01T00:00:00.000Z" }], token });
    const context = await loadAccountDeletionExecutionContext(client, {
      reference: REFERENCE,
      executionToken: token,
      traceRequestId: TRACE_ID,
    });
    assert.equal(context.estadoCodigo, estado);
  }
});

test("evaluada llama solamente 3C.1 primero con reautenticado_at persistido", async () => {
  const { stageCalls } = await orchestrateWith({ states: ["evaluada", "completada"] });
  assert.deepEqual(stageCalls.map((call) => call.stage), ["internal"]);
  assert.equal(stageCalls[0].args.authenticatedAt, NOW);
});

test("procesando no repite 3C.1 y llama anonimizacion", async () => {
  const { stageCalls } = await orchestrateWith({ states: ["procesando", "completada"] });
  assert.deepEqual(stageCalls.map((call) => call.stage), ["anonymization"]);
});

test("storage_pendiente llama Storage y fallo parcial no llama Auth", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["storage_pendiente"], token });
  const calls = [];
  const result = await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners(calls, {
      storage: async () => {
        calls.push({ stage: "storage" });
        return { storage_processed: false };
      },
    }),
  });
  assert.equal(result.completed, false);
  assert.equal(result.retryable, true);
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(calls.map((call) => call.stage), ["storage"]);
});

test("auth_pendiente llama Auth y no llama Storage", async () => {
  const { stageCalls } = await orchestrateWith({ states: ["auth_pendiente", "completada"] });
  assert.deepEqual(stageCalls.map((call) => call.stage), ["auth"]);
});

test("saga limpia recorre fases y relee estado entre etapas", async () => {
  const { result, stageCalls, client } = await orchestrateWith({
    states: ["evaluada", "procesando", "storage_pendiente", "auth_pendiente", "completada"],
  });
  assert.equal(result.completed, true);
  assert.equal(result.idempotent_replay, false);
  assert.deepEqual(stageCalls.map((call) => call.stage), ["internal", "anonymization", "storage", "auth"]);
  assert.equal(client.calls.filter((call) => String(call.sql).includes("referencia_publica")).length, 5);
});

test("limite de iteraciones evita ciclo infinito", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: Array(8).fill("procesando"), token });
  await assert.rejects(orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([]),
  }), { code: "CLIENT_ACCOUNT_DELETION_ORCHESTRATION_LIMIT_REACHED" });
});

test("bloqueo detiene la saga y conserva mensaje funcional", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["evaluada"], token });
  await assert.rejects(orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], {
      internal: async () => ({ processed: false, request_state: "bloqueada", blocking_reasons: [{ code: "X", message: "Bloqueo" }] }),
    }),
  }), { code: "CLIENT_ACCOUNT_DELETION_BLOCKED" });
});

test("reauth vencida limpia token", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["evaluada"], token });
  await assert.rejects(orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], {
      internal: async () => {
        throw new AppError(401, "expired", {
          code: "CLIENT_ACCOUNT_DELETION_REAUTH_EXPIRED_FOR_PROCESSING",
        });
      },
    }),
  }), { code: "CLIENT_ACCOUNT_DELETION_REAUTH_REQUIRED" });
  assert.ok(client.calls.some((call) => String(call.sql).includes("execution_token_hash = NULL")));
});

test("fallo Auth conserva token y responde reintentable", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["auth_pendiente"], token });
  const result = await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], {
      auth: async () => {
        throw new AppError(503, "temporal", { code: "CLIENT_ACCOUNT_DELETION_AUTH_TEMPORARY_FAILURE" });
      },
    }),
  });
  assert.equal(result.retryable, true);
  assert.equal(result.request.status, "auth_pendiente");
});

test("completada no llama etapas y replay terminal es idempotente", async () => {
  const { result, stageCalls } = await orchestrateWith({ states: ["completada"] });
  assert.equal(result.completed, true);
  assert.equal(result.idempotent_replay, true);
  assert.deepEqual(stageCalls, []);
});

test("respuesta final no contiene IDs internos, hash ni token", async () => {
  const token = generateAccountDeletionExecutionToken();
  const { result } = await orchestrateWith({ states: ["completada"], token });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(CLIENTE_ID, "i"));
  assert.doesNotMatch(serialized, new RegExp(USUARIO_ID, "i"));
  assert.doesNotMatch(serialized, /execution_token|hash|auth_user|storage/i);
});

test("dos ejecuciones sobre completada no duplican efectos", async () => {
  const token = generateAccountDeletionExecutionToken();
  const first = await orchestrateWith({ states: ["completada"], token });
  const second = await orchestrateWith({ states: ["completada"], token });
  assert.equal(first.stageCalls.length + second.stageCalls.length, 0);
});

test("errores 40001 conservan mapeo funcional", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["procesando"], token });
  await assert.rejects(orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], {
      anonymization: async () => {
        const error = new Error("serialization");
        error.code = "40001";
        throw error;
      },
    }),
  }), { code: "40001" });
});

test("ninguna funcion recibe IDs desde el body", async () => {
  const { stageCalls } = await orchestrateWith({ states: ["evaluada", "completada"] });
  assert.equal(stageCalls[0].args.clienteId, CLIENTE_ID);
  assert.equal(stageCalls[0].args.personaId, PERSONA_ID);
  assert.equal(stageCalls[0].args.usuarioId, USUARIO_ID);
});

test("3D.2 conserva hash al completar", async () => {
  const source = await readFile(new URL("../src/services/accountDeletionService.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function finalizeClientAccountDeletionAuthCleanup");
  const end = source.indexOf("async function failClientAccountDeletionAuthAttempt", start);
  const finalizer = source.slice(start, end);
  assert.doesNotMatch(finalizer, /execution_token_hash\s*=\s*NULL/);
});

test("confirmacion autenticada con app.inject devuelve token", async () => {
  const app = Fastify();
  const client = createRequestClient({
    activeRow: requestRow({ estado_codigo: "pendiente_confirmacion" }),
    updateRow: requestRow({ estado_codigo: "evaluada", execution_token_expires_at: "2026-07-11T12:10:00.000Z" }),
  });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { cliente_id: CLIENTE_ID, user: { id_persona: PERSONA_ID, id_usuario: USUARIO_ID } };
  });
  app.decorate("db", { async connect() { return { ...client, release() {} }; } });
  app.decorate("supabaseAdmin", { auth: { async getUser() { return { data: { user: { id: USUARIO_ID } }, error: null }; } } });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  const response = await app.inject({
    method: "POST",
    url: `/v1/cliente/me/account-deletion/requests/${REQUEST_ID}/confirm`,
    payload: {
      reauth_token: makeJwt(),
      confirmacion_texto: "ELIMINAR MI CUENTA",
      acepta_perder_masterpuntos: true,
      acepta_cancelar_membresia: true,
      acepta_historial_anonimizado: true,
      acepta_irreversibilidad: true,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().data.execution.token, /^[A-Za-z0-9_-]{40,100}$/);
  await app.close();
});

test("ejecucion publica con token valido y replay completado responde correctamente", async () => {
  const token = generateAccountDeletionExecutionToken();
  const app = Fastify();
  app.decorate("db", { async connect() { return createExecutionClient({ states: ["completada"], token }); } });
  await app.register(publicAccountDeletionRoutes, { prefix: "/v1/public/account-deletion" });
  const response = await app.inject({
    method: "POST",
    url: `/v1/public/account-deletion/requests/${REFERENCE}/execute`,
    payload: { execution_token: token },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.completed, true);
  assert.equal(response.json().data.idempotent_replay, true);
  await app.close();
});

test("ejecucion publica sin token responde 400", async () => {
  const app = Fastify();
  await app.register(publicAccountDeletionRoutes, { prefix: "/v1/public/account-deletion" });
  const response = await app.inject({
    method: "POST",
    url: `/v1/public/account-deletion/requests/${REFERENCE}/execute`,
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test("token incorrecto responde 401", async () => {
  const token = generateAccountDeletionExecutionToken();
  const app = Fastify();
  app.decorate("db", { async connect() { return createExecutionClient({ states: ["evaluada"], token }); } });
  await app.register(publicAccountDeletionRoutes, { prefix: "/v1/public/account-deletion" });
  const response = await app.inject({
    method: "POST",
    url: `/v1/public/account-deletion/requests/${REFERENCE}/execute`,
    payload: { execution_token: generateAccountDeletionExecutionToken() },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "CLIENT_ACCOUNT_DELETION_EXECUTION_CREDENTIAL_INVALID");
  await app.close();
});

test("public index registra ruta account deletion", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/index.js", import.meta.url), "utf8");
  assert.match(source, /accountDeletionRoutes/);
  assert.match(source, /prefix: "\/account-deletion"/);
  assert.equal(typeof publicRoutes, "function");
});

test("hash no se devuelve desde confirmacion", async () => {
  const client = createRequestClient({
    activeRow: requestRow({ estado_codigo: "pendiente_confirmacion" }),
    updateRow: requestRow({ estado_codigo: "evaluada", execution_token_expires_at: "2026-07-11T12:10:00.000Z" }),
  });
  const result = await confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: TRACE_ID,
  });
  assert.doesNotMatch(JSON.stringify(result), /execution_token_hash|[0-9a-f]{64}/);
});

test("token plano no se persiste en parametros SQL", async () => {
  const client = createRequestClient({
    activeRow: requestRow({ estado_codigo: "pendiente_confirmacion" }),
    updateRow: requestRow({ estado_codigo: "evaluada", execution_token_expires_at: "2026-07-11T12:10:00.000Z" }),
  });
  const result = await confirmClientAccountDeletionRequest(client, {
    requestId: REQUEST_ID,
    clienteId: CLIENTE_ID,
    personaId: PERSONA_ID,
    usuarioId: USUARIO_ID,
    authenticatedAt: NOW,
    traceRequestId: TRACE_ID,
  });
  assert.ok(!client.calls.some((call) => call.params?.includes(result.execution.token)));
});

test("credencial invalida no actualiza last_used_at", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["evaluada"], token });
  await assert.rejects(loadAccountDeletionExecutionContext(client, {
    reference: REFERENCE,
    executionToken: generateAccountDeletionExecutionToken(),
    traceRequestId: TRACE_ID,
  }));
  assert.ok(!client.calls.some((call) => String(call.sql).includes("execution_token_last_used_at")));
});

test("credencial valida actualiza last_used_at en saga no terminal", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["procesando"], token });
  await loadAccountDeletionExecutionContext(client, {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
  });
  assert.ok(client.calls.some((call) => String(call.sql).includes("execution_token_last_used_at = NOW()")));
});

test("replay completada no intenta actualizar last_used_at terminal", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["completada"], token });
  await loadAccountDeletionExecutionContext(client, {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
  });
  assert.ok(!client.calls.some((call) => String(call.sql).includes("execution_token_last_used_at = NOW()")));
});

test("estado no ejecutable con token valido responde 409", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["pendiente_confirmacion"], token });
  await assert.rejects(orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([]),
  }), { code: "CLIENT_ACCOUNT_DELETION_EXECUTION_STATE_INVALID" });
});

test("fallo Storage conserva estado reintentable en respuesta", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["storage_pendiente"], token });
  const result = await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], { storage: async () => ({ storage_processed: false }) }),
  });
  assert.deepEqual(result.request, { reference: REFERENCE, status: "storage_pendiente" });
});

test("fallo Storage no devuelve detalles de proveedor", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["storage_pendiente"], token });
  const result = await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners([], { storage: async () => ({ storage_processed: false, provider: "supabase" }) }),
  });
  assert.doesNotMatch(JSON.stringify(result), /supabase|bucket|object|path/i);
});

test("endpoint no usa cookies ni headers personalizados para autorizar", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /cookies?|headers?\[['"]x-|authorization/i);
});

test("endpoint no acepta token en query string", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /request\.query|querystring/i);
});

test("schema publico no acepta identidad desde frontend", async () => {
  const source = await readFile(new URL("../src/routes/v1/public/accountDeletion.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /id_cliente|clienteId|id_persona|personaId|id_usuario|usuarioId|authUserId/);
});

test("loader consulta identidad exclusivamente desde la solicitud privada", async () => {
  const source = await readFile(new URL("../src/services/accountDeletionService.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function loadAccountDeletionExecutionContext");
  const end = source.indexOf("function assertAccountDeletionExecutionStateValid", start);
  const loader = source.slice(start, end);
  assert.match(loader, /referencia_publica = \$1::text/);
  assert.match(loader, /id_cliente/);
  assert.match(loader, /id_persona/);
  assert.match(loader, /id_usuario/);
});

test("orquestador no abre transaccion global", async () => {
  const source = await readFile(new URL("../src/services/accountDeletionService.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function orchestrateClientAccountDeletion");
  const end = source.indexOf("export async function verifyRecentAccountDeletionReauthentication", start);
  const orchestrator = source.slice(start, end);
  assert.doesNotMatch(orchestrator, /BEGIN|COMMIT|ROLLBACK|pg_advisory/);
});

test("orquestador no llama Storage desde auth_pendiente", async () => {
  const calls = [];
  await orchestrateWith({ states: ["auth_pendiente", "completada"], runners: makeRunners(calls) });
  assert.deepEqual(calls.map((call) => call.stage), ["auth"]);
});

test("orquestador no llama Auth desde storage fallido", async () => {
  const token = generateAccountDeletionExecutionToken();
  const client = createExecutionClient({ states: ["storage_pendiente"], token });
  const calls = [];
  await orchestrateClientAccountDeletion(makeApp(client), {
    reference: REFERENCE,
    executionToken: token,
    traceRequestId: TRACE_ID,
    stageRunners: makeRunners(calls, { storage: async () => { calls.push({ stage: "storage" }); return { storage_processed: false }; } }),
  });
  assert.deepEqual(calls.map((call) => call.stage), ["storage"]);
});

test("respuesta completada tiene contrato final exacto", async () => {
  const { result } = await orchestrateWith({ states: ["completada"] });
  assert.deepEqual(Object.keys(result).sort(), ["completed", "completion", "idempotent_replay", "request"].sort());
  assert.deepEqual(result.completion, {
    account_deleted: true,
    history_retained_anonymized: true,
  });
});

test("migracion local excluye hash de bitacoras", async () => {
  const sql = await readFile(new URL("../db/migrations/20260711163541_account_deletion_execution_token_v1.sql", import.meta.url), "utf8");
  assert.match(sql, /to_jsonb\(OLD\) - 'execution_token_hash'/);
  assert.match(sql, /to_jsonb\(NEW\) - 'execution_token_hash'/);
});

test("migracion terminal permite hash en completada", async () => {
  const sql = await readFile(new URL("../db/migrations/20260711163730_account_deletion_execution_token_terminal_replay_v1.sql", import.meta.url), "utf8");
  assert.match(sql, /'completada'::text/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_completed_token_cleared/);
});
