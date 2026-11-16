import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { startPostgres17 } from './helpers/postgres17.mjs';
import { SongbirdBridge } from '../src/services/payments/songbirdBridge.js';
import { SongbirdRepository } from '../src/services/payments/songbirdRepository.js';
import { assertSongbirdFinalizationBlocked } from '../src/services/payments/songbirdContract.js';
import { createSongbirdSdkContract } from '../src/services/payments/songbirdSdkContract.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const ORDER = 'MF-OPERATIONAL-SYNTHETIC';
const TOKEN = `synthetic.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url')}.signature`;
const VALIDATED = 'synthetic.validated.signature';
const SERVER_CONTEXT = { serverOnly: 'SYNTHETIC-SERVER-CONTEXT-NEVER-RETURN' };
const challenge = { acsUrl: 'https://acs.offline.invalid/challenge', payload: 'synthetic-challenge',
  transactionId: 'synthetic-auth', authenticationId: 'synthetic-identifier' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('Songbird operational claims PostgreSQL17: concurrency, failed authentication and expiry never dispatch financial operations', {
  skip: process.env.RUN_PIXELPAY_SONGBIRD_PG !== 'true', timeout: 120000,
}, async t => {
  const original = net.Socket.prototype.connect;
  let externalConnections = 0;
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : net._normalizeArgs(args)[0];
    if (!['127.0.0.1', '::1'].includes(options.host)) { externalConnections++; throw new Error('NONLOCAL_NETWORK_BLOCKED'); }
    return original.apply(this, args);
  };
  let cluster; let pool;
  try {
    cluster = await startPostgres17();
    pool = new pg.Pool({ ...cluster.connectionOptions, options: '-c statement_timeout=7000', query_timeout: 8000, max: 8 });
    await pool.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA app_private;
      CREATE TABLE payment_intents(id_intent uuid PRIMARY KEY,created_by_usuario_id uuid,id_grupo_cita uuid,
        orden_compra text,monto_hnl numeric,moneda_codigo text,estado_intent_codigo text);
      CREATE TABLE app_private.pixelpay_sale_attempts(payment_attempt_id uuid PRIMARY KEY,id_intent uuid REFERENCES payment_intents);
      CREATE TABLE citas(id_cita uuid PRIMARY KEY,id_grupo_cita uuid,estado_cita_codigo text,deleted_at timestamptz);
      CREATE TABLE citas_holds(id_hold uuid PRIMARY KEY,id_cita uuid,estado_hold_codigo text,expires_at timestamptz);
      CREATE TABLE payments(id int); CREATE TABLE payment_events(id int);`);
    await pool.query(await readFile(new URL('../db/migrations/pixel/20261115190000_pixelpay_songbird_handoff.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../db/migrations/pixel/20261116003000_pixelpay_songbird_operational_context.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO payment_intents VALUES($1,$2,$3,$4,1,'HNL','pendiente_confirmacion')", [ID, OWNER, GROUP, ORDER]);
    await pool.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES($1,$2)', [ATTEMPT, ID]);
    await pool.query("INSERT INTO citas VALUES($1,$2,'pendiente_pago',NULL),($3,$2,'pendiente_pago',NULL)", [ID, GROUP, ATTEMPT]);
    await pool.query("INSERT INTO citas_holds VALUES($1,$1,'activo',clock_timestamp()+interval '30 minutes'),($2,$2,'activo',clock_timestamp()+interval '30 minutes')", [ID, ATTEMPT]);
    const repository = new SongbirdRepository(pool);
    const config = { enabled: true, key: Buffer.alloc(32, 8) };
    const snapshot = async () => (await pool.query('SELECT * FROM app_private.pixelpay_songbird_handoffs')).rows[0];
    const noFinancialEffects = async counter => {
      assert.equal(counter.finalize, 0);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM payments')).rows[0].n), 0);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM payment_events')).rows[0].n), 0);
      assert.equal((await pool.query('SELECT estado_intent_codigo FROM payment_intents')).rows[0].estado_intent_codigo, 'pendiente_confirmacion');
      assert.equal(Number((await pool.query("SELECT count(*) n FROM citas WHERE estado_cita_codigo='pendiente_pago'")).rows[0].n), 2);
      assert.equal(Number((await pool.query("SELECT count(*) n FROM citas_holds WHERE estado_hold_codigo='activo'")).rows[0].n), 2);
    };
    const rig = async () => {
      await pool.query('DELETE FROM app_private.pixelpay_songbird_handoffs');
      let time = Date.now();
      const counter = { lookup: 0, validate: 0, finalize: 0 };
      const contract = {
        browserPayloadAccredited: true, contextRequired: true, financialFinalizationAccredited: false,
        inspect: value => value === TOKEN,
        challengeAllowed: value => value.acsUrl === challenge.acsUrl,
        async lookup() { counter.lookup++; return { verified: true, challenge }; },
        async validate() { counter.validate++; return { verified: true }; },
        async finalize() { counter.finalize++; throw new Error('FINANCIAL_OPERATION_FORBIDDEN'); },
      };
      const bridge = new SongbirdBridge({ repository, config, contract, clock: () => time });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await bridge.reserve(c, { idIntent: ID, paymentAttemptId: ATTEMPT, ownerId: OWNER, groupId: GROUP,
          orderId: ORDER, amount: 1, currency: 'HNL', expiresAt: new Date(time + 1800000).toISOString() });
        await c.query('COMMIT');
      } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
      await bridge.capture(ID, OWNER, TOKEN, SERVER_CONTEXT);
      const captured = await snapshot();
      assert.equal(typeof captured.context_box, 'string');
      assert.equal(captured.context_box.includes(SERVER_CONTEXT.serverOnly), false);
      const handoff = (await bridge.claim(ID, OWNER)).handoff;
      assert.equal(handoff.jwt, TOKEN);
      assert.equal(JSON.stringify(handoff).includes(SERVER_CONTEXT.serverOnly), false);
      assert.equal(JSON.stringify(await bridge.status(ID, OWNER)).includes(SERVER_CONTEXT.serverOnly), false);
      assert.equal((await snapshot()).payload_box, null);
      return { bridge, handoff, counter, contract, expire: () => { time = Date.parse(handoff.expires_at) + 1; } };
    };
    const racePhase = async (fixture, operation, value) => {
      const entered = deferred(); const releaseIo = deferred();
      const method = operation === 'setup' ? 'lookup' : 'validate';
      const previous = fixture.contract[method];
      fixture.contract[method] = async (...args) => {
        const result = await previous(...args); entered.resolve(); await releaseIo.promise; return result;
      };
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [`pixelpay-sale:${ID}`]);
      const start = () => fixture.bridge.step(ID, OWNER, operation, fixture.handoff.lease_id, value)
        .then(result => ({ ok: true, result }), error => ({ ok: false, code: error.code }));
      const attempts = [start(), start()];
      let blockerReleased = false;
      try {
        let waiters = 0;
        for (let n = 0; n < 300; n++) {
          waiters = Number((await pool.query("SELECT count(DISTINCT pid) n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n);
          if (waiters === 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiters, 2, 'both independent PostgreSQL clients must wait on the actual claim lock');
        await blocker.query('COMMIT'); blocker.release(); blockerReleased = true;
        const adapterEntered = await Promise.race([entered.promise.then(() => true), Promise.all(attempts).then(() => false)]);
        assert.equal(adapterEntered, true);
        assert.equal((await snapshot()).state, operation === 'setup' ? 'setup_in_flight' : 'validation_in_flight');
        assert.equal((await snapshot()).context_box, null);
        const rejected = await Promise.race(attempts);
        assert.equal(rejected.ok, false);
        assert.equal(rejected.code, 'SONGBIRD_PHASE_ALREADY_CLAIMED');
      } finally {
        if (!blockerReleased) { await blocker.query('COMMIT'); blocker.release(); }
        releaseIo.resolve();
      }
      const results = await Promise.all(attempts);
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(fixture.counter[method], 1);
      return results.find(result => result.ok).result;
    };

    await t.test('independent initial JWT order diagnostics remain callback-only and both mismatches keep the durable bridge blocked', async () => {
      let providerCalls = 0;
      const contract = createSongbirdSdkContract({ providerFactory() {
        providerCalls++; throw new Error('PROVIDER_FORBIDDEN');
      } });
      const bridge = new SongbirdBridge({ repository, config, contract });
      const key = Buffer.alloc(32, 7).toString('base64');
      const boxed = `${Buffer.alloc(16, 8).toString('base64')}|${Buffer.alloc(24, 9).toString('base64')}`;
      const context = { version: 1, collectionUrlPresent: false,
        order: { id: ORDER, amount: '1.00', currency: 'HNL' },
        sdkPublicKey: key, merchantPublicKey: key,
        encrypted: { card_number: boxed, card_expire: boxed }, billing: {} };
      const privateMarker = 'SYNTHETIC-FOREIGN-ORDER-NEVER-LOG';
      for (const field of ['top', 'nested']) {
        await pool.query('DELETE FROM app_private.pixelpay_songbird_handoffs');
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await bridge.reserve(c, { idIntent: ID, paymentAttemptId: ATTEMPT, ownerId: OWNER, groupId: GROUP,
            orderId: ORDER, amount: 1, currency: 'HNL', expiresAt: new Date(Date.now() + 600000).toISOString() });
          await c.query('COMMIT');
        } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
        const claims = { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
          order_id: field === 'top' ? privateMarker : ORDER,
          Payload: { OrderDetails: { OrderNumber: field === 'nested' ? privateMarker : ORDER } } };
        const payload = [{ alg: 'HS256' }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'))
          .concat('c3ludGhldGlj').join('.');
        const result = await bridge.capture(ID, OWNER, payload, context);
        assert.equal(result.state, 'contract_blocked');
        assert.equal(result.financial_finalization_enabled, false);
        assert.equal(result.capture_diagnostic.rule, 'JWT_ORDER_MISMATCH');
        const flags = result.capture_diagnostic.flags;
        assert.equal(flags.jwt_order_id_present, true);
        assert.equal(flags.jwt_order_number_present, true);
        assert.equal(flags.jwt_order_id_matches, field !== 'top');
        assert.equal(flags.jwt_order_number_matches, field !== 'nested');
        assert.equal(Object.values(flags).every(value => typeof value === 'boolean'), true);
        const saved = await snapshot();
        assert.equal(saved.block_code, 'PIXELPAY_SONGBIRD_CONTEXT_UNAVAILABLE');
        assert.equal(saved.payload_box, null); assert.equal(saved.context_box, null);
        assert.equal(Object.hasOwn(saved, 'capture_diagnostic'), false);
        const restarted = new SongbirdBridge({ repository: new SongbirdRepository(pool), config, contract });
        const status = await restarted.status(ID, OWNER);
        assert.equal(status.state, 'contract_blocked');
        assert.equal(Object.hasOwn(status, 'capture_diagnostic'), false);
        await assert.rejects(restarted.claim(ID, OWNER), error => error.code === 'PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
        for (const object of [result, saved, status]) {
          assert.equal(JSON.stringify(object).includes(payload), false);
          assert.equal(JSON.stringify(object).includes(privateMarker), false);
          assert.equal(JSON.stringify(object).includes(boxed), false);
        }
        await noFinancialEffects({ finalize: 0 });
      }
      assert.equal(providerCalls, 0);
    });

    await t.test('legacy rollback writer closes a lease without knowing context_box; cleanup remains private and invoker', async () => {
      const fixture = await rig();
      const before = await snapshot();
      assert.equal(typeof before.context_box, 'string');
      // AM: The previous binary updates state without including the new context column.
      await pool.query("UPDATE app_private.pixelpay_songbird_handoffs SET state='interrupted' WHERE id_intent=$1", [ID]);
      const after = await snapshot();
      assert.equal(after.state, 'interrupted');
      assert.equal(after.context_box, null);
      assert.equal(after.lease_id, before.lease_id);
      assert.equal(after.payload_box, null);
      const privileges = (await pool.query(`SELECT
        has_function_privilege('authenticated','app_private.clear_pixelpay_songbird_context()','EXECUTE') AS authenticated_allowed,
        has_function_privilege('anon','app_private.clear_pixelpay_songbird_context()','EXECUTE') AS anon_allowed,
        has_function_privilege('service_role','app_private.clear_pixelpay_songbird_context()','EXECUTE') AS service_allowed,
        (SELECT prosecdef FROM pg_proc WHERE oid='app_private.clear_pixelpay_songbird_context()'::regprocedure) AS security_definer`)).rows[0];
      assert.equal(privileges.authenticated_allowed, false);
      assert.equal(privileges.anon_allowed, false);
      assert.equal(privileges.service_allowed, true);
      assert.equal(privileges.security_definer, false);
      await noFinancialEffects(fixture.counter);
    });
    await t.test('setup claim commits before adapter; two database waiters generate only one lookup', async () => {
      const fixture = await rig();
      const result = await racePhase(fixture, 'setup', 'synthetic-session');
      assert.equal(result.state, 'challenge_ready');
      assert.equal(result.financial_finalization_enabled, false);
      await noFinancialEffects(fixture.counter);
    });
    await t.test('validated claim commits before adapter; two waiters generate one continue and no final Sale', async () => {
      const fixture = await rig();
      await fixture.bridge.step(ID, OWNER, 'setup', fixture.handoff.lease_id, 'synthetic-session');
      const result = await racePhase(fixture, 'validated', VALIDATED);
      assert.equal(result.state, 'authentication_complete');
      assert.equal(result.financial_finalization_enabled, false);
      assert.throws(assertSongbirdFinalizationBlocked, error => error.code === 'PIXELPAY_3DS_FINALIZATION_BLOCKED');
      await noFinancialEffects(fixture.counter);
    });
    await t.test('explicit failed authentication is durable and can neither finalize nor re-send continue', async () => {
      const fixture = await rig();
      fixture.contract.validate = async () => { fixture.counter.validate++; return { verified: false, rejected: true }; };
      await fixture.bridge.step(ID, OWNER, 'setup', fixture.handoff.lease_id, 'synthetic-session');
      const failed = await fixture.bridge.step(ID, OWNER, 'validated', fixture.handoff.lease_id, VALIDATED);
      assert.equal(failed.state, 'authentication_failed');
      assert.equal(failed.financial_finalization_enabled, false);
      const restarted = new SongbirdBridge({ repository: new SongbirdRepository(pool), config, contract: fixture.contract });
      assert.equal((await restarted.status(ID, OWNER)).state, 'authentication_failed');
      await assert.rejects(restarted.step(ID, OWNER, 'validated', fixture.handoff.lease_id, VALIDATED), error => error.code === 'SONGBIRD_PHASE_ALREADY_CLAIMED');
      assert.equal(fixture.counter.validate, 1);
      await noFinancialEffects(fixture.counter);
    });
    await t.test('late lookup after handoff expiry cannot revive challenge or reuse the original payload', async () => {
      const fixture = await rig(); const entered = deferred(); const finish = deferred();
      fixture.contract.lookup = async () => { fixture.counter.lookup++; entered.resolve(); await finish.promise; return { verified: true, challenge }; };
      const operation = fixture.bridge.step(ID, OWNER, 'setup', fixture.handoff.lease_id, 'synthetic-session');
      await entered.promise; fixture.expire(); finish.resolve();
      assert.equal((await operation).state, 'expired');
      const row = await snapshot();
      assert.equal(row.payload_box, null); assert.equal(row.challenge_box, null); assert.equal(row.context_box, null);
      assert.equal((await fixture.bridge.claim(ID, OWNER)).state, 'expired');
      assert.equal(fixture.counter.lookup, 1);
      await noFinancialEffects(fixture.counter);
    });
    await t.test('uncertain continue survives backend restart and cannot be resent through setup or validated', async () => {
      const fixture = await rig();
      await fixture.bridge.step(ID, OWNER, 'setup', fixture.handoff.lease_id, 'synthetic-session');
      fixture.contract.validate = async () => { fixture.counter.validate++; throw new Error('SYNTHETIC_TRANSPORT_LOSS'); };
      assert.equal((await fixture.bridge.step(ID, OWNER, 'validated', fixture.handoff.lease_id, VALIDATED)).state, 'interrupted');
      const restarted = new SongbirdBridge({ repository: new SongbirdRepository(pool), config, contract: fixture.contract });
      assert.equal((await restarted.status(ID, OWNER)).state, 'interrupted');
      for (const [op, value] of [['setup', 'synthetic-session'], ['validated', VALIDATED]]) {
        await assert.rejects(restarted.step(ID, OWNER, op, fixture.handoff.lease_id, value), error => error.code === 'SONGBIRD_PHASE_ALREADY_CLAIMED');
      }
      assert.equal(fixture.counter.lookup, 1); assert.equal(fixture.counter.validate, 1);
      await noFinancialEffects(fixture.counter);
    });
  } finally {
    if (pool) await pool.end();
    if (cluster) await cluster.stop();
    net.Socket.prototype.connect = original;
    assert.equal(externalConnections, 0);
  }
});
