import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { PixelPaySdkProvider } from '../src/services/payments/PixelPaySdkProvider.js';
import { createSongbirdSdkContract } from '../src/services/payments/songbirdSdkContract.js';
import { SongbirdBridge } from '../src/services/payments/songbirdBridge.js';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const axios = require('axios');
const nacl = require('tweetnacl');
const EVENT = 'PIXELPAY_SONGBIRD_CAPTURE_DIAGNOSTIC';
const SECRET = 'SYNTHETIC-TELEMETRY-SECRET-NEVER-LOG';
const INJECTED = 'SYNTHETIC-SINK-ERROR-NEVER-LOG';
const COLLECTION = 'https://untrusted.invalid/never-log-collection-value';

class LocalRepository {
  constructor() { this.row = null; }
  async reserve(_client, row) { this.row = structuredClone(row); return this.row; }
  async mutate(id, owner, work) {
    assert.equal(this.row.id_intent === id && this.row.owner_id === owner, true);
    const row = structuredClone(this.row); row.version++;
    const result = await work(row); this.row = row; return result;
  }
}

async function observe({ tokenKind = 'valid', emptyName = false, sink = 'normal', loggerThrows = false,
  qa = true, collection = false } = {}) {
  // AM: Read only existing public test fixtures; never read credentials, environment files or historical intents.
  const source = await readFile(new URL('./pixelpay-sdk-provider.test.mjs', import.meta.url), 'utf8');
  const fixture = source.match(/card:\s*\{\s*number:\s*"([^"]+)",\s*holder:\s*"([^"]+)",\s*expire:\s*"([^"]+)",\s*cvv:\s*"([^"]+)"\s*\}/);
  assert.equal(Boolean(fixture), true);
  const now = Date.now();
  const context = { idIntent: '11111111-1111-4111-8111-111111111111',
    paymentAttemptId: '22222222-2222-4222-8222-222222222222', ownerId: '33333333-3333-4333-8333-333333333333',
    groupId: '44444444-4444-4444-8444-444444444444', orderId: 'SYNTHETIC-TELEMETRY-ORDER', amount: 1,
    currency: 'HNL', expiresAt: new Date(now + 600000).toISOString() };
  const claims = { iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + (tokenKind === 'expired' ? -1 : 600), order_id: context.orderId };
  if (['order-id', 'order-number'].includes(tokenKind)) {
    claims.order_id = tokenKind === 'order-id' ? SECRET : context.orderId;
    claims.Payload = { OrderDetails: { OrderNumber: tokenKind === 'order-number' ? SECRET : context.orderId } };
  }
  let token = [{ alg: 'HS256' }, claims]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('c3ludGhldGlj').join('.');
  if (tokenKind === 'json') token = 'synthetic.invalid.signature';
  if (tokenKind === 'shape') token = 'synthetic-not-a-jwt';
  const provider = new PixelPaySdkProvider({ endpoint: 'https://pixelpay.dev', env: 'sandbox',
    keyId: 'synthetic-telemetry-key', authHash: 'c'.repeat(32), secretKey: SECRET,
    appUrl: 'https://pixelpay.dev', now: () => new Date(now) });
  const contract = createSongbirdSdkContract({ providerFactory: () => provider, clock: () => now });
  const repository = new LocalRepository();
  const bridge = new SongbirdBridge({ repository, config: { enabled: true, key: Buffer.alloc(32, 8) }, contract, clock: () => now });
  await bridge.reserve(null, context);
  const merchantKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  const originalAdapter = axios.defaults.adapter;
  const originalConnect = net.Socket.prototype.connect;
  const methods = [sdk.Services.Transaction.prototype.doSale, sdk.Requests.SaleTransaction.prototype.withEncryption];
  const counts = { sale: 0, secondSale: 0, status: 0, sockets: 0, captures: 0, diagnosticCalls: 0 };
  const events = [];
  let sdkKey; let capturedContext; let error; let internalCapture;
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, fields => {
    events.push(fields);
    if (fields.event === EVENT) { counts.diagnosticCalls++; if (loggerThrows) throw new Error(INJECTED); }
  }]));
  net.Socket.prototype.connect = function () { counts.sockets++; throw new Error('EXTERNAL_IO_FORBIDDEN'); };
  axios.defaults.adapter = async config => {
    assert.equal(config.baseURL, 'https://pixelpay.dev');
    const response = (status, data) => ({ config, status, headers: {}, data: { success: true, data } });
    if (config.url.endsWith('merchant/public_key')) return response(200, { public_key: merchantKey });
    if (config.url.endsWith('transaction/status')) { counts.status++; throw new Error('STATUS_FORBIDDEN'); }
    if (!config.url.endsWith('transaction/sale')) throw new Error('UNEXPECTED_ROUTE');
    if (counts.sale++) { counts.secondSale++; throw new Error('SECOND_SALE_FORBIDDEN'); }
    sdkKey = config.headers['x-auth-secure'];
    return response(202, { transaction_type: 'songbird', payload: token,
      ...(collection ? { collection_url: COLLECTION } : {}) });
  };
  try {
    try {
      await provider.sale({ orderId: context.orderId, currency: 'HNL', amount: 1,
        items: [{ code: 'local-item', title: 'Synthetic item', price: 1, qty: 1 }],
        customer: { name: emptyName ? '' : 'Synthetic fixture', email: 'fixture@example.invalid' },
        billing: { address: 'Synthetic fixture address', country: 'HN', state: 'HN-CR', city: 'San Pedro Sula', phone: '99999999' },
        card: { number: fixture[1], holder: fixture[2], expire: fixture[3], cvv: fixture[4] },
      }, { ...context, qa3dsDiagnostic: qa, logger,
        async onSongbirdRequired(payload, value) {
          counts.captures++; capturedContext = value;
          if (sink === 'throw') throw Object.assign(new Error(INJECTED), { data: { jwt: payload, context: value } });
          internalCapture = await bridge.capture(context.idIntent, context.ownerId, payload, value);
          if (sink !== 'malicious') return internalCapture;
          return { ...internalCapture, capture_diagnostic: { accepted: true, stage: 'jwt_validation', rule: 'VALID',
            jwt: payload, context: value, message: INJECTED, flags: { jwt_present: true,
              jwt_shape_valid: payload, sdk_public_key_present: true, unexpected: SECRET } } };
        },
      });
    } catch (caught) { error = caught; }
    assert.equal(error?.uncertain, true); assert.equal(error?.statusCode, 202);
    assert.equal(error?.code, 'PIXELPAY_NETWORK_ERROR');
    assert.equal(error?.safeMessageCode, 'SDK_BROWSER_ACTION_REQUIRED');
    assert.equal(counts.sale, 1); assert.equal(counts.secondSale, 0); assert.equal(counts.status, 0); assert.equal(counts.sockets, 0);
    assert.deepEqual(methods, [sdk.Services.Transaction.prototype.doSale, sdk.Requests.SaleTransaction.prototype.withEncryption]);
    const diagnostic = events.filter(event => event.event === EVENT);
    assert.equal(diagnostic.length, qa ? 1 : 0); assert.equal(counts.diagnosticCalls, qa ? 1 : 0);
    for (const event of diagnostic) {
      for (const key of ['songbird_response', 'bridge_capture_completed', 'validation_available']) assert.equal(typeof event[key], 'boolean');
      for (const value of [event.capture, event.validation].filter(Boolean)) {
        assert.deepEqual(Object.keys(value).sort(), ['accepted', 'flags', 'rule', 'stage']);
        assert.equal(typeof value.accepted, 'boolean');
        assert.equal(Object.values(value.flags).every(flag => typeof flag === 'boolean'), true);
      }
    }
    const status = await bridge.status(context.idIntent, context.ownerId);
    assert.equal(Object.hasOwn(repository.row, 'capture_diagnostic'), false);
    assert.equal(Object.hasOwn(status, 'capture_diagnostic'), false);
    assert.equal(Object.hasOwn(error, 'capture_diagnostic'), false);
    assert.equal(JSON.stringify(repository.row).includes('capture_diagnostic'), false);
    assert.equal(JSON.stringify(status).includes('capture_diagnostic'), false);
    assert.equal(JSON.stringify(error).includes('capture_diagnostic'), false);
    assert.equal(JSON.stringify(error).includes('context_capture'), false);
    let claim;
    if (repository.row.state === 'handoff_ready') {
      const box = repository.row.payload_box;
      assert.equal(typeof box, 'string'); assert.equal(box.includes(token), false);
      assert.equal(typeof repository.row.context_box, 'string');
      claim = await bridge.claim(context.idIntent, context.ownerId);
      assert.equal(Object.hasOwn(claim, 'capture_diagnostic'), false);
      assert.equal(claim.handoff.jwt === token, true);
      await assert.rejects(bridge.claim(context.idIntent, context.ownerId), value => value.code === 'SONGBIRD_ALREADY_LEASED');
    }
    const publicText = JSON.stringify({ events, error, status });
    const forbidden = [token, SECRET, INJECTED, COLLECTION, fixture[1].replace(/\D/g, ''), merchantKey, sdkKey,
      ...Object.values(capturedContext?.encrypted || {}), '"card_cvv"', '"secretKey"', '"sdk_key_pair"'];
    for (const value of forbidden.filter(value => typeof value === 'string' && value)) assert.equal(publicText.includes(value), false);
    return { counts, event: diagnostic[0], status, state: repository.row.state, internalCapture };
  } finally {
    axios.defaults.adapter = originalAdapter; net.Socket.prototype.connect = originalConnect;
  }
}

test('valid native 202 capture emits one sanitized diagnostic and retains one-use AES-GCM handoff', async () => {
  const result = await observe();
  assert.equal(result.status.state, 'handoff_ready');
  assert.equal(result.event.capture.rule, 'VALID'); assert.equal(result.event.validation.rule, 'VALID');
  assert.equal(result.event.bridge_capture_completed, true); assert.equal(result.event.validation_available, true);
  assert.equal(result.event.capture.flags.sdk_key_pair_present, true);
});

test('capture exception identifies optional ciphertext rule, not provider omission or QA incident cause', async () => {
  // AM: Synthetic malformed provider input reproduces capture rejection; the real reservation route requires a name.
  const result = await observe({ emptyName: true });
  assert.equal(result.status.state, 'contract_blocked');
  assert.equal(result.event.capture.rule, 'OPTIONAL_CIPHERTEXT_INVALID');
  assert.equal(result.event.validation.rule, 'CONTEXT_MISSING');
  assert.equal(result.event.bridge_capture_completed, true);
});

for (const tokenKind of ['order-id', 'order-number']) {
  test(`native 202 diagnostic distinguishes ${tokenKind} mismatch without exposing the claim or allowing another Sale`, async () => {
    const result = await observe({ tokenKind });
    assert.equal(result.status.state, 'contract_blocked');
    assert.equal(result.event.capture.rule, 'VALID');
    assert.equal(result.event.validation.rule, 'JWT_ORDER_MISMATCH');
    assert.equal(result.event.validation.flags.jwt_order_id_present, true);
    assert.equal(result.event.validation.flags.jwt_order_number_present, true);
    assert.equal(result.event.validation.flags.jwt_order_id_matches, tokenKind !== 'order-id');
    assert.equal(result.event.validation.flags.jwt_order_number_matches, tokenKind !== 'order-number');
    assert.equal(result.counts.sale, 1);
    assert.equal(result.counts.secondSale, 0);
    assert.equal(result.counts.sockets, 0);
  });
}

for (const [tokenKind, rule] of [['expired', 'JWT_EXPIRED'], ['json', 'JWT_JSON_INVALID'], ['shape', 'JWT_SHAPE_INVALID']]) {
  test(`valid encrypted context distinguishes JWT validation failure (${rule}) without publishing input`, async () => {
    const result = await observe({ tokenKind });
    assert.equal(result.status.state, 'contract_blocked'); assert.equal(result.event.capture.rule, 'VALID');
    assert.equal(result.event.validation.rule, rule); assert.equal(result.event.validation.flags.context_present, true);
  });
}

test('unsupported collection URL remains blocked and only its presence is observable', async () => {
  const result = await observe({ collection: true });
  assert.equal(result.status.block_code, 'PIXELPAY_SONGBIRD_DIRECT_API_UNSUPPORTED');
  assert.equal(result.event.capture.rule, 'COLLECTION_URL_UNSUPPORTED');
  assert.equal(result.event.validation.rule, 'COLLECTION_URL_UNSUPPORTED');
});

test('sink failure remains uncertain and emits no original exception or sensitive envelope', async () => {
  const result = await observe({ sink: 'throw' });
  assert.equal(result.status.state, 'awaiting_response'); assert.equal(result.event.capture.rule, 'VALID');
  assert.equal(result.event.bridge_capture_completed, false); assert.equal(result.event.validation_available, false);
  assert.equal(result.event.validation, null);
});

test('provider re-sanitizes malicious sink diagnostics instead of logging returned input', async () => {
  const result = await observe({ sink: 'malicious' });
  assert.equal(result.status.state, 'handoff_ready');
  assert.deepEqual(result.event.validation.flags, { sdk_public_key_present: true, jwt_present: true });
});

test('a diagnostic logger exception does not alter durable handoff or uncertain financial result', async () => {
  const result = await observe({ loggerThrows: true });
  assert.equal(result.status.state, 'handoff_ready'); assert.equal(result.counts.diagnosticCalls, 1);
});

test('diagnostic disabled emits no capture event and cannot start another Sale', async () => {
  const result = await observe({ qa: false });
  assert.equal(result.counts.captures, 0); assert.equal(result.event, undefined);
  assert.equal(result.status.state, 'awaiting_response');
});
