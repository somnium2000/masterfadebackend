import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPublicPixelPay3dsAttempts, resolvePublicPixelPay3dsConfig } from '../src/services/payments/publicPixelPay3ds.js';

const claim = () => ({ idIntent: randomUUID(), idGrupoCita: randomUUID(),
  paymentAttemptId: randomUUID(), protectionExpiresAt: new Date(500_000).toISOString() });
const begin = (manager, current, owner) => manager.start({
  kind: 'booking', claim: current, owner, input: {}, provider: { env: 'sandbox' },
});
const contextFor = (manager, current, owner, token, kind = 'booking') => manager.get({
  kind, idIntent: current.idIntent, idGrupoCita: current.idGrupoCita, owner, token,
});

test('la continuación pública está apagada por defecto y separada de Live y del modo de prueba', () => {
  const valid = { qaBooking: { enabled: true }, qaSale: { enabled: true } };
  const config = { PIXELPAY_PUBLIC_3DS_ENABLED: 'true', ENTORNO: 'qa', PIXELPAY_ENV: 'sandbox' };
  assert.equal(resolvePublicPixelPay3dsConfig({}, {}), false);
  assert.equal(resolvePublicPixelPay3dsConfig(config, valid), true);
  assert.throws(() => resolvePublicPixelPay3dsConfig({ ...config, PIXELPAY_ENV: 'live' }, valid));
  assert.throws(() => resolvePublicPixelPay3dsConfig(config, { ...valid, delegated: {} }));
  assert.throws(() => resolvePublicPixelPay3dsConfig(config, { ...valid, qaSale: { enabled: false } }));
});

test('workers simultáneos conservan intento, titular y fase, y el resultado se aplica una vez', async t => {
  const attempts = new Map();
  const db = { async query(_sql, [_id, attemptId]) { return { rows: [{ payment_attempt_id: attemptId }] }; } };
  const manager = createPublicPixelPay3dsAttempts({ db, now: () => 1, makeAttempt({ context, onClose }) {
    const calls = [];
    attempts.set(context.attemptId, calls);
    return { close: onClose, async call(op) {
      calls.push(op);
      if (op === 'start') return { state: 'challenge', continuation_mode: 'direct_api' };
      if (op === 'lookup') return { status: 200, success: true, action: null };
      return { sdkResponse: { status: 200 }, final: { paymentAttemptId: context.attemptId } };
    } };
  } });
  t.after(() => manager.close());
  const a = claim(), b = claim();
  const [startedA, startedB] = await Promise.all([begin(manager, a, 'owner-a'), begin(manager, b, 'owner-b')]);
  assert.notEqual(startedA.token, startedB.token);
  assert.equal(contextFor(manager, a, 'owner-b', startedA.token), null);
  assert.equal(contextFor(manager, a, 'owner-a', startedB.token), null);
  assert.equal(contextFor(manager, a, 'owner-a', startedA.token, 'membership'), null);
  const contexts = [contextFor(manager, a, 'owner-a', startedA.token), contextFor(manager, b, 'owner-b', startedB.token)];
  await Promise.all(contexts.map(context => manager.advance(context, 'lookup', { reference: 'offline' })));
  const settled = [];
  const finish = context => manager.advance(context, 'retry', {}, async result => {
    settled.push(result.paymentAttemptId);
    return { id: result.paymentAttemptId };
  });
  const [resultA, resultAReplay, resultB] = await Promise.all([finish(contexts[0]), finish(contexts[0]), finish(contexts[1])]);
  assert.equal(resultA.payment.id, a.paymentAttemptId);
  assert.deepEqual(resultA, resultAReplay);
  assert.equal(resultB.payment.id, b.paymentAttemptId);
  assert.deepEqual(settled.sort(), [a.paymentAttemptId, b.paymentAttemptId].sort());
  for (const calls of attempts.values()) assert.deepEqual(calls, ['start', 'lookup', 'retry']);
});

test('vencimiento, pérdida de réplica y falta del marcador local impiden la continuación', async () => {
  let now = 1, workerClose;
  let update = true;
  const db = { async query() { return { rows: update ? [{}] : [] }; } };
  const options = { db, now: () => now, makeAttempt({ onClose }) {
    workerClose = onClose;
    return { close: onClose, async call(op) {
      assert.equal(op, 'start');
      return { state: 'challenge', continuation_mode: 'direct_api' };
    } };
  } };
  const manager = createPublicPixelPay3dsAttempts(options);
  const anotherReplica = createPublicPixelPay3dsAttempts(options);
  const a = claim();
  const { token } = await begin(manager, a, 'owner-a');
  const active = contextFor(manager, a, 'owner-a', token);
  assert.ok(active);
  assert.equal(contextFor(anotherReplica, a, 'owner-a', token), null);
  now = active.deadline;
  await assert.rejects(manager.advance(active, 'retry', {}), { code: 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST' });
  workerClose();
  assert.equal(contextFor(manager, a, 'owner-a', token), null);
  update = false;
  await assert.rejects(begin(manager, claim(), 'owner-b'), { code: 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST' });
});
