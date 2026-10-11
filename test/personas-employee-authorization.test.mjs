import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminPersonasRoutes from "../src/routes/v1/admin/personas.js";

const EMPLOYEE_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "22222222-2222-4222-8222-222222222222";

const validEmployeePayload = {
  persona: {
    nombres: "Ana",
    apellidos: "Prueba",
    dni: "0801199012345",
  },
  acceso: {
    correo_principal: "ana@example.test",
    roles: ["super_admin"],
  },
  empleado: {
    id_sucursal: BRANCH_ID,
    salario_base: 25000,
    es_barbero: false,
  },
};

async function createApp() {
  const activity = {
    dbQueries: 0,
    dbConnections: 0,
    authCalls: 0,
    allowedRoleSets: [],
  };
  const app = Fastify({ logger: false });

  app.decorate("db", {
    async query(sql) {
      activity.dbQueries += 1;
      if (String(sql).includes("FROM public.empleados e")) {
        return { rows: [], rowCount: 0 };
      }
      if (String(sql).includes("FROM public.roles")) {
        return { rows: [{ id_rol: "rol-admin", nombre: "admin" }], rowCount: 1 };
      }
      if (String(sql).includes("FROM public.sucursales")) {
        return { rows: [{ id_sucursal: BRANCH_ID, nombre_sucursal: "Sucursal QA" }], rowCount: 1 };
      }
      throw new Error("Unexpected database query in authorization test");
    },
    async connect() {
      activity.dbConnections += 1;
      throw new Error("Authorization test must not open a transaction");
    },
  });
  app.decorate("supabaseAdmin", {
    auth: {
      admin: new Proxy({}, {
        get() {
          activity.authCalls += 1;
          throw new Error("Authorization test must not call Supabase Auth");
        },
      }),
    },
  });
  app.decorate("requireRoles", (allowedRoles = []) => {
    activity.allowedRoleSets.push([...allowedRoles]);
    return async (request, reply) => {
      const roles = String(request.headers["x-test-roles"] || "")
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean);
      if (!allowedRoles.some((role) => roles.includes(role))) {
        return reply.code(403).send({
          error: { code: "AUTH_FORBIDDEN" },
        });
      }
      request.claims = { roles };
      if (request.headers["x-test-guard-only"] === "true") {
        return reply.code(204).send();
      }
    };
  });

  await app.register(adminPersonasRoutes, { prefix: "/personas" });
  await app.ready();
  return { app, activity };
}

const adminRequests = [
  { name: "listado", method: "GET", url: "/personas/empleados" },
  { name: "detalle", method: "GET", url: `/personas/empleados/${EMPLOYEE_ID}` },
  {
    name: "creacion con rol super_admin",
    method: "POST",
    url: "/personas/empleados",
    payload: validEmployeePayload,
  },
  {
    name: "edicion de roles y salario",
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}`,
    payload: {
      ...validEmployeePayload,
      acceso: { ...validEmployeePayload.acceso, roles: ["admin"] },
      empleado: { ...validEmployeePayload.empleado, salario_base: 99999 },
    },
  },
  { name: "inactivacion", method: "PATCH", url: `/personas/empleados/${EMPLOYEE_ID}/inactivar` },
  { name: "activacion", method: "PATCH", url: `/personas/empleados/${EMPLOYEE_ID}/activar` },
  { name: "eliminacion permanente", method: "DELETE", url: `/personas/empleados/${EMPLOYEE_ID}/permanente` },
];

test("admin accede al guard de las siete rutas de empleados", async (t) => {
  const { app, activity } = await createApp();
  t.after(() => app.close());

  for (const request of adminRequests) {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: { "x-test-roles": "admin", "x-test-guard-only": "true" },
      payload: request.payload,
    });
    assert.equal(response.statusCode, 204, request.name);
  }

  assert.equal(activity.dbQueries, 0);
  assert.equal(activity.dbConnections, 0);
  assert.equal(activity.authCalls, 0);
});

test("usuarios sin rol autorizado reciben 403 en las siete rutas antes de operar", async (t) => {
  const { app, activity } = await createApp();
  t.after(() => app.close());

  for (const request of adminRequests) {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: { "x-test-roles": "barbero" },
      payload: request.payload,
    });
    assert.equal(response.statusCode, 403, request.name);
    assert.equal(response.json().error.code, "AUTH_FORBIDDEN", request.name);
  }
  assert.equal(activity.dbQueries, 0);
  assert.equal(activity.dbConnections, 0);
  assert.equal(activity.authCalls, 0);
});

test("admin y super_admin conservan acceso al catalogo compartido", async (t) => {
  const { app, activity } = await createApp();
  t.after(() => app.close());

  for (const role of ["admin", "super_admin"]) {
    const response = await app.inject({
      method: "GET",
      url: "/personas/catalogos",
      headers: { "x-test-roles": role },
    });

    assert.equal(response.statusCode, 200, role);
    assert.equal(response.json().data.roles[0].nombre, "admin", role);
    assert.equal(response.json().data.sucursales[0].id_sucursal, BRANCH_ID, role);
  }

  assert.equal(activity.dbQueries, 4);
  assert.equal(activity.dbConnections, 0);
  assert.equal(activity.authCalls, 0);
});

test("super_admin accede al guard de las siete rutas y conserva la eliminacion permanente prohibida", async (t) => {
  const { app, activity } = await createApp();
  t.after(() => app.close());

  for (const request of adminRequests) {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: { "x-test-roles": "super_admin", "x-test-guard-only": "true" },
      payload: request.payload,
    });
    assert.equal(response.statusCode, 204, request.name);
  }

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/personas/empleados/${EMPLOYEE_ID}/permanente`,
    headers: { "x-test-roles": "super_admin" },
  });
  assert.equal(deleteResponse.statusCode, 410);
  assert.equal(deleteResponse.json().error.code, "PERSONAS_EMPLOYEE_PERMANENT_DELETE_DISABLED");

  assert.equal(activity.dbQueries, 0);
  assert.equal(activity.dbConnections, 0);
  assert.equal(activity.authCalls, 0);
  assert.ok(
    activity.allowedRoleSets.filter((roles) => roles.includes("super_admin") && roles.includes("admin")).length >= 7,
    "las rutas de empleados deben registrarse para super_admin y admin",
  );
});
