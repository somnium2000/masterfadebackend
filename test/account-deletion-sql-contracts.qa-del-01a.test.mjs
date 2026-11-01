import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import adminRoutes from "../src/routes/v1/admin/accountDeletion.js";
import internalRoutes from "../src/routes/v1/accountDeletion.js";
import {
  evaluateAdminInternalAccountDeletionDependencies,
  evaluateInternalAccountDeletionRequest,
  getAdminAccountDeletionRequestDetail,
  listAdminAccountDeletionRequests,
} from "../src/services/accountDeletionService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";

function completedClientRow() {
  return {
    id_solicitud: REQUEST,
    referencia_publica: "DEL-QA-CLIENT",
    tipo_sujeto: "cliente",
    id_persona: PERSON,
    id_usuario: USER,
    id_cliente: "55555555-5555-4555-8555-555555555555",
    id_empleado: null,
    estado_codigo: "completada",
    requiere_aprobacion: false,
    nombres: "Nombre que no debe exponerse",
    apellidos: "Apellido",
    active_roles: [],
    branch_labels: ["MasterFade QA"],
    usuario_estado: false,
    usuario_deleted_at: new Date("2026-10-01T00:00:00Z"),
    resumen_impacto: {},
  };
}

function adminApp({ detail = false } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("array_agg(DISTINCT su.")) {
        assert.match(text, /su\.nombre_sucursal/);
        assert.doesNotMatch(text, /su\.nombre(?:\s|\))/);
      }
      if (detail && text.includes("WHERE s.id_solicitud")) return { rows: [completedClientRow()] };
      if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: 0 };
      if (text.includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: 1 }] };
      if (text.includes("COUNT(*) FILTER")) return { rows: [{ completed: 1 }] };
      if (text.includes("ORDER BY s.solicitado_at")) return { rows: [completedClientRow()] };
      throw new Error(`SQL no simulado: ${text}`);
    },
    release() {},
  };
  return { app: { db: { async connect() { return client; } } }, calls };
}

test("listado administrativo usa nombre_sucursal y anonimiza Cliente completado", async () => {
  const { app } = adminApp();
  const result = await listAdminAccountDeletionRequests(app, { subject: "cliente" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].display_name, "Cliente eliminado");
  assert.deepEqual(result.items[0].branch_labels, ["MasterFade QA"]);
});

test("detalle administrativo usa nombre_sucursal y anonimiza Cliente completado", async () => {
  const { app } = adminApp({ detail: true });
  const result = await getAdminAccountDeletionRequestDetail(app, {
    requestId: REQUEST,
    actor: { usuarioId: "99999999-9999-4999-8999-999999999999", roles: ["super_admin"], highestRank: 90 },
  });
  assert.equal(result.subject.display_name, "Cliente eliminado");
  assert.deepEqual(result.subject.branches, ["MasterFade QA"]);
});

function assertPendingDependencySql(sql) {
  assert.match(sql, /agenda_bloqueos_empleados[\s\S]*rango\s*&&\s*tstzrange\(NOW\(\), NULL, '\[\)'\)/i);
  assert.match(sql, /bloqueos_agenda[\s\S]*rango\s*&&\s*tstzrange\(NOW\(\), NULL, '\[\)'\)/i);
  assert.match(sql, /barberos_perfiles_publicos[\s\S]*deleted_at IS NULL[\s\S]*visible_en_landing IS TRUE/i);
  assert.doesNotMatch(sql, /(?:agenda_bloqueos_empleados|bloqueos_agenda)[\s\S]{0,180}deleted_at/i);
  assert.doesNotMatch(sql, /barberos_perfiles_publicos[\s\S]{0,180}\bactivo\b/i);
}

test("preview Barbero-Administrador filtra solo bloqueos pendientes y perfiles visibles", async () => {
  const client = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("AS shared_client_identity")) return { rows: [{ shared_client_identity: false }] };
      if (text.includes("FROM public.usuarios u")) return { rows: [{ id_usuario: USER, id_persona: PERSON, estado: true, estado_acceso: "activo", deleted_at: null, persona_exists: PERSON }] };
      if (text.includes("FROM public.roles_usuarios ru")) return { rows: [{ nombre: "admin" }, { nombre: "barbero" }] };
      if (text.includes("FROM public.empleados")) return { rows: [{ id_empleado: EMPLOYEE, id_persona: PERSON, id_sucursal: null, es_barbero: true }] };
      if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: 0 };
      if (text.includes("WITH employee_ids")) {
        assertPendingDependencySql(text);
        return { rows: [{ future_agenda_blocks: 0, public_barber_profiles: 0 }] };
      }
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta")) return { rows: [] };
      throw new Error(`SQL no simulado: ${text}`);
    },
  };
  const result = await evaluateInternalAccountDeletionRequest(client, {
    usuarioId: USER,
    personaId: PERSON,
    employeeIdFromClaims: EMPLOYEE,
    rolesFromClaims: ["admin", "barbero"],
  });
  assert.equal(result.can_request, true);
  assert.equal(result.dependencies.future_agenda_blocks, 0);
});

test("preview y evaluación administrativa comparten el filtro temporal", async () => {
  const client = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("AS shared_client_identity")) return { rows: [{ shared_client_identity: false }] };
      if (text.includes("SELECT id_empleado")) return { rows: [{ id_empleado: EMPLOYEE }] };
      if (text.includes("WITH employee_ids")) {
        assertPendingDependencySql(text);
        return { rows: [{ future_agenda_blocks: 0, public_barber_profiles: 0 }] };
      }
      throw new Error(`SQL no simulado: ${text}`);
    },
  };
  const result = await evaluateAdminInternalAccountDeletionDependencies(client, {
    deletionRequestId: REQUEST,
    personaId: PERSON,
    usuarioId: USER,
    empleadoId: EMPLOYEE,
  });
  assert.equal(result.future_agenda_blocks, 0);
  assert.equal(result.public_barber_profiles, 0);
});

test("Super Admin obtiene listado, Clientes, Historial y detalle por HTTP", async (t) => {
  const db = adminApp({ detail: true }).app.db;
  const app = Fastify();
  t.after(() => app.close());
  app.decorate("db", db);
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { user: { id_usuario: "99999999-9999-4999-8999-999999999999" }, roles: ["super_admin"] };
  });
  await app.register(adminRoutes, { prefix: "/v1/admin/account-deletion" });

  for (const query of ["", "?subject=cliente", "?status=completada"]) {
    const response = await app.inject({ method: "GET", url: `/v1/admin/account-deletion/requests${query}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.items[0].display_name, "Cliente eliminado");
  }
  const detail = await app.inject({ method: "GET", url: `/v1/admin/account-deletion/requests/${REQUEST}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.subject.display_name, "Cliente eliminado");
});

function internalHttpClient() {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes("AS shared_client_identity")) return { rows: [{ shared_client_identity: false }] };
      if (text.includes("FROM public.usuarios u")) return { rows: [{ id_usuario: USER, id_persona: PERSON, estado: true, estado_acceso: "activo", deleted_at: null, persona_exists: PERSON }] };
      if (text.includes("FROM public.roles_usuarios ru")) return { rows: [{ nombre: "admin" }, { nombre: "barbero" }] };
      if (text.includes("FROM public.empleados")) return { rows: [{ id_empleado: EMPLOYEE, id_persona: PERSON, id_sucursal: null, es_barbero: true }] };
      if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: 0 };
      if (text.includes("WITH employee_ids")) {
        assertPendingDependencySql(text);
        return { rows: [{ future_agenda_blocks: 0, public_barber_profiles: 0 }] };
      }
      if (text.includes("FROM app_private.solicitudes_eliminacion_cuenta")) return { rows: [] };
      throw new Error(`SQL no simulado: ${text}`);
    },
    release() {},
  };
}

test("Barbero-Administrador obtiene preview y solicitud actual nula por HTTP", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.decorate("db", { async connect() { return internalHttpClient(); } });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { user: { id_usuario: USER, id_persona: PERSON }, empleado_id: EMPLOYEE, roles: ["admin", "barbero"] };
  });
  await app.register(internalRoutes, { prefix: "/v1/account-deletion" });

  const preview = await app.inject({ method: "GET", url: "/v1/account-deletion/me/preview" });
  assert.equal(preview.statusCode, 200, preview.body);
  const current = await app.inject({ method: "GET", url: "/v1/account-deletion/me/requests/current" });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().data.request, null);
});

test("claims sin id_persona reciben diagnóstico 409 preciso", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.decorate("db", { async connect() { return internalHttpClient(); } });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { user: { id_usuario: USER }, empleado_id: EMPLOYEE, roles: ["admin", "barbero"] };
  });
  await app.register(internalRoutes, { prefix: "/v1/account-deletion" });
  const response = await app.inject({ method: "GET", url: "/v1/account-deletion/me/preview" });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "INTERNAL_ACCOUNT_DELETION_CONTEXT_REQUIRED");
});
