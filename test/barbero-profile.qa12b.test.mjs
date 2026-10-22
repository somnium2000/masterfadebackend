import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/barbero.js';
const USER = '11111111-1111-4111-8111-111111111111';
const PERSON = '21111111-1111-4111-8111-111111111111';
const EMPLOYEE = '31111111-1111-4111-8111-111111111111';
async function fixture(t, role, { missing = false, fail = false } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql: sql.trim(), params });
    if (fail) throw new Error('SQL_INTERNAL_SYNTHETIC');
    if (sql.includes('FROM public.empleados e')) {
      assert.match(sql, /u.id_usuario = \$1::uuid/); assert.deepEqual(params, [USER]);
      return { rows: missing ? [] : [{ id_usuario: USER, id_persona: PERSON, id_empleado: EMPLOYEE, nombres: 'Sintético', es_barbero: true }] };
    }
    if (sql.includes('FROM public.citas c') || sql.includes('WITH active_tariffs')) assert.equal(params[0], EMPLOYEE);
    if (sql.includes('UPDATE public.personas')) { assert.equal(params[0], PERSON); assert.doesNotMatch(sql, /salario|id_sucursal|roles/); }
    return { rows: [], rowCount: 1 };
  };
  const app = Fastify(); t.after(() => app.close()); app.decorate('db', { query, connect: async () => ({ query, release() {} }) });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { roles: role ? [role] : [], user: { id_usuario: USER } };
    if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
  });
  await app.register(routes, { prefix: '/v1/barbero' }); return { app, queries };
}
for (const role of ['barbero','admin','super_admin']) {
  for (const method of ['GET','PATCH']) test(`${role} ${method} perfil propio por claims`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method, url: '/v1/barbero/perfil', ...(method === 'PATCH' ? { payload: { telefono_principal: '99999999' } } : {}) });
    assert.equal(response.statusCode, 200);
    if (method === 'GET') assert.ok(queries.every(q => /^SELECT|^WITH/.test(q.sql)));
    else assert.ok(queries.some(q => q.sql === 'COMMIT'));
  });
}
for (const role of ['cliente','security_auditor',null]) {
  for (const method of ['GET','PATCH']) test(`${role || 'anonimo'} rechazado ${method}`, async t => {
    const { app, queries } = await fixture(t, role);
    const response = await app.inject({ method, url: '/v1/barbero/perfil', ...(method === 'PATCH' ? { payload: { telefono_principal: '99999999' } } : {}) });
    assert.equal(response.statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
  });
}
test('perfil inexistente devuelve 404 sin actualizaciones', async t => {
  const { app, queries } = await fixture(t, 'barbero', { missing: true });
  assert.equal((await app.inject('/v1/barbero/perfil')).statusCode, 404); assert.ok(queries.every(q => /^SELECT/.test(q.sql)));
});
test('error técnico no se expone', async t => {
  const { app } = await fixture(t, 'barbero', { fail: true }); const response = await app.inject('/v1/barbero/perfil');
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('SQL_INTERNAL_SYNTHETIC'));
});
