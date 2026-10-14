import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/catalog.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const BASE = "/v1/admin/catalog";
const assignment = (rol, id_sucursal, activo = true, id_usuario = USER) => ({ rol, id_sucursal, activo, id_usuario });

async function buildApp({ roles = ["admin", "barbero"], assignments = [assignment("admin", A), assignment("barbero", B)], userId = USER, missingUser = false } = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: text, params });
    if (text.startsWith("SELECT DISTINCT ru.id_sucursal")) {
      assert.match(text, /FROM public\.roles_usuarios ru JOIN public\.roles r ON r\.id_rol = ru\.id_rol/);
      assert.match(text, /WHERE ru\.id_usuario = \$1::uuid/);
      assert.match(text, /AND ru\.activo IS TRUE/);
      assert.match(text, /AND r\.nombre = 'admin'/);
      assert.match(text, /AND ru\.id_sucursal IS NOT NULL/);
      assert.deepEqual(params, [userId]);
      assert.ok(!text.includes(userId));
      const ids = [...new Set(assignments.filter((item) => item.id_usuario === params[0] && item.rol === "admin" && item.activo === true && item.id_sucursal).map((item) => item.id_sucursal))];
      return { rows: ids.map((id_sucursal) => ({ id_sucursal })), rowCount: ids.length };
    }
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    if (text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (/^(INSERT|UPDATE|DELETE|BEGIN)/.test(text)) throw new Error("Unexpected write in scope test");
    // AM: Las lecturas autorizadas conservan los contratos de catalogos vacios.
    if (text.includes("public.servicios") || text.includes("public.paquetes")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected SQL: ${text}`);
  };
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: [A, B], user: missingUser ? undefined : { id_usuario: userId } };
  });
  app.decorate("db", { query, connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: BASE });
  await app.ready();
  return { app, calls };
}

function requests(branch) {
  return [
    { method: "GET", url: `${BASE}/servicios?id_sucursal=${branch}` },
    { method: "GET", url: `${BASE}/servicios/agrupados?id_sucursal=${branch}` },
    { method: "POST", url: `${BASE}/servicios`, payload: { nombre_servicio: "Corte", sucursales: [{ id_sucursal: branch, precio_hnl: 200, duracion_min: 30 }] } },
    { method: "PATCH", url: `${BASE}/servicios/${SERVICE}`, payload: { id_sucursal: branch, descripcion: "Editada" } },
    { method: "POST", url: `${BASE}/servicios/${SERVICE}/tarifas`, payload: { id_sucursal: branch, precio_hnl: 200, duracion_min: 30 } },
    { method: "PATCH", url: `${BASE}/servicios/${SERVICE}/tarifas/${branch}`, payload: { precio_hnl: 250 } },
    { method: "PATCH", url: `${BASE}/servicios/${SERVICE}/tarifas/${branch}/desactivar` },
    { method: "PATCH", url: `${BASE}/servicios/${SERVICE}/estado`, payload: { id_sucursal: branch, activo: false } },
    { method: "PATCH", url: `${BASE}/servicios/${SERVICE}/estado`, payload: { id_sucursal: branch, activo: true } },
    { method: "DELETE", url: `${BASE}/servicios/${SERVICE}?id_sucursal=${branch}` },
  ];
}

for (const request of requests(B)) {
  for (const scenario of [
    { name: "admin A + barbero B", assignments: [assignment("admin", A), assignment("barbero", B)] },
    { name: "admin B inactivo", assignments: [assignment("admin", B, false)] },
    { name: "admin B de otro usuario", assignments: [assignment("admin", B, true, OTHER)] },
    { name: "sin asignaciones", assignments: [] },
  ]) {
    test(`${scenario.name}: rechaza ${request.method} ${request.url} antes de escrituras`, async (t) => {
      const { app, calls } = await buildApp({ assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
      assert.ok(!calls.some((call) => /^(INSERT|UPDATE|DELETE|BEGIN)/.test(call.sql)));
      assert.ok(!calls.some((call) => /FROM public\.(servicios|paquetes)/.test(call.sql)));
    });
  }
}

for (const path of ["servicios", "servicios/agrupados"]) {
  for (const scenario of [
    { name: "admin A", assignments: [assignment("admin", A), assignment("barbero", B)], branch: A },
    { name: "admin A+B en A", assignments: [assignment("admin", A), assignment("admin", B)], branch: A },
    { name: "admin A+B en B", assignments: [assignment("admin", A), assignment("admin", B)], branch: B },
  ]) {
    test(`${scenario.name}: lectura autorizada ${path}`, async (t) => {
      const { app } = await buildApp({ assignments: scenario.assignments }); t.after(() => app.close());
      const response = await app.inject({ method: "GET", url: `${BASE}/${path}?id_sucursal=${scenario.branch}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.id_sucursal, scenario.branch);
      assert.deepEqual(response.json().data.servicios, []);
    });
  }
  test(`sucursal admin unica se selecciona automaticamente en ${path}`, async (t) => {
    const { app } = await buildApp({ assignments: [assignment("admin", A), assignment("admin", A), assignment("barbero", B)] });
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: `${BASE}/${path}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.id_sucursal, A);
  });
  test(`varias sucursales admin requieren seleccion en ${path}`, async (t) => {
    const { app } = await buildApp({ assignments: [assignment("admin", A), assignment("admin", B)] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: `${BASE}/${path}` });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "CATALOG_BRANCH_REQUIRED");
  });
  for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
    test(`${roles.join("+")} mantiene listado global y acceso B en ${path}`, async (t) => {
      const { app, calls } = await buildApp({ roles, assignments: [] }); t.after(() => app.close());
      for (const suffix of ["", `?id_sucursal=${B}`]) {
        const response = await app.inject({ method: "GET", url: `${BASE}/${path}${suffix}` });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().data.id_sucursal, suffix ? B : null);
      }
      assert.ok(!calls.some((call) => call.sql.includes("roles_usuarios")));
    });
  }
}

for (const userId of [null, "invalid", "' OR TRUE --", 42]) {
  test(`identidad invalida ${userId} no autoriza ni consulta asignaciones`, async (t) => {
    const { app, calls } = await buildApp({ userId }); t.after(() => app.close());
    const response = await app.inject(requests(B)[0]);
    assert.equal(response.statusCode, 403);
    assert.ok(!calls.some((call) => call.sql.includes("roles_usuarios")));
  });
}

test("sin identidad autenticada no consulta asignaciones ni autoriza B", async (t) => {
  const { app, calls } = await buildApp({ missingUser: true }); t.after(() => app.close());
  const response = await app.inject(requests(B)[0]);
  assert.equal(response.statusCode, 403);
  assert.ok(!calls.some((call) => call.sql.includes("roles_usuarios")));
});

for (const roles of [null, ["barbero"], ["cliente"]]) {
  test(`sin rol administrativo conserva ${roles ? 403 : 401}`, async (t) => {
    const { app, calls } = await buildApp({ roles }); t.after(() => app.close());
    const response = await app.inject(requests(A)[0]);
    assert.equal(response.statusCode, roles ? 403 : 401);
    assert.deepEqual(calls, []);
  });
}

test("Paquetes rechaza la sucursal de barbero tras incorporar su alcance admin", async (t) => {
  const { app, calls } = await buildApp(); t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `${BASE}/paquetes?id_sucursal=${B}` });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
  assert.ok(calls.some((call) => call.sql.includes("roles_usuarios")));
});

for (const request of [
  { method: "PATCH", url: `${BASE}/servicios/${SERVICE}/desactivar-global` },
  { method: "GET", url: `${BASE}/servicios/${SERVICE}/barberos?id_sucursal=${A}` },
  { method: "PUT", url: `${BASE}/servicios/${SERVICE}/barberos`, payload: { id_sucursal: A, id_empleados: [] } },
]) {
  test(`admin conserva 403 exclusivo de super_admin: ${request.method} ${request.url}`, async (t) => {
    const { app, calls } = await buildApp(); t.after(() => app.close());
    const response = await app.inject(request);
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(calls, []);
  });
}

test("admin sin asignaciones no obtiene listado global ni auto seleccion", async (t) => {
  const { app } = await buildApp({ assignments: [] }); t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `${BASE}/servicios` });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "CATALOG_BRANCH_REQUIRED");
});
