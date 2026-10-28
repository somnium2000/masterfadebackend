import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/plans.js";

// AM: Rutas reales con dobles de filas y controles estaticos; no ejecuta PostgreSQL.
const PLAN = "11111111-1111-4111-8111-111111111111";
const SERVICE = "21111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BARBER = "31111111-1111-4111-8111-111111111111";
const TODAY = "2026-01-15";
const cleanSql = (sql) => String(sql).replace(/--[^\r\n]*/g, "").replace(/\s+/g, " ").trim();
const benefits = (cantidad = 1) => ({ version: 1, items: [{ tipo: "servicio", id_servicio: SERVICE, nombre: "Corte", cantidad }] });
const tariff = (branch = A, overrides = {}) => ({
  id_sucursal: branch, id_empleado: null, deleted_at: null, activo: true,
  vigente_desde: "2026-01-01", vigente_hasta: null, updated_at: "2026-01-01T12:00:00Z",
  id_tarifa: "41111111-1111-4111-8111-111111111111", precio_hnl: 100,
  servicio_informativo: false, ...overrides,
});
const fixture = () => ({
  service: { id_servicio: SERVICE, nombre_servicio: "Corte", activo: true, agendable: true, deleted_at: null, visible_publico: true },
  tariffs: [tariff(A), tariff(B)],
  offers: [{ id_sucursal: A, activo: true, visible_publico: true }, { id_sucursal: B, activo: true, visible_publico: true }],
});
const planRow = (branch, storedBenefits) => ({
  id_plan: PLAN, id_sucursal: branch, nombre_plan: "Plan VIP", descripcion: "Original",
  periodo_membresia_codigo: "mensual", periodo_membresia_label: "Mensual", categoria_nivel: 1,
  precio_hnl: 1000, activo: true, visible_publico: true, orden_visual: 10, beneficios: storedBenefits,
});

// AM: Modelo limitado del SQL previo y corregido; su estructura se verifica por separado.
function serviceRows(sql, branchId, data) {
  if (!data.service || !data.service.activo || data.service.deleted_at) return [];
  const candidates = data.tariffs.filter((row) => row.id_sucursal === branchId && row.id_empleado === null
    && !row.deleted_at && row.activo && row.vigente_desde <= TODAY
    && (!row.vigente_hasta || row.vigente_hasta >= TODAY)
    && (!sql.includes("st.precio_hnl > 0") || row.precio_hnl > 0));
  let hasScope;
  if (sql.includes("effective_tariff")) {
    const effective = candidates.sort((left, right) => right.vigente_desde.localeCompare(left.vigente_desde)
      || right.updated_at.localeCompare(left.updated_at) || right.id_tarifa.localeCompare(left.id_tarifa))[0];
    hasScope = Boolean(effective && effective.servicio_informativo !== true);
  } else {
    hasScope = candidates.some((row) => row.servicio_informativo !== true);
  }
  if (sql.includes("s.agendable IS TRUE") && !data.service.agendable) hasScope = false;
  return [{ id_servicio: SERVICE, nombre_servicio: "Corte", has_scope_tariff: hasScope }];
}

async function buildApp(t, data = fixture()) {
  const state = { calls: [], writes: [], commit: 0, rollback: 0, serviceBranches: [], addedBranches: new Set() };
  const storedBenefits = benefits();
  const query = async (sql, params = []) => {
    const text = cleanSql(sql);
    state.calls.push({ sql: text, params });
    const result = (rows) => ({ rows, rowCount: rows.length });
    if (text.startsWith("SELECT DISTINCT ru.id_sucursal")) {
      assert.deepEqual(params, [PLAN]);
      return result([{ id_sucursal: A }, { id_sucursal: B }]);
    }
    if (text === "BEGIN") return result([]);
    if (text === "COMMIT") { state.commit += 1; return result([]); }
    if (text === "ROLLBACK") { state.rollback += 1; return result([]); }
    assert.doesNotMatch(text, /\b(?:subscriptions|subscription_consumptions|beneficios_snapshot|membership_purchase_orders|membership_payment_intents)\b/);
    if (text.includes("information_schema.columns")) return result([{ exists: true }]);
    if (text.startsWith("SELECT 1 FROM public.sucursales")) return result([{}]);
    if (text.startsWith("SELECT 1 FROM public.periodos_membresia")) return result([{}]);
    if (text.includes("lower(regexp_replace(trim(mp.nombre_plan)")) return result([]);
    if (text.includes("AS has_authorized_offer")) return result([{ has_authorized_offer: true }]);
    if (text.includes("FROM public.membership_plans mp") && text.endsWith("FOR UPDATE")) return result([{ id_plan: PLAN }]);
    if (text.includes("FROM public.membership_plans mp") && text.includes("mp.precio_hnl") && !text.includes("JOIN public.membership_plans_sucursal")) return result([planRow(A, storedBenefits)]);
    if (text.includes("JOIN public.membership_plans_sucursal mps") && text.includes("pm.descripcion AS periodo_membresia_label")) {
      const offer = data.offers.find((row) => row.id_sucursal === params[1]);
      return result(offer || state.addedBranches.has(params[1]) ? [planRow(params[1], storedBenefits)] : []);
    }
    if (text.includes("WITH ranked_offers AS") && text.includes("membership_plans_sucursal")) return result(data.offers.filter((row) => row.activo).map((row) => ({ id_sucursal: row.id_sucursal })));
    if (text.includes("FROM public.servicios s") && text.includes("has_scope_tariff")) {
      state.serviceBranches.push(params[1]);
      return result(serviceRows(text, params[1], data));
    }
    if (text.includes("FROM public.membership_plans_sucursal mps") && text.includes("FOR UPDATE")) {
      const offer = data.offers.find((row) => row.id_sucursal === params[1]);
      return result(offer ? [{ ...offer, precio_hnl: 1000, orden_visual: 10 }] : []);
    }
    if (/^(INSERT|UPDATE)/.test(text)) {
      assert.match(text, /^(?:INSERT INTO|UPDATE) public.membership_plans(?:_sucursal)?\b/);
      state.writes.push({ sql: text, params });
      if (text.startsWith("INSERT INTO public.membership_plans_sucursal")) state.addedBranches.add(params[1]);
      return result(text.includes("RETURNING id_plan") ? [{ id_plan: PLAN }] : []);
    }
    throw new Error(`Unexpected mock SQL: ${text.slice(0, 120)}`);
  };
  const app = Fastify();
  app.decorate("requireRoles", () => async (request) => { request.claims = { roles: ["admin"], branch_ids: [A, B], user: { id_usuario: PLAN } }; });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  await app.register(routes, { prefix: "/v1/admin/planes" });
  await app.ready();
  t.after(() => app.close());
  return { app, state };
}

const patch = (app, payload) => app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}`, payload: { id_sucursal: A, ...payload } });
const create = (app) => app.inject({ method: "POST", url: "/v1/admin/planes/", payload: {
  nombre_plan: "Plan nuevo", id_sucursal: A, precio_hnl: 1000, beneficios: benefits(),
} });
const activate = (app) => app.inject({ method: "PATCH", url: `/v1/admin/planes/${PLAN}/estado`, payload: { id_sucursal: A, activo: true } });
function rejected(response, state, code) {
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, code);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
  assert.equal(state.writes.length, 0);
}

const invalidCases = [
  ["A maestro no agendable", (data) => { data.service.agendable = false; }],
  ["B tarifa de precio cero", (data) => { data.tariffs[0].precio_hnl = 0; }],
  ["tarifa de precio negativo", (data) => { data.tariffs[0].precio_hnl = -1; }],
  ["tarifa informativa", (data) => { data.tariffs[0].servicio_informativo = true; }],
  ["C anterior operativa y posterior informativa", (data) => { data.tariffs.push(tariff(A, { vigente_desde: TODAY, servicio_informativo: true })); }],
  ["E tarifa futura unica", (data) => { data.tariffs[0].vigente_desde = "2026-01-16"; }],
  ["E tarifa vencida", (data) => { data.tariffs[0].vigente_hasta = "2026-01-14"; }],
  ["E tarifa inactiva", (data) => { data.tariffs[0].activo = false; }],
  ["E tarifa eliminada", (data) => { data.tariffs[0].deleted_at = TODAY; }],
  ["tarifa de otra sucursal", (data) => { data.tariffs[0].id_sucursal = B; }],
  ["tarifa exclusiva de barbero", (data) => { data.tariffs[0].id_empleado = BARBER; }],
  ["maestro inactivo", (data) => { data.service.activo = false; }],
  ["maestro eliminado", (data) => { data.service.deleted_at = TODAY; }],
];
for (const [name, change] of invalidCases) {
  test(`creacion rechaza ${name} sin escrituras`, async (t) => {
    const data = fixture();
    change(data);
    const { app, state } = await buildApp(t, data);
    rejected(await create(app), state, "CATALOG_PLAN_SERVICE_OUT_OF_SCOPE");
  });
}

test("D posterior operativa prevalece sobre anterior informativa", async (t) => {
  const data = fixture();
  data.tariffs[0].servicio_informativo = true;
  data.tariffs.push(tariff(A, { vigente_desde: TODAY }));
  const { app, state } = await buildApp(t, data);
  assert.equal((await create(app)).statusCode, 201);
  assert.equal(state.commit, 1);
});

test("tarifa futura informativa no desplaza la general vigente", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(A, { vigente_desde: "2026-01-16", servicio_informativo: true }));
  const { app } = await buildApp(t, data);
  assert.equal((await create(app)).statusCode, 201);
});

test("servicio oculto conserva su regla de membresias sin imponer visible_publico", async (t) => {
  const data = fixture();
  data.service.visible_publico = false;
  const { app, state } = await buildApp(t, data);
  assert.equal((await create(app)).statusCode, 201);
  const sql = state.calls.find((call) => call.sql.includes("has_scope_tariff")).sql;
  assert.doesNotMatch(sql, /visible_publico/);
});

test("SQL exige maestro agendable y seleccion general efectiva antes de filtrar informativo", async (t) => {
  const { app, state } = await buildApp(t);
  assert.equal((await create(app)).statusCode, 201);
  const call = state.calls.find(({ sql }) => sql.includes("has_scope_tariff"));
  for (const clause of ["s.deleted_at IS NULL", "s.activo IS TRUE", "s.agendable IS TRUE",
    "st.id_sucursal = $2::uuid", "st.id_empleado IS NULL", "st.deleted_at IS NULL", "st.activo IS TRUE",
    "st.precio_hnl > 0", "st.vigente_desde <= CURRENT_DATE", "st.vigente_hasta >= CURRENT_DATE"])
    assert.ok(call.sql.includes(clause), clause);
  assert.match(call.sql, /ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC LIMIT 1 \) effective_tariff/);
  assert.match(call.sql, /COALESCE\(effective_tariff.servicio_informativo, FALSE\) IS FALSE/);
  assert.doesNotMatch(call.sql, /COALESCE\(st.servicio_informativo, FALSE\) IS FALSE/);
  assert.deepEqual(call.params, [[SERVICE], A]);
});

test("cambio global compatible valida ambas sucursales y conserva cantidades", async (t) => {
  const { app, state } = await buildApp(t);
  assert.equal((await patch(app, { beneficios: benefits(2) })).statusCode, 200);
  assert.deepEqual(state.serviceBranches, [A, B, A]);
  assert.equal(state.writes.length, 1);
  const serialized = state.writes[0].params.find((value) => value && typeof value === "object" && Array.isArray(value.items));
  assert.equal(serialized.items[0].cantidad, 2);
  assert.equal(state.commit, 1);
});

for (const hidden of [false, true]) {
  test(`oferta activa B ${hidden ? "invisible" : "visible"} incompatible bloquea cambio global`, async (t) => {
    const data = fixture();
    data.offers[1].visible_publico = !hidden;
    data.tariffs[1].servicio_informativo = true;
    const { app, state } = await buildApp(t, data);
    rejected(await patch(app, { beneficios: benefits(2) }), state, "CATALOG_PLAN_BENEFITS_BRANCH_CONFLICT");
  });
}

test("oferta inactiva B incompatible no participa en cambio global", async (t) => {
  const data = fixture();
  data.offers[1].activo = false;
  data.tariffs[1].servicio_informativo = true;
  const { app, state } = await buildApp(t, data);
  assert.equal((await patch(app, { beneficios: benefits(2) })).statusCode, 200);
  assert.deepEqual(state.serviceBranches, [A, A]);
});

test("edicion descriptiva no revalida ni altera beneficios preexistentes incompatibles", async (t) => {
  const data = fixture();
  data.service.agendable = false;
  const { app, state } = await buildApp(t, data);
  assert.equal((await patch(app, { descripcion: "Nueva" })).statusCode, 200);
  assert.deepEqual(state.serviceBranches, []);
  assert.equal(state.writes.length, 1);
  assert.doesNotMatch(state.writes[0].sql, /beneficios =/);
});

test("beneficios equivalentes no se revalidan ni reescriben aunque hoy sean incompatibles", async (t) => {
  const data = fixture();
  data.service.agendable = false;
  const { app, state } = await buildApp(t, data);
  assert.equal((await patch(app, { beneficios: benefits() })).statusCode, 200);
  assert.deepEqual(state.serviceBranches, []);
  assert.deepEqual(state.writes, []);
});

for (const [name, operation] of [
  ["precio local", (app) => patch(app, { precio_hnl: 1200 })],
  ["reactivacion", activate],
]) {
  test(`${name} valida operatividad y rechaza sin UPDATE parcial`, async (t) => {
    const data = fixture();
    data.tariffs[0].precio_hnl = 0;
    const { app, state } = await buildApp(t, data);
    rejected(await operation(app), state, "CATALOG_PLAN_SERVICE_OUT_OF_SCOPE");
  });
  test(`${name} operativo conserva comportamiento`, async (t) => {
    const { app, state } = await buildApp(t);
    assert.equal((await operation(app)).statusCode, 200);
    assert.equal(state.commit, 1);
    assert.ok(state.serviceBranches.includes(A));
  });
}

test("addOffer legitimo valida la sucursal nueva sin modificar maestro", async (t) => {
  const data = fixture();
  data.offers = [data.offers[1]];
  const { app, state } = await buildApp(t, data);
  assert.equal((await patch(app, { precio_hnl: 1200 })).statusCode, 200);
  assert.deepEqual(state.serviceBranches, [A]);
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0].sql, /^INSERT INTO public.membership_plans_sucursal/);
});

test("creacion con dos ofertas iniciales rechaza la incompatible antes de INSERT", async (t) => {
  const data = fixture();
  data.tariffs[1].precio_hnl = 0;
  const { app, state } = await buildApp(t, data);
  const response = await app.inject({ method: "POST", url: "/v1/admin/planes/", payload: {
    nombre_plan: "Plan nuevo", beneficios: benefits(),
    ofertas: [{ id_sucursal: A, precio_hnl: 1000 }, { id_sucursal: B, precio_hnl: 1100 }],
  } });
  rejected(response, state, "CATALOG_PLAN_SERVICE_OUT_OF_SCOPE");
});

test("creacion con dos ofertas operativas valida ambas y conserva sus precios locales", async (t) => {
  const { app, state } = await buildApp(t);
  const response = await app.inject({ method: "POST", url: "/v1/admin/planes/", payload: {
    nombre_plan: "Plan nuevo", beneficios: benefits(),
    ofertas: [{ id_sucursal: A, precio_hnl: 1000 }, { id_sucursal: B, precio_hnl: 1100 }],
  } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(state.serviceBranches, [A, B, A]);
  const offers = state.writes.filter(({ sql }) => sql.startsWith("INSERT INTO public.membership_plans_sucursal"));
  assert.deepEqual(offers.map(({ params }) => [params[1], params[2]]), [[A, 1000], [B, 1100]]);
  assert.equal(state.commit, 1);
});

test("tarifa especifica posterior informativa no sustituye la general operativa", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(A, { id_empleado: BARBER, vigente_desde: TODAY, servicio_informativo: true }));
  const { app } = await buildApp(t, data);
  assert.equal((await create(app)).statusCode, 201);
});

test("tarifa con mismo inicio usa updated_at e id_tarifa para desempatar", async (t) => {
  const data = fixture();
  data.tariffs.push(tariff(A, { id_tarifa: "42222222-2222-4222-8222-222222222222", servicio_informativo: true }));
  const { app, state } = await buildApp(t, data);
  rejected(await create(app), state, "CATALOG_PLAN_SERVICE_OUT_OF_SCOPE");
});
