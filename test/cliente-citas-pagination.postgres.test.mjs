import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import auth from '../src/plugins/auth.js';
import routes from '../src/routes/v1/citas.js';
import { globalErrorHandler } from '../src/utils/errors.js';

test('Citas Cliente: SQL PostgreSQL aislado y autenticación real', { skip: !process.env.MASTERFADE_TEST_PGLITE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MASTERFADE_TEST_PGLITE));
  const pg = new PGlite(); const app = Fastify(); app.setErrorHandler(globalErrorHandler); t.after(async()=>{await app.close();await pg.close();});
  await pg.exec(`CREATE TABLE citas(id_cita uuid PRIMARY KEY,id_grupo_cita uuid,id_sucursal uuid,id_empleado_barbero uuid,
    id_cliente uuid,id_persona_cliente uuid,deleted_at timestamptz,estado_cita_codigo text,inicio_at timestamptz,fin_at timestamptz,
    duracion_total_min int,buffer_total_min int,total_pagar_hnl numeric,notas text,es_canje_recompensa boolean,orden_integrante int,
    alias_integrante text,created_at timestamptz DEFAULT now());
    CREATE TABLE sucursales(id_sucursal uuid PRIMARY KEY,nombre_sucursal text);
    CREATE TABLE empleados(id_empleado uuid PRIMARY KEY,id_persona uuid);
    CREATE TABLE personas(id_persona uuid PRIMARY KEY,nombres text,apellidos text);
    CREATE TABLE subscription_consumptions(id_cita uuid);
    CREATE TABLE citas_detalles(id_cita_detalle uuid,id_cita uuid,id_servicio uuid,nombre_servicio_snapshot text,id_tarifa uuid,
      cantidad int,duracion_min int,buffer_min int,precio_referencia_hnl numeric,precio_unitario_hnl numeric,subtotal_hnl numeric,
      descuento_hnl numeric,incluye_isv_snapshot boolean,isv_porcentaje numeric,isv_hnl numeric,total_linea_hnl numeric,origen_item_codigo text,created_at timestamptz DEFAULT now());
    CREATE TABLE servicios(id_servicio uuid,nombre_servicio text);
    CREATE TABLE citas_holds(id_hold uuid,id_cita uuid,estado_hold_codigo text,expires_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE payment_intents(id_intent uuid,id_cita uuid,estado_intent_codigo text,link_pago_url text,expires_at timestamptz,
      monto_hnl numeric,moneda_codigo text,created_at timestamptz DEFAULT now());`);
  const owner=randomUUID(),person=randomUUID(),other=randomUUID(),otherPerson=randomUUID(),branch=randomUUID(),barber=randomUUID();
  await pg.query("INSERT INTO sucursales VALUES($1,'Sucursal fixture')",[branch]);
  await pg.query("INSERT INTO personas VALUES($1,'Barbero','fixture')",[person]);
  await pg.query('INSERT INTO empleados VALUES($1,$2)',[barber,person]);
  const profiles=new Map();process.env.JWT_SECRET=randomBytes(48).toString('hex');
  const token=(cliente_id=owner,id_persona=person,roles=['cliente'])=>{const id=randomUUID();profiles.set(id,{id_usuario:id,id_persona,cliente_id,roles});return jwt.sign({sub:id,sid:randomUUID(),jti:randomUUID(),token_type:'app'},process.env.JWT_SECRET,{issuer:'masterfade-api',audience:'masterfade-app',expiresIn:'1h'});};
  let writes=0,sqlError;
  const query=(sql,params)=>{
    if(sql.includes('WITH base_user'))return Promise.resolve({rows:profiles.has(params[0])?[profiles.get(params[0])]:[]});
    if(sql.includes('token_jti_hash = $3'))return Promise.resolve({rows:[{estado:'activa',ultimo_uso_at:new Date(),expira_at:new Date(Date.now()+3600000),revocada_at:null}]});
    if(sql.includes('UPDATE public.seguridad_sesiones'))return Promise.resolve({rows:[],rowCount:0});
    // AM: La caducidad financiera de /pendiente queda fuera de esta prueba de lectura.
    if(sql.includes('UPDATE public.citas_holds')||sql.includes('WITH target_intents')||sql.includes('no_show_at = COALESCE'))return Promise.resolve({rows:[],rowCount:0});
    if(/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)){writes++;throw new Error('escritura inesperada');}
    return pg.query(sql,params).catch(error=>{sqlError=error;throw error;});
  };
  app.decorate('db',{query,connect:async()=>({query,release(){}})});await app.register(cookie);await app.register(auth);await app.register(routes,{prefix:'/v1/citas'});
  const session=token(),foreign=token(other,otherPerson);
  const call=(query='',access=session)=>app.inject({url:'/v1/citas'+query,headers:{cookie:'mf_session='+access}});
  const read=async query=>{const r=await call(query);assert.equal(r.statusCode,200,r.body+' '+sqlError?.message);return r.json().data;};
  const active=['en_espera','pendiente_pago','confirmada','en_salon','en_atencion'];
  const history=['completada','cancelada','cancelada_por_cliente','expirada','no_show','anulada'];
  const insert=async(i,state,{client=owner,persona=person,date='2020-11-12T14:00:00Z',deleted=null}={})=>{
    const id='44444444-4444-4444-8444-'+String(i).padStart(12,'0');
    await pg.query(`INSERT INTO citas(id_cita,id_sucursal,id_empleado_barbero,id_cliente,id_persona_cliente,estado_cita_codigo,inicio_at,fin_at,deleted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '30 minutes',$8)`,[id,branch,barber,client,persona,state,date,deleted]);return id;
  };
  await t.test('0,1,4,5,6,8,9,10,41,56 por apartado, empates estables y contrato tradicional',async()=>{
    for(const count of [0,1,4,5,6,8,9,10,41,56]){
      await pg.exec('TRUNCATE citas,subscription_consumptions');const expected={proximas:[],historial:[]};
      for(let i=1;i<=count;i++){
        expected.proximas.push(await insert(i,active[(i-1)%5]));
        expected.historial.push(await insert(i+100,history[(i-1)%6]));
      }
      for(const apartado of ['proximas','historial']){
        const ids=[];for(let page=1;page<=Math.max(1,Math.ceil(count/4));page++){
          const data=await read(`?apartado=${apartado}&page=${page}&limit=4`);
          assert.deepEqual(data.totals,{proximas:count,historial:count,total:count*2,pendientes_pago:Math.floor((count+3)/5)});
          assert.equal(data.pagination.page,page);assert.equal(data.pagination.total,count);assert.equal(data.pagination.limit,4);
          assert.equal(data.pagination.total_pages,Math.max(1,Math.ceil(count/4)));assert.equal(data.pagination.has_prev,page>1);assert.equal(data.pagination.has_next,page<Math.ceil(count/4));
          assert.ok(data.citas.length<=4);ids.push(...data.citas.map(c=>c.id_cita));
        }
        assert.deepEqual(ids,[...expected[apartado]].reverse());assert.equal(new Set(ids).size,count);
      }
      const legacy=await read('');assert.equal(legacy.citas.length,count*2);assert.equal(legacy.pagination,undefined);
      assert.deepEqual(legacy.citas.map(c=>c.id_cita),[...expected.proximas,...expected.historial].sort().reverse());
    }
    assert.equal(writes,0);
  });
  await t.test('fechas descendentes, página ajustada y vínculos de identidad sin duplicación',async()=>{
    await insert(500,'confirmada',{date:'2040-01-01T06:00:00Z'});await insert(501,'confirmada',{client:other,persona:otherPerson});
    await insert(502,'confirmada',{client:null});await insert(503,'confirmada',{persona:null});await insert(504,'confirmada',{deleted:'2026-01-01'});
    await pg.exec("INSERT INTO subscription_consumptions SELECT id_cita FROM citas WHERE id_cita::text LIKE '%000000000500'; INSERT INTO subscription_consumptions SELECT id_cita FROM subscription_consumptions LIMIT 1;");
    const first=await read('?apartado=proximas');assert.ok(first.citas[0].inicio_at.startsWith('2040'));assert.equal(first.totals.proximas,59);
    const last=await read('?apartado=proximas&page=999');assert.equal(last.pagination.page,15);assert.equal(last.citas.length,3);
    const theirs=await call('?apartado=proximas',foreign);assert.equal(theirs.json().data.totals.total,1);
    assert.equal((await read('?apartado=proximas&id_cliente='+other+'&id_persona_cliente='+otherPerson)).totals.proximas,59);
    assert.equal((await call('/'+first.citas[0].id_cita,foreign)).statusCode,404);
    const detail=await call('/'+first.citas[0].id_cita);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().data.cita.id_cita,first.citas[0].id_cita);
    await pg.exec("DELETE FROM citas WHERE estado_cita_codigo='pendiente_pago'");
    const pending=await call('/pendiente');assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().data.pendiente,null);
    assert.equal(writes,0);
  });
  await t.test('parámetros inválidos, token inválido, perfil y rol requerido',async()=>{
    for(const query of ['?apartado=otra','?page=1','?limit=5','?apartado=proximas&page=0','?apartado=historial&page=-1','?apartado=proximas&page=1.2','?apartado=proximas&page=abc','?apartado=proximas&limit=5','?apartado=proximas&limit=6','?apartado=proximas&limit=0'])assert.equal((await call(query)).statusCode,400,query);
    for(const query of ['?apartado=historial&page=100000001','?apartado=proximas&fecha_desde=2026-11-16&fecha_hasta=2026-11-15','?apartado=proximas&fecha_desde=2026-13-01'])assert.equal((await call(query)).statusCode,400,query);
    assert.equal((await call('?apartado=proximas','invalid')).statusCode,401);
    assert.equal((await app.inject({url:'/v1/citas?apartado=proximas'})).statusCode,401);
    assert.equal((await call('?apartado=proximas',token(owner,person,['barbero']))).statusCode,403);
    assert.equal((await call('?apartado=proximas',token(null,person))).statusCode,409);assert.equal(writes,0);
  });
  await t.test('once estados, pendientes vigentes, detalle y reducción de páginas',async()=>{
    await pg.exec('TRUNCATE citas,citas_holds,payment_intents,subscription_consumptions');
    const all=[...active,...history],ids=[];for(let i=0;i<all.length;i++)ids.push(await insert(i+1,all[i]));
    const prox=await read('?apartado=proximas'),past=await read('?apartado=historial');
    assert.deepEqual(new Set([...prox.citas,...(await read('?apartado=proximas&page=2')).citas].map(c=>c.estado_cita_codigo)),new Set(active));
    const rest=await read('?apartado=historial&page=2');assert.deepEqual(new Set([...past.citas,...rest.citas].map(c=>c.estado_cita_codigo)),new Set(history));
    assert.equal(prox.totals.total,11);assert.equal(prox.totals.pendientes_pago,1);
    const group=randomUUID(),pendingId=ids[1];await pg.query('UPDATE citas SET id_grupo_cita=$1,orden_integrante=1 WHERE id_cita=$2',[group,pendingId]);
    await pg.query("INSERT INTO citas_holds(id_hold,id_cita,estado_hold_codigo,expires_at) VALUES($1,$2,'activo','2099-01-01')",[randomUUID(),pendingId]);
    await pg.query("INSERT INTO payment_intents(id_intent,id_cita,estado_intent_codigo,expires_at,monto_hnl,moneda_codigo) VALUES($1,$2,'creado','2099-01-01',100,'HNL')",[randomUUID(),pendingId]);
    const pending=await call('/pendiente');assert.equal(pending.statusCode,200,pending.body+' '+sqlError?.message);assert.equal(pending.json().data.pendiente.id_grupo_cita,group);assert.equal(pending.json().data.pendiente.vigente,true);
    assert.equal((await call('/pendiente',foreign)).json().data.pendiente,null);
    await pg.query('DELETE FROM citas WHERE id_cita=ANY($1::uuid[])',[[ids[9],ids[10]]]);
    const shrunk=await read('?apartado=historial&page=2');assert.equal(shrunk.pagination.page,1);assert.equal(shrunk.citas.length,4);
    const before=await pg.query('SELECT id_cita,estado_cita_codigo FROM citas ORDER BY id_cita');
    for(let i=0;i<3;i++)await read('?apartado=proximas&page=1');
    assert.deepEqual((await pg.query('SELECT id_cita,estado_cita_codigo FROM citas ORDER BY id_cita')).rows,before.rows);assert.equal(writes,0);
  });
});
