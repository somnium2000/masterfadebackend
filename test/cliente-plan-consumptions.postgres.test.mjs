import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import auth from '../src/plugins/auth.js';
import routes from '../src/routes/v1/cliente.js';
import {getClienteMembershipState} from '../src/services/membershipService.js';
const BIN=process.env.MASTERFADE_PHASE02_PG_BIN;
// AM: PostgreSQL local efímero, guardas/controladores reales y metadatos de sesión sintéticos.
test('Planes Cliente: paginación SQL, aislamiento y remanentes',{skip:!BIN,timeout:90000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mf-planes-pag-')),data=path.join(dir,'data');let pool,app,started=false;
 const binary=(name,args)=>{const r=spawnSync(path.join(BIN,name+(process.platform==='win32'?'.exe':'')),args,{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);};
 t.after(async()=>{if(app)await app.close();if(pool)await pool.end();if(started)binary('pg_ctl',['-D',data,'-m','fast','-w','stop']);assert.equal(path.dirname(dir),path.resolve(tmpdir()));assert.ok(path.basename(dir).startsWith('mf-planes-pag-'));await rm(dir,{recursive:true,force:true});});
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));binary('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--locale=C','--no-sync']);binary('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;
 pool=new pg.Pool({host:'127.0.0.1',port,user:'postgres',database:'postgres'});
 await pool.query(`CREATE TABLE membership_plans(id_plan uuid PRIMARY KEY,nombre_plan text,descripcion text,periodo_membresia_codigo text,categoria_nivel int);
 CREATE TABLE subscriptions(id_suscripcion uuid PRIMARY KEY,id_cliente uuid,id_plan uuid,estado_suscripcion_codigo text,inicio_at timestamptz,fin_at timestamptz,id_sucursal_contratada uuid,beneficios_snapshot jsonb,motivo_fin_codigo text,created_at timestamptz DEFAULT now());
 CREATE TABLE subscription_consumptions(id_consumo uuid PRIMARY KEY,id_suscripcion uuid,id_cliente uuid,id_cita uuid,orden_integrante int,item_tipo text,id_servicio uuid,id_cortesia uuid,item_codigo text,item_nombre text,cantidad int,precio_unitario_hnl numeric,total_hnl numeric,coverage_status text,source_kind text,invalidado boolean,invalidado_motivo text,id_usuario_ejecutor uuid,created_at timestamptz);
 CREATE TABLE citas(id_cita uuid PRIMARY KEY,estado_cita_codigo text,id_sucursal uuid,inicio_at timestamptz DEFAULT '2030-01-01T16:00:00Z');
 CREATE TABLE sucursales(id_sucursal uuid,nombre_sucursal text);
 CREATE TABLE usuarios(id_usuario uuid,id_persona uuid);CREATE TABLE personas(id_persona uuid,nombres text,apellidos text);`);
 const client=randomUUID(),other=randomUUID(),sub=randomUUID(),foreign=randomUUID(),past=randomUUID(),branch=randomUUID(),plan=randomUUID(),service=randomUUID();
 await pool.query("INSERT INTO membership_plans VALUES($1,'Plan fixture','Prueba','mensual',1)",[plan]);await pool.query("INSERT INTO sucursales VALUES($1,'Centro')",[branch]);
 const benefits={version:1,items:[{tipo:'servicio',id_servicio:service,nombre:'Corte',cantidad:1000},{tipo:'cortesia',codigo:'lavado',nombre:'Lavado',cantidad:4}]};
 for(const [id,owner,state]of [[sub,client,'activa'],[foreign,other,'activa'],[past,client,'cancelada']])await pool.query("INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada,beneficios_snapshot) VALUES($1,$2,$3,$4,'2020-01-01','2099-01-01',$5,$6)",[id,owner,plan,state,branch,benefits]);
 const profiles=new Map();process.env.JWT_SECRET=randomBytes(48).toString('hex');
 const token=(owner,role='cliente')=>{const id=randomUUID();profiles.set(id,{id_usuario:id,roles:[role],cliente_id:owner,id_persona:randomUUID()});return jwt.sign({sub:id,sid:randomUUID(),jti:randomUUID(),token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});};
 let connectionFails=false;
 const db={query(sql,params){if(sql.includes('WITH base_user'))return {rows:profiles.has(params[0])?[profiles.get(params[0])]:[]};if(sql.includes('token_jti_hash = $3'))return {rows:[{estado:'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:null}]};return pool.query(sql,params);},connect:()=>{if(connectionFails)throw new Error('detalle privado del fixture');return pool.connect();}};
 app=Fastify();app.decorate('db',db);await app.register(cookie);await app.register(auth);await app.register(routes,{prefix:'/v1/cliente'});
 const access=token(client),second=token(other),url='/v1/cliente/planes/consumos';
 const call=(query='',session=access)=>app.inject({url:url+query,headers:{cookie:'mf_session='+session}});
 const insert=async(i,{owner=client,subscription=sub,state='completada',source='appointment_completed',invalid=false}={})=>{const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0'),cita=randomUUID();await pool.query('INSERT INTO citas(id_cita,estado_cita_codigo,id_sucursal) VALUES($1,$2,$3)',[cita,state,branch]);await pool.query("INSERT INTO subscription_consumptions(id_consumo,id_suscripcion,id_cliente,id_cita,item_tipo,id_servicio,item_nombre,cantidad,coverage_status,source_kind,invalidado,created_at) VALUES($1,$2,$3,$4,'servicio',$5,$6,1,'cubierto_plan',$7,$8,'2030-01-01T16:00:00Z')",[id,subscription,owner,cita,service,'Consumo '+i,source,invalid]);return id;};
 await t.test('0,1,5,6,10,41,56: todas las páginas con empate estable y sin pérdidas',async()=>{
  for(const count of [0,1,5,6,10,41,56]){
   await pool.query('TRUNCATE subscription_consumptions,citas');const ids=[];for(let i=1;i<=count;i++)ids.push(await insert(i));const seen=[];
   for(let page=1;page<=Math.max(1,Math.ceil(count/5));page++){
    const response=await call('?page='+page+'&limit=5');assert.equal(response.statusCode,200,response.body);const payload=response.json().data;
    assert.deepEqual(payload.pagination,{page,limit:5,total:count,total_pages:Math.max(1,Math.ceil(count/5))});assert.ok(payload.consumos.length<=5);seen.push(...payload.consumos.map(row=>row.id_consumo));
    for(const row of payload.consumos){assert.equal(row.id_suscripcion,sub);assert.equal(row.nombre_sucursal,'Centro');assert.equal(row.nombre_plan,'Plan fixture');}
   }
   assert.deepEqual(seen,ids.reverse());assert.equal(new Set(seen).size,count);
   const high=await call('?page=999');assert.equal(high.json().data.pagination.page,Math.max(1,Math.ceil(count/5)));
  }
 });
 await t.test('validación, dos clientes, propiedad de suscripción, auth y rol',async()=>{
  for(const query of ['?page=0','?page=-1','?page=x','?limit=10','?id_suscripcion=bad'])assert.equal((await call(query)).statusCode,400);
  assert.equal((await call('?id_suscripcion='+foreign)).statusCode,404);
  assert.equal((await call('?id_suscripcion='+sub,second)).statusCode,404);
  assert.equal((await call('',token(client,'barbero'))).statusCode,403);assert.equal((await call('','invalid')).statusCode,401);assert.equal((await app.inject({url})).statusCode,401);
  assert.equal((await call('',second)).json().data.pagination.total,0);
  assert.equal((await call('?id_cliente='+other)).json().data.pagination.total,56);
 });
 await t.test('fallo de conexión responde error controlado sin detalles privados',async()=>{
  connectionFails=true;try{const response=await call();assert.equal(response.statusCode,500);assert.doesNotMatch(response.body,/detalle privado/);}finally{connectionFails=false;}
 });
 await t.test('fecha descendente predomina sobre ID y la sucursal se conserva sin cita',async()=>{
  const id=await insert(0);await pool.query("UPDATE subscription_consumptions SET created_at='2031-01-01',id_cita=NULL WHERE id_consumo=$1",[id]);
  const response=await call();const row=response.json().data.consumos[0];assert.equal(row.id_consumo,id);assert.equal(row.nombre_sucursal,'Centro');
 });
 await t.test('filtros operativos, alcance histórico y remanentes no se alteran al paginar',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');await insert(1);await insert(2,{source:'legacy'});await insert(3,{invalid:true});await insert(4,{state:'cancelada'});await insert(5,{state:'expirada'});await insert(6,{subscription:past});await insert(7,{owner:other,subscription:foreign});
  await insert(8,{owner:other,subscription:sub});
  const before=await getClienteMembershipState(pool,client);
  const active=await call();assert.equal(active.json().data.pagination.total,2,active.body);
  assert.equal((await call('?id_suscripcion='+past)).json().data.pagination.total,1);
  for(let i=0;i<3;i++)await call('?page=2');
  const after=await getClienteMembershipState(pool,client);assert.deepEqual(after.planes_activos[0].remanentes,before.planes_activos[0].remanentes);assert.equal(after.planes_activos[0].remanentes.totales.servicios_restantes,998);
  await pool.query("UPDATE subscriptions SET estado_suscripcion_codigo='cancelada' WHERE id_suscripcion=$1",[sub]);
  const historical=await call();assert.equal(historical.json().data.pagination.total,4,historical.body);
 });
 const grouped=(query='',session=access)=>call('?agrupar_por=cita'+query,session);
 const groupInsert=async(i,{count=3,subscription=i%2?sub:past,owner=client,appointment=randomUUID(),source='appointment_completed',invalid=false}={})=>{
  const at=new Date(Date.UTC(2030,0,i+1,5,59,59)).toISOString();
  if(appointment)await pool.query("INSERT INTO citas(id_cita,estado_cita_codigo,id_sucursal,inicio_at) VALUES($1,'completada',$2,$3) ON CONFLICT DO NOTHING",[appointment,branch,at]);
  const ids=[];
  for(let n=0;n<count;n++){
   const id=randomUUID();ids.push(id);
   await pool.query(`INSERT INTO subscription_consumptions(id_consumo,id_suscripcion,id_cliente,id_cita,item_tipo,id_servicio,item_codigo,item_nombre,cantidad,coverage_status,source_kind,invalidado,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'cubierto_plan',$10,$11,$12)`,[id,subscription,owner,appointment,n%2?'cortesia':'servicio',n%2?null:service,n%2?'lavado':null,'Beneficio '+n,n+1,source,invalid,at]);
  }
  return {appointment,ids,at};
 };
 await t.test('UX-05: pagina 0/1/5/6/10/41/56 citas completas; tres beneficios no se fragmentan',async()=>{
  await pool.query("UPDATE subscriptions SET estado_suscripcion_codigo='activa' WHERE id_suscripcion=$1",[sub]);
  for(const count of [0,1,5,6,10,41,56]){
   await pool.query('TRUNCATE subscription_consumptions,citas');const expected=[];
   for(let i=1;i<=count;i++)expected.push(await groupInsert(i));
   const seen=[],lines=[];
   for(let page=1;page<=Math.max(1,Math.ceil(count/5));page++){
    const response=await grouped('&page='+page);assert.equal(response.statusCode,200,response.body);const data=response.json().data;
    assert.deepEqual(data.pagination,{page,limit:5,total:count,total_pages:Math.max(1,Math.ceil(count/5)),has_previous:page>1,has_next:page<Math.ceil(count/5)});
    assert.equal(data.total_consumos,count*3);assert.ok(data.citas.length<=5);
    for(const entry of data.citas){
     assert.equal(entry.tipo,'cita');assert.equal(entry.key,'cita:'+entry.id_cita);assert.equal(entry.consumos.length,3);assert.equal(entry.nombre_sucursal,'Centro');
     assert.ok(entry.inicio_at.endsWith('Z'));assert.equal(entry.planes.length,1);assert.equal(entry.planes[0].nombre_plan,'Plan fixture');
     assert.deepEqual(entry.consumos.map(row=>row.cantidad).sort(),[1,2,3]);
     seen.push(entry.id_cita);lines.push(...entry.consumos.map(row=>row.id_consumo));
    }
    assert.ok(data.membresias.some(row=>row.id_suscripcion===past&&row.estado_visible==='cancelada'));
   }
   assert.deepEqual(seen,expected.reverse().map(row=>row.appointment));assert.equal(new Set(seen).size,count);assert.equal(new Set(lines).size,count*3);
   assert.equal((await grouped('&page=999')).json().data.pagination.page,Math.max(1,Math.ceil(count/5)));
  }
 });
 await t.test('UX-05: una cita extensa con servicios de dos membresias conserva todas sus lineas',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');
  const first=await groupInsert(1,{count:41,subscription:past});await groupInsert(1,{count:3,subscription:sub,appointment:first.appointment});
  const result=(await grouped()).json().data;assert.equal(result.pagination.total,1);assert.equal(result.total_consumos,44);assert.equal(result.citas[0].consumos.length,44);assert.equal(result.citas[0].planes.length,2);
  assert.equal((await grouped('&id_suscripcion='+past)).json().data.citas[0].consumos.length,41);
 });
 await t.test('UX-05: registros historicos sin cita son independientes, incluyendo fuente legacy o nula',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');
  const first=await groupInsert(1,{count:1,appointment:null,source:'legacy'}),second=await groupInsert(1,{count:1,appointment:null,source:null});
  const result=(await grouped()).json().data;assert.equal(result.pagination.total,2);assert.equal(result.citas.length,2);
  assert.deepEqual(new Set(result.citas.map(row=>row.key)),new Set([...first.ids,...second.ids].map(id=>'consumo:'+id)));
  assert.ok(result.citas.every(row=>row.tipo==='sin_cita'&&row.id_cita===null&&row.inicio_at===null&&row.consumos.length===1));
 });
 await t.test('UX-05: historial de planes cancelados no desaparece con una nueva membresia activa ni se limita a veinte',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');await groupInsert(1,{subscription:past});await groupInsert(2,{subscription:sub});
  const history=[];
  for(let i=0;i<25;i++){
   const id=randomUUID();history.push(id);await pool.query("INSERT INTO subscriptions(id_suscripcion,id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,id_sucursal_contratada) VALUES($1,$2,$3,'vencida','2019-01-01','2020-01-01',$4)",[id,client,plan,branch]);
  }
  const result=(await grouped()).json().data;assert.equal(result.pagination.total,2);assert.equal(result.membresias.length,27);
  assert.ok(result.membresias.some(row=>row.id_suscripcion===past&&row.estado_visible==='cancelada'));assert.ok(result.citas.some(row=>row.planes.some(item=>item.id_suscripcion===past)));
  for(const id of history)assert.ok(result.membresias.some(row=>row.id_suscripcion===id));
 });
 await t.test('UX-05: aislamiento de cliente y suscripcion, validacion, compatibilidad y lectura sin escrituras',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');const shared=await groupInsert(1),foreignLines=await groupInsert(2,{owner:other,subscription:foreign});await groupInsert(3,{owner:other,subscription:sub});await groupInsert(4,{owner:client,subscription:foreign});await groupInsert(5,{invalid:true});
  await pool.query('UPDATE subscription_consumptions SET id_cita=$1 WHERE id_consumo=ANY($2::uuid[])',[shared.appointment,foreignLines.ids]);
  const snapshot=async()=>(await pool.query(`SELECT jsonb_build_object('consumos',(SELECT jsonb_agg(to_jsonb(sc) ORDER BY sc.id_consumo) FROM subscription_consumptions sc),'planes',(SELECT jsonb_agg(to_jsonb(sub) ORDER BY sub.id_suscripcion) FROM subscriptions sub)) data`)).rows[0].data;
  const before=await snapshot();
  const own=await grouped();assert.equal(own.statusCode,200);assert.equal(own.json().data.pagination.total,2);assert.equal(own.json().data.total_consumos,6);assert.ok(own.json().data.citas.flatMap(row=>row.consumos).every(row=>row.id_suscripcion===sub));assert.equal(own.json().data.citas.find(row=>row.id_cita===shared.appointment).consumos.length,3);
  const theirs=await grouped('',second);assert.equal(theirs.json().data.pagination.total,2);assert.equal(theirs.json().data.membresias.length,1);assert.ok(theirs.json().data.citas.flatMap(row=>row.consumos).every(row=>row.id_suscripcion===foreign));
  for(const query of ['&page=0','&page=x','&limit=6','&id_suscripcion=bad'])assert.equal((await grouped(query)).statusCode,400);
  assert.equal((await call('?agrupar_por=otro')).statusCode,400);assert.equal((await grouped('&id_suscripcion='+foreign)).statusCode,404);
  assert.equal((await grouped('&id_suscripcion='+sub,second)).statusCode,404);assert.equal((await grouped('',token(client,'barbero'))).statusCode,403);assert.equal((await grouped('','invalid')).statusCode,401);
  assert.equal((await app.inject({url:url+'?agrupar_por=cita'})).statusCode,401);
  assert.equal((await grouped('&id_cliente='+other)).json().data.pagination.total,2);
  const legacy=(await call()).json().data;assert.ok(Array.isArray(legacy.consumos));assert.equal('citas' in legacy,false);assert.equal('has_next' in legacy.pagination,false);
  assert.deepEqual(await snapshot(),before);
 });
 await t.test('UX-05: fecha real de cita estable en UTC/Honduras y desempate estable',async()=>{
  await pool.query('TRUNCATE subscription_consumptions,citas');
  const one=await groupInsert(1,{count:1}),two=await groupInsert(1,{count:1});
  const a=(await grouped()).json().data;const clientConnection=await pool.connect();
  try{
   await clientConnection.query("SET timezone='Asia/Tokyo'");
   const {listClienteMembershipConsumptionAppointments}=await import('../src/services/membershipService.js');
   const b=await listClienteMembershipConsumptionAppointments(clientConnection,client);assert.deepEqual(b.citas.map(row=>({key:row.key,inicio_at:row.inicio_at})),a.citas.map(row=>({key:row.key,inicio_at:row.inicio_at})));
  }finally{clientConnection.release();}
  assert.equal(a.citas[0].inicio_at,one.at);assert.equal(one.at,two.at);
  assert.deepEqual(a.citas.map(row=>row.key),[one,two].map(row=>'cita:'+row.appointment).sort().reverse());
  assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Tegucigalpa',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(one.at)),'2030-01-01');
 });

});
