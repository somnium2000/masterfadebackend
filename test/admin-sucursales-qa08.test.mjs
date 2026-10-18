import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/admin/sucursales.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t, { initial = true, concurrent, dependencies = 0, missing = false, sqlError = false, roles = ['super_admin'] } = {}) {
  let state = initial;
  const queries = [];
  const row = () => ({ id_sucursal: ID, id_empresa: COMPANY, nombre_sucursal: 'Sucursal', estado: state });
  const client = { release() {}, async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    queries.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('FOR UPDATE')) return { rows: missing ? [] : [row()], rowCount: missing ? 0 : 1 };
    if (text.includes('AS empleados_activos')) return { rows: [{ empleados_activos: dependencies }], rowCount: 1 };
    if (text.startsWith('UPDATE')) {
      if (sqlError) throw new Error('SQL_PRIVATE_DETAIL');
      if (concurrent !== undefined) state = concurrent;
      if (/estado = \$7/.test(text)) state = params[6];
      if (/estado = \$2/.test(text)) state = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('LOWER(TRIM')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM public.empresas')) return { rows: [{}], rowCount: 1 };
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
test('diagnóstico: dos nombres equivalentes superan precheck simultáneo con UNIQUE exacto simulado', async t => {
  const inserted = [];
  let checks = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const app = Fastify({ logger: false });
  app.decorate('requireRoles', () => async () => {});
  app.decorate('db', { async query(sql, params = []) {
    if (sql.includes('LOWER(TRIM')) {
      checks += 1; if (checks === 2) release(); await barrier;
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO public.sucursales/.test(sql)) {
      assert.ok(!inserted.includes(params[1])); inserted.push(params[1]);
      return { rows: [{ id_sucursal: ID }], rowCount: 1 };
    }
    if (sql.includes('FROM public.empresas')) return { rows: [{}], rowCount: 1 };
    return { rows: [{ id_sucursal: ID, id_empresa: COMPANY, nombre_sucursal: params[1] || 'Sucursal', estado: true }], rowCount: 1 };
  } });
  await app.register(routes, { prefix: '/v1/admin/sucursales' }); t.after(() => app.close());
  const responses = await Promise.all(['Sucursal', 'sucursal'].map(nombre_sucursal => app.inject({ method: 'POST', url: '/v1/admin/sucursales', payload: { id_empresa: COMPANY, nombre_sucursal } })));
  assert.deepEqual(responses.map(r => r.statusCode), [201, 201]);
  assert.equal(inserted.length, 2); assert.equal(new Set(inserted.map(name => name.trim().toLowerCase())).size, 1);
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
