import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { PixelPaySdkProvider } from '../../services/payments/PixelPaySdkProvider.js';
import { createPixelPaySaleSignature } from '../../services/payments/PixelPayDirectProvider.js';
import { comparePixelPayContinuationFields, createPixelPayNodeSaleTransaction, PixelPayContinuationRequiredError } from '../../services/payments/pixelPaySaleRuntime.js';
const require = createRequire(import.meta.url);
const sdk = require('@pixelpay/sdk-core');
// AM: Explicit internal SDK extensions, not documented public transport APIs.
const CardinalAuthentication = require('@pixelpay/sdk-core/lib/services/CardinalAuthentication').default;
const LookupTransaction = require('@pixelpay/sdk-core/lib/requests/LookupTransaction').default;
const LookupContinueTransaction = require('@pixelpay/sdk-core/lib/requests/LookupContinueTransaction').default;
const EMV = ['browser_java_enabled', 'browser_language', 'browser_color_depth', 'browser_screen_height',
  'browser_screen_width', 'browser_time_zone', 'user_agent', 'browser_javascript_enabled'];
const RESPONSE_FIELDS = ['identifier', 'continue_url', 'continue_payload', 'window_size', 'transaction_id',
  'response_approved', 'response_incomplete', 'response_code', 'transaction_amount', 'transaction_approved_amount',
  'payment_uuid', 'payment_hash', 'order_id', 'transaction_currency'];
const fail = () => { throw new Error('PROTOTYPE_REQUEST_REJECTED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const opaque = (value, max = 32768) => typeof value === 'string' && value.length > 0 && value.length <= max;
const CAS_COLLECTION = new Set([
  'https://cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect',
  'https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/Collect',
]);
const CAS_STEP_UP = new Set(['https://cas.client.cardinaltrusted.com/centinelapi/V2/Cruise/StepUp']);

function allowedCasUrl(value, targets) {
  return opaque(value, 2048) && !/[\s\\#]/.test(value) && targets.has(value.split('?', 1)[0]);
}

function collectionError(data) {
  if (data == null || !Object.hasOwn(data, 'collection_url')) return 'PIXELPAY_3DS_COLLECTION_URL_ABSENT';
  if (data.collection_url === null) return 'PIXELPAY_3DS_COLLECTION_URL_NULL';
  if (data.collection_url === '') return 'PIXELPAY_3DS_COLLECTION_URL_EMPTY';
  if (!allowedCasUrl(data.collection_url, CAS_COLLECTION)) return 'PIXELPAY_3DS_COLLECTION_URL_INVALID';
  return null;
}

function directLookupAccepted(response) {
  const data = response.data;
  if (response.success !== true || !opaque(data?.identifier, 160)) return false;
  if (response.action === 'continue') {
    return [200, 202].includes(response.status) && allowedCasUrl(data.continue_url, CAS_STEP_UP) && opaque(data.continue_payload);
  }
  return response.status === 200 && response.action === null;
}

function wire(response) {
  return { status: response.status, success: response.success, action: response.action,
    data: Object.fromEntries(RESPONSE_FIELDS.filter(key => response.data?.[key] !== undefined)
      .map(key => [key, response.data[key]])) };
}

// AM: Must live inside its dedicated worker. No transaction/keys are serialized out of this closure.
export function createDelegatedSession({ config, input, attemptId, explicitAuthentication = false, application = false }) {
  const provider = new PixelPaySdkProvider(config);
  const signature = createPixelPaySaleSignature({ secretKey: config.secretKey, appKey: config.keyId,
    orderId: input.orderId, appUrl: config.appUrl });
  const settings = provider.createTransaction(signature).settings;
  const request = provider.buildSaleRequest(input);
  if (explicitAuthentication) request.withAuthenticationRequest();
  let captured, captureDiagnostic, state = 'new', identifier, finalResponse, evidence;
  let continuationMode, directLookupVerified = false;
  const initial = createPixelPayNodeSaleTransaction(sdk, settings, { onContinuation: (response, diagnostic) => {
    captured = response;
    captureDiagnostic = diagnostic;
  } });
  const service = new CardinalAuthentication(settings);
  const memo = new Map();

  function verify(response) {
    // AM: Only responses received by this worker's provider transport enter financial classification.
    const result = provider.completeSaleResponse(input, { paymentAttemptId: attemptId }, null, Date.now(), {}, initial, response);
    const data = response.data;
    const observedUuid = captured?.data?.payment_uuid;
    return { providerApproved: result.approved === true && data?.order_id === input.orderId
      && data?.transaction_currency === input.currency && Boolean(result.paymentUuid) && Boolean(result.transactionId)
      && (!observedUuid || result.paymentUuid === observedUuid),
    bookingConfirmed: false, orderId: input.orderId, attemptId, paymentUuid: result.paymentUuid,
    amountMatches: result.amountMatches, paymentHashValid: result.paymentHashValid };
  }

  async function readApplicationResult(response) {
    const result = provider.completeSaleResponse(input, { paymentAttemptId: attemptId }, null, Date.now(), {}, initial, response);
    const matches = (field, expected) => typeof field === 'string' && field === expected;
    const payload = response.data;
    const observedUuid = captured?.data?.payment_uuid;
    let corroborated = matches(payload?.order_id, input.orderId)
      && matches(payload?.transaction_currency ?? payload?.order_currency, input.currency)
      && (!payload?.transaction_currency || !payload?.order_currency || payload.transaction_currency === payload.order_currency)
      && (!observedUuid || observedUuid === result.paymentUuid);
    const noConflict = [
      [payload?.order_id, input.orderId], [payload?.transaction_currency, input.currency],
      [payload?.order_currency, input.currency], [observedUuid, result.paymentUuid],
    ].every(([value, expected]) => value == null || matches(value, expected));
    if (!corroborated && result.approved && noConflict) {
      // AM: Only an independently approved Sale can use Status to corroborate missing identity fields.
      try {
        const status = await provider.queryPaymentStatus(result.paymentUuid, input);
        corroborated = status.ok && status.success && status.providerContractValid && status.approved
          && status.resultOrderId === input.orderId && status.resultCurrency === input.currency
          && status.resultPaymentUuid === result.paymentUuid && status.transactionId === result.transactionId
          && status.paymentHashValid && status.amountMatches && !status.incomplete;
      } catch { /* AM: Leave the attempt pending if corroboration is unavailable. */ }
    }
    // AM: Scope the financial outcome to trusted provider fields, never browser echoes or local defaults.
    return { ...result, outcome: corroborated ? result.outcome : 'uncertain',
      approved: corroborated && result.approved,
      observedPaymentUuid: observedUuid && result.paymentUuid && observedUuid !== result.paymentUuid
        ? null : result.paymentUuid || observedUuid || null };
  }

  async function execute(operation, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail();
    if (operation === 'status') {
      if (Object.keys(data).length) fail();
      return { state, evidence: evidence || { providerApproved: false, bookingConfirmed: false },
        canStartAgain: false, attemptId };
    }
    if (!['start', 'lookup', 'continue', 'retry'].includes(operation)) fail();
    const allowed = operation === 'lookup' ? ['reference', ...EMV] : operation === 'continue' ? ['payload'] : [];
    if (Object.keys(data).some(key => !allowed.includes(key))) fail();
    const normalized = Object.fromEntries(allowed.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
    const hash = digest(normalized);
    if (memo.has(operation)) {
      const previous = memo.get(operation);
      if (previous.hash !== hash) fail();
      return previous.promise;
    }
    if (operation !== 'start' && !['challenge', 'lookup', 'continued'].includes(state)) fail();
    if (operation === 'start' && state !== 'new') fail();
    if (operation === 'lookup' && (!opaque(data.reference, 1024) || EMV.some(key => data[key] !== undefined && !opaque(data[key], 2048)))) fail();
    if (operation === 'continue' && (!identifier || !opaque(data.payload))) fail();
    if (operation === 'retry' && !identifier) fail();
    if (application && operation !== 'start' && continuationMode !== 'direct_api') fail();
    if (continuationMode === 'direct_api') {
      if (operation === 'continue') fail();
      // AM: Direct API does not use authenticationContinue. Only the worker's lookup can admit a native retry.
      if (operation === 'retry' && (state !== 'lookup' || !directLookupVerified)) fail();
    }
    const promise = (async () => {
      try {
        if (operation === 'start') {
          state = 'starting';
          try {
            finalResponse = await initial.doSale(request);
          } catch (error) {
            if (!(error instanceof PixelPayContinuationRequiredError) || !captured
              || (!application && captured.data?.transaction_type !== 'songbird')) throw error;
          }
          if (!captured) {
            if (application) return { state: 'completed_without_3ds', final: await readApplicationResult(finalResponse) };
            evidence = verify(finalResponse);
            state = 'completed_without_3ds';
            return { state, evidence, threeDsGuaranteed: false };
          }
          if (application) {
            const code = captured.data?.transaction_type !== 'songbird' || !opaque(captured.data?.payload)
              ? 'PIXELPAY_3DS_CONTINUATION_INVALID' : collectionError(captured.data);
            if (code) {
              state = 'unsupported';
              return { state, observedPaymentUuid: captured.data?.payment_uuid ?? null,
                continuation_diagnostic: { ...captureDiagnostic, code, sdk_to_handoff_equal: null } };
            }
            continuationMode = 'direct_api';
          }
          const continuation = { status: captured.status, transaction_type: captured.data.transaction_type,
            payload: captured.data.payload, collection_url: application ? captured.data.collection_url : captured.data.collection_url ?? null };
          state = 'challenge';
          return { state, attemptId, order: { id: input.orderId, amount: input.amount, currency: input.currency },
            sdk: { endpoint: settings.endpoint, environment: settings.environment }, continuation,
            nodeAuthenticationRequested: request.authentication_request === true, threeDsGuaranteed: false,
            ...(application ? { continuation_mode: continuationMode, observedPaymentUuid: captured.data.payment_uuid ?? null,
              continuation_diagnostic: { ...captureDiagnostic, code: 'PIXELPAY_3DS_COLLECTION_READY',
                sdk_to_handoff_equal: comparePixelPayContinuationFields(captured.data, continuation) } } : {}) };
        }
        if (operation === 'lookup') {
          const lookup = new LookupTransaction();
          lookup.fromPaymentTransaction(request);
          // AM: Match the native manager: CVV is added only on its collection_url path.
          if (continuationMode === 'direct_api' || (!application && captured?.data?.collection_url)) lookup.card_cvv = request.card_cvv;
          for (const key of ['reference', ...EMV]) if (data[key] !== undefined) lookup[key] = data[key];
          const response = await service.authenticationLookup(lookup);
          directLookupVerified = continuationMode === 'direct_api' && directLookupAccepted(response);
          identifier = application && !directLookupVerified ? null : response.data?.identifier;
          request.authentication_identifier = identifier;
          state = response.status >= 500 ? 'uncertain' : 'lookup';
          if (!application) return wire(response);
          if (!directLookupVerified) return { status: response.status, success: false, action: null, data: {} };
          const result = wire(response);
          result.data = Object.fromEntries(Object.entries(result.data)
            .filter(([key]) => ['identifier', 'continue_url', 'continue_payload', 'window_size', 'transaction_id'].includes(key)));
          return result;
        }
        if (operation === 'continue') {
          const continuation = new LookupContinueTransaction();
          continuation.identifier = identifier;
          continuation.payload = data.payload;
          const response = await service.authenticationContinue(continuation);
          state = response.status >= 500 ? 'uncertain' : 'continued';
          return application ? { status: response.status, action: response.action, success: response.success, data: {} }
            : wire(response);
        }
        // AM: Native continuation may POST Sale again; it is not a second application initial Sale.
        finalResponse = await service.retryTransaction(request);
        if (application) {
          state = finalResponse.status >= 500 ? 'uncertain' : 'finished';
          return { sdkResponse: { status: finalResponse.status, action: finalResponse.action,
            success: finalResponse.success, data: {} }, final: await readApplicationResult(finalResponse) };
        }
        evidence = verify(finalResponse);
        state = finalResponse.status >= 500 ? 'uncertain' : 'finished';
        return wire(finalResponse);
      } catch {
        state = 'uncertain';
        throw new Error('PROTOTYPE_UNCERTAIN');
      }
    })();
    memo.set(operation, { hash, promise });
    return promise;
  }
  return { execute };
}
