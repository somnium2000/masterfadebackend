import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminPersonasRoutes from "../src/routes/v1/admin/personas.js";

const EMPLOYEE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_BRANCH_ID = "44444444-4444-4444-8444-444444444444";

const employeeRow = {
  id_empleado: EMPLOYEE_ID,
  id_persona: PERSON_ID,
  id_usuario: USER_ID,
  id_sucursal: OTHER_BRANCH_ID,
  nombres: "Ana",
  apellidos: "Operativa",
  estado_laboral: true,
  estado_usuario: true,
  es_barbero: false,
  roles: [{ rol: "admin", activo: true, id_sucursal: OTHER_BRANCH_ID }],
};

const userRow = {
  id_usuario: USER_ID,
  id_persona: PERSON_ID,
  nombres: "Ana",
  apellidos: "Operativa",
  estado: true,
  estado_acceso: "activo",
  tiene_empleado: true,
  tiene_cliente: false,
  is_protected: false,
  roles: [{ rol: "admin", activo: true, id_sucursal: OTHER_BRANCH_ID }],
};

const employeePayload = (roles) => ({
  persona: {
    nombres: "Ana",
    apellidos: "Operativa",
    dni: "0801199012345",
    telefono_principal: "99990000",
  },
  acceso: {
    correo_principal: "ana@example.test",
    roles,
  },
  empleado: {
    id_sucursal: OTHER_BRANCH_ID,
    salario_base: 25000,
    es_barbero: false,
  },
});

async function buildApp({
  listRows = [],
  protectedTarget = false,
  privilegedTarget = false,
  adminBranchIds = [OTHER_BRANCH_ID],
  clientQuery,
} = {}) {
  const activity = { mutations: [], authCalls: 0, mailCalls: 0 };
  const client = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text.includes("AM: PERSONAS_ADMIN_BRANCHES")) return { rows: adminBranchIds.map((id_sucursal) => ({ id_sucursal })), rowCount: adminBranchIds.length };
      if (text.includes("AM: PERSONAS_SCOPE_TARGET")) return { rows: [], rowCount: adminBranchIds.includes(OTHER_BRANCH_ID) ? 1 : 0 };
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^(INSERT|UPDATE|DELETE) /i.test(text)) {
        activity.mutations.push(text);
      }
      if (clientQuery) {
        const custom = await clientQuery(text, params, activity);
        if (custom !== undefined) return custom;
      }
      if (text.includes("FROM public.app_protected_users")) {
        return { rows: protectedTarget ? [{ exists: 1 }] : [], rowCount: protectedTarget ? 1 : 0 };
      }
      if (text.includes("FROM public.roles_usuarios ru") && text.includes("r.nombre = 'super_admin'")) {
        return { rows: privilegedTarget ? [{ exists: 1 }] : [], rowCount: privilegedTarget ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };

  const app = Fastify({ logger: false });
  app.decorate("db", {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes("AM: PERSONAS_ADMIN_BRANCHES")) return { rows: adminBranchIds.map((id_sucursal) => ({ id_sucursal })), rowCount: adminBranchIds.length };
      const visibleRows = text.includes("AM: PERSONAS_SCOPE_READ")
        ? listRows.filter((row) => params.at(-1).includes(row.id_sucursal || row.roles?.[0]?.id_sucursal))
        : listRows;
      if (text.includes("FROM public.usuarios u")) return { rows: visibleRows, rowCount: visibleRows.length };
      if (text.includes("FROM public.empleados e")) return { rows: visibleRows, rowCount: visibleRows.length };
      throw new Error("Unexpected pool query");
    },
    async connect() {
      return client;
    },
  });
  app.decorate("supabaseAdmin", {
    auth: {
      admin: new Proxy({}, {
        get() {
          activity.authCalls += 1;
          throw new Error("Supabase Auth must not be called in hierarchy rejection tests");
        },
      }),
    },
  });
  app.decorate("mailer", {
    configured: true,
    async sendPasswordRecoveryEmail() {
      activity.mailCalls += 1;
      throw new Error("Email must not be sent in hierarchy rejection tests");
    },
  });
  app.decorate("requireRoles", (allowedRoles = []) => async (request, reply) => {
    const roles = String(request.headers["x-test-roles"] || "").split(",").filter(Boolean);
    if (!allowedRoles.some((role) => roles.includes(role))) {
      return reply.code(403).send({ error: { code: "AUTH_FORBIDDEN" } });
    }
    request.claims = {
      roles,
      branch_ids: ["55555555-5555-4555-8555-555555555555"],
      user: { id_usuario: "66666666-6666-4666-8666-666666666666" },
    };
  });
  await app.register(adminPersonasRoutes, { prefix: "/personas" });
  await app.ready();
  return { app, activity };
}

test("admin no consulta empleados fuera de sus asignaciones administrativas", async (t) => {
  const { app } = await buildApp({ listRows: [employeeRow], adminBranchIds: ["55555555-5555-4555-8555-555555555555"] });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/personas/empleados",
    headers: { "x-test-roles": "admin" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.empleados, []);
});

test("listado de admin oculta super_admin y protegidos; super_admin conserva listado completo", async (t) => {
  const rows = [
    userRow,
    { ...userRow, id_usuario: "77777777-7777-4777-8777-777777777777", roles: [{ rol: "super_admin" }] },
    { ...userRow, id_usuario: "88888888-8888-4888-8888-888888888888", is_protected: true },
  ];
  const { app } = await buildApp({ listRows: rows });
  t.after(() => app.close());

  const adminResponse = await app.inject({ method: "GET", url: "/personas/usuarios", headers: { "x-test-roles": "admin" } });
  assert.equal(adminResponse.statusCode, 200);
  assert.deepEqual(adminResponse.json().data.usuarios.map((user) => user.id_usuario), [USER_ID]);

  const superResponse = await app.inject({ method: "GET", url: "/personas/usuarios", headers: { "x-test-roles": "super_admin" } });
  assert.equal(superResponse.statusCode, 200);
  assert.equal(superResponse.json().data.usuarios.length, 3);
});

test("admin no puede crear empleado con rol super_admin antes de Auth o escrituras", async (t) => {
  const { app, activity } = await buildApp({
    clientQuery(text) {
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: OTHER_BRANCH_ID }], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/personas/empleados",
    headers: { "x-test-roles": "admin" },
    payload: employeePayload(["admin", "super_admin"]),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_ROLE_FORBIDDEN");
  assert.equal(activity.authCalls, 0);
  assert.deepEqual(activity.mutations, []);
});

test("admin no puede convertir un empleado ordinario en super_admin", async (t) => {
  const { app, activity } = await buildApp({
    clientQuery(text) {
      if (text.includes("FROM public.empleados e")) return { rows: [employeeRow], rowCount: 1 };
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: OTHER_BRANCH_ID }], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}`,
    headers: { "x-test-roles": "admin" },
    payload: employeePayload(["super_admin"]),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_ROLE_FORBIDDEN");
  assert.equal(activity.authCalls, 0);
  assert.deepEqual(activity.mutations, []);
});

test("admin no puede modificar un empleado asociado a super_admin", async (t) => {
  const { app, activity } = await buildApp({
    privilegedTarget: true,
    clientQuery(text) {
      if (text.includes("FROM public.empleados e")) return { rows: [employeeRow], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}`,
    headers: { "x-test-roles": "admin" },
    payload: employeePayload(["admin"]),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_TARGET_FORBIDDEN");
  assert.deepEqual(activity.mutations, []);
});

for (const scenario of [
  { name: "edicion personal", method: "PATCH", url: `/personas/usuarios/${USER_ID}`, payload: { persona: { nombres: "Cambio" } } },
  { name: "bloqueo", method: "PATCH", url: `/personas/usuarios/${USER_ID}/bloquear` },
  { name: "inactivacion", method: "PATCH", url: `/personas/usuarios/${USER_ID}/inactivar` },
  { name: "reactivacion", method: "PATCH", url: `/personas/usuarios/${USER_ID}/activar` },
]) {
  test(`admin no puede ejecutar ${scenario.name} sobre super_admin`, async (t) => {
    const { app, activity } = await buildApp({
      privilegedTarget: true,
      clientQuery(text) {
        if (text.includes("FROM public.usuarios u")) return { rows: [userRow], rowCount: 1 };
        return undefined;
      },
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: scenario.method,
      url: scenario.url,
      headers: { "x-test-roles": "admin" },
      payload: scenario.payload,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_TARGET_FORBIDDEN");
    assert.deepEqual(activity.mutations, []);
  });
}

test("admin no puede alterar root protegido", async (t) => {
  const { app, activity } = await buildApp({
    protectedTarget: true,
    clientQuery(text) {
      if (text.includes("FROM public.usuarios u")) return { rows: [userRow], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/usuarios/${USER_ID}`,
    headers: { "x-test-roles": "admin" },
    payload: { persona: { nombres: "Cambio" } },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ROOT_USER_PROTECTED");
  assert.deepEqual(activity.mutations, []);
});

for (const markPending of [true, false]) {
  test(`admin no puede enviar configuracion a super_admin con marcar_pendiente_password=${markPending}`, async (t) => {
    const { app, activity } = await buildApp({
      privilegedTarget: true,
      clientQuery(text) {
        if (text.includes("LEFT JOIN auth.users")) return { rows: [{ ...userRow, email: "root@example.test" }], rowCount: 1 };
        return undefined;
      },
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: `/personas/usuarios/${USER_ID}/enviar-configuracion-password`,
      headers: { "x-test-roles": "admin" },
      payload: { marcar_pendiente_password: markPending },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_TARGET_FORBIDDEN");
    assert.deepEqual(activity.mutations, []);
    assert.equal(activity.authCalls, 0);
    assert.equal(activity.mailCalls, 0);
  });
}

test("admin no inactiva empleado ordinario de otra sucursal", async (t) => {
  const { app, activity } = await buildApp({
    adminBranchIds: ["55555555-5555-4555-8555-555555555555"],
    clientQuery(text) {
      if (text.includes("FROM public.empleados e")) return { rows: [employeeRow], rowCount: 1 };
      if (text.includes("SELECT id_rol, nombre") && text.includes("FROM public.roles")) {
        return { rows: [{ id_rol: "99999999-9999-4999-8999-999999999999", nombre: "admin" }], rowCount: 1 };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /^(UPDATE|INSERT|DELETE) /i.test(text)) return { rows: [], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}/inactivar`,
    headers: { "x-test-roles": "admin" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
  assert.deepEqual(activity.mutations, []);
});

test("admin conserva la edicion de usuarios ordinarios", async (t) => {
  const { app, activity } = await buildApp({
    clientQuery(text) {
      if (text.includes("FROM public.usuarios u")) return { rows: [userRow], rowCount: 1 };
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || text.startsWith("UPDATE public.personas")) return { rows: [], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/usuarios/${USER_ID}`,
    headers: { "x-test-roles": "admin" },
    payload: { persona: { nombres: "Ana", apellidos: "Operativa", telefono_principal: "99990000" } },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(activity.mutations.some((sql) => sql.startsWith("UPDATE public.personas")));
});

test("admin no reactiva un empleado con historial super_admin", async (t) => {
  const { app, activity } = await buildApp({
    privilegedTarget: true,
    clientQuery(text) {
      if (text.includes("FROM public.empleados e")) return { rows: [employeeRow], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}/activar`,
    headers: { "x-test-roles": "admin" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_TARGET_FORBIDDEN");
  assert.deepEqual(activity.mutations, []);
});

test("super_admin conserva la edicion legitima de un usuario ordinario", async (t) => {
  const { app, activity } = await buildApp({
    clientQuery(text) {
      if (text.includes("FROM public.usuarios u")) return { rows: [userRow], rowCount: 1 };
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || text.startsWith("UPDATE public.personas")) return { rows: [], rowCount: 1 };
      return undefined;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "PATCH",
    url: `/personas/usuarios/${USER_ID}`,
    headers: { "x-test-roles": "super_admin" },
    payload: { persona: { nombres: "Ana", apellidos: "Operativa", telefono_principal: "99990000" } },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(activity.mutations.some((sql) => sql.startsWith("UPDATE public.personas")));
});
