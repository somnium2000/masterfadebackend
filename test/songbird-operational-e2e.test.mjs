import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { PixelPaySdkProvider } from '../src/services/payments/PixelPaySdkProvider.js';
import { createSongbirdSdkContract } from '../src/services/payments/songbirdSdkContract.js';
import { SongbirdBridge } from '../src/services/payments/songbirdBridge.js';
import { assertSongbirdFinalizationBlocked } from '../src/services/payments/songbirdContract.js';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const axios = require('axios');
const nacl = require('tweetnacl');

class LocalRepository {
  constructor() { this.row = null; this.tail = Promise.resolve(); }
  async reserve(_client, row) { assert.equal(this.row, null); this.row = structuredClone(row); return this.row; }
  async mutate(id, owner, work) {
    let release;
    const before = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await before;
    try {
      if (this.row && (this.row.id_intent !== id || this.row.owner_id !== owner)) throw new Error('CONTEXT_MISMATCH');
      const next = structuredClone(this.row);
      if (next) next.version++;
      const result = await work(next);
      this.row = next;
      return result;
    } finally { release(); }
  }
}

test('backend operational chain: native SDK Sale 202 → encrypted handoff → native lookup/continue; no financial finalization', async () => {
  // AM: Reuse an existing official public test-card fixture; no real card or merchant credential is read.
  const fixtureSource = await readFile(new URL('./pixelpay-sdk-provider.test.mjs', import.meta.url), 'utf8');
  const fixture = fixtureSource.match(/card:\s*\{\s*number:\s*"([^"]+)",\s*holder:\s*"([^"]+)",\s*expire:\s*"([^"]+)",\s*cvv:\s*"([^"]+)"\s*\}/);
  assert.equal(Boolean(fixture), true);
  const now = Date.now();
  const clock = () => now;
  const context = { idIntent: '11111111-1111-4111-8111-111111111111',
    paymentAttemptId: '22222222-2222-4222-8222-222222222222',
    ownerId: '33333333-3333-4333-8333-333333333333', groupId: '44444444-4444-4444-8444-444444444444',
    orderId: 'SYNTHETIC-OPERATIONAL-E2E', amount: 1, currency: 'HNL', expiresAt: new Date(now + 600000).toISOString() };
  const token = phase => [
    { alg: 'HS256' }, { iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600, order_id: context.orderId,
      Payload: { OrderDetails: { OrderNumber: 'PROVIDER-OWNED-ORDER' } }, phase },
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('c3ludGhldGlj').join('.');
  const initialJwt = token('initial'); const validatedJwt = token('validated');
  const syntheticSecret = 'SYNTHETIC-SERVER-SECRET-NEVER-RETURN';
  const provider = new PixelPaySdkProvider({ endpoint: 'https://pixelpay.dev', env: 'sandbox',
    keyId: 'synthetic-key', authHash: 'c'.repeat(32), secretKey: syntheticSecret,
    appUrl: 'https://pixelpay.dev', now: () => new Date(now) });
  const contract = createSongbirdSdkContract({ providerFactory: () => provider, clock });
  const repository = new LocalRepository();
  const bridge = new SongbirdBridge({ repository, config: { enabled: true, key: Buffer.alloc(32, 8), ttlMs: 600000 }, contract, clock });
  await bridge.reserve(null, context);
  const publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  const originalAdapter = axios.defaults.adapter;
  const originalConnect = net.Socket.prototype.connect;
  const originalMethods = [sdk.Services.Transaction.prototype.doSale, sdk.Requests.SaleTransaction.prototype.withAuthenticationRequest];
  const counts = { initialSale: 0, secondSale: 0, lookup: 0, continue: 0, status: 0, sockets: 0, handoffCapture: 0 };
  const routes = []; const telemetry = [];
  let capturedContext; let salePublicKey; let initialError;
  const response = (config, status, data, success = true, action = null) => ({
    config, status, headers: { 'content-type': 'application/json' }, data: { success, action, data },
  });
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(method => [method, fields => telemetry.push(fields)]));
  net.Socket.prototype.connect = function () { counts.sockets++; throw new Error('EXTERNAL_IO_FORBIDDEN'); };
  axios.defaults.adapter = async config => {
    routes.push(config.url);
    assert.equal(config.baseURL, 'https://pixelpay.dev');
    const body = config.data ? JSON.parse(config.data) : {};
    if (config.url.endsWith('merchant/public_key')) return response(config, 200, { public_key: publicKey });
    if (config.url.endsWith('transaction/status')) { counts.status++; throw new Error('STATUS_FORBIDDEN'); }
    if (config.url.endsWith('transaction/sale')) {
      if (counts.initialSale) { counts.secondSale++; throw new Error('SECOND_SALE_FORBIDDEN'); }
      counts.initialSale++;
      assert.equal(body.order_id === context.orderId && Number(body.order_amount) === 1 && body.order_currency === 'HNL', true);
      assert.equal(body.card_number !== fixture[1].replace(/\D/g, '') && body.card_cvv !== fixture[4], true);
      salePublicKey = config.headers['x-auth-secure'];
      return response(config, 202, { transaction_type: 'songbird', payload: initialJwt });
    }
    if (config.url.endsWith('cardinal/authentication/lookup')) {
      counts.lookup++;
      assert.equal(body.order_id === context.orderId && Number(body.order_amount) === 1 && body.order_currency === 'HNL', true);
      assert.equal(body.card_number === capturedContext.encrypted.card_number, true);
      assert.equal(Object.hasOwn(body, 'card_cvv'), false);
      assert.equal(Object.hasOwn(body, 'sdk_key_pair'), false);
      assert.equal(config.headers['x-auth-secure'] === salePublicKey, true);
      assert.equal(body.browser_language, 'es-HN');
      assert.equal(body.reference, 'synthetic-cardinal-session');
      return response(config, 200, { identifier: 'synthetic-auth',
        continue_url: 'https://centinelapistag.cardinalcommerce.com/challenge',
        continue_payload: 'synthetic-challenge', transaction_id: 'synthetic-transaction' }, true, 'continue');
    }
    if (config.url.endsWith('cardinal/authentication/continue')) {
      counts.continue++;
      assert.equal(body.identifier, 'synthetic-auth');
      assert.equal(body.payload === validatedJwt, true);
      assert.equal(body.authenticate_token, false);
      return response(config, 200, {}, true);
    }
    throw new Error('UNEXPECTED_SDK_ROUTE');
  };
  try {
    try {
      await provider.sale({ orderId: context.orderId, amount: 1, currency: 'HNL',
        items: [{ code: 'synthetic-service', title: 'Synthetic service', price: 1, qty: 1 }],
        customer: { name: 'Synthetic fixture', email: 'fixture@example.invalid' },
        billing: { address: 'Synthetic fixture address', country: 'HN', state: 'HN-CR', city: 'San Pedro Sula', phone: '99999999' },
        card: { number: fixture[1], holder: fixture[2], expire: fixture[3], cvv: fixture[4] },
      }, { ...context, qa3dsDiagnostic: true, logger,
        async onSongbirdRequired(payload, serverContext) {
          counts.handoffCapture++;
          capturedContext = serverContext;
          await bridge.capture(context.idIntent, context.ownerId, payload, serverContext);
        },
      });
    } catch (error) { initialError = error; }
    assert.equal(initialError?.code, 'PIXELPAY_NETWORK_ERROR');
    assert.equal(initialError?.statusCode, 202);
    assert.equal(initialError?.safeMessageCode, 'SDK_BROWSER_ACTION_REQUIRED');
    assert.equal(counts.handoffCapture, 1);
    assert.equal(repository.row.state, 'handoff_ready');
    assert.equal(typeof repository.row.context_box, 'string');
    assert.equal(repository.row.context_box.includes(JSON.stringify(capturedContext)), false);
    assert.equal(repository.row.payload_box.includes(initialJwt), false);
    const contextJson = JSON.stringify(capturedContext);
    for (const forbidden of ['card_cvv', 'secretKey', 'sdk_key_pair', syntheticSecret, fixture[1].replace(/\D/g, '')]) {
      assert.equal(contextJson.includes(forbidden), false);
    }
    const lease = await bridge.claim(context.idIntent, context.ownerId);
    assert.equal(lease.handoff.jwt === initialJwt, true);
    assert.equal(repository.row.payload_box, null);
    const setup = await bridge.step(context.idIntent, context.ownerId, 'setup', lease.handoff.lease_id,
      'synthetic-cardinal-session', { emv: { browser_java_enabled: 'false', browser_javascript_enabled: 'true',
        browser_language: 'es-HN', browser_color_depth: '24', browser_screen_height: '900',
        browser_screen_width: '1400', browser_time_zone: '360', user_agent: 'Synthetic-browser' },
      ipAddress: '127.0.0.1', httpAccept: '*/*' });
    assert.equal(setup.state, 'challenge_ready');
    assert.equal(repository.row.context_box, null);
    assert.equal(setup.financial_finalization_enabled, false);
    const validated = await bridge.step(context.idIntent, context.ownerId, 'validated', lease.handoff.lease_id,
      validatedJwt, { actionCode: 'SUCCESS' });
    assert.equal(validated.state, 'contract_blocked');
    assert.equal(validated.block_code, 'PIXELPAY_SONGBIRD_AUTH_RESULT_UNACCREDITED');
    assert.equal(validated.provider_http_status, 200);
    assert.equal(validated.financial_finalization_enabled, false);
    assert.throws(assertSongbirdFinalizationBlocked, error => error.code === 'PIXELPAY_3DS_FINALIZATION_BLOCKED');
    await assert.rejects(bridge.step(context.idIntent, context.ownerId, 'validated', lease.handoff.lease_id,
      validatedJwt, { actionCode: 'SUCCESS' }), error => error.code === 'SONGBIRD_PHASE_ALREADY_CLAIMED');
    assert.deepEqual(routes, ['api/v2/merchant/public_key', 'api/v2/transaction/sale',
      'api/v2/cardinal/authentication/lookup', 'api/v2/cardinal/authentication/continue']);
    assert.deepEqual(counts, { initialSale: 1, secondSale: 0, lookup: 1, continue: 1, status: 0, sockets: 0, handoffCapture: 1 });
    const publicData = JSON.stringify({ error: initialError, telemetry, setup, validated,
      status: await bridge.status(context.idIntent, context.ownerId) });
    for (const forbidden of [initialJwt, validatedJwt, syntheticSecret, fixture[1].replace(/\D/g, ''), 'card_cvv', 'secretKey']) {
      assert.equal(publicData.includes(forbidden), false);
    }
    assert.equal(sdk.Services.Transaction.prototype.doSale === originalMethods[0], true);
    assert.equal(sdk.Requests.SaleTransaction.prototype.withAuthenticationRequest === originalMethods[1], true);
  } finally {
    axios.defaults.adapter = originalAdapter;
    net.Socket.prototype.connect = originalConnect;
  }
});
