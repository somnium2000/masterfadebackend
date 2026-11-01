import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/seguridad.js';
const ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '21111111-1111-4111-8111-111111111111';
async function fixture(t, role, { missing = false, fail = false } = {}) {
  const queries = [];
  const app = Fastify(); t.after(() => app.close());
  app.decorate('db', { query: async (sql, params) => {
    queries.push({ sql: sql.trim(), params }); assert.doesNotMatch(sql, /\bDELETE\b/i);
    if (fail) throw new Error('SQL_INTERNAL_SYNTHETIC');
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 41 }] };
    if (/UPDATE public.seguridad_alertas/.test(sql)) return { rowCount: missing ? 0 : 1, rows: missing ? [] : [{ id_alerta: ID, estado: params[1], comentario_resolucion: params[3] }] };
    return { rowCount: 1, rows: missing ? [] : [{ id_alerta: ID, estado: 'abierta', resumen: 'SYNTHETIC', detalle: { token: 'SYNTHETIC_SECRET', safe: true } }] };
  } });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    const roles = Array.isArray(role) ? role : role ? [role] : [];
    request.claims = { roles, user: { id_usuario: ACTOR } };
    if (!roles.length) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
    if (!allowed.some(item => roles.includes(item))) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
  });
  await app.register(routes, { prefix: '/v1/admin/seguridad' }); await app.ready();
  return { app, queries, change: (estado = 'resuelta', comentario = 'Comentario sintético') => app.inject({ method: 'PATCH', url: `/v1/admin/seguridad/alertas/${ID}/estado`, payload: { estado, comentario } }) };
}
for (const role of ['super_admin','security_admin','security_auditor','admin','barbero','cliente',null]) {
  for (const route of ['list','detail','update']) test(`${role || 'anonimo'} rechazado en alertas ${route}`, async t => {
    const { app, change, queries } = await fixture(t, role);
    const response = route === 'update' ? await change() : await app.inject(`/v1/admin/seguridad/alertas${route === 'detail' ? `/${ID}` : ''}`);
    assert.equal(response.statusCode, role ? 403 : 401); assert.equal(queries.length, 0);
  });
}
test('Root lista y filtra alertas con paginación sin escrituras', async t => {
  const { app, queries } = await fixture(t, 'root');
  const response = await app.inject('/v1/admin/seguridad/alertas?estado=abierta&severidad=alta&page=2&limit=20');
  assert.equal(response.statusCode, 200); assert.ok(queries.every(q => /^SELECT/.test(q.sql)));
  assert.equal(response.json().data.pagination.page, 2); assert.equal(response.json().data.pagination.total_pages, 3);
});
test('Root consulta detalle con tokens redactados', async t => {
  const { app } = await fixture(t, 'root'); const response = await app.inject(`/v1/admin/seguridad/alertas/${ID}`);
  assert.equal(response.statusCode, 200); assert.ok(!response.body.includes('SYNTHETIC_SECRET')); assert.equal(response.json().data.detalle.safe, true);
});
test('alertas multirrol requieren root aunque existan otros roles administrativos', async t => {
  const allowed = await fixture(t, ['root', 'security_admin', 'cliente']);
  assert.equal((await allowed.app.inject('/v1/admin/seguridad/alertas')).statusCode, 200);

  const denied = await fixture(t, ['super_admin', 'security_admin', 'admin']);
  assert.equal((await denied.app.inject('/v1/admin/seguridad/alertas')).statusCode, 403);
  assert.equal(denied.queries.length, 0);
});
for (const state of ['resuelta','descartada']) test(`Root ${state} conserva comentario y auditoría sin borrar histórico`, async t => {
  const { change, queries } = await fixture(t, 'root'); const response = await change(state);
  assert.equal(response.statusCode, 200); const update = queries.find(q => /^UPDATE/.test(q.sql));
  assert.deepEqual(update.params, [ID, state, ACTOR, 'Comentario sintético']);
  assert.ok(queries.some(q => /INSERT INTO public.seguridad_audit_logs/.test(q.sql)));
});
test('comentario vacío y estado no permitido se rechazan sin actualizar', async t => {
  const { change, queries } = await fixture(t, 'root');
  assert.equal((await change('resuelta', '   ')).statusCode, 400);
  assert.equal((await change('abierta')).statusCode, 400); assert.ok(!queries.some(q => /^UPDATE/.test(q.sql)));
});
test('alerta inexistente devuelve 404', async t => {
  const { change } = await fixture(t, 'root', { missing: true }); assert.equal((await change()).statusCode, 404);
});
test('fallo SQL no expone información técnica', async t => {
  const { change } = await fixture(t, 'root', { fail: true }); const response = await change();
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('SQL_INTERNAL_SYNTHETIC'));
});
