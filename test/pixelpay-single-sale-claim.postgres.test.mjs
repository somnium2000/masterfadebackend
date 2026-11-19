import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { createPixelPaySaleAttemptRecord, finalizePixelPaySaleAttempt } from '../src/services/payments/pixelPaySaleAttemptStore.js';
import { loadPixelPayQaOrigin } from '../src/services/payments/pixelPayQaOrigin.js';
import { resolveQaPixelPay3dsDiagnostic } from '../src/services/payments/qaPixelPay3dsDiagnostic.js';

const RUN = process.env.RUN_PIXELPAY_SINGLE_SALE_CLAIM_PG === 'true';
const INTENT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const CITA = '33333333-3333-4333-8333-333333333333';
const HOLD = '44444444-4444-4444-8444-444444444444';
const OTHER_GROUP = '55555555-5555-4555-8555-555555555555';

function functionSql(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, name);
  const section = source.slice(start);
  const tag = section.match(/AS (\$[a-z_]+\$)/i)?.[1];
  assert.ok(tag);
  const end = section.indexOf(`${tag};`, section.indexOf(`AS ${tag}`) + tag.length + 3);
  assert.ok(end > 0);
  return section.slice(0, end + tag.length + 1);
}

async function isolatedPostgres() {
  const detected = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8', windowsHide: true });
  const bin = process.env.MASTERFADE_TEST_PG_BIN || (detected.status === 0 ? detected.stdout.trim() : 'C:/Program Files/PostgreSQL/17/bin');
  const directory = await mkdtemp(path.join(tmpdir(), 'masterfade-single-sale-pg-'));
  const data = path.join(directory, 'data');
  const run = (name, args) => {
    const output = path.join(directory, `${name}.log`);
    const fd = openSync(output, 'w');
    let result;
    try {
      result = spawnSync(path.join(bin, process.platform === 'win32' ? `${name}.exe` : name), args,
        { windowsHide: true, encoding: 'utf8', timeout: 30000, stdio: ['ignore', fd, fd] });
    } finally { closeSync(fd); }
    assert.equal(result.status, 0, `${name}: ${result.error?.message || `exit ${result.status}; log ${output}`}`);
  };
  let client;
  const stop = async () => {
    if (client) await client.end();
    let pid;
    try { pid = await readFile(path.join(data, 'postmaster.pid'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pid) {
      assert.equal(path.resolve(pid.split(/\r?\n/)[1]), path.resolve(data));
      run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    }
    // AM: Limpiar exclusivamente el cluster temporal propio, nunca un servidor existente.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('masterfade-single-sale-pg-'));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C', '--no-sync']);
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    await appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
    run('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-t', '20', '-w', 'start']);
    const options = { host: '127.0.0.1', port, user: 'postgres', password: '', database: 'postgres', ssl: false,
      connectionTimeoutMillis: 5000, query_timeout: 10000 };
    client = new pg.Client(options);
    await client.connect();
    assert.match((await client.query('SHOW server_version')).rows[0].server_version, /^17\./);
    assert.equal(path.resolve((await client.query('SHOW data_directory')).rows[0].data_directory), path.resolve(data));
    return { client, options, stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

test('PostgreSQL17: RPC y START durable permiten un solo claim Sale por intent', { skip: !RUN }, async t => {
  // AM: Prueba RPC/store reales; el envio es un contador inerte, no un endpoint HTTP.
  const connect = net.Socket.prototype.connect;
  let externalConnections = 0;
  net.Socket.prototype.connect = function (...args) {
    const host = typeof args[0] === 'object' ? args[0]?.host : args[1];
    if (host !== '127.0.0.1') { externalConnections++; throw new Error('External network prohibited'); }
    return connect.apply(this, args);
  };
  let isolated;
  try {
    isolated = await isolatedPostgres();
    const { client, options } = isolated;
    await client.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA app_private;
      CREATE TABLE public.parametros_sistema(clave text PRIMARY KEY,valor_numero numeric);
      INSERT INTO public.parametros_sistema VALUES ('agendamiento_confirmacion_pago_gracia_min',5);
      CREATE TABLE public.payment_intents(id_intent uuid PRIMARY KEY,id_grupo_cita uuid NOT NULL,
        origen_pago_codigo text NOT NULL,estado_intent_codigo text NOT NULL,expires_at timestamptz,updated_at timestamptz);
      CREATE TABLE public.citas(id_cita uuid PRIMARY KEY,id_grupo_cita uuid NOT NULL,deleted_at timestamptz,estado_cita_codigo text NOT NULL);
      CREATE TABLE public.citas_holds(id_hold uuid PRIMARY KEY,id_cita uuid REFERENCES public.citas,
        estado_hold_codigo text NOT NULL,expires_at timestamptz NOT NULL,updated_at timestamptz);`);
    for (const [file, name] of [
      ['20260701_fase_1_rpc_reserva_atomica_holds.sql', 'app_private.obtener_gracia_confirmacion_pago_min_v1'],
      ['pixel/20260924010000_pixelpay_reconciliation_window.sql', 'app_private.proteger_reserva_pago_v1'],
    ]) await client.query(functionSql(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'), name));
    for (const file of ['20261011043911_pixelpay_sale_attempts.sql', '20261016010000_pixelpay_uncertain_observed_identifiers.sql',
      '20261018010000_pixelpay_observed_payment_uuid_opaque.sql', '20261028010000_pixelpay_provider_response_code.sql']) {
      await client.query(await readFile(new URL(`../db/migrations/pixel/${file}`, import.meta.url), 'utf8'));
    }
    let simulatedPosts = 0;
    await client.query(await readFile(new URL('../db/migrations/pixel/20261115233000_pixelpay_qa_test_origin.sql',import.meta.url),'utf8'));
    const reset = async (expired = false) => {
      simulatedPosts = 0;
      await client.query('TRUNCATE app_private.pixelpay_sale_attempts,public.payment_intents,public.citas_holds,public.citas');
      await client.query(`INSERT INTO public.payment_intents VALUES ($1,$2,'cita','link_generado',clock_timestamp()+interval '2 minutes',now());
        `, [INTENT, GROUP]);
      await client.query(`INSERT INTO public.citas VALUES ($1,$2,NULL,'pendiente_pago')`, [CITA, GROUP]);
      await client.query(`INSERT INTO public.citas_holds VALUES ($1,$2,'activo',clock_timestamp()+($3::integer*interval '1 minute'),now())`, [HOLD, CITA, expired ? -1 : 2]);
    };
    const start = async (connection, group = GROUP, id = INTENT, qaTestOrigin = null) => {
      await connection.query('SELECT app_private.proteger_reserva_pago_v1($1::uuid,$2::uuid)', [id, group]);
      const attempt = crypto.randomUUID();
      await createPixelPaySaleAttemptRecord(connection, { idIntent: id, qaTestOrigin, paymentAttemptId: attempt, requestId: 'qa-single-claim',
        cardExpireFormatValid: true, cardExpireFuture: true, billingAddressLength: 18 });
      return attempt;
    };
    const claim = async (connection = client, { group = GROUP, id = INTENT, qaTestOrigin = null, crash = false, rollback = false } = {}) => {
      await connection.query('BEGIN');
      let attempt;
      try {
        attempt = await start(connection, group, id, qaTestOrigin);
        if (rollback) throw new Error('Injected before COMMIT');
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; }
      if (!crash) simulatedPosts++;
      return attempt;
    };
    const state = async () => (await client.query(`SELECT i.estado_intent_codigo,
      count(a.*)::int attempts FROM public.payment_intents i LEFT JOIN app_private.pixelpay_sale_attempts a USING(id_intent)
      WHERE i.id_intent=$1 GROUP BY i.estado_intent_codigo`, [INTENT])).rows[0];

    await t.test('dos conexiones esperan el lock real y solo un START llega al proveedor doble tras COMMIT', async () => {
      await reset();
      const first = new pg.Client(options), second = new pg.Client(options);
      let pending;
      try {
        await Promise.all([first.connect(), second.connect()]);
        const pid = (await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await first.query('BEGIN');
        await start(first);
        pending = claim(second).then(value => ({ value }), error => ({ error }));
        const deadline = Date.now() + 5000;
        let waiting = false;
        do {
          waiting = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='advisory') waiting`, [pid])).rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
        } while (!waiting && Date.now() < deadline);
        assert.equal(waiting, true);
        assert.deepEqual(await state(), { estado_intent_codigo: 'link_generado', attempts: 0 });
        assert.equal(simulatedPosts, 0);
        await first.query('COMMIT');
        assert.deepEqual(await state(), { estado_intent_codigo: 'pendiente_confirmacion', attempts: 1 });
        simulatedPosts++;
        assert.match((await pending).error?.message || '', /MF_PAYMENT_INTENT_STATE_INVALID/);
        assert.equal(simulatedPosts, 1);
        assert.deepEqual(await state(), { estado_intent_codigo: 'pendiente_confirmacion', attempts: 1 });
      } finally {
        await first.query('ROLLBACK').catch(() => {});
        if (pending) await pending;
        await Promise.all([first.end(), second.end()]);
      }
    });
    await t.test('rollback anterior a COMMIT no deja START ni envio y permite un claim nuevo', async () => {
      await reset();
      await assert.rejects(claim(client, { rollback: true }), /Injected before COMMIT/);
      assert.equal(simulatedPosts, 0);
      assert.deepEqual(await state(), { estado_intent_codigo: 'link_generado', attempts: 0 });
      await claim();
      assert.equal(simulatedPosts, 1);
      assert.equal((await state()).attempts, 1);
    });
    await t.test('interrupcion despues de COMMIT mantiene START sin autorizacion para repetir', async () => {
      await reset();
      await claim(client, { crash: true });
      await assert.rejects(claim(), /MF_PAYMENT_INTENT_STATE_INVALID/);
      assert.equal(simulatedPosts, 0);
      assert.deepEqual(await state(), { estado_intent_codigo: 'pendiente_confirmacion', attempts: 1 });
    });
    for (const [name, dto, intentState] of [
      ['202 incierto', { outcome: 'uncertain', statusCode: 202, sdkResponseClass: 'PayloadResponse' }, 'pendiente_confirmacion'],
      ['timeout', { outcome: 'uncertain', errorCode: 'PIXELPAY_TIMEOUT', safeMessageCode: 'SDK_HTTP_TIMEOUT' }, 'pendiente_confirmacion'],
      ['rechazo', { outcome: 'payment_declined', statusCode: 200 }, 'fallido'],
    ]) await t.test(`${name}: FINAL durable, recarga/doble clic no reinician el intent`, async () => {
      await reset();
      const attempt = await claim();
      assert.equal(await finalizePixelPaySaleAttempt(client, { paymentAttemptId: attempt, ...dto }), true);
      if (intentState === 'fallido') await client.query("UPDATE public.payment_intents SET estado_intent_codigo='fallido'");
      for (let replay = 0; replay < 2; replay++) await assert.rejects(claim(), /MF_PAYMENT_INTENT_STATE_INVALID/);
      assert.equal(simulatedPosts, 1);
      assert.deepEqual(await state(), { estado_intent_codigo: intentState, attempts: 1 });
      const row = (await client.query('SELECT outcome,uncertain,finalized_at IS NOT NULL finalized FROM app_private.pixelpay_sale_attempts')).rows[0];
      assert.deepEqual(row, { outcome: dto.outcome, uncertain: dto.outcome === 'uncertain', finalized: true });
    });
    await t.test('hold vencido y grupo ajeno no producen claim ni envio', async () => {
      await reset(true);
      await assert.rejects(claim(), /MF_PAYMENT_HOLD_EXPIRED/);
      assert.equal((await state()).attempts, 0);
      await reset();
      await assert.rejects(claim(client, { group: OTHER_GROUP }), /MF_PAYMENT_INTENT_NOT_FOUND/);
      assert.equal((await state()).attempts, 0);
      assert.equal(simulatedPosts, 0);
    });
    await t.test('QA thirty-minute holds are preserved by the existing claim RPC',async()=>{
      await reset();await client.query("UPDATE public.citas_holds SET expires_at=date_trunc('second',clock_timestamp())+interval '30 minutes'");
      const before=(await client.query('SELECT expires_at FROM public.citas_holds')).rows[0].expires_at;
      await claim();const after=(await client.query('SELECT expires_at FROM public.citas_holds')).rows[0].expires_at;
      assert.equal(after.getTime(),before.getTime());
    });
    await t.test('QA markers survive disabled session and a new PG connection; independent intents never release either claim',async()=>{
      await reset();
      const other=crypto.randomUUID(),otherCita=crypto.randomUUID(),otherHold=crypto.randomUUID();
      await client.query(`INSERT INTO payment_intents VALUES($1,$2,'cita','link_generado',clock_timestamp()+interval '30 minutes',now());`,[other,OTHER_GROUP]);
      await client.query(`INSERT INTO citas VALUES($1,$2,NULL,'pendiente_pago')`,[otherCita,OTHER_GROUP]);
      await client.query(`INSERT INTO citas_holds VALUES($1,$2,'activo',clock_timestamp()+interval '30 minutes',now())`,[otherHold,otherCita]);
      await assert.rejects(claim(client,{qaTestOrigin:'sandbox_session',rollback:true}));
      assert.equal(await loadPixelPayQaOrigin(client,INTENT),null);
      const first=await claim(client,{qaTestOrigin:'sandbox_session'});
      await finalizePixelPaySaleAttempt(client,{paymentAttemptId:first,outcome:'uncertain',statusCode:202,safeMessageCode:'SDK_NETWORK_ERROR'});
      await claim(client,{id:other,group:OTHER_GROUP,qaTestOrigin:'sandbox_session'});
      assert.equal(resolveQaPixelPay3dsDiagnostic({}).enabled,false);
      const restarted=new pg.Client(options);await restarted.connect();
      try{
        for(const id of [INTENT,other])assert.equal(await loadPixelPayQaOrigin(restarted,id),'sandbox_session');
        const states=(await restarted.query('SELECT id_intent,outcome,qa_test_origin FROM app_private.pixelpay_sale_attempts')).rows;
        assert.equal(states.find(r=>r.id_intent===INTENT).outcome,'uncertain');assert.equal(states.find(r=>r.id_intent===other).outcome,null);
        await assert.rejects(claim(restarted,{qaTestOrigin:'sandbox_session'}),/MF_PAYMENT_INTENT_STATE_INVALID/);
        for(const sql of ['UPDATE app_private.pixelpay_sale_attempts SET qa_test_origin=NULL',
          "UPDATE app_private.pixelpay_sale_attempts SET qa_test_origin='3ds_diagnostic'",'DELETE FROM app_private.pixelpay_sale_attempts']){
          await assert.rejects(restarted.query(sql),/PIXELPAY_QA_ORIGIN_IMMUTABLE/);
        }
        assert.equal((await state()).attempts,1);
      }finally{await restarted.end();}
    });
    await t.test('ordinary attempts remain unmarked and cannot be relabelled later',async()=>{
      await reset();await claim();assert.equal(await loadPixelPayQaOrigin(client,INTENT),null);
      await assert.rejects(client.query("UPDATE app_private.pixelpay_sale_attempts SET qa_test_origin='sandbox_session'"),/PIXELPAY_QA_ORIGIN_IMMUTABLE/);
    });
    assert.equal(externalConnections, 0);
  } finally {
    try { if (isolated) await isolated.stop(); }
    finally { net.Socket.prototype.connect = connect; }
  }
});
