import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/superDashboard.js';
import { startPostgres17 } from './helpers/postgres17.mjs';
import { randomUUID } from 'node:crypto';

async function fixture(t, role = 'super_admin', row = {}, database = null) {
  const app = Fastify();
  const calls = [];
  app.decorate('db', { query: async (sql, params) => {
    calls.push({ sql, params });
    if (database) return database.query(sql,params);
    return { rows: [{
      total_citas: '124', ingresos_citas_hnl_total: '34.00', ingresos_citas_hnl_periodo: '3.00',
      planes_activados: '2', masterpuntos_canjeados: '3',
      ingresos_serie: [{ periodo: '2026-11-08T10:00:00', ingresos_hnl: '3.00' }],
      actividad_serie: [{ periodo: '2026-11-08T00:00:00', planes_activados: '2', masterpuntos_canjeados: '3' }],
      ...row,
    }] };
  } });
  app.decorate('requireRoles', (allowed) => async (_request, reply) => {
    if (!role) return reply.code(401).send({ ok: false });
    if (!allowed.includes(role)) return reply.code(403).send({ ok: false });
  });
  await app.register(routes, { prefix: '/v1/admin/super-dashboard' });
  await app.ready();
  t.after(() => app.close());
  return { app, calls };
}

test('SQL real: citas validas historicas sin duplicados y resto de agregados intactos',async t=>{
  const pg=await startPostgres17();t.after(()=>pg.stop());
  await pg.client.query(`
    CREATE TABLE citas (id_cita uuid PRIMARY KEY, estado_cita_codigo text, deleted_at timestamptz, total_pagar_hnl numeric);
    CREATE TABLE payment_intents (id_intent uuid PRIMARY KEY, id_cita uuid REFERENCES citas);
    CREATE TABLE payments (id_payment uuid PRIMARY KEY, id_intent uuid REFERENCES payment_intents, estado_pago_codigo text, monto_hnl numeric, paid_at timestamptz);
    CREATE TABLE subscriptions (id_suscripcion uuid PRIMARY KEY, inicio_at timestamptz);
    CREATE TABLE points_transactions (id_points_tx uuid PRIMARY KEY, tipo_puntos_codigo text, created_at timestamptz);
    CREATE TABLE citas_detalles (id_detalle uuid PRIMARY KEY, id_cita uuid REFERENCES citas);
  `);
  const {app,calls}=await fixture(t,'super_admin',{},pg.client);
  const add=async(state,deleted=null)=>{
    const id=randomUUID();await pg.client.query('INSERT INTO citas VALUES ($1,$2,$3,0)',[id,state,deleted]);return id;
  };
  const get=async(from='2026-11-01',to='2026-11-08')=>{
    const r=await app.inject('/v1/admin/super-dashboard/summary?fecha_desde='+from+'&fecha_hasta='+to);
    assert.equal(r.statusCode,200,r.body);return r.json().data;
  };
  for(let i=0;i<3;i++)await add('expirada');
  assert.equal((await get()).total_citas,0);
  const valid=[];
  for(const state of ['confirmada','en_salon','en_atencion','completada'])valid.push(await add(state));
  assert.equal((await get()).total_citas,4,'citas cubiertas por beneficios sin importe ni pago cuentan');
  for(const state of ['en_espera','pendiente_pago','expirada','cancelada','anulada','no_show'])await add(state);
  for(const state of ['confirmada','en_salon','en_atencion','completada'])await add(state,'2026-11-01T00:00:00Z');
  assert.equal((await get()).total_citas,4);
  for(let i=0;i<3;i++){
    const intent=randomUUID();await pg.client.query('INSERT INTO payment_intents VALUES ($1,$2)',[intent,valid[0]]);
    await pg.client.query('INSERT INTO payments VALUES ($1,$2,$3,10,$4)',[randomUUID(),intent,'capturado','2026-11-02T12:00:00Z']);
    await pg.client.query('INSERT INTO citas_detalles VALUES ($1,$2)',[randomUUID(),valid[0]]);
  }
  await pg.client.query('INSERT INTO subscriptions VALUES ($1,$2)',[randomUUID(),'2026-11-02T12:00:00Z']);
  await pg.client.query('INSERT INTO points_transactions VALUES ($1,$2,$3)',[randomUUID(),'canjear','2026-11-02T12:00:00Z']);
  const result=await get();assert.equal(result.total_citas,4);
  assert.equal(result.ingresos_citas_hnl_periodo,30);assert.equal(result.planes_activados,1);assert.equal(result.masterpuntos_canjeados,1);
  assert.equal(result.ingresos_serie.reduce((sum,x)=>sum+x.ingresos_hnl,0),30);
  assert.equal(result.actividad_serie.reduce((sum,x)=>sum+x.planes_activados,0),1);
  assert.equal(result.actividad_serie.reduce((sum,x)=>sum+x.masterpuntos_canjeados,0),1);
  for(const [from,to] of [['2020-01-01','2020-01-01'],['2026-01-15','2026-06-20'],['2024-03-15','2026-05-20']])assert.equal((await get(from,to)).total_citas,4);
  const {sql,params}=calls.at(-1);
  const baseline=(await pg.client.query(sql.replace('AND c.estado_cita_codigo = ANY($5::text[])',''),params.slice(0,4))).rows[0];
  const current=(await pg.client.query(sql,params)).rows[0];
  delete baseline.total_citas;delete current.total_citas;assert.deepEqual(current,baseline);
});

test('protege el resumen para super_admin', async (t) => {
  const anonymous = await fixture(t, null);
  assert.equal((await anonymous.app.inject('/v1/admin/super-dashboard/summary')).statusCode, 401);
  const admin = await fixture(t, 'admin');
  assert.equal((await admin.app.inject('/v1/admin/super-dashboard/summary')).statusCode, 403);
});

test('devuelve los cuatro KPIs y un rango inclusivo de Honduras', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-01&fecha_hasta=2026-11-08');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.data.periodo, { fecha_desde: '2026-11-01', fecha_hasta: '2026-11-08' });
  assert.equal(body.data.timezone, 'America/Tegucigalpa');
  assert.deepEqual([
    body.data.total_citas, body.data.ingresos_citas_hnl_total, body.data.ingresos_citas_hnl_periodo,
    body.data.planes_activados, body.data.masterpuntos_canjeados,
  ], [124, 34, 3, 2, 3]);
  assert.deepEqual(calls[0].params.slice(1, 4), ['2026-11-01T06:00:00.000Z', '2026-11-09T06:00:00.000Z', 'day']);
  assert.deepEqual(body.data.ingresos_serie, [{ periodo: '2026-11-08T10:00:00', ingresos_hnl: 3 }]);
  assert.deepEqual(body.data.actividad_serie, [{ periodo: '2026-11-08T00:00:00', planes_activados: 2, masterpuntos_canjeados: 3 }]);
});

test('rechaza fechas invalidas sin consultar la base', async (t) => {
  const { app, calls } = await fixture(t);
  assert.equal((await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-02-30')).statusCode, 400);
  assert.equal((await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-09&fecha_hasta=2026-11-08')).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('la consulta es agregada, parametrizada y de solo lectura', async (t) => {
  const { app, calls } = await fixture(t);
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-08&fecha_hasta=2026-11-08');
  const sql = calls[0].sql;
  assert.match(sql, /COUNT\(c\.id_cita\)/);
  assert.match(sql, /SELECT DISTINCT p\.id_payment, p\.monto_hnl, p\.paid_at/);
  assert.match(sql, /JOIN public\.payment_intents pi ON pi\.id_intent = p\.id_intent/);
  assert.match(sql, /JOIN public\.citas c ON c\.id_cita = pi\.id_cita/);
  assert.match(sql, /SUM\(ep\.monto_hnl\)/);
  assert.match(sql, /p\.paid_at IS NOT NULL/);
  assert.match(sql, /COUNT\(s\.id_suscripcion\)/);
  assert.match(sql, /COUNT\(DISTINCT pt\.id_points_tx\)/);
  assert.match(sql, /tipo_puntos_codigo = 'canjear'/);
  assert.match(sql, /WITH RECURSIVE range_config/);
  assert.match(sql, /WHEN 'month' THEN date_trunc\('month', \$2::timestamptz/);
  assert.match(sql, /WHEN 'year' THEN date_trunc\('year', \$2::timestamptz/);
  assert.match(sql, /GREATEST\(b\.bucket, rc\.local_from\)/);
  assert.match(sql, /LEAST\(b\.bucket \+ rc\.step, rc\.local_to\)/);
  assert.match(sql, /COALESCE\(\(SELECT SUM\(ep\.monto_hnl\)/);
  assert.doesNotMatch(sql, /subscription_payments|citas_detalles|total_pagar_hnl/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.deepEqual(calls[0].params[0], ['capturado', 'conciliado', 'manual_pagado']);
  assert.deepEqual(calls[0].params[4], ['confirmada','en_salon','en_atencion','completada']);
  assert.match(sql, /c\.estado_cita_codigo = ANY\(\$5::text\[\]\)/);
});

test('conserva buckets sin actividad y totales de series verificables', async (t) => {
  const { app } = await fixture(t, 'super_admin', {
    ingresos_citas_hnl_periodo: '5.00',
    planes_activados: '1',
    masterpuntos_canjeados: '2',
    ingresos_serie: [
      { periodo: '2026-11-01T00:00:00', ingresos_hnl: '2.00' },
      { periodo: '2026-11-02T00:00:00', ingresos_hnl: '0.00' },
      { periodo: '2026-11-03T00:00:00', ingresos_hnl: '3.00' },
    ],
    actividad_serie: [
      { periodo: '2026-11-01T00:00:00', planes_activados: '0', masterpuntos_canjeados: '1' },
      { periodo: '2026-11-02T00:00:00', planes_activados: '0', masterpuntos_canjeados: '0' },
      { periodo: '2026-11-03T00:00:00', planes_activados: '1', masterpuntos_canjeados: '1' },
    ],
  });
  const body = (await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-01&fecha_hasta=2026-11-03')).json().data;
  assert.equal(body.ingresos_serie.reduce((sum, item) => sum + item.ingresos_hnl, 0), body.ingresos_citas_hnl_periodo);
  assert.equal(body.actividad_serie.reduce((sum, item) => sum + item.planes_activados, 0), body.planes_activados);
  assert.equal(body.actividad_serie.reduce((sum, item) => sum + item.masterpuntos_canjeados, 0), body.masterpuntos_canjeados);
  assert.equal(body.ingresos_serie[1].ingresos_hnl, 0);
});

test('agrupa hoy por hora y rangos extensos de forma acotada', async (t) => {
  const { app, calls } = await fixture(t);
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-11-08&fecha_hasta=2026-11-08');
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-01-01&fecha_hasta=2026-11-08');
  assert.equal(calls[0].params[3], 'hour');
  assert.equal(calls[1].params[3], 'month');
});

test('períodos parciales de mes y año conservan límites reales', async (t) => {
  const { app, calls } = await fixture(t);
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2026-01-15&fecha_hasta=2026-06-20');
  await app.inject('/v1/admin/super-dashboard/summary?fecha_desde=2024-03-15&fecha_hasta=2026-05-20');
  assert.deepEqual(calls[0].params.slice(1, 4), ['2026-01-15T06:00:00.000Z', '2026-06-21T06:00:00.000Z', 'month']);
  assert.deepEqual(calls[1].params.slice(1, 4), ['2024-03-15T06:00:00.000Z', '2026-05-21T06:00:00.000Z', 'year']);
});
