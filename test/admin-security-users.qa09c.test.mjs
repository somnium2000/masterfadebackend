import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/seguridad.js';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '21111111-1111-4111-8111-111111111111';
async function fixture(t, role, options = {}) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql: sql.trim(), params });
    assert.doesNotMatch(sql, /(?:UPDATE|INSERT INTO|DELETE FROM) public\.roles(?:_usuarios)?\b/i);
    if (sql.includes('FROM public.app_protected_users')) {
      if (options.protectionFail) throw new Error('INTERNAL_SYNTHETIC');
      return { rows: [], rowCount: options.protected ? 1 : 0 };
    }
    if (sql.includes('AS is_super_admin')) return { rows: [{ id_usuario: options.self ? ACTOR : TARGET, estado_acceso: 'activo', is_super_admin: Boolean(options.superAdmin), is_critical_access: Boolean(options.critical) }] };
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: options.last ? 1 : 3 }] };
    if (/^SELECT/.test(sql.trim())) return { rows: [{ id_usuario: TARGET, nombres: 'SYNTHETIC', estado_acceso: 'activo', roles: ['cliente'] }] };
    if (options.fail && /UPDATE public.usuarios/.test(sql)) throw new Error('INTERNAL_SYNTHETIC');
    return { rows: [], rowCount: 1 };
  };
  const app = Fastify(); t.after(() => app.close());
  app.decorate('db', { query, connect: async () => ({ query, release() {} }) });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { roles: role ? [role] : [], user: { id_usuario: ACTOR } };
    if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
  });
  await app.register(routes, { prefix: '/v1/admin/seguridad' }); await app.ready();
  return { app, queries, change: state => app.inject({ method: 'PATCH', url: `/v1/admin/seguridad/usuarios/${options.self ? ACTOR : TARGET}/estado-acceso`, payload: { estado_acceso: state } }) };
}
for (const role of ['root','super_admin','security_admin','security_auditor']) test(`${role} puede consultar usuarios`, async t => {
  const { app, queries } = await fixture(t, role);
  const response = await app.inject('/v1/admin/seguridad/usuarios?q=SYNTHETIC&page=2&limit=20');
  assert.equal(response.statusCode, 200); assert.ok(queries.every(q => /^SELECT/.test(q.sql)));
});
for (const role of ['root','super_admin','security_admin']) {
  for (const state of ['bloqueado','activo']) test(`${role} cambia acceso a ${state} sin modificar roles`, async t => {
    const { change, queries } = await fixture(t, role);
    const response = await change(state); assert.equal(response.statusCode, 200);
    const update = queries.find(q => /UPDATE public.usuarios/.test(q.sql)); assert.deepEqual(update.params, [TARGET, state]);
    assert.ok(queries.some(q => q.sql === 'COMMIT')); assert.equal(response.json().data.estado_acceso, state);
  });
}
for (const role of ['security_auditor','admin','barbero','cliente',null]) test(`${role || 'anonimo'} no puede cambiar acceso`, async t => {
  const { change, queries } = await fixture(t, role); const response = await change('bloqueado');
  assert.equal(response.statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
});
for (const role of ['admin','barbero','cliente',null]) test(`${role || 'anonimo'} no puede listar`, async t => {
  const { app, queries } = await fixture(t, role); assert.equal((await app.inject('/v1/admin/seguridad/usuarios')).statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
});
for (const [name, options, state, status, code] of [
  ['root protegido', { protected: true }, 'bloqueado', 403, 'ROOT_USER_PROTECTED'],
  ['validación root fallida', { protectionFail: true }, 'bloqueado', 500, 'ROOT_USER_PROTECTION_CHECK_FAILED'],
  ['último superadmin', { superAdmin: true, last: true }, 'bloqueado', 409, 'SECURITY_LAST_SUPER_ADMIN_FORBIDDEN'],
  ['cuenta crítica propia', { self: true, critical: true }, 'inactivo', 409, 'SECURITY_SELF_CRITICAL_ACCESS_FORBIDDEN'],
]) test(`${name} rechaza sin escrituras de negocio`, async t => {
  const { change, queries } = await fixture(t, 'root', options); const response = await change(state);
  assert.equal(response.statusCode, status); assert.equal(response.json().error.code, code);
  assert.ok(queries.some(q => q.sql === 'ROLLBACK')); assert.ok(!queries.some(q => /^(UPDATE|INSERT)/.test(q.sql)));
});
test('fallo SQL revierte y no expone detalles internos', async t => {
  const { change, queries } = await fixture(t, 'root', { fail: true }); const response = await change('bloqueado');
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('INTERNAL_SYNTHETIC'));
  assert.ok(queries.some(q => q.sql === 'ROLLBACK')); assert.ok(!queries.some(q => q.sql === 'COMMIT'));
});
