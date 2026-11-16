import CardinalAuthenticationModule from '@pixelpay/sdk-core/lib/services/CardinalAuthentication.js';
import LookupTransactionModule from '@pixelpay/sdk-core/lib/requests/LookupTransaction.js';
import LookupContinueTransactionModule from '@pixelpay/sdk-core/lib/requests/LookupContinueTransaction.js';
import { AppError } from '../../utils/errors.js';
import { createPixelPaySaleSignature } from './PixelPayDirectProvider.js';

const CardinalAuthentication = CardinalAuthenticationModule.default || CardinalAuthenticationModule;
const LookupTransaction = LookupTransactionModule.default || LookupTransactionModule;
const LookupContinueTransaction = LookupContinueTransactionModule.default || LookupContinueTransactionModule;
const SANDBOX = 'https://pixelpay.dev';
const ACS_ORIGINS = new Set(['https://songbirdstag.cardinalcommerce.com', 'https://centinelapistag.cardinalcommerce.com']);
const ENCRYPTED = ['card_number', 'card_expire', 'customer_name', 'customer_email', 'customer_identification'];
const BILLING = ['billing_address', 'billing_country', 'billing_state', 'billing_city', 'billing_zip', 'billing_phone'];
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const fail = code => new AppError(409, 'La autenticacion 3DS no puede continuar.', { code });
const keyValid = value => typeof value === 'string' && Buffer.from(value, 'base64').length === 32
  && Buffer.from(value, 'base64').toString('base64') === value;
const boxed = value => {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const parts = value.split('|');
  return parts.length === 2 && Buffer.from(parts[0], 'base64').length >= 16
    && Buffer.from(parts[1], 'base64').length === 24
    && parts.every(part => Buffer.from(part, 'base64').toString('base64') === part);
};
const amount = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
const matches = (context, row) => context?.version === 1 && context.collectionUrlPresent === false
  && ID.test(context.order?.id || '') && context.order.id === row?.order_id
  && context.order.currency === 'HNL' && row.currency === 'HNL'
  && amount(context.order.amount) === '1.00' && amount(row.amount_hnl) === '1.00'
  && keyValid(context.sdkPublicKey) && keyValid(context.merchantPublicKey)
  && Object.keys(context.encrypted || {}).every(name => ENCRYPTED.includes(name))
  && Object.keys(context.billing || {}).every(name => BILLING.includes(name))
  && boxed(context.encrypted?.card_number) && boxed(context.encrypted?.card_expire)
  && ENCRYPTED.every(name => context.encrypted[name] === undefined || boxed(context.encrypted[name]))
  && BILLING.every(name => context.billing?.[name] === undefined
    || typeof context.billing[name] === 'string' && context.billing[name].length <= 500);

// AM: Capture only already-encrypted fields plus public keys. Never retain CVV or a NaCl secret key.
export function captureSongbirdSdkContext(saleRequest, settings, { collectionUrl = null } = {}) {
  const pair = saleRequest?.getSDKKeyPair?.();
  const context = { version: 1,
    order: { id: saleRequest?.order_id, amount: amount(saleRequest?.order_amount), currency: saleRequest?.order_currency },
    encrypted: {}, billing: {},
    sdkPublicKey: pair?.publicKey ? Buffer.from(pair.publicKey).toString('base64') : null,
    merchantPublicKey: settings?.public_key || null,
    collectionUrlPresent: collectionUrl !== null && collectionUrl !== undefined && collectionUrl !== '',
  };
  for (const name of ENCRYPTED) if (saleRequest?.[name] !== undefined) context.encrypted[name] = saleRequest[name];
  for (const name of BILLING) if (saleRequest?.[name] !== undefined) context.billing[name] = saleRequest[name];
  if (context.collectionUrlPresent) return { ...context, encrypted: {}, billing: {}, sdkPublicKey: null, merchantPublicKey: null };
  if (!matches(context, { order_id: context.order.id, amount_hnl: context.order.amount, currency: context.order.currency })) {
    throw fail('PIXELPAY_SONGBIRD_CONTEXT_INVALID');
  }
  return context;
}

function inspectJwt(value, now, orderId) {
  if (typeof value !== 'string' || value.length > 16000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return false;
  try {
    const [header, payload] = value.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    if (!header || !payload || Array.isArray(header) || Array.isArray(payload)
      || !['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'].includes(header.alg)) return false;
    if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now)) return false;
    if (payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60000 || payload.iat * 1000 < now - 300000)) return false;
    for (const declared of [payload.order_id, payload.Payload?.OrderDetails?.OrderNumber]) {
      if (declared !== undefined && declared !== orderId) return false;
    }
    return true;
  } catch { return false; }
}
// AM: SDK parseResponse collapses missing success to false; HTTP 200 false cannot prove rejection.
const rejected = status => status >= 400 && status < 500 && ![408, 429].includes(status);
// AM: SDK exceptions manufacture status 520; it is not sufficient evidence of provider HTTP.
const providerHttpStatus = response => Number.isInteger(response?.status) && response.status !== 520 ? response.status : null;

const challengeAllowed = challenge => {
  if (!challenge || !ID.test(challenge.authenticationId || '') || !ID.test(challenge.transactionId || '')
    || typeof challenge.payload !== 'string' || !challenge.payload || challenge.payload.length > 16000
    || typeof challenge.acsUrl !== 'string' || challenge.acsUrl.length > 2048) return false;
  try { const url = new URL(challenge.acsUrl); return ACS_ORIGINS.has(url.origin) && !url.username && !url.password && !url.hash; }
  catch { return false; }
};

function emvFields(browser) {
  const out = {};
  for (const name of ['browser_java_enabled', 'browser_javascript_enabled']) {
    if (!['true', 'false'].includes(browser?.[name])) throw fail('PIXELPAY_SONGBIRD_BROWSER_CONTEXT_INVALID');
    out[name] = browser[name];
  }
  for (const [name, limit] of [['browser_language', 40], ['user_agent', 1024], ['browser_header', 1024], ['ip_address', 80]]) {
    if (typeof browser?.[name] !== 'string' || !browser[name] || browser[name].length > limit || /[\r\n\0]/.test(browser[name])) throw fail('PIXELPAY_SONGBIRD_BROWSER_CONTEXT_INVALID');
    out[name] = browser[name];
  }
  for (const name of ['browser_color_depth', 'browser_screen_height', 'browser_screen_width', 'browser_time_zone']) {
    const text = browser?.[name]; const value = Number(text);
    if (typeof text !== 'string' || !/^-?\d{1,5}$/.test(text) || !Number.isInteger(value)
      || (name === 'browser_time_zone' ? value < -840 || value > 840 : value < 1 || value > 10000)) throw fail('PIXELPAY_SONGBIRD_BROWSER_CONTEXT_INVALID');
    out[name] = text;
  }
  out.device_channel = 'Browser';
  return out;
}

export function createSongbirdSdkContract({ providerFactory, clock = Date.now }) {
  if (typeof providerFactory !== 'function') throw fail('PIXELPAY_SONGBIRD_PROVIDER_REQUIRED');
  const service = attempt => {
    if (!ID.test(attempt?.order_id || '') || amount(attempt.amount_hnl) !== '1.00' || attempt.currency !== 'HNL') throw fail('PIXELPAY_SONGBIRD_CONTEXT_INVALID');
    const provider = providerFactory();
    if (provider?.env !== 'sandbox' || provider.endpoint !== SANDBOX || provider.appUrl !== SANDBOX || typeof provider.createTransaction !== 'function') throw fail('PIXELPAY_SONGBIRD_SANDBOX_REQUIRED');
    const signature = createPixelPaySaleSignature({ secretKey: provider.secretKey, appKey: provider.keyId, orderId: attempt.order_id, appUrl: provider.appUrl });
    const settings = provider.createTransaction(signature).settings;
    if (settings?.endpoint !== SANDBOX || settings?.environment !== 'sandbox') throw fail('PIXELPAY_SONGBIRD_SANDBOX_REQUIRED');
    return { settings, native: new CardinalAuthentication(settings) };
  };
  return Object.freeze({
    id: 'pixelpay-sdk-2.5.8-songbird-authentication-only', browserPayloadAccredited: true, contextRequired: true,
    inspect: (payload, row, context) => matches(context, row) && inspectJwt(payload, clock(), row.order_id),
    challengeAllowed,
    async lookup({ reference, attempt, context, browser }) {
      if (context?.collectionUrlPresent) throw fail('PIXELPAY_SONGBIRD_DIRECT_API_VARIANT_UNSUPPORTED');
      if (!matches(context, attempt) || !ID.test(reference || '')) throw fail('PIXELPAY_SONGBIRD_CONTEXT_INVALID');
      const emv = emvFields(browser);
      const { native, settings } = service(attempt);
      settings.public_key = context.merchantPublicKey;
      const request = new LookupTransaction();
      Object.assign(request, context.encrypted, context.billing, emv, {
        order_id: context.order.id, order_amount: context.order.amount, order_currency: context.order.currency,
        reference, sdk_key_pair: { publicKey: new Uint8Array(Buffer.from(context.sdkPublicKey, 'base64')) },
      });
      // AM: Native SDK reuses box|nonce ciphertexts and the original public key; no secret key is needed.
      const response = await native.authenticationLookup(request);
      const httpStatus = providerHttpStatus(response);
      if (httpStatus !== 200 || response?.success !== true) {
        const definitive = rejected(httpStatus);
        return { verified: false, rejected: definitive, httpStatus,
          blockCode: definitive ? 'PIXELPAY_SONGBIRD_LOOKUP_REJECTED' : 'PIXELPAY_SONGBIRD_LOOKUP_UNCERTAIN' };
      }
      const challenge = { acsUrl: response.data?.continue_url, payload: response.data?.continue_payload,
        transactionId: response.data?.transaction_id, authenticationId: response.data?.identifier };
      if (response.action !== 'continue' || !challengeAllowed(challenge)) return { verified: false, httpStatus, blockCode: 'PIXELPAY_SONGBIRD_CHALLENGE_UNACCREDITED' };
      return { verified: true, httpStatus, challenge };
    },
    async validate({ jwt, attempt }) {
      if (!inspectJwt(jwt, clock(), attempt?.order_id) || !ID.test(attempt?.authentication_id || '')) throw fail('PIXELPAY_SONGBIRD_VALIDATION_INPUT_INVALID');
      const { native } = service(attempt);
      const request = new LookupContinueTransaction();
      request.identifier = attempt.authentication_id; request.payload = jwt; request.authenticate_token = false;
      const response = await native.authenticationContinue(request);
      const httpStatus = providerHttpStatus(response);
      if (httpStatus !== 200 || response?.success !== true) {
        const definitive = rejected(httpStatus);
        return { verified: false, rejected: definitive, httpStatus,
          blockCode: definitive ? 'PIXELPAY_SONGBIRD_AUTHENTICATION_REJECTED' : 'PIXELPAY_SONGBIRD_CONTINUE_UNCERTAIN' };
      }
      // AM: HTTP/success describe a response, not a documented positive authentication or payment contract.
      return { verified: false, httpStatus, blockCode: 'PIXELPAY_SONGBIRD_AUTH_RESULT_UNACCREDITED' };
    },
  });
}
