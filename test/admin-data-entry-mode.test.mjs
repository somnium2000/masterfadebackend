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
import { globalErrorHandler } from '../src/utils/errors.js';

const ID='11111111-1111-4111-8111-111111111111';
async function fixture(t,{enabled=true,role='super_admin',asset=null,identityExists=false}={}){
 const app=Fastify();const state={business:0,auth:0,queries:0};
 app.setErrorHandler(globalErrorHandler);
 await app.register(fp(async a=>{a.decorate('config',{adminDataEntryMode:enabled});},{name:'env-plugin'}));
 app.decorate('db',{async query(sql){state.queries++;if(sql.includes('FROM public.usuarios'))return {rows:identityExists?[{exists:1}]:[]};return {rows:asset?[asset]:[],rowCount:asset?1:0};}});
 app.db.connect=async()=>({query:app.db.query.bind(app.db),release(){}});
 app.decorate('requireRoles',roles=>async(req,reply)=>{state.auth++;req.claims={user:{id_usuario:ID},roles:[role],branch_ids:[]};if(!roles.includes(role))return reply.code(403).send({code:'ROLE_FORBIDDEN'});});
 await app.register(gate);await app.register(cors,{origin:'https://masterfadeapp.com'});
 t.after(()=>app.close());return {app,state};
}
const blocked=[['POST','/v1/public/citas'],['POST','/v1/public/citas/hold'],['POST','/v1/citas/hold'],['POST','/v1/cliente/planes/orden'],['POST','/v1/cliente/planes/pago-intent'],['POST','/v1/cliente/planes/simulator/event'],['POST','/v1/pagos'],['POST','/v1/pagos/reservas'],['POST','/v1/public/pagos/webhook/pixelpay'],['POST','/v1/pagos/webhook/banpais'],['POST','/v1/account-deletion'],['POST','/v1/admin/account-deletion'],['POST','/v1/public/account-deletion'],['POST','/v1/auth/register'],['POST','/v1/auth/register/confirm'],['POST','/v1/auth/register/resend'],['POST','/v1/auth/social/confirm'],['PATCH','/v1/barbero/perfil'],['PATCH','/v1/admin/sucursales/'+ID+'/inactivar'],['DELETE','/v1/admin/personas/usuarios/'+ID+'/permanente'],['POST','/v1/admin/configuracion/promociones'],['POST','/v1/admin/configuracion/comunicacion/campanias/'+ID+'/enviar'],['POST','/v1/admin/seguridad/sesiones/revocar-todas'],['POST','/v1/admin/masterpuntos/legacy-migracion'],['POST','/v1/new-business-route']];
const publicCatalogReads=[
 ['GET','/v1/public/catalog/sucursales'],
 ['GET','/v1/public/catalog/servicios'],
 ['GET','/v1/public/catalog/paquetes'],
 ['GET','/v1/public/catalog/promociones'],
 ['GET','/v1/public/catalog/busqueda'],
 ['GET','/v1/public/agenda/barberos'],
 ['GET','/v1/public/catalog/planes'],
];
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
for(const change of [{scope_key:'public_promotion_main'},{bucket_name:'wrong'},{entity_type:'promocion'},{deleted_at:'2026-01-01'}])test('read-url rejects inconsistent/out-of-scope metadata '+JSON.stringify(change),async t=>{
 const asset={id_asset:ID,scope_key:'public_barber_profile',entity_type:'barbero',bucket_name:'imagenes_publicas',visibility:'public',...change};const {app,state}=await fixture(t,{asset});app.post('/v1/admin/storage/assets/:id/read-url',{preHandler:app.requireRoles(['super_admin'])},async()=>{state.business++;return {ok:true};});const r=await app.inject({method:'POST',url:'/v1/admin/storage/assets/'+ID+'/read-url',payload:{}});assert.equal(r.statusCode,403);assert.equal(state.business,0);
});
test('mode false preserves existing unrestricted route behavior',async t=>{
 const {app}=await fixture(t,{enabled:false});app.post('/v1/pagos',async()=>({ok:true}));assert.equal((await app.inject({method:'POST',url:'/v1/pagos'})).statusCode,200);
});
test('policy is exact, has no wildcard and never includes irreversible or payment routes',()=>{
 assert.equal(new Set(ADMIN_DATA_ENTRY_ROUTES).size,ADMIN_DATA_ENTRY_ROUTES.length);assert.ok(ADMIN_DATA_ENTRY_ROUTES.every(x=>!x.includes('*')&&!x.includes('/permanente')&&!x.includes('/pagos')&&!x.includes('account-deletion')));
});

// AM: Existing Google identities may authenticate; no pending registration/provisioning is initiated.
for(const field of ['supabase_token','access_token','token'])test('exchange existing identity preserves token alias '+field,async t=>{
 const {app,state}=await fixture(t,{identityExists:true});
 const token=jwt.sign({sub:ID,session_id:ID},'synthetic-only',{expiresIn:'1h'});
 app.decorate('supabaseAdmin',{auth:{getUser:async()=>({data:{user:{id:ID,email:'synthetic@example.test'}}})}});
 app.post('/v1/auth/exchange',async()=>{state.business++;return {ok:true};});
 assert.equal((await app.inject({method:'POST',url:'/v1/auth/exchange',payload:{[field]:token}})).statusCode,200);assert.equal(state.business,1);
});
test('exchange without internal identity is blocked before social provisioning',async t=>{
 const {app,state}=await fixture(t);const token=jwt.sign({sub:ID,session_id:ID},'synthetic-only',{expiresIn:'1h'});
 app.decorate('supabaseAdmin',{auth:{getUser:async()=>({data:{user:{id:ID,email:'synthetic@example.test'}}})}});
 app.post('/v1/auth/exchange',async()=>{state.business++;return {ok:true};});
 assert.equal((await app.inject({method:'POST',url:'/v1/auth/exchange',payload:{supabase_token:token}})).statusCode,403);assert.equal(state.business,0);
});
