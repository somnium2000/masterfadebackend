import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPublicPixelPay3dsAttempts, resolvePublicPixelPay3dsConfig } from '../src/services/payments/publicPixelPay3ds.js';
import { claimPixelPay3dsDispatch } from '../src/services/payments/pixelPaySaleAttemptStore.js';
import { startPostgres17 } from './helpers/postgres17.mjs';

const claim = () => ({
  idIntent: randomUUID(), idGrupoCita: randomUUID(), paymentAttemptId: randomUUID(),
  orderId: 'MF-test-order', amount: 1, currency: 'HNL', protectionExpiresAt: new Date(500_000).toISOString(),
});
const begin = (manager, current, owner, kind = 'booking', env = 'sandbox') => manager.start({
  kind, claim: current, owner, input: {}, provider: { env },
});
const contextFor = (manager, current, owner, token, kind = 'booking') => manager.get({
  kind, idIntent: current.idIntent, idGrupoCita: current.idGrupoCita, owner, token,
});

test('la continuación pública exige un perfil explícito Sandbox por identidad o Live público', () => {
  const qa = { qaBooking: { enabled: true }, qaSale: { enabled: true } };
  const sandbox = { PIXELPAY_PUBLIC_3DS_ENABLED: 'true', ENTORNO: 'qa', PIXELPAY_ENV: 'sandbox' };
  const live = {
    PIXELPAY_PUBLIC_3DS_ENABLED: 'true', NODE_ENV: 'production', ENTORNO: 'production',
    PAYMENT_PROVIDER: 'pixelpay', PIXELPAY_IMPLEMENTATION: 'sdk', PIXELPAY_ENV: 'live',
    PIXELPAY_ENDPOINT: 'https://provider.test', PIXELPAY_APP_URL: 'https://masterfade.test',
  };
  assert.equal(resolvePublicPixelPay3dsConfig({}, {}), false);
  assert.equal(resolvePublicPixelPay3dsConfig({ ...live, PIXELPAY_PUBLIC_3DS_ENABLED: 'false' }), false);
  assert.equal(resolvePublicPixelPay3dsConfig(sandbox, qa), 'sandbox');
  assert.throws(() => resolvePublicPixelPay3dsConfig({ ...sandbox, PIXELPAY_ENV: 'live' }, qa));
  assert.throws(() => resolvePublicPixelPay3dsConfig(sandbox, { ...qa, delegated: {} }));
  assert.throws(() => resolvePublicPixelPay3dsConfig(sandbox, { ...qa, qaSale: { enabled: false } }));
  for (const gate of ['bookingEnabled', 'vipPurchaseEnabled']) {
    assert.equal(resolvePublicPixelPay3dsConfig(live, { publicCommerce: { [gate]: true } }), 'live');
  }
  assert.throws(() => resolvePublicPixelPay3dsConfig(live, {}));
  const booking = { publicCommerce: { bookingEnabled: true } };
  assert.throws(() => resolvePublicPixelPay3dsConfig(live, { ...booking, ...qa }));
  for (const value of ['http://provider.test', 'https://pixelpay.dev', 'https://provider.test/path']) {
    assert.throws(() => resolvePublicPixelPay3dsConfig({ ...live, PIXELPAY_ENDPOINT: value }, booking));
  }
});

test('desafío y frictionless conservan intento, titular y fase y solo aplican un resultado', async t => {
  const attempts = new Map();
  const dispatched = new Set();
  const db = { async query(sql, [_id, attemptId]) {
    if (sql.includes('pixelpay.sale.3ds_continuation_dispatched')) {
      assert.equal(dispatched.has(attemptId), false);
      dispatched.add(attemptId);
    }
    return { rows: [{ payment_attempt_id: attemptId }] };
  } };
  const manager = createPublicPixelPay3dsAttempts({ db, environment: 'live', now: () => 1, makeAttempt({ context, onClose }) {
    const calls = [];
    attempts.set(context.attemptId, calls);
    return { close: onClose, async call(op, data) {
      calls.push(op);
      if (op === 'start') return { state: 'challenge', continuation_mode: 'direct_api' };
      if (op === 'lookup') return data.challenge
        ? { status: 202, success: true, action: 'continue' }
        : { status: 200, success: true, action: null };
      assert.ok(dispatched.has(context.attemptId));
      return { sdkResponse: { status: 200 }, final: { paymentAttemptId: context.attemptId } };
    } };
  } });
  t.after(() => manager.close());
  const a = claim(), b = claim();
  const [startedA, startedB] = await Promise.all([
    begin(manager, a, 'owner-a', 'booking', 'live'), begin(manager, b, 'owner-b', 'membership', 'live'),
  ]);
  assert.notEqual(startedA.token, startedB.token);
  assert.equal(contextFor(manager, a, 'owner-b', startedA.token), null);
  assert.equal(contextFor(manager, a, 'owner-a', startedB.token), null);
  assert.equal(contextFor(manager, a, 'owner-a', startedA.token, 'membership'), null);
  const contextA = contextFor(manager, a, 'owner-a', startedA.token);
  const contextB = contextFor(manager, b, 'owner-b', startedB.token, 'membership');
  await assert.rejects(manager.advance(contextA, 'retry', {}), { code: 'PIXELPAY_PUBLIC_3DS_PHASE_INVALID' });
  await manager.advance(contextA, 'lookup', { challenge: true });
  await manager.advance(contextB, 'lookup', { challenge: false });
  await assert.rejects(manager.advance(contextA, 'retry', { approved: true }), { code: 'PIXELPAY_PUBLIC_3DS_PHASE_INVALID' });
  const settled = [];
  const finish = context => manager.advance(context, 'retry', {}, async result => {
    settled.push(result.paymentAttemptId);
    return { id: result.paymentAttemptId };
  });
  const [resultA, resultAReplay, resultB] = await Promise.all([finish(contextA), finish(contextA), finish(contextB)]);
  assert.equal(resultA.payment.id, a.paymentAttemptId);
  assert.deepEqual(resultA, resultAReplay);
  assert.equal(resultB.payment.id, b.paymentAttemptId);
  assert.deepEqual(settled.sort(), [a.paymentAttemptId, b.paymentAttemptId].sort());
  for (const calls of attempts.values()) assert.deepEqual(calls, ['start', 'lookup', 'retry']);
});

test('vencimiento, pérdida de worker y falta del marcador local impiden la continuación', async t => {
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
  t.after(() => { manager.close(); anotherReplica.close(); });
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

test('una respuesta perdida después del despacho durable conserva el bloqueo', async t => {
  const a = claim();
  const calls = [];
  const db = { async query(sql) {
    calls.push(sql.includes('3ds_continuation_dispatched') ? 'claim' : 'record');
    return { rows: [{}] };
  } };
  const manager = createPublicPixelPay3dsAttempts({ db, now: () => 1, makeAttempt({ onClose }) {
    return { close: onClose, async call(op) {
      calls.push(op);
      if (op === 'start') return { state: 'challenge', continuation_mode: 'direct_api' };
      if (op === 'lookup') return { status: 202, success: true, action: 'continue' };
      throw new Error('No se recibió respuesta');
    } };
  } });
  t.after(() => manager.close());
  const { token } = await begin(manager, a, 'owner-a');
  const active = contextFor(manager, a, 'owner-a', token);
  await manager.advance(active, 'lookup', {});
  for (let i = 0; i < 2; i++) {
    await assert.rejects(manager.advance(active, 'retry', {}, () => assert.fail('conciliación inesperada')),
      { code: 'PIXELPAY_PUBLIC_3DS_CONTEXT_LOST' });
  }
  assert.equal(contextFor(manager, a, 'owner-a', token), null);
  assert.deepEqual(calls, ['start', 'record', 'lookup', 'claim', 'retry']);
});

test('PostgreSQL 17 arbitra un único despacho concurrente para el contexto 202 vigente',
  { skip: !process.env.MASTERFADE_TEST_PG_BIN }, async t => {
    const isolated = await startPostgres17();
    const pool = new pg.Pool(isolated.connectionOptions);
    t.after(async () => { await pool.end(); await isolated.stop(); });
    await isolated.client.query(`
      CREATE SCHEMA app_private;
      CREATE TABLE public.payment_providers(id_provider uuid PRIMARY KEY, codigo text NOT NULL);
      CREATE TABLE public.payment_intents(
        id_intent uuid PRIMARY KEY, id_provider uuid REFERENCES public.payment_providers,
        estado_intent_codigo text NOT NULL, orden_compra text NOT NULL, monto_hnl numeric NOT NULL,
        moneda_codigo text NOT NULL, expires_at timestamptz NOT NULL, provider_session_id text, referencia_externa text
      );
      CREATE TABLE app_private.pixelpay_sale_attempts(
        payment_attempt_id uuid PRIMARY KEY, id_intent uuid REFERENCES public.payment_intents,
        upstream_http_status smallint, finalized_at timestamptz
      );
      CREATE TABLE public.payment_events(
        id_event uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_provider uuid REFERENCES public.payment_providers,
        provider_event_id text NOT NULL, evento_tipo text NOT NULL, firma_valida boolean NOT NULL,
        payload_esencial jsonb NOT NULL, id_intent uuid REFERENCES public.payment_intents,
        UNIQUE(id_provider, provider_event_id)
      );
    `);
    const provider = randomUUID();
    const a = { ...claim(), deadline: Date.now() + 90_000 };
    await pool.query("INSERT INTO public.payment_providers VALUES ($1,'pixelpay')", [provider]);
    await pool.query(`INSERT INTO public.payment_intents
      VALUES ($1,$2,'pendiente_confirmacion',$3,$4,$5,clock_timestamp() + interval '1 minute',NULL,NULL)`,
    [a.idIntent, provider, a.orderId, a.amount, a.currency]);
    await pool.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES ($1,$2,NULL,NULL)',
      [a.paymentAttemptId, a.idIntent]);
    assert.equal(await claimPixelPay3dsDispatch(pool, a), false);
    await pool.query('UPDATE app_private.pixelpay_sale_attempts SET upstream_http_status = 202');
    for (const override of [
      { idIntent: randomUUID() }, { paymentAttemptId: randomUUID() }, { orderId: 'other' },
      { amount: 2 }, { currency: 'USD' }, { deadline: Date.now() - 1000 },
    ]) assert.equal(await claimPixelPay3dsDispatch(pool, { ...a, ...override }), false);
    const results = await Promise.all([claimPixelPay3dsDispatch(pool, a), claimPixelPay3dsDispatch(pool, a)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await claimPixelPay3dsDispatch(pool, a), false);
    const { rows } = await pool.query('SELECT evento_tipo, firma_valida, payload_esencial FROM public.payment_events');
    assert.deepEqual(rows, [{ evento_tipo: 'pixelpay.sale.3ds_continuation_dispatched',
      firma_valida: false, payload_esencial: { payment_attempt_id: a.paymentAttemptId } }]);
  });
