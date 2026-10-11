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
  activeBranches = [A, B],
  incompatibleBranches = [B],
  notBookableBranches = [],
  missingServiceBranches = [],
  exists = true,
  failOn = null,
} = {}) {
  const state = { masterUpdates: [], detailDeletes: 0, detailInserts: 0, offerWrites: 0, rollback: 0, commit: 0, activeOfferQueries: 0, validatedBranches: [], sequence: [] };
  const query = async (sql, params = []) => {
    const text = cleanSql(sql);
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    if (text === "COMMIT") { state.commit += 1; return { rows: [], rowCount: 0 }; }
    if (text === "ROLLBACK") { state.rollback += 1; return { rows: [], rowCount: 0 }; }
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    if (text.includes("package_active_offers")) { state.sequence.push("active-offers"); state.activeOfferQueries += 1; if (failOn === "activeOffers") throw new Error("simulated"); return { rows: activeBranches.map((id_sucursal) => ({ id_sucursal })), rowCount: activeBranches.length }; }
    if (text.includes("package_composition_lock")) { state.sequence.push("lock"); return { rows: exists ? [{ id_paquete: PACKAGE }] : [], rowCount: exists ? 1 : 0 }; }
    if (text.includes("WITH picked_offer AS") && text.includes("GROUP BY p.id_paquete")) return { rows: [packageRow(params[1])], rowCount: 1 };
    if (text.includes("FROM public.paquetes p") && text.includes("GROUP BY p.id_paquete")) return { rows: exists ? [packageRow()] : [], rowCount: exists ? 1 : 0 };
    if (text.includes("lower(regexp_replace(trim(p.nombre_paquete)")) return { rows: [], rowCount: 0 };
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
    request.claims = { roles, branch_ids: claims };
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
