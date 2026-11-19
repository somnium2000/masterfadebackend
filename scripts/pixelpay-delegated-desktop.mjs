import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { DelegatedAttempt } from '../src/experimental/pixelpayDelegated/attempt.js';
import { desktopContext } from '../test/fixtures/delegatedPixelPayProvider.mjs';

// AM: Standalone loopback-only fixture; not registered in MasterFade and never loads environment secrets.
const app = Fastify({ logger: false, bodyLimit: 40000 });
const attempts = new Map(['A', 'B'].map(id => [id, {
  token: randomBytes(24).toString('hex'),
  worker: new DelegatedAttempt({ workerUrl: new URL('../test/fixtures/delegatedPixelPayWorker.mjs', import.meta.url), context: desktopContext(id) }),
}]));
app.post('/attempts/:id/:operation', async (request, reply) => {
  reply.header('cache-control', 'no-store');
  const attempt = attempts.get(request.params.id);
  if (!attempt || request.headers.authorization !== `Bearer ${attempt.token}` || request.headers.origin) {
    return reply.code(403).send({ error: 'PROTOTYPE_FORBIDDEN' });
  }
  if (!['start', 'lookup', 'continue', 'retry', 'status'].includes(request.params.operation)) {
    return reply.code(400).send({ error: 'PROTOTYPE_OPERATION_INVALID' });
  }
  try { return await attempt.worker.call(request.params.operation, request.body || {}); }
  catch { return reply.code(409).send({ error: 'PROTOTYPE_UNCERTAIN', canStartAgain: false }); }
});
const address = await app.listen({ host: '127.0.0.1', port: 0 });
// AM: Ephemeral fixture capabilities only, consumed by the local integration test; no merchant secrets.
process.stdout.write(JSON.stringify({ address, tokens: Object.fromEntries([...attempts].map(([id, entry]) => [id, entry.token])) }) + '\n');
process.stdin.resume();
process.stdin.once('end', async () => {
  for (const { worker } of attempts.values()) worker.close();
  await app.close();
});
