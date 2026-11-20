import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DelegatedAttempt } from '../src/experimental/pixelpayDelegated/attempt.js';
import { desktopContext, installSyntheticProvider } from './fixtures/delegatedPixelPayProvider.mjs';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const CardinalAuthentication = require('@pixelpay/sdk-core/lib/services/CardinalAuthentication').default;
const LookupContinueTransaction = require('@pixelpay/sdk-core/lib/requests/LookupContinueTransaction').default;
const workerUrl = new URL('./fixtures/delegatedPixelPayWorker.mjs', import.meta.url);
const positive = { success: true, action: null };
const cases = [
  ['200 boolean success and null action', 200, positive, true],
  ['200 omitted action', 200, { success: true }, true],
  ['200 null optional data', 200, { ...positive, data: null }, true],
  ...['', false, 0].map(action => [`200 SDK-normalized falsy action ${JSON.stringify(action)}`, 200, { success: true, action }, true]),
  ...[201, 202, 204, 400, 401, 402, 408, 412, 422, 500, 503, 520].map(status => [`${status} is not continuation acceptance`, status, positive, false]),
  ['200 missing success', 200, { action: null }, false],
  ...[false, null, 'true', 1, {}, []].map(success => [`200 invalid success ${JSON.stringify(success)}`, 200, { success, action: null }, false]),
  ...['continue', 'retry', true, [], {}].map(action => [`200 non-null SDK action ${JSON.stringify(action)}`, 200, { success: true, action }, false]),
  ['200 empty body', 200, null, false],
];

for (const [name, status, body, accepted] of cases) {
  test(`authenticationContinue native response contract: ${name}`, async t => {
    const context = { ...desktopContext('contract', 'songbird'), application: true, publicContinuation: true,
      continueResponse: { status, body } };
    // AM: Observe the installed SDK's HTTP classification without constructing a fake Response instance.
    const fixture = installSyntheticProvider(context);
    let native;
    try {
      const settings = new sdk.Models.Settings();
      settings.setupEndpoint(context.config.endpoint);
      settings.setupEnvironment(context.config.env);
      settings.setupCredentials(context.config.keyId, context.config.authHash);
      const service = new CardinalAuthentication(settings);
      const request = new LookupContinueTransaction();
      request.identifier = 'auth-contract'; request.payload = 'opaque-validated-jwt';
      native = await service.authenticationContinue(request);
      assert.equal(native.status, status);
      assert.equal(native instanceof sdk.Responses.SuccessResponse, status === 200);
      assert.deepEqual(native.success, body?.success || false);
      assert.deepEqual(native.action, body?.action || null);
      assert.equal(fixture.stats.externalSockets, 0);
      assert.equal(fixture.stats.continues, 1);
    } finally { fixture.restore(); }

    // AM: The application gate runs after the same native transport/parser inside an isolated worker.
    const worker = new DelegatedAttempt({ workerUrl, context });
    t.after(() => worker.close());
    assert.equal((await worker.call('start')).continuation_mode, 'songbird');
    const lookup = await worker.call('lookup', { reference: 'synthetic-setup-session' });
    assert.equal(lookup.success, true);
    assert.equal(lookup.action, 'continue');
    await assert.rejects(worker.call('retry'));
    const continued = await worker.call('continue', { payload: 'opaque-validated-jwt' });
    assert.deepEqual(continued, { status, success: native.success, action: native.action, data: {} });
    if (accepted) {
      const final = await worker.call('retry');
      assert.equal(final.final.approved, true);
      assert.equal(final.final.paymentHashValid, true);
    } else await assert.rejects(worker.call('retry'));
    const stats = await worker.call('inspect');
    assert.equal(stats.initialSales, 1);
    assert.equal(stats.lookups, 1);
    assert.equal(stats.continues, 1);
    assert.equal(stats.retries, accepted ? 1 : 0);
    assert.equal(stats.statusQueries, 0);
    assert.equal(stats.externalSockets, 0);
  });
}
