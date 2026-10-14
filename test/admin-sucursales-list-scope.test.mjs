import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/sucursales.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const fixture = [
  { id_sucursal: B, nombre_sucursal: "Beta", estado: false },
  { id_sucursal: A, nombre_sucursal: "Alfa", estado: true },
  { id_sucursal: C, nombre_sucursal: "Gamma", estado: true },
].map((row) => ({ ...row, id_empresa: COMPANY, nombre_empresa: "MasterFade", direccion: null, telefono: null, fecha_inauguracion: null }));

async function buildApp({ roles = ["admin"], branches = [A], claims = { roles, branch_ids: branches } } = {}) {
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
    let rows = fixture;
    if (/s\.id_sucursal = ANY\(\$1::uuid\[\]\)/.test(text)) {
      assert.ok(Array.isArray(params[0]));
      rows = rows.filter((row) => params[0].map((id) => id.toLowerCase()).includes(row.id_sucursal));
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
    assert.match(queries[0].sql, /s\.id_sucursal = ANY\(\$1::uuid\[\]\)/);
    assert.deepEqual(queries[0].params, [branches]);
    assert.ok(!queries[0].sql.includes(A));
    assert.ok(!queries[0].sql.includes(B));
  });
}

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join("+")} conserva listado completo y contrato`, async (t) => {
    const { app, queries } = await buildApp({ roles, branches: [] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, [fixture[1], fixture[0], fixture[2]]);
    assert.deepEqual(queries[0].params, []);
    assert.doesNotMatch(queries[0].sql, /ANY\(/);
  });
}

for (const claims of [null, {}, { branch_ids: [A] }, { roles: "super_admin", branch_ids: [A] }, { roles: ["admin"] }, { roles: ["admin"], branch_ids: null }, { roles: ["admin"], branch_ids: A }, { roles: ["admin"], branch_ids: [null, 42, {}, "not-a-uuid", "' OR TRUE --"] }]) {
  test(`claims invalidos producen lista vacia: ${JSON.stringify(claims)}`, async (t) => {
    const { app, queries } = await buildApp({ claims }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/sucursales" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.sucursales, []);
    assert.deepEqual(queries[0].params, [[]]);
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
