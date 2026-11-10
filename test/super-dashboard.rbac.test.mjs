import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import auth from '../src/plugins/auth.js';
import routes from '../src/routes/v1/admin/superDashboard.js';

process.env.JWT_SECRET=randomBytes(48).toString('hex');
const USER=randomUUID(),SID=randomUUID(),JTI=randomUUID();
async function fixture(t,roles){
 const app=Fastify();let metrics=0;const state={roles};
 app.decorate('db',{query:async sql=>{
  if(sql.includes('WITH base_user'))return {rows:[{id_usuario:USER,roles:state.roles,branch_ids:[]}]};
  if(sql.includes('token_jti_hash = $3'))return {rows:[{estado:'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:null}]};
  if(sql.includes('WITH RECURSIVE range_config')){metrics++;return {rows:[{total_citas:4}]};}
  return {rows:[],rowCount:0};
 }});
 if(process.env.ADMIN_DATA_ENTRY_MODE==='true'){
  assert.equal(process.env.PAYMENT_PROVIDER,'disabled');
  await app.register(fp(async a=>{a.decorate('config',{adminDataEntryMode:true,paymentProvider:'disabled'});},{name:'env-plugin'}));
  const {default:gate}=await import('../src/plugins/adminDataEntry.js');
  await app.register(gate);
 }
 await app.register(cookie);await app.register(auth);await app.register(routes,{prefix:'/v1/admin/super-dashboard'});
 t.after(()=>app.close());
 const token=jwt.sign({sub:USER,sid:SID,jti:JTI,token_type:'app',roles:['super_admin']},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});
 return {app,state,token,metrics:()=>metrics};
}
for(const roles of [['super_admin'],['admin','super_admin'],['admin'],['admin','barbero'],['cliente'],['barbero'],['root'],['security_admin'],['security_auditor']])test('guard real dashboard '+roles.join('+'),async t=>{
 const f=await fixture(t,roles);const allowed=roles.includes('super_admin');
 const r=await f.app.inject({url:'/v1/admin/super-dashboard/summary?roles=super_admin',headers:{cookie:'mf_session='+f.token,'x-role':'super_admin','x-roles':'super_admin'}});
 assert.equal(r.statusCode,allowed?200:403,r.body);assert.equal(f.metrics(),allowed?1:0);
});
for(const token of [null,'invalid-session'])test('sin sesion valida '+token,async t=>{
 const f=await fixture(t,['super_admin']);const r=await f.app.inject({url:'/v1/admin/super-dashboard/summary',headers:token?{cookie:'mf_session='+token}:{}});
 assert.equal(r.statusCode,401,r.body);assert.equal(f.metrics(),0);
});
test('retirar super_admin de claims persistidos revoca acceso con la misma cookie',async t=>{
 const f=await fixture(t,['admin','super_admin']);
 assert.equal((await f.app.inject({url:'/v1/admin/super-dashboard/summary',headers:{cookie:'mf_session='+f.token}})).statusCode,200);
 f.state.roles=['admin','barbero'];
 const r=await f.app.inject({method:'GET',url:'/v1/admin/super-dashboard/summary?role=super_admin',headers:{cookie:'mf_session='+f.token,'content-type':'application/json'},payload:JSON.stringify({roles:['super_admin']})});
 assert.equal(r.statusCode,403,r.body);assert.equal(f.metrics(),1);
});
