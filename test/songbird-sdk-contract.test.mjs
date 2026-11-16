import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { captureSongbirdSdkContext, createSongbirdSdkContract } from '../src/services/payments/songbirdSdkContract.js';
import { PixelPaySdkProvider } from '../src/services/payments/PixelPaySdkProvider.js';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const nacl = require('tweetnacl');
const axios = require('axios');
const now = Date.now();
const jwt = (payload = {}, header = { alg: 'HS256' }) => [header, { iat: Math.floor(now / 1000), ...payload }]
  .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('c3ludGhldGlj').join('.');
const row = { order_id: 'SYNTHETIC-SONGBIRD-ORDER', amount_hnl: '1.00', currency: 'HNL', authentication_id: 'synthetic-auth' };
const browser = { browser_java_enabled: 'false', browser_javascript_enabled: 'true', browser_language: 'es-HN',
  browser_color_depth: '24', browser_screen_height: '900', browser_screen_width: '1400', browser_time_zone: '360',
  user_agent: 'Synthetic-browser', browser_header: '*/*', ip_address: '127.0.0.1' };

function rig() {
  const merchant = nacl.box.keyPair();
  const publicKey = Buffer.from(merchant.publicKey).toString('base64');
  const sale = new sdk.Requests.SaleTransaction();
  Object.assign(sale, { order_id: row.order_id, order_amount: row.amount_hnl, order_currency: row.currency,
    card_number: 'synthetic-card', card_expire: 'synthetic-expiry', card_cvv: 'synthetic-cvv',
    customer_email: 'synthetic-email', customer_name: 'synthetic-name', billing_country: 'HN' });
  sale.withEncryption(publicKey);
  const context = captureSongbirdSdkContext(sale, { public_key: publicKey });
  const provider = new PixelPaySdkProvider({ endpoint: 'https://pixelpay.dev', env: 'sandbox',
    keyId: 'synthetic-key', authHash: 'c'.repeat(32), secretKey: 'synthetic-secret', appUrl: 'https://pixelpay.dev' });
  const contract = createSongbirdSdkContract({ providerFactory: () => provider, clock: () => now });
  return { context, contract, sale, provider };
}

async function transport(work, reply = {}) {
  const original = axios.defaults.adapter; const connect = net.Socket.prototype.connect;
  let sockets = 0; const requests = [];
  net.Socket.prototype.connect = function () { sockets++; throw new Error('EXTERNAL_FORBIDDEN'); };
  axios.defaults.adapter = async config => {
    requests.push({ route: config.url, body: config.data ? JSON.parse(config.data) : {}, headers: config.headers });
    if (reply.throw) throw new Error('synthetic timeout');
    return { status: reply.status || 200, data: { success: true, ...reply.data }, config, headers: {} };
  };
  try { const result = await work(requests); assert.equal(sockets, 0); return result; }
  finally { axios.defaults.adapter = original; net.Socket.prototype.connect = connect; }
}

test('capture preserves encrypted lookup identity and public keys, never CVV or private key', () => {
  const { context, sale, contract } = rig();
  assert.equal(contract.inspect(jwt(), row, context), true);
  assert.equal(context.encrypted.card_number, sale.card_number);
  assert.equal(Object.hasOwn(context.encrypted, 'card_cvv'), false);
  const serialized = JSON.stringify(context);
  for (const text of ['synthetic-card', 'synthetic-cvv', 'synthetic-email', 'secretKey', 'card_cvv']) assert.equal(serialized.includes(text), false);
  sale.card_number = 'plaintext';
  assert.throws(() => captureSongbirdSdkContext(sale, { public_key: context.merchantPublicKey }));
});

test('inspect binds order, amount, currency and optional token time without asserting signature verification', () => {
  const { context, contract } = rig();
  assert.equal(contract.inspect(jwt(), row, context), true);
  assert.equal(contract.inspect(jwt({ exp: now / 1000 + 10 }), row, context), true);
  assert.equal(contract.inspect(jwt({ order_id: row.order_id }), row, context), true);
  assert.equal(contract.inspect(jwt({ Payload: { OrderDetails: { OrderNumber: row.order_id } } }), row, context), true);
  assert.equal(contract.inspect(jwt({ order_id: 'foreign' }), row, context), false);
  assert.equal(contract.inspect(jwt({ Payload: { OrderDetails: { OrderNumber: 'foreign' } } }), row, context), false);
  for (const token of [jwt({}, { alg: 'none' }), jwt({ exp: now / 1000 - 1 }), jwt({ iat: now / 1000 + 120 }), 'opaque.not.json']) assert.equal(contract.inspect(token, row, context), false);
  for (const change of [{ order_id: 'foreign' }, { amount_hnl: 2 }, { currency: 'USD' }]) assert.equal(contract.inspect(jwt(), { ...row, ...change }, context), false);
  assert.equal(contract.inspect(jwt(), row, { ...context, encrypted: { ...context.encrypted, card_cvv: 'injected' } }), false);
});

test('direct API collection variant is explicit and never retained as a browser handoff', async () => {
  const { sale, context, contract } = rig();
  const direct = captureSongbirdSdkContext(sale, { public_key: context.merchantPublicKey }, { collectionUrl: 'https://untrusted.invalid' });
  assert.equal(direct.collectionUrlPresent, true);
  assert.equal(contract.inspect(jwt(), row, direct), false);
  assert.equal(JSON.stringify(direct).includes('untrusted.invalid'), false);
  await assert.rejects(contract.lookup({ reference: 'ref', attempt: row, context: direct, browser }), error => error.code === 'PIXELPAY_SONGBIRD_DIRECT_API_VARIANT_UNSUPPORTED');
});

test('native lookup posts only its fixed route, same encrypted card identity, original public key, browser EMV and canonical order', async () => {
  const { context, contract } = rig();
  await transport(async requests => {
    const response = await contract.lookup({ reference: 'synthetic-reference', attempt: row, context, browser });
    assert.equal(response.verified, true);
    assert.equal(requests.length, 1);
    const sent = requests[0];
    assert.equal(sent.route, 'api/v2/cardinal/authentication/lookup');
    assert.equal(sent.headers['x-auth-secure'], context.sdkPublicKey);
    assert.equal(Boolean(sent.headers['x-auth-key'] && sent.headers['x-auth-hash'] && sent.headers['x-client-signature']), true);
    assert.equal(sent.body.card_number === context.encrypted.card_number, true);
    assert.equal(Object.hasOwn(sent.body, 'card_cvv'), false);
    assert.equal(Object.hasOwn(sent.body, 'sdk_key_pair'), false);
    assert.equal(sent.body.order_id, row.order_id);
    assert.equal(sent.body.order_amount, '1.00');
    assert.equal(sent.body.browser_language, browser.browser_language);
    assert.equal(sent.body.browser_screen_width, browser.browser_screen_width);
    assert.equal(sent.body.reference, 'synthetic-reference');
    assert.equal(sent.body.env, 'sandbox');
  }, { data: { action: 'continue', data: { identifier: row.authentication_id, continue_url: 'https://centinelapistag.cardinalcommerce.com/challenge', continue_payload: 'synthetic-challenge', transaction_id: 'synthetic-transaction' } } });
});

test('lookup rejects unknown ACS and missing browser context without any financial request', async () => {
  const { context, contract } = rig();
  await transport(async requests => {
    await assert.rejects(contract.lookup({ reference: 'ref', attempt: row, context, browser: {} }));
    assert.equal(requests.length, 0);
    const r = await contract.lookup({ reference: 'ref', attempt: row, context, browser });
    assert.equal(r.verified, false);
    assert.equal(r.blockCode, 'PIXELPAY_SONGBIRD_CHALLENGE_UNACCREDITED');
  }, { data: { action: 'continue', data: { identifier: row.authentication_id, continue_url: 'https://evil.invalid', continue_payload: 'synthetic', transaction_id: 'synthetic' } } });
});

test('native continue is bound to stored authentication identifier; success never authorizes financial finalization', async () => {
  const { contract } = rig(); const token = jwt();
  await transport(async requests => {
    const r = await contract.validate({ jwt: token, attempt: row });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].route, 'api/v2/cardinal/authentication/continue');
    assert.equal(requests[0].body.identifier, row.authentication_id);
    assert.equal(requests[0].body.payload === token, true);
    assert.equal(requests[0].body.authenticate_token, false);
    assert.equal(r.verified, false);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.blockCode, 'PIXELPAY_SONGBIRD_AUTH_RESULT_UNACCREDITED');
    assert.equal(JSON.stringify(r).includes(token), false);
  });
});

for (const scenario of [{ status: 200, data: { success: false } }, { status: 200, data: { success: undefined } }, { status: 403 }, { status: 202 }, { status: 408 }, { status: 429 }, { status: 520 }, { throw: true }]) {
  test(`continue rejects HTTP/transport uncertainty without a Sale (${scenario.status || 'timeout'})`, async () => {
    const { contract } = rig();
    await transport(async requests => {
      const r = await contract.validate({ jwt: jwt(), attempt: row });
      assert.equal(r.verified, false);
      assert.equal(r.blockCode, scenario.status === 403 ? 'PIXELPAY_SONGBIRD_AUTHENTICATION_REJECTED' : 'PIXELPAY_SONGBIRD_CONTINUE_UNCERTAIN');
      assert.equal(r.rejected, scenario.status === 403);
      assert.equal(r.httpStatus, scenario.throw || scenario.status === 520 ? null : scenario.status);
      assert.equal(requests.length, 1);
      assert.equal(requests.some(r => /transaction\/(sale|status|auth)/.test(r.route)), false);
    }, scenario);
  });
}

test('Live/provider mismatch never dispatches an authentication operation', async () => {
  const { context, provider } = rig(); provider.env = 'live';
  const contract = createSongbirdSdkContract({ providerFactory: () => provider });
  await transport(async requests => {
    await assert.rejects(contract.lookup({ reference: 'ref', attempt: row, context, browser }), error => error.code === 'PIXELPAY_SONGBIRD_SANDBOX_REQUIRED');
    assert.equal(requests.length, 0);
  });
});
