import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/reportes.js';

const A = '11111111-1111-4111-8111-111111111111';
const PLAN = '33333333-3333-4333-8333-333333333333';
const range = `fecha_desde=2026-10-01&fecha_hasta=2026-10-20&id_sucursal=${A}`;
async function setup(t, empty = false) {
  const calls = [];
  let releases = 0;
  const query = async (sql, params = []) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
    calls.push({ sql, params });
    if (/SELECT id_sucursal\s+FROM public\.sucursales/.test(sql)) return { rows: [{ id_sucursal: A }] };
    if (empty) return { rows: [] };
    if (sql.includes('AS ingresos_membresias_hnl') && sql.includes('FROM public.subscription_payments sp')) {
      return { rows: [{ fecha: '2026-10-10', ingresos_membresias_hnl: '250.50', cobros_membresia: 1 }] };
    }
    if (sql.includes('COUNT(sp.id_sub_payment)')) return { rows: [{ id_plan: PLAN, nombre_plan: 'Plan sintético', ingresos_hnl: '250.50', pagos_registrados: 1 }] };
    if (sql.includes('COUNT(su.id_suscripcion)')) return { rows: [{ id_plan: PLAN, nombre_plan: 'Plan sintético', suscripciones_activas: 2 }] };
    return { rows: [] };
  };
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', (allowed) => async (request) => {
    assert.deepEqual(allowed, ['super_admin']); request.claims = { roles: ['super_admin'] };
  });
  app.decorate('db', { query, connect: async () => ({ query, release: () => { releases += 1; } }) });
  await app.register(routes, { prefix: '/reportes' }); t.after(() => app.close());
  return { app, calls, releases: () => releases };
}
test('membresías conserva ingresos por plan, suscripciones activas y rango de sucursal', async (t) => {
  const { app, calls, releases } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(data.kpis.ingresos_membresias_hnl, 250.5);
  assert.equal(data.ventas_ingresos.ingresos_por_fecha[0].ingresos_membresias_hnl, 250.5);
  assert.equal(data.membresias.ingresos_por_planes[0].ingresos_hnl, 250.5);
  assert.equal(data.membresias.suscripciones_activas_por_plan[0].suscripciones_activas, 2);
  assert.equal(data.filtros_aplicados.id_sucursal, A);
  assert.equal(releases(), 1);
  for (const { sql, params } of calls.filter(({ sql }) => sql.includes('GROUP BY mp.id_plan'))) {
    assert.ok(params.includes(A)); assert.match(sql, /cl.id_sucursal_origen = ANY/);
  }
});
for (const format of ['csv', 'excel']) test(`exportación ${format} conserva importes y planes del dashboard`, async (t) => {
  const { app } = await setup(t);
  const response = await app.inject(`/reportes/export/${format}?${range}&export_type=membresias_planes`);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Plan sintético/); assert.match(response.body, /250\.5/);
  assert.match(response.headers['content-disposition'], /2026-10-01_2026-10-20/);
});
test('membresías sin registros devuelve colecciones vacías y cero sin NaN', async (t) => {
  const { app } = await setup(t, true);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.deepEqual(data.membresias.ingresos_por_planes, []);
  assert.deepEqual(data.membresias.suscripciones_activas_por_plan, []);
  assert.equal(data.kpis.ingresos_membresias_hnl, 0);
});
