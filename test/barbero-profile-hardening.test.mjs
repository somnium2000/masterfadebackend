import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import routes from '../src/routes/v1/barbero.js';
import { globalErrorHandler } from '../src/utils/errors.js';
const USER = '11111111-1111-4111-8111-111111111111';
const PERSON = '21111111-1111-4111-8111-111111111111';
const EMPLOYEE = '31111111-1111-4111-8111-111111111111';
async function fixture(t, { role = 'barbero', fail, sqlstate = '23514', missing = false, zeroUpdated = false } = {}) {
  const state = { row: { id_usuario: USER, id_persona: PERSON, id_empleado: EMPLOYEE, nombres: 'QA', es_barbero: true,
    telefono_principal: '99990000', fecha_nacimiento: '1990-01-01', genero_codigo: 'M', direccion_texto: 'Inicial', dni: '1234567890123' }, calls: [], commits: 0, releases: 0 };
  let tail = Promise.resolve();
  const error = () => Object.assign(new Error('SQL_INTERNAL_SYNTHETIC'), { code: sqlstate });
  const connect = async () => {
    if (fail === 'connect') throw error();
    let pending, unlock, reads = 0, committed = false;
    return { release(releaseError) { state.releases++; state.discarded = Boolean(releaseError); unlock?.(); unlock = null; }, async query(sql, params = []) {
      const text = sql.trim(); state.calls.push({ sql: text, params });
      if (committed) throw new Error('No queries allowed after COMMIT');
      if (text === 'BEGIN') { if (fail === 'begin') throw error(); return { rows: [] }; }
      if (text === 'ROLLBACK') { if (fail === 'rollback') throw error(); unlock?.(); unlock = null; return { rows: [] }; }
      if (text === 'COMMIT') { if (fail === 'commit') throw error(); state.row = pending ?? state.row; state.commits++; committed = true; unlock?.(); unlock = null; return { rows: [] }; }
      if (text.includes('FROM public.empleados e')) {
        assert.deepEqual(params, [USER]); assert.match(sql, /u.id_usuario = \$1::uuid/);
        if (text.includes('FOR UPDATE')) {
          const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
          pending = { ...state.row };
        }
        reads++;
        if (fail === 'refresh' && reads === 2) throw error();
        return { rows: missing ? [] : [{ ...(pending ?? state.row) }] };
      }
      if (text.includes('FROM public.generos')) return { rows: ['M', 'F', 'N', 'NB', 'O'].includes(params[0]) ? [{ genero_codigo: params[0] }] : [] };
      if (text.includes('UPDATE public.personas')) {
        assert.equal(params[0], PERSON);
        if (fail === 'update' || fail === 'rollback') throw error();
        if (zeroUpdated) return { rows: [], rowCount: 0 };
        pending ??= { ...state.row };
        const assignments = text.split('SET')[1].split('WHERE')[0];
        for (const match of assignments.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) pending[match[1]] = params[Number(match[2]) - 1];
        return { rows: [], rowCount: 1 };
      }
      if (fail === 'summary' && text.includes('FROM public.citas c')) throw error();
      return { rows: [] };
    } };
  };
  const app = Fastify(); t.after(() => app.close());
  app.setErrorHandler(globalErrorHandler);
  // AM: Todo acceso es sintético; incluso la lectura posterior debe usar el cliente transaccional.
  app.decorate('db', { connect, query: async () => { throw new Error('Pool read outside transaction'); } });
  app.decorate('requireRoles', allowed => async (request, reply) => {
    request.claims = { user: { id_usuario: USER }, roles: role ? [role] : [] };
    if (!role || !allowed.includes(role)) return reply.code(role ? 403 : 401).send({ error: { code: 'AUTH_REQUIRED' } });
  });
  await app.register(routes, { prefix: '/v1/barbero' });
  return { app, state, patch: (payload, query = '') => app.inject({ method: 'PATCH', url: '/v1/barbero/perfil' + query, payload }) };
}
for (const field of ['dni', 'rtn', 'observaciones', 'id_persona', 'id_usuario', 'roles', 'id_sucursal', 'foto_perfil_asset_id']) {
  test(`rechaza campo no editable ${field}, incluso junto al telefono`, async t => {
    const { patch, state } = await fixture(t);
    const r = await patch({ telefono_principal: '99991111', [field]: 'dato ajeno' });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error.code, 'BARBER_PROFILE_FIELDS_FORBIDDEN'); assert.equal(state.calls.length, 0);
  });
}
test('query manipulado no cambia identidad y PATCH no reescribe campos omitidos', async t => {
  const { patch, state } = await fixture(t);
  const r = await patch({ telefono_principal: ' +504 (9999)-1111 ' }, '?id_usuario=otro&id_persona=ajena');
  assert.equal(r.statusCode, 200); assert.equal(state.row.telefono_principal, '+50499991111');
  assert.equal(state.row.direccion_texto, 'Inicial'); assert.equal(state.row.dni, '1234567890123');
  const update = state.calls.find(q => q.sql.includes('UPDATE public.personas'));
  assert.doesNotMatch(update.sql, /SET[^]*\b(?:dni|rtn|observaciones|fecha_nacimiento|genero_codigo|direccion_texto)\s*=/);
  assert.deepEqual(update.params, [PERSON, '+50499991111']);
});
for (const value of [null, '', 'abc', '1234567', '+1234567', '9999abc9999', '9'.repeat(21), '++50499991111', '9999<1111']) {
  test(`rechaza telefono invalido ${JSON.stringify(value)}`, async t => {
    const { patch, state } = await fixture(t); const r = await patch({ telefono_principal: value });
    assert.equal(r.statusCode, 422); assert.equal(state.commits, 0); assert.equal(state.row.telefono_principal, '99990000');
    assert.ok(state.calls.some(q => q.sql === 'ROLLBACK'));
  });
}
test('nulos opcionales limpian solo los campos presentes', async t => {
  const { patch, state } = await fixture(t); const r = await patch({ fecha_nacimiento: null, genero_codigo: null, direccion_texto: null });
  assert.equal(r.statusCode, 200); assert.equal(state.row.fecha_nacimiento, null); assert.equal(state.row.genero_codigo, null); assert.equal(state.row.direccion_texto, null); assert.equal(state.row.telefono_principal, '99990000');
});
test('género se normaliza contra catálogo y dirección se recorta', async t => {
  const { patch, state } = await fixture(t); const r = await patch({ genero_codigo: ' femenino ', direccion_texto: ' Nueva direccion ' });
  assert.equal(r.statusCode, 200); assert.equal(state.row.genero_codigo, 'F'); assert.equal(state.row.direccion_texto, 'Nueva direccion');
  assert.equal((await patch({ genero_codigo: 'inexistente' })).statusCode, 422);
});
for (const now of ['2026-10-27T05:59:59Z', '2026-10-27T06:00:00Z']) {
  test(`límite calendario Tegucigalpa ${now}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    const { patch, state } = await fixture(t); const r = await patch({ fecha_nacimiento: '2026-10-27' });
    assert.equal(r.statusCode, now.includes('05:59') ? 400 : 200);
    assert.equal(state.commits, now.includes('05:59') ? 0 : 1);
  });
}
for (const date of ['2026-02-30', '2025-02-29', '2026-13-01', '9999-01-01', '2026-10-27T00:00:00Z']) {
  test(`rechaza fecha inválida/futura ${date}`, async t => {
    const { patch, state } = await fixture(t); assert.equal((await patch({ fecha_nacimiento: date })).statusCode, 400); assert.equal(state.commits, 0);
  });
}
test('fecha bisiesta válida persiste sin conversión horaria', async t => {
  const { patch, state } = await fixture(t); assert.equal((await patch({ fecha_nacimiento: '2024-02-29' })).statusCode, 200); assert.equal(state.row.fecha_nacimiento, '2024-02-29');
});
for (const [sqlstate, status] of [['23505',409],['23514',422],['23502',422],['23503',422],['22001',422],['40001',409],['40P01',409],['08006',503]]) {
  test(`restricción ${sqlstate}: respuesta funcional y rollback`, async t => {
    const { patch, state } = await fixture(t, { fail: 'update', sqlstate }); const r = await patch({ direccion_texto: 'Nueva' });
    assert.equal(r.statusCode, status); assert.ok(!r.body.includes('SQL_INTERNAL')); assert.equal(state.commits, 0); assert.equal(state.row.direccion_texto, 'Inicial'); assert.ok(state.calls.some(q => q.sql === 'ROLLBACK')); assert.equal(state.releases, 1);
  });
}
for (const fail of ['refresh', 'summary', 'commit']) {
  test(`fallo ${fail} antes de confirmar revierte todo`, async t => {
    const { patch, state } = await fixture(t, { fail, sqlstate: 'XX000' }); const r = await patch({ direccion_texto: 'Nueva' });
    assert.equal(r.statusCode, 500); assert.equal(state.commits, 0); assert.equal(state.row.direccion_texto, 'Inicial'); assert.ok(!r.body.includes('SQL_INTERNAL')); assert.ok(state.calls.some(q => q.sql === 'ROLLBACK'));
  });
}
test('fallo al conectar es controlado, sin liberar cliente inexistente', async t => {
  const { patch, state } = await fixture(t, { fail: 'connect', sqlstate: '08006' }); assert.equal((await patch({ direccion_texto: 'Nueva' })).statusCode, 503); assert.equal(state.releases, 0);
});
test('fallo de rollback descarta el cliente sin filtrar errores técnicos', async t => {
  const { patch, state } = await fixture(t, { fail: 'rollback' }); const r = await patch({ direccion_texto: 'Nueva' });
  assert.equal(r.statusCode, 422); assert.equal(state.discarded, true); assert.equal(state.releases, 1); assert.equal(state.commits, 0); assert.ok(!r.body.includes('SQL_INTERNAL'));
});
test('perfil inexistente y actualización sin fila no confirman escritura', async t => {
  for (const options of [{ missing: true }, { zeroUpdated: true }]) {
    const { patch, state } = await fixture(t, options); assert.equal((await patch({ direccion_texto: 'Nueva' })).statusCode, 404); assert.equal(state.commits, 0); assert.ok(state.calls.some(q => q.sql === 'ROLLBACK'));
  }
});
test('éxito no consulta tras COMMIT y devuelve el perfil actualizado', async t => {
  const { patch, state } = await fixture(t); const r = await patch({ telefono_principal: '99991111' });
  assert.equal(r.statusCode, 200); assert.equal(r.json().data.perfil.telefono_principal, '99991111'); assert.equal(state.calls.at(-1).sql, 'COMMIT'); assert.equal(state.releases, 1);
});
test('dos PATCH concurrentes no pierden cambios en campos diferentes', async t => {
  const { patch, state } = await fixture(t);
  const responses = await Promise.all([patch({ telefono_principal: '99991111' }), patch({ direccion_texto: 'Direccion concurrente' })]);
  assert.deepEqual(responses.map(r => r.statusCode), [200,200]); assert.equal(state.row.telefono_principal, '99991111'); assert.equal(state.row.direccion_texto, 'Direccion concurrente'); assert.equal(state.commits, 2);
});
test('cuerpo vacío no abre transacción', async t => {
  const { patch, state } = await fixture(t); assert.equal((await patch({})).statusCode, 400); assert.equal(state.calls.length, 0);
});
