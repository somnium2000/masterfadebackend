import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/personas.js';
const ID='11111111-1111-4111-8111-111111111111',PERSON='22222222-2222-4222-8222-222222222222',USER='33333333-3333-4333-8333-333333333333',BRANCH='44444444-4444-4444-8444-444444444444';
const ROLES={admin:'55555555-5555-4555-8555-555555555555',barbero:'66666666-6666-4666-8666-666666666666',super_admin:'77777777-7777-4777-8777-777777777777'};
const rows=(data=[])=>({rows:data,rowCount:data.length});
const payload=()=>({persona:{nombres:'Ana',apellidos:'Sintetica',dni:'0801199012345',telefono_principal:'99990000'},acceso:{correo_principal:'ana@example.test',roles:['admin']},empleado:{id_sucursal:BRANCH,es_barbero:false,salario_base:1000}});
async function fixture(t,options={}){
  const state={row:{id_empleado:ID,id_persona:PERSON,id_usuario:USER,nombres:'Ana',apellidos:'Sintetica',correo_principal:'ana@example.test',estado_laboral:true,estado_acceso:'activo',es_barbero:false,id_sucursal:BRANCH,...options.row},roles:new Map(options.noHistory?[]:[['admin',true]]),queries:[],auth:[],mail:[],authEmail:'ana@example.test',authUserExists:Boolean(options.authIdentity),otherPrimary:Boolean(options.guestHasOtherPrimary),barberProfileCreated:false};
  async function query(sql,params=[]){
    const text=String(sql).replace(/\s+/g,' ').trim();state.queries.push({text,params});
    if(text==='BEGIN'){state.snapshot={row:{...state.row},roles:new Map(state.roles),recovery:state.recovery,guestPersona:state.guestPersona?{...state.guestPersona}:null,otherPrimary:state.otherPrimary};return rows();}
    if(text==='COMMIT')return rows();
    if(text==='ROLLBACK'){Object.assign(state,state.snapshot);return rows();}
    if(text.includes('FROM public.app_protected_users'))return rows(options.protected?[{exists:1}]:[]);
    if(text.includes("r.nombre = 'super_admin'"))return rows(options.privileged?[{exists:1}]:[]);
    if(text.startsWith('SELECT e.id_empleado, e.roles_reactivacion'))return rows([{id_empleado:ID,roles_reactivacion:state.recovery??null}]);
    if(text.startsWith('UPDATE public.empleados SET roles_reactivacion = (')){const active=[...state.roles].filter(([,v])=>v).map(([rol])=>({usuario:USER,rol,sucursal:rol==='super_admin'?null:state.row.id_sucursal}));if(active.length)state.recovery=active;return rows();}
    if(text.startsWith('UPDATE public.empleados SET roles_reactivacion = NULL')){state.recovery=null;return rows();}
    if(text.startsWith('SELECT c.id_persona,')&&text.includes('FROM public.correos c'))return rows(options.duplicateEmail||options.guestContact?[{id_persona:PERSON,nombres:'Ana',apellidos:'Invitada',has_user:false,has_client:false,has_employee:false}]:[]);
    if(text.includes('FROM public.empleados e')){
      if(params[0]==='invalid')throw Object.assign(new Error('invalid uuid'),{code:'22P02'});
      return rows(options.missing?[]:[{...state.row,roles:[...state.roles].filter(([,v])=>v).map(([k])=>k)}]);
    }
    if(text.includes('FROM public.sucursales'))return rows(options.inactiveBranch?[]:[{id_sucursal:BRANCH}]);
    if(text.startsWith('SELECT dni, telefono_principal'))return rows(state.guestPersona?[state.guestPersona]:[{dni:payload().persona.dni,telefono_principal:'99990000'}]);
    if(text.includes('FROM public.personas')&&text.includes('regexp_replace'))return rows(options.duplicateDni?[{id_persona:PERSON}]:[]);
    if(text.startsWith('SELECT id_correo'))return rows(options.guestContact?[{id_correo:'88888888-8888-4888-8888-888888888888'}]:[]);
    if(text.includes('FROM public.correos')&&text.includes('LOWER'))return rows(options.duplicateEmail?[{id_persona:BRANCH}]:[]);
    if(text.includes('FROM auth.users'))return rows(state.authUserExists?[{id:options.foreignAuthId||USER}]:[]);
    if(text==='SELECT id_rol, nombre FROM public.roles')return rows(Object.entries(ROLES).map(([nombre,id_rol])=>({nombre,id_rol})));
    if(text.startsWith('INSERT INTO public.personas'))return rows([{id_persona:PERSON}]);
    if(text.startsWith('INSERT INTO public.correos'))return rows();
    if(text.startsWith('UPDATE public.correos')&&text.includes('es_principal = FALSE')){state.otherPrimary=false;return rows();}
    if(text.startsWith('UPDATE public.correos')&&text.includes('direccion_correo = $2')){if(state.otherPrimary)throw Object.assign(new Error('synthetic principal conflict'),{code:'23505',constraint:'uq_correos_principal_persona'});return rows();}
    if(text.startsWith('INSERT INTO public.usuarios')){state.row.estado_acceso=params[2];return rows();}
    if(text.startsWith('UPDATE public.personas')){assert.equal(params[0],PERSON);if(state.guestPersona&&text.includes('SET dni =')){state.guestPersona.dni=params[1];state.guestPersona.telefono_principal=params[2];}return rows();}
    if(text.startsWith('UPDATE public.usuarios')){state.row.estado_acceso=text.includes('estado = FALSE')?'bloqueado':options.pending?'pendiente_password':'activo';return rows();}
    if(text.startsWith('UPDATE public.roles_usuarios')){
      if(text.includes('activo = FALSE')){for(const [k,id] of Object.entries(ROLES))if(state.roles.has(k)&&params[1].includes(id))state.roles.set(k,false);return rows();}
      const role=Object.keys(ROLES).find(k=>ROLES[k]===params[1]);
      if(!state.roles.has(role))return rows();state.roles.set(role,true);return{rows:[],rowCount:1};
    }
    if(text.startsWith('INSERT INTO public.roles_usuarios')){state.roles.set(Object.keys(ROLES).find(k=>ROLES[k]===params[0]),true);return rows();}
    if(text.startsWith('INSERT INTO public.empleados')){
      if(state.guestPersona&&(!state.guestPersona.dni||!state.guestPersona.telefono_principal))throw Object.assign(new Error('synthetic required persona fields trigger'),{code:'23514'});
      if(options.sqlFailure)throw new Error('synthetic SQL failure');state.row.estado_laboral=params[4];state.row.es_barbero=params[5];return rows([{id_empleado:ID}]);
    }
    if(text.startsWith('UPDATE public.empleados')){
      if(options.sqlFailure)throw new Error('synthetic SQL failure');state.row.estado_laboral=text.includes('estado = FALSE')?false:text.includes('estado = TRUE')?true:params[4]??state.row.estado_laboral;if(params.length>1){state.row.id_sucursal=params[1];state.row.es_barbero=params[5];}return rows();
    }
    if(text.startsWith('INSERT INTO public.barberos_perfiles_publicos')){state.barberProfileCreated=true;return rows();}
    if(text.includes('public.barberos_perfiles_publicos'))return rows();
    throw new Error('Unexpected SQL: '+text);
  }
  const app=Fastify({logger:false});app.decorate('db',{query,connect:async()=>({query,release(){}})});
  if(options.guestMissingDni)state.guestPersona={dni:null,telefono_principal:options.guestMissingPhone?null:'88880000',nombres:'Nombre historico',cita:'cita-historica'};
  if(options.guestExistingDni)state.guestPersona={dni:options.guestExistingDni,telefono_principal:'88880000',nombres:'Nombre historico',cita:'cita-historica'};
  app.decorate('supabaseAdmin',{auth:{admin:{
    createUser:async input=>{state.auth.push(['create',input.email]);if(!options.authFailure)state.authUserExists=true;return options.authFailure?{error:{message:'synthetic'}}:{data:{user:{id:USER}}};},
    generateLink:async input=>{assert.equal(input.type,'recovery');assert.equal(new URL(input.options.redirectTo).pathname,'/reset-password');return{data:{properties:{hashed_token:'synthetic-recovery-hash-not-real',action_link:'http://127.0.0.1:9/synthetic-recovery'}}};},
    deleteUser:async id=>{state.auth.push(['delete',id]);state.authUserExists=false;return{};},
    updateUserById:async(id,input)=>{state.auth.push(['update',id,input.email]);state.authEmail=input.email;if(options.authTimeout&&state.auth.filter(([op])=>op==='update').length===1)throw new Error('synthetic timeout after provider write');return{data:{user:{id}}};}
  }}});
  if(options.mail)app.decorate('mailer',{configured:true,sendPasswordRecoveryEmail:async input=>{state.mail.push({to:input.to,kind:input.kind});return{sent:true};}});
  app.decorate('requireRoles',allowed=>async(request,reply)=>{const roles=String(request.headers['x-roles']??'').split(',').filter(Boolean);if(!roles.length)return reply.code(401).send({error:{code:'AUTH_REQUIRED'}});if(!roles.some(r=>allowed.includes(r)))return reply.code(403).send({error:{code:'AUTH_FORBIDDEN'}});request.claims={roles,branch_ids:[],user:{id_usuario:BRANCH}};});
  await app.register(routes,{prefix:'/personas'});t.after(()=>app.close());
  state.inject=(method,path=`/empleados/${ID}`,body,roles='admin')=>app.inject({method,url:'/personas'+path,payload:body,headers:{'x-roles':roles}});
  return state;
}
for(const method of ['POST','PATCH'])test(`${method} inactivo no conserva roles operativos`,async t=>{const s=await fixture(t);const body=payload();body.empleado.estado=false;const r=await s.inject(method,method==='POST'?'/empleados':undefined,body);assert.equal(r.statusCode,method==='POST'?201:200,r.body);assert.equal(s.row.estado_acceso,'bloqueado');assert.equal([...s.roles.values()].some(Boolean),false);});
test('edición ordinaria de inactivo no reactiva roles',async t=>{const s=await fixture(t,{row:{estado_laboral:false,estado_acceso:'bloqueado'}});s.roles.set('admin',false);const r=await s.inject('PATCH',undefined,payload());assert.equal(r.statusCode,200,r.body);assert.equal(s.roles.get('admin'),false);});
test('sin historial no inventa admin al activar',async t=>{const s=await fixture(t,{noHistory:true,row:{estado_laboral:false}});const r=await s.inject('PATCH',`/empleados/${ID}/activar`,undefined,'super_admin');assert.equal(r.statusCode,409,r.body);assert.equal([...s.roles.values()].some(Boolean),false);});

for(const roles of [['barbero'],['admin'],['admin','barbero']])test(`P1 ciclo restaura solo roles vigentes: ${roles}`,async t=>{
  const s=await fixture(t);const b=payload();b.acceso.roles=roles;b.empleado.es_barbero=roles.includes('barbero');
  assert.equal((await s.inject('PATCH',undefined,b,'super_admin')).statusCode,200);
  assert.equal((await s.inject('PATCH',`/empleados/${ID}/inactivar`,undefined,'super_admin')).statusCode,200);
  assert.equal((await s.inject('PATCH',`/empleados/${ID}/inactivar`,undefined,'super_admin')).statusCode,200);
  const r=await s.inject('PATCH',`/empleados/${ID}/activar`,undefined,'super_admin');assert.equal(r.statusCode,200,r.body);
  assert.deepEqual([...s.roles].filter(([,active])=>active).map(([name])=>name).sort(),[...roles].sort());
  assert.equal(s.recovery,null);
});

test('P1 historial retirado sin captura no autoriza reactivacion',async t=>{
  const s=await fixture(t,{row:{estado_laboral:false,estado_acceso:'bloqueado'}});s.roles.set('admin',false);
  const r=await s.inject('PATCH',`/empleados/${ID}/activar`,undefined,'super_admin');assert.equal(r.statusCode,409);
  assert.equal(s.roles.get('admin'),false);assert.equal(s.row.estado_acceso,'bloqueado');
});
test('timeout después de cambiar correo Auth compensa identidad',async t=>{const s=await fixture(t,{authTimeout:true});const body=payload();body.acceso.correo_principal='nuevo@example.test';assert.equal((await s.inject('PATCH',undefined,body)).statusCode,500);assert.equal(s.authEmail,'ana@example.test');assert.ok(s.queries.some(q=>q.text==='ROLLBACK'));});
for(const suffix of ['','/activar','/inactivar'])test(`UUID inválido rechazado en PATCH ${suffix}`,async t=>{const s=await fixture(t);assert.equal((await s.inject('PATCH','/empleados/invalid'+suffix,suffix?undefined:payload())).statusCode,400);assert.equal(s.queries.length,0);});
for(const roles of ['admin','super_admin','super_admin,admin'])test(`lectura global y edición: ${roles}`,async t=>{const s=await fixture(t);assert.equal((await s.inject('GET','/empleados',undefined,roles)).statusCode,200);assert.equal((await s.inject('PATCH',undefined,payload(),roles)).statusCode,200);});
for(const roles of ['','barbero','cliente'])test(`sin autorización no obtiene salarios ni escribe: ${roles}`,async t=>{const s=await fixture(t);for(const method of ['GET','PATCH','POST'])assert.equal((await s.inject(method,method==='POST'?'/empleados':undefined,method==='GET'?undefined:payload(),roles)).statusCode,roles?403:401);assert.equal(s.queries.length,0);});
for(const suffix of ['','/activar','/inactivar'])test(`admin no gestiona super_admin: ${suffix}`,async t=>{const s=await fixture(t,{privileged:true});assert.equal((await s.inject('PATCH',`/empleados/${ID}${suffix}`,suffix?undefined:payload())).statusCode,403);assert.equal(s.queries.some(q=>/^(BEGIN|UPDATE|INSERT)/.test(q.text)),false);});
for(const roles of ['admin','super_admin','super_admin,admin'])test(`root permanece protegido: ${roles}`,async t=>{const s=await fixture(t,{protected:true});assert.equal((await s.inject('PATCH',undefined,payload(),roles)).statusCode,403);assert.equal(s.queries.some(q=>q.text==='BEGIN'),false);});
test('admin no asigna super_admin antes de Auth/SQL',async t=>{const s=await fixture(t);const body=payload();body.acceso.roles=['super_admin'];assert.equal((await s.inject('POST','/empleados',body)).statusCode,403);assert.equal(s.auth.length,0);});
test('roles arbitrarios y salario negativo se rechazan por schema',async t=>{const s=await fixture(t);for(const value of ['cliente','inventado']){const b=payload();b.acceso.roles=[value];assert.equal((await s.inject('POST','/empleados',b)).statusCode,400);}const b=payload();b.empleado.salario_base=-1;assert.equal((await s.inject('POST','/empleados',b)).statusCode,400);assert.equal(s.queries.length,0);});
for(const role of ['admin','barbero','super_admin'])test(`alta autorizada rol ${role}, scope parametrizado`,async t=>{const s=await fixture(t);const b=payload();b.acceso.roles=[role];b.empleado.es_barbero=role==='barbero';b.acceso.correo_principal='ANA@EXAMPLE.TEST';const r=await s.inject('POST','/empleados',b,'super_admin,admin');assert.equal(r.statusCode,201,r.body);assert.equal(s.auth[0][1],'ana@example.test');const writes=s.queries.filter(q=>q.text.includes('activo = TRUE')||q.text.startsWith('INSERT INTO public.roles_usuarios'));assert.ok(writes.some(q=>q.params.includes(role==='super_admin'?null:BRANCH)));});
for(const option of ['duplicateDni','duplicateEmail','inactiveBranch'])test(`alta inválida sin Auth: ${option}`,async t=>{const s=await fixture(t,{[option]:true});const r=await s.inject('POST','/empleados',payload());assert.equal(r.statusCode,option==='inactiveBranch'?400:409,r.body);assert.equal(s.auth.length,0);});
test('invitado solo se convierte en empleado con vinculacion explicita',async t=>{const s=await fixture(t,{guestContact:true});const first=await s.inject('POST','/empleados',payload());assert.equal(first.statusCode,409);assert.equal(first.json().error.code,'PERSONAS_GUEST_LINK_REQUIRED');assert.equal(first.json().error.details.id_persona,PERSON);const body=payload();body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};const linked=await s.inject('POST','/empleados',body);assert.equal(linked.statusCode,201,linked.body);assert.equal(s.queries.some(q=>q.text.startsWith('INSERT INTO public.personas')),false);});
test('invitado con otro correo principal se vincula como barbero sin duplicar Persona',async t=>{const s=await fixture(t,{guestContact:true,guestHasOtherPrimary:true});const body=payload();body.acceso.roles=['barbero'];body.empleado.es_barbero=true;body.perfil_publico={alias_publico:'Barbero QA',visible_en_landing:true};body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};const linked=await s.inject('POST','/empleados',body);assert.equal(linked.statusCode,201,linked.body);assert.equal(s.otherPrimary,false);assert.equal(s.barberProfileCreated,true);assert.equal(s.queries.some(q=>q.text.startsWith('INSERT INTO public.personas')),false);assert.deepEqual(s.auth.map(([op])=>op),['create']);assert.ok(s.queries.some(q=>q.text==='COMMIT'));});
test('alta falla SQL y compensa solamente su Auth',async t=>{const s=await fixture(t,{sqlFailure:true});assert.equal((await s.inject('POST','/empleados',payload())).statusCode,500);assert.deepEqual(s.auth.map(([op])=>op),['create','delete']);assert.ok(s.queries.some(q=>q.text==='ROLLBACK'));});
test('Auth fallido no abre transacción',async t=>{const s=await fixture(t,{authFailure:true});assert.equal((await s.inject('POST','/empleados',payload())).statusCode,500);assert.equal(s.queries.some(q=>q.text==='BEGIN'),false);});
for(const guestMissingPhone of [false,true])test(`invitado sin DNI completa obligatorios antes del trigger barbero y preserva historial, telefono faltante: ${guestMissingPhone}`,async t=>{
  const s=await fixture(t,{guestContact:true,guestMissingDni:true,guestMissingPhone});
  const body=payload();body.acceso.roles=['barbero'];body.empleado.es_barbero=true;body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};
  const response=await s.inject('POST','/empleados',body);
  assert.equal(response.statusCode,201,response.body);
  assert.deepEqual(s.guestPersona,{dni:body.persona.dni,telefono_principal:guestMissingPhone?body.persona.telefono_principal:'88880000',nombres:'Nombre historico',cita:'cita-historica'});
  assert.equal(s.queries.some(q=>q.text.startsWith('INSERT INTO public.personas')),false);
  assert.equal(s.row.es_barbero,true);assert.equal(s.barberProfileCreated,true);
});
test('DNI diferente almacenado impide vinculación y compensa Auth',async t=>{
  const s=await fixture(t,{guestContact:true,guestExistingDni:'0801199012346'});const body=payload();body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};
  const response=await s.inject('POST','/empleados',body);assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'PERSONAS_GUEST_LINK_MISMATCH');assert.equal(s.guestPersona.dni,'0801199012346');assert.deepEqual(s.auth.map(([op])=>op),['create','delete']);
});
test('invitado con DNI duplicado no crea Auth',async t=>{
  const s=await fixture(t,{guestContact:true,guestMissingDni:true,duplicateDni:true});const body=payload();body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};
  assert.equal((await s.inject('POST','/empleados',body)).statusCode,409);assert.equal(s.auth.length,0);assert.equal(s.guestPersona.dni,null);
});
test('fallo posterior restaura Persona histórica y compensa solo Auth nuevo',async t=>{
  const s=await fixture(t,{guestContact:true,guestMissingDni:true,sqlFailure:true});const before={...s.guestPersona};const body=payload();body.vinculacion_persona={id_persona:PERSON,confirmar_vinculacion:true};
  assert.equal((await s.inject('POST','/empleados',body)).statusCode,500);assert.deepEqual(s.guestPersona,before);assert.deepEqual(s.auth.map(([op])=>op),['create','delete']);assert.ok(s.queries.some(q=>q.text==='ROLLBACK'));assert.equal(s.queries.some(q=>q.text==='COMMIT'),false);
});
test('sin usuario e inexistente no mutan',async t=>{for(const option of [{row:{id_usuario:null}},{missing:true}]){const s=await fixture(t,option);assert.equal((await s.inject('PATCH',undefined,payload())).statusCode,option.missing?404:409);assert.equal(s.queries.some(q=>q.text==='BEGIN'),false);}});
test('ciclo conserva pendiente_password y DELETE contractual 410',async t=>{const s=await fixture(t,{pending:true});assert.equal((await s.inject('PATCH',`/empleados/${ID}/inactivar`)).statusCode,200);assert.equal(s.row.estado_acceso,'bloqueado');assert.equal((await s.inject('PATCH',`/empleados/${ID}/activar`)).statusCode,200);assert.equal(s.row.estado_acceso,'pendiente_password');assert.equal((await s.inject('DELETE',`/empleados/${ID}/permanente`)).statusCode,410);});
test('PATCH sin perfil_publico no borra alias existente del Barbero',async t=>{const s=await fixture(t,{row:{es_barbero:true,alias_publico:'Alias existente',resumen_publico:'Resumen existente',certificaciones_titulos:['Certificacion'],visible_en_landing:true}});const b=payload();b.acceso.roles=['barbero'];b.empleado.es_barbero=true;assert.equal((await s.inject('PATCH',undefined,b)).statusCode,200);const write=s.queries.find(q=>q.text.startsWith('INSERT INTO public.barberos_perfiles_publicos'));assert.equal(write.params[1],'Alias existente');assert.equal(write.params[4],true);});
test('alta conserva setup de contraseña con correo exclusivamente simulado',async t=>{const s=await fixture(t,{mail:true});const r=await s.inject('POST','/empleados',payload());assert.equal(r.statusCode,201,r.body);assert.equal(r.json().data.setup_password.enviado,true);assert.deepEqual(s.mail,[{to:'ana@example.test',kind:'setup'}]);assert.equal(r.body.includes('synthetic-recovery'),false);});
for(const field of ['nombres','apellidos','dni','telefono_principal'])test(`obligatorio ${field} rechazado antes de Auth`,async t=>{const s=await fixture(t);const b=payload();b.persona[field]='';assert.equal((await s.inject('POST','/empleados',b)).statusCode,400);assert.equal(s.auth.length,0);});
test('RTN inválido y sucursal ausente no abren transacción',async t=>{const s=await fixture(t);const a=payload();a.persona.rtn='123';const b=payload();delete b.empleado.id_sucursal;for(const p of [a,b])assert.equal((await s.inject('POST','/empleados',p)).statusCode,400);assert.equal(s.queries.some(q=>q.text==='BEGIN'),false);});
