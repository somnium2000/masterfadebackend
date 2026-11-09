import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import security from '../src/plugins/security.js';
import {
  pixelPayStatusTransportOnRequest,
  pixelPayStatusTransportOnResponse,
} from '../src/services/payments/pixelPayStatusTransport.js';

async function createSecurityApp(logs = null, statusHandlerCalls = null) {
  const app = Fastify({
    logger: logs
      ? { level: 'trace', stream: { write: (message) => logs.push(message) } }
      : false,
  });
  app.decorate('config', {
    corsOrigins: ['http://localhost:5173'],
    cookieSecret: 'synthetic-cookie-secret-at-least-32-chars',
    isProduction: false,
  });
  await app.register(security);
  const transportHooks = {
    onRequest: pixelPayStatusTransportOnRequest,
    onResponse: pixelPayStatusTransportOnResponse,
  };
  const statusHandler = async () => {
    if (statusHandlerCalls) statusHandlerCalls.count += 1;
    return { ok: true };
  };
  app.post('/v1/public/pagos/pixelpay/status', transportHooks, statusHandler);
  app.post('/v1/pagos/reservas/pixelpay/status', transportHooks, statusHandler);
  app.post('/v1/cliente/contract-only', async () => ({ ok: true }));
  app.post('/v1/admin/contract-only', async () => ({ ok: true }));
  return app;
}

test('CSRF-A: ruta Status publica con mf_session no exige token CSRF', async (t) => {
  const app = await createSecurityApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/pagos/pixelpay/status',
    headers: { cookie: 'mf_session=synthetic-session' },
    payload: {},
  });
  assert.notEqual(response.statusCode, 403, response.body);
  assert.notEqual(response.json()?.error?.code, 'CSRF_TOKEN_INVALID');
});

test('CSRF-B: ruta Status autenticada conserva la proteccion CSRF', async (t) => {
  const logs = [];
  const statusHandlerCalls = { count: 0 };
  const app = await createSecurityApp(logs, statusHandlerCalls);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/pagos/reservas/pixelpay/status',
    headers: { cookie: 'mf_session=synthetic-session' },
    payload: {},
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, 'CSRF_TOKEN_INVALID');
  const entries = logs.map((entry) => JSON.parse(entry));
  const received = entries.find((entry) => entry.event === 'pixelpay_status_transport_received');
  const completed = entries.find((entry) => entry.event === 'pixelpay_status_transport_completed');
  assert.ok(received);
  assert.equal(completed?.http_status, 403);
  assert.equal(completed?.client_request_id, received.client_request_id);
  assert.equal(statusHandlerCalls.count, 0);
});

test('CSRF-C: ruta privada con cookie y header CSRF coincidentes funciona', async (t) => {
  const app = await createSecurityApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/cliente/contract-only',
    headers: {
      cookie: 'mf_session=synthetic-session; mf_csrf=synthetic-token',
      'x-csrf-token': 'synthetic-token',
    },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
});

for (const privatePath of ['/v1/cliente/contract-only', '/v1/admin/contract-only']) {
  test(`CSRF-C2: ${privatePath} conserva rechazo sin token`, async (t) => {
    const app = await createSecurityApp();
    t.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: privatePath,
      headers: { cookie: 'mf_session=synthetic-session' },
      payload: {},
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, 'CSRF_TOKEN_INVALID');
  });
}

test('CSRF-D: login permanece exento', async (t) => {
  const app = await createSecurityApp();
  t.after(() => app.close());
  app.post('/v1/auth/login', async () => ({ ok: true }));
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { cookie: 'mf_session=synthetic-session' },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
});

test('429 conserva correlacion de transporte sin invocar el handler', async (t) => {
  const previousMax = process.env.RATE_LIMIT_MAX;
  process.env.RATE_LIMIT_MAX = '1';
  t.after(() => {
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
  const logs = [];
  const statusHandlerCalls = { count: 0 };
  const app = await createSecurityApp(logs, statusHandlerCalls);
  t.after(() => app.close());
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  await app.inject({
    method: 'POST',
    url: '/v1/public/pagos/pixelpay/status',
    headers: { 'x-request-id': 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
    payload: {},
  });
  assert.equal(statusHandlerCalls.count, 1);
  logs.length = 0;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/public/pagos/pixelpay/status',
    headers: { 'x-request-id': requestId },
    payload: {},
  });

  const entries = logs.map((entry) => JSON.parse(entry));
  const received = entries.find((entry) => entry.event === 'pixelpay_status_transport_received');
  const completed = entries.find((entry) => entry.event === 'pixelpay_status_transport_completed');
  assert.equal(received?.client_request_id, requestId);
  assert.equal(completed?.client_request_id, requestId);
  assert.equal(completed?.http_status, 429);
  assert.equal(response.headers['x-request-id'], requestId);
  assert.equal(response.statusCode, 429, response.body);
  assert.equal(statusHandlerCalls.count, 1);
});
