import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/reportes.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BARBER = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '44444444-4444-4444-8444-444444444444';
const range = `fecha_desde=2026-10-01&fecha_hasta=2026-10-20&id_sucursal=${A}&id_barbero=${BARBER}&commission_rate=10`;
async function setup(t, { branch = A, empty = false } = {}) {
  const calls = [];
  let releases = 0;
  const query = async (sql, params = []) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i); calls.push({ sql, params });
    if (/SELECT id_sucursal\s+FROM public\.sucursales/.test(sql)) return { rows: [{ id_sucursal: A }, { id_sucursal: B }] };
    if (sql.includes('WHERE e.id_empleado = $1')) {
      assert.deepEqual(params[1], [A, B]);
      return { rows: params[0] === BARBER ? [{ id_empleado: BARBER, id_sucursal: branch, nombre_barbero: 'Barbero sintético' }] : [] };
    }
    if (empty) return { rows: [] };
    if (sql.includes('GROUP BY c.id_empleado_barbero') && sql.includes('AS servicios_realizados')) {
      return { rows: [{ id_empleado: BARBER, nombre_barbero: 'Barbero sintético', servicios_realizados: 3, citas_completadas: 2, no_show: 1 }] };
    }
    if (sql.includes('GROUP BY c.id_empleado_barbero') && sql.includes('AS ingresos_hnl')) {
      return { rows: [{ id_empleado: BARBER, nombre_barbero: 'Barbero sintético', ingresos_hnl: '150.00', citas_pagadas: 2 }] };
    }
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
test('productividad conserva servicios, ingresos y comisión del contrato con filtros', async (t) => {
  const { app, calls, releases } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  const row = data.productividad_barberos.resumen[0];
  assert.equal(row.id_empleado, BARBER); assert.equal(row.servicios_realizados, 3);
  assert.equal(row.ingresos_hnl, 150); assert.equal(row.comision_estimada_hnl, 15);
  assert.equal(data.filtros_aplicados.id_barbero, BARBER);
  assert.equal(data.filtros_aplicados.id_sucursal, A);
  for (const { params } of calls.filter(({ sql }) => sql.includes('GROUP BY c.id_empleado_barbero'))) {
    assert.ok(params.includes(A)); assert.ok(params.includes(BARBER));
  }
  assert.equal(releases(), 1);
});
for (const format of ['csv', 'excel']) test(`${format} conserva productividad y rango`, async (t) => {
  const { app } = await setup(t);
  const response = await app.inject(`/reportes/export/${format}?${range}&export_type=productividad`);
  assert.equal(response.statusCode, 200); assert.match(response.body, /Barbero sintético/);
  assert.match(response.body, /servicios_realizados/); assert.match(response.body, /150/);
  assert.match(response.headers['content-disposition'], /2026-10-01_2026-10-20/);
});
test('barbero fuera de la sucursal seleccionada se rechaza antes de estadísticas', async (t) => {
  const { app, calls, releases } = await setup(t, { branch: B });
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'REPORTES_BARBER_BRANCH_MISMATCH');
  assert.equal(calls.length, 2); assert.equal(releases(), 1);
});
test('barbero inexistente no devuelve estadísticas de otros', async (t) => {
  const { app, calls } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range.replace(BARBER, UNKNOWN)}`);
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'REPORTES_BARBER_NOT_FOUND'); assert.equal(calls.length, 2);
});
test('sin movimientos conserva un resumen vacío', async (t) => {
  const { app } = await setup(t, { empty: true });
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.productividad_barberos.resumen, []);
});
