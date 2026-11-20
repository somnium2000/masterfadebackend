import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegatedAttempt } from '../src/experimental/pixelpayDelegated/attempt.js';
import { desktopContext } from './fixtures/delegatedPixelPayProvider.mjs';
import { resolvePublicPixelPay3dsConfig } from '../src/services/payments/publicPixelPay3ds.js';

const malformed = [
  ['scheme-without-authority', 'https:acs.offline.invalid/challenge'],
  ['single-slash', 'https:/acs.offline.invalid/challenge'],
  ['extra-slash', 'https:///acs.offline.invalid/challenge'],
  ['relative', '/challenge'], ['protocol-relative', '//acs.offline.invalid/challenge'],
  ['leading-control', '\u0000https://acs.offline.invalid/challenge'],
  ['path-control', 'https://acs.offline.invalid/\u0000challenge'],
  ['trailing-control', 'https://acs.offline.invalid/challenge\u007f'],
  ['cleartext', 'http://acs.offline.invalid/challenge'],
  ['userinfo', 'https://synthetic:synthetic@acs.offline.invalid/challenge'],
];

function attempt(t, scenario, extra = {}, environment = 'sandbox') {
  const context = { ...desktopContext('URL-CONTRACT', scenario), application: true, publicContinuation: true, ...extra };
  if (environment === 'sandbox') Object.assign(context.config, { env: 'sandbox', endpoint: 'https://pixelpay.dev', appUrl: 'https://pixelpay.dev' });
  const worker = new DelegatedAttempt({ workerUrl: new URL('./fixtures/delegatedPixelPayWorker.mjs', import.meta.url), context });
  t.after(() => worker.close());
  return worker;
}

for (const [label, songbirdChallengeUrl] of malformed) {
  test(`Songbird destination rejects ${label} before browser handoff and continuation`, async t => {
    const worker = attempt(t, 'songbird', { songbirdChallengeUrl });
    const handoff = await worker.call('start');
    assert.equal(handoff.continuation_mode, 'songbird');
    assert.equal(Object.hasOwn(handoff.continuation, 'collection_url'), false);
    assert.deepEqual(await worker.call('lookup', { reference: 'synthetic-reference' }), {
      status: 202, success: false, action: null, data: {},
    });
    await assert.rejects(worker.call('continue', { payload: 'synthetic-validated' }));
    await assert.rejects(worker.call('retry'));
    const stats = await worker.call('inspect');
    assert.equal(stats.lookups, 1);
    assert.equal(stats.continues, 0);
    assert.equal(stats.retries, 0);
    assert.equal(stats.externalSockets, 0);
  });
}

for (const [label, collectionUrl] of [
  ['scheme-without-authority', 'https:cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect'],
  ['single-slash', 'https:/cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect'],
  ['leading-control', '\u0000https://cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect'],
]) {
  test(`present Direct collection ${label} never selects Songbird`, async t => {
    const worker = attempt(t, 'challenge', { collectionUrl });
    const start = await worker.call('start');
    assert.equal(start.state, 'unsupported');
    assert.equal(start.continuation, undefined);
    assert.equal(start.continuation_diagnostic.code, 'PIXELPAY_3DS_COLLECTION_URL_INVALID');
    await assert.rejects(worker.call('lookup', { reference: 'synthetic-reference' }));
    const stats = await worker.call('inspect');
    assert.equal(stats.initialSales, 1);
    assert.equal(stats.lookups + stats.continues + stats.retries + stats.externalSockets, 0);
  });
}

test('a genuinely absent collection selects Songbird while explicit null remains unsupported', async t => {
  const absent = attempt(t, 'collection-absent');
  const admitted = await absent.call('start');
  assert.equal(admitted.continuation_mode, 'songbird');
  assert.equal(Object.hasOwn(admitted.continuation, 'collection_url'), false);
  const explicitNull = attempt(t, 'collection-null');
  const rejected = await explicitNull.call('start');
  assert.equal(rejected.state, 'unsupported');
  assert.equal(rejected.continuation_diagnostic.code, 'PIXELPAY_3DS_COLLECTION_URL_NULL');
  assert.equal(rejected.continuation, undefined);
});

test('a canonical HTTPS issuer destination is retained byte-for-byte after native lookup', async t => {
  const songbirdChallengeUrl = 'https://ACS.offline.invalid:443/challenge?opaque=%2B%2F';
  const worker = attempt(t, 'songbird', { songbirdChallengeUrl });
  await worker.call('start');
  const lookup = await worker.call('lookup', { reference: 'synthetic-reference' });
  assert.equal(lookup.success, true);
  assert.equal(lookup.data.continue_url, songbirdChallengeUrl);
  assert.equal((await worker.call('inspect')).externalSockets, 0);
});

test('public Live configuration requires an unambiguous HTTPS origin for endpoint and app URL', () => {
  const env = { PIXELPAY_PUBLIC_3DS_ENABLED: 'true', NODE_ENV: 'production', ENTORNO: 'production',
    PIXELPAY_ENV: 'live', PAYMENT_PROVIDER: 'pixelpay', PIXELPAY_IMPLEMENTATION: 'sdk',
    PIXELPAY_ENDPOINT: 'https://provider.offline.invalid', PIXELPAY_APP_URL: 'https://shop.offline.invalid' };
  const profile = { publicCommerce: { bookingEnabled: true } };
  assert.equal(resolvePublicPixelPay3dsConfig(env, profile), 'live');
  for (const field of ['PIXELPAY_ENDPOINT', 'PIXELPAY_APP_URL']) {
    for (const value of ['https:provider.offline.invalid', 'https:/provider.offline.invalid',
      'https:///provider.offline.invalid', '\u0000https://provider.offline.invalid',
      'https://provider.offline.invalid\u007f']) {
      assert.throws(() => resolvePublicPixelPay3dsConfig({ ...env, [field]: value }, profile));
    }
  }
});

const liveOrigin = 'https://client.cardinaltrusted.com';
const casOrigin = 'https://cas.client.cardinaltrusted.com';
const collect = '/centinelapi/V1/Cruise/Collect';
const stepUp = '/centinelapi/V2/Cruise/StepUp';

for (const version of ['V1', 'V2']) {
  test(`Live admits official Collect ${version} and StepUp V2 via the native worker`, async t => {
    const collectionUrl = liveOrigin + collect.replace('V1', version);
    assert.equal(collectionUrl.length, 64);
    const worker = attempt(t, 'challenge', { collectionUrl }, 'live');
    const handoff = await worker.call('start');
    assert.equal(handoff.continuation_mode, 'direct_api');
    assert.equal(handoff.continuation.collection_url, collectionUrl);
    assert.equal(handoff.continuation_diagnostic.raw_to_sdk_equal.collection_url, true);
    const lookup = await worker.call('lookup', { reference: 'synthetic-reference' });
    assert.equal(lookup.success, true);
    assert.equal(lookup.data.continue_url, liveOrigin + stepUp);
    assert.equal((await worker.call('inspect')).externalSockets, 0);
  });
}

for (const [label, environment, collectionUrl] of [
  ['CAS in Live', 'live', casOrigin + collect],
  ['Live in CAS', 'sandbox', liveOrigin + collect],
  ['StepUp as Collect', 'live', liveOrigin + stepUp],
  ['cross-origin query', 'live', liveOrigin + collect + '?redirect=https://redirect.invalid'],
  ['normalized path', 'live', liveOrigin + '/other/..' + collect],
  ['lookalike domain', 'live', liveOrigin + '.invalid' + collect],
  ['empty credentials', 'live', liveOrigin.replace('://', '://@') + collect],
]) {
  test(`Direct API rejects Collect ${label} without falling back`, async t => {
    const worker = attempt(t, 'challenge', { collectionUrl }, environment);
    const result = await worker.call('start');
    assert.equal(result.state, 'unsupported');
    assert.equal(result.continuation_diagnostic.code, 'PIXELPAY_3DS_COLLECTION_URL_INVALID');
    assert.equal(result.continuation, undefined);
    await assert.rejects(worker.call('lookup', { reference: 'synthetic-reference' }));
    assert.equal((await worker.call('inspect')).externalSockets, 0);
  });
}

for (const stepUpUrl of [casOrigin + stepUp, liveOrigin + collect, liveOrigin + stepUp + '?return=https://redirect.invalid']) {
  test(`Live rejects mismatched StepUp destination ${stepUpUrl}`, async t => {
    const worker = attempt(t, 'challenge', { stepUpUrl }, 'live');
    assert.equal((await worker.call('start')).continuation_mode, 'direct_api');
    assert.deepEqual(await worker.call('lookup', { reference: 'synthetic-reference' }), {
      status: 202, success: false, action: null, data: {},
    });
    await assert.rejects(worker.call('retry'));
    const stats = await worker.call('inspect');
    assert.equal(stats.retries + stats.externalSockets, 0);
  });
}
