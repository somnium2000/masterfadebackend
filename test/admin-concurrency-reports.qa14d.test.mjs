import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/reportes.js';
const A = '11111111-1111-4111-8111-111111111111';
const range = `fecha_desde=2026-10-01&fecha_hasta=2026-10-20&id_sucursal=${A}`;
async function setup(t, empty = false) {
  const calls = [];
  let releases = 0;
  const query = async (sql, params = []) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i); calls.push({ sql, params });
    if (/SELECT id_sucursal\s+FROM public\.sucursales/.test(sql)) return { rows: [{ id_sucursal: A }] };
    if (empty) return { rows: [] };
    if (sql.includes('GROUP BY EXTRACT(ISODOW')) return { rows: [{ dia_semana_num: 1, total_citas: 5, no_show: 1, completadas: 3 }] };
    if (sql.includes('GROUP BY EXTRACT(HOUR')) return { rows: [{ hora: 10, total_citas: 5, no_show: 1, completadas: 3 }] };
    if (sql.includes('COUNT(*)::int AS total_citas')) return { rows: [{ total_citas: 5 }] };
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
test('dashboard conserva tráfico por día, hora pico y alcance de sucursal', async (t) => {
  const { app, calls, releases } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(data.kpis.total_citas, 5);
  assert.deepEqual(data.concurrencia_clientes.trafico_por_dia_semana[0], { dia_semana_num: 1, dia_semana_label: 'Lunes', total_citas: 5, no_show: 1, completadas: 3 });
  assert.deepEqual(data.concurrencia_clientes.horas_pico[0], { hora: 10, total_citas: 5, no_show: 1, completadas: 3 });
  assert.equal(data.filtros_aplicados.id_sucursal, A);
  for (const { sql, params } of calls.filter(({ sql }) => sql.includes('GROUP BY EXTRACT'))) {
    assert.ok(params.includes(A)); assert.match(sql, /c.id_sucursal = ANY/);
    assert.ok(params.includes('2026-10-01T06:00:00.000Z'));
    assert.ok(params.includes('2026-10-21T06:00:00.000Z'));
  }
  assert.equal(releases(), 1);
});
for (const format of ['csv', 'excel']) for (const type of ['concurrencia_dias', 'concurrencia_horas']) {
  test(`${format}/${type} conserva rango y datos del dashboard`, async (t) => {
    const { app } = await setup(t);
    const response = await app.inject(`/reportes/export/${format}?${range}&export_type=${type}`);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, type === 'concurrencia_dias' ? /Lunes/ : /hora/);
    assert.match(response.body, /total_citas/);
    assert.match(response.headers['content-disposition'], /2026-10-01_2026-10-20/);
  });
}
test('sin datos conserva colecciones vacías e indicadores cero', async (t) => {
  const { app } = await setup(t, true);
  const response = await app.inject(`/reportes/dashboard?${range}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.deepEqual(data.concurrencia_clientes.horas_pico, []);
  assert.deepEqual(data.concurrencia_clientes.trafico_por_dia_semana, []);
  assert.equal(data.kpis.total_citas, 0);
});
