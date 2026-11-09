import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/superDashboard.js';

async function fixture(t, role = 'super_admin', row = {}) {
  const app = Fastify();
  const calls = [];
  app.decorate('db', { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{
      total_citas: '124', ingresos_citas_hnl_total: '34.00', ingresos_citas_hnl_periodo: '3.00',
      planes_activados: '2', masterpuntos_canjeados: '3',
      ingresos_serie: [{ periodo: '2026-11-08T10:00:00', ingresos_hnl: '3.00' }],
      actividad_serie: [{ periodo: '2026-11-08T00:00:00', planes_activados: '2', masterpuntos_canjeados: '3' }],
      ...row,
    }] };
  } });
  app.decorate('requireRoles', (allowed) => async (_request, reply) => {
    if (!role) return reply.code(401).send({ ok: false });
    if (!allowed.includes(role)) return reply.code(403).send({ ok: false });
  });
  await app.register(routes, { prefix: '/v1/admin/super-dashboard' });
  await app.ready();
  t.after(() => app.close());
  return { app, calls };
}

test('protege el resumen para super_admin', async (t) => {
  const anonymous = await fixture(t, null);
  assert.equal((await anonymous.app.inject('/v1/admin/super-dashboard/summary')).statusCode, 401);
  const admin = await fixture(t, 'admin');
  assert.equal((await admin.app.inject('/v1/admin/super-dashboard/summary')).statusCode, 403);
});

test('devuelve los cuatro KPIs y un rango inclusivo de Honduras', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-01&fecha_hasta=2026-11-08');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.data.periodo, { fecha_desde: '2026-11-01', fecha_hasta: '2026-11-08' });
  assert.equal(body.data.timezone, 'America/Tegucigalpa');
  assert.deepEqual([
    body.data.total_citas, body.data.ingresos_citas_hnl_total, body.data.ingresos_citas_hnl_periodo,
    body.data.planes_activados, body.data.masterpuntos_canjeados,
  ], [124, 34, 3, 2, 3]);
  assert.deepEqual(calls[0].params.slice(1), ['2026-11-01T06:00:00.000Z', '2026-11-09T06:00:00.000Z', 'day']);
  assert.deepEqual(body.data.ingresos_serie, [{ periodo: '2026-11-08T10:00:00', ingresos_hnl: 3 }]);
  assert.deepEqual(body.data.actividad_serie, [{ periodo: '2026-11-08T00:00:00', planes_activados: 2, masterpuntos_canjeados: 3 }]);
});

test('rechaza fechas invalidas sin consultar la base', async (t) => {
  const { app, calls } = await fixture(t);
  assert.equal((await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-02-30')).statusCode, 400);
  assert.equal((await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-09&fecha_hasta=2026-11-08')).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('la consulta es agregada, parametrizada y de solo lectura', async (t) => {
  const { app, calls } = await fixture(t);
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-08&fecha_hasta=2026-11-08');
  const sql = calls[0].sql;
  assert.match(sql, /COUNT\(c\.id_cita\)/);
  assert.match(sql, /SELECT DISTINCT p\.id_payment, p\.monto_hnl, p\.paid_at/);
  assert.match(sql, /JOIN public\.payment_intents pi ON pi\.id_intent = p\.id_intent/);
  assert.match(sql, /JOIN public\.citas c ON c\.id_cita = pi\.id_cita/);
  assert.match(sql, /SUM\(ep\.monto_hnl\)/);
  assert.match(sql, /p\.paid_at IS NOT NULL/);
  assert.match(sql, /COUNT\(s\.id_suscripcion\)/);
  assert.match(sql, /COUNT\(DISTINCT pt\.id_points_tx\)/);
  assert.match(sql, /tipo_puntos_codigo = 'canjear'/);
  assert.match(sql, /WITH RECURSIVE range_config/);
  assert.match(sql, /LEAST\(b\.bucket \+ rc\.step, rc\.local_to\)/);
  assert.match(sql, /COALESCE\(\(SELECT SUM\(ep\.monto_hnl\)/);
  assert.doesNotMatch(sql, /subscription_payments|citas_detalles|total_pagar_hnl/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.deepEqual(calls[0].params[0], ['capturado', 'conciliado', 'manual_pagado']);
});

test('conserva buckets sin actividad y totales de series verificables', async (t) => {
  const { app } = await fixture(t, 'super_admin', {
    ingresos_citas_hnl_periodo: '5.00',
    planes_activados: '1',
    masterpuntos_canjeados: '2',
    ingresos_serie: [
      { periodo: '2026-11-01T00:00:00', ingresos_hnl: '2.00' },
      { periodo: '2026-11-02T00:00:00', ingresos_hnl: '0.00' },
      { periodo: '2026-11-03T00:00:00', ingresos_hnl: '3.00' },
    ],
    actividad_serie: [
      { periodo: '2026-11-01T00:00:00', planes_activados: '0', masterpuntos_canjeados: '1' },
      { periodo: '2026-11-02T00:00:00', planes_activados: '0', masterpuntos_canjeados: '0' },
      { periodo: '2026-11-03T00:00:00', planes_activados: '1', masterpuntos_canjeados: '1' },
    ],
  });
  const body = (await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-01&fecha_hasta=2026-11-03')).json().data;
  assert.equal(body.ingresos_serie.reduce((sum, item) => sum + item.ingresos_hnl, 0), body.ingresos_citas_hnl_periodo);
  assert.equal(body.actividad_serie.reduce((sum, item) => sum + item.planes_activados, 0), body.planes_activados);
  assert.equal(body.actividad_serie.reduce((sum, item) => sum + item.masterpuntos_canjeados, 0), body.masterpuntos_canjeados);
  assert.equal(body.ingresos_serie[1].ingresos_hnl, 0);
});

test('agrupa hoy por hora y rangos extensos de forma acotada', async (t) => {
  const { app, calls } = await fixture(t);
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-08&fecha_hasta=2026-11-08');
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-01-01&fecha_hasta=2026-11-08');
  assert.equal(calls[0].params[3], 'hour');
  assert.equal(calls[1].params[3], 'month');
});
