import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegatedAttempt } from '../src/experimental/pixelpayDelegated/attempt.js';
import { desktopContext } from './fixtures/delegatedPixelPayProvider.mjs';
import { createQaDelegatedAttempts, resolveQaDelegatedConfig } from '../src/experimental/pixelpayDelegated/qaAttempts.js';
const workerUrl = new URL('./fixtures/delegatedPixelPayWorker.mjs', import.meta.url);
function attempt(t, order = 'A', scenario, extra = {}) {
  const context = { ...desktopContext(order, scenario), ...extra };
  if (context.application) Object.assign(context.config, {
    env: 'sandbox', endpoint: 'https://pixelpay.dev', appUrl: 'https://pixelpay.dev',
  });
  const value = new DelegatedAttempt({ workerUrl, context });
  t.after(() => value.close());
  return value;
}
const lookup = { reference: 'opaque-reference', browser_language: 'es-HN', user_agent: 'Fixture' };

test('QA context follows hold/QA expiry instead of prototype timers and stays bound to owner and claim', async () => {
  let now = 1000, workerOptions;
  const qa = { enabled: true, intentId: 'A', until: now + 300000 };
  const registry = createQaDelegatedAttempts({ config: qa, now: () => now, makeAttempt: options => {
    workerOptions = options;
    return { call: async () => ({ state: 'challenge' }), close: options.onClose };
  } });
  const claim = { idIntent: 'A', idGrupoCita: 'group', paymentAttemptId: 'attempt-A', protectionExpiresAt: new Date(now + 290000) };
  const { deadline, token } = await registry.start({ claim, owner: 'owner', input: {}, provider: { env: 'sandbox' } });
  const key = { idIntent: 'A', idGrupoCita: 'group', owner: 'owner', token };
  assert.equal(workerOptions.lifetimeMs, 290000);
  assert.equal(workerOptions.timeoutMs, null);
  now += 180000;
  assert.ok(registry.get(key));
  assert.equal(registry.get({ ...key, owner: 'other' }), null);
  assert.equal(registry.get({ ...key, idGrupoCita: 'other' }), null);
  now = deadline - 1;
  assert.ok(registry.get(key));
  now = deadline;
  assert.equal(registry.get(key), null);
  assert.throws(() => resolveQaDelegatedConfig({ QA_PIXELPAY_DELEGATED_ENABLED: 'true', ENTORNO: 'prod' }, qa));
});
async function prepare(value) {
  const start = await value.call('start');
  assert.equal(start.continuation.status, 202);
  assert.equal(start.nodeAuthenticationRequested, false);
  assert.equal(start.threeDsGuaranteed, false);
  assert.equal(JSON.stringify(start).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(start).includes('synthetic-hash'), false);
  assert.equal(JSON.stringify(start).includes('sdk_key_pair'), false);
  await value.call('lookup', lookup);
  return start;
}

test('real Node Sale -> native lookup/continue/retry retains encryption; duplicates never dispatch again', async t => {
  const value = attempt(t);
  const handoff = await prepare(value);
  assert.equal(handoff.continuation.payload, 'opaque-setup-A');
  await value.call('continue', { payload: 'opaque-JWT-no-parsing' });
  const [one, two] = await Promise.all([value.call('retry'), value.call('retry')]);
  assert.deepEqual(one, two);
  assert.equal(one.data.order_id, 'A');
  assert.deepEqual(await value.call('start'), handoff);
  assert.equal((await value.call('status')).evidence.providerApproved, true);
  assert.equal((await value.call('status')).evidence.bookingConfirmed, false);
  assert.deepEqual(await value.call('inspect'), { externalSockets: 0, initialSales: 1, retries: 1,
    lookups: 1, continues: 1, cryptoContextMatches: true, credentialsInNode: true, orders: ['A', 'A', 'A'] });
});

test('A/B concurrent native retries stay isolated across worker module statics', async t => {
  const a = attempt(t, 'A'), b = attempt(t, 'B');
  await Promise.all([prepare(a), prepare(b)]);
  await Promise.all([a.call('continue', { payload: 'opaque-A' }), b.call('continue', { payload: 'opaque-B' })]);
  const [ra, rb] = await Promise.all([a.call('retry'), b.call('retry')]);
  assert.equal(ra.data.order_id, 'A');
  assert.equal(rb.data.order_id, 'B');
  assert.notEqual(ra.data.payment_uuid, rb.data.payment_uuid);
  for (const value of [a, b]) {
    const stats = await value.call('inspect');
    assert.equal(stats.initialSales, 1); assert.equal(stats.retries, 1);
    assert.equal(new Set(stats.orders).size, 1); assert.equal(stats.cryptoContextMatches, true);
    assert.equal(stats.externalSockets, 0);
  }
});

test('untrusted order/identifier/financial fields and conflicting duplicates are rejected', async t => {
  const value = attempt(t);
  await value.call('start');
  await assert.rejects(value.call('lookup', { ...lookup, order_id: 'B' }));
  await assert.rejects(value.call('retry', { response_approved: true }));
  await value.call('lookup', lookup);
  await assert.rejects(value.call('lookup', { ...lookup, reference: 'different' }));
  await assert.rejects(value.call('continue', { payload: 'opaque', identifier: 'other' }));
  assert.equal((await value.call('status')).evidence.providerApproved, false);
  assert.equal((await value.call('inspect')).initialSales, 1);
});

test('timeout and lost context remain uncertain; no automatic second initial Sale', async t => {
  const value = attempt(t, 'A', 'retry-timeout');
  await prepare(value);
  await value.call('continue', { payload: 'opaque' });
  assert.equal((await value.call('retry')).status, 520);
  assert.equal((await value.call('retry')).status, 520);
  assert.equal((await value.call('status')).state, 'uncertain');
  const stats = await value.call('inspect');
  assert.equal(stats.initialSales, 1); assert.equal(stats.retries, 1);
  value.close();
  await assert.rejects(value.call('start'), /CONTEXT_LOST/);
});

for (const scenario of ['frictionless', 'continue-false', 'declined', 'bad-currency', 'bad-uuid', 'bad-amount']) {
  test(`native continuation ${scenario}: no universal continueAccepted or browser approval`, async t => {
    const value = attempt(t, 'A', scenario);
    await prepare(value);
    if (scenario !== 'frictionless') await value.call('continue', { payload: 'opaque' });
    await value.call('retry');
    const status = await value.call('status');
    assert.equal(status.evidence.providerApproved, !['declined', 'bad-currency', 'bad-uuid', 'bad-amount'].includes(scenario));
    assert.equal(status.evidence.bookingConfirmed, false);
  });
}

test('explicit Node authentication stays rejected; no fallback removes it', async t => {
  const value = attempt(t, 'A', 'challenge', { explicitAuthentication: true });
  await assert.rejects(value.call('start'));
  await assert.rejects(value.call('start'));
  assert.equal((await value.call('inspect')).initialSales, 0);
  assert.equal((await value.call('status')).state, 'uncertain');
});

test('200 without authentication is never reported as a proven 3DS handoff', async t => {
  const value = attempt(t, 'A', 'no-3ds');
  const start = await value.call('start');
  assert.equal(start.state, 'completed_without_3ds');
  assert.equal(start.threeDsGuaranteed, false);
  assert.equal(start.evidence.bookingConfirmed, false);
  await assert.rejects(value.call('lookup', lookup));
});

test('QA native Direct API retries only after trusted lookup; PAID corroborates an approved Sale only', async t => {
  for (const [scenario, approved] of [['nested-status', true], ['missing-status-currency', false]]) {
    const value = attempt(t, 'A', scenario, { application: true });
    const handoff = await value.call('start');
    assert.equal(handoff.continuation_mode, 'direct_api');
    assert.equal(handoff.continuation.collection_url, 'https://cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect?n=%2B%2F');
    assert.equal(handoff.continuation.payload, 'opaque-setup-A');
    assert.deepEqual(handoff.continuation_diagnostic.sdk_to_handoff_equal, {
      collection_url: true, payload: true, transaction_type: true,
    });
    assert.deepEqual(handoff.continuation_diagnostic.raw_to_sdk_equal, {
      collection_url: true, payload: true, transaction_type: true,
    });
    assert.equal(handoff.continuation_diagnostic.sale_origin, 'https://pixelpay.dev');
    assert.equal(handoff.continuation_diagnostic.sale_environment, 'sandbox');
    assert.equal(handoff.continuation_diagnostic.upstream_cf_ray, '0123456789abcdef-TPA');
    assert.doesNotMatch(JSON.stringify(handoff.continuation_diagnostic), /opaque-setup-A|n=%2B|synthetic-secret/);
    await assert.rejects(value.call('retry'));
    const response = await value.call('lookup', lookup);
    assert.deepEqual(response.data, {
      identifier: 'auth-A', continue_url: 'https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/StepUp?n=%2B%2F',
      continue_payload: 'opaque.+/=%ñ', transaction_id: 'tx-A', window_size: '03',
    });
    assert.deepEqual(await value.call('lookup', lookup), response);
    await assert.rejects(value.call('lookup', { ...lookup, reference: 'different-attempt' }));
    await assert.rejects(value.call('continue', { payload: 'client-assertion' }));
    await assert.rejects(value.call('retry', { completed: true }));
    await assert.rejects(value.call('retry', { identifier: 'auth-A' }));
    const [result, repeated] = await Promise.all([value.call('retry'), value.call('retry')]);
    assert.deepEqual(repeated, result);
    assert.equal(result.final.approved, approved);
    assert.deepEqual(result.sdkResponse.data, {});
    const stats = await value.call('inspect');
    assert.equal(stats.initialSales, 1);
    assert.equal(stats.retries, 1);
    assert.equal(stats.lookups, 1);
    assert.equal(stats.continues, 0);
    assert.equal(stats.directLookupCvvMatches, true);
    assert.equal(stats.externalSockets, 0);
    value.close();
  }
});

for (const [suffix, reason, type] of [
  ['absent', 'ABSENT', 'absent'], ['top-level', 'ABSENT', 'absent'], ['null', 'NULL', 'null'],
  ['empty', 'EMPTY', 'empty_string'], ['object', 'INVALID', 'object'],
  ['untrusted', 'INVALID', 'string'], ['invalid-path', 'INVALID', 'string'],
]) test(`QA collection_url ${suffix} leaves the submitted Sale pending without a handoff or another Sale`, async t => {
  const value = attempt(t, 'A', `collection-${suffix}`, { application: true });
  const result = await value.call('start');
  assert.equal(result.state, 'unsupported');
  assert.equal(result.observedPaymentUuid, 'uuid-A');
  assert.equal(result.continuation, undefined);
  assert.equal(result.continuation_diagnostic.code, `PIXELPAY_3DS_COLLECTION_URL_${reason}`);
  assert.equal(result.continuation_diagnostic.raw_data.collection_url.type, type);
  assert.equal(result.continuation_diagnostic.raw_top_level_collection_url.present, suffix === 'top-level');
  assert.equal(result.continuation_diagnostic.sdk_data.collection_url.type, type);
  await assert.rejects(value.call('retry'));
  assert.equal((await value.call('inspect')).initialSales, 1);
});

for (const scenario of ['invalid-step-up', 'invalid-lookup-identifier', 'lookup-not-successful']) {
  test(`QA Direct API ${scenario} cannot dispatch the native retry`, async t => {
    const value = attempt(t, 'A', scenario, { application: true });
    assert.equal((await value.call('start')).continuation_mode, 'direct_api');
    const response = await value.call('lookup', lookup);
    assert.equal(response.success, false);
    assert.deepEqual(response.data, {});
    await assert.rejects(value.call('retry'));
    assert.equal((await value.call('inspect')).retries, 0);
  });
}

test('QA Direct API frictionless lookup can retry without requesting an ACS challenge', async t => {
  const value = attempt(t, 'A', 'frictionless', { application: true });
  assert.equal((await value.call('start')).continuation_mode, 'direct_api');
  const response = await value.call('lookup', lookup);
  assert.equal(response.action, null);
  assert.equal(response.success, true);
  const result = await value.call('retry');
  assert.equal(result.final.approved, true);
  assert.equal((await value.call('inspect')).retries, 1);
});

test('QA Direct API accepts a 200 challenge lookup and cannot retry after worker close', async t => {
  const value = attempt(t, 'A', 'challenge-http-200', { application: true });
  const start = await value.call('start');
  assert.equal(start.continuation_mode, 'direct_api');
  assert.equal(start.continuation.collection_url, 'https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/Collect?n=%2B%2F');
  const response = await value.call('lookup', lookup);
  assert.equal(response.status, 200);
  assert.equal(response.success, true);
  assert.equal(response.action, 'continue');
  assert.equal((await value.call('inspect')).retries, 0);
  value.close();
  await assert.rejects(value.call('retry'), /CONTEXT_LOST/);
});
