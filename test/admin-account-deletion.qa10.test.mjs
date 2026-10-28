import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/accountDeletion.js';
const ID = '11111111-1111-4111-8111-111111111111';
for (const role of ['cliente','barbero',null]) {
  for (const action of ['list','detail','approve','reject','retry']) test(`${role || 'anonimo'} no ejecuta ${action}`, async t => {
    const app = Fastify(); t.after(() => app.close());
    app.decorate('requireRoles', allowed => async (request, reply) => {
      request.claims = { roles: role ? [role] : [] };
      if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
      if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
    });
    // AM: Ningún ejecutor ni conexión de eliminación está disponible en esta prueba.
    await app.register(routes, { prefix: '/v1/admin/account-deletion' });
    const read = action === 'list' || action === 'detail';
    const payload = action === 'approve' ? { reauth_token: 'SYNTHETIC_NOT_A_REAL_TOKEN', confirmation_phrase: 'APROBAR ELIMINACION DE CUENTA', acknowledge_irreversible_action: true } : action === 'reject' ? { comment: 'Motivo sintético válido' } : undefined;
    const response = await app.inject({ method: read ? 'GET' : 'POST', url: `/v1/admin/account-deletion/requests${action === 'list' ? '' : `/${ID}${read ? '' : `/${action}`}`}`, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, role ? 403 : 401);
  });
}
test('aprobación sin reautenticación se rechaza por esquema antes del ejecutor', async t => {
  const app = Fastify(); t.after(() => app.close()); app.decorate('requireRoles', () => async request => { request.claims = { roles: ['root'] }; });
  await app.register(routes, { prefix: '/v1/admin/account-deletion' });
  const response = await app.inject({ method: 'POST', url: `/v1/admin/account-deletion/requests/${ID}/approve`, payload: { confirmation_phrase: 'APROBAR ELIMINACION DE CUENTA', acknowledge_irreversible_action: true } });
  assert.equal(response.statusCode, 400);
});
