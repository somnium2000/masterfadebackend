import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import publicAgendaRoutes, { mapDiscardedSlotsForResponse } from '../src/routes/v1/public/agenda.js';
import { globalErrorHandler } from '../src/utils/errors.js';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const BARBER = '22222222-2222-4222-8222-222222222222';
const SERVICE = '33333333-3333-4333-8333-333333333333';
const PRIVATE = { nombre_cliente: 'Persona Confidencial ApellidoReservado', contacto_nombre: 'Contacto Reservado',
  correo: 'privado@example.test', telefono: '99998888', id_cliente: '44444444-4444-4444-8444-444444444444' };
const args = `id_sucursal=${BRANCH}&id_barbero=${BARBER}&servicios=${SERVICE}&fecha=2030-10-16`;

async function fixture(roles = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push(String(sql));
    if (sql.includes('UPDATE ')) return { rows: [], rowCount: 0 };
    if (sql.includes('agenda_min_servicio_vendible_min')) return { rows: [{ agenda_min_servicio_vendible_min: 10 }] };
    if (sql.includes('agenda_buffer_global_min')) return { rows: [{ agenda_buffer_global_min: 0 }] };
    if (sql.includes('horarios_semanales_sucursales_bloques')) return { rows: [{ hora_inicio: '08:00:00', hora_fin: '12:00:00' }] };
    if (sql.includes('horarios_semanales_sucursales') && sql.includes('SELECT 1')) return { rows: [{ exists: 1 }] };
    if (sql.includes('FROM public.sucursales')) return { rows: [{ id_sucursal: BRANCH, nombre_sucursal: 'Sucursal QA', estado: true }] };
    if (sql.includes('FROM public.empleados e')) return { rows: [{ id_empleado: BARBER, id_sucursal: BRANCH, es_barbero: true,
      nombre_completo: 'Barbero Publico', nombres: 'Barbero', apellidos: 'Publico', nombre_sucursal: 'Sucursal QA', certificaciones_titulos: [], visible_en_landing: true }] };
    if (sql.includes('FROM public.empleados')) return { rows: [{ id_sucursal: BRANCH }] };
    if (sql.includes('FROM public.servicios s') && sql.includes('active_tariffs')) return { rows: [{ id_servicio: SERVICE,
      id_tarifa: SERVICE, nombre_servicio: 'Corte QA', duracion_min: 30, buffer_min: 0, precio_hnl: 300, incluye_isv: false, isv_porcentaje: 0 }] };
    if (sql.includes('FROM public.citas')) return { rows: [{ inicio_at: '2030-10-16T09:00:00-06:00', fin_at: '2030-10-16T09:30:00-06:00', estado_cita_codigo: 'confirmada', ...PRIVATE }] };
    if (sql.includes('FROM public.agenda_bloqueos_empleados')) return { rows: [{ inicio_at: '2030-10-16T10:00:00-06:00', fin_at: '2030-10-16T10:15:00-06:00', ...PRIVATE }] };
    if (sql.includes('agenda_excepciones_sucursal') || sql.includes('bloqueos_agenda')) return { rows: [] };
    throw new Error('Consulta no prevista en fixture: ' + sql.slice(0, 80) + ' ' + params.length);
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler(globalErrorHandler);
  app.decorate('config', { bookingIsvEnabled: false });
  app.decorate('db', { async connect() { return { query, release() {} }; } });
  // AM: Claims sinteticos del test; el endpoint y sus calculos son los reales, sin BD ni red externas.
  app.addHook('onRequest', async request => { request.claims = { roles }; });
  await app.register(publicAgendaRoutes, { prefix: '/v1/public/agenda' });
  return { app, calls };
}

function noPrivateData(body) {
  for (const value of Object.values(PRIVATE)) assert.equal(body.includes(value), false, value);
  for (const key of ['nombre_cliente', 'contacto_nombre', 'correo', 'telefono', 'id_cliente']) assert.equal(body.includes(`"${key}"`), false, key);
}

for (const roles of [[], ['cliente'], ['admin'], ['super_admin'], ['barbero']]) for (const debug of [false, true]) {
  test(`GET horarios roles=${roles.join(',') || 'publico'} debug=${debug}: sin PII y disponibilidad intacta`, async t => {
    const { app, calls } = await fixture(roles); t.after(() => app.close());
    const response = await app.inject(`/v1/public/agenda/horarios?${args}&debug=${debug}`);
    assert.equal(response.statusCode, 200, response.body); noPrivateData(response.body);
    const data = response.json().data;
    assert.ok(data.horarios.some(slot => slot.hora === '08:00'));
    assert.ok(data.horarios.every(slot => slot.hora !== '09:00' && slot.hora !== '09:15' && slot.hora !== '10:00'));
    const authorized = roles.some(role => ['admin', 'super_admin', 'barbero'].includes(role));
    if (debug && authorized) {
      assert.ok(data.debug.discarded_slots.length > 0);
      assert.ok(data.debug.discarded_reason_codes.length > 0);
      assert.ok(data.debug.curated_ranking.manana.candidates.length > 0);
      assert.ok(data.debug.discarded_slots.some(entry => Number.isFinite(entry.details.min_sellable_min)));
    } else assert.equal(data.debug, null);
    for (const sql of calls.filter(sql => sql.includes('FROM public.citas'))) {
      const selection = sql.slice(0, sql.indexOf('FROM public.citas'));
      assert.doesNotMatch(selection, /nombre|contacto|correo|telefono|id_cliente|SELECT\s+\*/i);
    }
  });
}

test('diagnostico autorizado: lista explicita elimina PII anidada sin perder razones ni tiempos', () => {
  const input = [{ reason: 'DURATION_INSUFFICIENT', inicio_at: '2030-10-16T08:00:00-06:00', fin_at: '2030-10-16T08:10:00-06:00',
    intervalo_inicio_at: '2030-10-16T08:00:00-06:00', intervalo_fin_at: '2030-10-16T08:10:00-06:00', ...PRIVATE,
    details: { interval_duration_min: 10, required_duration_min: 30, ...PRIVATE, cita: PRIVATE } }];
  const original = structuredClone(input), result = mapDiscardedSlotsForResponse(input);
  noPrivateData(JSON.stringify(result)); assert.deepEqual(input, original);
  assert.equal(result[0].reason, 'DURATION_INSUFFICIENT');
  assert.equal(result[0].inicio_at, '2030-10-16T14:00:00.000Z');
  assert.deepEqual(result[0].details, { interval_duration_min: 10, required_duration_min: 30 });
});

test('diagnostico descarta texto libre en razones, tiempos y valores numericos; conserva cierre de sucursal', () => {
  const [invalid, closed] = mapDiscardedSlotsForResponse([
    { reason: PRIVATE.nombre_cliente, inicio_at: PRIVATE.contacto_nombre, details: { reason: PRIVATE.correo, min_sellable_min: PRIVATE.telefono } },
    { reason: 'RESOURCE_UNAVAILABLE', details: { reason: 'branch_exceptions' } },
  ]);
  noPrivateData(JSON.stringify(invalid));
  assert.equal(invalid.reason, 'RESOURCE_UNAVAILABLE'); assert.equal(invalid.inicio_at, null);
  assert.deepEqual(invalid.details, {}); assert.deepEqual(closed.details, { reason: 'branch_exceptions' });
  assert.deepEqual(mapDiscardedSlotsForResponse(null), []);
});

test('query invalida se rechaza con 400 sin consultar disponibilidad', async t => {
  const { app, calls } = await fixture(); t.after(() => app.close());
  const response = await app.inject('/v1/public/agenda/horarios?id_sucursal=invalido&fecha=2030-10-16');
  assert.equal(response.statusCode, 400); assert.equal(calls.length, 0); noPrivateData(response.body);
});
