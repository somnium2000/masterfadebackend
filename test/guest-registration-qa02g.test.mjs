import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import security from '../src/plugins/security.js';
import { globalErrorHandler } from '../src/utils/errors.js';
import authRoutes from '../src/routes/v1/auth.js';
import { guestFixture } from './helpers/guestRegistrationDb.mjs';

process.env.FRONTEND_URL='http://127.0.0.1:5181';
process.env.JWT_SECRET=randomBytes(48).toString('hex');
process.env.CSRF_SECRET=randomBytes(48).toString('hex');
const data={nombres:'New',apellidos:'Owner',contrasena:'FinalOnly9!',confirmar_contrasena:'FinalOnly9!',acepta_terminos:true,consentimiento_marketing:false};
async function setup(t, options={}) {
  const f=guestFixture(options), app=Fastify({logger:false});
  app.decorate('db',f.db);app.decorate('supabaseAdmin',f.app.supabaseAdmin);app.decorate('mailer',f.app.mailer);
  app.decorate('supabase',{auth:{signInWithPassword:async({email,password})=>{
    const entry=[...f.auth].find(([id,u])=>u.email===email&&f.passwords.get(id)===password);
    return entry?{data:{user:{id:entry[0]}}}:{error:{status:401}};
  }}});
  if(options.security){
    app.setErrorHandler(globalErrorHandler);
    app.decorate('config',{corsOrigins:['http://127.0.0.1:5187'],cookieSecret:randomBytes(32).toString('hex')});
    await app.register(security);
    app.post('/v1/qa02h-private-probe',async()=>({ok:true}));
  }else await app.register(cookie);
  app.decorate('authenticate',async()=>{});await app.register(authRoutes,{prefix:'/v1/auth'});await app.ready();t.after(()=>app.close());
  return {...f,server:app,post:(url,payload)=>app.inject({method:'POST',url:'/v1/auth/register'+url,payload})};
}
async function start(f){const r=await f.post('',{...data,email:f.email,contrasena:'InitialDiscarded9!',confirmar_contrasena:'InitialDiscarded9!'});assert.equal(r.statusCode,202,r.body);return f.proof();}
test('nuevo correo conserva Registro normal y Cliente global',async t=>{
 const f=await setup(t,{free:true});const r=await f.post('',{...data,email:f.email});assert.equal(r.statusCode,201,r.body);
 assert.equal(f.state().users.length,1);assert.deepEqual(f.state().roles.map(x=>x.role),['cliente']);assert.equal(f.state().clients[0].marketing,false);
});
test('histórico: 202 sin Auth, sin password persistida y sin sesión; GET no confirma',async t=>{
 const f=await setup(t);await start(f);assert.equal(f.auth.size,0);assert.equal(f.state().users.length,0);
 assert.ok(!JSON.stringify(f.state()).includes('InitialDiscarded9!'));assert.match(f.state().operation.token_hash,/^[a-f0-9]{64}$/);
 const get=await f.server.inject('/v1/auth/register/confirm');assert.equal(get.statusCode,404);
});
test('confirmación válida: Persona propia, correo reasignado, solo Cliente, términos y marketing FALSE',async t=>{
 const f=await setup(t);const proof=await start(f);const r=await f.post('/confirm',{...proof,...data});assert.equal(r.statusCode,200,r.body);
 const s=f.state();assert.equal(s.operation.state,'completed');assert.equal(s.personas.length,2);
 assert.notEqual(s.users[0].persona,f.oldPersona);assert.equal(s.personas[0].id_persona,f.oldPersona);
 assert.equal(s.contact.id_persona,s.users[0].persona);assert.equal(s.contact.verificado,true);
 assert.equal(s.clients[0].terms,true);assert.equal(s.clients[0].marketing,false);assert.deepEqual(s.roles.map(x=>x.role),['cliente']);
 assert.equal(f.passwords.get(s.operation.auth_user_id),data.contrasena);assert.equal(r.headers['set-cookie'],undefined);
 assert.equal(JSON.stringify(f.calls).includes(data.contrasena),false);assert.equal(s.operation.email,null);
 assert.ok(!f.calls.some(x=>/UPDATE public\.(citas|citas_grupos|citas_integrantes)|DELETE/.test(x.q)));
});
for(const contact of [{has_user:true},{has_client:true},{has_employee:true},{has_branch:true},{deleted_at:'deleted'},
 {persona_deleted:'deleted'},{persona_exists:null}])test('conflicto seguro '+JSON.stringify(contact),async t=>{
 const f=await setup(t,{contact});const r=await f.post('',{...data,email:f.email});assert.equal(r.statusCode,409);assert.equal(f.auth.size,0);
 assert.equal(f.emails.length,0);assert.ok(!r.body.includes('id_persona'));
});
test('verificado no sustituye identidad ni la nueva prueba de buzón',async t=>{
 const f=await setup(t,{contact:{verificado:true}});await start(f);assert.equal(f.auth.size,0);assert.equal(f.state().users.length,0);
});
for(const options of [{authExists:true},{multiple:true},{unsafeHistory:true}])test('bloquea Auth huérfano, múltiples o historial insuficiente '+JSON.stringify(options),async t=>{
 const f=await setup(t,options);const r=await f.post('',{...data,email:f.email});assert.equal(r.statusCode,409);assert.equal(f.creates(),0);
});
test('token alterado, correo inyectado y términos omitidos no crean Auth',async t=>{
 const f=await setup(t);const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data,token:'0'.repeat(64)})).statusCode,401);
 assert.equal((await f.post('/confirm',{...p,...data,email:'other@example.test'})).statusCode,400);
 assert.equal((await f.post('/confirm',{...p,...data,acepta_terminos:false})).statusCode,400);assert.equal(f.creates(),0);
});
test('enlace expirado se rechaza antes de Auth',async t=>{
 const f=await setup(t);const p=await start(f);f.expire();assert.equal((await f.post('/confirm',{...p,...data})).statusCode,410);assert.equal(f.creates(),0);
});
test('replay/confirmaciones concurrentes: una creación y respuesta idempotente sin sesión',async t=>{
 const f=await setup(t);const p=await start(f);const r=await Promise.all([f.post('/confirm',{...p,...data}),f.post('/confirm',{...p,...data})]);
 assert.deepEqual(r.map(x=>x.statusCode),[200,200]);assert.equal(f.creates(),1);assert.equal(f.state().users.length,1);assert.equal(f.state().clients.length,1);
 assert.equal((await f.post('/confirm',{...p,...data,contrasena:'Different9!',confirmar_contrasena:'Different9!'})).statusCode,200);
 assert.equal(f.passwords.get(f.state().operation.auth_user_id),data.contrasena);
});
test('dos solicitudes iniciales: una operación y un envío; cooldown durable y reenvío invalida enlace anterior',async t=>{
 const f=await setup(t);await Promise.all([start(f),start(f)]);assert.equal(f.emails.length,1);const old=f.proof();
 f.allowResend();const r=await f.post('/resend',{email:f.email});assert.equal(r.statusCode,202);assert.equal(f.emails.length,2);
 assert.equal((await f.post('/confirm',{...old,...data})).statusCode,401);
});
for(const stage of ['INSERT INTO public.usuarios','INSERT INTO public.clientes','UPDATE public.correos'])test('rollback y recuperación '+stage,async t=>{
 const f=await setup(t,{failSql:stage});const p=await start(f);const failed=await f.post('/confirm',{...p,...data});assert.equal(failed.statusCode,503);
 assert.equal(f.state().users.length,0);assert.equal(f.state().contact.id_persona,f.oldPersona);assert.equal(f.auth.size,1);
 const retried=await f.post('/confirm',{...p,...data,contrasena:'RetryFinal8!',confirmar_contrasena:'RetryFinal8!'});assert.equal(retried.statusCode,200,retried.body);
 assert.equal(f.creates(),1);assert.equal(f.state().users.length,1);assert.equal(f.passwords.get(f.state().operation.auth_user_id),'RetryFinal8!');
});
test('timeout después de creación Auth: UUID y metadata permiten recuperar sin borrar identidad',async t=>{
 const f=await setup(t,{timeout:true});const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data})).statusCode,503);
 const login=await f.server.inject({method:'POST',url:'/v1/auth/login',payload:{identifier:f.email,contrasena:data.contrasena}});
 assert.equal(login.statusCode,401);assert.equal(login.headers['set-cookie'],undefined);
 assert.equal((await f.post('/confirm',{...p,...data})).statusCode,200);assert.equal(f.creates(),1);
});
test('error Auth no modifica dominio; fallo SMTP no declara registro completado',async t=>{
 const f=await setup(t,{authFail:true});const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data})).statusCode,503);assert.equal(f.state().users.length,0);
 const smtp=await setup(t,{smtpFail:true});assert.equal((await smtp.post('',{...data,email:smtp.email})).statusCode,503);assert.equal(smtp.auth.size,0);
});
test('marketing TRUE solo por elección explícita y prueba de identidad final recuperable',async t=>{
 const f=await setup(t);const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data,consentimiento_marketing:true})).statusCode,200);
 assert.equal(f.state().clients[0].marketing,true);const user=f.state().users[0];
 assert.equal(f.auth.get(user.id).email,f.email);assert.equal(f.passwords.get(user.id),data.contrasena);assert.notEqual(user.persona,f.oldPersona);
});
test('resend no enumera cuentas existentes y migración tiene acceso privado y rollback protegido',async t=>{
 const f=await setup(t,{authExists:true});const r=await f.post('/resend',{email:f.email});assert.equal(r.statusCode,202);assert.equal(f.emails.length,0);
 const sql=readFileSync(new URL('../db/migrations/20261019010000_guest_registration_requests.sql',import.meta.url),'utf8');
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.match(sql,/REVOKE ALL.*PUBLIC, anon, authenticated/);
 assert.match(sql,/auth_user_id uuid NOT NULL UNIQUE/);assert.match(sql,/token_hash text NOT NULL UNIQUE/);assert.match(sql,/Reconcile registration operations before rollback/);
 assert.doesNotMatch(sql,/^\s*password\s|GRANT.*service_role/im);
});
test('tras completar: login real de Fastify con Auth simulado devuelve solo Cliente y sesión',async t=>{
 const f=await setup(t);const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data})).statusCode,200);
 const login=await f.server.inject({method:'POST',url:'/v1/auth/login',payload:{identifier:f.email,contrasena:data.contrasena}});
 assert.equal(login.statusCode,200,login.body);assert.deepEqual(login.json().data.user.roles,['cliente']);
 assert.ok(login.headers['set-cookie']);assert.equal(login.json().data.user.id_persona,f.state().users[0].persona);
});
test('Auth creado tras timeout permite reenvío duradero sin registrar otra identidad',async t=>{
 const f=await setup(t,{timeout:true});const p=await start(f);assert.equal((await f.post('/confirm',{...p,...data})).statusCode,503);
 f.allowResend();const again=await f.post('',{...data,email:f.email});assert.equal(again.statusCode,202,again.body);
 const fresh=f.proof();assert.equal((await f.post('/confirm',{...fresh,...data})).statusCode,200);assert.equal(f.creates(),1);
});
test('revalidación bloquea una identidad Auth ajena que aparece antes de confirmar',async t=>{
 const f=await setup(t);const p=await start(f);f.auth.set('33333333-3333-4333-8333-333333333333',{email:f.email,app_metadata:{}});
 assert.equal((await f.post('/confirm',{...p,...data})).statusCode,409);assert.equal(f.creates(),0);assert.equal(f.state().contact.id_persona,f.oldPersona);
});

test('fallos inesperados del registro pendiente no exponen detalles SQL ni del transporte',async t=>{
 const sql=await setup(t,{failSql:'INSERT INTO app_private.guest_registration_requests'});
 const smtp=await setup(t);smtp.app.mailer.sendMail=async()=>{throw new Error('synthetic SMTP private diagnostic');};
 for(const f of [sql,smtp]){
  const r=await f.post('',{...data,email:f.email});assert.equal(r.statusCode,503,r.body);
  assert.equal(r.json().error.details,undefined);assert.doesNotMatch(r.body,/synthetic|SQL|SMTP|private diagnostic/);
  assert.equal(f.creates(),0);assert.equal(f.state().users.length,0);
 }
});

test('CSRF real: confirm/resend públicos no dependen de sesión; otra ruta conserva protección',async t=>{
 const f=await setup(t,{security:true,free:true});
 const headers={cookie:'mf_session=synthetic-local-only'};
 const resend=await f.server.inject({method:'POST',url:'/v1/auth/register/resend',headers,payload:{email:f.email}});
 assert.equal(resend.statusCode,202);assert.equal(f.emails.length,0);
 const confirm=await f.server.inject({method:'POST',url:'/v1/auth/register/confirm',headers,payload:{...data,operation:'11111111-1111-4111-8111-111111111111',token:'a'.repeat(64)}});
 assert.equal(confirm.statusCode,401);assert.notEqual(confirm.json().error.code,'CSRF_TOKEN_INVALID');
 const other=await f.server.inject({method:'POST',url:'/v1/qa02h-private-probe',headers,payload:{}});
 assert.equal(other.statusCode,403);assert.equal(other.json().error.code,'CSRF_TOKEN_INVALID');assert.equal(f.creates(),0);
});
test('rate limit real de reenvío: cinco solicitudes; la sexta se rechaza sin SMTP',async t=>{
 const f=await setup(t,{security:true,free:true});
 for(let i=0;i<5;i++)assert.equal((await f.post('/resend',{email:f.email})).statusCode,202);
 assert.equal((await f.post('/resend',{email:f.email})).statusCode,429);assert.equal(f.emails.length,0);
});
test('rate limit real de confirmación: diez intentos; el undécimo no toca Auth',async t=>{
 const f=await setup(t,{security:true});const payload={...data,operation:'11111111-1111-4111-8111-111111111111',token:'a'.repeat(64)};
 for(let i=0;i<10;i++)assert.equal((await f.post('/confirm',payload)).statusCode,401);
 assert.equal((await f.post('/confirm',payload)).statusCode,429);assert.equal(f.creates(),0);
});

test('registro histórico libera la consulta inicial antes de adquirir la conexión transaccional',async t=>{
 const f=await setup(t);const connect=f.db.connect;let active=0,peak=0;
 f.db.connect=async()=>{
  if(active!==0)throw new Error('LOCAL_POOL_CAPACITY_EXHAUSTED');
  const client=await connect();active++;peak=Math.max(peak,active);let released=false;
  return {query:client.query,release(){assert.equal(released,false);released=true;active--;client.release();}};
 };
 const response=await f.post('',{...data,email:f.email});
 assert.equal(response.statusCode,202,response.body);assert.equal(active,0);assert.equal(peak,1);
 assert.equal(f.emails.length,1);assert.equal(f.creates(),0);
});
