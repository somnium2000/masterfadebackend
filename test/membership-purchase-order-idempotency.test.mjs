import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import clienteRoutes from "../src/routes/v1/cliente.js";

const CLIENT = "41111111-1111-4111-8111-111111111111";
const OTHER = "42222222-2222-4222-8222-222222222222";
const USER = "51111111-1111-4111-8111-111111111111";
const OFFER = "11111111-1111-4111-8111-111111111111";
const OFFER_B = "12222222-2222-4222-8222-222222222222";
const PLAN = "21111111-1111-4111-8111-111111111111";
const BRANCH = "31111111-1111-4111-8111-111111111111";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const columns = ["id_order", "id_cliente", "id_usuario", "id_plan", "id_plan_sucursal", "id_sucursal",
  "estado_orden_codigo", "moneda_codigo", "subtotal_hnl", "descuento_hnl", "total_hnl",
  "plan_snapshot", "cliente_snapshot", "factura_snapshot", "email_factura", "idempotency_key", "expires_at"];
const clean = (sql) => String(sql).replace(/\s+/g, " ").trim();
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// AM: Simula UNIQUE, visibilidad al COMMIT y espera entre transacciones; no es PostgreSQL.
function store({ hasKeyColumn = true, hasIndex = true, concurrent = false, failFirstCommit = false } = {}) {
  const data = {
    orders: [], sessions: [], reservations: new Map(), initialReads: 0,
    insertAttempts: 0, conflicts: 0, commits: 0, rollbacks: 0, catalogReads: 0,
    schema: hasKeyColumn ? columns : columns.filter((name) => name !== "idempotency_key"),
    offer: { id_plan: PLAN, id_sucursal: BRANCH, precio_hnl: 1000, oferta_activa: true,
      visible_publico: true, nombre_plan: "Plan VIP", periodo_membresia_codigo: "trimestral",
      periodo_membresia_label: "Trimestral", categoria_nivel: 3, plan_activo: true,
      sucursal_activa: true, sucursal_deleted_at: null, nombre_sucursal: "Centro",
      beneficios: { version: 1, items: [{ tipo: "servicio", id_servicio: PLAN, nombre: "Corte", cantidad: 2 }] } },
  };
  const initialBarrier = deferred();
  let orderSequence = 0;
  data.connect = async () => {
    const session = { calls: [], aborted: false, pending: null, reservation: null, reads: 0, released: false };
    data.sessions.push(session);
    const releaseReservation = () => {
      if (session.reservation) {
        data.reservations.delete(session.reservation.key);
        session.reservation.done.resolve();
        session.reservation = null;
      }
    };
    const query = async (sql, params = []) => {
      const text = clean(sql);
      session.calls.push({ sql: text, params });
      const result = (rows) => ({ rows, rowCount: rows.length });
      if (text === "ROLLBACK") {
        data.rollbacks += 1; session.pending = null; session.aborted = false; releaseReservation(); return result([]);
      }
      if (session.aborted) throw Object.assign(new Error("Mock transaction aborted"), { code: "25P02" });
      if (text === "BEGIN") return result([]);
      if (text === "COMMIT") {
        if (failFirstCommit) {
          failFirstCommit = false;
          session.aborted = true;
          throw new Error("Simulated COMMIT failure");
        }
        if (session.pending) data.orders.push(session.pending);
        session.pending = null; data.commits += 1; releaseReservation(); return result([]);
      }
      if (text.includes("to_regclass('public.membership_purchase_orders')")) return result([{ has_purchase_orders: true }]);
      if (text.includes("to_regclass('public.subscriptions')")) return result([{ has_membership_plans: true, has_membership_plans_sucursal: true }]);
      if (text.includes("information_schema.columns")) return result(text.includes("table_name = 'membership_purchase_orders'")
        ? data.schema.map((column_name) => ({ column_name }))
        : [{ table_name: "membership_plans", column_name: "categoria_nivel" }]);
      if (text.includes("FROM public.membership_purchase_orders") && text.includes("idempotency_key = $2::text")) {
        if (!hasKeyColumn) { session.aborted = true; throw Object.assign(new Error("Missing mock column"), { code: "42703" }); }
        assert.match(text, /WHERE id_cliente = \$1::uuid AND idempotency_key = \$2::text/);
        assert.match(text, /expires_at > clock_timestamp\(\)/);
        const row = data.orders.find((order) => order.id_cliente === params[0] && order.idempotency_key === params[1]);
        session.reads += 1;
        if (concurrent && session.reads === 1) {
          data.initialReads += 1;
          if (data.initialReads === 2) initialBarrier.resolve();
          await initialBarrier.promise;
        }
        return result(row ? [{ ...structuredClone(row), unexpired: row.expires_at != null && new Date(row.expires_at).getTime() > Date.now() }] : []);
      }
      if (text.includes("FROM public.membership_plans_sucursal mps") && text.includes("WHERE mps.id_plan_sucursal = $1::uuid")) {
        data.catalogReads += 1;
        return result(data.offer ? [{ ...data.offer, id_plan_sucursal: params[0] }] : []);
      }
      if (text.includes("FROM public.clientes c")) return result([{ id_cliente: params[0], id_usuario: USER, nombre_completo: "Cliente", correo_principal: `${params[0]}@example.test` }]);
      if (text.startsWith("INSERT INTO public.membership_purchase_orders")) {
        data.insertAttempts += 1;
        const names = text.match(/membership_purchase_orders \( (.*?) \) VALUES/)[1].split(",").map((name) => name.trim());
        const row = Object.fromEntries(names.map((name, index) => [name, name === "expires_at" ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : params[index]]));
        if (!("idempotency_key" in row)) row.idempotency_key = null;
        const guarded = text.includes("ON CONFLICT (id_cliente, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING");
        if (row.idempotency_key) {
          assert.ok(guarded, "La clave exige ON CONFLICT, no solo SELECT previo");
          if (!hasIndex) { session.aborted = true; throw Object.assign(new Error("Missing mock index"), { code: "42P10" }); }
          const uniqueKey = `${row.id_cliente}:${row.idempotency_key}`;
          while (data.reservations.has(uniqueKey)) await data.reservations.get(uniqueKey).done.promise;
          if (data.orders.some((order) => `${order.id_cliente}:${order.idempotency_key}` === uniqueKey)) {
            data.conflicts += 1;
            return result([]);
          }
          const reservation = { key: uniqueKey, done: deferred() };
          data.reservations.set(uniqueKey, reservation);
          session.reservation = reservation;
        }
        for (const name of ["plan_snapshot", "cliente_snapshot", "factura_snapshot"]) if (row[name]) row[name] = JSON.parse(row[name]);
        orderSequence += 1;
        row.id_order = `90000000-0000-4000-8000-${String(orderSequence).padStart(12, "0")}`;
        session.pending = row;
        assert.match(text, /now\(\) \+ interval '30 minutes'/);
        return result([{ id_order: row.id_order }]);
      }
      throw new Error(`Unexpected SQL in isolated mock: ${text.slice(0, 120)}`);
    };
    return { query, release() { session.released = true; } };
  };
  return data;
}

async function appFor(t, data) {
  const app = Fastify();
  app.decorate("db", { connect: data.connect });
  app.decorate("requireRoles", () => async (request) => {
    // AM: Header exclusivo del doble para simular claims autenticados de dos clientes.
    request.claims = { roles: ["cliente"], cliente_id: request.headers["x-test-client"] || CLIENT, user: { id_usuario: USER } };
  });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.ready();
  t.after(() => app.close());
  return app;
}
const requestOrder = (app, { key = KEY, offer = OFFER, cliente = CLIENT, payload = {} } = {}) => app.inject({
  method: "POST", url: "/v1/cliente/planes/orden", headers: { "x-test-client": cliente },
  payload: { id_plan_sucursal: offer, ...(key === undefined ? {} : { idempotency_key: key }), ...payload },
});
const success = (response) => { assert.equal(response.statusCode, 201, response.body); return response.json().data; };
function failure(response, code, status = 409) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
}

test("primera solicitud persiste clave y contrato; repeticion devuelve orden y snapshots originales", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  const first = success(await requestOrder(app));
  const before = structuredClone(data.orders);
  data.offer.precio_hnl = 2500;
  data.offer.beneficios.items[0].cantidad = 99;
  data.offer.plan_activo = false;
  data.offer.sucursal_activa = false;
  const replay = success(await requestOrder(app));
  assert.deepEqual(replay, first);
  assert.equal(first.totales.total_hnl, 1000);
  assert.equal(replay.plan.beneficios.items[0].cantidad, 2);
  assert.deepEqual(data.orders, before);
  assert.equal(data.orders[0].idempotency_key, KEY);
  assert.equal(data.catalogReads, 1);
  assert.equal(data.insertAttempts, 1);
  assert.equal(data.commits, 2);
});

test("dos sesiones concurrentes con misma clave: UNIQUE espera COMMIT y solo inserta una orden", async (t) => {
  const data = store({ concurrent: true });
  const app = await appFor(t, data);
  const responses = await Promise.all([requestOrder(app), requestOrder(app)]);
  assert.deepEqual(success(responses[0]), success(responses[1]));
  assert.equal(data.initialReads, 2);
  assert.equal(data.insertAttempts, 2);
  assert.equal(data.conflicts, 1);
  assert.equal(data.orders.length, 1);
  assert.equal(data.commits, 2);
  assert.ok(data.sessions.every((session) => !session.aborted && session.released));
  assert.ok(data.sessions.some((session) => session.reads === 2));
});

test("misma clave con otra oferta devuelve conflicto sin otra insercion", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  success(await requestOrder(app));
  failure(await requestOrder(app, { offer: OFFER_B }), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_CONFLICT");
  assert.equal(data.orders.length, 1);
  assert.equal(data.insertAttempts, 1);
  assert.equal(data.rollbacks, 1);
});

test("conflicto concurrente con otra oferta recupera ganador y rechaza perdedor", async (t) => {
  const data = store({ concurrent: true });
  const app = await appFor(t, data);
  const responses = await Promise.all([requestOrder(app), requestOrder(app, { offer: OFFER_B })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(data.orders.length, 1);
  failure(responses.find((response) => response.statusCode === 409), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_CONFLICT");
});

test("clave compartida por clientes distintos no devuelve snapshots ajenos", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  const first = success(await requestOrder(app));
  const second = success(await requestOrder(app, { cliente: OTHER }));
  assert.notEqual(second.id_order, first.id_order);
  assert.equal(second.cliente.id_cliente, OTHER);
  assert.notEqual(second.cliente.email, first.cliente.email);
  assert.equal(data.orders.length, 2);
  assert.deepEqual(success(await requestOrder(app, { cliente: OTHER })), second);
});

test("payload id_cliente ajeno no sustituye claims autenticados", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  assert.equal(success(await requestOrder(app, { payload: { id_cliente: OTHER } })).cliente.id_cliente, CLIENT);
  assert.equal(data.orders[0].id_cliente, CLIENT);
});

test("clave nueva permite compra nueva y UUID mayusculo reutiliza la clave canonica", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  const first = success(await requestOrder(app));
  assert.equal(success(await requestOrder(app, { key: KEY.toUpperCase() })).id_order, first.id_order);
  assert.notEqual(success(await requestOrder(app, { key: KEY_B })).id_order, first.id_order);
  assert.equal(data.orders.length, 2);
});

for (const status of ["pagada", "cancelada", "expirada", "fallida"]) {
  test(`orden ${status} no se reutiliza ni se modifica`, async (t) => {
    const data = store();
    const app = await appFor(t, data);
    success(await requestOrder(app));
    data.orders[0].estado_orden_codigo = status;
    const before = structuredClone(data.orders);
    failure(await requestOrder(app), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_ORDER_UNAVAILABLE");
    assert.deepEqual(data.orders, before);
    assert.equal(data.insertAttempts, 1);
  });
}

test("pendiente con expires_at vencido rechaza sin cambiar su estado", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  success(await requestOrder(app));
  data.orders[0].expires_at = "2020-01-01T00:00:00Z";
  failure(await requestOrder(app), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_ORDER_UNAVAILABLE");
  assert.equal(data.orders[0].estado_orden_codigo, "pendiente_pago");
  assert.equal(data.orders.length, 1);
});

for (const [field, value, code] of [
  ["sucursal_activa", false, "MEMBERSHIP_PURCHASE_BRANCH_INACTIVE"],
  ["sucursal_deleted_at", "2026-01-01", "MEMBERSHIP_PURCHASE_BRANCH_INACTIVE"],
  ["visible_publico", false, "MEMBERSHIP_PURCHASE_OFFER_NOT_VISIBLE"],
  ["oferta_activa", false, "MEMBERSHIP_PURCHASE_OFFER_INACTIVE"],
  ["plan_activo", false, "MEMBERSHIP_PURCHASE_PLAN_INACTIVE"],
  ["precio_hnl", 0, "MEMBERSHIP_PURCHASE_PRICE_INVALID"],
]) {
  test(`compra nueva conserva rechazo de ${field}`, async (t) => {
    const data = store();
    data.offer[field] = value;
    const app = await appFor(t, data);
    failure(await requestOrder(app), code);
    assert.equal(data.insertAttempts, 0);
    assert.equal(data.rollbacks, 1);
  });
}

for (const key of ["", "no-uuid", "a".repeat(500), null]) {
  test(`HTTP rechaza clave invalida ${String(key).slice(0, 12)}`, async (t) => {
    const data = store();
    const app = await appFor(t, data);
    assert.equal((await requestOrder(app, { key })).statusCode, 400);
    assert.equal(data.sessions.length, 0);
    assert.equal(data.orders.length, 0);
  });
}

test("sin clave conserva comportamiento legacy y orden historica NULL", async (t) => {
  const data = store();
  const app = await appFor(t, data);
  const first = success(await requestOrder(app, { payload: { idempotency_key: undefined } }));
  const second = success(await requestOrder(app, { payload: { idempotency_key: undefined } }));
  assert.notEqual(first.id_order, second.id_order);
  assert.equal(data.orders.length, 2);
  assert.ok(data.orders.every((row) => row.idempotency_key === null));
});

test("columna ausente rechaza clave; legacy sigue creando sin SQL desprotegido", async () => {
  const service = await import("../src/services/membershipService.js?idempotency-column-absent");
  const data = store({ hasKeyColumn: false });
  const client = await data.connect();
  await assert.rejects(service.createMembershipPurchaseOrder(client, { clienteId: CLIENT, idPlanSucursal: OFFER, idempotencyKey: KEY }),
    { statusCode: 503, code: "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY" });
  assert.equal(data.insertAttempts, 0);
  assert.equal(data.catalogReads, 0);
  const legacy = await service.createMembershipPurchaseOrder(client, { clienteId: CLIENT, idPlanSucursal: OFFER });
  assert.ok(legacy.id_order);
  assert.equal(data.insertAttempts, 1);
});

test("columna presente sin indice falla segura y controlador hace rollback", async (t) => {
  const data = store({ hasIndex: false });
  const app = await appFor(t, data);
  failure(await requestOrder(app), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY", 503);
  assert.equal(data.orders.length, 0);
  assert.equal(data.rollbacks, 1);
  assert.equal(data.sessions[0].aborted, false);
});

test("migracion aditiva prepara columna nullable e indice UNIQUE parcial, sin aplicarlos", () => {
  const sql = readFileSync(new URL("../db/migrations/20261012_membership_purchase_order_idempotency.sql", import.meta.url), "utf8").replace(/--[^\r\n]*/g, "");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS idempotency_key text NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*\(id_cliente, idempotency_key\)[\s\S]*WHERE idempotency_key IS NOT NULL/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|DROP|GRANT|payment_intents|subscriptions)\b/i);
});

test("si el ganador revierte, la sesion que espera UNIQUE puede crear la unica orden", async (t) => {
  const data = store({ concurrent: true, failFirstCommit: true });
  const app = await appFor(t, data);
  const responses = await Promise.all([requestOrder(app), requestOrder(app)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 500]);
  assert.equal(data.orders.length, 1);
  assert.equal(data.rollbacks, 1);
  assert.equal(data.commits, 1);
  assert.equal(data.reservations.size, 0);
});

test("servicio rechaza clave invalida antes de consultar capacidades", async () => {
  const service = await import("../src/services/membershipService.js?idempotency-invalid-key");
  await assert.rejects(service.createMembershipPurchaseOrder({ query() { throw new Error("Unexpected DB call"); } },
    { clienteId: CLIENT, idPlanSucursal: OFFER, idempotencyKey: "invalid" }),
  { statusCode: 400, code: "MEMBERSHIP_PURCHASE_IDEMPOTENCY_KEY_INVALID" });
});

test("esquema sin snapshots completos rechaza clave antes de insertar", async () => {
  const service = await import("../src/services/membershipService.js?idempotency-missing-snapshots");
  const data = store();
  data.schema = columns.filter((column) => column !== "plan_snapshot");
  const client = await data.connect();
  await assert.rejects(service.createMembershipPurchaseOrder(client,
    { clienteId: CLIENT, idPlanSucursal: OFFER, idempotencyKey: KEY }),
  { statusCode: 503, code: "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY" });
  assert.equal(data.insertAttempts, 0);
});

test("replay lee JSON persistido sin modificar historicas NULL ni escribir pagos o consumos", async (t) => {
  const data = store();
  const historical = { id_order: "historica", id_cliente: CLIENT, idempotency_key: null, estado_orden_codigo: "pagada", plan_snapshot: { precio_hnl: 850 } };
  data.orders.push(structuredClone(historical));
  const app = await appFor(t, data);
  const first = success(await requestOrder(app));
  data.orders[1].plan_snapshot = JSON.stringify(data.orders[1].plan_snapshot);
  data.orders[1].cliente_snapshot = JSON.stringify(data.orders[1].cliente_snapshot);
  assert.deepEqual(success(await requestOrder(app)), first);
  assert.deepEqual(data.orders[0], historical);
  const writes = data.sessions.flatMap((session) => session.calls).filter(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /^INSERT INTO public.membership_purchase_orders/);
});

test("capacidad cacheada exige reinicio tras incorporar columna nueva", async () => {
  const service = await import("../src/services/membershipService.js?idempotency-capability-cache");
  const data = store({ hasKeyColumn: false });
  const client = await data.connect();
  const args = { clienteId: CLIENT, idPlanSucursal: OFFER, idempotencyKey: KEY };
  await assert.rejects(service.createMembershipPurchaseOrder(client, args), { code: "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY" });
  data.schema = columns;
  await assert.rejects(service.createMembershipPurchaseOrder(client, args), { code: "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY" });
  assert.equal(data.insertAttempts, 0);
});

test("dos instancias HTTP independientes comparten la proteccion UNIQUE simulada", async (t) => {
  const data = store({ concurrent: true });
  const firstApp = await appFor(t, data);
  const secondApp = await appFor(t, data);
  const [first, second] = await Promise.all([requestOrder(firstApp), requestOrder(secondApp)]);
  assert.equal(success(first).id_order, success(second).id_order);
  assert.equal(data.orders.length, 1);
  assert.equal(data.conflicts, 1);
});

test("columna ausente con cache anterior falla segura sin escribir y libera transaccion", async (t) => {
  const data = store({ hasKeyColumn: false });
  const app = await appFor(t, data);
  failure(await requestOrder(app), "MEMBERSHIP_PURCHASE_IDEMPOTENCY_SCHEMA_NOT_READY", 503);
  assert.equal(data.insertAttempts, 0);
  assert.equal(data.orders.length, 0);
  assert.equal(data.rollbacks, 1);
  assert.equal(data.sessions[0].aborted, false);
});
