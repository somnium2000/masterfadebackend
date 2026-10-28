import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/configuracion.js';
const ID = '11111111-1111-4111-8111-111111111111';
process.env.COMMUNICATION_SCHEDULER_ENABLED = 'false';
for (const role of ['cliente','barbero','security_auditor',null]) {
  for (const path of ['',`/${ID}`,`/${ID}/elegibilidad`,`/${ID}/envios`]) test(`${role || 'anonimo'} no consulta comunicación ${path || 'lista'}`, async t => {
    const app = Fastify(); t.after(() => app.close());
    app.decorate('requireRoles', allowed => async (request, reply) => {
      request.claims = { roles: role ? [role] : [] };
      if (!role) return reply.code(401).send({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Autenticación requerida' }, requestId: request.id });
      if (!allowed.includes(role)) return reply.code(403).send({ ok: false, error: { code: 'AUTH_FORBIDDEN', message: 'Acceso denegado' }, requestId: request.id });
    });
    // AM: Sin DB, SMTP ni scheduler; una autorización inesperada hará fallar la prueba.
    await app.register(routes, { prefix: '/v1/admin/configuracion' });
    const response = await app.inject(`/v1/admin/configuracion/comunicacion/campanias${path}`);
    assert.equal(response.statusCode, role ? 403 : 401);
  });
}
