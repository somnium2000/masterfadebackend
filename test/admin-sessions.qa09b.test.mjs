import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/seguridad.js';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const CURRENT = '21111111-1111-4111-8111-111111111111';
const TARGET = '31111111-1111-4111-8111-111111111111';
async function fixture(t, role, { sid = CURRENT, fail = false } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql: sql.trim(), params });
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 41 }] };
    if (/UPDATE public.seguridad_sesiones/i.test(sql)) {
      if (fail) throw new Error('SQL_INTERNAL_SYNTHETIC');
      return { rowCount: 1, rows: [{ id_sesion: TARGET, id_usuario: ACTOR }] };
    }
    if (/^SELECT/i.test(sql.trim())) return { rows: [{ id_sesion: CURRENT, id_usuario: ACTOR, estado: 'activa',
      ip_inicio: '192.0.2.4', metadata: { token: 'SYNTHETIC_SECRET', safe: true } }] };
    return { rows: [], rowCount: 1 };
  };
  const app = Fastify(); t.after(() => app.close());
  app.decorate('db', { query, connect: async () => ({ query, release() {} }) });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { roles: role ? [role] : [], user: { id_usuario: ACTOR } }; request.user = { sid };
    if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
  });
  await app.register(routes, { prefix: '/v1/admin/seguridad' }); await app.ready(); return { app, queries };
}
for (const role of ['root', 'super_admin', 'security_admin', 'security_auditor']) {
  for (const suffix of ['', `/${TARGET}`]) test(`${role} lectura sesiones ${suffix || 'lista'}`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject(`/v1/admin/seguridad/sesiones${suffix}`);
    assert.equal(response.statusCode, 200); assert.ok(queries.every(q => /^SELECT/.test(q.sql)));
    assert.ok(!response.body.includes('SYNTHETIC_SECRET'));
    if (!suffix) assert.equal(response.json().data.items[0].is_current_session, true);
  });
}
for (const role of ['root', 'super_admin', 'security_admin']) {
  for (const bulk of [false, true]) test(`${role} revocación ${bulk ? 'masiva' : 'individual'} con mocks`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method: 'POST', url: `/v1/admin/seguridad/sesiones/${bulk ? 'revocar-todas' : `${TARGET}/revocar`}` });
    assert.equal(response.statusCode, 200);
    const update = queries.find(q => /^UPDATE/.test(q.sql)); assert.ok(update);
    if (bulk) {
      assert.match(update.sql, /id_sesion <> \$2::uuid/); assert.equal(update.params[1], CURRENT);
      assert.equal(response.json().data.excluded_current_session, true);
      assert.ok(queries.some(q => q.sql === 'COMMIT'));
    } else assert.equal(update.params[0], TARGET);
  });
}
for (const role of ['security_auditor', 'admin', 'barbero', 'cliente', null]) {
  for (const bulk of [false, true]) test(`${role || 'anonimo'} no revoca ${bulk ? 'masivo' : 'individual'}`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method: 'POST', url: `/v1/admin/seguridad/sesiones/${bulk ? 'revocar-todas' : `${TARGET}/revocar`}` });
    assert.equal(response.statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
  });
}
test('sesión propia rechazada antes de cualquier escritura', async t => {
  const { app, queries } = await fixture(t, 'root');
  const response = await app.inject({ method: 'POST', url: `/v1/admin/seguridad/sesiones/${CURRENT}/revocar` });
  assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'SECURITY_SESSION_REVOKE_SELF_FORBIDDEN'); assert.equal(queries.length, 0);
});
test('sin sesión actual no realiza revocación masiva', async t => {
  const { app, queries } = await fixture(t, 'root', { sid: null });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/seguridad/sesiones/revocar-todas' })).statusCode, 400);
  assert.equal(queries.length, 0);
});
test('error masivo hace rollback y no expone mensaje SQL', async t => {
  const { app, queries } = await fixture(t, 'root', { fail: true });
  const response = await app.inject({ method: 'POST', url: '/v1/admin/seguridad/sesiones/revocar-todas' });
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('SQL_INTERNAL_SYNTHETIC'));
  assert.ok(queries.some(q => q.sql === 'ROLLBACK')); assert.ok(!queries.some(q => q.sql === 'COMMIT'));
});
