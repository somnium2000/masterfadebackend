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
  const songbird = context.scenario.startsWith('songbird');
  const flowScenario = context.scenario === 'songbird' ? 'challenge' : context.scenario.replace(/^songbird-/, '');
  const stats = { externalSockets: 0, initialSales: 0, retries: 0, lookups: 0, continues: 0,
    cryptoContextMatches: true, credentialsInNode: true, orders: [] };
  if (context.application) stats.directLookupCvvMatches = null;
  if (context.publicContinuation) stats.statusQueries = 0;
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
      response_approved: flowScenario !== 'declined', response_incomplete: false, response_code: '00',
      transaction_amount: context.input.amount,
      transaction_approved_amount: flowScenario === 'bad-amount' ? context.input.amount + 1 : context.input.amount,
      transaction_id: `tx-${context.input.orderId}`, payment_uuid: `uuid-${context.input.orderId}`,
      payment_hash: createHash('md5').update([flowScenario === 'bad-hash' ? 'unrelated' : context.input.orderId,
        context.config.keyId, context.config.secretKey].join('|')).digest('hex'),
    };
    if (config.url.endsWith('public_key')) return reply(200, { public_key: Buffer.from(merchant.publicKey).toString('base64') });
    if (config.url.endsWith('transaction/status')) {
      if (context.publicContinuation) stats.statusQueries++;
      if (body.payment_uuid !== approvedData.payment_uuid) throw new Error('STATUS_UUID_MISMATCH');
      return reply(200, { status: 'PAID', payment_uuid: approvedData.payment_uuid, order_id: context.input.orderId,
        ...(context.scenario === 'missing-status-currency' ? {} : { order_currency: context.input.currency }),
        last_response: { data: approvedData } });
    }
    if (config.url.endsWith('authentication/continue')) {
      stats.continues++;
      if (body.identifier !== `auth-${context.input.orderId}`) throw new Error('CONTEXT_MISMATCH');
      if (flowScenario === 'continue-timeout') throw new Error('SYNTHETIC_TIMEOUT');
      // AM: Contract tests retain the raw HTTP envelope so the native SDK performs its real normalization.
      if (Object.hasOwn(context, 'continueResponse')) return { config, status: context.continueResponse.status,
        headers: {}, data: structuredClone(context.continueResponse.body) };
      return reply(200, {}, null, flowScenario !== 'continue-false');
    }
    if (body.order_id !== context.input.orderId || Number(body.order_amount) !== context.input.amount
      || body.order_currency !== context.input.currency) throw new Error('CONTEXT_MISMATCH');
    checkCrypto(body, config.headers['x-auth-secure']);
    stats.orders.push(body.order_id);
    if (config.url.endsWith('lookup')) {
      stats.lookups++;
      if (context.application) {
        if (songbird && Object.hasOwn(body, 'card_cvv')) throw new Error('SONGBIRD_LOOKUP_CVV_FORBIDDEN');
        const [box, nonce] = String(body.card_cvv).split('|');
        const cvv = nonce && nacl.box.open(decode(box), decode(nonce), decode(config.headers['x-auth-secure']), merchant.secretKey);
        stats.directLookupCvvMatches = Boolean(cvv && Buffer.from(cvv).toString() === context.input.card.cvv);
      }
      const challengeUrl = context.application && !songbird ? 'https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/StepUp?n=%2B%2F'
        : 'https://acs.offline.invalid';
      return reply(context.application && !flowScenario.startsWith('frictionless') && flowScenario !== 'challenge-http-200' ? 202 : 200, {
        identifier: flowScenario === 'invalid-lookup-identifier' ? { unexpected: true } : `auth-${body.order_id}`,
        continue_url: songbird && Object.hasOwn(context, 'songbirdChallengeUrl') ? context.songbirdChallengeUrl
          : flowScenario === 'invalid-step-up' ? songbird ? 'http://acs.offline.invalid' : 'https://acs.offline.invalid'
          : flowScenario === 'invalid-step-up-userinfo' ? 'https://user:password@acs.offline.invalid' : challengeUrl,
        continue_payload: flowScenario === 'invalid-continue-payload' ? {} : 'opaque.+/=%ñ',
        transaction_id: flowScenario === 'invalid-transaction-id' ? null : `tx-${body.order_id}`, window_size: '03',
      }, flowScenario.startsWith('frictionless') ? null : 'continue', flowScenario !== 'lookup-not-successful');
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
          'collection-uppercase': collectionUrl.replace('cas.client.cardinaltrusted.com', 'CAS.CLIENT.CARDINALTRUSTED.COM'),
          'collection-port443': collectionUrl.replace('.com/', '.com:443/'),
          'collection-wrong-port': collectionUrl.replace('.com/', '.com:444/'),
          'collection-userinfo': collectionUrl.replace('https://', 'https://user:password@'),
          'collection-fragment': `${collectionUrl}#fragment`,
          'collection-v3': collectionUrl.replace('/V1/', '/V3/'),
          'collection-trailing-slash': collectionUrl.replace('/Collect?', '/Collect/?'),
        };
        const collectionValue = Object.hasOwn(context, 'collectionUrl') ? context.collectionUrl
          : Object.hasOwn(collection, context.scenario) ? collection[context.scenario] : collectionUrl;
        const response = reply(202, { transaction_type: 'songbird', payload: `opaque-setup-${body.order_id}`,
          payment_uuid: flowScenario === 'bad-uuid' ? 'different-uuid' : `uuid-${body.order_id}`,
          ...(context.application && !songbird && collectionValue !== undefined ? { collection_url: collectionValue } : {}) });
        response.headers['cf-ray'] = '0123456789abcdef-TPA';
        if (context.scenario === 'collection-top-level') response.data.collection_url = collectionUrl;
        return response;
      }
    } else {
      stats.retries++;
      if (body.authentication_identifier !== `auth-${context.input.orderId}`) throw new Error('CONTEXT_MISMATCH');
      await new Promise(resolve => setTimeout(resolve, 30));
      if (['retry-timeout', 'frictionless-timeout'].includes(flowScenario)) throw new Error('SYNTHETIC_TIMEOUT');
      if (flowScenario === 'frictionless-declined') return reply(402, {}, null, false);
      if (flowScenario === 'frictionless-second202') return reply(202, approvedData);
    }
    if (context.publicContinuation) {
      // AM: PixelPay's documented approval need not echo order or currency.
      const contradictions = {
        'bad-currency': { transaction_currency: 'USD' },
        'bad-order': { order_id: 'other-order' },
      };
      return reply(200, { ...approvedData, ...contradictions[flowScenario] },
        flowScenario === 'non-terminal-success' ? 'continue' : null);
    }
    return reply(200, ['nested-status', 'missing-status-currency'].includes(context.scenario) ? approvedData
      : { ...approvedData, order_id: body.order_id,
        transaction_currency: context.scenario === 'bad-currency' ? 'USD' : body.order_currency });
  };
  return { stats, restore() { net.Socket.prototype.connect = nativeConnect; globalThis.fetch = nativeFetch; axios.defaults.adapter = adapter; } };
}
