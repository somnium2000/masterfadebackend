import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/personas.js';
const USER='11111111-1111-4111-8111-111111111111',PERSON='22222222-2222-4222-8222-222222222222';
const rows=(data=[])=>({rows:data,rowCount:data.length});
async function fixture(t,opts={}){
  const s={row:{id_usuario:USER,id_persona:PERSON,nombres:'Usuario',apellidos:'Sintetico',email:'qa@example.test',estado:true,estado_acceso:'activo',tiene_empleado:true,tiene_cliente:false,roles:[{rol:'admin',activo:true}],...opts.row},queries:[],mail:[],auth:[]};
  async function query(sql,params=[]){const q=String(sql).replace(/\s+/g,' ').trim();s.queries.push({q,params});
    if(params.includes('invalid'))throw Object.assign(new Error('invalid UUID'),{code:'22P02'});
    if(q==='BEGIN'){s.snapshot={...s.row};return rows();}if(q==='COMMIT')return rows();if(q==='ROLLBACK'){s.row=s.snapshot;return rows();}
    if(q.includes('FROM public.app_protected_users'))return rows(opts.protected?[{}]:[]);
    if(q.startsWith('SELECT 1')&&q.includes("r.nombre = 'super_admin'"))return rows(opts.privileged?[{}]:[]);
    if(q.startsWith('SELECT estado_acceso FROM public.usuarios'))return rows([{estado_acceso:opts.lockedStatus??s.row.estado_acceso}]);
    if(q.startsWith('SELECT EXISTS')&&q.includes('AS has_active_roles'))return rows([{has_active_roles:true,has_empleado:true,has_empleado_activo:true,has_cliente:false,has_cliente_activo:false,...opts.guard}]);
    if(q.startsWith('SELECT EXISTS'))return rows([{has_empleado:true,has_cliente:false,has_super_admin:false,...opts.relation}]);
    if(q.startsWith('UPDATE public.usuarios')){s.row.estado_acceso=params[1];return rows();}
    if(q.startsWith('UPDATE public.personas')){s.row.nombres=params[1];s.row.apellidos=params[2];s.row.telefono_principal=params[3];return rows();}
    if(q.includes('FROM (')&&q.includes('FROM public.usuarios u'))return rows(opts.missing?[]:[{...s.row}]);
    if(q.includes('FROM public.usuarios u'))return rows(opts.missing?[]:[{...s.row}]);
    throw new Error('Unexpected query: '+q);
  }
  const app=Fastify({logger:false});app.decorate('db',{query,connect:async()=>({query,release(){}})});
  app.decorate('supabaseAdmin',{auth:{admin:{generateLink:async input=>{s.auth.push(input);return {data:{properties:{action_link:'http://127.0.0.1:9/synthetic-secret-link'}}};}}}});
  app.decorate('mailer',{configured:true,sendPasswordRecoveryEmail:async input=>{s.mail.push(input);return {sent:!opts.mailFailure};}});
  app.decorate('requireRoles',allowed=>async(req,reply)=>{const roles=String(req.headers['x-roles']??'').split(',').filter(Boolean);if(!roles.length)return reply.code(401).send({error:{code:'AUTH_REQUIRED'}});if(!roles.some(x=>allowed.includes(x)))return reply.code(403).send({error:{code:'AUTH_FORBIDDEN'}});req.claims={roles,user:{id_usuario:PERSON}};});
  await app.register(routes,{prefix:'/personas'});t.after(()=>app.close());s.call=(method,suffix='',payload,actor='admin',id=USER)=>app.inject({method,url:'/personas/usuarios'+(method==='GET'?'':`/${id}${suffix}`),payload,headers:{'x-roles':actor}});return s;
}
for(const actor of ['admin','super_admin','super_admin,admin'])test(`listado y edición personal autorizados: ${actor}`,async t=>{const s=await fixture(t);assert.equal((await s.call('GET','',undefined,actor)).statusCode,200);assert.equal((await s.call('PATCH','',{persona:{nombres:'Actualizado'}},actor)).statusCode,200);assert.equal(s.row.nombres,'Actualizado');assert.equal(s.queries.some(({q})=>/UPDATE public.roles_usuarios/.test(q)),false);});
for(const actor of ['','cliente','barbero'])test(`rechazo sin exposición: ${actor||'sin sesión'}`,async t=>{const s=await fixture(t);for(const [method,suffix,body] of [['GET',''],['PATCH','/bloquear'],['POST','/enviar-configuracion-password',{}]]){const r=await s.call(method,suffix,body,actor);assert.equal(r.statusCode,actor?403:401);}assert.equal(s.queries.length,0);});
for(const suffix of ['','/estado-acceso','/activar','/bloquear','/inactivar','/enviar-configuracion-password'])test(`UUID inválido sin consultar SQL: ${suffix}`,async t=>{const s=await fixture(t);const body=suffix===''?{persona:{nombres:'Nombre'}}:suffix==='/estado-acceso'?{estado_acceso:'activo'}:suffix.includes('password')?{}:undefined;const r=await s.call(suffix.includes('password')?'POST':'PATCH',suffix,body,'super_admin','invalid');assert.equal(r.statusCode,400,r.body);assert.equal(s.queries.length,0);});
test('Admin no modifica Superadmin; root no modificable por ningún actor',async t=>{for(const opts of [{privileged:true},{protected:true}]){const s=await fixture(t,opts);for(const suffix of ['/activar','/bloquear','/inactivar','/enviar-configuracion-password']){const r=await s.call(suffix.includes('password')?'POST':'PATCH',suffix,suffix.includes('password')?{}:undefined,opts.protected?'super_admin':'admin');assert.equal(r.statusCode,403,r.body);}assert.equal(s.queries.some(({q})=>/^(BEGIN|UPDATE|INSERT)/.test(q)),false);assert.equal(s.auth.length,0);}});
test('correo, rol y sucursal siguen rechazados sin escrituras',async t=>{const s=await fixture(t);for(const acceso of [{correo_principal:'other@example.test'},{rol_principal:'super_admin'},{id_sucursal:PERSON}]){assert.equal((await s.call('PATCH','',{acceso})).statusCode,400);}assert.equal(s.queries.some(({q})=>/^(BEGIN|UPDATE)/.test(q)),false);});
for(const [guard,code] of [[{has_active_roles:false},'ROLE_REQUIRED'],[{has_empleado_activo:false},'EMPLOYEE_INACTIVE'],[{has_cliente:true,has_cliente_activo:false},'CLIENT_INACTIVE']])test(`activar respeta dominio: ${code}`,async t=>{const s=await fixture(t,{guard});const r=await s.call('PATCH','/activar');assert.equal(r.statusCode,409,r.body);assert.equal(s.queries.some(({q})=>q.startsWith('UPDATE')),false);});
test('bloquear/inactivar/activar cambia acceso sin mutar roles o perfiles',async t=>{const s=await fixture(t);for(const [suffix,status] of [['/bloquear','bloqueado'],['/inactivar','inactivo'],['/activar','activo']]){assert.equal((await s.call('PATCH',suffix)).statusCode,200);assert.equal(s.row.estado_acceso,status);}assert.equal(s.queries.some(({q})=>/UPDATE public.(roles_usuarios|empleados|clientes)/.test(q)),false);});
test('reenvío simulado al destinatario correcto, sin token en respuesta',async t=>{const s=await fixture(t);const r=await s.call('POST','/enviar-configuracion-password',{});assert.equal(r.statusCode,200,r.body);assert.equal(s.auth.length,1);assert.equal(s.mail.length,1);assert.equal(s.mail[0].to,'qa@example.test');assert.equal(s.row.estado_acceso,'pendiente_password');assert.equal(r.body.includes('synthetic-secret'),false);});
test('reenvío bloqueado al observar estado vigente bajo bloqueo',async t=>{const s=await fixture(t,{lockedStatus:'bloqueado'});assert.equal((await s.call('POST','/enviar-configuracion-password',{})).statusCode,409);assert.equal(s.auth.length,0);assert.equal(s.mail.length,0);assert.ok(s.queries.some(({q})=>q==='ROLLBACK'));});
test('sin relación válida no activa ni envía contraseña',async t=>{const s=await fixture(t,{relation:{has_empleado:false,has_cliente:false}});for(const suffix of ['/activar','/enviar-configuracion-password'])assert.equal((await s.call(suffix.includes('password')?'POST':'PATCH',suffix,{})).statusCode,409);assert.equal(s.auth.length,0);});
