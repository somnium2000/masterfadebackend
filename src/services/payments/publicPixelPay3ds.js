import { createHash, randomUUID } from 'node:crypto';
import { DelegatedAttempt } from '../../experimental/pixelpayDelegated/attempt.js';
import { AppError } from '../../utils/errors.js';
import { claimPixelPay3dsDispatch, recordPixelPay3dsContinuation } from './pixelPaySaleAttemptStore.js';
import { sanitizePixelPayContinuationDiagnostic } from './pixelPaySaleRuntime.js';

const MAX_ACTIVE_ATTEMPTS = 8;
const MAX_CONTEXT_MS = 120_000;
const LOOKUP_PHASE_EVENTS = { challenge: 'challenge_ready', frictionless: 'frictionless_ready' };

export function publicPixelPay3dsUnavailable() {
  return new AppError(503, 'El pago con autenticación no está disponible en este momento.', {
    code: 'PIXELPAY_PUBLIC_3DS_UNAVAILABLE',
  });
}

const pending = (code = 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST') => new AppError(
  409, 'El pago sigue pendiente de verificación.', { code },
);

function isLiveOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[^/]/i.test(value) || /[\p{Cc}\s\\#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password
      && !url.search && !url.hash && !['pixelpay.dev', 'localhost'].includes(url.hostname);
  } catch { return false; }
}

export function resolvePublicPixelPay3dsConfig(env, { qaBooking, qaSale, delegated, publicCommerce } = {}) {
  const enabled = String(env.PIXELPAY_PUBLIC_3DS_ENABLED ?? 'false').trim();
  if (enabled === 'false') return false;
  if (enabled !== 'true' || delegated) {
    throw new Error('PIXELPAY_PUBLIC_3DS_ENABLED invalido o incompatible con el modo delegado de prueba.');
  }
  if (qaBooking?.enabled && qaSale?.enabled && env.ENTORNO === 'qa' && env.PIXELPAY_ENV === 'sandbox') {
    return 'sandbox';
  }
  if (env.NODE_ENV === 'production' && env.ENTORNO === 'production' && env.PIXELPAY_ENV === 'live'
    && env.PAYMENT_PROVIDER === 'pixelpay' && env.PIXELPAY_IMPLEMENTATION === 'sdk'
    && !qaBooking?.enabled && !qaSale?.enabled
    && (publicCommerce?.bookingEnabled || publicCommerce?.vipPurchaseEnabled)
    && isLiveOrigin(env.PIXELPAY_ENDPOINT) && isLiveOrigin(env.PIXELPAY_APP_URL)) return 'live';
  throw new Error('PIXELPAY_PUBLIC_3DS_ENABLED requiere QA SDK Sandbox por identidad o SDK Live con comercio publico habilitado.');
}

export function buildPublicPixelPay3dsHandoff({ result, deadline, token }) {
  if (result.state !== 'challenge' || !['direct_api', 'songbird'].includes(result.continuation_mode)) return null;
  return { state: result.state, order: result.order, sdk: result.sdk, continuation: result.continuation,
    continuation_mode: result.continuation_mode, token, expiresAt: deadline };
}

export function createPublicPixelPay3dsAttempts({
  db, logger, environment = 'sandbox', makeAttempt = options => new DelegatedAttempt(options), now = Date.now,
}) {
  const attempts = new Map();
  const reserved = new Set();
  const keyFor = ({ kind, idIntent }) => `${kind}:${idIntent}`;
  const current = context => attempts.get(context.key) === context && now() < context.deadline;
  const trace = (context, phase, httpStatus) => {
    try {
      logger?.info?.({ event: 'pixelpay_public_3ds_phase', phase,
        id_intent: context.claim.idIntent, paymentAttemptId: context.claim.paymentAttemptId,
        ...(Number.isInteger(httpStatus) && { upstream_status: httpStatus }) });
    } catch { /* AM: Diagnostics cannot determine the payment outcome. */ }
  };
  const traceStart = (claim, phase, details) => {
    // AM: An observability failure must not alter dispatch, persistence or handoff admission.
    try {
      logger?.info?.({ event: 'pixelpay_public_3ds_phase', phase,
        id_intent: claim.idIntent, paymentAttemptId: claim.paymentAttemptId, ...details });
    } catch { /* AM: Keep all diagnostic failures out of the payment result. */ }
  };
  function reserve() {
    if (attempts.size + reserved.size >= MAX_ACTIVE_ATTEMPTS) throw publicPixelPay3dsUnavailable();
    const slot = { release: () => reserved.delete(slot) };
    reserved.add(slot);
    return slot;
  }
  return {
    reserve,
    async start({ kind, claim, owner, input, provider, slot = reserve() }) {
      const hasSlot = reserved.delete(slot);
      const key = keyFor({ kind, idIntent: claim.idIntent });
      const startedAt = now();
      const deadline = Math.min(Date.parse(claim.protectionExpiresAt), startedAt + MAX_CONTEXT_MS);
      if (provider.env !== environment || !owner || !(deadline > startedAt)
        || attempts.has(key) || !hasSlot) throw pending();
      const token = randomUUID();
      let worker, stage = 'worker_construction';
      try {
        worker = makeAttempt({
          workerUrl: new URL('../../experimental/pixelpayDelegated/applicationWorker.js', import.meta.url),
          context: { attemptId: claim.paymentAttemptId, input, publicContinuation: true,
            config: { env: provider.env, endpoint: provider.endpoint, appUrl: provider.appUrl,
              keyId: provider.keyId, secretKey: provider.secretKey, authHash: provider.authHash } },
          lifetimeMs: deadline - startedAt,
          onClose: () => { if (attempts.get(key)?.token === token) attempts.delete(key); },
        });
        const context = { key, claim, owner, deadline, token, worker, phase: 'starting' };
        attempts.set(key, context);
        stage = 'worker_start';
        const result = await worker.call('start');
        traceStart(claim, 'start_result', {
          state: ['challenge', 'unsupported', 'completed_without_3ds'].includes(result.state) ? result.state : 'unknown',
          ...(result.continuation_diagnostic ? {
            continuation_diagnostic: sanitizePixelPayContinuationDiagnostic(result.continuation_diagnostic),
          } : {}),
        });
        if (result.state === 'challenge' || result.state === 'unsupported') {
          stage = 'durable_record';
          if (!await recordPixelPay3dsContinuation(db, { ...claim, paymentUuid: result.observedPaymentUuid })) {
            throw pending();
          }
        }
        if (result.state === 'challenge') {
          stage = 'context_check';
          if (!current(context)) throw pending();
          if (!['direct_api', 'songbird'].includes(result.continuation_mode)) throw pending();
          context.continuationMode = result.continuation_mode;
          context.phase = 'collection';
          trace(context, 'handoff_ready', 202);
        } else worker.close();
        return { result, deadline, token };
      } catch {
        traceStart(claim, 'start_failed', { stage, code: 'PIXELPAY_PUBLIC_3DS_START_UNCERTAIN' });
        worker?.close();
        throw pending();
      }
    },
    get({ kind, idIntent, idGrupoCita, owner, token }) {
      const context = attempts.get(keyFor({ kind, idIntent }));
      return context && current(context) && context.claim.idGrupoCita === idGrupoCita
        && context.owner === owner && context.token === token ? context : null;
    },
    async advance(context, operation, data, settle) {
      if (!current(context)) throw pending();
      if (operation === 'lookup' && context.phase === 'collection') {
        context.phase = 'lookup';
        try {
          const response = await context.worker.call('lookup', data);
          if (response.success === true && response.action === 'continue') context.phase = 'challenge';
          else if (response.success === true && response.status === 200 && response.action === null) {
            context.phase = 'frictionless';
          } else context.worker.close();
          trace(context, LOOKUP_PHASE_EVENTS[context.phase] ?? 'lookup_incomplete', response.status);
          return response;
        } catch {
          trace(context, 'lookup_failed');
          context.worker.close();
          throw pending();
        }
      }
      if (operation === 'continue') {
        if (context.continuationMode !== 'songbird' || Object.keys(data).length !== 1
          || typeof data.payload !== 'string' || !data.payload.length || data.payload.length > 32768) {
          throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
        }
        const hash = createHash('sha256').update(data.payload).digest('hex');
        if (context.continuePromise) {
          if (context.continueHash !== hash) throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
          return context.continuePromise;
        }
        if (context.phase !== 'challenge') throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
        context.phase = 'continuing';
        context.continueHash = hash;
        context.continuePromise = (async () => {
          try {
            const response = await context.worker.call('continue', data);
            const accepted = response.status === 200 && response.success === true && response.action === null;
            if (accepted) context.phase = 'continued';
            else context.worker.close();
            trace(context, accepted ? 'authentication_continue_ready' : 'authentication_continue_incomplete', response.status);
            return response;
          } catch {
            trace(context, 'authentication_continue_failed');
            context.worker.close();
            throw pending();
          }
        })();
        return context.continuePromise;
      }
      if (operation !== 'retry' || Object.keys(data).length) throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
      if (context.phase === 'finishing') return context.retryPromise;
      const finishPhases = context.continuationMode === 'songbird' ? ['continued', 'frictionless'] : ['challenge', 'frictionless'];
      if (!finishPhases.includes(context.phase)) throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
      context.phase = 'finishing';
      context.retryPromise = (async () => {
        try {
          if (!await claimPixelPay3dsDispatch(db, { ...context.claim, deadline: context.deadline })
            || !current(context)) throw pending();
          trace(context, 'continuation_dispatched');
          const response = await context.worker.call('retry');
          const payment = await settle(response.final);
          trace(context, 'continuation_result', response.sdkResponse.status);
          return { ...response.sdkResponse, payment };
        } catch {
          trace(context, 'continuation_failed');
          throw pending();
        } finally { context.worker.close(); }
      })();
      return context.retryPromise;
    },
    close() {
      for (const context of attempts.values()) context.worker.close();
    },
  };
}
