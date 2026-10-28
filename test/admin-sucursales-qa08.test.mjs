import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/sucursales.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
for (const name of ['empleados_activos','roles_activos','tarifas_activas','citas_futuras_activas']) test(`dependencia ${name} bloquea DELETE legacy sin borrado físico`,async t=>{
  const {app,queries}=await fixture(t,{dependencies:{[name]:1}});
  const r=await app.inject({method:'DELETE',url:`/v1/admin/sucursales/${ID}`});
  assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error.details[name],1);
  assert.equal(queries.some(q=>/^(UPDATE|DELETE)/.test(q.text)),false);
});
for(const body of [{id_empresa:COMPANY,nombre_sucursal:' '},{id_empresa:COMPANY,nombre_sucursal:'Nueva',telefono:'abcabc'},{id_empresa:'invalid',nombre_sucursal:'Nueva'}])test(`validación creación ${JSON.stringify(body)}`,async t=>{
  const {app,queries}=await fixture(t);const r=await app.inject({method:'POST',url:'/v1/admin/sucursales',payload:body});assert.equal(r.statusCode,400,r.body);assert.equal(queries.some(q=>q.text.startsWith('INSERT')),false);
});
test('empresa inexistente no crea sucursal',async t=>{const {app,queries}=await fixture(t,{missingCompany:true});const r=await app.inject({method:'POST',url:'/v1/admin/sucursales',payload:{id_empresa:COMPANY,nombre_sucursal:'Nueva'}});assert.equal(r.statusCode,400,r.body);assert.equal(queries.some(q=>q.text.startsWith('INSERT')),false);});
test('23505 concurrente devuelve 409 sin detalle SQL',async t=>{const {app,queries}=await fixture(t,{uniqueError:true});const r=await app.inject({method:'POST',url:'/v1/admin/sucursales',payload:{id_empresa:COMPANY,nombre_sucursal:'Nueva'}});assert.equal(r.statusCode,409,r.body);assert.equal(r.body.includes('SQL_PRIVATE_DETAIL'),false);assert.equal(queries.at(-1).text,'ROLLBACK');});
test('DELETE legacy exitoso solo actualiza estado de su sucursal',async t=>{const {app,queries}=await fixture(t);const r=await app.inject({method:'DELETE',url:`/v1/admin/sucursales/${ID}`});assert.equal(r.statusCode,200);assert.equal(r.json().data.sucursal.estado,false);assert.equal(queries.some(q=>q.text.startsWith('DELETE')),false);assert.ok(queries.filter(q=>q.text.startsWith('UPDATE')).every(q=>q.params[0]===ID));});
async function fixture(t, { initial = true, concurrent, dependencies = 0, missing = false, missingCompany = false, uniqueError = false, sqlError = false, roles = ['super_admin'] } = {}) {
  let state = initial;
  const queries = [];
  const row = () => ({ id_sucursal: ID, id_empresa: COMPANY, nombre_sucursal: 'Sucursal', estado: state });
  const client = { release() {}, async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    queries.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('FOR UPDATE') && !text.includes('FROM public.empresas')) return { rows: missing ? [] : [row()], rowCount: missing ? 0 : 1 };
    if (text.includes('AS empleados_activos')) return { rows: [typeof dependencies === 'object' ? dependencies : { empleados_activos: dependencies }], rowCount: 1 };
    if (text.startsWith('INSERT') && uniqueError) throw Object.assign(new Error('SQL_PRIVATE_DETAIL'), { code: '23505' });
    if (text.startsWith('UPDATE')) {
      if (sqlError) throw new Error('SQL_PRIVATE_DETAIL');
      if (concurrent !== undefined) state = concurrent;
      if (/estado = \$7/.test(text)) state = params[6];
      if (/estado = \$2/.test(text)) state = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('LOWER(TRIM')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM public.empresas')) return { rows: missingCompany ? [] : [{}], rowCount: missingCompany ? 0 : 1 };
    return { rows: missing ? [] : [row()], rowCount: missing ? 0 : 1 };
  } };
  const app = Fastify({ logger: false });
  app.decorate('db', { query: client.query.bind(client), connect: async () => client });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { roles };
    if (!roles.some(role => allowed.includes(role))) return reply.code(403).send({ error: 'Forbidden' });
  });
  await app.register(routes, { prefix: '/v1/admin/sucursales' });
  t.after(() => app.close());
  return { app, queries };
}
for (const initial of [true, false]) for (const concurrent of [undefined, !initial]) {
  test(`edición descriptiva preserva estado: inicial=${initial}, concurrente=${concurrent}`, async t => {
    const { app, queries } = await fixture(t, { initial, concurrent });
    const response = await app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}`, payload: { direccion: 'Nueva dirección' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.sucursal.estado, concurrent ?? initial);
    assert.doesNotMatch(queries.find(q => q.text.startsWith('UPDATE')).text, /\bestado\s*=/);
  });
}
for (const estado of [true, false]) test(`PATCH estado explícito ${estado}`, async t => {
  const { app, queries } = await fixture(t, { initial: !estado });
  const response = await app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}`, payload: { estado } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.sucursal.estado, estado);
  assert.ok(queries.some(q => q.text.includes('FOR UPDATE')));
  assert.equal(queries[0].text, 'BEGIN');
  assert.equal(queries.at(-1).text, 'COMMIT');
});
test('dependencias impiden inactivación y provocan rollback', async t => {
  const { app, queries } = await fixture(t, { dependencies: 1 });
  const response = await app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}`, payload: { estado: false } });
  assert.equal(response.statusCode, 409);
  assert.ok(!queries.some(q => q.text.startsWith('UPDATE')));
  assert.equal(queries.at(-1).text, 'ROLLBACK');
});
for (const [options, id, expected] of [[{}, 'invalid', 400], [{ missing: true }, ID, 404], [{ roles: ['admin'] }, ID, 403], [{ sqlError: true }, ID, 500]]) test(`error controlado ${expected}`, async t => {
  const { app, queries } = await fixture(t, options);
  const response = await app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${id}`, payload: { nombre_sucursal: 'Nueva' } });
  assert.equal(response.statusCode, expected);
  assert.ok(!response.body.includes('SQL_PRIVATE_DETAIL'));
  if ([400, 403].includes(expected)) assert.equal(queries.length, 0);
});

for (const action of ['activar', 'inactivar', 'delete']) test(`transición ${action} usa transacción y bloqueo de sucursal`, async t => {
  const { app, queries } = await fixture(t, { initial: action !== 'activar' });
  const response = await app.inject({ method: action === 'delete' ? 'DELETE' : 'PATCH', url: `/v1/admin/sucursales/${ID}${action === 'delete' ? '' : `/${action}`}` });
  assert.equal(response.statusCode, 200);
  const lock = queries.findIndex(q => q.text.includes('FOR UPDATE'));
  const update = queries.findIndex(q => q.text.startsWith('UPDATE'));
  assert.ok(lock > 0 && update > lock);
  assert.equal(queries[0].text, 'BEGIN'); assert.equal(queries.at(-1).text, 'COMMIT');
});
test('error SQL durante transición explícita hace rollback', async t => {
  const { app, queries } = await fixture(t, { sqlError: true });
  const response = await app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}`, payload: { estado: false } });
  assert.equal(response.statusCode, 500); assert.equal(queries.at(-1).text, 'ROLLBACK');
  assert.ok(!response.body.includes('SQL_PRIVATE_DETAIL'));
});
test('nombres equivalentes concurrentes se serializan por empresa', async t => {
  const inserted = [];
  let tail = Promise.resolve();
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', () => async () => {});
  app.decorate('db', { async connect() {
    let unlock;
    return { release() {}, async query(sql, params = []) {
      if (sql.includes('FROM public.empresas') && sql.includes('FOR UPDATE')) {
        const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
        return { rows: [{}], rowCount: 1 };
      }
      if (/^(COMMIT|ROLLBACK)$/.test(sql)) { unlock?.(); return { rows: [], rowCount: 0 }; }
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql.includes('LOWER(TRIM')) {
        const found = inserted.some(name => name.trim().toLowerCase() === params[1].trim().toLowerCase());
        return { rows: found ? [{ id_sucursal: ID }] : [], rowCount: found ? 1 : 0 };
      }
      if (/INSERT INTO public.sucursales/.test(sql)) {
        inserted.push(params[1]); return { rows: [{ id_sucursal: ID }], rowCount: 1 };
      }
      return { rows: [{ id_sucursal: ID, id_empresa: COMPANY, nombre_sucursal: 'Sucursal', estado: true }], rowCount: 1 };
    } };
  } });
  await app.register(routes, { prefix: '/v1/admin/sucursales' }); t.after(() => app.close());
  const responses = await Promise.all(['Sucursal', 'sucursal'].map(nombre_sucursal => app.inject({ method: 'POST', url: '/v1/admin/sucursales', payload: { id_empresa: COMPANY, nombre_sucursal } })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
  assert.equal(inserted.length, 1);
});

test('activación e inactivación concurrentes esperan el bloqueo y releen estado', async t => {
  let state = true, owner = null, waiting = false, allowFirst;
  const firstGate = new Promise(resolve => { allowFirst = resolve; });
  let unlock;
  const unlocked = new Promise(resolve => { unlock = resolve; });
  const events = [];
  let clients = 0;
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', () => async () => {});
  app.decorate('db', { async connect() {
    const number = ++clients;
    return { release() {}, async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text === 'BEGIN') return { rows: [] };
      if (text === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return { rows: [] };
      if (text.includes('FOR UPDATE')) {
        if (owner) { waiting = true; await unlocked; }
        owner = number; events.push(`lock${number}`);
        if (number === 1) await firstGate;
        return { rows: [{ id_sucursal: ID }], rowCount: 1 };
      }
      if (text === 'COMMIT') { events.push(`commit${number}`); owner = null; if (number === 1) unlock(); return { rows: [] }; }
      assert.equal(owner, number);
      if (text.includes('AS empleados_activos')) return { rows: [{ empleados_activos: 0 }], rowCount: 1 };
      if (text.startsWith('UPDATE')) { state = params[1]; events.push(`state${state}`); return { rows: [], rowCount: 1 }; }
      return { rows: [{ id_sucursal: ID, id_empresa: COMPANY, nombre_sucursal: 'Sucursal', estado: state }], rowCount: 1 };
    } };
  } });
  await app.register(routes, { prefix: '/v1/admin/sucursales' }); await app.ready(); t.after(() => app.close());
  const first = app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}/inactivar` });
  while (!owner) await new Promise(resolve => setImmediate(resolve));
  const second = app.inject({ method: 'PATCH', url: `/v1/admin/sucursales/${ID}/activar` });
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state, true); allowFirst();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => r.statusCode), [200, 200]); assert.equal(state, true);
  assert.deepEqual(events, ['lock1', 'statefalse', 'commit1', 'lock2', 'statetrue', 'commit2']);
});
