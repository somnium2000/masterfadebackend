import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/seguridad.js';

const ID = '11111111-1111-4111-8111-111111111111';
async function fixture(t, role, { fail = false, missing = false } = {}) {
  const queries = [];
  const row = { id_login_log: ID, resultado: 'failed', email_masked: 's***@example.test', ip: '192.0.2.4',
    created_at: '2026-10-20T12:00:00Z', metadata: { reason: 'synthetic', token: 'SYNTHETIC_SECRET', nested: { jwt: 'SYNTHETIC_SECRET', safe: true } } };
  const app = Fastify(); t.after(() => app.close());
  app.decorate('db', { query: async (sql, params) => {
    queries.push({ sql, params }); assert.match(sql.trim(), /^SELECT/i);
    if (fail) throw new Error('SQL_INTERNAL_SYNTHETIC');
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 41 }] };
    return { rows: missing ? [] : [row] };
  } });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { roles: role ? [role] : [] };
    if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
  });
  await app.register(routes, { prefix: '/v1/admin/seguridad' }); await app.ready();
  return { app, queries };
}

for (const role of ['root', 'super_admin', 'security_admin', 'security_auditor']) {
  for (const suffix of ['', `/${ID}`]) test(`${role} puede leer login logs ${suffix || 'lista'}`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method: 'GET', url: `/v1/admin/seguridad/login-logs${suffix}` });
    assert.equal(response.statusCode, 200); assert.ok(queries.length);
    assert.ok(!response.body.includes('SYNTHETIC_SECRET'));
    if (suffix) {
      const data = response.json().data;
      if (role === 'security_auditor') { assert.equal(data.metadata, undefined); assert.notEqual(data.ip, '192.0.2.4'); }
      else { assert.equal(data.metadata.reason, 'synthetic'); assert.deepEqual(data.metadata.nested, { safe: true }); }
    }
  });
}
for (const role of ['admin', 'barbero', 'cliente', null]) {
  for (const suffix of ['', `/${ID}`]) test(`${role || 'anonimo'} rechazado antes de consultar ${suffix || 'lista'}`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method: 'GET', url: `/v1/admin/seguridad/login-logs${suffix}` });
    assert.equal(response.statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
  });
}
test('filtros, orden y paginación usan parámetros y solo lecturas', async t => {
  const { app, queries } = await fixture(t, 'root');
  const response = await app.inject({ method: 'GET', url: '/v1/admin/seguridad/login-logs?page=2&limit=20&resultado=failed&provider=google&sort_by=provider&sort_dir=asc' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(queries[1].params, ['failed', 'google', 20, 20]);
  assert.match(queries[1].sql, /ORDER BY ll.provider ASC/);
  assert.equal(response.json().data.pagination.total_pages, 3);
});
test('UUID inválido rechazado sin SQL y detalle inexistente devuelve 404', async t => {
  const { app, queries } = await fixture(t, 'root', { missing: true });
  assert.equal((await app.inject('/v1/admin/seguridad/login-logs/invalid')).statusCode, 400); assert.equal(queries.length, 0);
  assert.equal((await app.inject(`/v1/admin/seguridad/login-logs/${ID}`)).statusCode, 404);
});
test('error SQL devuelve mensaje controlado sin información interna', async t => {
  const { app } = await fixture(t, 'root', { fail: true });
  for (const suffix of ['', `/${ID}`]) {
    const response = await app.inject(`/v1/admin/seguridad/login-logs${suffix}`);
    assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('SQL_INTERNAL_SYNTHETIC'));
  }
});
