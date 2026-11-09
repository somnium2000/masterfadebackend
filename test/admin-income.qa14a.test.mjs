import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/reportes.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const range = 'fecha_desde=2026-10-01&fecha_hasta=2026-10-20';
async function setup(t) {
  const queries = [];
  let released = 0;
  const query = async (sql, params = []) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
    queries.push({ sql, params });
    return { rows: /SELECT id_sucursal\s+FROM public\.sucursales/.test(sql) ? [{ id_sucursal: A }] : [] };
  };
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', (allowed) => async (request) => {
    assert.deepEqual(allowed, ['super_admin']);
    request.claims = { roles: ['super_admin'], branch_ids: [B] };
  });
  app.decorate('db', { query, connect: async () => ({ query, release: () => { released += 1; } }) });
  await app.register(routes, { prefix: '/reportes' });
  t.after(() => app.close());
  return { app, queries, released: () => released };
}
test('dashboard vacío conserva rango, sucursal y totales cero', async (t) => {
  const { app, queries, released } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}&id_sucursal=${A}`);
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(data.kpis.ingresos_totales_hnl, 0);
  assert.deepEqual(data.ventas_ingresos.ingresos_por_fecha, []);
  assert.equal(data.filtros_aplicados.id_sucursal, A);
  assert.equal(data.filtros_aplicados.fecha_desde, '2026-10-01');
  assert.ok(queries.some(({ params }) => params.includes(A)));
  assert.equal(released(), 1);
});
for (const format of ['csv', 'excel']) test(`export ${format} aplica el mismo rango y sucursal sin escrituras`, async (t) => {
  const { app, released } = await setup(t);
  const response = await app.inject(`/reportes/export/${format}?${range}&id_sucursal=${A}&export_type=resumen`);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-disposition'], /2026-10-01_2026-10-20/);
  assert.match(response.body, /ingresos_totales_hnl/);
  assert.equal(released(), 1);
});
test('sucursal no disponible rechazada antes de las consultas financieras', async (t) => {
  const { app, queries, released } = await setup(t);
  const response = await app.inject(`/reportes/dashboard?${range}&id_sucursal=${B}`);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'REPORTES_BRANCH_FORBIDDEN');
  assert.equal(queries.length, 1); assert.equal(released(), 1);
});
test('rango invertido rechazado antes de SQL', async (t) => {
  const { app, queries, released } = await setup(t);
  const response = await app.inject('/reportes/dashboard?fecha_desde=2026-10-20&fecha_hasta=2026-10-01');
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'REPORTES_DATE_RANGE_INVALID');
  assert.equal(queries.length, 0); assert.equal(released(), 1);
});

for (const invalidDate of ['2026-02-30', '2026-99-99', '2026-04-31', '2026-00-01', '2026-02-29']) {
  test(`fecha calendario invalida ${invalidDate} se rechaza antes de SQL`, async (t) => {
    const { app, queries, released } = await setup(t);
    const response = await app.inject(`/reportes/dashboard?fecha_desde=${invalidDate}&fecha_hasta=${invalidDate}`);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'REPORTES_DATE_INVALID');
    assert.equal(queries.length, 0);
    assert.equal(released(), 1);
  });
}

for (const validDate of ['2024-02-29', '2026-10-29']) {
  test(`fecha calendario valida ${validDate} conserva el flujo`, async (t) => {
    const { app, queries, released } = await setup(t);
    const response = await app.inject(`/reportes/dashboard?fecha_desde=${validDate}&fecha_hasta=${validDate}`);
    assert.equal(response.statusCode, 200);
    assert.ok(queries.length > 0);
    assert.equal(response.json().data.filtros_aplicados.fecha_desde, validDate);
    assert.equal(released(), 1);
  });
}
