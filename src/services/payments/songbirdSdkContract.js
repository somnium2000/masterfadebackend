import CardinalAuthenticationModule from '@pixelpay/sdk-core/lib/services/CardinalAuthentication.js';
import LookupTransactionModule from '@pixelpay/sdk-core/lib/requests/LookupTransaction.js';
import LookupContinueTransactionModule from '@pixelpay/sdk-core/lib/requests/LookupContinueTransaction.js';
import PayloadResponseModule from '@pixelpay/sdk-core/lib/responses/PayloadResponse.js';
import SuccessResponseModule from '@pixelpay/sdk-core/lib/responses/SuccessResponse.js';
import { AppError } from '../../utils/errors.js';
import { createPixelPaySaleSignature } from './PixelPayDirectProvider.js';

const CardinalAuthentication = CardinalAuthenticationModule.default || CardinalAuthenticationModule;
const LookupTransaction = LookupTransactionModule.default || LookupTransactionModule;
const LookupContinueTransaction = LookupContinueTransactionModule.default || LookupContinueTransactionModule;
const PayloadResponse = PayloadResponseModule.default || PayloadResponseModule;
const SuccessResponse = SuccessResponseModule.default || SuccessResponseModule;
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
const DIAGNOSTIC_STAGES = new Set(['context_capture','context_validation','jwt_validation']);
const DIAGNOSTIC_RULES = new Set(['VALID','CAPTURE_EXCEPTION','CONTEXT_MISSING','CONTEXT_VERSION_INVALID',
  'COLLECTION_URL_UNSUPPORTED','COLLECTION_FLAG_INVALID','ORDER_MISMATCH','CURRENCY_MISMATCH','AMOUNT_MISMATCH',
  'SDK_PUBLIC_KEY_MISSING','SDK_PUBLIC_KEY_INVALID','MERCHANT_PUBLIC_KEY_MISSING','MERCHANT_PUBLIC_KEY_INVALID',
  'ENCRYPTED_FIELDS_UNEXPECTED','BILLING_FIELDS_INVALID','CARD_NUMBER_MISSING','CARD_NUMBER_CIPHERTEXT_INVALID',
  'CARD_EXPIRE_MISSING','CARD_EXPIRE_CIPHERTEXT_INVALID','OPTIONAL_CIPHERTEXT_INVALID','JWT_MISSING','JWT_SHAPE_INVALID',
  'JWT_JSON_INVALID','JWT_ALGORITHM_UNSUPPORTED','JWT_EXP_INVALID','JWT_EXPIRED','JWT_IAT_INVALID','JWT_IAT_FUTURE',
  'JWT_IAT_STALE','JWT_ORDER_MISMATCH']);
const DIAGNOSTIC_FLAGS = new Set(['context_present','context_version_valid','collection_url_present',
  'order_matches','currency_matches','amount_matches','sdk_public_key_present','sdk_public_key_valid',
  'merchant_public_key_present','merchant_public_key_valid','card_number_present','card_number_encrypted',
  'card_expire_present','card_expire_encrypted','optional_encrypted_valid','billing_valid',
  'jwt_present','jwt_shape_valid','jwt_json_valid','jwt_algorithm_valid','jwt_exp_present','jwt_iat_present',
  'jwt_time_valid','jwt_order_matches','jwt_order_id_present','jwt_order_id_is_string','jwt_order_id_matches',
  'jwt_order_number_present','jwt_order_number_is_string','jwt_order_number_matches',
  'jwt_payload_is_object','jwt_payload_is_string',
  'sale_request_present','sdk_key_pair_accessor_present','sdk_key_pair_present']);

// AM: Diagnostic values are a separate allowlist, never an exception/body/context serialization.
export function sanitizeSongbirdCaptureDiagnostic(value) {
  if (!value || !DIAGNOSTIC_STAGES.has(value.stage) || !DIAGNOSTIC_RULES.has(value.rule)
    || typeof value.accepted !== 'boolean') return null;
  return { accepted: value.accepted, stage: value.stage, rule: value.rule,
    flags: Object.fromEntries([...DIAGNOSTIC_FLAGS].filter(name => typeof value.flags?.[name] === 'boolean')
      .map(name => [name, value.flags[name]])) };
}

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
export function captureSongbirdSdkContext(saleRequest, settings, { collectionUrl = null, onDiagnostic } = {}) {
  const emit = value => {
    try { if (typeof onDiagnostic === 'function') onDiagnostic(sanitizeSongbirdCaptureDiagnostic(value)); }
    catch { /* AM: Observability cannot change the acceptance gate or the durable Sale claim. */ }
  };
  let diagnostic;
  try {
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
    const row = { order_id: context.order.id, amount_hnl: context.order.amount, currency: context.order.currency };
    diagnostic = inspectSongbirdContextCapture(null, row, context);
    diagnostic = { ...diagnostic, accepted: matches(context, row), stage: 'context_capture',
      rule: context.collectionUrlPresent ? 'COLLECTION_URL_UNSUPPORTED' : contextRule(context, row),
      flags: Object.fromEntries(Object.entries(diagnostic.flags).filter(([name]) => !name.startsWith('jwt_'))) };
    Object.assign(diagnostic.flags, { sale_request_present: Boolean(saleRequest),
      sdk_key_pair_accessor_present: typeof saleRequest?.getSDKKeyPair === 'function', sdk_key_pair_present: Boolean(pair) });
    emit(diagnostic);
    if (context.collectionUrlPresent) return { ...context, encrypted: {}, billing: {}, sdkPublicKey: null, merchantPublicKey: null };
    if (!diagnostic.accepted) throw fail('PIXELPAY_SONGBIRD_CONTEXT_INVALID');
    return context;
  } catch (error) {
    if (!diagnostic) emit({ accepted: false, stage: 'context_capture', rule: 'CAPTURE_EXCEPTION',
      flags: { sale_request_present: Boolean(saleRequest), collection_url_present: collectionUrl !== null && collectionUrl !== undefined && collectionUrl !== '' } });
    throw error;
  }
}

function inspectJwt(value, now, orderId) {
  if (typeof value !== 'string' || value.length > 16000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return false;
  try {
    const [header, payload] = value.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    if (!header || !payload || Array.isArray(header) || Array.isArray(payload)
      || !['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'].includes(header.alg)) return false;
    if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now)) return false;
    if (payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60000 || payload.iat * 1000 < now - 300000)) return false;
    // AM: Cardinal's OrderNumber belongs to the provider; binding uses the captured backend context.
    for (const declared of [payload.order_id]) {
      if (declared !== undefined && declared !== orderId) return false;
    }
    return true;
  } catch { return false; }
}

function contextRule(context, row) {
  if (!context) return 'CONTEXT_MISSING';
  if (context.version !== 1) return 'CONTEXT_VERSION_INVALID';
  if (context.collectionUrlPresent === true) return 'COLLECTION_URL_UNSUPPORTED';
  if (context.collectionUrlPresent !== false) return 'COLLECTION_FLAG_INVALID';
  if (!ID.test(context.order?.id || '') || context.order.id !== row?.order_id) return 'ORDER_MISMATCH';
  if (context.order.currency !== 'HNL' || row?.currency !== 'HNL') return 'CURRENCY_MISMATCH';
  if (amount(context.order.amount) !== '1.00' || amount(row?.amount_hnl) !== '1.00') return 'AMOUNT_MISMATCH';
  if (!context.sdkPublicKey) return 'SDK_PUBLIC_KEY_MISSING';
  if (!keyValid(context.sdkPublicKey)) return 'SDK_PUBLIC_KEY_INVALID';
  if (!context.merchantPublicKey) return 'MERCHANT_PUBLIC_KEY_MISSING';
  if (!keyValid(context.merchantPublicKey)) return 'MERCHANT_PUBLIC_KEY_INVALID';
  if (!Object.keys(context.encrypted || {}).every(name => ENCRYPTED.includes(name))) return 'ENCRYPTED_FIELDS_UNEXPECTED';
  if (!Object.keys(context.billing || {}).every(name => BILLING.includes(name))) return 'BILLING_FIELDS_INVALID';
  if (!context.encrypted?.card_number) return 'CARD_NUMBER_MISSING';
  if (!boxed(context.encrypted.card_number)) return 'CARD_NUMBER_CIPHERTEXT_INVALID';
  if (!context.encrypted?.card_expire) return 'CARD_EXPIRE_MISSING';
  if (!boxed(context.encrypted.card_expire)) return 'CARD_EXPIRE_CIPHERTEXT_INVALID';
  if (!ENCRYPTED.every(name => context.encrypted[name] === undefined || boxed(context.encrypted[name]))) return 'OPTIONAL_CIPHERTEXT_INVALID';
  if (!BILLING.every(name => context.billing?.[name] === undefined || typeof context.billing[name] === 'string' && context.billing[name].length <= 500)) return 'BILLING_FIELDS_INVALID';
  return 'VALID';
}

export function inspectSongbirdContextCapture(payload, row, context, { now = Date.now() } = {}) {
  const present = value => value !== undefined && value !== null && value !== '';
  const flags = {
    context_present: Boolean(context), context_version_valid: context?.version === 1,
    collection_url_present: context?.collectionUrlPresent === true,
    order_matches: Boolean(ID.test(context?.order?.id || '') && context.order.id === row?.order_id),
    currency_matches: context?.order?.currency === 'HNL' && row?.currency === 'HNL',
    amount_matches: amount(context?.order?.amount) === '1.00' && amount(row?.amount_hnl) === '1.00',
    sdk_public_key_present: present(context?.sdkPublicKey), sdk_public_key_valid: keyValid(context?.sdkPublicKey),
    merchant_public_key_present: present(context?.merchantPublicKey), merchant_public_key_valid: keyValid(context?.merchantPublicKey),
    card_number_present: present(context?.encrypted?.card_number), card_number_encrypted: boxed(context?.encrypted?.card_number),
    card_expire_present: present(context?.encrypted?.card_expire), card_expire_encrypted: boxed(context?.encrypted?.card_expire),
    optional_encrypted_valid: Object.keys(context?.encrypted || {}).every(name => ENCRYPTED.includes(name))
      && ENCRYPTED.every(name => context?.encrypted?.[name] === undefined || boxed(context.encrypted[name])),
    billing_valid: Object.keys(context?.billing || {}).every(name => BILLING.includes(name))
      && BILLING.every(name => context?.billing?.[name] === undefined || typeof context.billing[name] === 'string' && context.billing[name].length <= 500),
    jwt_present: typeof payload === 'string' && payload.length > 0,
    jwt_shape_valid: typeof payload === 'string' && payload.length <= 16000 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(payload),
    jwt_json_valid: false, jwt_algorithm_valid: false, jwt_exp_present: false, jwt_iat_present: false,
    jwt_time_valid: false, jwt_order_matches: false,
    jwt_order_id_present: false, jwt_order_id_is_string: false, jwt_order_id_matches: false,
    jwt_order_number_present: false, jwt_order_number_is_string: false, jwt_order_number_matches: false,
    jwt_payload_is_object: false, jwt_payload_is_string: false,
  };
  let jwtRule = !flags.jwt_present ? 'JWT_MISSING' : 'JWT_SHAPE_INVALID';
  if (flags.jwt_shape_valid) {
    jwtRule = 'JWT_JSON_INVALID';
    try {
      const [header, claims] = payload.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
      flags.jwt_json_valid = Boolean(header && claims && !Array.isArray(header) && !Array.isArray(claims));
      if (flags.jwt_json_valid) {
        flags.jwt_algorithm_valid = ['HS256','HS384','HS512','RS256','RS384','RS512','ES256','ES384','ES512'].includes(header.alg);
        flags.jwt_exp_present = claims.exp !== undefined; flags.jwt_iat_present = claims.iat !== undefined;
        const expValid = !flags.jwt_exp_present || Number.isFinite(claims.exp) && claims.exp * 1000 > now;
        const iatValid = !flags.jwt_iat_present || Number.isFinite(claims.iat) && claims.iat * 1000 <= now + 60000 && claims.iat * 1000 >= now - 300000;
        flags.jwt_time_valid = expValid && iatValid;
        // AM: Observe Cardinal OrderNumber without using it as the merchant order identity.
        const orderNumber = claims.Payload?.OrderDetails?.OrderNumber;
        flags.jwt_order_id_present = claims.order_id !== undefined;
        flags.jwt_order_id_is_string = typeof claims.order_id === 'string';
        flags.jwt_order_id_matches = flags.jwt_order_id_present && claims.order_id === row?.order_id;
        flags.jwt_order_number_present = orderNumber !== undefined;
        flags.jwt_order_number_is_string = typeof orderNumber === 'string';
        flags.jwt_order_number_matches = flags.jwt_order_number_present && orderNumber === row?.order_id;
        flags.jwt_payload_is_object = claims.Payload !== null && typeof claims.Payload === 'object' && !Array.isArray(claims.Payload);
        flags.jwt_payload_is_string = typeof claims.Payload === 'string';
        flags.jwt_order_matches = claims.order_id === undefined || claims.order_id === row?.order_id;
        jwtRule = !flags.jwt_algorithm_valid ? 'JWT_ALGORITHM_UNSUPPORTED'
          : flags.jwt_exp_present && !Number.isFinite(claims.exp) ? 'JWT_EXP_INVALID' : !expValid ? 'JWT_EXPIRED'
          : flags.jwt_iat_present && !Number.isFinite(claims.iat) ? 'JWT_IAT_INVALID'
          : flags.jwt_iat_present && claims.iat * 1000 > now + 60000 ? 'JWT_IAT_FUTURE'
          : !iatValid ? 'JWT_IAT_STALE' : !flags.jwt_order_matches ? 'JWT_ORDER_MISMATCH' : 'VALID';
      }
    } catch { /* AM: Only a fixed rule is retained; parse errors can contain opaque token material. */ }
  }
  const rule = contextRule(context, row);
  return { accepted: matches(context, row) && inspectJwt(payload, now, row?.order_id),
    stage: rule === 'VALID' ? 'jwt_validation' : 'context_validation', rule: rule === 'VALID' ? jwtRule : rule, flags };
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

// AM: Inspect only shape/validity; never serialize provider values, URLs, errors or encrypted context.
function lookupDiagnostic(response, httpStatus, challenge, attempt) {
  const present = value => value !== undefined && value !== null && value !== '';
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  let urlValid = false; let originAllowed = false; let acsOrigin = null;
  if (typeof challenge.acsUrl === 'string' && challenge.acsUrl.length <= 2048) {
    try {
      const url = new URL(challenge.acsUrl);
      // AM: Only normalized HTTPS origin is diagnostic; never retain path, query, fragment or userinfo.
      if (url.protocol === 'https:') acsOrigin = url.origin;
      urlValid = url.protocol === 'https:' && !url.username && !url.password && !url.hash;
      originAllowed = ACS_ORIGINS.has(url.origin);
    } catch { /* AM: Parsing failures may include URLs; retain booleans only. */ }
  }
  return {
    event: 'PIXELPAY_SONGBIRD_LOOKUP_DIAGNOSTIC',
    id_intent: uuid(attempt.id_intent), paymentAttemptId: uuid(attempt.payment_attempt_id),
    provider_http_status: httpStatus, acs_origin: acsOrigin,
    response_class: response instanceof PayloadResponse ? 'PayloadResponse'
      : response instanceof SuccessResponse ? 'SuccessResponse' : response == null ? 'absent' : 'other',
    // AM: These describe the parsed SDK response; missing upstream success is normalized to false by SDK.
    success: response?.success === true, success_is_boolean: typeof response?.success === 'boolean',
    action: ['continue', 'token_auth_success', 'token_auth_failed'].includes(response?.action) ? response.action
      : response?.action == null ? 'absent' : 'other',
    fields: {
      identifier_present: present(challenge.authenticationId), identifier_valid: ID.test(challenge.authenticationId || ''),
      transaction_id_present: present(challenge.transactionId), transaction_id_valid: ID.test(challenge.transactionId || ''),
      continue_payload_present: present(challenge.payload),
      continue_payload_valid: typeof challenge.payload === 'string' && challenge.payload.length > 0 && challenge.payload.length <= 16000,
      continue_url_present: present(challenge.acsUrl), continue_url_valid: urlValid,
      acs_origin_allowed: originAllowed, challenge_valid: challengeAllowed(challenge),
    },
    financial_finalization_enabled: false,
  };
}

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

export function createSongbirdSdkContract({ providerFactory, clock = Date.now, logger }) {
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
    inspectCapture: (payload, row, context) => inspectSongbirdContextCapture(payload, row, context, { now: clock() }),
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
      const challenge = { acsUrl: response?.data?.continue_url, payload: response?.data?.continue_payload,
        transactionId: response?.data?.transaction_id, authenticationId: response?.data?.identifier };
      try { logger?.info?.(lookupDiagnostic(response, httpStatus, challenge, attempt), 'PixelPay QA lookup diagnostic'); }
      catch { /* AM: Telemetry cannot change authentication acceptance or trigger a retry. */ }
      // AM: SDK 2.5.8 maps HTTP 202 to PayloadResponse; it is only a candidate for a validated challenge.
      const expectedResponse = httpStatus === 200 || (httpStatus === 202 && response instanceof PayloadResponse);
      if (!expectedResponse || response?.success !== true) {
        const definitive = rejected(httpStatus);
        return { verified: false, rejected: definitive, httpStatus,
          blockCode: definitive ? 'PIXELPAY_SONGBIRD_LOOKUP_REJECTED' : 'PIXELPAY_SONGBIRD_LOOKUP_UNCERTAIN' };
      }
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
