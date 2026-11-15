import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {startPostgres17} from './helpers/postgres17.mjs';
import {SongbirdBridge} from '../src/services/payments/songbirdBridge.js';
import {SongbirdRepository} from '../src/services/payments/songbirdRepository.js';

const ID='11111111-1111-4111-8111-111111111111',ATTEMPT='22222222-2222-4222-8222-222222222222';
const OWNER='33333333-3333-4333-8333-333333333333',GROUP='44444444-4444-4444-8444-444444444444';
const JWT='synthetic.initial.signature';
test('Songbird durable bridge PostgreSQL17: real locks/rollback, no provider or financial writes',{
  skip:process.env.RUN_PIXELPAY_SONGBIRD_PG!=='true',timeout:90000,
},async t=>{
  const original=net.Socket.prototype.connect;let externalAttempts=0;
  net.Socket.prototype.connect=function(...args){
    const options=Array.isArray(args[0])?args[0][0]:net._normalizeArgs(args)[0];
    if(!['127.0.0.1','::1'].includes(options.host)){externalAttempts++;throw new Error('NONLOCAL_NETWORK_BLOCKED');}
    return original.apply(this,args);
  };
  let cluster,pool;
  try{
    cluster=await startPostgres17();pool=new pg.Pool({...cluster.connectionOptions,options:'-c statement_timeout=5000',query_timeout:6000,max:6});
    await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;
      CREATE TABLE public.payment_intents(id_intent uuid PRIMARY KEY,created_by_usuario_id uuid,id_grupo_cita uuid,
        orden_compra text,monto_hnl numeric,moneda_codigo text,estado_intent_codigo text);
      CREATE TABLE app_private.pixelpay_sale_attempts(payment_attempt_id uuid PRIMARY KEY,id_intent uuid REFERENCES public.payment_intents);
      CREATE TABLE public.citas(id_cita uuid PRIMARY KEY,id_grupo_cita uuid,estado_cita_codigo text,deleted_at timestamptz);
      CREATE TABLE public.citas_holds(id_hold uuid PRIMARY KEY,id_cita uuid,estado_hold_codigo text,expires_at timestamptz);
      CREATE TABLE public.payments(id int);CREATE TABLE public.payment_events(id int);`);
    await pool.query(await readFile(new URL('../db/migrations/pixel/20261115190000_pixelpay_songbird_handoff.sql',import.meta.url),'utf8'));
    const order='MF-PIXELPAY-'+ID.replaceAll('-','').toUpperCase();
    await pool.query(`INSERT INTO payment_intents VALUES($1,$2,$3,$4,1,'HNL','pendiente_confirmacion')`,[ID,OWNER,GROUP,order]);
    await pool.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES($1,$2)',[ATTEMPT,ID]);
    await pool.query(`INSERT INTO citas VALUES($1,$2,'pendiente_pago',NULL),($3,$2,'pendiente_pago',NULL)`,[ID,GROUP,ATTEMPT]);
    await pool.query(`INSERT INTO citas_holds VALUES($1,$1,'activo',clock_timestamp()+interval '10 minutes'),
      ($2,$2,'activo',clock_timestamp()+interval '10 minutes')`,[ID,ATTEMPT]);
    const repo=new SongbirdRepository(pool);const config={enabled:true,key:Buffer.alloc(32,8)};
    const ctx={idIntent:ID,paymentAttemptId:ATTEMPT,ownerId:OWNER,groupId:GROUP,orderId:order,amount:1,currency:'HNL',expiresAt:new Date(Date.now()+600000).toISOString()};
    let lookups=0;
    const contract={browserPayloadAccredited:true,inspect:v=>v===JWT,
      async lookup(){lookups++;throw new Error('synthetic transport loss');}};
    const bridge=new SongbirdBridge({repository:repo,config,contract});
    const reserve=async()=>{const c=await pool.connect();try{await c.query('BEGIN');await bridge.reserve(c,ctx);await c.query('COMMIT');}finally{c.release();}};
    const reset=async()=>{await pool.query('DELETE FROM app_private.pixelpay_songbird_handoffs');await reserve();await bridge.capture(ID,OWNER,JWT);};
    await t.test('migration private table; reservation and ciphertext bind to exact attempt and owner',async()=>{
      await reserve();assert.equal((await bridge.status(ID,OWNER)).state,'awaiting_response');
      await bridge.capture(ID,OWNER,JWT);
      const row=(await pool.query('SELECT * FROM app_private.pixelpay_songbird_handoffs')).rows[0];
      assert.equal(row.payload_box.includes(JWT),false);assert.equal(row.state,'handoff_ready');
      assert.equal((await bridge.status(ID,GROUP)).state,'unavailable');
      assert.equal((await pool.query(`SELECT has_table_privilege('authenticated','app_private.pixelpay_songbird_handoffs','SELECT') AS allowed`)).rows[0].allowed,false);
    });
    await t.test('two clients wait on real locks; one lease and one payload delivery',async()=>{
      const blocker=await pool.connect();await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[`pixelpay-sale:${ID}`]);
      const pending=[bridge.claim(ID,OWNER),bridge.claim(ID,OWNER)].map(p=>p.then(value=>({ok:true,value}),error=>({ok:false,code:error.code})));
      let waiters=0;
      try{
        for(let i=0;i<200;i++){
          waiters=Number((await pool.query("SELECT count(DISTINCT pid) n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n);
          if(waiters===2)break;await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiters,2);
      }finally{await blocker.query('COMMIT');blocker.release();}
      const results=await Promise.all(pending);
      assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'SONGBIRD_ALREADY_LEASED');
      assert.equal(results.find(r=>r.ok).value.handoff.jwt,JWT);
      assert.equal((await pool.query('SELECT payload_box FROM app_private.pixelpay_songbird_handoffs')).rows[0].payload_box,null);
    });
    await t.test('restart and rollback do not reissue payload or release financial intent',async()=>{
      const fresh=new SongbirdBridge({repository:new SongbirdRepository(pool),config,contract});
      assert.equal((await fresh.status(ID,OWNER)).state,'browser_leased');
      await assert.rejects(fresh.claim(ID,OWNER),e=>e.code==='SONGBIRD_ALREADY_LEASED');
      await assert.rejects(repo.mutate(ID,OWNER,row=>{row.state='interrupted';throw new Error('rollback');}));
      assert.equal((await fresh.status(ID,OWNER)).state,'browser_leased');
      assert.equal((await pool.query('SELECT estado_intent_codigo FROM payment_intents')).rows[0].estado_intent_codigo,'pendiente_confirmacion');
    });
    await t.test('lost authentication response stays interrupted; no replay or financial write',async()=>{
      await reset();const lease=(await bridge.claim(ID,OWNER)).handoff.lease_id;
      assert.equal((await bridge.step(ID,OWNER,'setup',lease,'synthetic-reference')).state,'interrupted');
      await assert.rejects(bridge.step(ID,OWNER,'setup',lease,'synthetic-reference'));
      assert.equal(lookups,1);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM payments')).rows[0].n),0);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM payment_events')).rows[0].n),0);
    });
    await t.test('one expired/missing hold and contradictory canonical context block authentication',async()=>{
      await reset();await pool.query('DELETE FROM citas_holds WHERE id_hold=$1',[ATTEMPT]);
      assert.equal((await bridge.claim(ID,OWNER)).state,'expired');
      assert.equal((await pool.query('SELECT payload_box FROM app_private.pixelpay_songbird_handoffs')).rows[0].payload_box,null);
      await pool.query('UPDATE payment_intents SET monto_hnl=2');
      await assert.rejects(bridge.claim(ID,OWNER),e=>e.code==='SONGBIRD_NOT_FOUND');
    });
    await t.test('unaccredited production contract persists metadata only',async()=>{
      await pool.query('UPDATE payment_intents SET monto_hnl=1');
      await pool.query(`INSERT INTO citas_holds VALUES($1,$1,'activo',clock_timestamp()+interval '10 minutes')`,[ATTEMPT]);
      await pool.query('DELETE FROM app_private.pixelpay_songbird_handoffs');await reserve();
      const guarded=new SongbirdBridge({repository:repo,config});
      assert.equal((await guarded.capture(ID,OWNER,JWT)).state,'contract_blocked');
      await assert.rejects(guarded.claim(ID,OWNER),e=>e.code==='PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
      assert.equal((await pool.query('SELECT payload_box FROM app_private.pixelpay_songbird_handoffs')).rows[0].payload_box,null);
    });
  }finally{
    if(pool)await pool.end();if(cluster)await cluster.stop();net.Socket.prototype.connect=original;
    assert.equal(externalAttempts,0);
  }
});
