import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHostedSandboxProbeCases, sanitizeHostedProbeResponse, runHostedSandboxDiagnostic } from '../scripts/pixelpay-hosted-sandbox-diagnostic.mjs';

test('Diagnostico no confunde server Cloudflare con un challenge demostrado', () => {
  const result = sanitizeHostedProbeResponse({ status: 403, headers: new Headers({ server: 'cloudflare', 'set-cookie': 'sensitive=hidden' }), body: '<h1>Forbidden</h1>' });
  assert.equal(result.signals.edgeChallenge, false);
  assert.equal(result.signals.cloudflareChallengeMarkup, false);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
test('Challenge y modulo no disponible se registran como evidencias diferentes', () => {
  const challenge = sanitizeHostedProbeResponse({ status: 403, headers: new Headers({ 'cf-mitigated': 'challenge' }), body: '<title>Just a moment...</title>' });
  assert.equal(challenge.signals.edgeChallenge, true);
  const module = sanitizeHostedProbeResponse({ status: 404, headers: new Headers(), body: '<h1>El módulo de pago sandbox no existe</h1>' });
  assert.equal(module.signals.sandboxModuleUnavailable, true);
  assert.equal(module.signals.edgeChallenge, false);
  const jsonModule = sanitizeHostedProbeResponse({ status: 500, headers: new Headers({ 'content-type': 'application/json' }),
    body: '{"success":false,"message":"El m\\u00f3dulo de pago sandbox no existe"}' });
  assert.equal(jsonModule.signals.sandboxModuleUnavailable, true);
  assert.equal(jsonModule.signals.jsonResponse, true);
});
test('Matriz acotada solo consulta Hosted Sandbox con datos ficticios y sin tarjetas/callback', () => {
  for (const item of buildHostedSandboxProbeCases()) {
    assert.ok(['https://pixelpay.app', 'https://pixelpay.dev'].includes(item.origin));
    assert.equal(item.params.has('_callback'), false);
    assert.equal(item.params.get('_email'), 'sandbox@example.invalid');
    assert.equal([...item.params.keys()].some(name => /card|cvv|pan|token/i.test(name)), false);
  }
});
test('Transporte no sigue redirects ni registra firmas, cuerpos o query values', async () => {
  const result = await runHostedSandboxDiagnostic({ fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/v2/transaction/hosted/sandbox');
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ success: true, url: 'https://pixelpay.app/sandbox/token/checkout/example?payload=hidden-signature' }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(result.results.length, 6);
  assert.equal(JSON.stringify(result).includes('hidden-signature'), false);
  assert.ok(result.results.every(item => item.response.signals.success));
});
