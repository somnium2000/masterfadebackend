import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import routes from "../src/routes/v1/admin/cortesias.js";

const ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const assignment = (rol, id_sucursal, activo = true, id_usuario = ID) => ({ rol, id_sucursal, activo, id_usuario });

const cleanSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

async function buildApp({ roles = ["admin"], claims = [A], assignments = claims.map((id) => assignment("admin", id)), userId = ID, missingUser = false, associations = [[A, true], [B, true], [C, false]], linked = true, exists = true, duplicate = false, failUpdate = false, failState = false } = {}) {
  const state = { branches: new Map(associations), queries: [], upserts: [], masterUpdates: [], implicitUpdates: 0, begin: 0, commit: 0, rollback: 0 };
  const row = () => ({
    id: ID,
    nombre: "Corte gratis",
    descripcion: "Original",
    created_at: null,
    updated_at: null,
    sucursales: [...state.branches].map(([id_sucursal, activa], index) => ({ id: `0000000${index + 1}-0000-4000-8000-000000000000`, id_sucursal, nombre_sucursal: id_sucursal, activa, created_at: null, updated_at: null })),
  });
  const query = async (sql, params = []) => {
    const text = cleanSql(sql);
    state.queries.push({ text, params });
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
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) { state[text.toLowerCase()] += 1; return { rows: [], rowCount: 0 }; }
    if (text.includes("FROM public.cortesias") && text.includes("WHERE id = $1::uuid") && text.includes("LIMIT 1")) return { rows: exists ? [row()] : [], rowCount: exists ? 1 : 0 };
    if (text.includes("FROM public.cortesias_sucursales cs") && text.includes("ANY($2::uuid[])")) {
      const authorized = linked && params[1].some((id) => state.branches.has(id));
      return { rows: authorized ? [{}] : [], rowCount: authorized ? 1 : 0 };
    }
    if (text.includes("FROM public.sucursales s") && text.includes("ANY($1::uuid[])")) return { rows: params[0].map((id_sucursal) => ({ id_sucursal })), rowCount: params[0].length };
    if (text.includes("LOWER(regexp_replace(TRIM(c.nombre)")) return { rows: duplicate ? [{}] : [], rowCount: duplicate ? 1 : 0 };
    if (text.startsWith("UPDATE public.cortesias SET")) { state.masterUpdates.push({ text, params }); if (failUpdate) throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    if (text.includes("SELECT 1 FROM public.sucursales WHERE id_sucursal")) return { rows: [{}], rowCount: 1 };
    if (text.startsWith("UPDATE public.cortesias_sucursales SET activa =")) {
      if (failState) throw new Error("simulated state failure");
      state.branches.set(params[1], params[2]);
      return { rows: [{ id: ID }], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO public.cortesias_sucursales")) { state.upserts.push({ id_sucursal: params[1], activa: params[2] }); state.branches.set(params[1], params[2]); return { rows: [], rowCount: 1 }; }
    if (text.includes("NOT (id_sucursal = ANY")) { state.implicitUpdates += 1; return { rows: [], rowCount: 1 }; }
    if (text.includes("WHERE c.id = $1::uuid") && text.includes("GROUP BY c.id")) return { rows: [row()], rowCount: 1 };
    if (text.includes("ORDER BY c.nombre ASC, c.created_at DESC")) {
      const scopedRow = row();
      scopedRow.sucursales = scopedRow.sucursales.filter((scope) => !params[0] || scope.id_sucursal === params[0]);
      return { rows: !params[0] || state.branches.has(params[0]) ? [scopedRow] : [], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO public.cortesias (")) return { rows: [{ id: ID }], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${text.slice(0, 180)}`);
  };
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: claims, user: missingUser ? undefined : { id_usuario: userId } };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/catalog/cortesias" });
  await app.ready();
  return { app, state };
}

async function patch(app, payload) {
  return app.inject({ method: "PATCH", url: `/v1/admin/catalog/cortesias/${ID}`, payload });
}

for (const endpoint of ["", "/estado"]) {
  for (const [roles, claims, expected] of [
    [["admin"], [A], [A]],
    [["admin"], [A, B], [A, B]],
    [["super_admin"], [], [A, B, C]],
    [["admin", "super_admin"], [A], [A, B, C]],
  ]) {
    test(`PATCH ${endpoint || "maestro"} limita respuesta para ${roles.join("+")} con ${claims.length} sucursales`, async (t) => {
      const { app, state } = await buildApp({ roles, claims });
      t.after(() => app.close());
      const response = await app.inject({ method: "PATCH", url: `/v1/admin/catalog/cortesias/${ID}${endpoint}`,
        payload: endpoint ? { id_sucursal: A, activa: false } : { descripcion: "Actualizada" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().data.sucursales.map((scope) => scope.id_sucursal), expected);
      assert.equal(state.branches.get(B), true);
      assert.equal(state.branches.get(C), false);
      assert.equal(state.masterUpdates.length, endpoint ? 0 : 1);
      assert.equal(state.branches.get(A), endpoint ? false : true);
      assert.equal(state.commit, 1);
      assert.equal(state.rollback, 0);
    });
  }
}

test("estado fuera de alcance devuelve 403 sin escrituras", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/admin/catalog/cortesias/${ID}/estado`, payload: { id_sucursal: B, activa: false } });
  assert.equal(response.statusCode, 403);
  assert.equal(state.begin, 0);
  assert.equal(state.branches.get(B), true);
});

test("error al cambiar estado revierte sin commit", async (t) => {
  const { app, state } = await buildApp({ failState: true }); t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/admin/catalog/cortesias/${ID}/estado`, payload: { id_sucursal: A, activa: false } });
  assert.equal(response.statusCode, 500);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
  assert.equal(state.branches.get(A), true);
});

test("admin de A edita campos globales y conserva B y C por omision", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { nombre: "Corte global", descripcion: "Nueva" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual([...state.branches.values()], [true, true, false]);
  assert.equal(state.upserts.length, 0);
  assert.equal(state.implicitUpdates, 0);
});

test("admin de A y B modifica solo A y B conserva estado", async (t) => {
  const { app, state } = await buildApp({ claims: [A, B] }); t.after(() => app.close());
  const response = await patch(app, { sucursales: [{ id_sucursal: A, activa: false }] });
  assert.equal(response.statusCode, 200);
  assert.equal(state.branches.get(A), false);
  assert.equal(state.branches.get(B), true);
});

test("PATCH solo de asociacion no escribe campos maestros", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { sucursales: [{ id_sucursal: A, activa: false }] });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 0);
});

test("PATCH solo de nombre no sobrescribe una descripcion concurrente", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { nombre: "Corte de bienvenida" });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.match(state.masterUpdates[0].text, /nombre =/);
  assert.doesNotMatch(state.masterUpdates[0].text, /descripcion =/);
});

test("PATCH solo de descripcion no incluye nombre en el UPDATE", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { descripcion: "Descripcion concurrente" });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.match(state.masterUpdates[0].text, /descripcion =/);
  assert.doesNotMatch(state.masterUpdates[0].text, /nombre =/);
});

test("descripcion null conserva la limpieza explicita", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { descripcion: null });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.equal(state.masterUpdates[0].params[1], null);
});

test("PATCH de maestro y asociaciones aplica ambas operaciones", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, {
    nombre: "Corte actualizado",
    descripcion: "Descripcion actualizada",
    sucursales: [{ id_sucursal: A, activa: false }],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.match(state.masterUpdates[0].text, /nombre =/);
  assert.match(state.masterUpdates[0].text, /descripcion =/);
  assert.deepEqual(state.upserts, [{ id_sucursal: A, activa: false }]);
});

test("inactivacion explicita se aplica y asociacion omitida se conserva", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { sucursales: [{ id_sucursal: A, activa: false }] });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.upserts, [{ id_sucursal: A, activa: false }]);
  assert.equal(state.branches.get(B), true);
});

test("admin no puede enviar una sucursal fuera de alcance", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patch(app, { sucursales: [{ id_sucursal: C, activa: true }] });
  assert.equal(response.statusCode, 403);
  assert.equal(state.rollback, 1);
  assert.equal(state.upserts.length, 0);
});

test("admin no puede editar una cortesia completamente ajena", async (t) => {
  const { app, state } = await buildApp({ linked: false }); t.after(() => app.close());
  const response = await patch(app, { descripcion: "No autorizada" });
  assert.equal(response.statusCode, 403);
  assert.equal(state.rollback, 1);
});

test("admin sin sucursales recibe rechazo controlado", async (t) => {
  const { app } = await buildApp({ claims: [] }); t.after(() => app.close());
  const response = await patch(app, { descripcion: "No autorizada" });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
});

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join(" + ")} conserva alcance global`, async (t) => {
    const { app, state } = await buildApp({ roles, claims: [] }); t.after(() => app.close());
    const response = await patch(app, { sucursales: [{ id_sucursal: C, activa: true }] });
    assert.equal(response.statusCode, 200);
    assert.equal(state.branches.get(C), true);
  });
}

for (const [label, roles, expected] of [["sin sesion", null, 401], ["cliente", ["cliente"], 403]]) {
  test(`${label} queda bloqueado`, async (t) => {
    const { app } = await buildApp({ roles }); t.after(() => app.close());
    assert.equal((await patch(app, { descripcion: "Cambio" })).statusCode, expected);
  });
}

test("UUID inexistente responde 404", async (t) => {
  const { app } = await buildApp({ exists: false }); t.after(() => app.close());
  assert.equal((await patch(app, { descripcion: "Cambio" })).statusCode, 404);
});

test("nombre duplicado responde 409 sin modificar asociaciones", async (t) => {
  const { app, state } = await buildApp({ duplicate: true }); t.after(() => app.close());
  assert.equal((await patch(app, { nombre: "Duplicada" })).statusCode, 409);
  assert.equal(state.upserts.length, 0);
});

test("falla SQL ejecuta rollback sin commit ni asociaciones parciales", async (t) => {
  const { app, state } = await buildApp({ failUpdate: true }); t.after(() => app.close());
  assert.equal((await patch(app, { descripcion: "Cambio" })).statusCode, 500);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
  assert.equal(state.upserts.length, 0);
});

function scopedRequests(branch) {
  const base = "/v1/admin/catalog/cortesias";
  return [
    { method: "GET", url: `${base}?id_sucursal=${branch}` },
    { method: "POST", url: base, payload: { nombre: "Nueva", sucursales: [{ id_sucursal: branch, activa: true }] } },
    { method: "PATCH", url: `${base}/${ID}`, payload: { descripcion: "Editada", sucursales: [{ id_sucursal: branch, activa: true }] } },
    { method: "PATCH", url: `${base}/${ID}/estado`, payload: { id_sucursal: branch, activa: false } },
  ];
}

for (const roles of [null, ["cliente"]]) {
  for (const request of scopedRequests(A).filter((item) => item.method !== "PATCH" || item.url.endsWith("/estado"))) {
    test(`sin autorizacion conserva ${roles ? 403 : 401}: ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp({ roles }); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, roles ? 403 : 401);
      assert.deepEqual(state.queries, []);
    });
  }
}

test("el alcance corresponde al usuario autenticado y no a una identidad fija", async (t) => {
  const { app } = await buildApp({ userId: OTHER_USER, claims: [A, B], assignments: [assignment("admin", A), assignment("admin", B, true, OTHER_USER)] });
  t.after(() => app.close());
  const response = await app.inject(scopedRequests(B)[0]);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.cortesias[0].sucursales.map((scope) => scope.id_sucursal), [B]);
});

for (const request of scopedRequests(B)) {
  for (const scenario of [
    { name: "admin A + barbero B", assignments: [assignment("admin", A), assignment("barbero", B)] },
    { name: "admin B inactivo", assignments: [assignment("admin", B, false)] },
    { name: "admin B de otro usuario", assignments: [assignment("admin", B, true, OTHER_USER)] },
    { name: "sin asignaciones administrativas", assignments: [] },
  ]) {
    test(`${scenario.name} rechaza ${request.method} ${request.url} sin escrituras`, async (t) => {
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
      assert.ok(!state.queries.some(({ text }) => /^(INSERT|UPDATE|DELETE)/.test(text)));
      assert.equal(state.commit, 0);
      assert.equal(state.branches.get(B), true);
      if (request.method === "PATCH" && !request.url.endsWith("/estado")) assert.equal(state.rollback, 1);
    });
  }
}

for (const scenario of [
  { name: "admin A + barbero B", roles: ["admin", "barbero"], assignments: [assignment("admin", A), assignment("barbero", B)], branch: A, allowed: [A] },
  { name: "admin A+B en A", roles: ["admin"], assignments: [assignment("admin", A), assignment("admin", B)], branch: A, allowed: [A, B] },
  { name: "admin A+B en B", roles: ["admin"], assignments: [assignment("admin", A), assignment("admin", B)], branch: B, allowed: [A, B] },
]) {
  for (const request of scopedRequests(scenario.branch)) {
    test(`${scenario.name} permite ${request.method} ${request.url} y filtra respuesta`, async (t) => {
      const { app, state } = await buildApp({ roles: scenario.roles, claims: [A, B, C], assignments: scenario.assignments,
        ...(request.method === "POST" ? { associations: [] } : {}) });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      const data = response.json().data;
      const scopes = request.method === "GET" ? data.cortesias[0].sucursales : data.sucursales;
      const expected = ["GET", "POST"].includes(request.method) ? [scenario.branch] : scenario.allowed;
      assert.deepEqual(scopes.map((scope) => scope.id_sucursal), expected);
      assert.equal(typeof response.json().requestId, "string");
      assert.equal(state.queries.filter(({ text }) => text.startsWith("SELECT DISTINCT ru.id_sucursal")).length, 1);
      if (request.method === "PATCH") {
        assert.equal(state.branches.get(C), false);
        assert.equal(state.implicitUpdates, 0);
        assert.equal(state.commit, 1);
      }
    });
  }
}

test("rol ajeno no habilita editar un maestro asociado solamente a B", async (t) => {
  const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)], associations: [[B, true]] });
  t.after(() => app.close());
  const response = await patch(app, { descripcion: "No autorizada" });
  assert.equal(response.statusCode, 403);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
});

test("admin A + barbero B conserva edicion del maestro compartido sin cambiar asociaciones omitidas", async (t) => {
  const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)] });
  t.after(() => app.close());
  const response = await patch(app, { nombre: "Nombre compartido", descripcion: "Descripcion compartida" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(state.masterUpdates.length, 1);
  assert.deepEqual(state.masterUpdates[0].params, [ID, "Nombre compartido", "Descripcion compartida"]);
  assert.deepEqual([...state.branches], [[A, true], [B, true], [C, false]]);
  assert.deepEqual(state.upserts, []);
  assert.equal(state.implicitUpdates, 0);
  assert.deepEqual(response.json().data.sucursales.map((scope) => scope.id_sucursal), [A]);
});

for (const scenario of [
  { name: "identidad ausente", missingUser: true },
  { name: "identidad nula", userId: null },
  { name: "identidad no UUID", userId: "' OR TRUE --" },
]) {
  for (const request of scopedRequests(A)) {
    test(`${scenario.name} restringe ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp(scenario); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.ok(!state.queries.some(({ text }) => /^(INSERT|UPDATE|DELETE)/.test(text) || text.includes("roles_usuarios")));
      assert.equal(state.commit, 0);
    });
  }
}

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  for (const request of scopedRequests(B)) {
    test(`${roles.join("+")} conserva ${request.method} ${request.url} sin alcance admin`, async (t) => {
      const { app, state } = await buildApp({ roles, claims: [], assignments: [], missingUser: true }); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
      if (request.method !== "GET") assert.deepEqual(response.json().data.sucursales.map((scope) => scope.id_sucursal), [A, B, C]);
    });
  }
  test(`${roles.join("+")} conserva listado global`, async (t) => {
    const { app } = await buildApp({ roles, claims: [], assignments: [] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/catalog/cortesias" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.id_sucursal, null);
    assert.deepEqual(response.json().data.cortesias[0].sucursales.map((scope) => scope.id_sucursal), [A, B, C]);
  });
}

for (const [name, assignments, status] of [
  ["una admin y otra barbero", [assignment("admin", A), assignment("admin", A), assignment("barbero", B)], 200],
  ["varias admin", [assignment("admin", A), assignment("admin", B)], 400],
  ["ninguna admin", [], 400],
]) {
  test(`seleccion automatica de GET con ${name}`, async (t) => {
    const { app } = await buildApp({ claims: [A, B], assignments }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/catalog/cortesias" });
    assert.equal(response.statusCode, status, response.body);
    if (status === 200) assert.equal(response.json().data.id_sucursal, A);
    else assert.equal(response.json().error.code, "CATALOG_BRANCH_REQUIRED");
  });
}
