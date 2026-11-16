import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSecurity02CurrentFixture,decorateSecurity02,securitySource as read } from './helpers/security02CurrentFixture.mjs';
import { createMasterpuntosRelease10Fixture } from './helpers/security02Release10Fixture.mjs';

const dir='db/manual/security02-release/';
const apply=(await read(dir+'10-apply.sql')).replaceAll('\r\n','\n'), rollback=await read(dir+'30-rollback.sql');
const preflight=await read(dir+'00-preflight.sql'),postflight=await read(dir+'20-postflight.sql');
const source=(await read('db/manual/20261113235412_seguridad_supabase_02_routine_hardening.sql')).replaceAll('\r\n','\n');
const run=Boolean(process.env.MASTERFADE_TEST_PG_BIN);
const rows=r=>(Array.isArray(r)?r:[r]).flatMap(r=>r.rows);
const state=(r,s)=>assert.ok(rows(r).some(r=>r.state===s&&Number(r.mismatches)===0&&r.trusted),JSON.stringify(rows(r)));
const dataSnapshot=async c=>(await c.query(`SELECT (SELECT jsonb_agg(to_jsonb(t)) FROM points_transactions t) ledger,(SELECT jsonb_agg(to_jsonb(t)) FROM points_cycles t) cycles`)).rows;
const functions=async c=>(await c.query(`SELECT p.oid::regprocedure::text signature,md5(p.prosrc) body,proowner,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY signature`)).rows;
async function rejects(c,sql,pattern){try{await assert.rejects(c.query(sql),pattern);}finally{await c.query('ROLLBACK');}}

test('SEGURIDAD02 release: fuente aprobada intacta y candidato #123 fijado',async()=>{
  const manifest=JSON.parse(await read(dir+'manifest.json'));
  assert.equal(createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex'),manifest.source_sha256);
  assert.equal(manifest.source_sha256,'200fad91768a66ac1e99b166cbe3683bb88e3ea6100bb7b5c5c29f215e3cd49f');
  assert.equal(manifest.candidate123,'57ca040ab6641896558fd939e282406acfcd6ff3');
  for(const [file,hash] of Object.entries({'10-apply.sql':'75cd7800fe5ea156f0018bca97439ad36093735d47660e86279a06e93172b905','20-postflight.sql':'78e212eac489c0a3bc4ff7ae772bdf1ec52e1ff9efc60f18fb382206c7155143','paid.sql':'bcfbaf4ff3c74b1b298fc2f378c2990c4a18fcc234e1657924ca9604071194bc'})) {
    assert.equal(createHash('sha256').update((await read('test/fixtures/security02-release/release10/'+file)).replaceAll('\r\n','\n')).digest('hex'),hash,file);
  }
  assert.ok(apply.includes(source.replace(/COMMIT;\s*$/,'').split('DO $preflight$')[1].split('-- AM | Return reviewable')[0]));
});

for(const env of ['prod','qa'])test(`SEGURIDAD02 catalogo real ${env}: guardas, preservacion y rollback`,{skip:!run,timeout:180000},async t=>{
  const f=await createSecurity02CurrentFixture(env);t.after(f.stop);const c=f.client;
  const initial=await functions(c);
  if(env==='qa'){
    state(await c.query(preflight),'RELEASE10_HARDENED');
    // AM: La replica QA certifica metadatos efectivos; no recrea el respaldo remoto.
    await c.query(source);await c.query(source);state(await c.query(postflight),'RELEASE10_HARDENED');
    assert.deepEqual(await functions(c),initial);await c.query(rollback);assert.deepEqual(await functions(c),initial);return;
  }
  state(await c.query(preflight),'PROD_CURRENT');
  await c.query(`INSERT INTO points_transactions(id_points_tx,id_cliente,tipo_puntos_codigo,puntos) VALUES(gen_random_uuid(),gen_random_uuid(),'ajustar',60),(gen_random_uuid(),gen_random_uuid(),'ajuste_resta',-4)`);
  const ledger=await dataSnapshot(c);
  for(const mutation of [
    'ALTER FUNCTION public.fn_set_updated_at() SET search_path=public',
    'GRANT EXECUTE ON FUNCTION public.fn_has_role(uuid,text) TO anon',
    'ALTER TABLE public.citas DISABLE TRIGGER tr_points_cita_confirmada',
    'DROP POLICY p_points_select_self ON public.points_transactions',
    "ALTER FUNCTION public.fn_set_updated_at() OWNER TO service_role",
  ])await t.test('bloqueo atomico: '+mutation,async()=>{
    await c.query('BEGIN');await c.query(mutation);await rejects(c,apply,/CATALOG_DRIFT/);
    assert.deepEqual(await dataSnapshot(c),ledger);state(await c.query(preflight),'PROD_CURRENT');
  });
  await c.query(apply);state(await c.query(postflight),'PROD_HARDENED');
  const hardened=await functions(c);assert.deepEqual(hardened.map(({proconfig:_,...r})=>r),initial.map(({proconfig:_,...r})=>r));
  assert.deepEqual(await dataSnapshot(c),ledger);await c.query(apply);state(await c.query(postflight),'PROD_HARDENED');
  await c.query(rollback);state(await c.query(await read(dir+'40-rollback-postflight.sql')),'PROD_CURRENT');
  assert.deepEqual(await functions(c),initial);assert.deepEqual(await dataSnapshot(c),ledger);
  await c.query(rollback);await c.query(apply);await c.query("ALTER FUNCTION public.fn_set_updated_at() SET statement_timeout='1s'");
  await rejects(c,rollback,/definition\/config drift/);assert.deepEqual(await dataSnapshot(c),ledger);
});

test('SEGURIDAD02 + #123: ordenes reales, hashes y respaldo sin rebaselinar',{skip:!run,timeout:180000},async t=>{
  const f=await createMasterpuntosRelease10Fixture();const c=await f.pool.connect();t.after(async()=>{c.release();await f.close();});
  // AM: Se prueban los SQL congelados de #123 sin modificar su PR ni copiar su backend.
  await decorateSecurity02(c);state(await c.query(preflight),'PROD_CURRENT');
  await c.query(apply);
  const baseline=await f.snapshot();await rejects(c,await f.sql('10-apply.sql'),/CATALOG_DRIFT/);assert.deepEqual(await f.snapshot(),baseline);
  await c.query(rollback);
  state(await c.query(preflight),'PROD_CURRENT');
  // AM: Rollback conserva permisos efectivos; #123 compara ademas proacl NULL frente a ACL explicita.
  await rejects(c,await f.sql('10-apply.sql'),/CATALOG_DRIFT/);
  assert.ok(Number((await c.query('SELECT count(*) FROM app_private.security02_routine_backup')).rows[0].count)===41);
  assert.deepEqual(await f.snapshot(),baseline);
});

test('SEGURIDAD02 despues de #123 en ventana nueva: contrato y hashes #123 intactos',{skip:!run,timeout:180000},async t=>{
  const f=await createMasterpuntosRelease10Fixture();const c=await f.pool.connect();t.after(async()=>{c.release();await f.close();});
  await decorateSecurity02(c);await c.query(await f.sql('10-apply.sql'));
  state(await c.query(preflight),'RELEASE10_CURRENT');
  const candidate=JSON.parse(await read('test/fixtures/security02-release/release10/qa-catalog.json'));
  const checkCandidate=async()=>{
    for(const r of candidate.functions){
      const signature=r.signature.startsWith('app_private.')?r.signature:'public.'+r.signature;
      assert.equal((await c.query('SELECT md5(pg_get_functiondef($1::regprocedure)) hash',[signature])).rows[0].hash,r.hash,signature);
    }
  };
  const ledger=await f.snapshot();await checkCandidate();
  await c.query(apply);state(await c.query(postflight),'RELEASE10_HARDENED');await checkCandidate();
  assert.equal(Number(rows(await c.query(await f.sql('20-postflight.sql'))).find(r=>r.code==='TARGET_FUNCTIONS_OR_TRIGGERS').affected),0);
  assert.deepEqual(await f.snapshot(),ledger);
  await c.query(rollback);state(await c.query(preflight),'RELEASE10_CURRENT');await checkCandidate();
  assert.equal(Number(rows(await c.query(await f.sql('20-postflight.sql'))).find(r=>r.code==='TARGET_FUNCTIONS_OR_TRIGGERS').affected),1,'AM: #123 rechaza la representacion explicita de ACL que deja el rollback aprobado');
  assert.deepEqual(await f.snapshot(),ledger);
});
