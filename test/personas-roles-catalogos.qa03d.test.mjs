import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/personas.js';
const ID='11111111-1111-4111-8111-111111111111';
const rows=(data=[])=>({rows:data,rowCount:data.length});
async function fixture(t,opts={}) {
  const s={queries:[],connected:0,released:0,roles:[{id_rol:ID,nombre:'super_admin'},{id_rol:'22222222-2222-4222-8222-222222222222',nombre:'admin'}]};
  async function query(sql,params=[]) {
    const q=String(sql).replace(/\s+/g,' ').trim();s.queries.push({q,params});
    if(opts.queryFailure)throw new Error('connect ECONNREFUSED INTERNAL password=SECRET');
    if(opts.insertFailure&&q.startsWith('INSERT'))throw new Error('SQL INTERNAL password=SECRET');
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return rows();
    if(q.startsWith('SELECT id_rol FROM'))return rows(s.roles.filter(x=>x.nombre.toLowerCase()===params[0]));
    if(q.startsWith('INSERT INTO public.roles')){if(opts.uniqueFailure)throw Object.assign(new Error('duplicate key INTERNAL'),{code:'23505',constraint:'roles_nombre_key'});const role={id_rol:'33333333-3333-4333-8333-333333333333',nombre:params[0],created_at:'2026-10-20',updated_at:'2026-10-20'};s.roles.push(role);return rows([role]);}
    if(q.includes("AM: PERSONAS_ADMIN_BRANCHES"))return rows([{id_sucursal:ID}]);
    if(q.includes('FROM public.roles'))return rows(s.roles.filter(role=>!q.includes("WHERE nombre IN")||role.nombre!=="super_admin").sort((a,b)=>a.nombre.localeCompare(b.nombre)));
    if(q.includes('FROM public.sucursales')){assert.match(q,/deleted_at IS NULL/);assert.match(q,/estado IS TRUE/);assert.match(q,/ORDER BY nombre_sucursal ASC/);return rows(opts.emptyBranches?[]:[{id_sucursal:ID,nombre_sucursal:'Sucursal Sintetica'}]);}
    throw new Error('Unexpected query: '+q);
  }
  const app=Fastify({logger:false});app.decorate('db',{query,connect:async()=>{s.connected++;if(opts.connectFailure)throw new Error('database INTERNAL password=SECRET');return {query,release(){s.released++;}};}});
  app.decorate('requireRoles',allowed=>async(req,reply)=>{const roles=String(req.headers['x-roles']||'').split(',').filter(Boolean);if(!roles.length)return reply.code(401).send({error:{code:'AUTH_REQUIRED'}});if(!roles.some(x=>allowed.includes(x)))return reply.code(403).send({error:{code:'AUTH_FORBIDDEN'}});req.claims={roles,user:{id_usuario:ID},branch_ids:[]};});
  await app.register(routes,{prefix:'/personas'});t.after(()=>app.close());s.call=(method,path,actor='super_admin',payload)=>app.inject({method,url:'/personas'+path,headers:{'x-roles':actor},payload});return s;
}
for(const actor of ['super_admin','super_admin,admin'])test(`listado y creación solo Superadmin: ${actor}`,async t=>{const s=await fixture(t);const r=await s.call('GET','/roles',actor);assert.equal(r.statusCode,200);assert.deepEqual(r.json().data.roles.map(x=>x.nombre),['admin','super_admin']);const before=structuredClone(s.roles);const create=await s.call('POST','/roles',actor,{nombre:'  Auditor_QA  '});assert.equal(create.statusCode,201,create.body);assert.equal(create.json().data.rol.nombre,'auditor_qa');assert.deepEqual(s.roles.slice(0,2),before);assert.equal(s.released,1);assert.ok(s.queries.some(x=>x.q==='COMMIT'));assert.equal(s.queries.some(x=>/UPDATE|DELETE|roles_usuarios/.test(x.q)),false);});
for(const actor of ['admin','cliente','barbero',''])test(`no administrar definiciones ni privilegios: ${actor||'anónimo'}`,async t=>{const s=await fixture(t);for(const method of ['GET','POST']){const r=await s.call(method,'/roles',actor,method==='POST'?{nombre:'super_admin'}:undefined);assert.equal(r.statusCode,actor?403:401);}assert.equal(s.connected,0);assert.equal(s.queries.length,0);});
for(const nombre of ['super_admin',' SUPER_ADMIN '])test(`duplicado normalizado no modifica roles: ${nombre}`,async t=>{const s=await fixture(t);const r=await s.call('POST','/roles','super_admin',{nombre});assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'PERSONAS_ROLE_DUPLICATE');assert.equal(s.roles.length,2);assert.ok(s.queries.some(x=>x.q==='ROLLBACK'));});
for(const nombre of ['','  ','a','con espacio','admin;drop','éxito','a'.repeat(51)])test(`nombre inválido rechazado: ${JSON.stringify(nombre)}`,async t=>{const s=await fixture(t);assert.equal((await s.call('POST','/roles','super_admin',{nombre})).statusCode,400);assert.equal(s.queries.some(x=>x.q.startsWith('INSERT')),false);});
test('duplicado concurrente 23505 mantiene 409 y rollback',async t=>{const s=await fixture(t,{uniqueFailure:true});const r=await s.call('POST','/roles','super_admin',{nombre:'auditor_qa'});assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error.code,'PERSONAS_ROLE_DUPLICATE');assert.ok(s.queries.some(x=>x.q==='ROLLBACK'));assert.equal(s.released,1);});
test('fallo de conexión se maneja sin exponer error técnico',async t=>{const s=await fixture(t,{connectFailure:true});const r=await s.call('POST','/roles','super_admin',{nombre:'auditor_qa'});assert.equal(r.statusCode,500);assert.equal(r.json().error.code,'PERSONAS_ROLE_CREATE_ERROR');assert.doesNotMatch(r.body,/SECRET|INTERNAL|database/);assert.equal(s.queries.length,0);});
test('fallo al insertar revierte y libera conexión sin tocar roles anteriores',async t=>{const s=await fixture(t,{insertFailure:true});const r=await s.call('POST','/roles','super_admin',{nombre:'auditor_qa'});assert.equal(r.statusCode,500);assert.doesNotMatch(r.body,/SECRET|INTERNAL|SQL/);assert.ok(s.queries.some(x=>x.q==='ROLLBACK'));assert.equal(s.released,1);assert.equal(s.roles.length,2);});
test('fallo de BEGIN libera conexión sin rollback ficticio',async t=>{const s=await fixture(t,{queryFailure:true});const r=await s.call('POST','/roles','super_admin',{nombre:'auditor_qa'});assert.equal(r.statusCode,500);assert.deepEqual(s.queries.map(x=>x.q),['BEGIN']);assert.equal(s.released,1);});
for(const actor of ['admin','super_admin','super_admin,admin'])test(`catálogos conservan roles permitidos y sucursales autorizadas: ${actor}`,async t=>{const s=await fixture(t);const r=await s.call('GET','/catalogos',actor);assert.equal(r.statusCode,200);assert.equal(r.json().data.roles.length,actor==="admin"?1:2);assert.deepEqual(Object.keys(r.json().data.sucursales[0]).sort(),['id_sucursal','nombre_sucursal']);assert.equal(s.queries.some(x=>/^(INSERT|UPDATE|DELETE)/.test(x.q)),false);});
for(const actor of ['cliente','barbero',''])test(`catálogos sin exposición: ${actor||'anónimo'}`,async t=>{const s=await fixture(t);assert.equal((await s.call('GET','/catalogos',actor)).statusCode,actor?403:401);assert.equal(s.queries.length,0);});
test('catálogo sin sucursales mantiene contrato y no inventa datos',async t=>{const s=await fixture(t,{emptyBranches:true});const r=await s.call('GET','/catalogos','admin');assert.equal(r.statusCode,200);assert.deepEqual(r.json().data.sucursales,[]);});
for(const path of ['/catalogos','/roles'])test(`fallo de consulta ${path} no expone detalles`,async t=>{const s=await fixture(t,{queryFailure:true});const r=await s.call('GET',path);assert.equal(r.statusCode,500);assert.doesNotMatch(r.body,/SECRET|INTERNAL|ECONNREFUSED/);});
