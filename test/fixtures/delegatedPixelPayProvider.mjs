import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import net from 'node:net';
const require = createRequire(import.meta.url);
const axios = require('axios');
const nacl = require('tweetnacl');

export function desktopContext(orderId = 'A', scenario = 'challenge') {
  return { attemptId: `attempt-${orderId}`, scenario,
    config: { env: 'live', endpoint: 'https://offline-pixelpay.invalid', appUrl: 'https://offline-shop.invalid',
      keyId: 'synthetic-key', authHash: 'synthetic-hash', secretKey: 'synthetic-secret' },
    input: { orderId, currency: 'HNL', amount: 1, items: [{ code: 'test', title: 'Fixture', qty: 1, price: 1 }],
      customer: { name: 'Fixture', email: 'fixture@example.invalid' },
      billing: { address: 'Synthetic address', country: 'HN', state: 'HN-CR', city: 'SPS', phone: '99999999' },
      card: { number: '4111111111111111', holder: 'Fixture', expire: '3007', cvv: '999' } } };
}

// AM: Only the test transport is synthetic; SDK constructors, encryption and service methods remain native.
export function installSyntheticProvider(context) {
  if (typeof globalThis.window !== 'undefined' || typeof globalThis.document !== 'undefined') throw new Error('NODE_DOM_FORBIDDEN');
  const nativeConnect = net.Socket.prototype.connect, nativeFetch = globalThis.fetch, adapter = axios.defaults.adapter;
  const merchant = nacl.box.keyPair();
  const stats = { externalSockets: 0, initialSales: 0, retries: 0, lookups: 0, continues: 0,
    cryptoContextMatches: true, credentialsInNode: true, orders: [] };
  if (context.application) stats.directLookupCvvMatches = null;
  let initialPublicKey, initialCiphertext;
  net.Socket.prototype.connect = function () { stats.externalSockets++; throw new Error('EXTERNAL_BLOCKED'); };
  globalThis.fetch = async () => { stats.externalSockets++; throw new Error('EXTERNAL_BLOCKED'); };
  const decode = value => Uint8Array.from(Buffer.from(value, 'base64'));
  function checkCrypto(body, publicKey) {
    const [box, nonce] = String(body.card_number).split('|');
    const clear = nacl.box.open(decode(box), decode(nonce), decode(publicKey), merchant.secretKey);
    const matched = clear && Buffer.from(clear).toString() === context.input.card.number;
    stats.cryptoContextMatches &&= Boolean(matched && (!initialPublicKey || initialPublicKey === publicKey)
      && (!initialCiphertext || initialCiphertext === body.card_number));
    initialPublicKey ||= publicKey;
    initialCiphertext ||= body.card_number;
  }
  axios.defaults.adapter = async config => {
    if (config.baseURL !== context.config.endpoint) throw new Error('UNEXPECTED_ENDPOINT');
    stats.credentialsInNode &&= config.headers['x-auth-key'] === context.config.keyId
      && config.headers['x-auth-hash'] === context.config.authHash;
    const body = config.data ? JSON.parse(config.data) : {};
    const reply = (status, data, action = null, success = true) => ({ config, status, headers: {}, data: { success, action, data } });
    const approvedData = {
      response_approved: context.scenario !== 'declined', response_incomplete: false, response_code: '00',
      transaction_amount: context.input.amount,
      transaction_approved_amount: context.scenario === 'bad-amount' ? context.input.amount + 1 : context.input.amount,
      transaction_id: `tx-${context.input.orderId}`, payment_uuid: `uuid-${context.input.orderId}`,
      payment_hash: createHash('md5').update([context.input.orderId, context.config.keyId, context.config.secretKey].join('|')).digest('hex'),
    };
    if (config.url.endsWith('public_key')) return reply(200, { public_key: Buffer.from(merchant.publicKey).toString('base64') });
    if (config.url.endsWith('transaction/status')) {
      if (body.payment_uuid !== approvedData.payment_uuid) throw new Error('STATUS_UUID_MISMATCH');
      return reply(200, { status: 'PAID', payment_uuid: approvedData.payment_uuid, order_id: context.input.orderId,
        ...(context.scenario === 'missing-status-currency' ? {} : { order_currency: context.input.currency }),
        last_response: { data: approvedData } });
    }
    if (config.url.endsWith('authentication/continue')) {
      stats.continues++;
      if (body.identifier !== `auth-${context.input.orderId}`) throw new Error('CONTEXT_MISMATCH');
      return reply(200, {}, null, context.scenario !== 'continue-false');
    }
    if (body.order_id !== context.input.orderId || Number(body.order_amount) !== context.input.amount
      || body.order_currency !== context.input.currency) throw new Error('CONTEXT_MISMATCH');
    checkCrypto(body, config.headers['x-auth-secure']);
    stats.orders.push(body.order_id);
    if (config.url.endsWith('lookup')) {
      stats.lookups++;
      if (context.application) {
        const [box, nonce] = String(body.card_cvv).split('|');
        const cvv = nonce && nacl.box.open(decode(box), decode(nonce), decode(config.headers['x-auth-secure']), merchant.secretKey);
        stats.directLookupCvvMatches = Boolean(cvv && Buffer.from(cvv).toString() === context.input.card.cvv);
      }
      const challengeUrl = context.application ? 'https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/StepUp?n=%2B%2F'
        : 'https://acs.offline.invalid';
      return reply(context.application && !['frictionless', 'challenge-http-200'].includes(context.scenario) ? 202 : 200, {
        identifier: context.scenario === 'invalid-lookup-identifier' ? { unexpected: true } : `auth-${body.order_id}`,
        continue_url: context.scenario === 'invalid-step-up' ? 'https://acs.offline.invalid' : challengeUrl,
        continue_payload: 'opaque.+/=%ñ', transaction_id: `tx-${body.order_id}`, window_size: '03',
      }, context.scenario === 'frictionless' ? null : 'continue', context.scenario !== 'lookup-not-successful');
    }
    if (!config.url.endsWith('transaction/sale')) throw new Error('UNEXPECTED_ROUTE');
    if (!body.authentication_identifier) {
      stats.initialSales++;
      if (context.scenario !== 'no-3ds') {
        const collectionPathVersion = context.scenario === 'challenge-http-200' ? 'V2' : 'V1';
        const collectionUrl = `https://cas.client.cardinaltrusted.com/centinelapi/${collectionPathVersion}/Cruise/Collect?n=%2B%2F`;
        const collection = {
          'collection-absent': undefined, 'collection-top-level': undefined, 'collection-null': null,
          'collection-empty': '', 'collection-object': { url: collectionUrl },
          'collection-untrusted': 'https://example.invalid/collection',
          'collection-invalid-path': 'https://cas.client.cardinaltrusted.com/other',
        };
        const collectionValue = Object.hasOwn(collection, context.scenario) ? collection[context.scenario] : collectionUrl;
        const response = reply(202, { transaction_type: 'songbird', payload: `opaque-setup-${body.order_id}`,
          payment_uuid: context.scenario === 'bad-uuid' ? 'different-uuid' : `uuid-${body.order_id}`,
          ...(context.application && collectionValue !== undefined ? { collection_url: collectionValue } : {}) });
        response.headers['cf-ray'] = '0123456789abcdef-TPA';
        if (context.scenario === 'collection-top-level') response.data.collection_url = collectionUrl;
        return response;
      }
    } else {
      stats.retries++;
      if (body.authentication_identifier !== `auth-${context.input.orderId}`) throw new Error('CONTEXT_MISMATCH');
      await new Promise(resolve => setTimeout(resolve, 30));
      if (context.scenario === 'retry-timeout') throw new Error('SYNTHETIC_TIMEOUT');
    }
    return reply(200, ['nested-status', 'missing-status-currency'].includes(context.scenario) ? approvedData
      : { ...approvedData, order_id: body.order_id,
        transaction_currency: context.scenario === 'bad-currency' ? 'USD' : body.order_currency });
  };
  return { stats, restore() { net.Socket.prototype.connect = nativeConnect; globalThis.fetch = nativeFetch; axios.defaults.adapter = adapter; } };
}
