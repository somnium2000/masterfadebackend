import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import Fastify from 'fastify';
import env from '../src/plugins/env.js';
import {PaymentProviderFactory} from '../src/services/payments/PaymentProviderFactory.js';
function configure(t,overrides={}){
 const before={...process.env};Object.assign(process.env,{NODE_ENV:'production',ENTORNO:'production',FRONTEND_URL:'https://masterfadeapp.com',PAYMENT_PROVIDER:'disabled',ADMIN_DATA_ENTRY_MODE:'true',AUTH_COOKIE_SECURE:'true',TODOPAGO_AUTH_URL:'ignored-invalid-unused-provider',DB_SSL:'false'});
 for(const key of ['JWT_SECRET','COOKIE_SECRET','CSRF_SECRET','BOOKING_RELEASE_TOKEN_SECRET'])process.env[key]=randomBytes(40).toString('hex');
 Object.assign(process.env,overrides);t.after(()=>{for(const k of Object.keys(process.env))if(!(k in before))delete process.env[k];Object.assign(process.env,before);PaymentProviderFactory.reset();});
}
for(const pair of [{ADMIN_DATA_ENTRY_MODE:'false'},{ADMIN_DATA_ENTRY_MODE:'true',PAYMENT_PROVIDER:'mock'},{ADMIN_DATA_ENTRY_MODE:'true',PAYMENT_PROVIDER:'pixelpay'},{ADMIN_DATA_ENTRY_MODE:'invalid'}])test('contradictory configuration cannot start '+JSON.stringify(pair),async t=>{
 configure(t,pair);const app=Fastify();t.after(()=>app.close());await assert.rejects(app.register(env).ready());
});
test('production admin+disabled starts without any payment credentials',async t=>{
 configure(t);for(const k of Object.keys(process.env))if(k.startsWith('PIXELPAY_')||k.startsWith('TODOPAGO_'))delete process.env[k];
 const app=Fastify();t.after(()=>app.close());await app.register(env);await app.ready();assert.equal(app.config.paymentProvider,'disabled');assert.equal(app.config.adminDataEntryMode,true);assert.equal(app.config.todoPago,null);assert.equal(app.config.agendaSse.enabled,false);
});
test('disabled provider refuses initialization before a cached instance can be used',async t=>{
 configure(t);let used=0;PaymentProviderFactory._instance={createIntent(){used++;}};
 assert.throws(()=>PaymentProviderFactory.create(),e=>e.code==='PAYMENTS_DISABLED'&&e.statusCode===503);assert.equal(used,0);
});
// AM: Full production plugin graph is booted only against an unreachable local fixture target.
test('admin startup listens with no provider calls or membership/agenda jobs',async t=>{
 configure(t,{NODE_ENV:'production',ENTORNO:'production',DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',DATABASE_LISTEN_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',DB_SSL:'true',DB_SSL_REJECT_UNAUTHORIZED:'true',DB_TEST_CONNECTION:'false',SUPABASE_URL:'',SUPABASE_ANON_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',MEMBERSHIP_ALERTS_ENABLED:'true',AGENDA_SSE_ENABLED:'true',SMTP_HOST:'',SMTP_VERIFY_ON_BOOT:'false'});
 const {buildApp}=await import('../src/app.js');const app=await buildApp();t.after(()=>app.close());await app.ready();await app.listen({host:'127.0.0.1',port:0});
 assert.equal(app.agendaRealtime.enabled,false);assert.equal((await app.inject({url:'/v1/health/live'})).statusCode,200);
 for(const path of ['/v1/public/citas','/v1/public/pagos','/v1/pagos/webhook/mock','/v1/account-deletion/cliente/execute']){
  const r=await app.inject({method:'POST',url:path,payload:{}});assert.equal(r.statusCode,403,r.body);assert.equal(r.json().error.code,'ADMIN_DATA_ENTRY_RESTRICTED');
 }
});
