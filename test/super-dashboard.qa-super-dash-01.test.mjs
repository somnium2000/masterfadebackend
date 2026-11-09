import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/superDashboard.js';

async function fixture(t, role = 'super_admin', row = {}) {
  const app = Fastify();
  const calls = [];
  app.decorate('db', { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ total_citas: '124', valor_citas_hnl: '4.00', planes_activados: '2', masterpuntos_canjeados: '3', ...row }] };
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
    body.data.total_citas, body.data.valor_citas_hnl,
    body.data.planes_activados, body.data.masterpuntos_canjeados,
  ], [124, 4, 2, 3]);
  assert.deepEqual(calls[0].params.slice(1), ['2026-11-01T06:00:00.000Z', '2026-11-09T06:00:00.000Z']);
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
  assert.match(sql, /SUM\(c\.total_pagar_hnl\)/);
  assert.match(sql, /COUNT\(s\.id_suscripcion\)/);
  assert.match(sql, /COUNT\(DISTINCT pt\.id_points_tx\)/);
  assert.match(sql, /tipo_puntos_codigo = 'canjear'/);
  assert.match(sql, /estado_cita_codigo = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.deepEqual(calls[0].params[0], ['confirmada', 'en_salon', 'en_atencion', 'completada']);
});
