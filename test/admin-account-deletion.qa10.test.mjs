import assert from 'node:assert/strict';
import test from 'node:test';
import { adminModeApp } from './helpers/adminModeApp.mjs';
import routes from '../src/routes/v1/admin/accountDeletion.js';
import { randomUUID } from 'node:crypto';
const ID = '11111111-1111-4111-8111-111111111111';
async function fixture(t,{empty=false,protectedAccount=false,status='pendiente_aprobacion',role='super_admin'}={}) {
 const app=await adminModeApp();t.after(()=>app.close());const calls=[];
 const row={id_solicitud:ID,referencia_publica:'DEL-SYNTHETIC',tipo_sujeto:'personal',modo_proceso:'requiere_aprobacion',requiere_aprobacion:true,estado_codigo:status,id_persona:randomUUID(),id_usuario:randomUUID(),active_roles:['barbero'],nombres:'Persona',apellidos:'Sintetica',resumen_impacto:{},bloqueos_detectados:[]};
 const query=async(sql,params=[])=>{
  calls.push({sql,params});
  if(sql.includes('AS shared_client_identity'))return {rows:[{shared_client_identity:false}]};
  if(sql.includes('public.app_protected_users'))return {rows:protectedAccount?[{}]:[],rowCount:protectedAccount?1:0};
  if(sql.includes('COUNT(*)::int AS total'))return {rows:[{total:empty?0:1}]};
  if(sql.includes('COUNT(*) FILTER'))return {rows:[{}]};
  if(sql.trim().startsWith('UPDATE app_private.solicitudes_eliminacion_cuenta'))return {rows:[{...row,estado_codigo:'rechazada'}],rowCount:1};
  if(sql.includes('FROM app_private.solicitudes_eliminacion_cuenta s'))return {rows:empty?[]:[row],rowCount:empty?0:1};
  return {rows:[],rowCount:0};
 };
 app.decorate('db',{query,connect:async()=>({query,release(){}})});
 app.decorate('requireRoles',allowed=>async(request,reply)=>{request.claims={roles:[role],user:{id_usuario:'22222222-2222-4222-8222-222222222222'}};if(!allowed.includes(role))return reply.code(403).send({error:{code:'ROLE_FORBIDDEN'}});});
 app.decorate('supabaseAdmin',{auth:{getUser:async()=>({error:{status:401},data:{user:null}})}});
 await app.register(routes,{prefix:'/v1/admin/account-deletion'});return {app,calls,row};
}
for(const empty of [true,false])test('listado real con filtros '+(empty?'vacio':'con datos'),async t=>{
 const {app,calls}=await fixture(t,{empty});
 const r=await app.inject({url:'/v1/admin/account-deletion/requests?subject=personal&status=pendiente_aprobacion&search=Sintetica&page=1&limit=20'});
 assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.items.length,empty?0:1);
 assert.deepEqual(calls[0].params,['personal','pendiente_aprobacion','%sintetica%']);
});
test('detalle real y rechazo autorizado conservan controlador',async t=>{
 const {app}=await fixture(t);
 let r=await app.inject({url:'/v1/admin/account-deletion/requests/'+ID});assert.equal(r.statusCode,200,r.body);
 r=await app.inject({method:'POST',url:'/v1/admin/account-deletion/requests/'+ID+'/reject',payload:{comment:'Motivo sintetico autorizado'}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.rejected,true);
});
test('retry terminal es idempotente sin repetir eliminacion',async t=>{
 const {app,calls}=await fixture(t,{status:'completada'});
 const r=await app.inject({method:'POST',url:'/v1/admin/account-deletion/requests/'+ID+'/retry'});assert.equal(r.statusCode,200,r.body);
 assert.equal(calls.filter(x=>/^\s*(UPDATE|DELETE|INSERT)\b/.test(x.sql)).length,0);
});
for(const protectedAccount of [false,true])test('aprobacion mantiene '+(protectedAccount?'proteccion de cuenta':'reautenticacion'),async t=>{
 const {app,calls}=await fixture(t,{protectedAccount});
 const r=await app.inject({method:'POST',url:'/v1/admin/account-deletion/requests/'+ID+'/approve',payload:{reauth_token:'invalid-synthetic-token-only',confirmation_phrase:'APROBAR ELIMINACION DE CUENTA',acknowledge_irreversible_action:true}});
 assert.ok([401,403].includes(r.statusCode),r.body);assert.notEqual(r.json().error?.code,'ADMIN_DATA_ENTRY_RESTRICTED');
 assert.equal(calls.filter(x=>/^\s*(UPDATE|DELETE|INSERT)\b/.test(x.sql)).length,0);
});
for (const role of ['cliente','barbero',null]) {
  for (const action of ['list','detail','approve','reject','retry']) test(`${role || 'anonimo'} no ejecuta ${action}`, async t => {
    const app = await adminModeApp(); t.after(() => app.close());
    app.decorate('requireRoles', allowed => async (request, reply) => {
      request.claims = { roles: role ? [role] : [] };
      if (!role) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } });
      if (!allowed.includes(role)) return reply.code(403).send({ error: { code: 'AUTH_FORBIDDEN' } });
    });
    // AM: Ningún ejecutor ni conexión de eliminación está disponible en esta prueba.
    await app.register(routes, { prefix: '/v1/admin/account-deletion' });
    const read = action === 'list' || action === 'detail';
    const payload = action === 'approve' ? { reauth_token: 'SYNTHETIC_NOT_A_REAL_TOKEN', confirmation_phrase: 'APROBAR ELIMINACION DE CUENTA', acknowledge_irreversible_action: true } : action === 'reject' ? { comment: 'Motivo sintético válido' } : undefined;
    const response = await app.inject({ method: read ? 'GET' : 'POST', url: `/v1/admin/account-deletion/requests${action === 'list' ? '' : `/${ID}${read ? '' : `/${action}`}`}`, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, role ? 403 : 401);
  });
}
test('aprobación sin reautenticación se rechaza por esquema antes del ejecutor', async t => {
  const app = await adminModeApp(); t.after(() => app.close()); app.decorate('requireRoles', () => async request => { request.claims = { roles: ['root'] }; });
  await app.register(routes, { prefix: '/v1/admin/account-deletion' });
  const response = await app.inject({ method: 'POST', url: `/v1/admin/account-deletion/requests/${ID}/approve`, payload: { confirmation_phrase: 'APROBAR ELIMINACION DE CUENTA', acknowledge_irreversible_action: true } });
  assert.equal(response.statusCode, 400);
});
