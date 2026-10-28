import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Fastify from 'fastify';
import publicCitasRoutes from '../src/routes/v1/public/citas.js';
import publicPagosRoutes from '../src/routes/v1/public/pagos.js';
import { buildCanonicalReservationPayload, createCanonicalReservation } from '../src/services/bookingCanonicalReservationService.js';

const pagos = readFileSync(new URL('../src/routes/v1/public/pagos.js', import.meta.url), 'utf8');
const citas = readFileSync(new URL('../src/routes/v1/public/citas.js', import.meta.url), 'utf8');
function extract(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last).trim();
}
class ErrorDouble extends Error {
  constructor(statusCode, message, options) { super(message); this.statusCode = statusCode; Object.assign(this, options); }
}
const load = vm.runInNewContext('(' + extract(pagos, 'async function loadPublicGroup(', 'function assertPublicGroupPayable(') + ')', {
  AppError: ErrorDouble, normalizeEmail: value => String(value || '').trim().toLowerCase(),
});
const guest = vm.runInNewContext('(' + extract(citas, 'async function resolveOrCreatePublicClient(', 'export default async function publicCitasRoutes') + ')', {
  buildFullName: (first, last) => [first, last].filter(Boolean).join(' '),
  splitFullName: name => ({ nombres: name.split(' ')[0], apellidos: name.split(' ').slice(1).join(' ') }),
});
const group = '11111111-1111-4111-8111-111111111111';
const persona = '22222222-2222-4222-8222-222222222222';
const email = 'titular@example.test';
const base = () => ({ id_grupo_cita: group, id_persona_titular: persona, id_persona_cliente: persona,
  id_cliente_titular: null, orden_integrante: 1, id_cita: 'appointment', id_cita_integrante: 'member',
  snapshot_integrante_id: 'member', snapshot_persona_id: persona, snapshot_orden: 1, snapshot_rol: 'titular',
  contacto_email: email, contacto_email_snapshot: email, direccion_correo: null, primary_email_count: 0,
  total_pagar_hnl: '115.00', estado_cita_codigo: 'en_espera' });
function database(rows) {
  return { query: async (sql, params) => {
    assert.match(sql, /ci.id_cita_integrante = c.id_cita_integrante/);
    assert.match(sql, /ci.id_grupo_cita = cg.id_grupo_cita/);
    assert.match(sql, /count\(\*\) AS primary_email_count/);
    assert.equal(params[0], group); assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE)\b/);
    return { rows: structuredClone(rows) };
  } };
}
const run = (rows, titularEmail = email) => load(database(rows), { groupId: group, titularEmail });
const forbidden = promise => assert.rejects(promise, e => e.statusCode === 403 && e.code === 'PUBLIC_PAGOS_GROUP_FORBIDDEN');

for (const kind of ['nuevo', 'usado', 'cliente', 'empleado', 'admin']) {
  test(`invitado ${kind}: Persona propia, sin lookup por correo ni cuenta`, async () => {
    let count = 0;
    const db = { query: async (sql, params) => {
      count++; assert.match(sql, /INSERT INTO public.personas/);
      assert.doesNotMatch(sql, /public\.(correos|usuarios|clientes|roles)|SELECT|UPDATE/);
      assert.deepEqual([...params], ['Guest', 'Owner', '99999999']);
      return { rows: [{ id_persona: persona }] };
    } };
    const value = await guest(db, { nombres: 'Guest', apellidos: 'Owner', telefono: '99999999', email: `${kind}@example.test` });
    assert.equal(value.id_persona, persona); assert.equal(value.id_cliente, null); assert.equal(count, 1);
  });
}
test('dos reservas con mismo email no reutilizan Persona ni duplican identidad registrada', async () => {
  let count = 0; const db = { query: async () => ({ rows: [{ id_persona: `guest-${++count}` }] }) };
  const a = await guest(db, { nombres: 'Guest', email }); const b = await guest(db, { nombres: 'Guest', email });
  assert.notEqual(a.id_persona, b.id_persona); assert.equal(a.id_cliente, null); assert.equal(b.id_cliente, null);
});
test('contactos titular/acompañante se mantienen en payload canónico sin cuentas', async () => {
  const block = (order, contact) => ({ orden_integrante: order, id_persona: persona, contacto_email: contact,
    contacto_nombre: 'Guest', tipo_cliente_codigo: 'invitado', inicio_at: '2099-01-01T15:00:00Z',
    selection: { serviceSelection: { items: [] } }, detailRows: [], id_empleado_barbero: persona });
  const payload = buildCanonicalReservationPayload({ requestId: group, idSucursal: group, idPersonaTitular: persona,
    integrantes: [block(1, email), block(2, 'companion@example.test')] });
  assert.equal(payload.integrantes[0].contacto_email, email);
  assert.equal(payload.integrantes[1].contacto_email, 'companion@example.test');
  assert.equal(payload.integrantes[0].id_usuario, null); assert.equal(payload.integrantes[0].id_cliente, null);
  assert.match(citas, /contacto_email: integrante\.contacto\?\.email \|\| null/);
  let rpcCalls = 0;
  await createCanonicalReservation({ query: async (sql, params) => {
    rpcCalls++; assert.equal(sql, 'SELECT app_private.crear_reserva_canonica_v1($1::jsonb) AS resultado');
    assert.equal(params[0].integrantes[0].contacto_email, email);
    assert.equal(params[0].integrantes[1].contacto_email, 'companion@example.test');
    return { rows: [{ resultado: { id_grupo_cita: group } }] };
  } }, payload);
  assert.equal(rpcCalls, 1);
});
for (const name of ['sin correo en correos', 'correo histórico reasociado', 'reintento', 'conciliación interna']) {
  test(`${name}: contacto de reserva autoriza sin cambiar identidad ni importes`, async () => {
    const row = { ...base(), direccion_correo: name === 'correo histórico reasociado' ? 'new-account@example.test' : null };
    const rows = await run([row]); assert.deepEqual(rows, [row]);
    assert.equal(rows[0].total_pagar_hnl, '115.00'); assert.equal(rows[0].id_persona_titular, persona);
  });
}
test('acompañante primero en resultados no se utiliza para autorizar', async () => {
  const companion = { ...base(), orden_integrante: 2, snapshot_orden: 2, snapshot_rol: 'acompanante', contacto_email: 'companion@example.test' };
  assert.equal((await run([companion, base()])).length, 2);
  await forbidden(run([companion, base()], 'companion@example.test'));
});
test('segundo integrante marcado titular se rechaza por contradicción', () =>
  forbidden(run([base(), { ...base(), orden_integrante: 2 }])));
for (const [name, change] of [
  ['snapshots contradictorios', { contacto_email_snapshot: 'other@example.test' }],
  ['Persona de cita ajena', { id_persona_cliente: 'other' }],
  ['Persona de integrante ajena', { snapshot_persona_id: 'other' }],
  ['integrante de otro grupo no unido', { snapshot_integrante_id: null }],
  ['rol acompañante', { snapshot_rol: 'acompanante' }],
  ['orden integrante diferente', { snapshot_orden: 2 }],
  ['cliente diferente', { id_cliente_titular: 'client', cita_cliente_id: 'other' }],
  ['contacto inválido', { contacto_email: 'invalid', contacto_email_snapshot: 'invalid' }],
]) test(`${name}: 403 sin escrituras`, () => forbidden(run([{ ...base(), ...change }])));
test('correo incorrecto y groupId solo se rechazan', async () => {
  await forbidden(run([base()], 'other@example.test')); await forbidden(run([base()], ''));
});
test('titular duplicado o ausente se rechaza', async () => {
  await forbidden(run([base(), base()])); await forbidden(run([{ ...base(), orden_integrante: 2 }]));
});
test('grupo inexistente conserva 404', async () => {
  await assert.rejects(run([]), e => e.statusCode === 404 && e.code === 'PUBLIC_PAGOS_GROUP_NOT_FOUND');
});
test('legacy con titular inequívoco y único principal conserva acceso', async () => {
  const row = { ...base(), id_cita_integrante: null, contacto_email: null, contacto_email_snapshot: null,
    primary_email_count: 1, direccion_correo: email };
  assert.equal((await run([row])).length, 1);
  await forbidden(run([{ ...row, primary_email_count: 2 }]));
  await forbidden(run([{ ...row, primary_email_count: 0, direccion_correo: null }]));
});
test('Fastify real: arranque con mocks, no enumera cuentas y conserva duplicados intrarreserva', async t => {
  const app = Fastify({ logger: false });
  app.decorate('db', { query: async () => { throw new Error('No debe consultar identidades'); } });
  await app.register(publicCitasRoutes, { prefix: '/public/citas' });
  await app.register(publicPagosRoutes, { prefix: '/public/pagos' });
  await app.ready(); t.after(() => app.close());
  for (const kind of ['nuevo', 'cliente', 'admin']) {
    const response = await app.inject({ method: 'POST', url: '/public/citas/validar-contactos',
      payload: { contactos: [{ email: `${kind}@example.test`, nombre: 'Guest Owner' }] } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().valido, true);
  }
  const duplicate = await app.inject({ method: 'POST', url: '/public/citas/validar-contactos',
    payload: { contactos: [{ email }, { email }] } });
  assert.equal(duplicate.statusCode, 409); assert.equal(duplicate.json().error.code, 'PUBLIC_CITAS_CONTACT_DUPLICATE_CONFLICT');
});
