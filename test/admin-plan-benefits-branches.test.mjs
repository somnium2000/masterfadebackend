import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import routes from "../src/routes/v1/admin/plans.js";

const PLAN = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE = "21111111-1111-4111-8111-111111111111";
const COURTESY = "31111111-1111-4111-8111-111111111111";
const cleanSql = (sql) => String(sql).replace(/\s+/g, " ").trim();

const benefits = (serviceQuantity = 1, courtesyQuantity = 1) => ({
  version: 1,
  items: [
    { tipo: "servicio", id_servicio: SERVICE, id_cortesia: null, nombre: "Corte", cantidad: serviceQuantity },
    { tipo: "cortesia", id_servicio: null, id_cortesia: COURTESY, nombre: "Bebida", cantidad: courtesyQuantity },
  ],
});

const planRow = (branchId = A, storedBenefits = benefits()) => ({
  id_plan: PLAN,
  id_sucursal: branchId,
  nombre_plan: "Plan VIP",
  descripcion: "Original",
  periodo_membresia_codigo: "mensual",
  periodo_membresia_label: "Mensual",
  categoria_nivel: 1,
  precio_hnl: 1000,
  activo: true,
  visible_publico: true,
  orden_visual: 10,
  beneficios: storedBenefits,
});

async function buildApp({
  activeBranches = [A, B],
  incompatibleServiceBranches = [],
  inactiveCourtesyBranches = [],
  missingServiceBranches = [],
  missingCourtesyBranches = [],
  storedBenefits = benefits(),
  exists = true,
  roles = ["admin"],
  claims = [A, B],
  failOn = null,
} = {}) {
  const state = {
    activeOfferQueries: 0,
    masterUpdates: [],
    offerWrites: 0,
    validatedServiceBranches: [],
    validatedCourtesyBranches: [],
    sequence: [],
    commit: 0,
    rollback: 0,
    subscriptionWrites: 0,
  };

  const query = async (sql, params = []) => {
    const text = cleanSql(sql);
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    if (text === "COMMIT") { state.commit += 1; return { rows: [], rowCount: 0 }; }
    if (text === "ROLLBACK") { state.rollback += 1; return { rows: [], rowCount: 0 }; }
    if (text.includes("information_schema.columns") && text.includes("membership_plans")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    if (text.includes("Serializa la comparacion") || (text.includes("FROM public.membership_plans mp") && text.endsWith("FOR UPDATE"))) {
      state.sequence.push("lock");
      return { rows: exists ? [{ id_plan: PLAN }] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.includes("FROM public.membership_plans mp") && text.includes("mp.precio_hnl") && !text.includes("JOIN public.membership_plans_sucursal")) {
      return { rows: exists ? [planRow(A, storedBenefits)] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.includes("JOIN public.membership_plans_sucursal mps") && text.includes("pm.descripcion AS periodo_membresia_label")) {
      return { rows: exists ? [planRow(params[1], storedBenefits)] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.includes("WITH ranked_offers AS") && text.includes("membership_plans_sucursal")) {
      if (failOn === "activeOffers") throw new Error("simulated");
      state.sequence.push("active-offers");
      state.activeOfferQueries += 1;
      return { rows: activeBranches.map((id_sucursal) => ({ id_sucursal })), rowCount: activeBranches.length };
    }
    if (text.includes("FROM public.servicios s") && text.includes("has_scope_tariff")) {
      const branchId = params[1];
      state.validatedServiceBranches.push(branchId);
      const rows = missingServiceBranches.includes(branchId)
        ? []
        : [{ id_servicio: SERVICE, nombre_servicio: "Corte", has_scope_tariff: !incompatibleServiceBranches.includes(branchId) }];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM public.cortesias c") && text.includes("cortesias_sucursales")) {
      const branchId = params[1];
      state.validatedCourtesyBranches.push(branchId);
      const rows = missingCourtesyBranches.includes(branchId)
        ? []
        : [{ id_cortesia: COURTESY, nombre: "Bebida", activa: !inactiveCourtesyBranches.includes(branchId) }];
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("UPDATE public.membership_plans SET")) {
      state.sequence.push("master");
      if (failOn === "master") throw new Error("simulated");
      state.masterUpdates.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM public.membership_plans_sucursal mps") && text.includes("FOR UPDATE")) {
      return { rows: [{ id_plan: PLAN, id_sucursal: A, precio_hnl: 1000, activo: true, visible_publico: true, orden_visual: 10 }], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO public.membership_plans_sucursal")) {
      if (failOn === "offer") throw new Error("simulated");
      state.offerWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    if (/\b(subscriptions|subscription_consumptions|membership_purchase_orders|membership_payment_intents)\b/i.test(text) && /^(INSERT|UPDATE|DELETE)/i.test(text)) {
      state.subscriptionWrites += 1;
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("lower(regexp_replace(trim(mp.nombre_plan)")) return { rows: [], rowCount: 0 };
    if (text.startsWith("SELECT 1 FROM public.periodos_membresia")) return { rows: [{}], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${text.slice(0, 240)}`);
  };

  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: claims };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/planes" });
  await app.ready();
  return { app, state };
}

const patchPlan = (app, payload) => app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}`, payload });

test("rechaza beneficios compatibles en A pero incompatibles en oferta activa B", async (t) => {
  const { app, state } = await buildApp({ incompatibleServiceBranches: [B] });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PLAN_BENEFITS_BRANCH_CONFLICT");
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
});

test("actualiza beneficios compatibles en todas las ofertas activas sin reescribir oferta", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 200);
  assert.deepEqual(state.validatedServiceBranches, [A, B, A]);
  assert.equal(state.masterUpdates.length, 1);
  assert.equal(state.offerWrites, 0);
  assert.ok(state.sequence.indexOf("lock") < state.sequence.indexOf("active-offers"));
  assert.ok(state.sequence.indexOf("active-offers") < state.sequence.indexOf("master"));
});

test("beneficios equivalentes con distinto orden no validan ni reescriben", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  const reversed = { version: 1, items: [...benefits().items].reverse() };
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: reversed })).statusCode, 200);
  assert.equal(state.activeOfferQueries, 0);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
});

test("edicion descriptiva es parcial y no valida beneficios ni oferta", async (t) => {
  const { app, state } = await buildApp({ incompatibleServiceBranches: [B] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, descripcion: "Nueva" })).statusCode, 200);
  assert.equal(state.activeOfferQueries, 0);
  assert.deepEqual(state.validatedServiceBranches, []);
  assert.equal(state.offerWrites, 0);
  assert.match(state.masterUpdates[0].sql, /descripcion = \$2/);
  assert.doesNotMatch(state.masterUpdates[0].sql, /nombre_plan =/);
  assert.doesNotMatch(state.masterUpdates[0].sql, /beneficios =/);
});

test("cortesia inactiva existente permite conservar cantidad pero no aumentarla", async (t) => {
  const same = await buildApp({ inactiveCourtesyBranches: [A, B] });
  t.after(() => same.app.close());
  assert.equal((await patchPlan(same.app, { id_sucursal: A, beneficios: benefits(2, 1) })).statusCode, 200);

  const increased = await buildApp({ inactiveCourtesyBranches: [A, B] });
  t.after(() => increased.app.close());
  const response = await patchPlan(increased.app, { id_sucursal: A, beneficios: benefits(2, 2) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PLAN_BENEFITS_BRANCH_CONFLICT");
});

test("precio local valida la composicion vigente y solo actualiza la oferta", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, precio_hnl: 1200 })).statusCode, 200);
  assert.equal(state.activeOfferQueries, 0);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 1);
});

test("plan inexistente conserva 404 y no escribe", async (t) => {
  const { app, state } = await buildApp({ exists: false });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, descripcion: "Nueva" })).statusCode, 404);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
});

test("tres ofertas activas rechazan cuando una sucursal es incompatible", async (t) => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const { app } = await buildApp({ activeBranches: [A, B, C], incompatibleServiceBranches: [C], claims: [A, B, C] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 409);
});

test("oferta inactiva incompatible no participa en validacion global", async (t) => {
  const { app, state } = await buildApp({ activeBranches: [A], incompatibleServiceBranches: [B] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 200);
  assert.equal(state.validatedServiceBranches.includes(B), false);
});

test("oferta activa invisible incompatible permanece incluida", async (t) => {
  const { app } = await buildApp({ activeBranches: [A, B], incompatibleServiceBranches: [B] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 409);
});

for (const [label, options] of [
  ["servicio inexistente", { missingServiceBranches: [B] }],
  ["servicio sin tarifa operativa vigente", { incompatibleServiceBranches: [B] }],
  ["cortesia sin asociacion", { missingCourtesyBranches: [B] }],
]) {
  test(`${label} rechaza el cambio global`, async (t) => {
    const { app } = await buildApp(options);
    t.after(() => app.close());
    assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 409);
  });
}

test("cortesia nueva inactiva es rechazada", async (t) => {
  const stored = { version: 1, items: [benefits().items[0]] };
  const { app } = await buildApp({ storedBenefits: stored, inactiveCourtesyBranches: [A] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits() })).statusCode, 409);
});

for (const [label, payload, expectedColumn] of [
  ["nombre", { nombre_plan: "Plan Renombrado" }, "nombre_plan"],
  ["categoria", { categoria_nivel: 2 }, "categoria_nivel"],
  ["periodo mensual", { periodo_membresia_codigo: "mensual" }, "periodo_membresia_codigo"],
]) {
  test(`PATCH solo ${label} mantiene escritura parcial`, async (t) => {
    const { app, state } = await buildApp();
    t.after(() => app.close());
    assert.equal((await patchPlan(app, { id_sucursal: A, ...payload })).statusCode, 200);
    assert.equal(state.activeOfferQueries, 0);
    assert.equal(state.offerWrites, 0);
    assert.match(state.masterUpdates[0].sql, new RegExp(`${expectedColumn} =`));
    assert.doesNotMatch(state.masterUpdates[0].sql, /beneficios =/);
  });
}

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join(" + ")} conserva acceso global`, async (t) => {
    const { app } = await buildApp({ roles, claims: [] });
    t.after(() => app.close());
    assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 200);
  });
}

test("admin fuera de alcance conserva 403", async (t) => {
  const { app } = await buildApp({ claims: [A] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: B, descripcion: "Nueva" })).statusCode, 403);
});

test("actor sin permisos conserva 403", async (t) => {
  const { app } = await buildApp({ roles: ["cliente"] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, descripcion: "Nueva" })).statusCode, 403);
});

test("usuario sin autenticacion conserva 401", async (t) => {
  const { app } = await buildApp({ roles: null });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, descripcion: "Nueva" })).statusCode, 401);
});

test("error SQL revierte sin commit", async (t) => {
  const { app, state } = await buildApp({ failOn: "activeOffers" });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 500);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
});

test("la ruta no escribe contratos ni consumos historicos", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) })).statusCode, 200);
  assert.equal(state.subscriptionWrites, 0);
});

test("lectura legacy se compara sin reescribir nombres snapshot", async (t) => {
  const storedBenefits = [
    { id_servicio: SERVICE, nombre: "Corte legacy", cantidad: 1 },
    { tipo: "cortesia", id_cortesia: COURTESY, nombre: "Bebida legacy", cantidad: 1 },
  ];
  const { app, state } = await buildApp({ storedBenefits });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, beneficios: benefits() })).statusCode, 200);
  assert.equal(state.masterUpdates.length, 0);
});
