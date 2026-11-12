import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/citas.js';

const BRANCH='11111111-1111-4111-8111-111111111111', BARBER='22222222-2222-4222-8222-222222222222', PERSON='33333333-3333-4333-8333-333333333333';
test('historial real: SQL PostgreSQL, páginas estables, filtros y día Honduras', {skip: !process.env.MASTERFADE_TEST_PGLITE}, async t => {
  assert.ok(process.env.MASTERFADE_TEST_PGLITE, 'Indicar módulo PGlite aislado; no usar una base externa');
  const { PGlite } = await import(pathToFileURL(process.env.MASTERFADE_TEST_PGLITE));
  const pg = new PGlite();
  t.after(()=>pg.close());
  await pg.exec(`
    CREATE TABLE citas(id_cita uuid PRIMARY KEY, id_grupo_cita uuid, id_sucursal uuid, id_empleado_barbero uuid,
      deleted_at timestamptz, estado_cita_codigo text, orden_integrante int, alias_integrante text,
      id_persona_cliente uuid, id_cliente uuid, inicio_at timestamptz, fin_at timestamptz,
      atencion_iniciada_at timestamptz, atencion_finalizada_at timestamptz,
      retraso_inicio_min int, duracion_total_min int, buffer_total_min int, selection_type text,
      id_paquete uuid, total_pagar_hnl numeric, moneda_codigo text, asignada_automaticamente boolean, notas text);
    CREATE TABLE sucursales(id_sucursal uuid,nombre_sucursal text,deleted_at timestamptz,estado boolean);
    CREATE TABLE personas(id_persona uuid,nombres text,apellidos text,telefono_principal text);
    CREATE TABLE empleados(id_empleado uuid,id_persona uuid);
    CREATE TABLE correos(id_correo uuid,id_persona uuid,direccion_correo text,deleted_at timestamptz,es_principal boolean,verificado boolean);
    CREATE TABLE citas_detalles(id_cita_detalle uuid,id_cita uuid,id_servicio uuid);
    CREATE TABLE servicios(id_servicio uuid,nombre_servicio text);
    CREATE TABLE citas_holds(id_cita uuid,estado_hold_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE payment_intents(id_cita uuid,estado_intent_codigo text,expires_at timestamptz,created_at timestamptz);
    CREATE TABLE citas_reagendaciones(id_cita uuid,id_lote_reagendacion uuid,id_cita_causante uuid,retraso_min int,tipo_reagendacion_codigo text,created_at timestamptz,id_reagendacion uuid);
  `);
  await pg.query("INSERT INTO sucursales VALUES ($1,'Sucursal',NULL,true)",[BRANCH]);
  await pg.query("INSERT INTO personas VALUES ($1,'Persona','Fixture','00000000')",[PERSON]);
  await pg.query("INSERT INTO empleados VALUES ($1,$2)",[BARBER,PERSON]);
  const expected=[];
  for(let i=1;i<=23;i++){
    const id='44444444-4444-4444-8444-'+String(i).padStart(12,'0');
    expected.push(id);
    await pg.query("INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,inicio_at,estado_cita_codigo) VALUES ($1,$2,$3,$4,$5,'confirmada')",[id,BRANCH,BARBER,PERSON,'2026-11-'+String(1+Math.floor(i/4)).padStart(2,'0')+'T14:00:00Z']);
  }
  const app=Fastify();
  await pg.query("INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,inicio_at,deleted_at) VALUES ('55555555-5555-4555-8555-555555555555',$1,$2,$3,'2099-01-01',now())",[BRANCH,BARBER,PERSON]);
  t.after(()=>app.close());
  let queryError='';
  app.decorate('db',{query(sql,params){
    // AM: La caducidad no forma parte de esta prueba; las consultas de listado sí ejecutan SQL real.
    if(sql.includes('UPDATE public.citas_holds') || sql.includes('WITH target_intents') || sql.includes("no_show_at = COALESCE")) return Promise.resolve({rows:[],rowCount:0});
    return pg.query(sql,params).catch(error=>{queryError=error.message;throw error;});
  }});
  app.decorate('requireRoles',allowed=>async request=>{
    const role=request.headers['x-fixture-role']||'admin';
    if(!allowed.includes(role)) {const e=new Error('Forbidden');e.statusCode=403;throw e;}
    request.claims={roles:[role],branch_ids:[BRANCH],empleado_id:BARBER};
  });
  await app.register(routes,{prefix:'/v1/admin/citas'});
  const get=async path=>{const r=await app.inject({url:'/v1/admin/citas/'+path});assert.equal(r.statusCode,200,r.body+' '+queryError);return r.json().data;};
  const all=[];
  for(let page=1;page<=3;page++){
    const data=await get('historial?page='+page+'&limit=9');
    assert.equal(data.pagination.total,23);assert.equal(data.pagination.total_pages,3);
    assert.equal(data.pagination.has_next,page<3);
    all.push(...data.citas.map(c=>c.id_cita));
  }
  assert.deepEqual(all,expected.reverse());assert.equal(new Set(all).size,23);
  assert.equal((await get('historial?page=99&limit=9')).pagination.total,23);
  assert.deepEqual((await get('historial?page=99&limit=9')).citas,[]);
  assert.deepEqual((await get('historial?estado=completada')).citas,[]);
  for(const page of ['0','-1','1.5','invalid'])assert.equal((await app.inject({url:'/v1/admin/citas/historial?page='+page})).statusCode,400);
  assert.equal((await app.inject({url:'/v1/admin/citas/historial?limit=0.5'})).statusCode,400);
  assert.equal((await app.inject({url:'/v1/admin/citas/historial?id_sucursal=99999999-9999-4999-8999-999999999999'})).statusCode,403);
  assert.equal((await app.inject({url:'/v1/admin/citas/historial',headers:{'x-fixture-role':'barbero'}})).statusCode,403);
  await pg.exec("DELETE FROM citas");
  for(const [i,time] of ['2026-11-12T05:59:59Z','2026-11-12T06:00:00Z','2026-11-13T05:59:59.999999Z','2026-11-13T06:00:00Z'].entries()){
    await pg.query("INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,inicio_at,estado_cita_codigo) VALUES ($1,$2,$3,$4,$5,'confirmada')",['44444444-4444-4444-8444-'+String(i).padStart(12,'0'),BRANCH,BARBER,PERSON,time]);
  }
  for(const zone of ['UTC','Asia/Tokyo','America/Los_Angeles']){
    await pg.exec("SET TIME ZONE '"+zone+"'");
    const day=await get('operativas?fecha_desde=2026-11-12&fecha_hasta=2026-11-12&zona_horaria=America%2FTegucigalpa');
    assert.deepEqual(day.citas.map(c=>c.id_cita.slice(-1)),['1','2']);
    assert.equal((await get('historial?limit=9')).citas.length,4);
  }
});
