import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import cors from '@fastify/cors';
import gate, { ADMIN_DATA_ENTRY_ROUTES } from '../src/plugins/adminDataEntry.js';
import personas from '../src/routes/v1/admin/personas.js';
import catalog from '../src/routes/v1/admin/catalog.js';
import plans from '../src/routes/v1/admin/plans.js';
import cortesias from '../src/routes/v1/admin/cortesias.js';
import cliente from '../src/routes/v1/cliente.js';
import citas from '../src/routes/v1/citas.js';
import points from '../src/routes/v1/clientePoints.js';
import publicCitas from '../src/routes/v1/public/citas.js';
import publicPayments from '../src/routes/v1/public/pagos.js';
import payments from '../src/routes/v1/pagos.js';
import adminStorage from '../src/routes/v1/admin/storage.js';
import { globalErrorHandler } from '../src/utils/errors.js';

const ID='11111111-1111-4111-8111-111111111111';
async function fixture(t,{enabled=true,role='super_admin',asset=null,identityExists=false}={}){
 const app=Fastify();const state={business:0,auth:0,queries:0};
 app.setErrorHandler(globalErrorHandler);
 await app.register(fp(async a=>{a.decorate('config',{adminDataEntryMode:enabled,paymentProvider:'disabled'});},{name:'env-plugin'}));
 app.decorate('db',{async query(sql){state.queries++;if(sql.includes('FROM public.usuarios'))return {rows:identityExists?[{exists:1}]:[]};return {rows:asset?[asset]:[],rowCount:asset?1:0};}});
 app.db.connect=async()=>({query:app.db.query.bind(app.db),release(){}});
 app.decorate('requireRoles',roles=>async(req,reply)=>{state.auth++;req.claims={user:{id_usuario:ID},roles:[role],branch_ids:[]};if(!roles.includes(role))return reply.code(403).send({code:'ROLE_FORBIDDEN'});});
 await app.register(gate);await app.register(cors,{origin:'https://masterfadeapp.com'});
 t.after(()=>app.close());return {app,state};
}
const commercialRoutes = [["POST","/v1/public/citas/hold","/v1/public/citas/hold"],["POST","/v1/citas","/v1/citas"],["POST","/v1/citas/hold","/v1/citas/hold"],["POST","/v1/citas/hold/:id_grupo_cita/confirmar","/v1/citas/hold/11111111-1111-4111-8111-111111111111/confirmar"],["POST","/v1/citas/pendiente/:id_grupo_cita/retomar","/v1/citas/pendiente/11111111-1111-4111-8111-111111111111/retomar"],["POST","/v1/cliente/puntos/canjear","/v1/cliente/puntos/canjear"],["POST","/v1/cliente/planes/adquirir","/v1/cliente/planes/adquirir"],["POST","/v1/cliente/planes/orden","/v1/cliente/planes/orden"],["POST","/v1/cliente/planes/pago-intent","/v1/cliente/planes/pago-intent"],["POST","/v1/cliente/planes/confirmar-pago","/v1/cliente/planes/confirmar-pago"],["POST","/v1/cliente/planes/pago-intent/:id_payment_intent/estado","/v1/cliente/planes/pago-intent/11111111-1111-4111-8111-111111111111/estado"],["POST","/v1/cliente/planes/simulator/event","/v1/cliente/planes/simulator/event"]];
for(const prefix of ['/v1/public/pagos','/v1/pagos/reservas']) {
 for(const suffix of ['/crear-intent','/pixelpay/sale','/pixelpay/status','/estado','/mock-completar','/simulator/event']) commercialRoutes.push(['POST',prefix+suffix,prefix+suffix]);
}
commercialRoutes.push(['POST','/v1/pagos/crear-intent','/v1/pagos/crear-intent']);
const blocked = commercialRoutes.map(([method, , url]) => [method, url]);
const publicCatalogReads=[
 ['GET','/v1/public/catalog/sucursales'],
 ['GET','/v1/public/catalog/servicios'],
 ['GET','/v1/public/catalog/paquetes'],
 ['GET','/v1/public/catalog/promociones'],
 ['GET','/v1/public/catalog/busqueda'],
 ['GET','/v1/public/agenda/barberos'],
 ['GET','/v1/public/catalog/planes'],
];
test('real commercial controllers reject every registered blocked operation before auth or database effects',async t=>{
 const {app,state}=await fixture(t,{role:'cliente'});
 await app.register(cliente,{prefix:'/v1/cliente'});
 await app.register(citas,{prefix:'/v1/citas'});
 await app.register(points,{prefix:'/v1/cliente/puntos'});
 await app.register(publicCitas,{prefix:'/v1/public/citas'});
 await app.register(publicPayments,{prefix:'/v1/public/pagos'});
 await app.register(publicPayments,{prefix:'/v1/pagos/reservas',authenticated:true});
 await app.register(payments,{prefix:'/v1/pagos'});
 await app.ready();
 for(const [method,template,url]of commercialRoutes){
  assert.ok(app.hasRoute({method,url:template}), method+' '+template+' must be registered');
  const response=await app.inject({method,url,payload:{id_servicio:ID,id_sucursal:ID,usar_puntos:true}});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(response.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');
 }
 assert.equal(state.auth,0);assert.equal(state.queries,0);assert.equal(state.business,0);
});
test('approved public catalog reads bypass only the administrative-mode guard',async t=>{
 const {app,state}=await fixture(t);
 for(const [method,url]of publicCatalogReads)app.route({method,url,handler:async()=>{state.business++;return {ok:true};}});
 for(const [method,url]of publicCatalogReads){const r=await app.inject({method,url});assert.equal(r.statusCode,200,r.body);}
 assert.equal(state.business,publicCatalogReads.length);
});
test('public catalog GET allowlist does not grant write methods or path variants',async t=>{
 const {app,state}=await fixture(t);
 for(const method of ['POST','PATCH','PUT','DELETE'])app.route({method,url:'/v1/public/catalog/servicios',handler:async()=>{state.business++;return {ok:true};}});
 app.get('/v1/public/catalog/servicios/extra',async()=>{state.business++;return {ok:true};});
 for(const method of ['POST','PATCH','PUT','DELETE']){const r=await app.inject({method,url:'/v1/public/catalog/servicios',payload:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');}
 const suffix=await app.inject({url:'/v1/public/catalog/servicios/extra'});assert.equal(suffix.statusCode,403,suffix.body);assert.equal(suffix.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');
 assert.equal(state.business,0);
});
test('booking availability and commercial public operations remain blocked',async t=>{
 const {app,state}=await fixture(t);
 const restricted=[['GET','/v1/public/agenda/disponibilidad'],['GET','/v1/public/agenda/horarios'],['POST','/v1/public/citas'],['POST','/v1/public/pagos/webhook/pixelpay']];
 for(const [method,url]of restricted)app.route({method,url,handler:async()=>{state.business++;return {ok:true};}});
 for(const [method,url]of restricted){const r=await app.inject({method,url,payload:method==='GET'?undefined:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');}
 assert.equal(state.business,0);
});
// AM: Block registered business routes before even their auth hook, including privileged callers.
for(const role of ['super_admin','admin','root','cliente'])test('deny-by-default overrides role '+role,async t=>{
 const {app,state}=await fixture(t,{role});
 for(const [method,url]of blocked)app.route({method,url,preHandler:async()=>{state.auth++;},handler:async()=>{state.business++;return {ok:true};}});
 for(const [method,url]of blocked){const r=await app.inject({method,url,payload:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');}
 assert.equal(state.business,0);assert.equal(state.auth,0);assert.equal(state.queries,0);
});
test('unmatched paths, alternative methods and encoded suffix cannot open an endpoint',async t=>{
 const {app}=await fixture(t);app.post('/v1/admin/personas/clientes',async()=>({ok:true}));
 for(const url of ['/other','/v1/admin/personas/clientes/extra','/v1/admin/personas/clientes%2fextra'])assert.equal((await app.inject({url})).statusCode,403);
 assert.equal((await app.inject({method:'DELETE',url:'/v1/admin/personas/clientes'})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/v1/admin/personas/clientes',headers:{'x-http-method-override':'DELETE'},payload:{}})).statusCode,403);
});
test('CORS preflight stays available without invoking a business handler',async t=>{
 const {app,state}=await fixture(t);const r=await app.inject({method:'OPTIONS',url:'/v1/auth/login',headers:{origin:'https://masterfadeapp.com','access-control-request-method':'POST'}});assert.equal(r.statusCode,204);assert.equal(state.business,0);
});
// AM: Exercise productive administrative controllers with isolated SQL mocks and unchanged role guards.
for(const [plugin,prefix,paths]of [[personas,'/v1/admin/personas',['/clientes','/empleados','/usuarios']],[catalog,'/v1/admin/catalog',['/servicios','/paquetes']],[plans,'/v1/admin/catalog/planes',['']],[cortesias,'/v1/admin/catalog/cortesias',['']]])test('administrative controllers remain available '+prefix,async t=>{
 const {app,state}=await fixture(t);await app.register(plugin,{prefix});
 for(const suffix of paths){const r=await app.inject({url:prefix+suffix});assert.equal(r.statusCode,200,r.body);}
 assert.ok(state.auth>0);assert.ok(state.queries>0);
});
test('original role restrictions are not granted by the allowlist',async t=>{
 const {app}=await fixture(t,{role:'cliente'});await app.register(personas,{prefix:'/v1/admin/personas'});const r=await app.inject({url:'/v1/admin/personas/clientes'});assert.equal(r.statusCode,403);assert.equal(r.json().code,'ROLE_FORBIDDEN');
});
for(const prefix of ['/v1/admin/citas','/v1/admin/membresias'])test('administrative operation remains available '+prefix,async t=>{
 const {app,state}=await fixture(t);app.post(prefix+'/probe',{preHandler:app.requireRoles(['super_admin','admin'])},async()=>{state.business++;return {ok:true};});
 const r=await app.inject({method:'POST',url:prefix+'/probe',payload:{}});assert.equal(r.statusCode,200,r.body);assert.equal(state.auth,1);assert.equal(state.business,1);
});
const restoredAdminRoutes=[
 ['GET','/v1/admin/super-dashboard/summary'],['GET','/v1/admin/reportes/dashboard'],
 ['GET','/v1/admin/seguridad/usuarios'],['GET','/v1/admin/masterpuntos/contexto'],
 ['GET','/v1/admin/puntos/regalias'],['POST','/v1/admin/puntos/clientes/:id_cliente/ajuste','/v1/admin/puntos/clientes/'+ID+'/ajuste'],
 ['GET','/v1/admin/configuracion/promociones'],
];
test('approved administrative modules reach existing role guards and handlers',async t=>{
 const {app,state}=await fixture(t);for(const [method,route]of restoredAdminRoutes)app.route({method,url:route,preHandler:app.requireRoles(['super_admin','admin']),handler:async()=>{state.business++;return {ok:true};}});
 for(const [method,route,url=route]of restoredAdminRoutes){const r=await app.inject({method,url,payload:method==='GET'?undefined:{}});assert.equal(r.statusCode,200,r.body);}
 assert.equal(state.auth,restoredAdminRoutes.length);assert.equal(state.business,restoredAdminRoutes.length);
});
test('client role remains rejected from restored administrative modules',async t=>{
 const {app,state}=await fixture(t,{role:'cliente'});for(const [method,route]of restoredAdminRoutes)app.route({method,url:route,preHandler:app.requireRoles(['super_admin','admin']),handler:async()=>{state.business++;return {ok:true};}});
 for(const [method,route,url=route]of restoredAdminRoutes){const r=await app.inject({method,url,payload:method==='GET'?undefined:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().code,'ROLE_FORBIDDEN');}
 assert.equal(state.auth,restoredAdminRoutes.length);assert.equal(state.business,0);
});
for(const prefix of ['/v1/admin/citas','/v1/admin/membresias'])test('administrative operation keeps role protection '+prefix,async t=>{
 const {app,state}=await fixture(t,{role:'cliente'});app.post(prefix+'/probe',{preHandler:app.requireRoles(['super_admin','admin'])},async()=>{state.business++;return {ok:true};});
 const r=await app.inject({method:'POST',url:prefix+'/probe',payload:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().code,'ROLE_FORBIDDEN');assert.equal(state.auth,1);assert.equal(state.business,0);
});
for(const scope of ['public_promotion_main','public_branding','public_gallery_item','arbitrary'])test('unapproved Storage scope cannot reach business '+scope,async t=>{
 const {app,state}=await fixture(t);app.post('/v1/admin/storage/uploads/prepare',{preHandler:app.requireRoles(['super_admin'])},async()=>{state.business++;return {ok:true};});
 const r=await app.inject({method:'POST',url:'/v1/admin/storage/uploads/prepare',payload:{scope_key:scope,entity_type:'barbero'}});assert.equal(r.statusCode,403);assert.equal(state.business,0);
});
test('approved photograph preserves auth and permits its business handler',async t=>{
 const {app,state}=await fixture(t);app.post('/v1/admin/storage/uploads/prepare',{preHandler:app.requireRoles(['super_admin'])},async()=>{state.business++;return {ok:true};});
 const r=await app.inject({method:'POST',url:'/v1/admin/storage/uploads/prepare',payload:{scope_key:'public_barber_profile',entity_type:'barbero'}});assert.equal(r.statusCode,200);assert.equal(state.business,1);assert.equal(state.auth,1);
});
for(const scope of ['public_promotion_main','public_promotion_mobile'])test('promotion image scope reaches real storage controller '+scope,async t=>{
 const {app}=await fixture(t);let calls=0;
 const original=app.db.query;app.db.query=async(sql,params)=>{
  if(sql.includes('INSERT INTO public.storage_assets'))return {rows:[{id_asset:ID}]};
  return original(sql,params);
 };
 app.decorate('supabaseAdmin',{storage:{from:()=>({getPublicUrl:()=>({data:{publicUrl:'https://synthetic.invalid/photo'}}),createSignedUploadUrl:async()=>{calls++;return {data:{token:'synthetic'}};}})}});
 await app.register(adminStorage,{prefix:'/v1/admin/storage'});
 const r=await app.inject({method:'POST',url:'/v1/admin/storage/uploads/prepare',payload:{scope_key:scope,entity_type:'promocion',id_sucursal:ID,file_name:'photo.webp',content_type:'image/webp',size_bytes:128}});
 assert.equal(r.statusCode,201,r.body);assert.equal(calls,1);
});
test('promotion image read and delete retain real storage checks',async t=>{
 const asset={id_asset:ID,scope_key:'public_promotion_main',entity_type:'promocion',bucket_name:'imagenes_publicas',visibility:'public',public_url:'https://synthetic.invalid/photo',object_path:'synthetic/photo',id_sucursal:ID};
 const {app}=await fixture(t,{asset});let removed=0;
 app.db.query=async sql=>sql.includes('SELECT 1')?{rows:[],rowCount:0}:{rows:[asset],rowCount:1};
 app.decorate('supabaseAdmin',{storage:{from:()=>({remove:async()=>{removed++;return {error:null};}})}});
 await app.register(adminStorage,{prefix:'/v1/admin/storage'});
 const read=await app.inject({method:'POST',url:'/v1/admin/storage/assets/'+ID+'/read-url',payload:{}});assert.equal(read.statusCode,200,read.body);
 const deleted=await app.inject({method:'DELETE',url:'/v1/admin/storage/assets/'+ID});assert.equal(deleted.statusCode,200,deleted.body);assert.equal(removed,1);
});
for(const change of [{scope_key:'public_promotion_main'},{bucket_name:'wrong'},{entity_type:'promocion'},{deleted_at:'2026-01-01'}])test('read-url rejects inconsistent/out-of-scope metadata '+JSON.stringify(change),async t=>{
 const asset={id_asset:ID,scope_key:'public_barber_profile',entity_type:'barbero',bucket_name:'imagenes_publicas',visibility:'public',...change};const {app,state}=await fixture(t,{asset});app.post('/v1/admin/storage/assets/:id/read-url',{preHandler:app.requireRoles(['super_admin'])},async()=>{state.business++;return {ok:true};});const r=await app.inject({method:'POST',url:'/v1/admin/storage/assets/'+ID+'/read-url',payload:{}});assert.equal(r.statusCode,403);assert.equal(state.business,0);
});
test('mode false preserves existing unrestricted route behavior',async t=>{
 const {app}=await fixture(t,{enabled:false});app.post('/v1/pagos',async()=>({ok:true}));assert.equal((await app.inject({method:'POST',url:'/v1/pagos'})).statusCode,200);
});
test('policy is exact, has no wildcard and never includes irreversible or payment routes',()=>{
 assert.equal(new Set(ADMIN_DATA_ENTRY_ROUTES).size,ADMIN_DATA_ENTRY_ROUTES.length);assert.ok(ADMIN_DATA_ENTRY_ROUTES.every(x=>!x.includes('*')&&!x.includes('/permanente')&&!x.includes('/pagos')));
});

// AM: Existing Google identities may authenticate; no pending registration/provisioning is initiated.
for(const field of ['supabase_token','access_token','token'])test('exchange existing identity preserves token alias '+field,async t=>{
 const {app,state}=await fixture(t,{identityExists:true});
 const token=jwt.sign({sub:ID,session_id:ID},'synthetic-only',{expiresIn:'1h'});
 app.decorate('supabaseAdmin',{auth:{getUser:async()=>({data:{user:{id:ID,email:'synthetic@example.test'}}})}});
 app.post('/v1/auth/exchange',async()=>{state.business++;return {ok:true};});
 assert.equal((await app.inject({method:'POST',url:'/v1/auth/exchange',payload:{[field]:token}})).statusCode,200);assert.equal(state.business,1);
});
test('exchange without internal identity reaches the original controller',async t=>{
 const {app,state}=await fixture(t);const token=jwt.sign({sub:ID,session_id:ID},'synthetic-only',{expiresIn:'1h'});
 app.decorate('supabaseAdmin',{auth:{getUser:async()=>({data:{user:{id:ID,email:'synthetic@example.test'}}})}});
 app.post('/v1/auth/exchange',async()=>{state.business++;return {ok:true};});
 assert.equal((await app.inject({method:'POST',url:'/v1/auth/exchange',payload:{supabase_token:token}})).statusCode,200);assert.equal(state.business,1);
});
