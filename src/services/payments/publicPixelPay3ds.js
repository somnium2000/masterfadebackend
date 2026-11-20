import { randomUUID } from 'node:crypto';
import { DelegatedAttempt } from '../../experimental/pixelpayDelegated/attempt.js';
import { AppError } from '../../utils/errors.js';
import { recordPixelPay3dsContinuation } from './pixelPaySaleAttemptStore.js';

const MAX_ACTIVE_ATTEMPTS = 8;
const MAX_CONTEXT_MS = 120_000;

export function publicPixelPay3dsUnavailable() {
  return new AppError(503, 'El pago con autenticación no está disponible en este momento.', {
    code: 'PIXELPAY_PUBLIC_3DS_UNAVAILABLE',
  });
}

const pending = (code = 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST') => new AppError(
  409, 'El pago sigue pendiente de verificación.', { code },
);

export function resolvePublicPixelPay3dsConfig(env, { qaBooking, qaSale, delegated }) {
  const enabled = String(env.PIXELPAY_PUBLIC_3DS_ENABLED ?? 'false').trim();
  if (enabled === 'false') return false;
  if (enabled !== 'true' || !qaBooking?.enabled || !qaSale?.enabled || delegated
    || env.ENTORNO !== 'qa' || env.PIXELPAY_ENV !== 'sandbox') {
    throw new Error('PIXELPAY_PUBLIC_3DS_ENABLED requiere QA SDK Sandbox, identidad y Sale QA, sin modo delegado de prueba.');
  }
  return true;
}

export function buildPublicPixelPay3dsHandoff({ result, deadline, token }) {
  if (result.state !== 'challenge' || result.continuation_mode !== 'direct_api') return null;
  return { state: result.state, order: result.order, sdk: result.sdk, continuation: result.continuation,
    continuation_mode: result.continuation_mode, token, expiresAt: deadline };
}

export function createPublicPixelPay3dsAttempts({
  db, makeAttempt = options => new DelegatedAttempt(options), now = Date.now,
}) {
  const attempts = new Map();
  const reserved = new Set();
  const keyFor = ({ kind, idIntent }) => `${kind}:${idIntent}`;
  const current = context => attempts.get(context.key) === context && now() < context.deadline;
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
      if (provider.env !== 'sandbox' || !owner || !(deadline > startedAt)
        || attempts.has(key) || !hasSlot) throw pending();
      const token = randomUUID();
      const worker = makeAttempt({
        workerUrl: new URL('../../experimental/pixelpayDelegated/applicationWorker.js', import.meta.url),
        context: { attemptId: claim.paymentAttemptId, input, publicContinuation: true,
          config: { env: provider.env, endpoint: provider.endpoint, appUrl: provider.appUrl,
            keyId: provider.keyId, secretKey: provider.secretKey, authHash: provider.authHash } },
        lifetimeMs: deadline - startedAt,
        onClose: () => { if (attempts.get(key)?.token === token) attempts.delete(key); },
      });
      const context = { key, claim, owner, deadline, token, worker, phase: 'starting' };
      attempts.set(key, context);
      try {
        const result = await worker.call('start');
        if (result.state === 'challenge' || result.state === 'unsupported') {
          if (!await recordPixelPay3dsContinuation(db, { ...claim, paymentUuid: result.observedPaymentUuid })) {
            throw pending();
          }
        }
        if (result.state === 'challenge') {
          if (!current(context)) throw pending();
          context.phase = 'collection';
        } else worker.close();
        return { result, deadline, token };
      } catch {
        worker.close();
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
          return response;
        } catch {
          context.worker.close();
          throw pending();
        }
      }
      if (operation !== 'retry' || Object.keys(data).length) throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
      if (context.phase === 'challenge') {
        context.worker.close();
        throw pending('PIXELPAY_PUBLIC_3DS_PROOF_UNAVAILABLE');
      }
      if (context.phase === 'finishing') return context.retryPromise;
      if (context.phase !== 'frictionless') throw pending('PIXELPAY_PUBLIC_3DS_PHASE_INVALID');
      context.phase = 'finishing';
      context.retryPromise = (async () => {
        try {
          const response = await context.worker.call('retry');
          const payment = await settle(response.final);
          return { ...response.sdkResponse, payment };
        } catch {
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
