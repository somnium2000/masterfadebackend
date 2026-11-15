import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMasterpuntosRelease10Fixture } from './helpers/masterpuntosRelease10Fixture.mjs';
import { addManualPointsAdjustment } from '../src/services/pointsService.js';

test('Release10: cuerpos PROD efectivos, transicion atomica a QA y reversion conservan ledger PostgreSQL17',
  {skip:!process.env.MASTERFADE_TEST_PG_BIN,timeout:240000},async t=>{
    const f=await createMasterpuntosRelease10Fixture();t.after(f.close);
    const allZero = result => {const results=Array.isArray(result)?result:[result];
      const checks=results.flatMap(r=>r.rows).filter(r=>'affected'in r);
      assert.ok(checks.length>0);assert.deepEqual(checks.filter(r=>Number(r.affected)!==0),[]);};
    const assertTarget = async () => {
      const qa=JSON.parse(await f.source('test/fixtures/masterpuntos-release10/qa-catalog.json'));
      for(const fn of qa.functions){const signature=fn.signature.startsWith('app_private.')?fn.signature:'public.'+fn.signature;
        assert.equal((await f.pool.query('SELECT md5(pg_get_functiondef($1::regprocedure)) hash',[signature])).rows[0].hash,fn.hash,signature);}
    };
    await t.test('los nueve cuerpos PROD y sus triggers corresponden al catalogo actual',async()=>{
      for(const fn of f.prod.functions)assert.equal((await f.pool.query('SELECT md5(pg_get_functiondef($1::regprocedure)) hash',[fn.signature])).rows[0].hash,fn.hash,fn.signature);
      allZero(await f.run('00-preflight.sql'));
    });
    for(const [name,mutation,reason] of [
      ['funcion distinta',"ALTER FUNCTION fn_points_estado_final_cita() SET search_path=public",'CATALOG_DRIFT'],
      ['trigger deshabilitado',"ALTER TABLE citas DISABLE TRIGGER tr_points_cita_confirmada",'CATALOG_DRIFT'],
      ['indice unico ausente',"DROP INDEX uq_points_tx_canje_por_cita",'REQUIRED_UNIQUE_INDEXES'],
      ['regla incompatible',"UPDATE points_rules SET expiracion_meses=1",'RULE_REVIEW'],
    ])await t.test('preflight bloquea '+name+' y conserva todo',async()=>{
      const before=await f.snapshot(),c=await f.pool.connect();try{
        await c.query('BEGIN');await c.query(mutation);
        await assert.rejects(c.query(await f.sql('10-apply.sql')),new RegExp(reason));await c.query('ROLLBACK');
      }finally{c.release();}assert.deepEqual(await f.snapshot(),before);allZero(await f.run('00-preflight.sql'));
    });
    await t.test('sin ciclos con saldo historico abierto: bloquea sin DDL ni correccion',async()=>{
      const actor=await f.owner();await f.pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos) VALUES($1,'ajustar',5)",[actor.id]);
      const before=await f.snapshot();
      const c=await f.pool.connect();try{await assert.rejects(c.query(await f.sql('10-apply.sql')),/HISTORICAL_UNCYCLED_REVIEW/);await c.query('ROLLBACK');}finally{c.release();}
      assert.deepEqual(await f.snapshot(),before);
      // AM: Se completa exclusivamente el historial sintetico para probar un bloque cerrado autorizado.
      await f.pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,puntos) VALUES($1,'ajuste_resta',5)",[actor.id]);
      allZero(await f.run('00-preflight.sql'));
    });
    const baseline=await f.snapshot();
    const hashes=(await f.run('00-preflight.sql')).flatMap(r=>r.rows).find(r=>r.ledger_md5);
    await t.test('fallo al final de la transicion revierte ambas fases, sin dejar acreditacion intermedia',async()=>{
      const c=await f.pool.connect();try{
        const failLate=(await f.sql('10-apply.sql')).replace(/COMMIT;\s*$/,'SELECT 1/0; COMMIT;');
        await assert.rejects(c.query(failLate),{code:'22012'});await c.query('ROLLBACK');
      }finally{c.release();}assert.deepEqual(await f.snapshot(),baseline);allZero(await f.run('00-preflight.sql'));
    });
    await t.test('PROD -> fuentes ciclos/pago -> QA exacto, atomico y repetible',async()=>{
      await f.run('10-apply.sql');await assertTarget();allZero(await f.run('20-postflight.sql'));
      assert.deepEqual(await f.snapshot(),baseline);await f.run('10-apply.sql');await assertTarget();
      assert.deepEqual(await f.snapshot(),baseline);
    });
    await t.test('helpers privados conservan privilegios postgres y deniegan roles de API',async()=>{
      const {rows}=await f.pool.query("SELECT p.oid::regprocedure name,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service_role,has_function_privilege('postgres',p.oid,'EXECUTE') postgres FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname LIKE 'points_%_v1'");
      assert.equal(rows.length,4);for(const row of rows){assert.equal(row.anon,false);assert.equal(row.authenticated,false);assert.equal(row.service_role,false);assert.equal(row.postgres,true);}
    });
    await t.test('aborto antes de trafico restaura DDL PROD, cada fila y permiso originales',async()=>{
      const c=await f.pool.connect();try{
        await c.query("SELECT set_config('masterfade.release10_expected_ledger',$1,false),set_config('masterfade.release10_expected_cycles',$2,false)",[hashes.ledger_md5,hashes.cycles_md5]);
        await c.query(await f.sql('31-restore-before-traffic.sql'));
      }finally{c.release();}
      assert.deepEqual(await f.snapshot(),baseline);allZero(await f.run('00-preflight.sql'));await f.run('10-apply.sql');await assertTarget();
    });
    for(const zone of ['UTC','America/Tegucigalpa'])await t.test('ambos overloads equivalen a doce meses y rechazan ancla futura en '+zone,async()=>{
      const actor=await f.owner(),other=await f.owner(),c=await f.pool.connect();try{
        await c.query('BEGIN');await c.query("SELECT set_config('TimeZone',$1,true)",[zone]);
        for(const [signature,id] of [['$1::uuid,now()',actor.id],['$1::uuid,NULL::int,now()',other.id]]){
          const cycle=(await c.query(`SELECT vence_at=primer_acumulado_at+interval '12 months' annual FROM fn_points_get_or_create_active_cycle(${signature})`,[id])).rows[0];assert.equal(cycle.annual,true);
        }
        await assert.rejects(c.query("SELECT * FROM fn_points_get_or_create_active_cycle($1::uuid,12,now()+interval '1 day')",[actor.id]),{code:'22023'});await c.query('ROLLBACK');
      }finally{c.release();}
    });
    await t.test('pago valido, un punto por cita, sucursales y ciclos anuales desde acreditacion',async()=>{
      const actor=await f.owner(),a=await f.appointment(actor),b=await f.appointment(actor,{atBranch:f.otherBranch});
      await Promise.all([f.paid(actor,a),f.paid(actor,b)]);assert.equal(await f.balance(actor),2);
      const {rows}=await f.pool.query("SELECT count(*)::int n,bool_and(vence_at=primer_acumulado_at+interval '12 months') annual FROM points_cycles WHERE id_cliente=$1",[actor.id]);
      assert.equal(rows[0].n,1);assert.equal(rows[0].annual,true);
      assert.equal((await f.pool.query('SELECT count(DISTINCT id_sucursal_origen)::int n FROM points_transactions WHERE id_cliente=$1',[actor.id])).rows[0].n,2);
      await Promise.all([f.pool.query('SELECT app_private.points_award_paid_appointment_v1($1)',[a]),f.pool.query('SELECT app_private.points_award_paid_appointment_v1($1)',[a])]);
      assert.equal(await f.balance(actor),2);
      const before=await f.snapshot();await f.pool.query("UPDATE citas SET estado_cita_codigo='no_show' WHERE id_cita=$1",[a]);assert.deepEqual(await f.snapshot(),before);
    });
    for(const invalid of ['fallido','tardio','monto','moneda','mock'])await t.test('evidencia invalida '+invalid+' no crea ciclos',async()=>{
      const actor=await f.owner(),a=await f.appointment(actor);
      await f.paid(actor,a,{state:invalid==='fallido'?'fallido':'capturado',late:invalid==='tardio',amount:invalid==='monto'?299:300,currency:invalid==='moneda'?'USD':'HNL',reference:invalid==='mock'?'tx_mock_synthetic':randomUUID()});
      assert.equal(await f.balance(actor),0);assert.equal((await f.pool.query('SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1',[actor.id])).rows[0].n,0);
    });
    await t.test('ajustes conservan permisos de resta, idempotencia y debitos en el ciclo',async()=>{
      const actor=await f.owner(),key=randomUUID();
      const input={idCliente:actor.id,accion:'sumar',puntos:9,motivo:'Ajuste sintetico',usuarioAdmin:{id_usuario:actor.user},allowGlobalAssignment:true,idempotencyKey:key};
      const results=await Promise.all([addManualPointsAdjustment({db:f.pool},input),addManualPointsAdjustment({db:f.pool},input)]);
      assert.equal(results[0].id_points_tx,results[1].id_points_tx);assert.equal(await f.balance(actor),9);
      await assert.rejects(addManualPointsAdjustment({db:f.pool},{...input,accion:'restar',puntos:1,idempotencyKey:randomUUID(),claims:{roles:['admin'],branch_ids:[f.otherBranch]}}),{statusCode:403});
      await addManualPointsAdjustment({db:f.pool},{...input,accion:'restar',puntos:4,idempotencyKey:randomUUID(),claims:{roles:['super_admin']}});
      assert.equal(await f.balance(actor),5);
      assert.equal((await f.pool.query('SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND id_cycle IS NULL',[actor.id])).rows[0].n,0);
    });
    await t.test('vence solo el remanente, lectura no escribe, concurrencia expira una vez y abre otro ciclo',async()=>{
      const actor=await f.owner();
      const cycle=(await f.pool.query("INSERT INTO points_cycles(id_cliente,primer_acumulado_at,vence_at) VALUES($1,now()-interval '13 months',now()-interval '13 months'+interval '12 months') RETURNING id_cycle",[actor.id])).rows[0].id_cycle;
      await f.pool.query("INSERT INTO points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,created_at,updated_at) VALUES($1,$2,'ajustar',9,now()-interval '12 months',now()-interval '12 months'),($1,$2,'ajuste_resta',4,now()-interval '11 months',now()-interval '11 months')",[actor.id,cycle]);
      const before=await f.snapshot();assert.equal(await f.balance(actor),0);assert.deepEqual(await f.snapshot(),before);
      await Promise.all([f.pool.query('SELECT fn_points_materialize_expired_cycles($1)',[actor.id]),f.pool.query('SELECT fn_points_materialize_expired_cycles($1)',[actor.id])]);
      const expirations=(await f.pool.query("SELECT puntos FROM points_transactions WHERE id_cycle=$1 AND tipo_puntos_codigo='vencimiento'",[cycle])).rows;
      assert.deepEqual(expirations,[{puntos:-5}]);assert.equal(await f.balance(actor),0);
      const a=await f.appointment(actor);await f.paid(actor,a);assert.equal(await f.balance(actor),1);
      assert.equal((await f.pool.query("SELECT count(*)::int n FROM points_cycles WHERE id_cliente=$1 AND estado_ciclo_codigo='activo'",[actor.id])).rows[0].n,1);
    });
    await t.test('restauracion antigua bloqueada tras nuevos movimientos',async()=>{
      const c=await f.pool.connect();try{
        await c.query("SELECT set_config('masterfade.release10_expected_ledger',$1,false),set_config('masterfade.release10_expected_cycles',$2,false)",[hashes.ledger_md5,hashes.cycles_md5]);
        const before=await f.snapshot();await assert.rejects(c.query(await f.sql('31-restore-before-traffic.sql')),/RESTORE_REQUIRES_UNCHANGED_BASELINE/);await c.query('ROLLBACK');assert.deepEqual(await f.snapshot(),before);
      }finally{c.release();}
    });
    await t.test('contencion tras trafico conserva el ledger y suspende acreditacion',async()=>{
      const before=await f.snapshot();await f.run('30-rollback-containment.sql');await f.run('30-rollback-containment.sql');assert.deepEqual(await f.snapshot(),before);
      const actor=await f.owner(),a=await f.appointment(actor);await f.paid(actor,a);assert.equal(await f.balance(actor),0);
      assert.equal((await f.pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND tgenabled='D'")).rows[0].n,4);
    });
  });
