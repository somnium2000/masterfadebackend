import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { fixture, body, USER } from './auth-recovery-qa02i.test.mjs';

// AM: Proveedor estricto y persistencia exclusivamente en memoria; sin conexiones.
async function setup(t, options = {}) {
  const f = await fixture(t, options);
  const providerSecret = randomBytes(40).toString('hex');
  const authSessions = new Map(), appSessions = new Map(), calls = [];
  const other = randomUUID(), oldSid = randomUUID();
  let internalUserProbeCount = 0;
  authSessions.set(oldSid, { user_id: USER, not_after: null });
  const sign = (overrides = {}, secret = providerSecret) => jwt.sign({ sub: USER, session_id: oldSid, ...overrides }, secret, overrides.exp === undefined ? { expiresIn: '1h' } : {});
  const oldToken = sign();
  let inserts = 0, providerCalls = 0;
  const originalQuery = f.app.db.query.bind(f.app.db);
  const originalConnect = f.app.db.connect.bind(f.app.db);
  async function intercept(sql, params, fallback) {
    calls.push({ sql, params });
    if (options.concurrentProvision && /SELECT\s+1\s+FROM public\.usuarios/.test(sql)) {
      internalUserProbeCount++;
      return internalUserProbeCount === 1 ? { rows: [], rowCount: 0 } : { rows: [{ exists: 1 }], rowCount: 1 };
    }
    if (options.newSocial && /SELECT\s+1\s+FROM public\.usuarios/.test(sql)) return { rows: [] };
    if (options.concurrentProvision && /SELECT\s+id_usuario\s+FROM public\.usuarios/.test(sql)) return { rows: [], rowCount: 0 };
    if (options.concurrentProvision && /SELECT\s+id_rol\s+FROM public\.roles/.test(sql)) {
      return { rows: [{ id_rol: randomUUID() }], rowCount: 1 };
    }
    if (options.concurrentProvision && /INSERT INTO public\.personas/.test(sql)) {
      return { rows: [{ id_persona: randomUUID() }], rowCount: 1 };
    }
    if (options.concurrentProvision && /INSERT INTO public\.usuarios/.test(sql)) {
      const conflict = new Error('synthetic concurrent user');
      conflict.code = '23505'; conflict.constraint = 'usuarios_pkey';
      throw conflict;
    }
    if (sql.includes('WITH base_user') && options.roles) return { rows: [{ id_usuario: USER, roles: options.roles, branch_ids: [] }] };
    if (sql.includes('has_schema_privilege')) {
      if (options.permissionError) throw Error('private privilege diagnostic');
      return { rows: [{ allowed: !options.noPermission }], rowCount: 1 };
    }
    if (sql.includes('FROM auth.sessions')) {
      if (options.sessionQueryError) throw Error('private auth session diagnostic');
      assert.deepEqual(params, [params[0], USER]);
      assert.match(sql, /id\s*=\s*\$1::uuid/);
      assert.match(sql, /user_id\s*=\s*\$2::uuid/);
      assert.match(sql, /not_after/);
      if (options.onSessionRead) await options.onSessionRead();
      const row = authSessions.get(params[0]);
      return { rows: row && row.user_id === params[1] && (!row.not_after || row.not_after > new Date()) ? [{ id: params[0] }] : [] };
    }
    if (sql.includes('INSERT INTO public.seguridad_sesiones')) {
      if (options.beforeInsert) await options.beforeInsert();
      inserts++; appSessions.set(params[0], { user: params[1], revoked: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("motivo_cierre = 'password_reset'")) {
      for (const session of appSessions.values()) if (session.user === params[0]) session.revoked = true;
    }
    if (sql.includes('token_jti_hash = $3') && appSessions.has(params[0])) {
      const row = appSessions.get(params[0]);
      return { rows: row.user === params[1] ? [{ estado: row.revoked ? 'revocada' : 'activa', revocada_at: row.revoked ? new Date() : null, ultimo_uso_at: new Date(), expira_at: new Date(Date.now() + 3600000) }] : [] };
    }
    return fallback(sql, params);
  }
  f.app.db.query = (sql, p = []) => intercept(sql, p, originalQuery);
  f.app.db.connect = async () => {
    if (options.connectError) throw Error('private connection diagnostic');
    const client = await originalConnect(), query = client.query.bind(client);
    client.query = (sql, p = []) => intercept(sql, p, query);
    return client;
  };
  f.app.supabaseAdmin.auth.getUser = async token => {
    providerCalls++;
    if (options.providerThrow) throw Error('private provider diagnostic');
    if (options.providerUnavailable) return { error: { status: 503 } };
    try {
      const claims = jwt.verify(token, providerSecret, { algorithms: ['HS256'] });
      return { data: { user: { id: claims.sub, email: 'qa02i@example.test', email_confirmed_at: new Date().toISOString() } } };
    } catch { return { error: { status: 401 } }; }
  };
  f.app.supabaseAdmin.auth.admin.getUserById = async id => {
    if (options.socialLookupError) throw Error('private provider diagnostic');
    return { data: { user: { id: options.socialMismatch ? other : id, email: 'qa02i@example.test' } } };
  };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const response = await priorFetch(input, init);
    if (url.pathname === '/auth/v1/logout' && url.searchParams.get('scope') === 'global' && response.ok) {
      for (const [sid, row] of authSessions) if (row.user_id === USER) authSessions.delete(sid);
    }
    return response;
  };
  t.after(() => { globalThis.fetch = priorFetch; });
  const passwordLogin = f.app.supabase.auth.signInWithPassword;
  f.app.supabase.auth.signInWithPassword = async credentials => {
    const result = await passwordLogin(credentials);
    if (result.data?.user) {
      const sid = randomUUID(); authSessions.set(sid, { user_id: USER, not_after: null });
      result.data.session = { access_token: sign({ session_id: sid }) };
    }
    return result;
  };
  const exchange = token => f.app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { supabase_token: token || oldToken } });
  const login = password => f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: 'qa02i@example.test', contrasena: password } });
  return { ...f, authSessions, appSessions, other, oldSid, oldToken, sign, calls, exchange, login, stats: () => ({ inserts, providerCalls }),
    social: sessionId => f.app.inject({ method: 'POST', url: '/v1/auth/social/confirm', payload: { social_confirm_token: jwt.sign({ sub: USER, email: 'qa02i@example.test', token_type: 'social_confirm', session_id: sessionId }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '30m' }) } }) };
}
function cookie(response) {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : [values || '']).find(v => v.startsWith('mf_session='))?.split(';')[0];
}
const probe = (f, value) => f.app.inject({ url: '/probe', headers: { cookie: value } });
function rejected(response, f, before = 0) {
  assert.ok([401, 403, 503].includes(response.statusCode), response.body);
  assert.equal(cookie(response), undefined); assert.equal(f.stats().inserts, before);
  assert.doesNotMatch(response.body, /private|diagnostic|SELECT|auth\.sessions/);
}
const consentWrites = calls => calls.filter(({ sql }) =>
  /UPDATE\s+public\.clientes/i.test(sql)
  && /(?:acepta_terminos|consentimiento_marketing)/i.test(sql));

for (const priorState of [
  'marketing rechazado',
  'marketing revocado',
  'terminos no aceptados',
  'consentimientos aceptados con fechas existentes',
]) test(`exchange social conserva ${priorState} sin reescribir consentimientos`, async t => {
  const f = await setup(t);
  const response = await f.exchange();
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(consentWrites(f.calls), []);
});

test('confirmacion social de cuenta interna existente no reescribe consentimientos', async t => {
  const f = await setup(t);
  const response = await f.social(f.oldSid);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(consentWrites(f.calls), []);
});

test('carrera de aprovisionamiento que encuentra usuario concurrente no reescribe consentimientos', async t => {
  const f = await setup(t, { concurrentProvision: true });
  const response = await f.social(f.oldSid);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(f.calls.some(({ sql }) => /INSERT INTO public\.usuarios/.test(sql)));
  assert.deepEqual(consentWrites(f.calls), []);
});

test('P1: reset rechaza reexchange anterior; nuevo login y token legítimos conservan roles y otra identidad', async t => {
  const f = await setup(t);
  const initial = await f.login('BeforeOnly9!'); assert.equal(initial.statusCode, 200, initial.body);
  const previousCookie = cookie(initial); assert.equal((await probe(f, previousCookie)).statusCode, 200);
  const otherSid = randomUUID(); f.authSessions.set(otherSid, { user_id: f.other });
  const otherAppSid = randomUUID(); f.appSessions.set(otherAppSid, { user: f.other, revoked: false });
  const otherCookie = 'mf_session=' + jwt.sign({ sub: f.other, sid: otherAppSid, jti: randomUUID(), token_type: 'app' }, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app', expiresIn: '1h' });
  assert.equal((await f.reset()).statusCode, 200);
  assert.equal((await probe(f, previousCookie)).statusCode, 401);
  const before = f.stats().inserts; const stale = await f.exchange();
  assert.equal(stale.statusCode, 401, stale.body); rejected(stale, f, before);
  assert.equal((await probe(f, previousCookie)).statusCode, 401);
  assert.equal((await f.login('BeforeOnly9!')).statusCode, 401);
  const current = await f.login(body.contrasena); assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json().data.user.roles, ['cliente']);
  assert.equal((await probe(f, cookie(current))).statusCode, 200);
  const freshSid = [...f.authSessions.keys()].find(sid => sid !== otherSid);
  const fresh = await f.exchange(f.sign({ session_id: freshSid })); assert.equal(fresh.statusCode, 200, fresh.body);
  assert.deepEqual(fresh.json().data.user.roles, ['cliente']);
  assert.equal((await probe(f, cookie(fresh))).statusCode, 200);
  assert.equal((await probe(f, otherCookie)).statusCode, 200); assert.ok(f.authSessions.has(otherSid));
});
test('JWT y sesión Auth vigentes permiten exchange; SQL parametrizado exige identidad y permisos', async t => {
  const f = await setup(t); const r = await f.exchange(); assert.equal(r.statusCode, 200, r.body);
  assert.ok(f.calls.some(c => c.sql.includes('has_schema_privilege')));
  assert.ok(f.calls.some(c => c.sql.includes('FROM auth.sessions')));
});
for (const scenario of ['deleted', 'expired', 'missing', 'manipulated', 'other-user', 'not-after']) test('rechazo antes de emitir: ' + scenario, async t => {
  const f = await setup(t); let token = f.oldToken;
  if (scenario === 'deleted') f.authSessions.delete(f.oldSid);
  if (scenario === 'expired') token = f.sign({ exp: 1 });
  if (scenario === 'missing') token = f.sign({ session_id: undefined });
  if (scenario === 'manipulated') token = f.sign({ session_id: randomUUID() }, randomBytes(40).toString('hex'));
  if (scenario === 'other-user') f.authSessions.set(f.oldSid, { user_id: f.other });
  if (scenario === 'not-after') f.authSessions.set(f.oldSid, { user_id: USER, not_after: new Date(0) });
  const r = await f.exchange(token); assert.equal(r.statusCode, 401, r.body); rejected(r, f);
});
for (const option of ['providerThrow', 'providerUnavailable', 'permissionError', 'noPermission', 'sessionQueryError', 'connectError']) test('fallo cerrado sin cookies: ' + option, async t => {
  const f = await setup(t, { [option]: true }); const r = await f.exchange();
  assert.equal(r.statusCode, 503, r.body); rejected(r, f);
});
test('confirmación social conserva sesión legítima y rechaza prueba cuya sesión fue revocada', async t => {
  const f = await setup(t); const valid = await f.social(f.oldSid); assert.equal(valid.statusCode, 200, valid.body);
  assert.equal((await f.reset()).statusCode, 200); const count = f.stats().inserts;
  const stale = await f.social(f.oldSid); assert.equal(stale.statusCode, 401, stale.body); rejected(stale, f, count);
});
test('confirmación social antigua sin vínculo de sesión falla cerrada', async t => {
  const f = await setup(t); const r = await f.social(undefined); assert.equal(r.statusCode, 401, r.body); rejected(r, f);
});
test('Google pendiente conserva el vínculo firmado con la sesión verificada, sin emitir mf_session', async t => {
  const f = await setup(t, { newSocial: true }); let link;
  f.app.mailer.sendSocialProvisionConfirmationEmail = async message => { link = message.actionLink; return { sent: true }; };
  const r = await f.exchange(); assert.equal(r.statusCode, 202);
  assert.equal(cookie(r), undefined); assert.equal(f.stats().inserts, 0);
  const proof = new URL(link).searchParams.get('social_confirm_token');
  const claims = jwt.verify(proof, process.env.JWT_SECRET, { issuer: 'masterfade-api', audience: 'masterfade-app' });
  assert.equal(claims.session_id, f.oldSid); assert.equal(claims.sub, USER);
});
for (const roles of [['barbero'], ['admin'], ['super_admin'], ['super_admin', 'admin']]) test('exchange conserva los roles internos: ' + roles.join('+'), async t => {
  const f = await setup(t, { roles }); const r = await f.exchange(); assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().data.user.roles, roles);
});
for (const option of ['socialLookupError', 'socialMismatch']) test('confirmación social rechaza consulta inconsistente: ' + option, async t => {
  const f = await setup(t, { [option]: true }); const r = await f.social(f.oldSid);
  assert.equal(r.statusCode, option === 'socialLookupError' ? 503 : 401); rejected(r, f);
});
test('reset iniciado primero bloquea dos exchange hasta revocar la sesión Auth', async t => {
  let entered, release; const reached = new Promise(r => entered = r), wait = new Promise(r => release = r);
  const f = await setup(t, { beforeUpdate: async () => { entered(); await wait; } });
  const resetting = f.reset(); await reached;
  let completed = 0; const requests = [f.exchange(), f.exchange()].map(p => p.then(r => { completed++; return r; }));
  await new Promise(r => setTimeout(r, 20)); assert.equal(completed, 0); release();
  assert.equal((await resetting).statusCode, 200);
  for (const r of await Promise.all(requests)) { assert.equal(r.statusCode, 401, r.body); rejected(r, f); }
});
test('exchange validado primero mantiene lock hasta emisión: reset posterior revoca la cookie nueva', async t => {
  let entered, release; const reached = new Promise(r => entered = r), wait = new Promise(r => release = r);
  const f = await setup(t, { beforeInsert: async () => { entered(); await wait; } });
  const exchanging = f.exchange(); await reached; let resetDone = false;
  const resetting = f.reset().then(r => { resetDone = true; return r; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(resetDone, false); release();
  const exchanged = await exchanging; assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal((await resetting).statusCode, 200);
  assert.equal((await probe(f, cookie(exchanged))).statusCode, 401);
  assert.equal((await f.exchange()).statusCode, 401);
});
