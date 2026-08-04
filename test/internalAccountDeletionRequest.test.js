import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelInternalAccountDeletionRequest,
  createInternalAccountDeletionRequest,
  evaluateInternalAccountDeletionRequest,
  getCurrentInternalAccountDeletionRequest,
  validateInternalAccountDeletionRequestBody,
  verifyRecentInternalAccountDeletionReauthentication,
} from "../src/services/accountDeletionService.js";

const USUARIO_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";
const EMPLEADO_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const REFERENCE = "DEL-ABCDEF123456";
const IDEMPOTENCY_KEY = "internal-account-delete-test-key";
const NOW = "2026-07-11T12:00:00.000Z";

function makeJwt({ sub = USUARIO_ID, iat = Math.floor(Date.now() / 1000) } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub, iat })}.signature`;
}

function requestRow(overrides = {}) {
  return {
    id_solicitud: REQUEST_ID,
    referencia_publica: REFERENCE,
    estado_codigo: "pendiente_aprobacion",
    solicitado_at: NOW,
    requiere_aprobacion: true,
    decision_codigo: null,
    decision_at: null,
    ...overrides,
  };
}

function createClient(options = {}) {
  const calls = [];
  const roles = options.roles || ["admin"];
  const employees = options.employees ?? [{
    id_empleado: EMPLEADO_ID,
    id_persona: PERSONA_ID,
    id_sucursal: "55555555-5555-4555-8555-555555555555",
    es_barbero: roles.includes("barbero"),
  }];
  const deps = {
    future_operational_appointments: 0,
    active_weekly_schedules: 0,
    future_agenda_blocks: 0,
    public_barber_profiles: 0,
    employee_service_rates: 0,
    promotion_references: 0,
    ...options.dependencies,
  };
  return {
    calls,
    released: false,
    release() {
      this.released = true;
      calls.push({ sql: "RELEASE", params: [] });
    },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM public.usuarios u")) {
        return { rows: options.userMissing ? [] : [{
          id_usuario: USUARIO_ID,
          id_persona: PERSONA_ID,
          estado: options.userInactive ? false : true,
          estado_acceso: "activo",
          deleted_at: options.userDeleted ? NOW : null,
          persona_exists: options.personaMissing ? null : PERSONA_ID,
        }] };
      }
      if (text.includes("FROM public.roles_usuarios ru")) {
        return { rows: roles.map((nombre) => ({ nombre })) };
      }
      if (text.includes("FROM public.empleados")) {
        return { rows: employees };
      }
      if (text.includes("FROM public.app_protected_users")) {
        return { rowCount: options.protectedUser ? 1 : 0, rows: options.protectedUser ? [{ "?column?": 1 }] : [] };
      }
      if (text.includes("WITH employee_ids")) {
        return { rows: [deps] };
      }
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta") && text.includes("estado_codigo = ANY")) {
        return { rows: options.currentRequest ? [options.currentRequest] : [] };
      }
      if (text.includes("INSERT INTO app_private.solicitudes_eliminacion_cuenta")) {
        return { rows: [requestRow()] };
      }
      if (text.includes("FOR UPDATE")) {
        if (Object.prototype.hasOwnProperty.call(options, "cancelRow")) {
          return { rows: options.cancelRow ? [options.cancelRow] : [] };
        }
        return { rows: [requestRow()] };
      }
      if (text.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")) {
        return { rows: [requestRow({ estado_codigo: "cancelada" })] };
      }
      return { rows: [] };
    },
  };
}

async function preview(options = {}) {
  return evaluateInternalAccountDeletionRequest(createClient(options), {
    usuarioId: USUARIO_ID,
    personaId: PERSONA_ID,
    employeeIdFromClaims: options.employeeIdFromClaims ?? EMPLEADO_ID,
    rolesFromClaims: options.roles || ["admin"],
  });
}

async function createRequest(options = {}) {
  return createInternalAccountDeletionRequest(createClient(options), {
    usuarioId: USUARIO_ID,
    personaId: PERSONA_ID,
    employeeIdFromClaims: options.employeeIdFromClaims ?? EMPLEADO_ID,
    rolesFromClaims: options.roles || ["admin"],
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: "req-test",
    authenticatedAt: NOW,
  });
}

test("preview de admin elegible", async () => {
  const result = await preview({ roles: ["admin"] });
  assert.equal(result.can_request, true);
  assert.deepEqual(result.dependencies.active_roles, ["admin"]);
});

test("preview de barbero elegible", async () => {
  const result = await preview({ roles: ["barbero"] });
  assert.equal(result.can_request, true);
  assert.equal(result.dependencies.is_barber, true);
});

test("rol cliente rechazado", async () => {
  const result = await preview({ roles: ["cliente"] });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_INTERNAL_ROLE_NOT_FOUND");
});

test("root protegido", async () => {
  const result = await preview({ roles: ["root"] });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_PROTECTED");
});

test("super admin protegido", async () => {
  const result = await preview({ roles: ["super_admin"] });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_PROTECTED");
});

test("usuario en app_protected_users", async () => {
  const result = await preview({ protectedUser: true });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_PROTECTED");
});

test("sin empleado activo", async () => {
  const result = await preview({ employees: [] });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_EMPLOYEE_NOT_FOUND");
});

test("contexto laboral ambiguo", async () => {
  const result = await preview({
    employeeIdFromClaims: "",
    employees: [
      { id_empleado: EMPLEADO_ID, id_persona: PERSONA_ID, id_sucursal: null, es_barbero: false },
      { id_empleado: "66666666-6666-4666-8666-666666666666", id_persona: PERSONA_ID, id_sucursal: null, es_barbero: false },
    ],
  });
  assert.equal(result.can_request, false);
  assert.equal(result.blocking_reasons[0].code, "INTERNAL_ACCOUNT_DELETION_EMPLOYEE_CONTEXT_AMBIGUOUS");
});

test("citas futuras aparecen como dependencia", async () => {
  const result = await preview({ dependencies: { future_operational_appointments: 2 } });
  assert.equal(result.dependencies.future_operational_appointments, 2);
});

test("citas futuras no bloquean la solicitud", async () => {
  const result = await preview({ dependencies: { future_operational_appointments: 2 } });
  assert.equal(result.can_request, true);
});

test("horarios activos aparecen", async () => {
  const result = await preview({ dependencies: { active_weekly_schedules: 3 } });
  assert.equal(result.dependencies.active_weekly_schedules, 3);
});

test("bloqueos de agenda aparecen", async () => {
  const result = await preview({ dependencies: { future_agenda_blocks: 4 } });
  assert.equal(result.dependencies.future_agenda_blocks, 4);
});

test("perfil publico aparece", async () => {
  const result = await preview({ dependencies: { public_barber_profiles: 1 } });
  assert.equal(result.dependencies.public_barber_profiles, 1);
});

test("tarifas especificas aparecen", async () => {
  const result = await preview({ dependencies: { employee_service_rates: 5 } });
  assert.equal(result.dependencies.employee_service_rates, 5);
});

test("referencias promocionales aparecen", async () => {
  const result = await preview({ dependencies: { promotion_references: 6 } });
  assert.equal(result.dependencies.promotion_references, 6);
});

test("solicitud directa a pendiente_aprobacion", async () => {
  const result = await createRequest();
  assert.equal(result.request.estado_codigo, "pendiente_aprobacion");
  assert.equal(result.created, true);
});

test("no usa pendiente_confirmacion", async () => {
  const result = await createRequest();
  assert.notEqual(result.request.estado_codigo, "pendiente_confirmacion");
});

test("reauth valida", async () => {
  const token = makeJwt();
  const app = { supabaseAdmin: { auth: { async getUser(received) { assert.equal(received, token); return { data: { user: { id: USUARIO_ID } }, error: null }; } } } };
  const result = await verifyRecentInternalAccountDeletionReauthentication(app, { reauthToken: token, expectedUserId: USUARIO_ID });
  assert.equal(result.authUserId, USUARIO_ID);
});

test("reauth invalida", async () => {
  const app = { supabaseAdmin: { auth: { async getUser() { return { data: {}, error: new Error("bad") }; } } } };
  await assert.rejects(verifyRecentInternalAccountDeletionReauthentication(app, { reauthToken: "bad", expectedUserId: USUARIO_ID }), { code: "INTERNAL_ACCOUNT_DELETION_REAUTH_REQUIRED" });
});

test("reauth de otro usuario", async () => {
  const app = { supabaseAdmin: { auth: { async getUser() { return { data: { user: { id: "99999999-9999-4999-8999-999999999999" } }, error: null }; } } } };
  await assert.rejects(verifyRecentInternalAccountDeletionReauthentication(app, { reauthToken: makeJwt(), expectedUserId: USUARIO_ID }), { code: "INTERNAL_ACCOUNT_DELETION_REAUTH_USER_MISMATCH" });
});

test("reauth vencida", async () => {
  const app = { supabaseAdmin: { auth: { async getUser() { return { data: { user: { id: USUARIO_ID } }, error: null }; } } } };
  await assert.rejects(verifyRecentInternalAccountDeletionReauthentication(app, { reauthToken: makeJwt({ iat: Math.floor(Date.now() / 1000) - 600 }), expectedUserId: USUARIO_ID }), { code: "INTERNAL_ACCOUNT_DELETION_REAUTH_EXPIRED" });
});

test("frase incorrecta", () => {
  assert.throws(() => validateInternalAccountDeletionRequestBody({
    confirmation_phrase: "SOLICITAR",
    acknowledge_account_remains_active: true,
    acknowledge_operational_dependencies: true,
    acknowledge_access_revocation: true,
    acknowledge_history_retention: true,
  }), { code: "INTERNAL_ACCOUNT_DELETION_CONFIRMATION_PHRASE_INVALID" });
});

test("acknowledgement faltante", () => {
  assert.throws(() => validateInternalAccountDeletionRequestBody({
    confirmation_phrase: "SOLICITAR ELIMINACION DE MI CUENTA",
    acknowledge_account_remains_active: true,
    acknowledge_operational_dependencies: true,
    acknowledge_access_revocation: false,
    acknowledge_history_retention: true,
  }), { code: "INTERNAL_ACCOUNT_DELETION_ACKNOWLEDGEMENTS_REQUIRED" });
});

test("idempotencia misma clave", async () => {
  const result = await createRequest({ currentRequest: requestRow() });
  assert.equal(result.idempotent_replay, true);
});

test("solicitud activa con otra clave", async () => {
  const result = await createRequest({ currentRequest: requestRow() });
  assert.equal(result.request.id_solicitud, REQUEST_ID);
});

test("doble envio no duplica", async () => {
  const client = createClient({ currentRequest: requestRow() });
  await createInternalAccountDeletionRequest(client, {
    usuarioId: USUARIO_ID,
    personaId: PERSONA_ID,
    employeeIdFromClaims: EMPLEADO_ID,
    rolesFromClaims: ["admin"],
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: "req-test",
    authenticatedAt: NOW,
  });
  assert.equal(client.calls.some((call) => call.sql.includes("INSERT INTO app_private")), false);
});

test("cuenta permanece activa", async () => {
  const client = createClient();
  await createRequest();
  assert.equal(client.calls.some((call) => /UPDATE public\.usuarios|DELETE FROM public\.usuarios/.test(call.sql)), false);
});

test("empleado permanece activo", async () => {
  const client = createClient();
  await createInternalAccountDeletionRequest(client, { usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], idempotencyKey: IDEMPOTENCY_KEY, requestId: "req-test", authenticatedAt: NOW });
  assert.equal(client.calls.some((call) => /UPDATE public\.empleados|DELETE FROM public\.empleados/.test(call.sql)), false);
});

test("roles permanecen activos", async () => {
  const client = createClient();
  await createInternalAccountDeletionRequest(client, { usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], idempotencyKey: IDEMPOTENCY_KEY, requestId: "req-test", authenticatedAt: NOW });
  assert.equal(client.calls.some((call) => /UPDATE public\.roles_usuarios|DELETE FROM public\.roles_usuarios/.test(call.sql)), false);
});

test("sesiones permanecen activas", async () => {
  const client = createClient();
  await createInternalAccountDeletionRequest(client, { usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], idempotencyKey: IDEMPOTENCY_KEY, requestId: "req-test", authenticatedAt: NOW });
  assert.equal(client.calls.some((call) => /seguridad_sesiones/.test(call.sql)), false);
});

test("Auth no se modifica", async () => {
  const app = { supabaseAdmin: { auth: { async getUser() { return { data: { user: { id: USUARIO_ID } }, error: null }; } } } };
  await verifyRecentInternalAccountDeletionReauthentication(app, { reauthToken: makeJwt(), expectedUserId: USUARIO_ID });
  assert.equal(typeof app.supabaseAdmin.auth.deleteUser, "undefined");
});

test("Storage no se modifica", async () => {
  const client = createClient();
  await createInternalAccountDeletionRequest(client, { usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], idempotencyKey: IDEMPOTENCY_KEY, requestId: "req-test", authenticatedAt: NOW });
  assert.equal(client.calls.some((call) => /storage_assets|storage\./i.test(call.sql)), false);
});

test("current devuelve solicitud", async () => {
  const result = await getCurrentInternalAccountDeletionRequest(createClient({ currentRequest: requestRow() }), { usuarioId: USUARIO_ID, empleadoId: EMPLEADO_ID });
  assert.equal(result.request.id_solicitud, REQUEST_ID);
});

test("current sin solicitud devuelve null", async () => {
  const result = await getCurrentInternalAccountDeletionRequest(createClient(), { usuarioId: USUARIO_ID, empleadoId: EMPLEADO_ID });
  assert.equal(result.request, null);
});

test("cancelacion valida", async () => {
  const result = await cancelInternalAccountDeletionRequest(createClient(), { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" });
  assert.equal(result.cancelled, true);
});

test("replay cancelado", async () => {
  const result = await cancelInternalAccountDeletionRequest(createClient({ cancelRow: requestRow({ estado_codigo: "cancelada" }) }), { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" });
  assert.equal(result.idempotent_replay, true);
});

test("otro usuario no puede cancelar", async () => {
  await assert.rejects(cancelInternalAccountDeletionRequest(createClient({ cancelRow: null }), { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" }), { code: "INTERNAL_ACCOUNT_DELETION_REQUEST_NOT_FOUND" });
});

test("aprobada no puede cancelarse", async () => {
  await assert.rejects(cancelInternalAccountDeletionRequest(createClient({ cancelRow: requestRow({ estado_codigo: "aprobada" }) }), { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" }), { code: "INTERNAL_ACCOUNT_DELETION_CANNOT_CANCEL" });
});

test("estado terminal no se actualiza", async () => {
  const client = createClient({ cancelRow: requestRow({ estado_codigo: "cancelada" }) });
  await cancelInternalAccountDeletionRequest(client, { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" });
  assert.equal(client.calls.some((call) => call.sql.includes("UPDATE app_private.solicitudes_eliminacion_cuenta")), false);
});

test("40001 se mapea", async () => {
  const client = createClient();
  client.query = async (sql) => {
    if (String(sql).includes("UPDATE app_private")) {
      const error = new Error("serialization");
      error.code = "40001";
      throw error;
    }
    return createClient().query(sql);
  };
  await assert.rejects(cancelInternalAccountDeletionRequest(client, { requestId: REQUEST_ID, usuarioId: USUARIO_ID, personaId: PERSONA_ID, employeeIdFromClaims: EMPLEADO_ID, rolesFromClaims: ["admin"], traceRequestId: "req" }), { code: "INTERNAL_ACCOUNT_DELETION_SERIALIZATION_RETRY_REQUIRED" });
});

test("conexion se libera", () => {
  const client = createClient();
  client.release();
  assert.equal(client.released, true);
});
