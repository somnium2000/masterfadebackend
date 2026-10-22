import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import authRoutes from '../src/routes/v1/auth.js';
import authPlugin from '../src/plugins/auth.js';
import security from '../src/plugins/security.js';
import { globalErrorHandler } from '../src/utils/errors.js';
import { acquirePasswordOperationLock, generateRecoveryActionLink } from '../src/services/authRecovery.js';

process.env.FRONTEND_URL='http://127.0.0.1:5189';
process.env.SUPABASE_URL='http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY='synthetic-public-key';
process.env.JWT_SECRET=randomBytes(40).toString('hex');
process.env.CSRF_SECRET=randomBytes(40).toString('hex');
const USER=randomUUID(), OTHER=randomUUID(), HASH='a'.repeat(64), SID=randomUUID(), JTI=randomUUID();
const body={token_hash:HASH,contrasena:'ChangedOnly9!',confirmar_contrasena:'ChangedOnly9!'};
const syntheticSession=()=>jwt.sign({sub:USER,sid:SID,jti:JTI,token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});

async function fixture(t,options={}){
 let consumed=false,password='BeforeOnly9!',revoked=false,updates=0,delivered=0,verifies=0;const queues=new Map();
 const calls=[],actions=[],providerCalls=[];let generated;
 const query=async(sql,params=[])=>{
  const q=sql.replace(/\s+/g,' ').trim();calls.push({q,params});
  if(q.startsWith('SELECT pg_advisory_')||q==='BEGIN'||q==='ROLLBACK')return {rows:[{}],rowCount:1};
  if(q.startsWith('UPDATE public.seguridad_sesiones')&&q.includes("motivo_cierre = 'password_reset'")){
   actions.push('revoke');if(options.dbFail)throw Error('SQL private diagnostic');assert.equal(params[0],USER);revoked=true;return {rows:[{id_sesion:SID}],rowCount:1};
  }
  if(q.includes('token_jti_hash = $3'))return {rows:[{estado:revoked?'revocada':'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:revoked?new Date():null}]};
  if(q.includes('WITH base_user'))return {rows:[{id_usuario:USER,roles:['cliente'],branch_ids:[]}]};
  if(q.includes('FROM public.usuarios'))return {rows:[{id_usuario:USER,estado_acceso:'activo'}],rowCount:1};
  if(q.includes('COUNT('))return {rows:[{total:0}]};
  if(q.startsWith('UPDATE public.usuarios'))return {rows:[{estado_acceso:'activo'}],rowCount:1};
  if(q.includes('FROM public.personas'))return {rows:[]};
  if(q.includes('app_protected_users'))return {rows:[]};
  if(q.includes('seguridad_'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:0};
 };
 const connect=async()=>{let unlock;return {query:async(q,p)=>{
  if(q.includes('pg_advisory_xact_lock(')){const old=queues.get(p[0]);queues.set(p[0],new Promise(r=>unlock=r));await old;}
  if(q==='ROLLBACK'){unlock?.();unlock=null;}
  return query(q,p);
 },release(){unlock?.();}};};
 const app=Fastify({logger:false});app.setErrorHandler(globalErrorHandler);
 app.decorate('db',{query,connect});app.decorate('config',{corsOrigins:[process.env.FRONTEND_URL],cookieSecret:randomBytes(32).toString('hex')});
 app.decorate('supabaseAdmin',{auth:{admin:{
  generateLink:async input=>{generated=input;return options.missing?{error:{code:'user_not_found'}}:{data:{properties:{hashed_token:HASH,action_link:'https://synthetic.invalid/auth/v1/verify?type=recovery&token='+HASH}}};},
  updateUserById:async(id,attrs)=>{actions.push('update');assert.equal(id,USER);updates++;if(options.beforeUpdate)await options.beforeUpdate();if(options.updateFail)return {error:{status:503}};password=attrs.password;if(options.updateTimeout)throw Error('ambiguous provider timeout');return {data:{user:{id:USER}}};},
 }}});
 app.decorate('mailer',{configured:true,sendPasswordRecoveryEmail:async message=>{delivered++;providerCalls.push(message);if(options.smtpThrow)throw Error('SMTP private diagnostic');return {sent:!options.smtpFail};}});
 app.decorate('supabase',{auth:{signInWithPassword:async({password:p})=>p===password?{data:{user:{id:USER,email:'qa02i@example.test'}}}:{error:{status:401}}}});
 const prior=globalThis.fetch;globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  assert.equal(url.origin,process.env.SUPABASE_URL,'No external transport');
  if(url.pathname==='/auth/v1/verify'){
   verifies++;const p=JSON.parse(init.body);assert.equal(p.type,'recovery');
   if(consumed||options.invalid||p.token_hash!==HASH)return new Response(JSON.stringify({code:'otp_expired',msg:'Invalid or expired'}),{status:403,headers:{'content-type':'application/json'}});
   consumed=true;return new Response(JSON.stringify({access_token:'synthetic-only',refresh_token:'synthetic-only',expires_in:3600,token_type:'bearer',user:{id:USER,email:'qa02i@example.test'}}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url.pathname==='/auth/v1/logout'){actions.push('provider-logout');return new Response(null,{status:options.signOutFail?503:204});}
  throw Error('Unexpected Auth call '+url.pathname);
 };
 if(options.security)await app.register(security);else await app.register(cookie);
 await app.register(authPlugin);await app.register(authRoutes,{prefix:'/v1/auth'});
 app.get('/probe',{preHandler:app.authenticate},async()=>({ok:true}));await app.ready();
 t.after(async()=>{await app.close();globalThis.fetch=prior;});
 return {app,calls,actions,providerCalls,get generated(){return generated;},state:()=>({password,revoked,updates,delivered,verifies,consumed}),reset:p=>app.inject({method:'POST',url:'/v1/auth/reset-password',payload:p||body})};
}

test('redirect y prueba nativa del correo público llegan a reset-password, no a login',async t=>{
 const f=await fixture(t);const r=await f.app.inject({method:'POST',url:'/v1/auth/forgot-password',payload:{email:'qa02i@example.test'}});
 assert.equal(r.statusCode,200);assert.equal(new URL(f.providerCalls[0].actionLink).pathname,'/reset-password');
 assert.equal(new URL(f.generated.options.redirectTo).pathname,'/reset-password');
 assert.ok(new URL(f.providerCalls[0].actionLink).hash.includes('token_hash='));assert.doesNotMatch(r.body,/token_hash|synthetic.invalid/);
});
test('reset validado en servidor revoca sesiones previas y no acepta un UUID de destino',async t=>{
 const f=await fixture(t);assert.equal((await f.app.inject({url:'/probe',headers:{cookie:'mf_session='+syntheticSession()}})).statusCode,200);
 const r=await f.reset();assert.equal(r.statusCode,200,r.body);assert.equal(f.state().password,body.contrasena);assert.ok(f.state().revoked);
 assert.equal((await f.app.inject({url:'/probe',headers:{cookie:'mf_session='+syntheticSession()}})).statusCode,401);
 assert.equal((await f.reset({...body,id_usuario:OTHER})).statusCode,400);
});

export { fixture, body, USER, HASH, generateRecoveryActionLink };

test('capacidad de locks reserva conexiones y libera cupo tras finalizar',async t=>{
 const f=await fixture(t);f.app.db.options={max:2};const lock=await acquirePasswordOperationLock(f.app,'one@example.test');
 await assert.rejects(acquirePasswordOperationLock(f.app,'two@example.test'),e=>e.statusCode===503);await lock.release();
 const again=await acquirePasswordOperationLock(f.app,'two@example.test');await again.release();
 assert.ok(f.calls.some(c=>c.q==="SET LOCAL lock_timeout = '3s'"));
});
test('control: update Auth externo sin coordinación no revoca por sí solo mf_session',async t=>{
 const f=await fixture(t);await f.app.supabaseAdmin.auth.admin.updateUserById(USER,{password:'ExternalOnly9!'});
 assert.equal((await f.app.inject({url:'/probe',headers:{cookie:'mf_session='+syntheticSession()}})).statusCode,200);
 assert.equal((await f.reset()).statusCode,200);assert.equal((await f.app.inject({url:'/probe',headers:{cookie:'mf_session='+syntheticSession()}})).statusCode,401);
});

for(const invalid of [{...body,token_hash:'b'.repeat(64)},{...body,contrasena:'weak',confirmar_contrasena:'weak'},
 {...body,confirmar_contrasena:'Different9!'},{...body,id_usuario:OTHER},{...body,access_token:'ordinary'},
 {access_token:'ordinary',contrasena:body.contrasena,confirmar_contrasena:body.contrasena}])test('payload inválido no modifica contraseña/sesiones '+JSON.stringify(Object.keys(invalid)),async t=>{
 const f=await fixture(t);const r=await f.reset(invalid);assert.ok([400,401].includes(r.statusCode),r.body);assert.equal(f.state().updates,0);assert.equal(f.state().revoked,false);
});
test('enlace expirado/reutilizado: rechazo sin una segunda modificación',async t=>{
 const expired=await fixture(t,{invalid:true});assert.equal((await expired.reset()).statusCode,401);assert.equal(expired.state().updates,0);
 const valid=await fixture(t);assert.equal((await valid.reset()).statusCode,200);assert.equal((await valid.reset()).statusCode,401);assert.equal(valid.state().updates,1);
});
test('dos confirmaciones concurrentes consumen el OTP una sola vez',async t=>{
 const f=await fixture(t);const replies=await Promise.all([f.reset(),f.reset()]);assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,401]);assert.equal(f.state().updates,1);
});
for(const option of ['dbFail','updateFail','updateTimeout','signOutFail'])test('fallo parcial seguro '+option,async t=>{
 const f=await fixture(t,{[option]:true});const r=await f.reset();assert.equal(r.statusCode,503,r.body);assert.doesNotMatch(r.body,/SQL|diagnostic|timeout|synthetic/);
 if(option==='dbFail'){assert.equal(f.state().updates,0);assert.equal(f.state().password,'BeforeOnly9!');}
 else{assert.equal(f.state().revoked,true);assert.equal((await f.app.inject({url:'/probe',headers:{cookie:'mf_session='+syntheticSession()}})).statusCode,401);}
});
test('cookie de otra identidad no autoriza ni cambia su contraseña',async t=>{
 const f=await fixture(t);const other=jwt.sign({sub:OTHER,sid:SID,jti:JTI,token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});
 const r=await f.app.inject({method:'POST',url:'/v1/auth/reset-password',headers:{cookie:'mf_session='+other},payload:body});
 assert.equal(r.statusCode,409);assert.equal(f.state().updates,0);assert.equal(f.state().revoked,false);
});
test('login con contraseña anterior queda fuera del intervalo de reset',async t=>{
 let reached,release;const entered=new Promise(r=>reached=r),wait=new Promise(r=>release=r);
 const f=await fixture(t,{beforeUpdate:async()=>{reached();await wait;}});
 const reset=f.reset();await entered;let loginDone=false;
 const login=f.app.inject({method:'POST',url:'/v1/auth/login',payload:{identifier:'qa02i@example.test',contrasena:'BeforeOnly9!'}}).then(r=>{loginDone=true;return r;});
 await new Promise(r=>setTimeout(r,20));assert.equal(loginDone,false);release();assert.equal((await reset).statusCode,200);assert.equal((await login).statusCode,401);
 assert.ok(f.calls.some(c=>c.q.includes('pg_advisory_xact_lock')&&c.params[0]==='password-operation:qa02i@example.test'));
});
for(const options of [{missing:true},{smtpFail:true},{smtpThrow:true}])test('forgot neutral sin exposición '+JSON.stringify(options),async t=>{
 const f=await fixture(t,options);const r=await f.app.inject({method:'POST',url:'/v1/auth/forgot-password',payload:{email:randomUUID()+'@example.test'}});
 assert.equal(r.statusCode,200,r.body);assert.match(r.json().data.message,/Si el correo existe/);assert.doesNotMatch(r.body,/SQL|SMTP|token_hash/);
});
test('rate limits reales de forgot y reset rechazan repeticiones',async t=>{
 const f=await fixture(t,{security:true,invalid:true});
 for(let i=0;i<10;i++)assert.equal((await f.reset()).statusCode,401);
 assert.equal((await f.reset()).statusCode,429);assert.equal(f.state().verifies,10);
 const email=randomUUID()+'@example.test';for(let i=0;i<3;i++)assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/forgot-password',payload:{email}})).statusCode,200);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/forgot-password',payload:{email}})).statusCode,429);
});
test('uso administrativo de generateRecoveryActionLink conserva contrato previo',async t=>{
 const f=await fixture(t);const result=await generateRecoveryActionLink(f.app,'admin-test@example.test');
 assert.equal(new URL(f.generated.options.redirectTo).pathname,'/login');assert.match(result.action_link,/synthetic.invalid/);
});
