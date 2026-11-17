import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { captureSongbirdSdkContext, createSongbirdSdkContract, inspectSongbirdContextCapture, sanitizeSongbirdCaptureDiagnostic } from '../src/services/payments/songbirdSdkContract.js';

const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
const nacl = require('tweetnacl');
const now = Date.now();
const row = { order_id: 'SYNTHETIC-CONTEXT-CAPTURE', amount_hnl: '1.00', currency: 'HNL' };
const secretSentinel = 'SYNTHETIC-PRIVATE-DATA-NEVER-LOG';
const token = (claims = {}, header = { alg: 'HS256' }) => [header,
  { iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600, order_id: row.order_id, ...claims }]
  .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('c3ludGhldGlj').join('.');
const flags = ['jwt_present','jwt_shape_valid','jwt_json_valid','jwt_algorithm_valid','jwt_time_valid','jwt_order_matches',
  'sdk_public_key_present','sdk_public_key_valid','merchant_public_key_present','merchant_public_key_valid',
  'card_number_present','card_number_encrypted','card_expire_present','card_expire_encrypted','optional_encrypted_valid',
  'billing_valid','order_matches','amount_matches','currency_matches','collection_url_present','context_present','context_version_valid'];
const allowedFlags = [...flags, 'jwt_exp_present','jwt_iat_present','sale_request_present',
  'sdk_key_pair_accessor_present','sdk_key_pair_present',
  'jwt_order_id_present','jwt_order_id_is_string','jwt_order_id_matches',
  'jwt_order_number_present','jwt_order_number_is_string','jwt_order_number_matches',
  'jwt_payload_is_object','jwt_payload_is_string'];
const contextRules = {
  'context absent': 'CONTEXT_MISSING', 'context version': 'CONTEXT_VERSION_INVALID',
  'SDK public key missing': 'SDK_PUBLIC_KEY_MISSING', 'SDK public key malformed': 'SDK_PUBLIC_KEY_INVALID',
  'SDK public key unpadded': 'SDK_PUBLIC_KEY_INVALID',
  'merchant public key missing': 'MERCHANT_PUBLIC_KEY_MISSING', 'merchant public key malformed': 'MERCHANT_PUBLIC_KEY_INVALID',
  'merchant public key whitespace': 'MERCHANT_PUBLIC_KEY_INVALID',
  'card number missing': 'CARD_NUMBER_MISSING', 'card number plaintext': 'CARD_NUMBER_CIPHERTEXT_INVALID',
  'card expiry missing': 'CARD_EXPIRE_MISSING', 'card expiry plaintext': 'CARD_EXPIRE_CIPHERTEXT_INVALID',
  'optional encrypted plaintext': 'OPTIONAL_CIPHERTEXT_INVALID', 'optional encrypted null': 'OPTIONAL_CIPHERTEXT_INVALID',
  'billing field malformed': 'BILLING_FIELDS_INVALID',
  'canonical order mismatch': 'ORDER_MISMATCH', 'canonical amount mismatch': 'AMOUNT_MISMATCH',
  'canonical currency mismatch': 'CURRENCY_MISMATCH',
};
const jwtRules = {
  'JWT absent': 'JWT_MISSING', 'JWT malformed': 'JWT_SHAPE_INVALID', 'JWT JSON malformed': 'JWT_JSON_INVALID',
  'JWT unsigned algorithm': 'JWT_ALGORITHM_UNSUPPORTED', 'JWT expired': 'JWT_EXPIRED',
  'JWT future timestamp': 'JWT_IAT_FUTURE', 'JWT stale timestamp': 'JWT_IAT_STALE',
  'JWT contradictory order': 'JWT_ORDER_MISMATCH',
};

function nativeFixture() {
  const publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  const sale = new sdk.Requests.SaleTransaction();
  Object.assign(sale, { order_id: row.order_id, order_amount: '1', order_currency: 'HNL',
    card_number: 'synthetic-number', card_expire: 'synthetic-expiry', card_cvv: 'synthetic-cvv',
    customer_name: secretSentinel, customer_email: 'fixture@example.invalid', billing_country: 'HN' });
  sale.withEncryption(publicKey);
  const settings = { public_key: publicKey };
  return { sale, settings, context: captureSongbirdSdkContext(sale, settings) };
}

function assertSafeDiagnostic(diagnostic, forbidden = []) {
  assert.deepEqual(Object.keys(diagnostic).sort(), ['accepted','flags','rule','stage']);
  assert.equal(typeof diagnostic.accepted, 'boolean');
  assert.equal(typeof diagnostic.stage, 'string');
  assert.equal(typeof diagnostic.rule, 'string');
  assert.equal(Object.values(diagnostic.flags).every(value => typeof value === 'boolean'), true);
  assert.equal(Object.keys(diagnostic.flags).every(name => allowedFlags.includes(name)), true);
  const output = JSON.stringify(diagnostic);
  for (const value of [secretSentinel, 'synthetic-number', 'synthetic-cvv', 'fixture@example.invalid', ...forbidden]) {
    if (value) assert.equal(output.includes(value), false);
  }
}

test('native SDK encryption and capture remain intact; context diagnostics contain only codes/boolean flags', () => {
  const { sale, settings, context } = nativeFixture();
  const keyPair = sale.getSDKKeyPair();
  const captured = [];
  const observed = captureSongbirdSdkContext(sale, settings, { onDiagnostic: value => captured.push(value) });
  assert.deepEqual(observed, context);
  assert.equal(sale.getSDKKeyPair(), keyPair);
  assert.equal(settings.public_key, context.merchantPublicKey);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].stage, 'context_capture');
  assert.equal(captured[0].accepted, true);
  assert.equal(captured[0].rule, 'VALID');
  const jwt = token({ sensitiveFixture: secretSentinel });
  const result = inspectSongbirdContextCapture(jwt, row, context, { now });
  assert.equal(result.accepted, true);
  for (const key of flags.filter(name => name !== 'collection_url_present')) assert.equal(result.flags[key], true);
  assert.equal(result.flags.collection_url_present, false);
  assert.equal(result.flags.jwt_exp_present, true);
  assert.equal(result.flags.jwt_iat_present, true);
  for (const result of [...captured, inspectSongbirdContextCapture(jwt, row, context, { now })]) {
    assertSafeDiagnostic(result, [jwt, context.sdkPublicKey, context.merchantPublicKey,
      Buffer.from(keyPair.secretKey).toString('base64'), ...Object.values(context.encrypted)]);
  }
});

for (const scenario of [
  { name: 'context absent', change: () => null, flag: 'context_present' },
  { name: 'context version', change: c => ({ ...c, version: 2 }), flag: 'context_version_valid' },
  { name: 'SDK public key missing', change: c => ({ ...c, sdkPublicKey: null }), flag: 'sdk_public_key_present' },
  { name: 'SDK public key malformed', change: c => ({ ...c, sdkPublicKey: 'invalid' }), flag: 'sdk_public_key_valid' },
  { name: 'SDK public key unpadded', change: c => ({ ...c, sdkPublicKey: c.sdkPublicKey.replace(/=+$/, '') }), flag: 'sdk_public_key_valid' },
  { name: 'merchant public key missing', change: c => ({ ...c, merchantPublicKey: null }), flag: 'merchant_public_key_present' },
  { name: 'merchant public key malformed', change: c => ({ ...c, merchantPublicKey: 'invalid' }), flag: 'merchant_public_key_valid' },
  { name: 'merchant public key whitespace', change: c => ({ ...c, merchantPublicKey: ` ${c.merchantPublicKey}` }), flag: 'merchant_public_key_valid' },
  { name: 'card number missing', change: c => ({ ...c, encrypted: { ...c.encrypted, card_number: undefined } }), flag: 'card_number_present' },
  { name: 'card number plaintext', change: c => ({ ...c, encrypted: { ...c.encrypted, card_number: secretSentinel } }), flag: 'card_number_encrypted' },
  { name: 'card expiry missing', change: c => ({ ...c, encrypted: { ...c.encrypted, card_expire: undefined } }), flag: 'card_expire_present' },
  { name: 'card expiry plaintext', change: c => ({ ...c, encrypted: { ...c.encrypted, card_expire: secretSentinel } }), flag: 'card_expire_encrypted' },
  { name: 'optional encrypted plaintext', change: c => ({ ...c, encrypted: { ...c.encrypted, customer_name: secretSentinel } }), flag: 'optional_encrypted_valid' },
  { name: 'optional encrypted null', change: c => ({ ...c, encrypted: { ...c.encrypted, customer_name: null } }), flag: 'optional_encrypted_valid' },
  { name: 'billing field malformed', change: c => ({ ...c, billing: { billing_country: 123 } }), flag: 'billing_valid' },
  { name: 'canonical order mismatch', change: c => ({ ...c, order: { ...c.order, id: 'OTHER-ORDER' } }), flag: 'order_matches' },
  { name: 'canonical amount mismatch', change: c => ({ ...c, order: { ...c.order, amount: '2' } }), flag: 'amount_matches' },
  { name: 'canonical currency mismatch', change: c => ({ ...c, order: { ...c.order, currency: 'USD' } }), flag: 'currency_matches' },
]) test(`capture rejection identifies ${scenario.name} without relaxing its validation`, () => {
  const { context } = nativeFixture();
  const invalidContext = scenario.change(context);
  const result = inspectSongbirdContextCapture(token(), row, invalidContext, { now });
  const contract = createSongbirdSdkContract({ clock: () => now,
    providerFactory() { throw new Error('PROVIDER_MUST_NOT_BE_CREATED'); } });
  assert.equal(result.accepted, false);
  assert.equal(contract.inspect(token(), row, invalidContext), result.accepted);
  assert.deepEqual(contract.inspectCapture(token(), row, invalidContext), result);
  assert.equal(result.rule, contextRules[scenario.name]);
  assert.equal(result.flags[scenario.flag], false);
  assertSafeDiagnostic(result, [token(), context.sdkPublicKey, context.merchantPublicKey, ...Object.values(context.encrypted)]);
});

for (const scenario of [
  { name: 'JWT absent', value: null, flag: 'jwt_present' },
  { name: 'JWT malformed', value: 'invalid', flag: 'jwt_shape_valid' },
  { name: 'JWT JSON malformed', value: 'c3ludGhldGlj.c3ludGhldGlj.c3ludGhldGlj', flag: 'jwt_json_valid' },
  { name: 'JWT unsigned algorithm', value: token({}, { alg: 'none' }), flag: 'jwt_algorithm_valid' },
  { name: 'JWT expired', value: token({ exp: Math.floor(now / 1000) - 10 }), flag: 'jwt_time_valid' },
  { name: 'JWT future timestamp', value: token({ iat: Math.floor(now / 1000) + 120 }), flag: 'jwt_time_valid' },
  { name: 'JWT stale timestamp', value: token({ iat: Math.floor(now / 1000) - 600 }), flag: 'jwt_time_valid' },
  { name: 'JWT contradictory order', value: token({ order_id: 'OTHER-ORDER' }), flag: 'jwt_order_matches' },
]) test(`JWT rejection identifies ${scenario.name} without returning its value`, () => {
  const { context } = nativeFixture();
  const result = inspectSongbirdContextCapture(scenario.value, row, context, { now });
  assert.equal(result.accepted, false);
  assert.equal(result.rule, jwtRules[scenario.name]);
  assert.equal(result.flags[scenario.flag], false);
  assertSafeDiagnostic(result, [scenario.value, context.sdkPublicKey, context.merchantPublicKey, ...Object.values(context.encrypted)]);
});

test('unsupported collection_url remains an explicit blocked variant with no browser URL retained', () => {
  const { sale, settings } = nativeFixture();
  const observations = [];
  const context = captureSongbirdSdkContext(sale, settings, { collectionUrl: 'https://unsupported.invalid', onDiagnostic: value => observations.push(value) });
  const result = inspectSongbirdContextCapture(token(), row, context, { now });
  assert.equal(result.accepted, false);
  assert.equal(result.rule, 'COLLECTION_URL_UNSUPPORTED');
  assert.equal(result.flags.collection_url_present, true);
  assert.equal(JSON.stringify(context).includes('unsupported.invalid'), false);
  for (const diagnostic of [...observations, result]) assertSafeDiagnostic(diagnostic, [token(), 'unsupported.invalid']);
});

test('Cardinal OrderNumber is observational; explicit merchant order_id and captured context remain binding', () => {
  const { context } = nativeFixture();
  const contract = createSongbirdSdkContract({ clock: () => now,
    providerFactory() { throw new Error('PROVIDER_MUST_NOT_BE_CREATED'); } });
  const cases = [
    { value: undefined, present: false, string: false, matches: false, allowed: true },
    { value: row.order_id, present: true, string: true, matches: true, allowed: true },
    { value: secretSentinel, present: true, string: true, matches: false, allowed: false },
    { value: null, present: true, string: false, matches: false, allowed: false },
    { value: '', present: true, string: true, matches: false, allowed: false },
    { value: 17, present: true, string: false, matches: false, allowed: false },
  ];
  const connect = net.Socket.prototype.connect;
  let sockets = 0;
  net.Socket.prototype.connect = function () { sockets++; throw new Error('EXTERNAL_IO_FORBIDDEN'); };
  try {
    for (const top of cases) for (const nested of cases) {
      const jwt = token({ order_id: top.value, Payload: { OrderDetails: { OrderNumber: nested.value } } });
      const result = inspectSongbirdContextCapture(jwt, row, context, { now });
      const expected = {
        jwt_order_id_present: top.present, jwt_order_id_is_string: top.string, jwt_order_id_matches: top.matches,
        jwt_order_number_present: nested.present, jwt_order_number_is_string: nested.string, jwt_order_number_matches: nested.matches,
        jwt_payload_is_object: true, jwt_payload_is_string: false,
      };
      for (const [key, value] of Object.entries(expected)) assert.equal(result.flags[key], value);
      assert.equal(result.accepted, top.allowed);
      assert.equal(result.flags.jwt_order_matches, top.allowed);
      assert.equal(result.rule, result.accepted ? 'VALID' : 'JWT_ORDER_MISMATCH');
      assert.equal(contract.inspect(jwt, row, context), result.accepted);
      assertSafeDiagnostic(sanitizeSongbirdCaptureDiagnostic(result), [jwt, row.order_id]);
    }
    assert.equal(sockets, 0);
  } finally { net.Socket.prototype.connect = connect; }
});

test('stringified Cardinal Payload is reported as such without normalizing it or replacing the existing nested claim path', () => {
  const { context } = nativeFixture();
  const jwt = token({ order_id: undefined, ObjectifyPayload: false,
    Payload: JSON.stringify({ OrderDetails: { OrderNumber: secretSentinel } }) });
  const result = inspectSongbirdContextCapture(jwt, row, context, { now });
  assert.equal(result.flags.jwt_payload_is_string, true);
  assert.equal(result.flags.jwt_payload_is_object, false);
  assert.equal(result.flags.jwt_order_id_present, false);
  assert.equal(result.flags.jwt_order_number_present, false);
  assert.equal(result.flags.jwt_order_number_matches, false);
  // AM: Characterize the existing gate; do not introduce an undocumented normalization policy.
  assert.equal(result.flags.jwt_order_matches, true);
  assert.equal(result.accepted, true);
  assertSafeDiagnostic(result, [jwt, secretSentinel]);
});

test('numerically equivalent order identifiers still fail strict comparison; no coercion is introduced', () => {
  const { context } = nativeFixture();
  const numericRow = { ...row, order_id: '17' };
  const numericContext = { ...context, order: { ...context.order, id: '17' } };
  const result = inspectSongbirdContextCapture(token({ order_id: 17 }), numericRow, numericContext, { now });
  assert.equal(result.flags.order_matches, true);
  assert.equal(result.flags.jwt_order_id_present, true);
  assert.equal(result.flags.jwt_order_id_is_string, false);
  assert.equal(result.flags.jwt_order_id_matches, false);
  assert.equal(result.rule, 'JWT_ORDER_MISMATCH');
  assert.equal(result.accepted, false);
});

test('malformed JWT JSON cannot supply positive claim indicators and diagnostics do not attest signature verification', () => {
  const { context } = nativeFixture();
  const invalid = inspectSongbirdContextCapture('synthetic.invalid.signature', row, context, { now });
  for (const name of allowedFlags.filter(name => /^jwt_order_(id|number)_|^jwt_payload_is_/.test(name))) {
    assert.equal(invalid.flags[name], false);
  }
  // AM: The synthetic suffix is not a valid HMAC; existing acceptance is structural, not cryptographic proof.
  const structural = inspectSongbirdContextCapture(token(), row, context, { now });
  assert.equal(structural.accepted, true);
  assert.equal(Object.hasOwn(structural.flags, 'jwt_signature_verified'), false);
  const sanitized = sanitizeSongbirdCaptureDiagnostic({ ...structural,
    flags: { ...structural.flags, jwt_order_id_present: secretSentinel,
      jwt_order_number_matches: secretSentinel, jwt_signature_verified: true } });
  assert.equal(Object.hasOwn(sanitized.flags, 'jwt_order_id_present'), false);
  assert.equal(Object.hasOwn(sanitized.flags, 'jwt_order_number_matches'), false);
  assert.equal(Object.hasOwn(sanitized.flags, 'jwt_signature_verified'), false);
  assertSafeDiagnostic(sanitized);
});

test('a malformed capture-input accessor exception is diagnosed without logging its error or request values', () => {
  const { sale, settings } = nativeFixture();
  const observations = [];
  // AM: This malformed plain input is separate from the unchanged native SDK instance/prototype.
  const malformed = { ...sale };
  Object.defineProperty(malformed, 'getSDKKeyPair', { get() { throw new Error(secretSentinel); } });
  assert.throws(() => captureSongbirdSdkContext(malformed, settings, { onDiagnostic: value => observations.push(value) }));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].accepted, false);
  assert.equal(observations[0].stage, 'context_capture');
  assert.equal(observations[0].rule, 'CAPTURE_EXCEPTION');
  assertSafeDiagnostic(observations[0]);
});

test('diagnostic acceptance exactly matches the adapter gate and cannot trigger network IO', () => {
  const { context } = nativeFixture();
  const contract = createSongbirdSdkContract({ providerFactory() { throw new Error('PROVIDER_MUST_NOT_BE_CREATED'); }, clock: () => now });
  const originalConnect = net.Socket.prototype.connect;
  let sockets = 0;
  net.Socket.prototype.connect = function () { sockets++; throw new Error('EXTERNAL_IO_FORBIDDEN'); };
  try {
    for (const value of [token(), token({ exp: now / 1000 - 1 }), 'invalid', null]) {
      const diagnosis = inspectSongbirdContextCapture(value, row, context, { now });
      assert.equal(contract.inspect(value, row, context), diagnosis.accepted);
      assert.deepEqual(contract.inspectCapture(value, row, context), diagnosis);
    }
    assert.equal(sockets, 0);
  } finally { net.Socket.prototype.connect = originalConnect; }
});

test('untrusted diagnostic stage input cannot become a log value', () => {
  const { context } = nativeFixture();
  const result = inspectSongbirdContextCapture(token(), row, context, { now, captureStage: secretSentinel });
  assert.equal(result.accepted, true);
  assert.notEqual(result.stage, secretSentinel);
  assertSafeDiagnostic(result, [token(), context.sdkPublicKey, context.merchantPublicKey]);
});

test('diagnostic callback failure never changes valid capture or the SDK objects', () => {
  const { sale, settings, context } = nativeFixture();
  const pair = sale.getSDKKeyPair();
  const captured = captureSongbirdSdkContext(sale, settings, { onDiagnostic() { throw new Error(secretSentinel); } });
  assert.deepEqual(captured, context);
  assert.equal(sale.getSDKKeyPair(), pair);
});

test('diagnostic sanitizer drops raw data and accepts only known codes, stages and boolean flags', () => {
  const { context } = nativeFixture();
  const jwt = token({ confidentialFixture: secretSentinel });
  const result = sanitizeSongbirdCaptureDiagnostic({ accepted: false, stage: 'context_validation', rule: 'CONTEXT_MISSING',
    payload: jwt, context, error: { message: secretSentinel },
    flags: { context_present: false, card_number_encrypted: true, jwt_present: secretSentinel, extra: context.encrypted.card_number } });
  assert.deepEqual(result, { accepted: false, stage: 'context_validation', rule: 'CONTEXT_MISSING',
    flags: { context_present: false, card_number_encrypted: true } });
  assertSafeDiagnostic(result, [jwt, context.sdkPublicKey, context.merchantPublicKey, ...Object.values(context.encrypted)]);
  assert.equal(sanitizeSongbirdCaptureDiagnostic({ accepted: false, stage: secretSentinel, rule: 'CONTEXT_MISSING', flags: {} }), null);
  assert.equal(sanitizeSongbirdCaptureDiagnostic({ accepted: false, stage: 'context_validation', rule: secretSentinel, flags: {} }), null);
  assert.equal(sanitizeSongbirdCaptureDiagnostic({ accepted: secretSentinel, stage: 'context_validation', rule: 'CONTEXT_MISSING', flags: {} }), null);
});
