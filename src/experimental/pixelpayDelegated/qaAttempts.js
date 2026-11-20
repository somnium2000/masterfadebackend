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
  let consumedLiveTest = false;
  return {
    async start({ claim, owner, input, provider }) {
      const deadline = Math.min(new Date(claim.protectionExpiresAt).getTime(), config.until);
      const lifetimeMs = deadline - now();
      const validIntent = config.liveTest
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.idIntent)
        : claim.idIntent === config.intentId;
      const validEnvironment = provider.env === (config.liveTest ? 'live' : 'sandbox');
      if (live || !(lifetimeMs > 0) || !validIntent || !validEnvironment
        || (config.liveTest && (consumedLiveTest || !Number.isFinite(claim.amount)
          || claim.amount <= 0 || claim.amount > config.maxAmountHnl))) {
        throw new Error('PIXELPAY_DELEGATED_CONTEXT_UNAVAILABLE');
      }
      // One real-money attempt per runtime; no automatic retry after close/errors.
      if (config.liveTest) consumedLiveTest = true;
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
      const context = { claim, owner, deadline, worker, token, continuationMode: null };
      live = context;
      try {
        const result = await worker.call('start');
        if (result.state === 'challenge') context.continuationMode = result.continuation_mode;
        else worker.close();
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
