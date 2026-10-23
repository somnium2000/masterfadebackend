import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import authRoutes from '../src/routes/v1/auth.js';
import { guestFixture } from './helpers/guestRegistrationDb.mjs';

const source = readFileSync(new URL('../src/routes/v1/auth.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const baseline = execFileSync('git', ['show', 'HEAD:src/routes/v1/auth.js'], { encoding: 'utf8' }).replaceAll('\r\n', '\n');
const extract = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start))).trim();
test('02G conserva las protecciones de recuperación y sesiones del baseline', () => {
  assert.equal(source.slice(source.indexOf('  app.post("/forgot-password"')), baseline.slice(baseline.indexOf('  app.post("/forgot-password"')));
  assert.match(extract(source, 'async function ensureRegisterEmailAvailability(', 'async function getClienteRoleId('), /classifyRegistrationEmail\(client, email\)/);
});

async function fixture(t, duplicate = '') {
  const user = randomUUID(), persona = randomUUID(), cliente = randomUUID(), role = randomUUID();
  let creations = 0;
  const queries = [];
  const query = async sql => {
    queries.push(sql);
    assert.doesNotMatch(sql, /guest_registration_requests|UPDATE public\.correos/);
    if (sql.includes('FROM public.correos co LEFT JOIN public.personas')) return { rows: duplicate === 'contact' ? [{ id_correo: randomUUID(), id_persona: persona, persona_exists: persona, has_user: true }] : [], rowCount: duplicate === 'contact' ? 1 : 0 };
    if (sql.includes('SELECT id, raw_app_meta_data FROM auth.users')) return { rows: duplicate === 'auth' ? [{ id: user, raw_app_meta_data: {} }] : [], rowCount: duplicate === 'auth' ? 1 : 0 };
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
test('confirm y resend validan el payload antes de tocar Auth', async t => {
  const f = await fixture(t);
  for (const suffix of ['confirm', 'resend']) assert.equal((await f.app.inject({ method: 'POST', url: '/v1/auth/register/' + suffix, payload: {} })).statusCode, 400);
  assert.equal(f.creations(), 0);
});
test('correo histórico mantiene HTTP 202 sin Auth, sesión ni transferencia de reservas', async t => {
  const f = guestFixture();
  const previousUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'http://127.0.0.1:5181';
  t.after(() => { if (previousUrl === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previousUrl; });
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async () => {});
  app.decorate('db', f.db); app.decorate('supabaseAdmin', f.app.supabaseAdmin); app.decorate('mailer', f.app.mailer);
  await app.register(authRoutes, { prefix: '/v1/auth' }); await app.ready(); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { ...payload, email: f.email } });
  assert.equal(response.statusCode, 202); assert.equal(response.json().data.pending_verification, true);
  assert.equal(f.creates(), 0); assert.equal(f.state().users.length, 0); assert.equal(response.headers['set-cookie'], undefined);
  assert.ok(!f.calls.some(({ q }) => /UPDATE public\.(citas|citas_grupos|citas_integrantes)/.test(q)));
});
