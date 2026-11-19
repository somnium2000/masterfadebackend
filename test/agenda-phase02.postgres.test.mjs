import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import cookie from '@fastify/cookie';
import auth from '../src/plugins/auth.js';
import pg from 'pg';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/citas.js';
import { evaluateClientAccountDeletion, confirmClientAccountDeletionRequest, runClientAccountDeletionInternal } from '../src/services/accountDeletionService.js';

const BIN=process.env.MASTERFADE_PHASE02_PG_BIN;
const BRANCH=randomUUID(),BARBER=randomUUID(),PERSON=randomUUID(),USER=randomUUID(),CPERSON=randomUUID(),CLIENT=randomUUID(),REQUEST=randomUUID();
const identity={clienteId:CLIENT,personaId:CPERSON,usuarioId:USER};
const fixtureSchema = `
    CREATE TABLE citas(id_cita uuid PRIMARY KEY, id_grupo_cita uuid, id_sucursal uuid, id_empleado_barbero uuid,
      deleted_at timestamptz, estado_cita_codigo text, orden_integrante int, alias_integrante text,
      id_persona_cliente uuid, id_cliente uuid, inicio_at timestamptz, fin_at timestamptz,
      atencion_iniciada_at timestamptz, atencion_finalizada_at timestamptz,
      retraso_inicio_min int, duracion_total_min int, buffer_total_min int, selection_type text,
      id_paquete uuid, total_pagar_hnl numeric, moneda_codigo text, asignada_automaticamente boolean, notas text);
    CREATE TABLE sucursales(id_sucursal uuid,nombre_sucursal text,deleted_at timestamptz,estado boolean);
    CREATE TABLE personas(id_persona uuid,nombres text,apellidos text,telefono_principal text);
    CREATE TABLE empleados(id_empleado uuid,id_persona uuid);
    CREATE TABLE correos(id_correo uuid,id_persona uuid,direccion_correo text,deleted_at timestamptz,es_principal boolean,verificado boolean);
    CREATE TABLE citas_detalles(id_cita_detalle uuid,id_cita uuid,id_servicio uuid);
    CREATE TABLE servicios(id_servicio uuid,nombre_servicio text);
    CREATE TABLE citas_holds(id_cita uuid,estado_hold_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE payment_intents(id_cita uuid,estado_intent_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE citas_reagendaciones(id_cita uuid,id_lote_reagendacion uuid,id_cita_causante uuid,retraso_min int,tipo_reagendacion_codigo text,created_at timestamptz,id_reagendacion uuid);
  `;

test('FASE-02: PostgreSQL aislado, transiciones y bloqueo Cliente', {skip:!BIN}, async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mf-agenda-fase02-'));
  const data=path.join(directory,'data');
  const binary=(name,args)=>{const result=spawnSync(path.join(BIN,name+(process.platform==='win32'?'.exe':'')),args,{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr||result.error?.message);};
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  let started=false,pool,app,source;
  t.after(async()=>{
    if(app)await app.close();
    if(source)source.release();
    if(pool)await pool.end();
    if(started)binary('pg_ctl',['-D',data,'-m','fast','-w','stop']);
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mf-agenda-fase02-'));
    await rm(directory,{recursive:true,force:true});
  });
  binary('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C','--no-sync']);
  binary('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;
  pool=new pg.Pool({host:'127.0.0.1',port,user:'postgres',database:'postgres',max:4});
  await pool.query(fixtureSchema);
  await pool.query(`
    ALTER TABLE citas ADD COLUMN llegada_real_at timestamptz, ADD COLUMN no_show_at timestamptz, ADD COLUMN updated_at timestamptz, ADD COLUMN contacto_email text, ADD COLUMN contacto_nombre text, ADD COLUMN id_cita_integrante uuid;
    ALTER TABLE empleados ADD COLUMN estado boolean, ADD COLUMN deleted_at timestamptz;
    ALTER TABLE citas_reagendaciones ADD COLUMN id_sucursal uuid, ADD COLUMN id_empleado_barbero_anterior uuid, ADD COLUMN id_empleado_barbero_nuevo uuid,
      ADD COLUMN inicio_at_anterior timestamptz, ADD COLUMN fin_at_anterior timestamptz, ADD COLUMN inicio_at_nuevo timestamptz, ADD COLUMN fin_at_nuevo timestamptz,
      ADD COLUMN motivo text, ADD COLUMN id_usuario_accion uuid;
  `);
  await pool.query("INSERT INTO sucursales VALUES ($1,'Fixture',NULL,true)",[BRANCH]);
  await pool.query("INSERT INTO personas VALUES ($1,'Barbero','Fixture',NULL),($2,'Cliente','Fixture',NULL)",[PERSON,CPERSON]);
  await pool.query("INSERT INTO empleados(id_empleado,id_persona,estado) VALUES ($1,$2,true)",[BARBER,PERSON]);
  source=await pool.connect();let queryError=null;
  const profiles=new Map();
  process.env.JWT_SECRET=randomBytes(48).toString('hex');
  const db={query(sql,params){
    if(sql.includes('WITH base_user'))return Promise.resolve({rows:profiles.has(params[0])?[profiles.get(params[0])]:[]});
    if(sql.includes('token_jti_hash = $3'))return Promise.resolve({rows:[{estado:'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:null}]});
    if(sql.includes('UPDATE public.citas_holds')||sql.includes('WITH target_intents')||sql.includes('no_show_at = COALESCE'))return Promise.resolve({rows:[],rowCount:0});
    return pool.query(sql,params).catch(error=>{queryError=error;throw error;});
  },async connect(){
    return {async query(sql,params){
      // AM: No se ejecuta mantenimiento financiero ni caducidad ajena al caso; el flujo y sus transacciones usan SQL real.
      if(sql.includes('UPDATE public.citas_holds')||sql.includes('WITH target_intents')||sql.includes('no_show_at = COALESCE'))return {rows:[],rowCount:0};
      try{return await source.query(sql,params);}catch(error){queryError=error;throw error;}
    },release(){}};
  }};
  app=Fastify();
  app.decorate('db',db);
  await app.register(cookie);
  await app.register(auth);
  await app.register(routes,{prefix:'/v1/admin/citas'});
  const insert=async(state='confirmada',inicio=new Date(Date.now()+60000).toISOString())=>{
    const id=randomUUID();
    await pool.query("INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,inicio_at,fin_at,estado_cita_codigo) VALUES ($1,$2,$3,$4,$5,$5::timestamptz+interval '30 minutes',$6)",[id,BRANCH,BARBER,CPERSON,inicio,state]);return id;
  };
  const action=(id,operation,options={})=>{
    const idUser=randomUUID();
    profiles.set(idUser,{id_usuario:idUser,roles:[options['x-fixture-role']||'admin'],branch_ids:[options['x-fixture-branch']||BRANCH],empleado_id:options['x-fixture-barber']||BARBER});
    const token=jwt.sign({sub:idUser,sid:randomUUID(),jti:randomUUID(),token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});
    return app.inject({method:'POST',url:'/v1/admin/citas/'+id+'/'+operation,headers:{cookie:'mf_session='+token},payload:{}});
  };
  const state=async id=>(await pool.query('SELECT * FROM citas WHERE id_cita=$1',[id])).rows[0];
  await t.test('flujo válido sin cuenta Cliente, estados inválidos y permisos',async()=>{
    const id=await insert();
    for(const [operation,next,role]of [['registrar-llegada','en_salon','admin'],['iniciar-atencion','en_atencion','barbero'],['finalizar-atencion','completada','super_admin']]){
      const response=await action(id,operation,{'x-fixture-role':role});assert.equal(response.statusCode,200,response.body+' '+queryError?.message);assert.equal((await state(id)).estado_cita_codigo,next);
    }
    assert.ok((await state(id)).atencion_finalizada_at);
    assert.equal((await action(id,'iniciar-atencion')).statusCode,409);
    assert.equal((await action(id,'registrar-llegada')).statusCode,409);
    assert.equal((await action(id,'finalizar-atencion')).statusCode,409);
    for(const headers of [{},{cookie:'mf_session=invalid'}]){
      const response=await app.inject({method:'POST',url:'/v1/admin/citas/'+id+'/iniciar-atencion',headers,payload:{}});
      assert.equal(response.statusCode,401);
    }
    for(const headers of [{'x-fixture-role':'cliente'},{'x-fixture-branch':randomUUID()},{'x-fixture-role':'barbero','x-fixture-barber':randomUUID()}]){
      const response=await action(id,'iniciar-atencion',headers);assert.ok([403,404].includes(response.statusCode),response.body);
    }
  });
  await t.test('en_salon antigua puede iniciar; no exige cuenta Cliente',async()=>{
    const id=await insert('en_salon','2026-10-08T14:00:00Z');
    const response=await action(id,'iniciar-atencion');
    assert.equal(response.statusCode,200,response.body+' '+queryError?.code+' '+queryError?.message);
    assert.equal((await state(id)).estado_cita_codigo,'en_atencion');
  });
  await t.test('propaga solo las siguientes del mismo día/barbero; fallo revierte todo',async sub=>{
    sub.mock.timers.enable({apis:['Date'],now:new Date('2030-06-15T18:00:00Z')});
    await pool.query('DELETE FROM citas');
    const start=new Date(Date.now()-15*60000),id=await insert('en_salon',start.toISOString()),next=await insert('confirmada',new Date(start.getTime()+3600000).toISOString());
    const before=(await state(next)).inicio_at.getTime();
    const tomorrow=await insert('confirmada',new Date(start.getTime()+86400000).toISOString());
    const completed=await insert('completada',new Date(start.getTime()+1800000).toISOString());
    const different=await insert('confirmada',new Date(start.getTime()+1800000).toISOString());
    const secondEmployee=randomUUID();
    await pool.query('INSERT INTO empleados(id_empleado,id_persona,estado) VALUES($1,$2,true)',[secondEmployee,PERSON]);
    await pool.query('UPDATE citas SET id_empleado_barbero=$1 WHERE id_cita=$2',[secondEmployee,different]);
    const unchanged=await Promise.all([tomorrow,completed,different].map(state));
    await pool.query('ALTER TABLE citas_reagendaciones ADD CONSTRAINT fixture_failure CHECK(false)');
    const failure=await action(id,'iniciar-atencion');assert.equal(failure.statusCode,500);
    assert.equal(queryError.code,'23514');
    assert.equal((await state(id)).estado_cita_codigo,'en_salon');assert.equal((await state(next)).inicio_at.getTime(),before);
    await pool.query('ALTER TABLE citas_reagendaciones DROP CONSTRAINT fixture_failure');
    const response=await action(id,'iniciar-atencion');assert.equal(response.statusCode,200,response.body+' '+queryError?.message);
    assert.equal((await state(next)).inicio_at.getTime(),before+15*60000);
    assert.equal((await pool.query('SELECT count(*)::int n FROM citas_reagendaciones')).rows[0].n,1);
    for(const original of unchanged)assert.equal((await state(original.id_cita)).inicio_at.getTime(),original.inicio_at.getTime());
  });
  await pool.query(`
    CREATE SCHEMA app_private;
    CREATE TABLE usuarios(id_usuario uuid PRIMARY KEY,estado boolean DEFAULT true,estado_acceso text DEFAULT 'activo',deleted_at timestamptz,password_hash text);
    CREATE TABLE clientes(id_cliente uuid PRIMARY KEY,id_persona uuid,id_usuario uuid,estado boolean,deleted_at timestamptz,anonimizado boolean DEFAULT false);
    CREATE TABLE roles(id_rol uuid PRIMARY KEY,nombre text);
    CREATE TABLE roles_usuarios(id_usuario uuid,id_rol uuid,activo boolean);
    CREATE TABLE app_protected_users(id_usuario uuid,activo boolean);
    CREATE TABLE citas_integrantes(id_cita_integrante uuid,id_grupo_cita uuid,id_cliente uuid,id_persona uuid,id_usuario uuid);
    CREATE TABLE citas_grupos(id_grupo_cita uuid,id_cliente_titular uuid,id_persona_titular uuid,id_usuario_titular uuid);
    ALTER TABLE citas_holds ADD COLUMN id_hold uuid, ADD COLUMN id_usuario uuid;
    ALTER TABLE payment_intents ADD COLUMN id_intent uuid, ADD COLUMN id_grupo_cita uuid, ADD COLUMN id_hold uuid, ADD COLUMN id_membership_order uuid, ADD COLUMN created_by_usuario_id uuid;
    CREATE TABLE membership_purchase_orders(id_order uuid,id_cliente uuid,estado_orden_codigo text);
    CREATE TABLE payments(id_payment uuid,id_intent uuid,estado_pago_codigo text);
    CREATE TABLE vw_points_balance(id_cliente uuid,balance_puntos numeric);
    CREATE TABLE membership_plans(id_plan uuid,nombre_plan text);
    CREATE TABLE subscriptions(id_suscripcion uuid,id_plan uuid,id_cliente uuid,inicio_at timestamptz,fin_at timestamptz,renovacion_auto boolean,cancelada_al_fin boolean,id_sucursal_contratada uuid,estado_suscripcion_codigo text,created_at timestamptz);
    CREATE TABLE points_transactions(id_points_tx uuid,id_cliente uuid);
    CREATE TABLE app_private.solicitudes_eliminacion_cuenta(
      id_solicitud uuid PRIMARY KEY,referencia_publica text,id_cliente uuid,id_persona uuid,id_usuario uuid,
      tipo_sujeto text DEFAULT 'cliente',modo_proceso text DEFAULT 'autonomo',requiere_aprobacion boolean DEFAULT false,
      estado_codigo text,idempotency_key text,solicitado_at timestamptz DEFAULT now(),reautenticado_at timestamptz,
      resumen_impacto jsonb DEFAULT '{}',bloqueos_detectados jsonb,procesando_at timestamptz,
      auth_user_id_pendiente uuid,error_codigo text,error_detalle_tecnico text,request_id text,updated_at timestamptz,
      execution_token_hash text,execution_token_issued_at timestamptz,execution_token_expires_at timestamptz,execution_token_last_used_at timestamptz);
  `);
  await pool.query("INSERT INTO usuarios(id_usuario) VALUES($1)",[USER]);
  await pool.query("INSERT INTO clientes(id_cliente,id_persona,id_usuario,estado) VALUES($1,$2,$3,true)",[CLIENT,CPERSON,USER]);
  const clientRole=randomUUID();
  await pool.query("INSERT INTO roles VALUES($1,'cliente')",[clientRole]);
  await pool.query("INSERT INTO roles_usuarios VALUES($1,$2,true)",[USER,clientRole]);
  await pool.query("INSERT INTO app_private.solicitudes_eliminacion_cuenta(id_solicitud,referencia_publica,id_cliente,id_persona,id_usuario,estado_codigo) VALUES($1,'DEL-FIXTURE',$2,$3,$4,'pendiente_confirmacion')",[REQUEST,CLIENT,CPERSON,USER]);
  const reset=async()=>{
    await pool.query('DELETE FROM citas; DELETE FROM citas_grupos; DELETE FROM citas_integrantes');
    await pool.query("UPDATE app_private.solicitudes_eliminacion_cuenta SET estado_codigo='pendiente_confirmacion',reautenticado_at=NULL,execution_token_hash=NULL WHERE id_solicitud=$1",[REQUEST]);
  };
  const confirm=client=>confirmClientAccountDeletionRequest(client,{...identity,requestId:REQUEST,authenticatedAt:new Date().toISOString(),traceRequestId:'fixture'});
  const transact=async fn=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  await t.test('los cinco estados bloquean preview y confirmación en vínculos directos, integrante y grupo',async()=>{
    for(const link of ['cliente','persona','integrante','grupo'])for(const estado of ['en_espera','pendiente_pago','confirmada','en_salon','en_atencion']){
      await reset();const id=await insert(estado,'2026-10-08T14:00:00Z');
      if(link==='cliente')await pool.query('UPDATE citas SET id_cliente=$1 WHERE id_cita=$2',[CLIENT,id]);
      if(link!=='persona')await pool.query('UPDATE citas SET id_persona_cliente=$1 WHERE id_cita=$2',[PERSON,id]);
      if(link==='integrante'){
        const group=randomUUID(),member=randomUUID();
        await pool.query('UPDATE citas SET id_grupo_cita=$1,id_cita_integrante=$2 WHERE id_cita=$3',[group,member,id]);
        await pool.query('INSERT INTO citas_integrantes VALUES($1,$2,$3,$4,$5)',[member,group,CLIENT,CPERSON,USER]);
      }
      if(link==='grupo'){
        const group=randomUUID();
        await pool.query('UPDATE citas SET id_grupo_cita=$1 WHERE id_cita=$2',[group,id]);
        await pool.query('INSERT INTO citas_grupos VALUES($1,$2,$3,$4)',[group,CLIENT,CPERSON,USER]);
      }
      const preview=await evaluateClientAccountDeletion(pool,identity);
      assert.equal(preview.can_delete,false);assert.equal(preview.blocking_appointments.count,1);
      const result=await transact(confirm);assert.equal(result.ready_for_processing,false);
      assert.equal(result.request.estado_codigo,'bloqueada');
      assert.equal((await state(id)).estado_cita_codigo,estado);
    }
  });
  await t.test('historial completado no bloquea y una cuenta ajena no atribuye citas',async()=>{
    await reset();const id=await insert('completada','2026-10-08T14:00:00Z');
    const preview=await evaluateClientAccountDeletion(pool,identity);
    assert.equal(preview.can_delete,true);assert.equal(preview.retained_history.appointments_count,1);
    await pool.query('UPDATE citas SET id_persona_cliente=$1 WHERE id_cita=$2',[PERSON,id]);
    await pool.query("UPDATE citas SET estado_cita_codigo='en_salon' WHERE id_cita=$1",[id]);
    assert.equal((await evaluateClientAccountDeletion(pool,identity)).retained_history.appointments_count,0);
    assert.equal((await evaluateClientAccountDeletion(pool,identity)).can_delete,true);
  });
  await t.test('replay concurrente debe reevaluar una cita aparecida después de la primera confirmación',async()=>{
    await reset();
    const first=await pool.connect(),second=await pool.connect();
    let secondResult;
    try{
      await first.query('BEGIN');const original=await confirm(first);assert.equal(original.ready_for_processing,true);
      await insert('en_salon');
      await second.query('BEGIN');
      let finished=false;secondResult=confirm(second).then(result=>{finished=true;return result;});
      await new Promise(resolve=>setTimeout(resolve,80));assert.equal(finished,false,'El lock por usuario serializa confirmaciones');
      await first.query('COMMIT');
      const replay=await secondResult;
      await second.query('COMMIT');
      assert.equal(replay.ready_for_processing,false,'No autorizar replay si apareció una cita activa');
      assert.equal(replay.request.estado_codigo,'bloqueada');
      assert.equal(replay.execution,undefined);
    }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
  });
  await t.test('procesamiento reevalúa y bloquea sin desactivar Cliente ni borrar historial',async()=>{
    for(const estado of ['en_espera','pendiente_pago','confirmada','en_salon','en_atencion']){
      await reset();await transact(confirm);
      const id=await insert(estado);
      const result=await runClientAccountDeletionInternal({db:pool},{...identity,deletionRequestId:REQUEST,authenticatedAt:new Date().toISOString(),traceRequestId:'fixture'});
      assert.equal(result.processed,false);assert.equal(result.request_state,'bloqueada');
      assert.equal((await state(id)).estado_cita_codigo,estado);
      assert.equal((await pool.query('SELECT estado FROM clientes WHERE id_cliente=$1',[CLIENT])).rows[0].estado,true);
      assert.equal((await pool.query('SELECT estado FROM usuarios WHERE id_usuario=$1',[USER])).rows[0].estado,true);
    }
  });
  await t.test('procesamiento que espera el lock debe evaluar dependencias confirmadas mientras esperaba',async()=>{
    await reset();await transact(confirm);
    const holder=await pool.connect();
    let entered;const startedLock=new Promise(resolve=>{entered=resolve;});
    const guarded={db:{async connect(){
      const client=await pool.connect();
      return {release:(...args)=>client.release(...args),query(sql,params){
        if(sql.includes('pg_advisory_xact_lock')||sql.includes('pg_advisory_lock'))entered();
        // AM: Si falla la protección, abortar antes de cualquier efecto de eliminación.
        if(sql.includes("SET estado_codigo = 'procesando'"))throw new Error('fixture: procesamiento indebidamente autorizado');
        return client.query(sql,params);
      }};
    }}};
    let processing;
    try{
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('masterfade.account_deletion'),hashtext($1::text))",[USER]);
      processing=runClientAccountDeletionInternal(guarded,{...identity,deletionRequestId:REQUEST,authenticatedAt:new Date().toISOString(),traceRequestId:'fixture'}).then(value=>({value}),error=>({error}));
      await startedLock;
      await holder.query("INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,inicio_at,estado_cita_codigo) VALUES($1,$2,$3,$4,now(),'en_salon')",[randomUUID(),BRANCH,BARBER,CPERSON]);
      await holder.query('COMMIT');
      const result=await processing;
      assert.equal(result.error,undefined,result.error?.message);
      assert.equal(result.value.processed,false);assert.equal(result.value.request_state,'bloqueada');
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  await t.test('invitados sin persona: listado, Buscar reserva, nombres y aislamiento',async subtest=>{
    subtest.mock.timers.enable({apis:['Date'],now:new Date('2030-06-15T16:10:00Z')});
    await pool.query('DELETE FROM citas; ALTER TABLE clientes ADD COLUMN preferencias jsonb; ALTER TABLE personas ADD COLUMN observaciones text');
    const secondBarber=randomUUID(),secondBranch=randomUUID(),group=randomUUID();
    await pool.query("INSERT INTO empleados(id_empleado,id_persona,estado) VALUES($1,$2,true)",[secondBarber,PERSON]);
    await pool.query("INSERT INTO sucursales VALUES($1,'Otra',NULL,true)",[secondBranch]);
    const holder=await insert('confirmada','2030-06-15T14:00:00Z'),guest=await insert('confirmada','2030-06-15T15:00:00Z'),other=await insert('confirmada','2030-06-15T16:00:00Z');
    await pool.query("UPDATE citas SET id_grupo_cita=$1 WHERE id_cita=ANY($2::uuid[])",[group,[holder,guest,other]]);
    await pool.query("UPDATE citas SET id_cliente=$1,contacto_nombre='Contacto titular',alias_integrante='Titular' WHERE id_cita=$2",[CLIENT,holder]);
    await pool.query("UPDATE citas SET id_persona_cliente=NULL,contacto_nombre='Invitado de contacto',alias_integrante='Alias invitado' WHERE id_cita=$1",[guest]);
    await pool.query("UPDATE citas SET id_persona_cliente=NULL,contacto_nombre='   ',alias_integrante='Segundo invitado',id_empleado_barbero=$1 WHERE id_cita=$2",[secondBarber,other]);
    const outside=await insert('confirmada','2030-06-15T17:00:00Z');await pool.query('UPDATE citas SET id_sucursal=$1 WHERE id_cita=$2',[secondBranch,outside]);
    const yesterday=await insert('confirmada','2030-06-15T05:59:59.999Z'),last=await insert('confirmada','2030-06-16T05:59:59.999Z'),tomorrow=await insert('confirmada','2030-06-16T06:00:00Z');
    const read=async(path,role='admin',barber=BARBER)=>{
      const id=randomUUID();profiles.set(id,{id_usuario:id,roles:[role],branch_ids:[BRANCH],empleado_id:barber});
      const token=jwt.sign({sub:id,sid:randomUUID(),jti:randomUUID(),token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});
      return app.inject({url:'/v1/admin/citas'+path,headers:{cookie:'mf_session='+token}});
    };
    const list=role=>read('/operativas?fecha_desde=2030-06-15&fecha_hasta=2030-06-15&zona_horaria=America%2FTegucigalpa&id_sucursal='+BRANCH,role);
    for(const role of ['admin','super_admin']){
      const response=await list(role);assert.equal(response.statusCode,200,response.body+' '+queryError?.message);
      const rows=response.json().data.citas;assert.deepEqual(rows.filter(r=>r.id_grupo_cita===group).map(r=>r.id_cita),[holder,guest,other]);assert.equal(new Set(rows.map(r=>r.id_cita)).size,rows.length);assert.ok(rows.some(r=>r.id_cita===last));assert.ok(!rows.some(r=>r.id_cita===yesterday||r.id_cita===tomorrow));
      assert.equal(rows.find(r=>r.id_cita===holder).nombre_cliente,'Contacto titular');assert.equal(rows.find(r=>r.id_cita===guest).nombre_cliente,'Invitado de contacto');assert.equal(rows.find(r=>r.id_cita===other).nombre_cliente,'Segundo invitado');
    }
    const barberRows=(await list('barbero')).json().data.citas;assert.deepEqual(barberRows.filter(r=>r.id_grupo_cita===group).map(r=>r.id_cita),[holder,guest]);
    const secondRead=await read('/operativas?id_sucursal='+BRANCH,'barbero',secondBarber);assert.deepEqual(secondRead.json().data.citas.map(r=>r.id_cita),[other]);
    const foreign=await read('/operativas?id_sucursal='+secondBranch,'barbero');assert.equal(foreign.statusCode,403,foreign.body);
    let hash=0;for(const char of group.toUpperCase())hash=((hash<<5)-hash+char.charCodeAt(0))|0;const code=Math.abs(hash).toString(36).toUpperCase().padStart(5,'0').slice(-5);
    const lookup=await read('/reservas/buscar?codigo='+code+'&id_sucursal='+BRANCH);assert.equal(lookup.statusCode,200,lookup.body);assert.equal(lookup.json().data.reservas[0].citas.length,3);
    const monthBefore=await insert('confirmada','2030-06-01T05:59:59.999Z'),monthFirst=await insert('confirmada','2030-06-01T06:00:00Z'),monthLast=await insert('confirmada','2030-07-01T05:59:59.999Z'),monthNext=await insert('confirmada','2030-07-01T06:00:00Z');
    const month=await read('/operativas?fecha_desde=2030-06-01&fecha_hasta=2030-06-30&zona_horaria=America%2FTegucigalpa&id_sucursal='+BRANCH,'barbero');assert.equal(month.statusCode,200,month.body);const monthIds=month.json().data.citas.map(r=>r.id_cita);assert.ok(monthIds.includes(monthFirst));assert.ok(monthIds.includes(monthLast));assert.ok(!monthIds.includes(monthBefore));assert.ok(!monthIds.includes(monthNext));
    const denied=await action(guest,'registrar-llegada',{'x-fixture-role':'barbero','x-fixture-barber':secondBarber});assert.equal(denied.statusCode,404,denied.body);
    for(const [op,next]of [['registrar-llegada','en_salon'],['iniciar-atencion','en_atencion'],['finalizar-atencion','completada']]){
      const response=await action(guest,op,{'x-fixture-role':op==='registrar-llegada'?'admin':'barbero'});assert.equal(response.statusCode,200,response.body+' '+queryError?.message);assert.equal((await state(guest)).estado_cita_codigo,next);
    }
    await pool.query("UPDATE citas SET contacto_nombre=' ',alias_integrante='Alias titular' WHERE id_cita=$1",[holder]);
    assert.equal((await list('admin')).json().data.citas.find(r=>r.id_cita===holder).nombre_cliente,'Cliente Fixture');
  });
  await t.test('invitado en propagación: bloqueo seguro, rollback y jornada HN exclusiva',async subtest=>{
    subtest.mock.timers.enable({apis:['Date'],now:new Date('2030-06-15T18:00:00Z')});
    await pool.query('DELETE FROM citas; DELETE FROM citas_reagendaciones');
    const lead=await insert('en_salon','2030-06-15T17:45:00Z'),guest=await insert('confirmada','2030-06-15T18:30:00Z'),late=await insert('confirmada','2030-06-16T05:59:59.999Z'),tomorrow=await insert('confirmada','2030-06-16T06:00:00Z');
    await pool.query("UPDATE citas SET id_persona_cliente=NULL,contacto_nombre='Invitado retrasado' WHERE id_cita=ANY($1::uuid[])",[[guest,late,tomorrow]]);
    const snapshot=await state(guest);await pool.query('ALTER TABLE citas_reagendaciones ADD CONSTRAINT fixture_guest_failure CHECK(false)');
    const failure=await action(lead,'iniciar-atencion');assert.equal(failure.statusCode,500);assert.equal(queryError.code,'23514');assert.equal((await state(guest)).inicio_at.getTime(),snapshot.inicio_at.getTime());assert.equal((await state(lead)).estado_cita_codigo,'en_salon');
    await pool.query('ALTER TABLE citas_reagendaciones DROP CONSTRAINT fixture_guest_failure');const response=await action(lead,'iniciar-atencion');assert.equal(response.statusCode,200,response.body+' '+queryError?.message);
    assert.equal((await state(guest)).inicio_at.getTime(),snapshot.inicio_at.getTime()+15*60000);assert.equal((await state(late)).inicio_at.toISOString(),'2030-06-16T06:14:59.999Z');assert.equal((await state(tomorrow)).inicio_at.toISOString(),'2030-06-16T06:00:00.000Z');
    assert.equal(Number((await pool.query('SELECT count(*) n FROM citas_reagendaciones')).rows[0].n),2);
  });

});
