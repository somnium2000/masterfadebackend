import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import authRoutes from '../src/routes/v1/auth.js';

const source = readFileSync(new URL('../src/routes/v1/auth.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const baseline = execFileSync('git', ['show', 'HEAD:src/routes/v1/auth.js'], { encoding: 'utf8' }).replaceAll('\r\n', '\n');
const extract = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start))).trim();
test('registro y disponibilidad conservan exactamente el contrato baseline', () => {
  assert.equal(extract(source, 'async function ensureRegisterEmailAvailability(', 'async function getClienteRoleId('), extract(baseline, 'async function ensureRegisterEmailAvailability(', 'async function getClienteRoleId('));
  assert.equal(extract(source, '  app.post(\n    "/register",', '  app.post("/forgot-password"'), extract(baseline, '  app.post(\n    "/register",', '  app.post("/forgot-password"'));
  assert.doesNotMatch(source, /guestRegistrationService|classifyRegistrationEmail|requestGuestRegistration|completeGuestRegistration/);
});

async function fixture(t, duplicate = '') {
  const user = randomUUID(), persona = randomUUID(), cliente = randomUUID(), role = randomUUID();
  let creations = 0;
  const queries = [];
  const query = async sql => {
    queries.push(sql);
    assert.doesNotMatch(sql, /guest_registration_requests|UPDATE public\.correos/);
    if (sql.includes('SELECT 1') && sql.includes('FROM public.correos')) return { rows: duplicate === 'contact' ? [{}] : [], rowCount: duplicate === 'contact' ? 1 : 0 };
    if (sql.includes('SELECT 1') && sql.includes('FROM auth.users')) return { rows: duplicate === 'auth' ? [{}] : [], rowCount: duplicate === 'auth' ? 1 : 0 };
    if (sql.includes('SELECT id_rol')) return { rows: [{ id_rol: role }], rowCount: 1 };
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('INSERT INTO public.personas')) return { rows: [{ id_persona: persona }], rowCount: 1 };
    if (sql.includes('INSERT INTO public.clientes')) return { rows: [{ id_cliente: cliente }], rowCount: 1 };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || sql.includes('INSERT INTO public.')) return { rows: [], rowCount: 1 };
    throw new Error('UNEXPECTED_MOCK_QUERY');
  };
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async () => {});
  app.decorate('config', { cookieSecret: 'synthetic-local-only' });
  app.decorate('db', { query, connect: async () => ({ query, release() {} }) });
  app.decorate('supabaseAdmin', { auth: { admin: {
    createUser: async () => { creations++; return { data: { user: { id: user } } }; },
    deleteUser: async () => { throw new Error('COMPENSATION_NOT_EXPECTED'); },
  } } });
  await app.register(authRoutes, { prefix: '/v1/auth' }); await app.ready(); t.after(() => app.close());
  return { app, queries, creations: () => creations };
}
const payload = { nombres: 'Synthetic', apellidos: 'Only', email: 'package@example.test', contrasena: 'SyntheticOnly9!', confirmar_contrasena: 'SyntheticOnly9!', acepta_terminos: true, consentimiento_marketing: false };
test('registro libre mantiene HTTP 201 y no crea operación histórica', async t => {
  const f = await fixture(t); const response = await f.app.inject({ method: 'POST', url: '/v1/auth/register', payload });
  assert.equal(response.statusCode, 201); assert.equal(f.creations(), 1);
  assert.equal(response.json().data.cliente.id_sucursal_origen, null);
});
for (const duplicate of ['contact', 'auth']) test('duplicado ' + duplicate + ' conserva HTTP 409 sin crear Auth', async t => {
  const f = await fixture(t, duplicate); const response = await f.app.inject({ method: 'POST', url: '/v1/auth/register', payload });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'AUTH_REGISTER_EMAIL_EXISTS'); assert.equal(f.creations(), 0);
});
test('confirm y resend históricos no están registrados', async t => {
  const f = await fixture(t);
  for (const suffix of ['confirm', 'resend']) assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/register/' + suffix, payload: {} })).statusCode, 404);
});
