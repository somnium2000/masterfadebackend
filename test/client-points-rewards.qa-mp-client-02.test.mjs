import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import clientePointsRoutes from "../src/routes/v1/clientePoints.js";
import {
  applyRewardRedeemForConfirmedGroup,
  getClientePointsSummary,
  redeemReward,
} from "../src/services/pointsService.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BRANCH_A = "33333333-3333-4333-8333-333333333333";
const BRANCH_B = "44444444-4444-4444-8444-444444444444";
const RULE = "55555555-5555-4555-8555-555555555555";
const SERVICE_NO_PLAN = "66666666-6666-4666-8666-666666666666";
const SERVICE_PLAN = "77777777-7777-4777-8777-777777777777";
const GROUP = "88888888-8888-4888-8888-888888888888";
const CITA_A = "99999999-9999-4999-8999-999999999999";
const CYCLE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function summaryFixture({ balance = 10, activePlan = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("fn_points_materialize_expired_cycles")) return { rows: [] };
      if (text.includes("JOIN public.personas p")) return { rows: [{
        id_cliente: CLIENT, id_usuario: USER, id_sucursal_origen: BRANCH_A,
        nombres: "Cliente", apellidos: "QA",
      }] };
      if (text.includes("AS puntos_titular")) return { rows: [{ saldo_total: balance, puntos_titular: balance, puntos_integrante: 0 }] };
      if (text.includes("COALESCE(r.puntos_para_premio")) return { rows: [{ puntos_para_premio: 10 }] };
      if (text.includes("ORDER BY pt.created_at DESC")) return { rows: [] };
      if (text.includes("FROM public.subscriptions s")) return { rows: [{ has_active_plan: activePlan }] };
      if (text.includes("FROM public.sucursales") && text.includes("estado IS TRUE")) return { rows: [{ id_sucursal: params[0] }] };
      if (text.includes("SELECT COALESCE(SUM(pt.puntos), 0)::int AS saldo_total")) return { rows: [{ saldo_total: balance }] };
      if (text.includes("SELECT r.id_rule, r.puntos_para_premio")) return { rows: [{ id_rule: RULE, puntos_para_premio: 10 }] };
      if (text.includes("FROM public.points_rule_services prs")) {
        assert.match(text, /prs\.habilitado IS TRUE/);
        assert.match(text, /prs\.visible_cliente IS TRUE/);
        assert.match(text, /s\.agendable IS TRUE/);
        assert.match(text, /America\/Tegucigalpa/);
        const withPlan = params[1] === "con_membresia";
        return { rows: [{
          id_servicio: withPlan ? SERVICE_PLAN : SERVICE_NO_PLAN,
          nombre_servicio: withPlan ? "Servicio membresia" : "Servicio general",
          orden_visual: 1,
          sucursales_disponibles: withPlan ? [BRANCH_B] : [BRANCH_A],
        }] };
      }
      throw new Error(`SQL_NO_SIMULADO: ${text}`);
    },
    release() {},
  };
  return { app: { db: { connect: async () => client } }, calls };
}

for (const [label, activePlan, expectedService, expectedCondition] of [
  ["sin membresia", false, SERVICE_NO_PLAN, "sin_membresia"],
  ["con membresia", true, SERVICE_PLAN, "con_membresia"],
]) test(`resumen cliente ${label} usa exclusivamente la configuracion autorizada`, async () => {
  const fixture = summaryFixture({ activePlan });
  const result = await getClientePointsSummary(fixture.app, CLIENT, { includeRedeemableServices: true });
  assert.equal(result.progreso_actual, 10);
  assert.equal(result.puede_canjear, true);
  assert.deepEqual(result.servicios_redimibles, [{
    id_servicio: expectedService,
    nombre_servicio: activePlan ? "Servicio membresia" : "Servicio general",
    sucursales_disponibles: [activePlan ? BRANCH_B : BRANCH_A],
  }]);
  const configurationCall = fixture.calls.find(({ text }) => text.includes("FROM public.points_rule_services prs"));
  assert.equal(configurationCall.params[1], expectedCondition);
});

test("resumen administrativo no expone ni consulta servicios de recompensa", async () => {
  const fixture = summaryFixture();
  const result = await getClientePointsSummary(fixture.app, CLIENT);
  assert.equal(Object.hasOwn(result, "servicios_redimibles"), false);
  assert.equal(fixture.calls.some(({ text }) => text.includes("FROM public.points_rule_services prs")), false);
});

test("GET cliente puntos resumen entrega opciones configuradas sin escrituras", async (t) => {
  const fixture = summaryFixture();
  const app = Fastify({ logger: false });
  app.decorate("db", fixture.app.db);
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { roles: ["cliente"], cliente_id: CLIENT, user: { id_usuario: USER } };
  });
  await app.register(clientePointsRoutes, { prefix: "/v1/cliente/puntos" });
  await app.ready();
  t.after(() => app.close());

  const response = await app.inject("/v1/cliente/puntos/resumen");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.servicios_redimibles, [{
    id_servicio: SERVICE_NO_PLAN,
    nombre_servicio: "Servicio general",
    sucursales_disponibles: [BRANCH_A],
  }]);
  assert.equal(fixture.calls.some(({ text }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
});

test("preparar canje valida la misma configuracion y no descuenta puntos", async () => {
  const fixture = summaryFixture({ balance: 10, activePlan: false });
  const result = await redeemReward(fixture.app, {
    idCliente: CLIENT,
    idServicioCanje: SERVICE_NO_PLAN,
    idSucursal: BRANCH_A,
  });
  assert.equal(result.canje_preparado, true);
  assert.equal(result.saldo_actual, 10);
  assert.equal(fixture.calls.some(({ text }) => text.includes("INSERT INTO public.points_transactions")), false);
});

test("servicio no configurado se rechaza por API sin descontar puntos", async () => {
  const fixture = summaryFixture({ balance: 10, activePlan: false });
  await assert.rejects(redeemReward(fixture.app, {
    idCliente: CLIENT,
    idServicioCanje: SERVICE_PLAN,
    idSucursal: BRANCH_A,
  }), { statusCode: 409, code: "POINTS_REDEEM_SERVICE_FORBIDDEN" });
  assert.equal(fixture.calls.some(({ text }) => text.includes("INSERT INTO public.points_transactions")), false);
});

test("confirmar canje descuenta una sola vez y libera acumulacion bajo la meta", async () => {
  let balance = 10;
  let redeemed = null;
  const insertions = [];
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text.includes("pg_advisory_xact_lock") || text.includes("fn_points_materialize_expired_cycles")) return { rows: [] };
      if (text.includes("JOIN public.personas p")) return { rows: [{ id_cliente: CLIENT, id_usuario: USER, id_sucursal_origen: BRANCH_A, nombres: "Cliente", apellidos: "QA" }] };
      if (text.includes("FROM public.citas_grupos cg") && text.includes("JOIN LATERAL")) return { rows: [{
        id_grupo_cita: GROUP, id_cliente_titular: CLIENT, id_cita: CITA_A, id_sucursal: BRANCH_A,
        estado_cita_codigo: "confirmada", es_canje_recompensa: true, descuento_hnl: 100, inicio_at: "2026-11-02T12:00:00Z",
      }] };
      if (text.includes("FROM public.points_transactions") && text.includes("FOR UPDATE")) return { rows: redeemed ? [redeemed] : [] };
      if (text.includes("FROM public.citas_detalles cd")) return { rows: [{ id_servicio: SERVICE_NO_PLAN, subtotal_hnl: 100, nombre_servicio: "Servicio general" }] };
      if (text.includes("FROM public.subscriptions s")) return { rows: [{ has_active_plan: false }] };
      if (text.includes("SELECT r.id_rule, r.puntos_para_premio")) return { rows: [{ id_rule: RULE, puntos_para_premio: 10 }] };
      if (text.includes("FROM public.points_rule_services prs")) return { rows: [{ id_servicio: SERVICE_NO_PLAN, nombre_servicio: "Servicio general", orden_visual: 1, sucursales_disponibles: [BRANCH_A] }] };
      if (text.includes("COALESCE(r.puntos_para_premio")) return { rows: [{ puntos_para_premio: 10 }] };
      if (text.includes("SELECT COALESCE(SUM(pt.puntos), 0)::int AS saldo_total")) return { rows: [{ saldo_total: balance }] };
      if (text.includes("INSERT INTO public.points_transactions")) {
        balance -= 10;
        redeemed = { id_points_tx: CYCLE, id_servicio_canje: SERVICE_NO_PLAN, puntos: -10, created_at: "2026-11-02T13:00:00Z" };
        insertions.push(redeemed);
        return { rows: [{ ...redeemed, id_cliente: CLIENT, id_cita: CITA_A }], rowCount: 1 };
      }
      if (text.startsWith("DELETE FROM public.points_transactions")) return { rows: [], rowCount: 0 };
      throw new Error(`SQL_NO_SIMULADO: ${text}`);
    },
  };

  const first = await applyRewardRedeemForConfirmedGroup(client, { idGrupoCita: GROUP, idCliente: CLIENT });
  const replay = await applyRewardRedeemForConfirmedGroup(client, { idGrupoCita: GROUP, idCliente: CLIENT });
  assert.equal(first.aplicada, true);
  assert.equal(first.saldo_actual, 0);
  assert.equal(replay.ya_aplicada, true);
  assert.equal(insertions.length, 1);

});
