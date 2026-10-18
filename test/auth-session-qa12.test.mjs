import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import authRoutes from '../src/routes/v1/auth.js';
import authPlugin from '../src/plugins/auth.js';
import { closeActiveSession, checkUserTemporaryLock } from '../src/services/securityService.js';

// AM: Dobles exclusivamente en memoria; sin pools, SMTP ni proveedores reales.
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.CSRF_SECRET = crypto.randomBytes(48).toString('hex');
process.env.AUTH_LOGIN_DELAY_FAIL3_MS = '0';
const USER = crypto.randomUUID(), SID = crypto.randomUUID(), JTI = crypto.randomUUID();
const silentLog = { warn() {}, error() {}, info() {} };
const token = () => jwt.sign({ sub: USER, sid: SID, jti: JTI, token_type: 'app' }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '1h' });

async function setup(t, options = {}) {
  let state = options.state || 'activa', sessions = 0, providerCalls = 0, resets = 0;
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes('app_protected_users')) {
      if (options.protectionError) throw Error('synthetic protected lookup error');
      return { rows: options.protected ? [{}] : [], rowCount: options.protected ? 1 : 0 };
    }
    if (sql.includes('SELECT locked_until_at')) {
      if (options.lockError) throw Error('synthetic private DB path');
      return { rows: [{ locked_until_at: options.locked ? new Date(Date.now() + 60000) : null }] };
    }
    if (sql.includes('WITH base_user')) return { rows: [{ id_usuario: USER, roles: ['cliente'], branch_ids: [] }] };
    if (sql.replace(/\s+/g, ' ').includes('SELECT 1 FROM public.usuarios')) return { rows: [{}], rowCount: 1 };
    if (sql.replace(/\s+/g, ' ').includes('SELECT id_usuario FROM public.usuarios')) return { rows: [{ id_usuario: USER }], rowCount: 1 };
    if (sql.includes('COUNT(')) return { rows: [{ total: options.rateLimited ? 100 : 0 }] };
    if (sql.includes('SELECT estado_acceso')) return { rows: [{ estado_acceso: 'activo' }], rowCount: 1 };
    if (sql.includes('UPDATE public.usuarios')) return { rows: [{ estado_acceso: 'activo' }], rowCount: 1 };
    if (sql.includes('INSERT INTO public.seguridad_usuarios_acceso')) { resets++; return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO public.seguridad_sesiones')) { sessions++; return { rows: [], rowCount: 1 }; }
    if (sql.includes("estado = 'cerrada'")) {
      if (options.closeError) throw Error('synthetic SQL failure');
      if (state === 'activa' && !options.noUpdate) { state = 'cerrada'; return { rows: [{ id_sesion: SID }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT estado, cierre_at')) return { rows: state === 'inexistente' ? [] : [{ estado: state, cierre_at: state === 'cerrada' ? new Date() : null, revocada_at: state === 'revocada' ? new Date() : null, expira_at: new Date(state === 'expirada' ? 0 : Date.now() + 3600000) }] };
    if (sql.includes('token_jti_hash = $3')) return { rows: state === 'inexistente' ? [] : [{ estado: state, ultimo_uso_at: new Date(options.idle ? 0 : Date.now()), expira_at: new Date(state === 'expirada' ? 0 : Date.now() + 3600000), revocada_at: state === 'revocada' ? new Date() : null }] };
    return { rows: [], rowCount: 0 };
  };
  const app = Fastify(); app.decorate('db', { query, connect: async () => ({ query, release() {} }) });
  app.decorate('supabase', { auth: { signInWithPassword: async () => { providerCalls++; return options.invalidPassword ? { error: { status: 401 } } : { data: { user: { id: USER } } }; } } });
  const syntheticUser = { id: USER, email: 'synthetic@example.test', email_confirmed_at: new Date().toISOString() };
  app.decorate('supabaseAdmin', { auth: { getUser: async () => ({ data: { user: syntheticUser } }), admin: { getUserById: async () => ({ data: { user: syntheticUser } }) } } });
  await app.register(cookie); await app.register(authPlugin); await app.register(authRoutes, { prefix: '/auth' });
  app.get('/guard', { preHandler: app.requireRoles(['cliente']) }, async () => ({ ok: true }));
  await app.ready(); t.after(() => app.close());
  return { app, queries, stats: () => ({ state, sessions, providerCalls, resets }) };
}

for (const options of [{ lockError: true }, { protectionError: true }]) test(`login fail-closed ${JSON.stringify(options)}`, async t => {
  const f = await setup(t, options);
  const r = await f.app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'synthetic@example.test', contrasena: 'synthetic' } });
  assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'AUTH_LOCK_CHECK_UNAVAILABLE');
  assert.equal(r.headers['set-cookie'], undefined); assert.equal(f.stats().sessions, 0); assert.equal(f.stats().resets, 0);
  assert.ok(!r.body.includes('synthetic private'));
});
test('bloqueo real conserva 429 y no se elimina antes de validarlo', async t => {
  const f = await setup(t, { locked: true }); const r = await f.app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'synthetic@example.test', contrasena: 'synthetic' } });
  assert.equal(r.statusCode, 429); assert.equal(r.json().error.code, 'AUTH_USER_TEMPORARILY_LOCKED'); assert.equal(f.stats().sessions, 0); assert.equal(f.stats().resets, 0);
});
test('bypass protegido solo después de verificación positiva', async t => {
  const f = await setup(t, { protected: true, lockError: true });
  const r = await checkUserTemporaryLock(f.app, { idUsuario: USER }); assert.equal(r.ok, true); assert.equal(r.bypassed, true);
});
test('identidad inválida no consulta el bloqueo', async () => {
  let calls = 0; const result = await checkUserTemporaryLock({ db: { query: async () => { calls++; } } }, { idUsuario: 'invalid' });
  assert.equal(result.ok, false); assert.equal(calls, 0);
});
test('login válido conserva sesión y cookies', async t => {
  const f = await setup(t); const r = await f.app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'synthetic@example.test', contrasena: 'synthetic' } });
  assert.equal(r.statusCode, 200); assert.equal(f.stats().sessions, 1); assert.ok(r.headers['set-cookie']);
});
test('credenciales incorrectas mantienen rechazo', async t => {
  const f = await setup(t, { invalidPassword: true }); const r = await f.app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'synthetic@example.test', contrasena: 'synthetic' } });
  assert.equal(r.statusCode, 401); assert.equal(f.stats().sessions, 0);
});
test('rate limiting impide contactar al proveedor', async t => {
  const f = await setup(t, { rateLimited: true }); const r = await f.app.inject({ method: 'POST', url: '/auth/login', payload: { identifier: 'synthetic@example.test', contrasena: 'synthetic' } });
  assert.equal(r.statusCode, 429); assert.equal(f.stats().providerCalls, 0);
});
for (const state of ['activa', 'cerrada', 'revocada', 'expirada', 'inexistente']) test(`logout idempotente: ${state}`, async t => {
  const f = await setup(t, { state }); const headers = { cookie: `mf_session=${token()}` };
  for (let i = 0; i < 2; i++) { const r = await f.app.inject({ method: 'POST', url: '/auth/logout', headers }); assert.equal(r.statusCode, 200); assert.equal(r.json().data.logged_out, true); }
  assert.equal((await f.app.inject({ url: '/guard', headers })).statusCode, 401);
});
for (const options of [{ closeError: true }, { noUpdate: true }]) test(`no confirma cierre sin revocación: ${JSON.stringify(options)}`, async t => {
  const f = await setup(t, options); const headers = { cookie: `mf_session=${token()}` };
  const r = await f.app.inject({ method: 'POST', url: '/auth/logout', headers });
  assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'AUTH_LOGOUT_UNCONFIRMED'); assert.equal(r.headers['set-cookie'], undefined);
  assert.equal((await f.app.inject({ url: '/guard', headers })).statusCode, 200);
});
test('sin token o token inválido no existe una sesión utilizable que revocar', async t => {
  const f = await setup(t);
  for (const value of ['', 'invalid']) { const r = await f.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `mf_session=${value}` } }); assert.equal(r.statusCode, 200); }
});
test('logout concurrente cierra una vez y ambos resultados son seguros', async t => {
  const f = await setup(t); const headers = { cookie: `mf_session=${token()}` };
  const results = await Promise.all([1, 2].map(() => f.app.inject({ method: 'POST', url: '/auth/logout', headers })));
  assert.ok(results.every(r => r.statusCode === 200)); assert.equal(f.stats().state, 'cerrada');
  assert.equal((await f.app.inject({ url: '/guard', headers })).statusCode, 401);
});
test('inactividad sigue rechazando la sesión', async t => {
  const f = await setup(t, { idle: true }); const r = await f.app.inject({ url: '/guard', headers: { cookie: `mf_session=${token()}` } });
  assert.equal(r.statusCode, 401); assert.equal(r.json().error.code, 'AUTH_SESSION_IDLE_EXPIRED');
});
test('fallo SQL en comprobación posterior tampoco confirma cierre', async () => {
  let count = 0; const result = await closeActiveSession({ db: { query: async () => { if (++count === 1) return { rowCount: 0 }; throw Error('synthetic'); } } }, { log: silentLog }, { sid: SID, id_usuario: USER });
  assert.equal(result.ok, false);
});
for (const endpoint of ['exchange', 'social/confirm']) test(`${endpoint} no elude el fallo del bloqueo temporal`, async t => {
  const f = await setup(t, { lockError: true });
  const payload = endpoint === 'exchange' ? { supabase_token: 'synthetic-provider-token' } : { social_confirm_token: jwt.sign({ sub: USER, email: 'synthetic@example.test', token_type: 'social_confirm' }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '1h' }) };
  const r = await f.app.inject({ method: 'POST', url: '/auth/' + endpoint, payload });
  assert.equal(r.statusCode, 503, r.body); assert.equal(r.json().error.code, 'AUTH_LOCK_CHECK_UNAVAILABLE');
  assert.equal(f.stats().sessions, 0); assert.equal(r.headers['set-cookie'], undefined);
});
