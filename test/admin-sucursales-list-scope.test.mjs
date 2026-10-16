import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/sucursales.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const DELETED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const assignment = (rol, id_sucursal, activo = true, id_usuario = USER) => ({ rol, id_sucursal, activo, id_usuario });
const fixture = [
  { id_sucursal: B, nombre_sucursal: "Beta", estado: false },
  { id_sucursal: A, nombre_sucursal: "Alfa", estado: true },
  { id_sucursal: C, nombre_sucursal: "Gamma", estado: true },
].map((row) => ({ ...row, id_empresa: COMPANY, nombre_empresa: "MasterFade", direccion: null, telefono: null, fecha_inauguracion: null }));

async function buildApp({ roles = ["admin"], branches = [A], assignments = branches.map((id) => assignment("admin", id)), claims = { roles, branch_ids: branches, user: { id_usuario: USER } } } = {}) {
  const queries = [];
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = claims;
  });
  app.decorate("db", { query: async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    queries.push({ sql: text, params });
    assert.match(text, /^SELECT /);
    assert.match(text, /WHERE s\.deleted_at IS NULL/);
    assert.match(text, /ORDER BY s\.nombre_sucursal ASC/);
    let rows = [...fixture, { ...fixture[0], id_sucursal: DELETED, deleted_at: "2026-01-01" }].filter((row) => !row.deleted_at);
    if (/AND EXISTS \(/.test(text)) {
      assert.match(text, /FROM public\.roles_usuarios ru JOIN public\.roles r ON r\.id_rol = ru\.id_rol/);
      assert.match(text, /WHERE ru\.id_usuario = \$1::uuid/);
      assert.match(text, /AND ru\.id_sucursal = s\.id_sucursal/);
      assert.match(text, /AND ru\.activo IS TRUE/);
      assert.match(text, /AND r\.nombre = 'admin'/);
      assert.deepEqual(params, [claims.user.id_usuario]);
      rows = rows.filter((row) => assignments.some((item) => item.id_usuario.toLowerCase() === params[0].toLowerCase()
        && item.rol === "admin" && item.activo === true && item.id_sucursal === row.id_sucursal));
    }
    if (text.includes("AND COALESCE(s.estado, TRUE) IS TRUE")) rows = rows.filter((row) => row.estado);
    rows = [...rows].sort((left, right) => left.nombre_sucursal.localeCompare(right.nombre_sucursal));
    return { rows, rowCount: rows.length };
  } });
  await app.register(routes, { prefix: "/v1/admin/sucursales" });
  await app.ready();
  return { app, queries };
}

for (const branches of [[A], [A, B], []]) {
  test(`admin obtiene solo ${branches.length} sucursales autorizadas mediante SQL`, async (t) => {
    const { app, queries } = await buildApp({ branches }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.sucursales.map((row) => row.id_sucursal), branches);
    assert.equal(typeof body.requestId, "string");
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /AND EXISTS \(/);
    assert.deepEqual(queries[0].params, [USER]);
    assert.ok(!queries[0].sql.includes(A));
    assert.ok(!queries[0].sql.includes(B));
    assert.ok(!queries[0].sql.includes(USER));
  });
}

for (const scenario of [
  { name: "admin A y barbero B solo obtiene A", assignments: [assignment("admin", A), assignment("barbero", B)], expected: [A] },
  { name: "admin A y admin B obtiene ambas", assignments: [assignment("admin", A), assignment("admin", B)], expected: [A, B] },
  { name: "sin asignaciones administrativas activas no obtiene sucursales", assignments: [assignment("admin", A, false), assignment("barbero", B)], expected: [] },
  { name: "asignacion admin de otro usuario no concede acceso", assignments: [assignment("admin", A), assignment("admin", B, true, OTHER_USER)], expected: [A] },
  { name: "asignaciones duplicadas no duplican sucursales", assignments: [assignment("admin", A), assignment("admin", A)], expected: [A] },
  { name: "asignacion sin sucursal no concede acceso global", assignments: [assignment("admin", null)], expected: [] },
  { name: "sucursal eliminada no se devuelve", assignments: [assignment("admin", A), assignment("admin", DELETED)], expected: [A] },
]) {
  test(scenario.name, async (t) => {
    const { app, queries } = await buildApp({ roles: ["admin", "barbero"], branches: [A, B, C], assignments: scenario.assignments });
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales.map((row) => row.id_sucursal), scenario.expected);
    assert.match(queries[0].sql, /AND EXISTS \(/);
    assert.deepEqual(queries[0].params, [USER]);
  });
}

for (const branch_ids of [undefined, null, [], [B], "not-an-array", [null, "' OR TRUE --"]]) {
  test(`branch_ids no determina el alcance administrativo: ${JSON.stringify(branch_ids)}`, async (t) => {
    const { app } = await buildApp({ claims: { roles: ["admin"], user: { id_usuario: USER }, branch_ids } });
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales.map((row) => row.id_sucursal), [A]);
  });
}

for (const id_usuario of [undefined, null, "", 42, {}, [], "not-a-uuid", "' OR TRUE --"]) {
  test(`identificador autenticado invalido no consulta ni expone registros: ${JSON.stringify(id_usuario)}`, async (t) => {
    const { app, queries } = await buildApp({ claims: { roles: ["admin"], branch_ids: [A, B], user: { id_usuario } } });
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, []);
    assert.equal(queries.length, 0);
  });
}

test("usa el identificador autenticado y no una identidad fija", async (t) => {
  const { app, queries } = await buildApp({
    claims: { roles: ["admin"], branch_ids: [A, B], user: { id_usuario: OTHER_USER } },
    assignments: [assignment("admin", A), assignment("admin", B, true, OTHER_USER)],
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.sucursales.map((row) => row.id_sucursal), [B]);
  assert.deepEqual(queries[0].params, [OTHER_USER]);
});

test("el cliente no puede aportar id_usuario para ampliar alcance", async (t) => {
  const { app, queries } = await buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/admin/sucursales?id_usuario=${OTHER_USER}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.sucursales.map((row) => row.id_sucursal), [A]);
  assert.deepEqual(queries[0].params, [USER]);
});

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join("+")} conserva listado completo y contrato`, async (t) => {
    const { app, queries } = await buildApp({ roles, branches: [] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, [fixture[1], fixture[0], fixture[2]]);
    assert.deepEqual(queries[0].params, []);
    assert.doesNotMatch(queries[0].sql, /ANY\(/);
    assert.doesNotMatch(queries[0].sql, /roles_usuarios|EXISTS/);
  });
  test(`${roles.join("+")} conserva precedencia sin identificador ni asignaciones administrativas`, async (t) => {
    const { app } = await buildApp({ roles, assignments: [assignment("barbero", A)], claims: { roles, branch_ids: [] } });
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, [fixture[1], fixture[0], fixture[2]]);
  });
}

for (const claims of [null, {}, { branch_ids: [A] }, { roles: "super_admin", branch_ids: [A] }, { roles: ["admin"] }, { roles: ["admin"], branch_ids: null }, { roles: ["admin"], branch_ids: A }, { roles: ["admin"], branch_ids: [null, 42, {}, "not-a-uuid", "' OR TRUE --"] }]) {
  test(`claims invalidos producen lista vacia: ${JSON.stringify(claims)}`, async (t) => {
    const { app, queries } = await buildApp({ claims }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, []);
    assert.equal(queries.length, 0);
  });
}

for (const roles of [["admin"], ["super_admin"]]) {
  for (const onlyActive of [true, false]) {
    test(`${roles[0]} solo_activas=${onlyActive} conserva alcance y estado`, async (t) => {
      const { app } = await buildApp({ roles, branches: [A, B] }); t.after(() => app.close());
      const response = await app.inject({ method: "GET", url: `/v1/admin/sucursales?solo_activas=${onlyActive}` });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().data.sucursales.map((row) => row.id_sucursal), onlyActive ? (roles[0] === "admin" ? [A] : [A, C]) : (roles[0] === "admin" ? [A, B] : [A, B, C]));
    });
  }
}

for (const request of [
  { method: "GET", url: "/v1/admin/sucursales/empresas" },
  { method: "GET", url: `/v1/admin/sucursales/${A}` },
  { method: "POST", url: "/v1/admin/sucursales", payload: { id_empresa: COMPANY, nombre_sucursal: "Nueva" } },
  { method: "PATCH", url: `/v1/admin/sucursales/${A}`, payload: { nombre_sucursal: "Cambio" } },
  { method: "PATCH", url: `/v1/admin/sucursales/${A}/activar` },
  { method: "PATCH", url: `/v1/admin/sucursales/${A}/inactivar` },
  { method: "DELETE", url: `/v1/admin/sucursales/${A}` },
]) {
  test(`admin conserva 403 en ${request.method} ${request.url}`, async (t) => {
    const { app, queries } = await buildApp(); t.after(() => app.close());
    assert.equal((await app.inject(request)).statusCode, 403);
    assert.equal(queries.length, 0);
  });
}

for (const roles of [null, ["cliente"]]) {
  test(`listado conserva ${roles ? 403 : 401} sin autorizacion`, async (t) => {
    const { app, queries } = await buildApp({ roles }); t.after(() => app.close());
    assert.equal((await app.inject({ method: "GET", url: "/v1/admin/sucursales" })).statusCode, roles ? 403 : 401);
    assert.equal(queries.length, 0);
  });
}
