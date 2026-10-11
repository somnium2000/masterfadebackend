import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import routes from "../src/routes/v1/admin/cortesias.js";

const ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const cleanSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

async function buildApp({ roles = ["admin"], claims = [A], linked = true, exists = true, duplicate = false, failUpdate = false } = {}) {
  const state = { branches: new Map([[A, true], [B, true], [C, false]]), upserts: [], masterUpdates: [], implicitUpdates: 0, begin: 0, commit: 0, rollback: 0 };
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
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) { state[text.toLowerCase()] += 1; return { rows: [], rowCount: 0 }; }
    if (text.includes("FROM public.cortesias") && text.includes("WHERE id = $1::uuid") && text.includes("LIMIT 1")) return { rows: exists ? [row()] : [], rowCount: exists ? 1 : 0 };
    if (text.includes("FROM public.cortesias_sucursales cs") && text.includes("ANY($2::uuid[])")) return { rows: linked ? [{}] : [], rowCount: linked ? 1 : 0 };
    if (text.includes("FROM public.sucursales s") && text.includes("ANY($1::uuid[])")) return { rows: params[0].map((id_sucursal) => ({ id_sucursal })), rowCount: params[0].length };
    if (text.includes("LOWER(regexp_replace(TRIM(c.nombre)")) return { rows: duplicate ? [{}] : [], rowCount: duplicate ? 1 : 0 };
    if (text.startsWith("UPDATE public.cortesias SET")) { state.masterUpdates.push({ text, params }); if (failUpdate) throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("INSERT INTO public.cortesias_sucursales")) { state.upserts.push({ id_sucursal: params[1], activa: params[2] }); state.branches.set(params[1], params[2]); return { rows: [], rowCount: 1 }; }
    if (text.includes("NOT (id_sucursal = ANY")) { state.implicitUpdates += 1; return { rows: [], rowCount: 1 }; }
    if (text.includes("WHERE c.id = $1::uuid") && text.includes("GROUP BY c.id")) return { rows: [row()], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${text.slice(0, 180)}`);
  };
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: claims };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/catalog/cortesias" });
  await app.ready();
  return { app, state };
}

async function patch(app, payload) {
  return app.inject({ method: "PATCH", url: `/v1/admin/catalog/cortesias/${ID}`, payload });
}

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
