import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { captureSongbirdSdkContext, createSongbirdSdkContract } from '../src/services/payments/songbirdSdkContract.js';
import { PixelPaySdkProvider } from '../src/services/payments/PixelPaySdkProvider.js';
import { SongbirdBridge } from '../src/services/payments/songbirdBridge.js';
import { assertSongbirdFinalizationBlocked } from '../src/services/payments/songbirdContract.js';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const nacl = require('tweetnacl');
const axios = require('axios');
const CardinalAuthentication = require('@pixelpay/sdk-core/lib/services/CardinalAuthentication.js').default;
const now = Date.now();
const jwt = (payload = {}, header = { alg: 'HS256' }) => [header, { iat: Math.floor(now / 1000), ...payload }]
  .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('c3ludGhldGlj').join('.');
const row = { id_intent: '11111111-1111-4111-8111-111111111111', payment_attempt_id: '22222222-2222-4222-8222-222222222222',
  order_id: 'SYNTHETIC-SONGBIRD-ORDER', amount_hnl: '1.00', currency: 'HNL', authentication_id: 'synthetic-auth' };
const browser = { browser_java_enabled: 'false', browser_javascript_enabled: 'true', browser_language: 'es-HN',
  browser_color_depth: '24', browser_screen_height: '900', browser_screen_width: '1400', browser_time_zone: '360',
  user_agent: 'Synthetic-browser', browser_header: '*/*', ip_address: '127.0.0.1' };

const challenge = { identifier: row.authentication_id, transaction_id: 'synthetic-transaction',
  continue_url: 'https://centinelapistag.cardinalcommerce.com/challenge', continue_payload: 'synthetic-challenge' };
const lookupReply = (status, data = {}) => ({ status, data: { action: 'continue', data: challenge, ...data } });

function rig(options = {}) {
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
  const contract = createSongbirdSdkContract({ providerFactory: () => provider, clock: () => now, ...options });
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
  assert.equal(contract.inspect(jwt({ Payload: { OrderDetails: { OrderNumber: 'provider-order' } } }), row, context), true);
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

for (const scenario of [
  { name: 'false success', data: { success: false } },
  { name: 'missing success', data: { success: undefined } },
  { name: 'string success', data: { success: 'true' } },
  { name: 'missing action', data: { action: undefined } },
  { name: 'terminal action', data: { action: 'token_auth_success' } },
  ...Object.keys(challenge).map(field => ({ name: `missing ${field}`, data: { data: { ...challenge, [field]: undefined } } })),
  { name: 'invalid identifier', data: { data: { ...challenge, identifier: 'invalid identifier' } } },
  { name: 'oversized payload', data: { data: { ...challenge, continue_payload: 'x'.repeat(16001) } } },
  ...['https://evil.invalid/challenge', 'https://songbird.cardinalcommerce.com/challenge',
    'https://user@centinelapistag.cardinalcommerce.com/challenge',
    'https://centinelapistag.cardinalcommerce.com/challenge#fragment'].map(continue_url => ({
    name: `forbidden ACS ${continue_url}`, data: { data: { ...challenge, continue_url } },
  })),
]) {
  test(`HTTP 202 lookup blocks ${scenario.name} without financial requests`, async () => {
    const { context, contract } = rig();
    await transport(async requests => {
      const result = await contract.lookup({ reference: 'ref', attempt: row, context, browser });
      assert.equal(result.verified, false);
      assert.equal(result.httpStatus, 202);
      assert.equal(Object.hasOwn(result, 'challenge'), false);
      assert.deepEqual(requests.map(request => request.route), ['api/v2/cardinal/authentication/lookup']);
    }, lookupReply(202, scenario.data));
  });
}

test('HTTP 202 requires the SDK PayloadResponse class rather than a matching shape or class name', async () => {
  const { context, contract } = rig();
  const original = CardinalAuthentication.prototype.authenticationLookup;
  CardinalAuthentication.prototype.authenticationLookup = async () => ({ status: 202, success: true, action: 'continue',
    data: challenge, constructor: { name: 'PayloadResponse' } });
  try {
    await transport(async requests => {
      const result = await contract.lookup({ reference: 'ref', attempt: row, context, browser });
      assert.equal(result.verified, false);
      assert.equal(result.blockCode, 'PIXELPAY_SONGBIRD_LOOKUP_UNCERTAIN');
      assert.equal(requests.length, 0);
    });
  } finally { CardinalAuthentication.prototype.authenticationLookup = original; }
});

class LookupRepository {
  async reserve(_client, value) { this.row = structuredClone(value); return this.row; }
  async mutate(id, owner, work) {
    assert.equal(id, this.row.id_intent); assert.equal(owner, this.row.owner_id);
    const next = structuredClone(this.row); next.version++;
    const result = await work(next); this.row = next; return result;
  }
}

for (const scenario of [{ status: 200, valid: true }, { status: 202, valid: true }, { status: 202, valid: false }]) {
  test(`native lookup HTTP ${scenario.status} ${scenario.valid ? 'valid' : 'invalid'} follows the bridge claim/setup state without Sale or financial confirmation`, async () => {
    const { context, contract } = rig(); const repository = new LookupRepository();
    const owner = '33333333-3333-4333-8333-333333333333';
    const bridge = new SongbirdBridge({ repository, config: { enabled: true, key: Buffer.alloc(32, 8), ttlMs: 600000 }, contract, clock: () => now });
    await bridge.reserve(null, { idIntent: row.id_intent, paymentAttemptId: row.payment_attempt_id, ownerId: owner,
      groupId: '44444444-4444-4444-8444-444444444444', orderId: row.order_id,
      amount: row.amount_hnl, currency: row.currency, expiresAt: new Date(now + 600000).toISOString() });
    assert.equal((await bridge.capture(row.id_intent, owner, jwt(), context)).state, 'handoff_ready');
    const lease = await bridge.claim(row.id_intent, owner);
    assert.equal(lease.state, 'browser_leased');
    await transport(async requests => {
      const setup = await bridge.step(row.id_intent, owner, 'setup', lease.handoff.lease_id, 'synthetic-reference', {
        emv: browser, ipAddress: browser.ip_address, httpAccept: browser.browser_header,
      });
      assert.equal(setup.state, scenario.valid ? 'challenge_ready' : 'contract_blocked');
      assert.equal(setup.provider_http_status, scenario.status);
      assert.equal(setup.financial_finalization_enabled, false);
      assert.equal(repository.row.context_box, null);
      await assert.rejects(bridge.step(row.id_intent, owner, 'setup', lease.handoff.lease_id, 'synthetic-reference'),
        error => error.code === 'SONGBIRD_PHASE_ALREADY_CLAIMED');
      assert.deepEqual(requests.map(request => request.route), ['api/v2/cardinal/authentication/lookup']);
      assert.throws(assertSongbirdFinalizationBlocked, error => error.code === 'PIXELPAY_3DS_FINALIZATION_BLOCKED');
    }, lookupReply(scenario.status, scenario.valid ? {} : { data: { ...challenge, continue_payload: undefined } }));
  });
}

test('lookup diagnostics correlate native response class and booleans without sensitive data', async () => {
  const telemetry = [];
  const { context, contract } = rig({ logger: { info: fields => telemetry.push(fields) } });
  await transport(async () => {
    assert.equal((await contract.lookup({ reference: 'ref', attempt: row, context, browser })).verified, true);
  }, lookupReply(202, { message: 'SENSITIVE-PROVIDER-MESSAGE', data: { ...challenge, jwt: jwt(), secretKey: 'SENSITIVE-PROVIDER-SECRET' } }));
  assert.equal(telemetry.length, 1);
  assert.deepEqual(telemetry[0], {
    event: 'PIXELPAY_SONGBIRD_LOOKUP_DIAGNOSTIC', id_intent: row.id_intent, paymentAttemptId: row.payment_attempt_id,
    provider_http_status: 202, acs_origin: 'https://centinelapistag.cardinalcommerce.com', response_class: 'PayloadResponse', success: true, success_is_boolean: true, action: 'continue',
    fields: { identifier_present: true, identifier_valid: true, transaction_id_present: true, transaction_id_valid: true,
      continue_payload_present: true, continue_payload_valid: true, continue_url_present: true, continue_url_valid: true,
      acs_origin_allowed: true, challenge_valid: true }, financial_finalization_enabled: false,
  });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of [jwt(), challenge.continue_payload, challenge.continue_url, challenge.identifier,
    challenge.transaction_id, context.encrypted.card_number, context.sdkPublicKey, 'synthetic-secret',
    'SENSITIVE-PROVIDER-MESSAGE', 'SENSITIVE-PROVIDER-SECRET', 'card_cvv', 'secretKey']) assert.equal(serialized.includes(forbidden), false);
});

test('lookup diagnostics normalize unknown action and nonboolean success without leaking their values', async () => {
  const telemetry = [];
  const { context, contract } = rig({ logger: { info: fields => telemetry.push(fields) } });
  await transport(async () => {
    assert.equal((await contract.lookup({ reference: 'ref', attempt: row, context, browser })).verified, false);
  }, lookupReply(202, { success: 'SENSITIVE-SUCCESS', action: 'SENSITIVE-ACTION' }));
  assert.equal(telemetry[0].success, false);
  assert.equal(telemetry[0].success_is_boolean, false);
  assert.equal(telemetry[0].action, 'other');
  assert.equal(JSON.stringify(telemetry).includes('SENSITIVE-'), false);
});

test('a throwing diagnostic logger cannot change acceptance of a valid HTTP 202 lookup', async () => {
  const { context, contract } = rig({ logger: { info() { throw new Error('LOGGER_FAILURE'); } } });
  await transport(async requests => {
    assert.equal((await contract.lookup({ reference: 'ref', attempt: row, context, browser })).verified, true);
    assert.equal(requests.length, 1);
  }, lookupReply(202));
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

for (const [url, origin] of [
  ['https://user:password@ACS.Example.invalid:8443/private?jwt=SENSITIVE#fragment','https://acs.example.invalid:8443'],
  ['https://ACS.Example.invalid:443/private?payload=SENSITIVE','https://acs.example.invalid'],
  ['http://acs.example.invalid/private',null], ['not-a-url-SENSITIVE',null],
]) test('ACS diagnostic retains only normalized HTTPS origin',async()=>{
  const telemetry=[];const {context,contract}=rig({logger:{info:fields=>telemetry.push(fields)}});
  await transport(async()=>{
    const result=await contract.lookup({reference:'ref',attempt:row,context,browser});
    assert.equal(result.verified,false);
  },lookupReply(202,{data:{...challenge,continue_url:url}}));
  assert.equal(telemetry[0].acs_origin,origin);
  assert.equal(telemetry[0].fields.acs_origin_allowed,false);
  for(const secret of ['password','private','SENSITIVE','fragment'])assert.equal(JSON.stringify(telemetry).includes(secret),false);
});

for (const [origin, allowed] of [
  ['https://cas.client.cardinaltrusted.com', true],
  ['https://client.cardinaltrusted.com', false],
  ['https://evil.cas.client.cardinaltrusted.com', false],
  ['https://cas.client.cardinaltrusted.com.evil.invalid', false],
  ['http://cas.client.cardinaltrusted.com', false],
  ['https://cas.client.cardinaltrusted.com:8443', false],
]) test('CAS origin policy: '+origin, async()=>{
  const {context,contract}=rig();
  await transport(async requests=>{
    const result=await contract.lookup({reference:'ref',attempt:row,context,browser});
    assert.equal(result.verified,allowed);
    assert.deepEqual(requests.map(r=>r.route),['api/v2/cardinal/authentication/lookup']);
  },lookupReply(202,{data:{...challenge,continue_url:origin+'/merchantacs/threeds/v2/creq'}}));
});
