import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import clienteRoutes from "../src/routes/v1/cliente.js";

// AM: Controlador y servicio reales con BD simulada; no ejecuta SQL ni APIs externas.
const OFFER = "11111111-1111-4111-8111-111111111111";
const PLAN = "21111111-1111-4111-8111-111111111111";
const BRANCH = "31111111-1111-4111-8111-111111111111";
const CLIENT = "41111111-1111-4111-8111-111111111111";
const USER = "51111111-1111-4111-8111-111111111111";
const ORDER = "61111111-1111-4111-8111-111111111111";
const SERVICE = "71111111-1111-4111-8111-111111111111";
const normalizedBenefits = { version: 1, items: [{
  tipo: "servicio", id_servicio: SERVICE, id_cortesia: null, codigo: null, nombre: "Corte", cantidad: 2,
}] };
const requiredColumns = ["id_order", "id_cliente", "id_plan", "id_plan_sucursal", "id_sucursal",
  "estado_orden_codigo", "moneda_codigo", "subtotal_hnl", "descuento_hnl", "total_hnl"];
const columns = [...requiredColumns, "id_usuario", "plan_snapshot", "cliente_snapshot", "factura_snapshot", "email_factura", "expires_at"];
const clean = (sql) => String(sql).replace(/\s+/g, " ").trim();
const fixture = () => ({
  branch: { estado: true, deleted_at: null, exists: true },
  offer: {
    id_plan_sucursal: OFFER, id_plan: PLAN, id_sucursal: BRANCH, precio_hnl: 1000,
    oferta_activa: true, visible_publico: true, orden_visual: 10, nombre_plan: "Plan VIP",
    plan_descripcion: "Descripcion", periodo_membresia_codigo: "trimestral", categoria_nivel: 3,
    beneficios: normalizedBenefits, plan_activo: true, periodo_membresia_label: "Trimestral",
    nombre_sucursal: "Centro",
  },
  historicalOrders: [{ id_order: "historica", estado_orden_codigo: "pendiente_pago", plan_snapshot: { precio_hnl: 850 } }],
});

function databaseDouble(data, { legacy = false } = {}) {
  const state = { calls: [], inserts: [], commit: 0, rollback: 0, released: 0 };
  const query = async (sql, params = []) => {
    const text = clean(sql);
    state.calls.push({ sql: text, params });
    const result = (rows) => ({ rows, rowCount: rows.length });
    if (text === "BEGIN") return result([]);
    if (text === "COMMIT") { state.commit += 1; return result([]); }
    if (text === "ROLLBACK") { state.rollback += 1; return result([]); }
    if (text.includes("to_regclass('public.membership_purchase_orders')")) return result([{ has_purchase_orders: true }]);
    if (text.includes("to_regclass('public.subscriptions')")) return result([{ has_membership_plans: true, has_membership_plans_sucursal: true }]);
    if (text.includes("information_schema.columns")) return result(text.includes("table_name = 'membership_purchase_orders'")
      ? (legacy ? requiredColumns : columns).map((column_name) => ({ column_name }))
      : legacy ? [] : [{ table_name: "membership_plans", column_name: "categoria_nivel" }]);
    if (text.includes("FROM public.membership_plans_sucursal mps") && text.includes("WHERE mps.id_plan_sucursal = $1::uuid")) {
      assert.deepEqual(params, [OFFER]);
      if (!data.offer || !data.branch.exists) return result([]);
      // AM: Las condiciones proceden de las filas persistidas simuladas, no del payload HTTP.
      return result([{
        ...data.offer,
        categoria_nivel: text.includes("1::smallint AS categoria_nivel") ? 1 : data.offer.categoria_nivel,
        ...(text.includes("s.estado AS sucursal_activa") ? { sucursal_activa: data.branch.estado } : {}),
        ...(text.includes("s.deleted_at AS sucursal_deleted_at") ? { sucursal_deleted_at: data.branch.deleted_at } : {}),
      }]);
    }
    if (text.includes("FROM public.clientes c")) {
      assert.deepEqual(params, [CLIENT]);
      return result([{ id_cliente: CLIENT, id_usuario: USER, nombre_completo: "Cliente Prueba", correo_principal: "cliente@example.test" }]);
    }
    if (text.startsWith("INSERT INTO public.membership_purchase_orders")) {
      state.inserts.push({ sql: text, params });
      return result([{ id_order: ORDER }]);
    }
    // AM: Cualquier escritura en historial, pagos, suscripciones o consumos falla el test.
    throw new Error(`Unexpected mock SQL: ${text.slice(0, 140)}`);
  };
  return { state, client: { query, release() { state.released += 1; } } };
}

async function buildApp(t, data = fixture()) {
  const { client, state } = databaseDouble(data);
  const app = Fastify();
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { roles: ["cliente"], cliente_id: CLIENT, user: { id_usuario: USER } };
  });
  app.decorate("db", { connect: async () => client });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.ready();
  t.after(() => app.close());
  return { app, state };
}
const createOrder = (app) => app.inject({ method: "POST", url: "/v1/cliente/planes/orden", payload: { id_plan_sucursal: OFFER } });
function assertRejected(response, state, code, status = 409) {
  assert.equal(response.statusCode, status);
  assert.equal(response.json().error.code, code);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
  assert.equal(state.released, 1);
  assert.deepEqual(state.inserts, []);
  assert.ok(state.calls.every(({ sql }) => !/^(?:INSERT|UPDATE|DELETE)\b/.test(sql)));
}

for (const [name, change] of [
  ["A sucursal inactiva con oferta activa", (data) => { data.branch.estado = false; }],
  ["B sucursal eliminada con oferta visible", (data) => { data.branch.deleted_at = "2026-01-15T12:00:00Z"; }],
  ["sucursal inactiva y eliminada", (data) => { data.branch.estado = false; data.branch.deleted_at = "2026-01-15"; }],
]) {
  test(`${name} rechaza nueva orden sin escrituras ni snapshot`, async (t) => {
    const data = fixture();
    change(data);
    const before = JSON.stringify(data.historicalOrders);
    const { app, state } = await buildApp(t, data);
    const response = await createOrder(app);
    assertRejected(response, state, "MEMBERSHIP_PURCHASE_BRANCH_INACTIVE");
    assert.equal(response.json().error.message, "La sucursal de esta oferta no está disponible para nuevas compras.");
    assert.equal(JSON.stringify(data.historicalOrders), before);
    assert.equal(state.calls.filter(({ sql }) => sql.includes("FROM public.clientes c")).length, 0);
  });
}

const currentErrors = [
  ["D oferta inactiva", (data) => { data.offer.oferta_activa = false; }, "MEMBERSHIP_PURCHASE_OFFER_INACTIVE", 409],
  ["E oferta invisible", (data) => { data.offer.visible_publico = false; }, "MEMBERSHIP_PURCHASE_OFFER_NOT_VISIBLE", 409],
  ["F plan inactivo", (data) => { data.offer.plan_activo = false; }, "MEMBERSHIP_PURCHASE_PLAN_INACTIVE", 409],
  ["precio cero", (data) => { data.offer.precio_hnl = 0; }, "MEMBERSHIP_PURCHASE_PRICE_INVALID", 409],
  ["precio negativo", (data) => { data.offer.precio_hnl = -1; }, "MEMBERSHIP_PURCHASE_PRICE_INVALID", 409],
  ["precio no numerico", (data) => { data.offer.precio_hnl = "invalid"; }, "MEMBERSHIP_PURCHASE_PRICE_INVALID", 409],
  ["oferta inexistente", (data) => { data.offer = null; }, "MEMBERSHIP_PURCHASE_PLAN_NOT_FOUND", 404],
  ["sucursal inexistente mantiene JOIN y 404", (data) => { data.branch.exists = false; }, "MEMBERSHIP_PURCHASE_PLAN_NOT_FOUND", 404],
];
for (const [name, change, code, status] of currentErrors) {
  test(`${name} conserva rechazo anterior`, async (t) => {
    const data = fixture();
    change(data);
    const { app, state } = await buildApp(t, data);
    assertRejected(await createOrder(app), state, code, status);
  });
}

test("C sucursal operativa conserva respuesta, totales, identidad y beneficios", async (t) => {
  const { app, state } = await buildApp(t);
  const response = await createOrder(app);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().data, {
    id_order: ORDER, estado_orden_codigo: "pendiente_pago",
    plan: { id_plan: PLAN, id_plan_sucursal: OFFER, nombre_plan: "Plan VIP", id_sucursal: BRANCH,
      sucursal_nombre: "Centro", precio_hnl: 1000, beneficios: normalizedBenefits },
    totales: { subtotal_hnl: 1000, descuento_hnl: 0, total_hnl: 1000, moneda_codigo: "HNL" },
    cliente: { id_cliente: CLIENT, email: "cliente@example.test" },
  });
  assert.equal(response.json().success, true);
  assert.equal(state.commit, 1);
  assert.equal(state.rollback, 0);
  assert.equal(state.released, 1);
  assert.equal(state.inserts.length, 1);
});

test("orden valida conserva snapshots comerciales, categoria, periodo y expiracion", async (t) => {
  const { app, state } = await buildApp(t);
  assert.equal((await createOrder(app)).statusCode, 201);
  const { sql, params } = state.inserts[0];
  const names = sql.match(/membership_purchase_orders \( (.*?) \) VALUES/)[1].split(",").map((value) => value.trim());
  const values = Object.fromEntries(names.map((name, index) => [name, params[index]]));
  assert.equal(values.id_cliente, CLIENT);
  assert.equal(values.id_usuario, USER);
  assert.equal(values.id_plan_sucursal, OFFER);
  assert.deepEqual(JSON.parse(values.plan_snapshot), {
    id_plan: PLAN, id_plan_sucursal: OFFER, nombre_plan: "Plan VIP", id_sucursal: BRANCH,
    sucursal_nombre: "Centro", precio_hnl: 1000, beneficios: normalizedBenefits,
    periodo_membresia_codigo: "trimestral", periodo_membresia_label: "Trimestral", categoria_nivel: 3,
  });
  assert.deepEqual(JSON.parse(values.cliente_snapshot), { id_cliente: CLIENT, id_usuario: USER,
    nombre_completo: "Cliente Prueba", email: "cliente@example.test" });
  assert.deepEqual(JSON.parse(values.factura_snapshot), { moneda_codigo: "HNL", subtotal_hnl: 1000,
    descuento_hnl: 0, total_hnl: 1000, descripcion: "Compra de plan Plan VIP - Centro" });
  assert.match(sql, /now\(\) \+ interval '30 minutes'/);
});

test("estado de sucursal se lee con JOIN existente y parametros, sin consultas adicionales", async (t) => {
  const { app, state } = await buildApp(t);
  assert.equal((await createOrder(app)).statusCode, 201);
  const offers = state.calls.filter(({ sql }) => sql.includes("WHERE mps.id_plan_sucursal = $1::uuid"));
  assert.equal(offers.length, 1);
  assert.match(offers[0].sql, /JOIN public.sucursales s ON s.id_sucursal = mps.id_sucursal/);
  assert.match(offers[0].sql, /s.estado AS sucursal_activa/);
  assert.match(offers[0].sql, /s.deleted_at AS sucursal_deleted_at/);
  assert.deepEqual(offers[0].params, [OFFER]);
  assert.equal(state.calls.filter(({ sql }) => /FROM public.sucursales/.test(sql)).length, 0);
  assert.ok(state.calls.indexOf(offers[0]) < state.calls.findIndex(({ sql }) => sql.startsWith("INSERT")));
});

for (const [name, change, code] of currentErrors.slice(0, 6)) {
  test(`${name} conserva precedencia si la sucursal tambien esta inactiva`, async (t) => {
    const data = fixture();
    data.branch.estado = false;
    change(data);
    const { app, state } = await buildApp(t, data);
    assertRejected(await createOrder(app), state, code);
  });
}

test("compatibilidad legacy sin categoria ni columnas opcionales conserva alta valida", async () => {
  const service = await import("../src/services/membershipService.js?purchase-branch-legacy");
  const { client, state } = databaseDouble(fixture(), { legacy: true });
  const result = await service.createMembershipPurchaseOrder(client, { clienteId: CLIENT, usuarioId: USER, idPlanSucursal: OFFER });
  assert.equal(result.id_order, ORDER);
  assert.equal(result.plan.precio_hnl, 1000);
  assert.equal(state.inserts.length, 1);
  assert.doesNotMatch(state.inserts[0].sql, /plan_snapshot|cliente_snapshot|factura_snapshot/);
  assert.match(state.calls.find(({ sql }) => sql.includes("WHERE mps.id_plan_sucursal")).sql, /1::smallint AS categoria_nivel/);
});
