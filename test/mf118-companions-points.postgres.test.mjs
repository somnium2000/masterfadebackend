import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {grantEngagementPointsForConfirmedGroup} from '../src/services/pointsService.js';
import {createCoverageTracker,consumeCoverageForServices} from '../src/services/membershipService.js';
const BIN=process.env.MASTERFADE_PHASE02_PG_BIN;
test('MF118: cobertura individual y MasterPuntos en PostgreSQL aislado',{skip:!BIN,timeout:90000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mf118-pg-')),data=path.join(dir,'data');let pool,started=false;
 const binary=(name,args)=>{const r=spawnSync(path.join(BIN,name+(process.platform==='win32'?'.exe':'')),args,{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);};
 t.after(async()=>{if(pool)await pool.end();if(started)binary('pg_ctl',['-D',data,'-m','fast','-w','stop']);assert.equal(path.dirname(dir),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('mf118-pg-'));await rm(dir,{recursive:true,force:true});});
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 binary('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C','--no-sync']);binary('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;
 pool=new pg.Pool({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
 await pool.query(`CREATE TABLE estados_cita(estado_cita_codigo text);INSERT INTO estados_cita VALUES('confirmada'),('completada');
 CREATE TABLE clientes(id_cliente uuid PRIMARY KEY,id_usuario uuid,id_sucursal_origen uuid,deleted_at timestamptz);
 CREATE TABLE citas_grupos(id_grupo_cita uuid,id_cliente_titular uuid);
 CREATE TABLE citas(id_cita uuid PRIMARY KEY,id_cliente uuid,id_sucursal uuid,id_grupo_cita uuid,inicio_at timestamptz DEFAULT now(),estado_cita_codigo text,orden_integrante int,es_canje_recompensa boolean DEFAULT false,deleted_at timestamptz,creada_por_usuario_id uuid,created_at timestamptz DEFAULT now(),total_pagar_hnl numeric DEFAULT 0);
 CREATE TABLE subscription_consumptions(id_cita uuid);
 CREATE TABLE points_rules(id_sucursal uuid,puntos_por_cita int,puntos_para_premio int,activo boolean,created_at timestamptz,updated_at timestamptz);
 INSERT INTO points_rules VALUES(NULL,1,10,true,now(),now());
 CREATE TABLE points_cycles(id_cycle uuid DEFAULT gen_random_uuid(),id_cliente uuid UNIQUE,estado_ciclo_codigo text DEFAULT 'activo',vence_at timestamptz DEFAULT now()+interval '12 months');
 CREATE TABLE points_transactions(id_points_tx uuid DEFAULT gen_random_uuid(),id_cliente uuid,id_cita uuid,id_cycle uuid,id_sucursal_origen uuid,tipo_puntos_codigo text,origen_punto_codigo text,puntos int,vence_at timestamptz,motivo text,creado_por_usuario_id uuid,created_at timestamptz,updated_at timestamptz);
 CREATE UNIQUE INDEX uq_points_tx_acumular_por_cita ON points_transactions(id_cita,tipo_puntos_codigo) WHERE id_cita IS NOT NULL AND tipo_puntos_codigo='acumular';
 CREATE FUNCTION fn_points_materialize_expired_cycles(uuid) RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
 CREATE FUNCTION fn_points_get_effective_rule(uuid) RETURNS TABLE(puntos_para_premio int) LANGUAGE sql AS $$ SELECT 10 $$;
 CREATE FUNCTION fn_points_get_or_create_active_cycle(uuid,timestamptz) RETURNS SETOF points_cycles LANGUAGE sql AS $$ INSERT INTO points_cycles(id_cliente) VALUES($1) ON CONFLICT(id_cliente) DO UPDATE SET id_cliente=$1 RETURNING * $$;
 CREATE FUNCTION fn_points_get_or_create_active_cycle(uuid,int,timestamptz) RETURNS SETOF points_cycles LANGUAGE sql AS $$ SELECT * FROM fn_points_get_or_create_active_cycle($1,$3) $$;
 `);
 await pool.query(await readFile(new URL('./sql/mf118-points-fixture.sql',import.meta.url),'utf8'));
 await pool.query(`CREATE TRIGGER guard_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,id_cita,origen_punto_codigo ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
 CREATE TRIGGER puntos_cita AFTER UPDATE ON citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();`);
 const client=randomUUID(),companion=randomUUID(),branch=randomUUID(),group=randomUUID();
 await pool.query('INSERT INTO clientes VALUES($1,gen_random_uuid(),$3,NULL),($2,gen_random_uuid(),$3,NULL)',[client,companion,branch]);await pool.query('INSERT INTO citas_grupos VALUES($1,$2)',[group,client]);
 const insert=async(state,order=1,owner=client,reward=false)=>{const id=randomUUID();await pool.query('INSERT INTO citas(id_cita,id_cliente,id_sucursal,id_grupo_cita,estado_cita_codigo,orden_integrante,es_canje_recompensa) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,branch,group,state,order,reward]);return id;};
 const sum=async id=>Number((await pool.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1',[id])).rows[0]?.balance_puntos||0);
 await t.test('confirmación no acredita; completada con membresía sí; reintentos no duplican',async()=>{
  const id=await insert('confirmada');await pool.query('INSERT INTO subscription_consumptions VALUES($1)',[id]);
  assert.deepEqual(await grantEngagementPointsForConfirmedGroup(pool,{idGrupoCita:group}),{titular:0,acompanantes:0});assert.equal(await sum(client),0);
  await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1",[id]);assert.equal(await sum(client),1);
  await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1",[id]);await grantEngagementPointsForConfirmedGroup(pool,{idGrupoCita:group});assert.equal(await sum(client),1);
 });
 await t.test('hold/pendientes/cancelación/expiración no generan puntos; recompensa titular excluida',async()=>{
  for(const state of ['en_espera','pendiente_pago','cancelada','expirada','no_show','anulada'])await insert(state);
  const reward=await insert('confirmada',1,client,true);await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1",[reward]);assert.equal(await sum(client),1);
 });
 await t.test('acompañante registrado recibe punto propio; sin Cliente vinculado no se acredita al titular',async()=>{
  const own=await insert('confirmada',2,companion),guest=await insert('confirmada',3,null);
  await grantEngagementPointsForConfirmedGroup(pool,{idGrupoCita:group});assert.equal(await sum(client),1);assert.equal(await sum(companion),0);
  await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=ANY($1::uuid[])",[[own,guest]]);assert.equal(await sum(companion),1);assert.equal(await sum(client),1);
 });
 await t.test('cobertura del titular no se transfiere; totales para uno y varios servicios',async()=>{
  const service=randomUUID(),extra=randomUUID();await pool.query('CREATE TABLE fixture_services(id_servicio uuid,nombre_servicio text,precio_hnl numeric)');await pool.query("INSERT INTO fixture_services VALUES($1,'Corte',300),($2,'Barba',150)",[service,extra]);
  const items=(await pool.query('SELECT * FROM fixture_services ORDER BY precio_hnl DESC')).rows;
  for(const count of [1,2]){
   const tracker=createCoverageTracker({active:{id_suscripcion:randomUUID(),estado_suscripcion_codigo:'activa',estado_visible:'activa',id_sucursal_contratada:branch},summary:{servicios:[{id_servicio:service,restante:2,total:2}]}},{appointmentBranchId:branch});
   const titular=consumeCoverageForServices(tracker,[items[0]],{isTitular:true});assert.equal(titular.coveredTotalHnl,300);assert.equal(titular.extraTotalHnl,0);
   const rest=tracker.serviceRemaining.get(service),other=consumeCoverageForServices(tracker,items.slice(0,count),{isTitular:false});assert.equal(other.coveredTotalHnl,0);assert.equal(other.extraTotalHnl,count===1?300:450);assert.equal(tracker.serviceRemaining.get(service),rest);
  }
 });
 await t.test('vista QA excluye ciclos vencidos al leer, sin nuevas transacciones',async()=>{
  const before=Number((await pool.query('SELECT count(*) n FROM points_transactions')).rows[0].n);
  await pool.query("UPDATE points_cycles SET vence_at=now()-interval '1 day' WHERE id_cliente=$1",[client]);
  assert.equal(await sum(client),0);assert.equal(Number((await pool.query('SELECT count(*) n FROM points_transactions')).rows[0].n),before);
 });
});
