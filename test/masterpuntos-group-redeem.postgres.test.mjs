import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import auth from '../src/plugins/auth.js';
import privateCommerce from '../src/plugins/privateCommerce.js';
import adminDataEntry from '../src/plugins/adminDataEntry.js';
import clientePointsRoutes from '../src/routes/v1/clientePoints.js';
import citasRoutes from '../src/routes/v1/citas.js';
import publicPagosRoutes from '../src/routes/v1/public/pagos.js';
import { redeemReward, getClientePointsSummary } from '../src/services/pointsService.js';
import { PaymentProviderFactory } from '../src/services/payments/PaymentProviderFactory.js';

const BIN=process.env.MASTERFADE_PHASE02_PG_BIN;
const source=file=>readFile(new URL('../'+file,import.meta.url),'utf8');
// AM: Controladores y SQL canonico originales; todas las identidades y fechas son sinteticas.
test('CANJE-GRUPAL-01: hold, intent, confirmacion y puntos con PostgreSQL real', {skip:!BIN,timeout:240000}, async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mf-group-redeem-')),data=path.join(directory,'data');
 let pool,app,qaConfirmApp,started=false;
 const binary=(name,args)=>{const result=spawnSync(path.join(BIN,name+(process.platform==='win32'?'.exe':'')),args,{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr||result.error?.message);};
 t.after(async()=>{if(qaConfirmApp)await qaConfirmApp.close();if(app)await app.close();if(pool)await pool.end();if(started)binary('pg_ctl',['-D',data,'-m','fast','-w','stop']);assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('mf-group-redeem-'));await rm(directory,{recursive:true,force:true});});
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 binary('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C','--no-sync']);
 await appendFile(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
 binary('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-w','start']);started=true;
 pool=new pg.Pool({host:'127.0.0.1',port,user:'postgres',database:'postgres',max:8});
 await pool.query(await source('test/sql/microfase2a2/ci_cron_bootstrap.sql'));
 await pool.query(await source('test/sql/microfase2a2/pre_2a2_schema.sql'));
 for(const file of ['20260701_microfase_2a2_reconciliacion_transaccional.sql','20260701_microfase_2a3_guardia_snapshot_fiscal.sql','20260701_microfase_2a4_promociones_trazabilidad_cupos.sql','20260701_fase_1_rpc_reserva_atomica_holds.sql','20260702_fase_1b_reserva_canonica_hardening.sql','20260702_fase_1b1_cierre_reserva_canonica.sql'])await pool.query(await source('db/migrations/'+file));
 const points=await source('test/sql/masterpuntos-integral-fixture.sql');
 await pool.query(points.slice(points.indexOf('CREATE TABLE tipos_puntos'),points.indexOf('CREATE TABLE servicios_tarifas')));
 await pool.query(points.slice(points.indexOf('CREATE TABLE membership_plans'),points.indexOf('CREATE TABLE usuarios')));
 await pool.query(`ALTER TABLE clientes ADD COLUMN id_usuario uuid,ADD COLUMN id_sucursal_origen uuid;
 ALTER TABLE usuarios ADD COLUMN estado_acceso text DEFAULT 'activo';
 ALTER TABLE personas ADD COLUMN telefono_principal text DEFAULT '99999999';
 CREATE TABLE correos(id_correo uuid DEFAULT gen_random_uuid(),id_persona uuid,direccion_correo text,deleted_at timestamptz,es_principal boolean DEFAULT true,verificado boolean DEFAULT true);
 ALTER TABLE servicios ADD COLUMN activo boolean DEFAULT true,ADD COLUMN agendable boolean DEFAULT true,ADD COLUMN visible_publico boolean DEFAULT true,ADD COLUMN deleted_at timestamptz;
 ALTER TABLE servicios_tarifas ADD COLUMN servicio_informativo boolean DEFAULT false;
 CREATE TABLE estados_cita(estado_cita_codigo text); INSERT INTO estados_cita VALUES('completada');
 ALTER TABLE citas ADD COLUMN no_show_at timestamptz;
 ALTER TABLE membership_plans ADD COLUMN activo boolean DEFAULT true,ADD COLUMN beneficios jsonb;
 CREATE TABLE membership_plans_sucursal(id_plan_sucursal uuid DEFAULT gen_random_uuid(),id_plan uuid,id_sucursal uuid,precio_hnl numeric,activo boolean DEFAULT true,visible_publico boolean DEFAULT true,orden_visual int,updated_at timestamptz DEFAULT now());
 CREATE TABLE periodos_membresia(periodo_membresia_codigo text,descripcion text);
 ALTER TABLE personas ADD COLUMN foto_perfil_path text,ADD COLUMN foto_perfil_asset_id uuid;
 ALTER TABLE parametros_sistema ADD COLUMN valor_texto text;
 ALTER TABLE horarios_semanales_sucursales_bloques ADD COLUMN id_bloque_horario uuid DEFAULT gen_random_uuid();
 CREATE TABLE barberos_perfiles_publicos(id_empleado uuid,alias_publico text,resumen_publico text,certificaciones_titulos text[],visible_en_landing boolean,deleted_at timestamptz);
 CREATE TABLE storage_assets(id_asset uuid,visibility text,public_url text,updated_at timestamptz,deleted_at timestamptz);
 CREATE TABLE agenda_bloqueos_empleados(id_empleado uuid,rango tstzrange);
 CREATE TABLE agenda_excepciones_sucursal(id_excepcion_sucursal uuid PRIMARY KEY,id_sucursal uuid,fecha date,modo_excepcion_codigo text,motivo text,created_at timestamptz DEFAULT now());
 CREATE TABLE agenda_excepciones_sucursal_bloques(id_bloque_excepcion uuid,id_excepcion_sucursal uuid,hora_inicio time,hora_fin time,minuto_inicio int,minuto_fin int,orden_visual int);
 ALTER TABLE citas_paquetes ADD COLUMN nombre_paquete_snapshot text;
 ALTER TABLE notificaciones_email ADD COLUMN id_notificacion uuid DEFAULT gen_random_uuid(),ADD COLUMN correo_destino text,ADD COLUMN asunto text,ADD COLUMN cuerpo text,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN ultimo_error text,ADD COLUMN enviado_en timestamptz;
 CREATE TABLE seguridad_sesiones(id_sesion uuid,estado text,ultimo_uso_at timestamptz,ip_ultimo_uso inet,user_agent text,request_id text);
 CREATE TABLE app_private.pixelpay_sale_attempts(id_sale_attempt uuid,id_intent uuid,outcome text,uncertain boolean,finalized_at timestamptz,created_at timestamptz);
 CREATE TABLE audit_logs(accion text,metadata jsonb,created_at timestamptz);
 CREATE TABLE payment_events(id_event uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_provider uuid,provider_event_id text,evento_tipo text,firma_valida boolean,payload_esencial jsonb,id_intent uuid,created_at timestamptz DEFAULT now(),UNIQUE(id_provider,provider_event_id));
CREATE TABLE promociones(id_promocion uuid,titulo text,estado boolean,mecanica text,cantidad_requerida int,cantidad_bonificada int);
 ALTER TABLE promociones_sucursal ADD COLUMN visible_publico boolean,ADD COLUMN vigencia_desde date,ADD COLUMN vigencia_hasta date,ADD COLUMN vigencia_hora_desde time,ADD COLUMN vigencia_hora_hasta time;
 CREATE TABLE promociones_reglas_agendamiento(id_promocion_regla uuid,id_promocion uuid,tipo_promocion_agendamiento_codigo text,tipo_descuento_codigo text,aplica_a_codigo text,valor_descuento numeric,es_acumulable boolean,prioridad_aplicacion int,requiere_codigo boolean,codigo_promocional text,max_usos_por_reserva int,max_usos_por_cliente int,modo_aplicacion_codigo text,min_subtotal_hnl numeric,max_descuento_hnl numeric,cantidad_requerida int,cantidad_bonificada int,bonificacion_modo_codigo text,scope_evaluacion_codigo text,activo boolean);
 CREATE TABLE payment_providers(id_provider uuid PRIMARY KEY DEFAULT gen_random_uuid(),codigo text,nombre text,activo boolean DEFAULT true,configuracion_publica jsonb);
 `);
 await pool.query(await source('db/migrations/pixel/20260923010000_payment_intents_provider_contract.sql'));
 const uncertain=await source('db/migrations/pixel/20261106010000_pixelpay_uncertain_expiration_evidence.sql');
 await pool.query(uncertain.slice(uncertain.indexOf('CREATE OR REPLACE FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1('),uncertain.indexOf('$mf$;')+5));
 await pool.query(await source('test/sql/masterpuntos-legacy-functions.sql'));
 await pool.query(await source('test/sql/mf118-points-fixture.sql'));
 await pool.query(await source('db/migrations/20261030010000_masterpuntos_readonly_expiration_v1.sql'));
 await pool.query(`CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,id_cita,origen_punto_codigo ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
 CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo,puntos ON points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();
 CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();`);
 await pool.query(await source('db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql'));
 await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS pago_tardio boolean DEFAULT false;
 ALTER TABLE citas ADD COLUMN IF NOT EXISTS moneda_codigo text DEFAULT 'HNL';
 CREATE TABLE subscription_payments(id_payment uuid,id_suscripcion uuid,estado text,monto_hnl numeric,moneda_codigo text,paid_at timestamptz);
 CREATE TABLE membership_purchase_orders(id_order uuid PRIMARY KEY,id_suscripcion uuid,id_cliente uuid,estado_orden_codigo text,total_hnl numeric,moneda_codigo text,paid_at timestamptz);`);
 await pool.query(await source('db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql'));
 const branch=randomUUID(),barber=randomUUID(),barberPerson=randomUUID(),service=randomUUID(),extra=randomUUID();
 await pool.query("INSERT INTO sucursales(id_sucursal) VALUES($1)",[branch]);
 await pool.query("INSERT INTO personas(id_persona) VALUES($1)",[barberPerson]);
 await pool.query("INSERT INTO empleados(id_empleado,id_sucursal,id_persona) VALUES($1,$2,$3)",[barber,branch,barberPerson]);
 await pool.query("INSERT INTO servicios(id_servicio,nombre_servicio,duracion_min) VALUES($1,'Corte elegible',30),($2,'Extra',15)",[service,extra]);
 await pool.query("INSERT INTO servicios_tarifas(id_tarifa,id_servicio,id_sucursal,precio_hnl,vigente_desde) VALUES(gen_random_uuid(),$1,$3,300,current_date-1),(gen_random_uuid(),$2,$3,150,current_date-1)",[service,extra,branch]);
 await pool.query("INSERT INTO horarios_semanales_empleados(id_empleado,dia_semana,hora_inicio,hora_fin) SELECT $1,i,'08:00','19:00' FROM generate_series(1,7) i",[barber]);
 await pool.query("WITH h AS (INSERT INTO horarios_semanales_sucursales(id_sucursal,vigencia_desde) VALUES($1,current_date-1) RETURNING id_horario_sucursal) INSERT INTO horarios_semanales_sucursales_bloques(id_horario_sucursal,dia_semana,hora_inicio,hora_fin) SELECT h.id_horario_sucursal,i,'08:00','19:00' FROM h CROSS JOIN generate_series(1,7) i",[branch]);
 await pool.query("INSERT INTO points_rule_services SELECT id_rule,$1,c,true,true,1 FROM points_rules CROSS JOIN (VALUES('sin_membresia'),('con_membresia')) v(c)",[service]);
 const launches=[];const originalProvider=PaymentProviderFactory.create;t.after(()=>{PaymentProviderFactory.create=originalProvider;});
 PaymentProviderFactory.create=()=>({async createIntent(args){launches.push(args);return {providerIntentId:randomUUID(),paymentUrl:'https://fixture.invalid/payment',launch:{type:'redirect',action:'https://fixture.invalid/payment',method:'GET',fields:{}}};}});
 const profiles=new Map(),errors=[];process.env.JWT_SECRET=randomBytes(48).toString('hex');
 let confirmationRace=null;
 const armConfirmationRace=groupId=>{let release;const ready=new Promise(resolve=>{release=resolve;});confirmationRace={groupId:String(groupId),arrivals:0,ready,release};};
 let dbQueries=0;
 const query=async(client,sql,params)=>{
  dbQueries++;
  if(confirmationRace&&sql.includes('SELECT id_grupo_cita, id_cliente_titular, id_persona_titular, estado_grupo_codigo')&&String(params?.[0]||'')===confirmationRace.groupId){confirmationRace.arrivals++;if(confirmationRace.arrivals===2)confirmationRace.release();await confirmationRace.ready;}
  if(sql.includes('WITH base_user'))return {rows:profiles.has(params[0])?[profiles.get(params[0])]:[]};
  if(sql.includes('token_jti_hash = $3'))return {rows:[{estado:'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:null}]};
  return client.query(sql,params).catch(error=>{errors.push({message:error.message,sql});throw error;});
 };
 const db={query:(sql,params)=>query(pool,sql,params),async connect(){const client=await pool.connect();return{query:(sql,params)=>query(client,sql,params),release:()=>client.release()};}};
 app=Fastify();app.decorate('db',db);app.decorate('config',{paymentProvider:'mock',bookingIsvEnabled:false,qaPaymentSimulation:{enabled:true},privateCommercePilot:{enabled:false,userIds:[],ips:[],proxies:[]}});
 await app.register(fp(async()=>{},{name:'env-plugin'}));await app.register(cookie);await app.register(auth);await app.register(citasRoutes,{prefix:'/v1/citas'});await app.register(publicPagosRoutes,{prefix:'/v1/pagos/reservas',authenticated:true});await app.ready();
 let emailsSent=0;
 qaConfirmApp=Fastify();qaConfirmApp.decorate('db',db);qaConfirmApp.decorate('config',{paymentProvider:'todopago',bookingIsvEnabled:false,qaPaymentSimulation:{enabled:true},privateCommercePilot:{enabled:false,userIds:[],ips:[],proxies:[]}});qaConfirmApp.decorate('mailer',{configured:true,sendMail:async()=>{emailsSent++;return{sent:true};}});
 await qaConfirmApp.register(fp(async()=>{},{name:'env-plugin'}));await qaConfirmApp.register(cookie);await qaConfirmApp.register(auth);await qaConfirmApp.register(privateCommerce);await qaConfirmApp.register(citasRoutes,{prefix:'/v1/citas'});await qaConfirmApp.ready();
 const unauthenticated=await qaConfirmApp.inject({method:'POST',url:`/v1/citas/hold/${randomUUID()}/confirmar`,payload:{}});assert.equal(unauthenticated.statusCode,401,unauthenticated.body);
 const plan=randomUUID();await pool.query("INSERT INTO membership_plans(id_plan,nombre_plan,descripcion,periodo_membresia_codigo,categoria_nivel) VALUES($1,'VIP fixture','Grupo','mensual',1)",[plan]);
 const owner=async(points=10,member=false)=>{
  const id=randomUUID(),person=randomUUID(),user=randomUUID(),email=user+'@example.test';
  await pool.query("INSERT INTO personas(id_persona,nombres,apellidos) VALUES($1,'Cliente','Sintetico')",[person]);
  await pool.query('INSERT INTO usuarios(id_usuario,id_persona) VALUES($1,$2)',[user,person]);
  await pool.query('INSERT INTO clientes(id_cliente,id_persona,id_usuario,id_sucursal_origen) VALUES($1,$2,$3,$4)',[id,person,user,branch]);
  await pool.query('INSERT INTO correos(id_persona,direccion_correo) VALUES($1,$2)',[person,email]);
  profiles.set(user,{id_usuario:user,id_persona:person,roles:['cliente'],cliente_id:id,email});
  if(points)await pool.query("INSERT INTO points_transactions(id_cliente,tipo_puntos_codigo,origen_punto_codigo,puntos,id_cycle) SELECT $1,'ajustar','sistema',$2,id_cycle FROM fn_points_get_or_create_active_cycle($1,12,now())",[id,points]);
  if(member)await pool.query("INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada,beneficios_snapshot) VALUES(gen_random_uuid(),$1,$2,'activa',now()-interval '1 day',now()+interval '1 year',$3,$4)",[id,plan,branch,{version:1,items:[{tipo:'servicio',id_servicio:service,nombre:'Corte VIP',cantidad:100}]}]);
  const token=jwt.sign({sub:user,sid:randomUUID(),jti:randomUUID(),token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});
  return {id,person,user,email,cookie:`mf_session=${token}`};
 };
 const balance=async actor=>Number((await pool.query('SELECT balance_puntos FROM vw_points_balance WHERE id_cliente=$1',[actor.id])).rows[0]?.balance_puntos||0);
 let day=7;
 const payloadFor=(contacts,token,{extras=true}={})=>{
  let chosen=new Date(Date.now()+day++*86400000);if(chosen.getUTCDay()===0)chosen=new Date(Date.now()+day++*86400000);
  const date=chosen.toISOString().slice(0,10);
  return {id_sucursal:branch,...(token?{canje_context_token:token}:{}),integrantes:[null,...contacts].map((contact,index)=>({orden_integrante:index+1,alias:index?'Invitado '+index:'Titular',id_barbero:barber,selection_type:'services',
   servicios:[{id_servicio:service},...(extras&&index===0?[{id_servicio:extra}]:[])],fecha_inicio:`${date}T${10+index}:00:00-06:00`,contacto:{nombre:'Invitado Sintetico',email:contact?.email||'guest'+index+'@example.test'}}))};
 };
 const inject=(actor,url,payload,key=randomUUID(),server=app)=>server.inject({method:'POST',url,headers:{cookie:actor.cookie,'x-idempotency-key':key},payload});
 const ok=response=>{assert.equal(response.statusCode>=200&&response.statusCode<300,true,response.body+'\n'+JSON.stringify(errors.filter(error=>!error.message.startsWith('current transaction')).slice(-3).map(error=>error.message)));return response.json().data;};
 const invoke=async(actor,url,payload,key)=>ok(await inject(actor,url,payload,key));
 const prepare=actor=>redeemReward({db},{idCliente:actor.id,idSucursal:branch,idServicioCanje:service});
 const createIntent=(actor,hold)=>invoke(actor,'/v1/pagos/reservas/crear-intent',{id_grupo_cita:hold.id_grupo_cita,titular_email:actor.email});
 const paymentPayload=(actor,hold,intent)=>({id_grupo_cita:hold.id_grupo_cita,id_intent:intent.id_intent,titular_email:actor.email});
 const pay=(actor,hold,intent,status='paid')=>invoke(actor,'/v1/pagos/reservas/mock-completar',{...paymentPayload(actor,hold,intent),status});
 for(const points of [10,20]) for(const member of [false,true]) for(const count of [1,2,3,4]) for(const kind of ['registrados','invitados']) await t.test(`saldo ${points}, VIP=${member}, ${count} acompanantes ${kind}: total grupal y un solo canje`,async()=>{
  const actor=await owner(points,member),contacts=[];
  for(let i=0;i<count;i++)contacts.push(kind==='registrados'?await owner(0):null);
  const reward=await prepare(actor),payload=payloadFor(contacts,reward.canje_context_token),key=randomUUID(),expected=count*300+150;
  assert.equal(await balance(actor),points);
  const hold=await invoke(actor,'/v1/citas/hold',payload,key);
  assert.equal(hold.total_pagar_hnl,expected);assert.equal(hold.cubierto_por_recompensa_hnl,300);assert.equal(hold.cubierto_por_plan_hnl,0);
  assert.equal(hold.descuento_total_hnl,300);assert.equal(hold.subtotal_hnl,expected+300);
  const replay=await invoke(actor,'/v1/citas/hold',payload,key);assert.equal(replay.id_grupo_cita,hold.id_grupo_cita);
  const rows=(await pool.query('SELECT id_cita,id_cliente,orden_integrante,es_canje_recompensa,total_pagar_hnl FROM citas WHERE id_grupo_cita=$1 ORDER BY orden_integrante',[hold.id_grupo_cita])).rows;
  assert.equal(rows.length,count+1);assert.equal(rows[0].es_canje_recompensa,true);
  assert.equal(Number(rows[0].total_pagar_hnl),150);assert.ok(rows.slice(1).every(row=>row.es_canje_recompensa===false&&Number(row.total_pagar_hnl)===300));
  assert.equal(await balance(actor),points);
  const intent=await createIntent(actor,hold);assert.equal(intent.monto_hnl,expected);assert.equal(intent.total_hnl,expected);
  const repeatedIntent=await createIntent(actor,hold);assert.equal(repeatedIntent.id_intent,intent.id_intent);
  assert.equal(launches.at(-1).montoHnl,expected);
  await pool.query("UPDATE payment_intents SET estado_intent_codigo='pendiente_confirmacion' WHERE id_intent=$1",[intent.id_intent]);
  const pending=await invoke(actor,'/v1/pagos/reservas/estado',paymentPayload(actor,hold,intent));assert.equal(pending.booking_confirmed,false);assert.equal(await balance(actor),points);
  const bypass=await inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp);
  assert.equal(bypass.statusCode,409);assert.equal(bypass.json().error.code,'CITAS_CONFIRM_PAYMENT_REQUIRED');
  const paid=await pay(actor,hold,intent);assert.equal(paid.booking.total_hnl,expected);assert.equal(paid.booking.recompensa_utilizada.puntos_descontados,10);
  assert.equal(await balance(actor),points-10);
  await Promise.all([pay(actor,hold,intent),pay(actor,hold,intent)]);
  assert.equal(await balance(actor),points-10);
  assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cita=ANY($1::uuid[]) AND tipo_puntos_codigo='canjear'",[rows.map(row=>row.id_cita)])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment_intents WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows[0].n,1);
  await Promise.all(rows.map(row=>pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1",[row.id_cita])));
  await Promise.all(rows.map(row=>pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_cita=$1",[row.id_cita])));
  // AM: Un pago mock no es evidencia financiera; completar tampoco acredita con la nueva migracion.
  assert.equal(await balance(actor),points-10);
  for(const contact of contacts.filter(Boolean))assert.equal(await balance(contact),0);
 });
 for(const member of [false,true]) for(const count of [1,2,3,4]) await t.test(`saldo 9, VIP=${member}, ${count} acompanantes: reserva normal sin canje`,async()=>{
  const actor=await owner(9,member);await assert.rejects(prepare(actor),{code:'POINTS_REDEEM_INSUFFICIENT_BALANCE'});
  const hold=await invoke(actor,'/v1/citas/hold',payloadFor(Array(count).fill(null),null,{extras:false}));assert.equal(hold.total_pagar_hnl,(count+(member?0:1))*300);assert.equal(await balance(actor),9);
  const persisted=(await pool.query("SELECT response_payload FROM app_private.reserva_idempotencia WHERE id_grupo_cita=$1 AND scope='auth:citas:hold'",[hold.id_grupo_cita])).rows;
  assert.equal(persisted.length,1);
  const evidence=persisted[0].response_payload.membership_consumption;
  assert.equal(evidence.version,1);assert.equal(evidence.id_suscripcion,member?hold.membresia.id_suscripcion:null);
  assert.equal(evidence.citas.length,count+1);
  const appointments=(await pool.query('SELECT id_cita,orden_integrante FROM citas WHERE id_grupo_cita=$1 ORDER BY orden_integrante',[hold.id_grupo_cita])).rows;
  for(const appointment of appointments){
   const covered=evidence.citas.find(row=>row.id_cita===appointment.id_cita);assert.ok(covered);
   if(member&&Number(appointment.orden_integrante)===1){
    const detail=(await pool.query('SELECT line_key,id_servicio,cantidad FROM citas_detalles WHERE id_cita=$1',[appointment.id_cita])).rows;
    assert.equal(detail.length,1);assert.deepEqual(covered.servicios,[{id_servicio:service,line_key:detail[0].line_key,cantidad:1}]);
   }else assert.deepEqual(covered.servicios,[]);
  }
  assert.equal(Object.hasOwn(hold,'membership_consumption'),false);
  assert.equal(Object.hasOwn(persisted[0].response_payload.data,'membership_consumption'),false);
 });
 await t.test('cuota VIP no disponible revierte confirmacion HTTP y no deja consumos ni puntos',async()=>{
  const actor=await owner(9,true);
  const hold=await invoke(actor,'/v1/citas/hold',payloadFor([],null,{extras:false}));
  await pool.query("UPDATE subscriptions SET estado_suscripcion_codigo='vencida',motivo_fin_codigo='agotamiento' WHERE id_cliente=$1",[actor.id]);
  const before=(await pool.query('SELECT id_cita,estado_cita_codigo FROM citas WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows;
  assert.equal(before.length,1);assert.equal(before[0].estado_cita_codigo,'en_espera');
  const response=await inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{});
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().error.code,'MEMBERSHIP_CONSUMPTION_SUBSCRIPTION_INACTIVE');
  assert.deepEqual((await pool.query('SELECT id_cita,estado_cita_codigo FROM citas WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows,before);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM subscription_consumptions WHERE id_cita=$1',[before[0].id_cita])).rows[0].n,0);
  assert.equal(await balance(actor),9);
 });
 await t.test('sin servicios elegibles mantiene gate obligatorio y mensaje de ausencia',async()=>{
  const actor=await owner();await pool.query('UPDATE points_rule_services SET habilitado=false');
  try {
   const summary=await getClientePointsSummary({db},actor.id,{includeRedeemableServices:true});assert.deepEqual(summary.servicios_redimibles,[]);
   await assert.rejects(prepare(actor),{code:'POINTS_REDEEM_SERVICE_FORBIDDEN'});
   const blocked=await inject(actor,'/v1/citas/hold',payloadFor([null],null));assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.code,'REWARD_REDEEM_REQUIRED');assert.equal(await balance(actor),10);
  }finally{await pool.query('UPDATE points_rule_services SET habilitado=true');}
 });
 await t.test('tarifa cero del propio servicio de recompensa conserva rechazo sin consumo',async()=>{
  const actor=await owner();await pool.query('UPDATE servicios_tarifas SET precio_hnl=0 WHERE id_servicio=$1',[service]);
  try {
   const reward=await prepare(actor),before=(await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n;
   const response=await inject(actor,'/v1/citas/hold',payloadFor([null],reward.canje_context_token));
   assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'POINTS_REDEEM_NOT_APPLIED');assert.equal(await balance(actor),10);
   assert.equal((await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n,before);
  }finally{await pool.query('UPDATE servicios_tarifas SET precio_hnl=300 WHERE id_servicio=$1',[service]);}
 });
 await t.test('titular sin extras, total cero: confirmar sin intent, idempotente y sin punto propio',async()=>{
  const actor=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([],reward.canje_context_token,{extras:false}));
  assert.equal(hold.total_pagar_hnl,0);assert.equal(await balance(actor),10);
  const noPayment=await inject(actor,'/v1/pagos/reservas/crear-intent',{id_grupo_cita:hold.id_grupo_cita,titular_email:actor.email});
  assert.equal(noPayment.statusCode,409);assert.equal(noPayment.json().error.code,'PUBLIC_PAGOS_GROUP_NO_PENDING_BALANCE');
  const paymentsBefore=Number((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n);
  const eventsBefore=Number((await pool.query('SELECT count(*)::int n FROM payment_events')).rows[0].n);
  const launchesBefore=launches.length;
  const emailsBefore=emailsSent;
  const result=ok(await inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp));
  assert.equal(result.confirmado_sin_pago,true);assert.equal(result.estado_grupo_codigo,'confirmada');assert.equal(result.total_pagar_hnl,0);assert.equal(result.recompensa_utilizada.puntos_descontados,10);assert.equal(result.citas_confirmadas_count,1);
  const replay=ok(await inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp));
  assert.equal(replay.ya_confirmadas,true);assert.equal(await balance(actor),0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='canjear'",[actor.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment_intents WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows[0].n,0);
  assert.equal(Number((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n),paymentsBefore);
  assert.equal(Number((await pool.query('SELECT count(*)::int n FROM payment_events')).rows[0].n),eventsBefore);
  assert.equal(launches.length,launchesBefore);
  assert.equal(emailsSent,emailsBefore+1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM citas WHERE id_grupo_cita=$1 AND estado_cita_codigo='confirmada'",[hold.id_grupo_cita])).rows[0].n,1);
  await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_grupo_cita=$1",[hold.id_grupo_cita]);assert.equal(await balance(actor),0);
 });
 await t.test('dos confirmaciones simultaneas serializan efectos y correo',async()=>{
  const actor=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([],reward.canje_context_token,{extras:false}));
  const auditBefore=Number((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE accion='cita_confirmada_sin_pago'")).rows[0].n),emailsBefore=emailsSent;
  armConfirmationRace(hold.id_grupo_cita);
  const responses=await Promise.all([inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp),inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp)]);confirmationRace=null;
  for(const response of responses)assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(responses.map(response=>response.json().data.ya_confirmadas).sort(),[false,true]);
  assert.equal(emailsSent,emailsBefore+1);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE accion='cita_confirmada_sin_pago'")).rows[0].n),auditBefore+1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='canjear'",[actor.id])).rows[0].n,1);assert.equal(await balance(actor),0);
 });
 await t.test('confirmacion sin pago conserva propietario y vencimiento del hold',async()=>{
  const actor=await owner(),other=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([],reward.canje_context_token,{extras:false}));
  const foreign=await inject(other,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp);
  assert.equal(foreign.statusCode,403);assert.equal(foreign.json().error.code,'CITAS_GROUP_FORBIDDEN');assert.equal(await balance(actor),10);assert.equal(await balance(other),10);
  await pool.query("UPDATE citas_holds SET expires_at=now()-interval '1 second' WHERE id_cita IN(SELECT id_cita FROM citas WHERE id_grupo_cita=$1)",[hold.id_grupo_cita]);
  const expired=await inject(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token},randomUUID(),qaConfirmApp);
  assert.equal(expired.statusCode,409);assert.ok(['CITAS_HOLD_EXPIRED','CITAS_HOLD_INACTIVE'].includes(expired.json().error.code),expired.body);assert.equal(await balance(actor),10);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment_intents WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM points_transactions WHERE id_cliente=$1 AND tipo_puntos_codigo='canjear'",[actor.id])).rows[0].n,0);
 });
 for(const count of [1,2,3,4])await t.test(`grupo ${count} con total configurado cero: solo un canje, sin puntos por servicios gratuitos`,async()=>{
  const actor=await owner(),reward=await prepare(actor),payload=payloadFor(Array(count).fill(null),reward.canje_context_token,{extras:false});
  payload.integrantes.slice(1).forEach(block=>{block.servicios=[{id_servicio:extra}];});
  await pool.query('UPDATE servicios_tarifas SET precio_hnl=0 WHERE id_servicio=$1',[extra]);
  try {
   const hold=await invoke(actor,'/v1/citas/hold',payload);assert.equal(hold.total_pagar_hnl,0);
   const result=await invoke(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token});assert.equal(result.recompensa_utilizada.puntos_descontados,10);assert.equal(await balance(actor),0);
   await invoke(actor,`/v1/citas/hold/${hold.id_grupo_cita}/confirmar`,{canje_context_token:reward.canje_context_token});assert.equal(await balance(actor),0);
   await pool.query("UPDATE citas SET estado_cita_codigo='completada' WHERE id_grupo_cita=$1",[hold.id_grupo_cita]);assert.equal(await balance(actor),0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM payment_intents WHERE id_grupo_cita=$1',[hold.id_grupo_cita])).rows[0].n,0);
  }finally{await pool.query('UPDATE servicios_tarifas SET precio_hnl=150 WHERE id_servicio=$1',[extra]);}
 });
 await t.test('token ajeno/invalido, servicio no seleccionado y paquetes del titular no crean operaciones',async()=>{
  const actor=await owner(),other=await owner(),reward=await prepare(actor),payload=payloadFor([null],reward.canje_context_token);
  const before=(await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n;
  const unauthorized=await inject(other,'/v1/citas/hold',payload);assert.equal(unauthorized.statusCode,403);assert.equal(unauthorized.json().error.code,'POINTS_REDEEM_CONTEXT_FORBIDDEN');
  const invalid=await inject(actor,'/v1/citas/hold',{...payload,canje_context_token:reward.canje_context_token.slice(0,-1)+'!'});assert.equal(invalid.statusCode,409);
  const wrong=structuredClone(payload);wrong.integrantes[0].servicios=[{id_servicio:extra}];
  const missing=await inject(actor,'/v1/citas/hold',wrong);assert.equal(missing.statusCode,409);assert.equal(missing.json().error.code,'POINTS_REDEEM_SERVICE_MISMATCH');
  for(const selection_type of ['package','mixed']) {
   const wrongPackage=structuredClone(payload);wrongPackage.integrantes[0].selection_type=selection_type;wrongPackage.integrantes[0].id_paquete=randomUUID();
   const response=await inject(actor,'/v1/citas/hold',wrongPackage);assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'POINTS_REDEEM_PACKAGE_NOT_ALLOWED');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n,before);assert.equal(await balance(actor),10);assert.equal(await balance(other),10);
 });
 await t.test('ordenes de titular duplicados no permiten un segundo servicio canjeado',async()=>{
  const actor=await owner(),reward=await prepare(actor),payload=payloadFor([null],reward.canje_context_token);
  payload.integrantes[1].orden_integrante=1;
  const before=(await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n;
  const response=await inject(actor,'/v1/citas/hold',payload);assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'POINTS_REDEEM_GROUP_ORDER_INVALID');
  assert.equal((await pool.query('SELECT count(*)::int n FROM citas')).rows[0].n,before);assert.equal(await balance(actor),10);
 });
 await t.test('intento con importe divergente y acceso de otro cliente no confirma ni consume',async()=>{
  const actor=await owner(),other=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([null],reward.canje_context_token)),intent=await createIntent(actor,hold);
  const wrongOwner=await inject(other,'/v1/pagos/reservas/mock-completar',{...paymentPayload(actor,hold,intent),status:'paid'});assert.equal(wrongOwner.statusCode,403);
  await pool.query('UPDATE payment_intents SET monto_hnl=monto_hnl+1 WHERE id_intent=$1',[intent.id_intent]);
  const mismatch=await inject(actor,'/v1/pagos/reservas/mock-completar',{...paymentPayload(actor,hold,intent),status:'paid'});assert.equal(mismatch.statusCode,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payments WHERE id_intent=$1',[intent.id_intent])).rows[0].n,0);assert.equal(await balance(actor),10);
 });
 for(const status of ['failed','expired'])await t.test(`${status}: no debita, no confirma y rechaza reutilizacion`,async()=>{
  const actor=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([null,null],reward.canje_context_token)),intent=await createIntent(actor,hold);
  await pay(actor,hold,intent,status);assert.equal(await balance(actor),10);
  const invalid=await inject(actor,'/v1/pagos/reservas/mock-completar',{...paymentPayload(actor,hold,intent),status:'paid'});assert.equal(invalid.statusCode,409);assert.equal(await balance(actor),10);
 });
 await t.test('holds expirados, cancelaciones e inasistencias no consumen ni acreditan',async()=>{
  const actor=await owner(),reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([null,null],reward.canje_context_token));
  await pool.query("UPDATE citas_holds SET expires_at=now()-interval '1 second' WHERE id_cita IN(SELECT id_cita FROM citas WHERE id_grupo_cita=$1)",[hold.id_grupo_cita]);
  const invalid=await inject(actor,'/v1/pagos/reservas/crear-intent',{id_grupo_cita:hold.id_grupo_cita,titular_email:actor.email});assert.equal(invalid.statusCode,409);assert.equal(await balance(actor),10);
  const nextHold=await invoke(actor,'/v1/citas/hold',payloadFor([null,null,null],reward.canje_context_token)),intent=await createIntent(actor,nextHold);await pay(actor,nextHold,intent);
  const rows=(await pool.query('SELECT id_cita FROM citas WHERE id_grupo_cita=$1 ORDER BY orden_integrante',[nextHold.id_grupo_cita])).rows;
  for(const [i,state] of ['completada','cancelada','no_show','completada'].entries())await pool.query('UPDATE citas SET estado_cita_codigo=$1 WHERE id_cita=$2',[state,rows[i].id_cita]);
  assert.equal(await balance(actor),0);
 });
 await t.test('dos servicios elegibles del mismo precio: confirma solo el servicio descontado del titular',async()=>{
  const actor=await owner();
  await pool.query('UPDATE servicios_tarifas SET precio_hnl=300 WHERE id_servicio=$1',[extra]);
  await pool.query("INSERT INTO points_rule_services SELECT id_rule,$1,'sin_membresia',true,true,2 FROM points_rules",[extra]);
  try {
   const reward=await prepare(actor),hold=await invoke(actor,'/v1/citas/hold',payloadFor([null],reward.canje_context_token)),intent=await createIntent(actor,hold);
   assert.equal(hold.total_pagar_hnl,600);assert.equal(intent.monto_hnl,600);
   const paid=await pay(actor,hold,intent);assert.equal(paid.booking.recompensa_utilizada.id_servicio_canje,service);assert.equal(await balance(actor),0);
  }finally{await pool.query('DELETE FROM points_rule_services WHERE id_servicio=$1',[extra]);await pool.query('UPDATE servicios_tarifas SET precio_hnl=150 WHERE id_servicio=$1',[extra]);}
 });
 await t.test('comercio pausado rechaza antes de SQL, holds, intents, canjes y confirmaciones',async()=>{
  const paused=Fastify();t.after(()=>paused.close());paused.decorate('db',db);paused.decorate('config',{paymentProvider:'disabled',adminDataEntryMode:true,privateCommercePilot:{enabled:false,userIds:[],ips:[],proxies:[]}});
  await paused.register(fp(async()=>{},{name:'env-plugin'}));await paused.register(cookie);await paused.register(auth);await paused.register(adminDataEntry);await paused.register(privateCommerce);await paused.register(clientePointsRoutes,{prefix:'/v1/cliente/puntos'});await paused.register(citasRoutes,{prefix:'/v1/citas'});await paused.register(publicPagosRoutes,{prefix:'/v1/pagos/reservas',authenticated:true});await paused.ready();
  const actor=await owner(),reward=await prepare(actor);
  const before=(await pool.query("SELECT (SELECT count(*) FROM citas) citas,(SELECT count(*) FROM payment_intents) intents,(SELECT count(*) FROM points_transactions) puntos")).rows;
  for(const [url,payload] of [['/v1/cliente/puntos/canjear',{id_servicio:service,id_sucursal:branch}],['/v1/citas/hold',payloadFor([null],reward.canje_context_token)],['/v1/citas/hold/'+randomUUID()+'/confirmar',{}],['/v1/pagos/reservas/crear-intent',{id_grupo_cita:randomUUID(),titular_email:actor.email}],['/v1/pagos/reservas/mock-completar',{id_grupo_cita:randomUUID(),id_intent:randomUUID(),titular_email:actor.email}]]){
   const queries=dbQueries;const response=await inject(actor,url,payload,randomUUID(),paused);assert.equal(dbQueries,queries);assert.equal(response.statusCode,403);assert.equal(response.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');
  }
  assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM citas) citas,(SELECT count(*) FROM payment_intents) intents,(SELECT count(*) FROM points_transactions) puntos")).rows,before);
 });
});
