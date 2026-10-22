import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/reportes.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const range = 'fecha_desde=2026-10-01&fecha_hasta=2026-10-20';
async function setup(t, empty = false) {
  const calls = [];
  let releases = 0;
  const query = async (sql, params = []) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i); calls.push({ sql, params });
    if (/SELECT id_sucursal\s+FROM public\.sucursales/.test(sql)) return { rows: [{ id_sucursal: A }, { id_sucursal: B }] };
    if (empty) return { rows: [] };
    if (sql.includes('GROUP BY c.id_sucursal, s.nombre_sucursal')) {
      assert.deepEqual(params[3], [A, B]);
      const rows = [
        { id_sucursal: A, nombre_sucursal: 'Sede A', ingresos_hnl: '100.00', citas_pagadas: 2 },
        { id_sucursal: B, nombre_sucursal: 'Sede B', ingresos_hnl: '60.00', citas_pagadas: 3 },
      ];
      return { rows: params[4] ? rows.filter((row) => row.id_sucursal === params[4]) : rows };
    }
    return { rows: [] };
  };
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', (allowed) => async (request) => {
    assert.deepEqual(allowed, ['super_admin']); request.claims = { roles: ['super_admin'], branch_ids: [A] };
  });
  app.decorate('db', { query, connect: async () => ({ query, release: () => { releases += 1; } }) });
  await app.register(routes, { prefix: '/reportes' }); t.after(() => app.close());
  return { app, calls, releases: () => releases };
}
test('superadmin conserva comparativo global aunque claims incluya una sola sucursal', async (t) => {
  const { app, releases } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.ventas_ingresos.ingresos_por_sucursal, [
    { id_sucursal: A, nombre_sucursal: 'Sede A', ingresos_hnl: 100, citas_pagadas: 2 },
    { id_sucursal: B, nombre_sucursal: 'Sede B', ingresos_hnl: 60, citas_pagadas: 3 },
  ]); assert.equal(releases(), 1);
});
test('filtro de sucursal y rango se parametrizan en consulta financiera existente', async (t) => {
  const { app, calls } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}&id_sucursal=${B}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.ventas_ingresos.ingresos_por_sucursal.map((row) => row.id_sucursal), [B]);
  const { sql, params } = calls.find(({ sql }) => sql.includes('GROUP BY c.id_sucursal, s.nombre_sucursal'));
  assert.match(sql, /c.id_sucursal = ANY\(\$4::uuid\[\]\)/);
  assert.match(sql, /c.id_sucursal = \$5::uuid/);
  assert.equal(params[4], B);
  assert.equal(params[1], '2026-10-01T06:00:00.000Z');
  assert.equal(params[2], '2026-10-21T06:00:00.000Z');
});
for (const format of ['csv', 'excel']) test(`${format} de sucursales conserva filas y filtro del dashboard`, async (t) => {
  const { app } = await setup(t);
  const response = await app.inject(`/reportes/export/${format}?${range}&id_sucursal=${B}&export_type=ingresos_sucursal`);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Sede B/); assert.doesNotMatch(response.body, /Sede A/);
  assert.match(response.body, /citas_pagadas/); assert.match(response.body, /ingresos_hnl/);
  assert.match(response.headers['content-disposition'], /2026-10-01_2026-10-20/);
});
test('sin registros devuelve comparativo vacío sin recalcular saldos', async (t) => {
  const { app } = await setup(t, true);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.ventas_ingresos.ingresos_por_sucursal, []);
});
