import { randomUUID } from 'node:crypto';
import { DelegatedAttempt } from './attempt.js';

export function resolveQaDelegatedConfig(env, diagnostic) {
  const enabled = env.QA_PIXELPAY_DELEGATED_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('QA_PIXELPAY_DELEGATED_ENABLED invalido.');
  if (enabled === 'false') return null;
  if (!diagnostic?.enabled || diagnostic.sessionMode || !diagnostic.intentId
    || env.ENTORNO !== 'qa' || env.NODE_ENV !== 'development' || env.PIXELPAY_ENV !== 'sandbox') {
    throw new Error('PixelPay delegado requiere un unico intent QA Sandbox autorizado.');
  }
  return diagnostic;
}

export function createQaDelegatedAttempts({ config, makeAttempt = options => new DelegatedAttempt(options), now = Date.now }) {
  let live = null;
  return {
    async start({ claim, owner, input, provider }) {
      const deadline = Math.min(new Date(claim.protectionExpiresAt).getTime(), config.until);
      const lifetimeMs = deadline - now();
      if (live || !(lifetimeMs > 0) || claim.idIntent !== config.intentId || provider.env !== 'sandbox') {
        throw new Error('PIXELPAY_DELEGATED_CONTEXT_UNAVAILABLE');
      }
      const token = randomUUID();
      const worker = makeAttempt({
        workerUrl: new URL('./applicationWorker.js', import.meta.url),
        context: { attemptId: claim.paymentAttemptId, input,
          config: { env: provider.env, endpoint: provider.endpoint, appUrl: provider.appUrl,
            keyId: provider.keyId, secretKey: provider.secretKey, authHash: provider.authHash } },
        // AM: SDK HTTP calls own the transport timeout. The claim deadline bounds the worker.
        lifetimeMs, timeoutMs: null,
        onClose: () => { if (live?.token === token) live = null; },
      });
      live = { claim, owner, deadline, worker, token };
      try {
        const result = await worker.call('start');
        if (result.state !== 'challenge') worker.close();
        return { result, deadline, token };
      } catch (error) {
        worker.close();
        throw error;
      }
    },
    get({ idIntent, idGrupoCita, owner, token }) {
      if (!live || live.deadline <= now() || live.claim.idIntent !== idIntent
        || live.claim.idGrupoCita !== idGrupoCita || live.owner !== owner || live.token !== token) return null;
      return live;
    },
    close() { live?.worker.close(); },
  };
}
