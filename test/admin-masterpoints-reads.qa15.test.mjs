import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

// Solo servicios ficticios: nunca se importan cálculos, materializaciones ni escrituras.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let calls = [], fail = false;
const read = (name, result) => async (...args) => {
  calls.push({ name, args });
  if (fail) throw new Error('SQL INTERNAL SECRET');
  return typeof result === 'function' ? result(...args) : result;
};
const forbiddenWrite = () => { throw new Error('WRITE_SERVICE_MUST_NOT_RUN'); };
const pointsServices = {
  addManualPointsAdjustment: forbiddenWrite,
  searchActiveClientesForAdminPoints: read('search', { clientes: [{ id_cliente: A, nombre_cliente: 'Sintético A', correo: null, telefono: null, id_usuario: null }] }),
  getClientePointsSummary: read('summary', (_app, id) => ({ id_cliente: id, saldo_total: id === A ? 7 : 2, puntos_titular: 5, puntos_integrante: 2, puntos_para_premio: 10, progreso_actual: 7, historial: [] })),
};
const masterServices = {
  getMasterPuntosRewardServicesConfig: read('config', { regla: { puntos_para_premio: 10 }, servicios_catalogo: [], configuracion: { sin_membresia: [], con_membresia: [] } }),
  updateMasterPuntosRewardServicesConfig: forbiddenWrite,
  getMasterPuntosContext: read('context', { sucursales: [], servicios_catalogo: [] }),
  listMasterPuntosClientes: read('clients', { clientes: [], meta: { page: 1, limit: 2, total: 0 } }),
  getMasterPuntosClienteMovimientos: read('movements', { movimientos: [], meta: { page: 1, limit: 2, total: 0 } }),
  updateMasterPuntosRegla: forbiddenWrite, createMasterPuntosCanje: forbiddenWrite, createMasterPuntosLegacyMigration: forbiddenWrite,
};
// Dobles ESM en memoria: Node estándar, sin flags experimentales ni cambios de manifiestos.
const servicesKey = '__mfMasterpointsReadOnlyQa15';
globalThis[servicesKey] = { pointsServices, masterServices };
after(() => { delete globalThis[servicesKey]; });
const doubles = (name, services) => 'data:text/javascript,' + encodeURIComponent(Object.keys(services)
  .map((key) => `export const ${key} = (...args) => globalThis[${JSON.stringify(servicesKey)}].${name}.${key}(...args);`).join('\n'));
async function loadRoutes(path) {
  const url = new URL(path, import.meta.url);
  const source = readFileSync(url, 'utf8').replace(/from "([^"]+)"/g, (_match, specifier) => {
    const target = specifier.endsWith('/pointsService.js') ? doubles('pointsServices', pointsServices)
      : specifier.endsWith('/masterPuntosService.js') ? doubles('masterServices', masterServices)
        : new URL(specifier, url).href;
    return `from ${JSON.stringify(target)}`;
  });
  return (await import('data:text/javascript,' + encodeURIComponent(source))).default;
}
const points = await loadRoutes('../src/routes/v1/admin/puntos.js');
const master = await loadRoutes('../src/routes/v1/admin/masterpuntos.js');
const endpoints = ['/puntos/regalias', '/puntos/clientes/buscar?q=Sintetico&limit=2', `/puntos/clientes/${A}/resumen`, '/master/contexto', '/master/clientes?page=1&limit=2', `/master/clientes/${A}/movimientos?page=1&limit=2`];
async function setup(t, roles) {
  calls = []; fail = false;
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', (allowed) => async (request, reply) => {
    assert.deepEqual(allowed, ['admin', 'super_admin']);
    if (!roles) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
    request.claims = { roles, user: { id_usuario: B }, branch_ids: [A] };
  });
  const noDatabase = () => { throw new Error('DATABASE_MUST_NOT_RUN'); };
  app.decorate('db', { query: noDatabase, connect: noDatabase });
  await app.register(points, { prefix: '/puntos' }); await app.register(master, { prefix: '/master' });
  t.after(() => app.close()); return app;
}
for (const roles of [['admin'], ['super_admin'], ['admin', 'super_admin'], ['barbero'], ['cliente'], ['security_auditor'], null]) {
  for (const endpoint of endpoints) test(`${roles?.join('+') || 'anónimo'} GET ${endpoint}`, async (t) => {
    const app = await setup(t, roles);
    const allowed = roles?.some((role) => ['admin', 'super_admin'].includes(role));
    const response = await app.inject({ method: 'GET', url: endpoint });
    assert.equal(response.statusCode, allowed ? 200 : roles ? 403 : 401);
    assert.equal(calls.length, allowed ? 1 : 0);
    if (allowed && endpoint.startsWith('/master/')) assert.deepEqual(calls[0].args[1].branch_ids, [A]);
  });
}
for (const endpoint of endpoints) test(`error seguro en GET ${endpoint}`, async (t) => {
  const app = await setup(t, ['admin']); fail = true;
  const response = await app.inject({ method: 'GET', url: endpoint });
  assert.equal(response.statusCode, 500); assert.doesNotMatch(response.body, /SQL|INTERNAL|SECRET/);
});
test('resúmenes conservan exclusivamente el identificador solicitado y valores del servicio', async (t) => {
  const app = await setup(t, ['admin']);
  for (const [id, balance] of [[A, 7], [B, 2]]) {
    const response = await app.inject({ method: 'GET', url: `/puntos/clientes/${id}/resumen` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.id_cliente, id); assert.equal(response.json().data.saldo_total, balance);
    assert.equal(calls.at(-1).args[1], id);
  }
});
test('identificador inválido rechazado antes de servicios de consulta', async (t) => {
  const app = await setup(t, ['admin']);
  for (const endpoint of ['/puntos/clientes/invalid/resumen', '/master/clientes/invalid/movimientos']) {
    const response = await app.inject({ method: 'GET', url: endpoint }); assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('rutas de búsqueda, resumen y ajuste pasan claims completos al servicio', async (t) => {
  const originalAdjustment = pointsServices.addManualPointsAdjustment;
  pointsServices.addManualPointsAdjustment = read('adjustment', { id_points_tx: A, id_cliente: A, saldo_actual: 5 });
  t.after(() => { pointsServices.addManualPointsAdjustment = originalAdjustment; });
  const app = await setup(t, ['admin']);
  await app.inject('/puntos/clientes/buscar?q=Sintetico');
  await app.inject(`/puntos/clientes/${A}/resumen`);
  const adjustment = await app.inject({
    method: 'POST',
    url: `/puntos/clientes/${A}/ajuste`,
    headers: { 'x-idempotency-key': '99999999-9999-4999-8999-999999999999' },
    payload: { accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético' },
  });
  assert.equal(adjustment.statusCode, 200);
  assert.deepEqual(calls.find(({ name }) => name === 'search').args[1].claims.branch_ids, [A]);
  assert.deepEqual(calls.find(({ name }) => name === 'summary').args[2].claims.branch_ids, [A]);
  assert.deepEqual(calls.find(({ name }) => name === 'adjustment').args[1].claims.branch_ids, [A]);
  assert.equal(calls.find(({ name }) => name === 'adjustment').args[1].idempotencyKey, '99999999-9999-4999-8999-999999999999');
});

for (const role of ['cliente', 'barbero']) test(`${role} no puede invocar ajuste administrativo`, async (t) => {
  const app = await setup(t, [role]);
  const response = await app.inject({
    method: 'POST',
    url: `/puntos/clientes/${A}/ajuste`,
    headers: { 'x-idempotency-key': '99999999-9999-4999-8999-999999999999' },
    payload: { accion: 'sumar', puntos: 5, motivo: 'Ajuste sintético' },
  });
  assert.equal(response.statusCode, 403); assert.equal(calls.length, 0);
});

test('búsqueda real con DB simulada conserva filtros de clientes y usuarios activos', async () => {
  const { searchActiveClientesForAdminPoints } = await import('../src/services/pointsService.js?qa15-readonly');
  let queried = false;
  const result = await searchActiveClientesForAdminPoints({ db: { query: async (sql, params) => {
    queried = true; assert.match(sql.trim(), /^SELECT/);
    if (sql.includes('FROM public.sucursales')) return { rows: [{ id_sucursal: A }] };
    assert.match(sql, /c.deleted_at IS NULL/); assert.match(sql, /COALESCE\(c.estado, TRUE\) IS TRUE/);
    assert.match(sql, /COALESCE\(u.estado, TRUE\) IS TRUE/);
    assert.match(sql, /estado_acceso.*NOT IN \('bloqueado', 'inactivo'\)/);
    assert.match(sql, /c.id_sucursal_origen = ANY\(\$3::uuid\[\]\)/);
    assert.deepEqual(params, ['%sintético%', 'sintético%', [A], false, 20]);
    return { rows: [{ id_cliente: A, nombre_cliente: 'Sintético A', id_usuario: B }] };
  } } }, { q: ' Sintético ', limit: 999, claims: { roles: ['admin'], branch_ids: [A] } });
  assert.equal(queried, true); assert.equal(result.clientes[0].id_cliente, A);
});
test('búsqueda corta no consulta DB y la longitud excesiva se rechaza', async () => {
  const { searchActiveClientesForAdminPoints } = await import('../src/services/pointsService.js?qa15-readonly');
  const app = { db: { query: () => { throw new Error('DB_MUST_NOT_RUN'); } } };
  assert.deepEqual(await searchActiveClientesForAdminPoints(app, { q: 'A' }), { clientes: [] });
  await assert.rejects(searchActiveClientesForAdminPoints(app, { q: 'A'.repeat(81) }), { statusCode: 400 });
});
