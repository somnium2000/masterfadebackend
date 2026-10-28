import assert from 'node:assert/strict';
import test from 'node:test';
import { findReservationGroupIds } from '../src/services/adminReservationLookup.js';
import Fastify from 'fastify';
import adminCitasRoutes from '../src/routes/v1/admin/citas.js';

const branch = '11111111-1111-4111-8111-111111111111';
async function makeApp(roles = ['admin'], appointments = []) {
  const app = Fastify();
  app.decorate('db', { async query(sql) {
    if (sql.includes('FROM public.sucursales')) return { rows: [{ id_sucursal: branch }] };
    if (sql.includes('WITH RECURSIVE')) return { rows: [...new Set(appointments.map((cita) => cita.id_grupo_cita))].map((id_grupo_cita) => ({ id_grupo_cita })) };
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('FROM public.citas c')) {
      assert.match(sql, /c.id_grupo_cita = ANY/);
      assert.match(sql, /c.id_sucursal = ANY/);
      assert.doesNotMatch(sql, /c.estado_cita_codigo = ANY/);
      return { rows: appointments };
    }
    throw new Error('Unexpected query');
  } });
  app.decorate('requireRoles', (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false });
    request.claims = { roles, branch_ids: [branch] };
  });
  await app.register(adminCitasRoutes, { prefix: '/v1/admin/citas' });
  await app.ready();
  return app;
}

test('HTTP valida codigo y conserva permisos y sucursal', async (t) => {
  for (const [roles, url, status] of [
    [null, '?codigo=GOXBD', 401], [['cliente'], '?codigo=GOXBD', 403],
    [['admin'], '?codigo=INVALID', 400],
    [['admin'], '?codigo=GOXBD&id_sucursal=22222222-2222-4222-8222-222222222222', 403],
    [['admin'], '?codigo=GOXBD', 200],
    [['barbero'], '?codigo=GOXBD', 403],
  ]) await t.test(`${roles} ${url}`, async () => {
    const app = await makeApp(roles);
    try { const result = await app.inject({ url: `/v1/admin/citas/reservas/buscar${url}` }); assert.equal(result.statusCode, status); if (status === 200) assert.deepEqual(result.json().data.reservas, []); }
    finally { await app.close(); }
  });
});

test('HTTP conserva padre completado e hijo confirmado y separa grupos coincidentes', async () => {
  const groupA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', groupB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fixtures = [
    { id_cita: branch, id_grupo_cita: groupA, estado_cita_codigo: 'completada', alias_integrante: 'Padre' },
    { id_cita: groupA, id_grupo_cita: groupA, estado_cita_codigo: 'confirmada', alias_integrante: 'Hijo' },
    { id_cita: groupB, id_grupo_cita: groupB, estado_cita_codigo: 'en_salon', alias_integrante: 'Otra reserva' },
  ].map((row) => ({ ...row, inicio_at: '2026-10-28T14:00:00Z', fin_at: '2026-10-28T14:30:00Z', id_sucursal: branch }));
  const app = await makeApp(['admin'], fixtures);
  try {
    const result = await app.inject({ url: '/v1/admin/citas/reservas/buscar?codigo=GOXBD' });
    assert.equal(result.statusCode, 200);
    const groups = result.json().data.reservas;
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].citas.map((cita) => cita.estado_cita_codigo), ['completada', 'confirmada']);
    assert.equal(groups[1].citas.length, 1);
  } finally { await app.close(); }
});

test('rechaza codigo invalido sin consultar datos', async () => {
  let calls = 0;
  const db = { query() { calls++; } };
  await assert.rejects(findReservationGroupIds(db, { code: 'bad!', branchIds: [] }));
  assert.equal(calls, 0);
});

test('consulta exacta conserva colisiones y aplica alcance en SQL', async () => {
  const db = { async query(sql, values) {
    assert.match(sql, /c.id_sucursal = ANY\(\$1::uuid\[\]\)/);
    assert.match(sql, /c.id_empleado_barbero = \$2::uuid/);
    assert.equal(values[2], parseInt('GOXBD', 36));
    assert.doesNotMatch(sql, /estado_cita_codigo\s*=/);
    return { rows: [{ id_grupo_cita: 'group-a' }, { id_grupo_cita: 'group-b' }] };
  } };
  assert.deepEqual(await findReservationGroupIds(db, { code: ' goxbd ', branchIds: ['branch'], barberId: 'barber' }), ['group-a', 'group-b']);
});
