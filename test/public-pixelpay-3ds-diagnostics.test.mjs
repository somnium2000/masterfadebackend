import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPixelPay3dsAttempts } from '../src/services/payments/publicPixelPay3ds.js';

const claim = { idIntent: '99999999-9999-4999-8999-999999999999',
  paymentAttemptId: '88888888-8888-4888-8888-888888888888',
  idGrupoCita: '11111111-2222-4333-8444-555555555555',
  protectionExpiresAt: new Date(500000).toISOString() };
const start = manager => manager.start({ kind: 'booking', claim, owner: 'owner', input: {}, provider: { env: 'sandbox' } });
const metadata = (type, length = null) => ({ present: type !== 'absent', type, length });
const unsupported = {
  state: 'unsupported', observedPaymentUuid: null,
  continuation_diagnostic: {
    code: 'PIXELPAY_3DS_COLLECTION_URL_ABSENT', upstream_http_status: 202,
    upstream_cf_ray: '0123456789abcdef-TPA', sale_origin: 'https://pixelpay.dev', sale_environment: 'sandbox',
    raw_top_level_collection_url: { ...metadata('absent'), origin: null },
    raw_data: { collection_url: { ...metadata('absent'), origin: null },
      payload: metadata('string', 300), transaction_type: metadata('string', 8), transaction_type_kind: 'songbird' },
    sdk_data: { collection_url: { ...metadata('absent'), origin: null },
      payload: metadata('string', 300), transaction_type: metadata('string', 8), transaction_type_kind: 'songbird' },
    raw_to_sdk_equal: { collection_url: true, payload: true, transaction_type: true }, sdk_to_handoff_equal: null,
    payload: 'NEVER_LOG_RAW_JWT', card_cvv: 'NEVER_LOG_CVV', error: 'NEVER_LOG_ERROR',
  },
};

test('public 202 unsupported records a closed safe diagnostic and preserves pending result', async () => {
  const records = [], queries = [];
  let closed = 0;
  const manager = createPublicPixelPay3dsAttempts({ now: () => 1,
    db: { async query(...args) { queries.push(args); return { rows: [{}] }; } },
    logger: { info: event => records.push(event) },
    makeAttempt: ({ onClose }) => ({ call: async () => unsupported, close() { closed++; onClose(); } }),
  });
  const result = await start(manager);
  assert.deepEqual(result.result, unsupported);
  assert.equal(queries.length, 1);
  assert.equal(closed, 1);
  const event = records.find(row => row.phase === 'start_result');
  assert.ok(event, 'unsupported 202 must leave an observable reason');
  assert.equal(event.state, 'unsupported');
  assert.equal(event.continuation_diagnostic.code, 'PIXELPAY_3DS_COLLECTION_URL_ABSENT');
  assert.equal(event.continuation_diagnostic.sdk_data.collection_url.type, 'absent');
  assert.equal(event.continuation_diagnostic.sdk_data.transaction_type_kind, 'songbird');
  assert.equal(event.id_intent, claim.idIntent);
  assert.equal(event.paymentAttemptId, claim.paymentAttemptId);
  assert.doesNotMatch(JSON.stringify(records), /NEVER_LOG|card_cvv|"error"|token|payment_uuid/);
  assert.equal(manager.get({ kind: 'booking', ...claim, owner: 'owner', token: result.token }), null);
});

for (const failure of ['worker_construction', 'worker_start', 'durable_record']) {
  test(`public start failure ${failure} logs a fixed stage without exposing the exception`, async () => {
    const records = [];
    const manager = createPublicPixelPay3dsAttempts({ now: () => 1,
      db: { async query() { throw new Error('NEVER_LOG_SQL'); } },
      logger: { info: event => records.push(event) },
      makeAttempt: ({ onClose }) => {
        if (failure === 'worker_construction') throw new Error('NEVER_LOG_IMPORT');
        return { close: onClose, async call() {
          if (failure === 'worker_start') throw new Error('NEVER_LOG_UPSTREAM');
          return unsupported;
        } };
      },
    });
    await assert.rejects(start(manager));
    const event = records.find(row => row.phase === 'start_failed');
    assert.ok(event);
    assert.equal(event.stage, failure);
    assert.equal(event.code, 'PIXELPAY_PUBLIC_3DS_START_UNCERTAIN');
    assert.doesNotMatch(JSON.stringify(records), /NEVER_LOG|"error"|stack/);
  });
}

test('context expiration after the durable record logs context_check without admitting a handoff', async () => {
  const records = [];
  let now = 1, closed = 0;
  const manager = createPublicPixelPay3dsAttempts({ now: () => now,
    db: { async query() { now = 500000; return { rows: [{}] }; } },
    logger: { info: event => records.push(event) },
    makeAttempt: ({ onClose }) => ({
      async call() { return { ...unsupported, state: 'challenge' }; },
      close() { closed++; onClose(); },
    }),
  });
  await assert.rejects(start(manager), { code: 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST' });
  assert.equal(closed, 1);
  assert.equal(records.find(row => row.phase === 'start_failed')?.stage, 'context_check');
  assert.equal(records.some(row => row.phase === 'handoff_ready'), false);
  assert.doesNotMatch(JSON.stringify(records), /NEVER_LOG|"error"|stack/);
});

test('failure of the diagnostic sink does not change pending semantics', async () => {
  const manager = createPublicPixelPay3dsAttempts({ now: () => 1,
    db: { async query() { return { rows: [{}] }; } },
    logger: { info() { throw new Error('LOG_SINK_FAILURE'); } },
    makeAttempt: ({ onClose }) => ({ call: async () => unsupported, close: onClose }),
  });
  assert.equal((await start(manager)).result.state, 'unsupported');
});

test('unrecognized metadata values and URL credentials cannot reach the diagnostic sink', async () => {
  const records = [];
  const poisoned = structuredClone(unsupported);
  const diagnostic = poisoned.continuation_diagnostic;
  diagnostic.code = 'NEVER_LOG_ARBITRARY_CODE';
  diagnostic.sale_origin = 'https://pixelpay.dev/private-path?jwt=NEVER_LOG_QUERY';
  diagnostic.upstream_cf_ray = 'NEVER_LOG_ARBITRARY_RAY';
  diagnostic.sdk_data.collection_url.origin = 'https://private:NEVER_LOG_PASSWORD@pixelpay.dev';
  diagnostic.raw_data.payload = { present: 'NEVER_LOG_BOOLEAN', type: 'NEVER_LOG_TYPE',
    length: 'NEVER_LOG_LENGTH', value: 'NEVER_LOG_VALUE' };
  const manager = createPublicPixelPay3dsAttempts({ now: () => 1,
    db: { async query() { return { rows: [{}] }; } },
    logger: { info: event => records.push(event) },
    makeAttempt: ({ onClose }) => ({ call: async () => poisoned, close: onClose }),
  });
  await start(manager);
  const logged = records[0].continuation_diagnostic;
  assert.equal(logged.code, null);
  assert.equal(logged.sale_origin, 'https://pixelpay.dev');
  assert.equal(logged.upstream_cf_ray, null);
  assert.equal(logged.sdk_data.collection_url.origin, null);
  assert.deepEqual(logged.raw_data.payload, { present: null, type: null, length: null });
  assert.doesNotMatch(JSON.stringify(records), /NEVER_LOG|private-path|private:/);
});
