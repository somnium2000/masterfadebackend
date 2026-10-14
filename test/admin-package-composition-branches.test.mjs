import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import routes from "../src/routes/v1/admin/catalog.js";

const PACKAGE = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const S1 = "21111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "23333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const assignment = (rol, id_sucursal, activo = true, id_usuario = PACKAGE) => ({ rol, id_sucursal, activo, id_usuario });

const cleanSql = (sql) => String(sql).replace(/\s+/g, " ").trim();
const packageRow = (branchId = A) => ({
  id_paquete: PACKAGE,
  nombre_paquete: "Paquete base",
  descripcion: "Original",
  precio_hnl: 500,
  activo: true,
  visible_publico: true,
  orden_visual: 10,
  id_sucursal: branchId,
  items: [
    { id_servicio: S1, nombre_servicio: "Servicio 1", cantidad: 1 },
    { id_servicio: S2, nombre_servicio: "Servicio 2", cantidad: 1 },
  ],
});

async function buildApp({
  roles = ["admin"],
  claims = [A],
  assignments = claims.map((id) => assignment("admin", id)),
  userId = PACKAGE,
  missingUser = false,
  activeBranches = [A, B],
  incompatibleBranches = [B],
  notBookableBranches = [],
  missingServiceBranches = [],
  exists = true,
  duplicateName = false,
  failOn = null,
} = {}) {
  const state = { queries: [], masterUpdates: [], detailDeletes: 0, detailInserts: 0, offerWrites: 0, rollback: 0, commit: 0, activeOfferQueries: 0, validatedBranches: [], sequence: [] };
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
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    if (text === "COMMIT") { state.commit += 1; return { rows: [], rowCount: 0 }; }
    if (text === "ROLLBACK") { state.rollback += 1; return { rows: [], rowCount: 0 }; }
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    if (text.includes("package_active_offers")) { state.sequence.push("active-offers"); state.activeOfferQueries += 1; if (failOn === "activeOffers") throw new Error("simulated"); return { rows: activeBranches.map((id_sucursal) => ({ id_sucursal })), rowCount: activeBranches.length }; }
    if (text.includes("package_composition_lock")) { state.sequence.push("lock"); return { rows: exists ? [{ id_paquete: PACKAGE }] : [], rowCount: exists ? 1 : 0 }; }
    if (text.includes("WITH picked_offer AS") && text.includes("GROUP BY p.id_paquete")) return { rows: [packageRow(params[1])], rowCount: 1 };
    if (text.includes("HAVING COUNT(pd.id_servicio) >= 2")) return { rows: [packageRow(params[0])], rowCount: 1 };
    if (text.includes("FROM public.paquetes p") && text.includes("GROUP BY p.id_paquete")) return { rows: exists ? [packageRow()] : [], rowCount: exists ? 1 : 0 };
    if (text.includes("lower(regexp_replace(trim(p.nombre_paquete)")) return { rows: duplicateName ? [{ id_paquete: PACKAGE }] : [], rowCount: duplicateName ? 1 : 0 };
    if (text.startsWith("INSERT INTO public.paquetes (")) { if (failOn === "create") throw new Error("simulated"); return { rows: [{ id_paquete: PACKAGE }], rowCount: 1 }; }
    if (text.includes("total_citas_futuras")) return { rows: [{ total_citas_futuras: 0 }], rowCount: 1 };
    if (text.includes("AS has_scoped_tariff") && text.includes("FROM public.servicios s")) {
      const branchId = params[0]?.[0];
      state.validatedBranches.push(branchId);
      const serviceIds = missingServiceBranches.includes(branchId) ? params[1].slice(0, 1) : params[1];
      return {
        rows: serviceIds.map((id_servicio) => ({
          id_servicio,
          agendable: !notBookableBranches.includes(branchId),
          has_scoped_tariff: !incompatibleBranches.includes(branchId),
        })),
        rowCount: serviceIds.length,
      };
    }
    if (text.includes("FROM public.paquetes_detalles pd") && text.includes("ORDER BY pd.id_servicio")) return { rows: [{ id_servicio: S1, cantidad: 1 }, { id_servicio: S2, cantidad: 1 }], rowCount: 2 };
    if (text.startsWith("UPDATE public.paquetes SET")) { state.sequence.push("master"); state.masterUpdates.push({ sql: text, params }); if (failOn === "master") throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("DELETE FROM public.paquetes_detalles")) { state.sequence.push("delete"); state.detailDeletes += 1; if (failOn === "delete") throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("INSERT INTO public.paquetes_detalles")) { state.sequence.push("insert"); state.detailInserts += 1; if (failOn === "insert") throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    if (text.includes("FROM public.paquetes_sucursal ps") && text.includes("FOR UPDATE")) {
      return { rows: [{ id_paquete_sucursal: "31111111-1111-4111-8111-111111111111", id_paquete: PACKAGE, id_sucursal: A, precio_hnl: 500, activo: true, visible_publico: true, orden_visual: 10 }], rowCount: 1 };
    }
    if (text.startsWith("UPDATE public.paquetes_sucursal SET")) { state.sequence.push("offer"); state.offerWrites += 1; if (failOn === "offer") throw new Error("simulated"); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected SQL: ${text.slice(0, 220)}`);
  };

  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: claims, user: missingUser ? undefined : { id_usuario: userId } };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/catalog" });
  await app.ready();
  return { app, state };
}

const compositionPayload = {
  id_sucursal: A,
  items: [
    { id_servicio: S1, cantidad: 2 },
    { id_servicio: S2, cantidad: 1 },
  ],
};

const patchPackage = (app, payload = compositionPayload) => app.inject({
  method: "PATCH",
  url: `/v1/admin/catalog/paquetes/${PACKAGE}`,
  payload,
});

test("rechaza composicion compatible en A pero incompatible en oferta activa B", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  const response = await patchPackage(app);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PACKAGE_COMPOSITION_BRANCH_CONFLICT");
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.detailDeletes, 0);
  assert.equal(state.detailInserts, 0);
  assert.equal(state.offerWrites, 0);
});

test("acepta composicion compatible en dos ofertas activas", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 200);
  assert.deepEqual(state.validatedBranches, [A, B]);
  assert.equal(state.detailDeletes, 1);
  assert.equal(state.detailInserts, 2);
});

test("rechaza tres sucursales cuando una oferta activa es incompatible", async (t) => {
  const { app } = await buildApp({ activeBranches: [A, B], incompatibleBranches: [B, C] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
});

test("oferta inactiva incompatible no bloquea", async (t) => {
  const { app, state } = await buildApp({ activeBranches: [A], incompatibleBranches: [C] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 200);
  assert.deepEqual(state.validatedBranches, [A]);
});

test("oferta activa invisible incompatible bloquea", async (t) => {
  const { app } = await buildApp({ activeBranches: [A, B], incompatibleBranches: [B] }); t.after(() => app.close());
  const response = await patchPackage(app);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PACKAGE_COMPOSITION_BRANCH_CONFLICT");
});

test("servicio no agendable rechaza composicion", async (t) => {
  const { app } = await buildApp({ incompatibleBranches: [], notBookableBranches: [B] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
});

test("servicio informativo sin tarifa operativa rechaza composicion", async (t) => {
  const { app } = await buildApp({ incompatibleBranches: [B] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
});

test("servicio sin tarifa vigente rechaza composicion", async (t) => {
  const { app } = await buildApp({ incompatibleBranches: [B] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
});

test("servicio inexistente o inactivo rechaza composicion", async (t) => {
  const { app } = await buildApp({ incompatibleBranches: [], missingServiceBranches: [B] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
});

for (const [label, payload] of [
  ["precio", { id_sucursal: A, precio_hnl: 650 }],
  ["visibilidad", { id_sucursal: A, visible_publico: false }],
  ["nombre y descripcion", { id_sucursal: A, nombre_paquete: "Nuevo nombre", descripcion: "Nueva descripcion" }],
]) {
  test(`edicion solo de ${label} no ejecuta validacion global`, async (t) => {
    const { app, state } = await buildApp(); t.after(() => app.close());
    assert.equal((await patchPackage(app, payload)).statusCode, 200);
    assert.equal(state.activeOfferQueries, 0);
    assert.deepEqual(state.validatedBranches, label === "nombre y descripcion" ? [] : [A]);
  });
}

test("composicion incompatible con precio no altera oferta", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patchPackage(app, { ...compositionPayload, precio_hnl: 700 });
  assert.equal(response.statusCode, 409);
  assert.equal(state.offerWrites, 0);
});

test("error SQL durante validacion ejecuta rollback", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [], failOn: "activeOffers" }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 500);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
});

test("incompatibilidad preserva maestro detalles y ofertas", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 409);
  assert.deepEqual(
    { master: state.masterUpdates.length, deletes: state.detailDeletes, inserts: state.detailInserts, offers: state.offerWrites },
    { master: 0, deletes: 0, inserts: 0, offers: 0 }
  );
});

test("admin conserva validacion de sucursal de operacion", async (t) => {
  const { app } = await buildApp({ claims: [A], incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app, { ...compositionPayload, id_sucursal: B })).statusCode, 403);
});

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join(" + ")} conserva operacion global compatible`, async (t) => {
    const { app } = await buildApp({ roles, claims: [], incompatibleBranches: [] }); t.after(() => app.close());
    assert.equal((await patchPackage(app)).statusCode, 200);
  });
}

test("usuario sin permisos recibe 403", async (t) => {
  const { app } = await buildApp({ roles: ["cliente"] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 403);
});

test("usuario sin sesion recibe 401", async (t) => {
  const { app } = await buildApp({ roles: null }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 401);
});

test("UUID de paquete inexistente conserva respuesta 404", async (t) => {
  const { app } = await buildApp({ exists: false }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 404);
});

test("paquete sin otras ofertas activas conserva validacion local", async (t) => {
  const { app, state } = await buildApp({ activeBranches: [], incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 200);
  assert.deepEqual(state.validatedBranches, [A]);
});

test("version antigua activa y version vigente inactiva no valida esa sucursal", async (t) => {
  const { app, state } = await buildApp({ activeBranches: [A], incompatibleBranches: [C] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 200);
  assert.equal(state.validatedBranches.includes(C), false);
});

test("bloquea el paquete antes de validar y sustituir composicion", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app)).statusCode, 200);
  assert.ok(state.sequence.indexOf("lock") < state.sequence.indexOf("active-offers"));
  assert.ok(state.sequence.indexOf("lock") < state.sequence.indexOf("delete"));
});

for (const failOn of ["delete", "insert"]) {
  test(`falla SQL en ${failOn} revierte la transaccion`, async (t) => {
    const { app, state } = await buildApp({ incompatibleBranches: [], failOn }); t.after(() => app.close());
    assert.equal((await patchPackage(app)).statusCode, 500);
    assert.equal(state.rollback, 1);
    assert.equal(state.commit, 0);
  });
}

for (const [failOn, payload] of [
  ["master", { id_sucursal: A, nombre_paquete: "Nuevo nombre" }],
  ["offer", { id_sucursal: A, precio_hnl: 650 }],
]) {
  test(`falla SQL en ${failOn} revierte la transaccion`, async (t) => {
    const { app, state } = await buildApp({ incompatibleBranches: [], failOn }); t.after(() => app.close());
    assert.equal((await patchPackage(app, payload)).statusCode, 500);
    assert.equal(state.rollback, 1);
    assert.equal(state.commit, 0);
  });
}

test("nombre parcial no sobrescribe descripcion ni oferta", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app, { id_sucursal: A, nombre_paquete: "Nuevo nombre" })).statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.match(state.masterUpdates[0].sql, /nombre_paquete = \$2/);
  assert.doesNotMatch(state.masterUpdates[0].sql, /descripcion\s*=/);
  assert.equal(state.offerWrites, 0);
  assert.equal(state.detailDeletes, 0);
});

test("descripcion parcial admite limpieza explicita sin sobrescribir nombre", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  assert.equal((await patchPackage(app, { id_sucursal: A, descripcion: null })).statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.match(state.masterUpdates[0].sql, /descripcion = \$2/);
  assert.doesNotMatch(state.masterUpdates[0].sql, /nombre_paquete\s*=/);
  assert.equal(state.masterUpdates[0].params[1], null);
  assert.equal(state.offerWrites, 0);
});

test("composicion equivalente en distinto orden no se revalida ni reemplaza", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await patchPackage(app, {
    id_sucursal: A,
    items: [
      { id_servicio: S2, cantidad: 1 },
      { id_servicio: S1, cantidad: 1 },
    ],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.activeOfferQueries, 0);
  assert.equal(state.detailDeletes, 0);
  assert.equal(state.detailInserts, 0);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
});

test("cambio de servicio ejecuta validacion global y reemplazo", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  const response = await patchPackage(app, {
    id_sucursal: A,
    items: [
      { id_servicio: S1, cantidad: 1 },
      { id_servicio: S3, cantidad: 1 },
    ],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.activeOfferQueries, 1);
  assert.equal(state.detailDeletes, 1);
  assert.equal(state.detailInserts, 2);
});

for (const [label, localField] of [
  ["precio", { precio_hnl: 650 }],
  ["visibilidad", { visible_publico: false }],
  ["orden visual", { orden_visual: 25 }],
]) {
  test(`items equivalentes con ${label} conservan validacion local`, async (t) => {
    const { app, state } = await buildApp({ incompatibleBranches: [A] }); t.after(() => app.close());
    const response = await patchPackage(app, { ...compositionPayload, items: [
      { id_servicio: S2, cantidad: 1 },
      { id_servicio: S1, cantidad: 1 },
    ], ...localField });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(state.validatedBranches, [A]);
    assert.equal(state.activeOfferQueries, 0);
    assert.equal(state.offerWrites, 0);
    assert.equal(state.detailDeletes, 0);
  });
}

test("oferta local incompatible se rechaza igual con y sin items equivalentes", async (t) => {
  const withItems = await buildApp({ incompatibleBranches: [A] }); t.after(() => withItems.app.close());
  const withoutItems = await buildApp({ incompatibleBranches: [A] }); t.after(() => withoutItems.app.close());
  const equivalentItems = [
    { id_servicio: S1, cantidad: 1 },
    { id_servicio: S2, cantidad: 1 },
  ];
  const first = await patchPackage(withItems.app, { id_sucursal: A, items: equivalentItems, precio_hnl: 650 });
  const second = await patchPackage(withoutItems.app, { id_sucursal: A, precio_hnl: 650 });
  assert.equal(first.statusCode, 409);
  assert.equal(second.statusCode, 409);
  assert.equal(withItems.state.offerWrites, 0);
  assert.equal(withoutItems.state.offerWrites, 0);
});

test("items equivalentes con precio y servicios disponibles actualizan solo oferta local", async (t) => {
  const { app, state } = await buildApp({ incompatibleBranches: [] }); t.after(() => app.close());
  const response = await patchPackage(app, { id_sucursal: A, items: [
    { id_servicio: S2, cantidad: 1 },
    { id_servicio: S1, cantidad: 1 },
  ], precio_hnl: 650 });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.validatedBranches, [A]);
  assert.equal(state.activeOfferQueries, 0);
  assert.equal(state.offerWrites, 1);
  assert.equal(state.detailDeletes, 0);
  assert.equal(state.detailInserts, 0);
});

function scopeRequests(branch) {
  const base = "/v1/admin/catalog/paquetes";
  return [
    { method: "GET", url: `${base}?id_sucursal=${branch}` },
    { method: "POST", url: base, payload: { nombre_paquete: "Nuevo", items: compositionPayload.items, ofertas: [{ id_sucursal: branch, precio_hnl: 600 }] } },
    { method: "PATCH", url: `${base}/${PACKAGE}`, payload: { id_sucursal: branch, descripcion: "Editada" } },
    { method: "PATCH", url: `${base}/${PACKAGE}/estado`, payload: { id_sucursal: branch, activo: true } },
    { method: "PATCH", url: `${base}/${PACKAGE}/estado`, payload: { id_sucursal: branch, activo: false } },
    { method: "DELETE", url: `${base}/${PACKAGE}?id_sucursal=${branch}` },
  ];
}

for (const request of scopeRequests(B)) {
  for (const scenario of [
    { name: "admin A + barbero B", assignments: [assignment("admin", A), assignment("barbero", B)] },
    { name: "admin B inactivo", assignments: [assignment("admin", B, false)] },
    { name: "admin B de otro usuario", assignments: [assignment("admin", B, true, OTHER_USER)] },
    { name: "sin asignaciones", assignments: [] },
  ]) {
    test(`${scenario.name} rechaza ${request.method} ${request.url} antes de escribir`, async (t) => {
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "AUTH_FORBIDDEN_BRANCH");
      assert.ok(!state.queries.some(({ text }) => /^(BEGIN|INSERT|UPDATE|DELETE)/.test(text)));
      assert.equal(state.commit, 0);
    });
  }
}

for (const scenario of [
  { name: "admin A + barbero B opera A", assignments: [assignment("admin", A), assignment("barbero", B)], branch: A },
  { name: "admin A+B opera A", assignments: [assignment("admin", A), assignment("admin", B)], branch: A },
  { name: "admin A+B opera B", assignments: [assignment("admin", A), assignment("admin", B)], branch: B },
]) {
  for (const request of scopeRequests(scenario.branch)) {
    test(`${scenario.name}: ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B, C], assignments: scenario.assignments, incompatibleBranches: [] });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      const data = response.json().data;
      assert.equal(data.id_sucursal ?? data.paquetes?.[0]?.id_sucursal, scenario.branch);
      assert.equal(state.queries.filter(({ text }) => text.startsWith("SELECT DISTINCT ru.id_sucursal")).length, 1);
      if (request.method !== "GET") assert.equal(state.commit, 1);
    });
  }
}

for (const scenario of [
  { name: "ausente", missingUser: true },
  { name: "nula", userId: null },
  { name: "no UUID", userId: "' OR TRUE --" },
]) {
  for (const request of scopeRequests(A)) {
    test(`identidad ${scenario.name} rechaza ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp(scenario); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.ok(!state.queries.some(({ text }) => /^(BEGIN|INSERT|UPDATE|DELETE)/.test(text) || text.includes("roles_usuarios")));
    });
  }
}

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  for (const request of scopeRequests(B)) {
    test(`${roles.join("+")} conserva ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp({ roles, claims: [], assignments: [], missingUser: true, incompatibleBranches: [] });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
    });
  }
  test(`${roles.join("+")} conserva GET global`, async (t) => {
    const { app, state } = await buildApp({ roles, claims: [], assignments: [] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/catalog/paquetes" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.id_sucursal, null);
    assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
  });
}

for (const offers of [[A, B], [B, A]]) {
  test(`POST mixto rechaza todas las ofertas antes de escribir: ${offers.join(",")}`, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)], incompatibleBranches: [] });
    t.after(() => app.close());
    const response = await app.inject({ method: "POST", url: "/v1/admin/catalog/paquetes", payload: { nombre_paquete: "Multiple", items: compositionPayload.items, ofertas: offers.map((id_sucursal) => ({ id_sucursal, precio_hnl: 600 })) } });
    assert.equal(response.statusCode, 403, response.body);
    assert.ok(!state.queries.some(({ text }) => /^(BEGIN|INSERT|UPDATE|DELETE)/.test(text)));
  });
}

test("POST permite ofertas A+B administrativas y valida servicios de ambas", async (t) => {
  const { app, state } = await buildApp({ claims: [A, B, C], assignments: [assignment("admin", A), assignment("admin", B), assignment("barbero", C)], incompatibleBranches: [] });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/v1/admin/catalog/paquetes", payload: { nombre_paquete: "Multiple", items: compositionPayload.items, ofertas: [A, B].map((id_sucursal) => ({ id_sucursal, precio_hnl: 600 })) } });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(state.validatedBranches, [A, B]);
  assert.equal(state.offerWrites, 2);
  assert.equal(state.commit, 1);
});

for (const [name, assignments, status] of [
  ["una admin y otra barbero", [assignment("admin", A), assignment("admin", A), assignment("barbero", B)], 200],
  ["varias admin", [assignment("admin", A), assignment("admin", B)], 400],
  ["ninguna admin", [], 400],
]) {
  test(`GET seleccion automatica con ${name}`, async (t) => {
    const { app } = await buildApp({ claims: [A, B], assignments }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/catalog/paquetes" });
    assert.equal(response.statusCode, status, response.body);
    if (status === 200) assert.equal(response.json().data.id_sucursal, A);
    else assert.equal(response.json().error.code, "CATALOG_BRANCH_REQUIRED");
  });
}

for (const compatible of [false, true]) {
  test(`admin A sin autorizacion en B conserva validacion global de composicion: compatible=${compatible}`, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)], incompatibleBranches: compatible ? [] : [B] });
    t.after(() => app.close());
    const response = await patchPackage(app);
    assert.equal(response.statusCode, compatible ? 200 : 409, response.body);
    assert.deepEqual(state.validatedBranches, [A, B]);
    assert.equal(state.offerWrites, 0);
    assert.equal(state.commit, compatible ? 1 : 0);
    assert.equal(state.rollback, compatible ? 0 : 1);
  });
}

for (const failure of ["duplicate", "create"]) {
  test(`POST conserva ${failure === "duplicate" ? "duplicados" : "rollback"}`, async (t) => {
    const { app, state } = await buildApp({ duplicateName: failure === "duplicate", failOn: failure === "create" ? "create" : null });
    t.after(() => app.close());
    const response = await app.inject(scopeRequests(A)[1]);
    assert.equal(response.statusCode, failure === "duplicate" ? 409 : 500, response.body);
    assert.equal(state.commit, 0);
    assert.equal(state.rollback, 1);
    assert.equal(state.offerWrites, 0);
  });
}
