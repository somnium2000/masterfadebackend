import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLive3dsDirectConfig, assertLive3dsFreshIntent,
  LIVE_3DS_TEST_WINDOW_MS, LIVE_3DS_MAX_AMOUNT_HNL } from '../src/experimental/pixelpayDelegated/liveConfig.js';
import { createQaDelegatedAttempts } from '../src/experimental/pixelpayDelegated/qaAttempts.js';

const ID = '11111111-1111-4111-8111-111111111111';
const privateAccess = { enabled: false, qaCapabilities: false, userIds: [ID], ips: ['198.51.100.10'] };
const env = { PIXELPAY_LIVE_3DS_TEST_ENABLED: 'true', NODE_ENV: 'production', ENTORNO: 'production',
  PAYMENT_PROVIDER: 'pixelpay', PIXELPAY_IMPLEMENTATION: 'sdk', PIXELPAY_ENV: 'live',
  PIXELPAY_ENDPOINT: 'https://pixelpay.app', PIXELPAY_APP_URL: 'https://pixelpay.app',
  PUBLIC_BOOKING_ENABLED: 'false', PUBLIC_VIP_PURCHASE_ENABLED: 'false',
  PRIVATE_COMMERCE_PILOT_ENABLED: 'false' };
const now = Date.parse('2026-11-19T23:10:00Z');
const freshIntent = { id_intent: ID, estado_intent_codigo: 'link_generado',
  created_at: new Date(now + 1000), monto_hnl: 200, moneda_codigo: 'HNL',
  orden_compra: 'MF-PIXELPAY-11111111111141118111111111111111',
  provider_session_id: null, referencia_externa: null, link_pago_url: null };

test('Live flag off has no Live session and requires no extra setup', () => {
  assert.equal(resolveLive3dsDirectConfig({}, privateAccess), null);
  assert.equal(resolveLive3dsDirectConfig({ ...env, PIXELPAY_LIVE_3DS_TEST_ENABLED: 'false' },
    privateAccess), null);
});

test('Live requires private IP/account plus Live SDK; public booking and QA stay blocked', () => {
  const config = resolveLive3dsDirectConfig(env, privateAccess, { now });
  assert.equal(config.liveTest, true);
  assert.equal(config.until - config.since, LIVE_3DS_TEST_WINDOW_MS);
  for (const [badEnv, badPrivate] of [
    [{ ...env, PIXELPAY_ENV: 'sandbox' }, privateAccess],
    [{ ...env, NODE_ENV: 'development' }, privateAccess],
    [{ ...env, PUBLIC_BOOKING_ENABLED: 'true' }, privateAccess],
    [{ ...env, PUBLIC_VIP_PURCHASE_ENABLED: 'true' }, privateAccess],
    [{ ...env, PRIVATE_COMMERCE_PILOT_ENABLED: 'true' }, privateAccess],
    [{ ...env, PIXELPAY_ENDPOINT: 'https://pixelpay.dev' }, privateAccess],
    [{ ...env, PIXELPAY_LIVE_3DS_TEST_ENABLED: 'true', QA_PIXELPAY_DELEGATED_ENABLED: 'true' }, privateAccess],
    [env, { ...privateAccess, enabled: true }],
    [env, { ...privateAccess, userIds: [ID, ID] }],
    [env, { ...privateAccess, ips: [] }],
  ]) assert.throws(() => resolveLive3dsDirectConfig(badEnv, badPrivate, { now }));
});

test('Live preflight requires new canonical 1-500 HNL booking, never a prior Sale', () => {
  const c = resolveLive3dsDirectConfig(env, privateAccess, { now });
  assert.doesNotThrow(() => assertLive3dsFreshIntent(c, freshIntent, 200, false, now + 2000));
  for (const [intent, amount, attempted, when] of [
    [freshIntent, 200, true, now + 2000],
    [freshIntent, 200, false, c.until],
    [freshIntent, LIVE_3DS_MAX_AMOUNT_HNL + 1, false, now + 2000],
    [{ ...freshIntent, estado_intent_codigo: 'pendiente_confirmacion' }, 200, false, now + 2000],
    [{ ...freshIntent, created_at: new Date(now - 1000) }, 200, false, now + 2000],
    [{ ...freshIntent, provider_session_id: 'P-existing' }, 200, false, now + 2000],
    [{ ...freshIntent, orden_compra: 'other' }, 200, false, now + 2000],
    [{ ...freshIntent, moneda_codigo: 'USD' }, 200, false, now + 2000],
  ]) assert.throws(() => assertLive3dsFreshIntent(c, intent, amount, attempted, when),
    e => e.code === 'PIXELPAY_LIVE_3DS_TEST_RESTRICTED');
});

test('Live worker only starts one Sale, including after close and uncertain outcome', async () => {
  const c = resolveLive3dsDirectConfig(env, privateAccess, { now });
  let starts = 0; let close = () => {};
  const registry = createQaDelegatedAttempts({ config: c, now: () => now + 2000,
    makeAttempt: opts => {
      starts += 1;
      close = opts.onClose;
      return { call: async () => ({ state: 'challenge' }), close: opts.onClose };
    } });
  const claim = { idIntent: ID, idGrupoCita: ID, paymentAttemptId: ID, amount: 200,
    protectionExpiresAt: new Date(now + 40000) };
  await registry.start({ claim, owner: ID, input: {}, provider: { env: 'live' } });
  assert.equal(starts, 1);
  close();
  await assert.rejects(registry.start({ claim, owner: ID, input: {}, provider: { env: 'live' } }),
    /CONTEXT_UNAVAILABLE/);
  await assert.rejects(registry.start({ claim, owner: ID, input: {}, provider: { env: 'sandbox' } }),
    /CONTEXT_UNAVAILABLE/);
  assert.equal(starts, 1);
});
