import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import routes from "../src/routes/v1/admin/plans.js";

const PLAN = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE = "21111111-1111-4111-8111-111111111111";
const COURTESY = "31111111-1111-4111-8111-111111111111";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const assignment = (rol, id_sucursal, activo = true, id_usuario = PLAN) => ({ rol, id_sucursal, activo, id_usuario });
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
  assignments = claims.map((id) => assignment("admin", id)),
  userId = PLAN,
  missingUser = false,
  failOn = null,
  associatedBranches = [A, B],
  masterActive = false,
  activeSubscribers = 0,
} = {}) {
  const state = {
    queries: [],
    activeOfferQueries: 0,
    masterUpdates: [],
    offerWrites: 0,
    validatedServiceBranches: [],
    validatedCourtesyBranches: [],
    sequence: [],
    commit: 0,
    rollback: 0,
    subscriptionWrites: 0,
    scopedReads: 0,
    masterActive,
    offerParams: [],
  };

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
    if (text.includes("information_schema.columns") && text.includes("membership_plans")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.includes("information_schema.columns") && text.includes("subscriptions")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.startsWith("WITH scoped_offers AS")) return { rows: [planRow(params[0], storedBenefits)], rowCount: 1 };
    if (text.startsWith("INSERT INTO public.membership_plans (")) return { rows: [{ id_plan: PLAN }], rowCount: 1 };
    if (text.includes("SELECT COUNT(*)::int AS total")) return { rows: [{ total: activeSubscribers }], rowCount: 1 };
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    if (text.includes("AS has_authorized_offer") && text.includes("membership_plans_sucursal")) {
      const authorizedBranches = Array.isArray(params[1]) ? params[1] : [];
      return {
        rows: [{ has_authorized_offer: associatedBranches.some((branchId) => authorizedBranches.includes(branchId)) }],
        rowCount: 1,
      };
    }
    if (text.includes("Serializa la comparacion") || (text.includes("FROM public.membership_plans mp") && text.endsWith("FOR UPDATE"))) {
      state.sequence.push("lock");
      return { rows: exists ? [{ id_plan: PLAN }] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.includes("FROM public.membership_plans mp") && text.includes("mp.precio_hnl") && !text.includes("JOIN public.membership_plans_sucursal")) {
      return { rows: exists ? [planRow(A, storedBenefits)] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.includes("JOIN public.membership_plans_sucursal mps") && text.includes("pm.descripcion AS periodo_membresia_label")) {
      state.scopedReads += 1;
      const isAssociated = associatedBranches.includes(params[1]) || state.offerWrites > 0;
      return { rows: exists && isAssociated ? [planRow(params[1], storedBenefits)] : [], rowCount: exists && isAssociated ? 1 : 0 };
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
      if (text.includes("activo = TRUE")) state.masterActive = true;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM public.membership_plans_sucursal mps") && text.includes("FOR UPDATE")) {
      const isAssociated = associatedBranches.includes(params[1]);
      return {
        rows: isAssociated ? [{ id_plan: PLAN, id_sucursal: params[1], precio_hnl: 1000, activo: true, visible_publico: true, orden_visual: 10 }] : [],
        rowCount: isAssociated ? 1 : 0,
      };
    }
    if (text.startsWith("INSERT INTO public.membership_plans_sucursal")) {
      if (failOn === "offer") throw new Error("simulated");
      state.offerWrites += 1;
      state.offerParams.push(params);
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
    request.claims = { roles, branch_ids: claims, user: missingUser ? undefined : { id_usuario: userId } };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/planes" });
  await app.ready();
  return { app, state };
}

const patchPlan = (app, payload) => app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}`, payload });

for (const masterActive of [false, true]) {
  test(`inactivar oferta conserva estado maestro ${masterActive}`, async (t) => {
    const { app, state } = await buildApp({ masterActive });
    t.after(() => app.close());
    const response = await app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}/estado`, payload: { id_sucursal: A, activo: false } });
    assert.equal(response.statusCode, 200);
    assert.equal(state.masterActive, masterActive);
    assert.equal(state.offerWrites, 1);
    assert.equal(state.commit, 1);
    assert.equal(state.subscriptionWrites, 0);
    assert.deepEqual(state.offerParams[0], [PLAN, A, 1000, false, true, 10]);
  });
}

test("estado rechaza oferta inexistente sin crearla", async (t) => {
  const { app, state } = await buildApp({ associatedBranches: [B] });
  t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}/estado`, payload: { id_sucursal: A, activo: false } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "CATALOG_PLAN_OFFER_NOT_FOUND");
  assert.equal(state.offerWrites, 0);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.rollback, 1);
});

test("activar oferta existente activa explicitamente el maestro", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}/estado`, payload: { id_sucursal: A, activo: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterActive, true);
  assert.equal(state.offerWrites, 1);
});

test("estado conserva confirmacion de suscripciones y rollback SQL", async (t) => {
  const guarded = await buildApp({ activeSubscribers: 2 });
  t.after(() => guarded.app.close());
  const request = { method: "PATCH", url: `/v1/admin/planes/${PLAN}/estado`, payload: { id_sucursal: A, activo: false } };
  const response = await guarded.app.inject(request);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PLAN_ACTIVE_SUBSCRIPTIONS_CONFIRM_REQUIRED");
  assert.equal(guarded.state.offerWrites, 0);
  assert.equal((await guarded.app.inject({ ...request, payload: { ...request.payload, confirmar_clientes_activos: true } })).statusCode, 200);
  const failing = await buildApp({ failOn: "offer" });
  t.after(() => failing.app.close());
  assert.equal((await failing.app.inject(request)).statusCode, 500);
  assert.equal(failing.state.rollback, 1);
  assert.equal(failing.state.commit, 0);
  assert.equal(failing.state.masterUpdates.length, 0);
});

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

test("admin A no puede editar maestro asociado solamente a B", async (t) => {
  const { app, state } = await buildApp({ claims: [A], associatedBranches: [B], activeBranches: [B] });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, nombre_plan: "Nombre modificado" });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "CATALOG_PLAN_MASTER_OUT_OF_SCOPE");
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
  assert.equal(state.commit, 0);
  assert.equal(state.rollback, 1);
});

test("admin A no puede modificar beneficios de maestro asociado solamente a B", async (t) => {
  const { app, state } = await buildApp({ claims: [A], associatedBranches: [B], activeBranches: [B] });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, beneficios: benefits(2) });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "CATALOG_PLAN_MASTER_OUT_OF_SCOPE");
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 0);
  assert.equal(state.commit, 0);
  assert.equal(state.rollback, 1);
});

test("admin A puede editar maestro asociado a A", async (t) => {
  const { app, state } = await buildApp({ claims: [A], associatedBranches: [A], activeBranches: [A] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: A, nombre_plan: "Nombre autorizado" })).statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.equal(state.commit, 1);
});

test("admin con A y B puede editar maestro asociado a B", async (t) => {
  const { app, state } = await buildApp({ claims: [A, B], associatedBranches: [B], activeBranches: [B] });
  t.after(() => app.close());
  assert.equal((await patchPlan(app, { id_sucursal: B, descripcion: "Autorizada" })).statusCode, 200);
  assert.equal(state.masterUpdates.length, 1);
  assert.equal(state.commit, 1);
});

test("addOffer autorizado en A no exige asociacion previa del maestro", async (t) => {
  const { app, state } = await buildApp({ claims: [A], associatedBranches: [B], activeBranches: [B] });
  t.after(() => app.close());
  const response = await patchPlan(app, {
    id_sucursal: A,
    precio_hnl: 1100,
    visible_publico: true,
    orden_visual: 20,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 1);
  assert.equal(state.commit, 1);
});

test("editOffer autorizado en A conserva actualizacion local", async (t) => {
  const { app, state } = await buildApp({ claims: [A], associatedBranches: [A], activeBranches: [A] });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, precio_hnl: 1250, visible_publico: false });
  assert.equal(response.statusCode, 200);
  assert.equal(state.masterUpdates.length, 0);
  assert.equal(state.offerWrites, 1);
  assert.equal(state.commit, 1);
});

test("respuesta scoped inexistente revierte antes de COMMIT", async (t) => {
  const { app, state } = await buildApp({
    roles: ["super_admin"],
    claims: [],
    associatedBranches: [B],
    activeBranches: [B],
  });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, nombre_plan: "Cambio global" });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CATALOG_PLAN_OFFER_NOT_FOUND");
  assert.equal(state.commit, 0);
  assert.equal(state.rollback, 1);
  assert.equal(state.offerWrites, 0);
});

function scopeRequests(branch) {
  const base = "/v1/admin/planes";
  return [
    { method: "GET", url: `${base}?id_sucursal=${branch}` },
    { method: "POST", url: base, payload: { nombre_plan: "Nuevo", beneficios: benefits(), ofertas: [{ id_sucursal: branch, precio_hnl: 1200 }] } },
    { method: "PATCH", url: `${base}/${PLAN}`, payload: { id_sucursal: branch, descripcion: "Editada" } },
    { method: "PATCH", url: `${base}/${PLAN}/estado`, payload: { id_sucursal: branch, activo: true } },
    { method: "PATCH", url: `${base}/${PLAN}/estado`, payload: { id_sucursal: branch, activo: false } },
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
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      assert.equal(response.json().data.id_sucursal, scenario.branch);
      assert.equal(state.queries.filter(({ text }) => text.startsWith("SELECT DISTINCT ru.id_sucursal")).length, 1);
      if (request.method !== "GET") assert.equal(state.commit, 1);
      assert.equal(state.subscriptionWrites, 0);
    });
  }
}

for (const scenario of [{ missingUser: true }, { userId: null }, { userId: "' OR TRUE --" }]) {
  for (const request of scopeRequests(A)) {
    test(`identidad invalida ${JSON.stringify(scenario)} rechaza ${request.method} ${request.url}`, async (t) => {
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
      const { app, state } = await buildApp({ roles, claims: [], assignments: [], missingUser: true }); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
    });
  }
  test(`${roles.join("+")} mantiene listado global`, async (t) => {
    const { app } = await buildApp({ roles, claims: [], assignments: [] }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/planes" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.id_sucursal, null);
  });
}

for (const branches of [[A, B], [B, A]]) {
  test(`POST rechaza oferta ajena antes de crear: ${branches.join(",")}`, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)] });
    t.after(() => app.close());
    const response = await app.inject({ method: "POST", url: "/v1/admin/planes", payload: { nombre_plan: "Multiple", beneficios: benefits(), ofertas: branches.map((id_sucursal) => ({ id_sucursal, precio_hnl: 1200 })) } });
    assert.equal(response.statusCode, 403, response.body);
    assert.ok(!state.queries.some(({ text }) => /^(BEGIN|INSERT|UPDATE|DELETE)/.test(text)));
  });
}

test("POST permite todas las ofertas administrativas y valida beneficios en A y B", async (t) => {
  const { app, state } = await buildApp({ assignments: [assignment("admin", A), assignment("admin", B)] });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/v1/admin/planes", payload: { nombre_plan: "Multiple", beneficios: benefits(), ofertas: [A, B].map((id_sucursal) => ({ id_sucursal, precio_hnl: 1200 })) } });
  assert.equal(response.statusCode, 201, response.body);
  assert.ok(state.validatedServiceBranches.includes(A) && state.validatedServiceBranches.includes(B));
  assert.ok(state.validatedCourtesyBranches.includes(A) && state.validatedCourtesyBranches.includes(B));
  assert.equal(state.offerWrites, 2);
  assert.equal(state.commit, 1);
});

test("admin A + barbero B no edita maestro asociado solamente a B", async (t) => {
  const { app, state } = await buildApp({ claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)], associatedBranches: [B] });
  t.after(() => app.close());
  const response = await patchPlan(app, { id_sucursal: A, descripcion: "No autorizada" });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "CATALOG_PLAN_MASTER_OUT_OF_SCOPE");
  const scopeQuery = state.queries.find(({ text }) => text.includes("AS has_authorized_offer"));
  assert.deepEqual(scopeQuery.params, [PLAN, [A]]);
  assert.ok(!state.queries.some(({ text }) => /^(INSERT|UPDATE|DELETE)/.test(text)));
  assert.equal(state.rollback, 1);
});

for (const scenario of [
  { name: "compatible", options: {}, status: 200 },
  { name: "servicio no disponible en B", options: { incompatibleServiceBranches: [B] }, status: 409 },
  { name: "cortesia inactiva en B", options: { inactiveCourtesyBranches: [B] }, status: 409 },
]) {
  test(`admin A sin permiso operativo en B mantiene beneficios globales: ${scenario.name}`, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], claims: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)], ...scenario.options });
    t.after(() => app.close());
    const response = await patchPlan(app, { id_sucursal: A, beneficios: benefits(2, 2) });
    assert.equal(response.statusCode, scenario.status, response.body);
    assert.ok(state.validatedServiceBranches.includes(B));
    if (!scenario.options.incompatibleServiceBranches) assert.ok(state.validatedCourtesyBranches.includes(B));
    assert.equal(state.offerWrites, 0);
    assert.equal(state.commit, scenario.status === 200 ? 1 : 0);
    if (scenario.status === 409) {
      assert.equal(response.json().error.code, "CATALOG_PLAN_BENEFITS_BRANCH_CONFLICT");
      assert.equal(state.masterUpdates.length, 0);
      assert.equal(state.rollback, 1);
    }
  });
}

for (const [name, assignments, status] of [
  ["una administrativa", [assignment("admin", A), assignment("admin", A), assignment("barbero", B)], 200],
  ["varias administrativas", [assignment("admin", A), assignment("admin", B)], 400],
  ["ninguna administrativa", [], 400],
]) {
  test(`GET seleccion automatica con ${name}`, async (t) => {
    const { app } = await buildApp({ claims: [A, B], assignments }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/planes" });
    assert.equal(response.statusCode, status, response.body);
    if (status === 200) assert.equal(response.json().data.id_sucursal, A);
    else assert.equal(response.json().error.code, "CATALOG_BRANCH_REQUIRED");
  });
}

test("alcance vinculado al identificador autenticado y no a una identidad fija", async (t) => {
  const { app } = await buildApp({ userId: OTHER_USER, assignments: [assignment("admin", A), assignment("admin", B, true, OTHER_USER)] });
  t.after(() => app.close());
  const response = await app.inject(scopeRequests(B)[0]);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.id_sucursal, B);
});
