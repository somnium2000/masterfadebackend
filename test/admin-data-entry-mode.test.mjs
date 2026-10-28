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
const blocked=[['POST','/v1/public/citas'],['POST','/v1/pagos'],['POST','/v1/pagos/reservas'],['POST','/v1/public/pagos/webhook/pixelpay'],['POST','/v1/pagos/webhook/banpais'],['POST','/v1/admin/membresias'],['POST','/v1/account-deletion'],['POST','/v1/admin/account-deletion'],['POST','/v1/public/account-deletion'],['POST','/v1/auth/register'],['POST','/v1/auth/register/confirm'],['POST','/v1/auth/register/resend'],['POST','/v1/auth/social/confirm'],['PATCH','/v1/barbero/perfil'],['PATCH','/v1/admin/sucursales/'+ID+'/inactivar'],['DELETE','/v1/admin/personas/usuarios/'+ID+'/permanente'],['POST','/v1/admin/configuracion/promociones'],['POST','/v1/new-business-route']];
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
