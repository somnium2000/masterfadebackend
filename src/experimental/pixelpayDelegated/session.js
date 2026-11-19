import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { PixelPaySdkProvider } from '../../services/payments/PixelPaySdkProvider.js';
import { createPixelPaySaleSignature } from '../../services/payments/PixelPayDirectProvider.js';
import { createPixelPayNodeSaleTransaction, PixelPayContinuationRequiredError } from '../../services/payments/pixelPaySaleRuntime.js';
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

function wire(response) {
  return { status: response.status, success: response.success, action: response.action,
    data: Object.fromEntries(RESPONSE_FIELDS.filter(key => response.data?.[key] !== undefined)
      .map(key => [key, response.data[key]])) };
}

// AM: Must live inside its dedicated worker. No transaction/keys are serialized out of this closure.
export function createDelegatedSession({ config, input, attemptId, explicitAuthentication = false }) {
  const provider = new PixelPaySdkProvider(config);
  const signature = createPixelPaySaleSignature({ secretKey: config.secretKey, appKey: config.keyId,
    orderId: input.orderId, appUrl: config.appUrl });
  const settings = provider.createTransaction(signature).settings;
  const request = provider.buildSaleRequest(input);
  if (explicitAuthentication) request.withAuthenticationRequest();
  let captured, state = 'new', identifier, finalResponse, evidence;
  const initial = createPixelPayNodeSaleTransaction(sdk, settings, { onContinuation: response => { captured = response; } });
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
    const promise = (async () => {
      try {
        if (operation === 'start') {
          state = 'starting';
          try {
            finalResponse = await initial.doSale(request);
          } catch (error) {
            if (!(error instanceof PixelPayContinuationRequiredError) || captured?.data?.transaction_type !== 'songbird') throw error;
          }
          if (!captured) {
            evidence = verify(finalResponse);
            state = 'completed_without_3ds';
            return { state, evidence, threeDsGuaranteed: false };
          }
          state = 'challenge';
          return { state, attemptId, order: { id: input.orderId, amount: input.amount, currency: input.currency },
            sdk: { endpoint: settings.endpoint, environment: settings.environment },
            continuation: { status: captured.status, transaction_type: captured.data.transaction_type,
              payload: captured.data.payload, collection_url: captured.data.collection_url ?? null },
            nodeAuthenticationRequested: request.authentication_request === true, threeDsGuaranteed: false };
        }
        if (operation === 'lookup') {
          const lookup = new LookupTransaction();
          lookup.fromPaymentTransaction(request);
          // AM: Match the native manager: CVV is added only on its collection_url path.
          if (captured?.data?.collection_url) lookup.card_cvv = request.card_cvv;
          for (const key of ['reference', ...EMV]) if (data[key] !== undefined) lookup[key] = data[key];
          const response = await service.authenticationLookup(lookup);
          identifier = response.data?.identifier;
          request.authentication_identifier = identifier;
          state = response.status >= 500 ? 'uncertain' : 'lookup';
          return wire(response);
        }
        if (operation === 'continue') {
          const continuation = new LookupContinueTransaction();
          continuation.identifier = identifier;
          continuation.payload = data.payload;
          const response = await service.authenticationContinue(continuation);
          state = response.status >= 500 ? 'uncertain' : 'continued';
          return wire(response);
        }
        // AM: Native continuation may POST Sale again; it is not a second application initial Sale.
        finalResponse = await service.retryTransaction(request);
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
