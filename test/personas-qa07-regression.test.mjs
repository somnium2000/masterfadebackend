import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/personas.js";

const U = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const E = "11111111-1111-4111-8111-111111111111";

async function fixture(t, { state = "activo", lockedState = state, sent = true, privileged = false, protectedUser = false, authError = false, mailError = false, missingToken = false, missingAuthUser = false, missingUser = false } = {}) {
  const activity = { writes: [], auth: 0, mail: 0, sql: [], events: [], locked: false };
  const row = { id_usuario: U, id_persona: P, estado_acceso: state, nombres: "Prueba", apellidos: "Sintetica", email: "synthetic@example.test", estado: true, tiene_empleado: true, roles: [{ rol: "admin" }] };
  const query = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    activity.sql.push(text);
    if (/^(UPDATE|INSERT|DELETE)/.test(text)) activity.writes.push({ text, params });
    if (text === "COMMIT" || text === "ROLLBACK") { activity.events.push(text); activity.locked = false; return { rows: [], rowCount: 0 }; }
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    if (text.includes("FOR UPDATE")) { activity.locked = true; return { rows: [{ estado_acceso: lockedState }], rowCount: 1 }; }
    if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: protectedUser ? 1 : 0 };
    if (text.includes("AS has_empleado")) return { rows: [{ has_empleado: true }], rowCount: 1 };
    if (text.includes("r.nombre = 'super_admin'") && !text.includes("GROUP BY")) return { rows: [], rowCount: privileged ? 1 : 0 };
    if (text.startsWith("UPDATE")) { activity.events.push("UPDATE"); return { rows: [], rowCount: 1 }; }
    if (text.includes("FROM public.usuarios u")) return { rows: missingUser ? [] : [row], rowCount: missingUser ? 0 : 1 };
    if (text.includes("FROM public.empleados e")) return { rows: [{ id_empleado: E, id_persona: P, estado_laboral: true }], rowCount: 1 };
    throw new Error("Unexpected mocked query");
  };
  const app = Fastify({ logger: false });
  app.decorate("db", { query, connect: async () => ({ query, release() {} }) });
  app.decorate("supabaseAdmin", { auth: { admin: { async generateLink(input) {
    assert.equal(activity.locked, true);
    activity.auth++;
    activity.generated = input;
    if (authError) throw new Error("SQL host token synthetic-private");
    if (missingAuthUser) return { error: { code: 'user_not_found' } };
    return { data: { properties: { hashed_token: missingToken ? undefined : 'synthetic-setup-hash-not-real', action_link: "https://example.test/auth/v1/verify" } } };
  } } } });
  app.decorate("mailer", { configured: true, async sendPasswordRecoveryEmail(message) {
    assert.equal(activity.locked, true);
    activity.mail++; activity.events.push("MAIL");
    activity.delivered = message;
    if (mailError) throw new Error("SMTP host token synthetic-private");
    return { sent };
  } });
  app.decorate("requireRoles", () => async request => { request.claims = { roles: ["admin"], user: { id_usuario: U } }; });
  await app.register(routes, { prefix: "/personas" });
  t.after(() => app.close());
  return { app, activity };
}

for (const state of ["bloqueado", "inactivo"]) for (const payload of [{}, { marcar_pendiente_password: false }]) {
  test(`setup rechaza ${state}, mark=${payload.marcar_pendiente_password}`, async t => {
    const { app, activity } = await fixture(t, { state });
    const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, "PERSONAS_USER_SETUP_ACCESS_RESTRICTED");
    assert.equal(activity.auth + activity.mail + activity.writes.length, 0);
    assert.ok(!activity.sql.includes("BEGIN"));
  });
}
for (const state of ["activo", "pendiente_password"]) for (const sent of [true, false]) {
  test(`setup ${state}, enviado=${sent} conserva contrato y no transiciona al fallar`, async t => {
    const { app, activity } = await fixture(t, { state, sent });
    const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().data.setup_password.enviado, sent);
    assert.equal(r.json().data.estado_acceso_objetivo, sent ? "pendiente_password" : state);
    assert.equal(activity.writes.length, sent ? 1 : 0);
    if (sent) assert.deepEqual(activity.events, ["MAIL", "UPDATE", "COMMIT"]);
    else assert.deepEqual(activity.events, ["MAIL", "COMMIT"]);
    assert.ok(activity.writes.every(w => !/SET estado =|roles_usuarios|id_sucursal/.test(w.text)));
  });
}
test("setup sin marcar pendiente mantiene activo y envía una vez", async t => {
  const { app, activity } = await fixture(t);
  const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: { marcar_pendiente_password: false } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().data.estado_acceso_objetivo, "activo");
  assert.equal(activity.writes.length, 0); assert.equal(activity.mail, 1);
});
for (const options of [{ authError: true }, { mailError: true }]) test("fallo externo simulado no transiciona ni expone detalles " + JSON.stringify(options), async t => {
  const { app, activity } = await fixture(t, options);
  const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(r.statusCode, 200); assert.equal(r.json().data.setup_password.enviado, false);
  assert.equal(r.json().data.estado_acceso_objetivo, "activo");
  assert.equal(activity.writes.length, 0); assert.ok(!r.body.includes("synthetic-private"));
});
test("bloqueo concurrente antes del lock se conserva sin enlaces ni escrituras", async t => {
  const { app, activity } = await fixture(t, { lockedState: "bloqueado" });
  const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(r.statusCode, 409);
  assert.equal(activity.auth + activity.mail + activity.writes.length, 0);
  assert.ok(activity.sql.includes("ROLLBACK"));
});
for (const options of [{ privileged: true }, { protectedUser: true }]) test("setup conserva protección jerárquica " + JSON.stringify(options), async t => {
  const { app, activity } = await fixture(t, options);
  const r = await app.inject({ method: "POST", url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(r.statusCode, 403); assert.equal(activity.auth + activity.mail + activity.writes.length, 0);
});
test('setup entrega enlace del FRONTEND_URL QA con hash por fragmento sin filtrar en API', async t => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://qa-setup.example.test/';
  t.after(() => { if (previous === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previous; });
  const { app, activity } = await fixture(t);
  const response = await app.inject({ method: 'POST', url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.setup_password.enviado, true);
  const target = new URL(activity.delivered.actionLink);
  assert.equal(target.origin, 'https://qa-setup.example.test');
  assert.equal(target.pathname, '/reset-password');
  assert.equal(target.search, '');
  assert.deepEqual([...new URLSearchParams(target.hash.slice(1))], [['token_hash', 'synthetic-setup-hash-not-real'], ['type', 'recovery']]);
  assert.equal(activity.generated.options.redirectTo, 'https://qa-setup.example.test/reset-password');
  assert.equal(activity.delivered.kind, 'setup');
  assert.doesNotMatch(response.body, /synthetic-setup|token_hash|auth\/v1\/verify|localhost/);
});
for (const options of [{ missingToken: true }, { missingAuthUser: true }]) test('setup sin prueba válida no envía SMTP ni cambia acceso ' + JSON.stringify(options), async t => {
  const { app, activity } = await fixture(t, options);
  const response = await app.inject({ method: 'POST', url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.setup_password.enviado, false);
  assert.equal(activity.mail, 0);
  assert.equal(activity.writes.length, 0);
  assert.doesNotMatch(response.body, /synthetic-setup|token_hash|auth\/v1\/verify/);
});
test('setup de usuario interno inexistente no genera enlace', async t => {
  const { app, activity } = await fixture(t, { missingUser: true });
  const response = await app.inject({ method: 'POST', url: `/personas/usuarios/${U}/enviar-configuracion-password`, payload: {} });
  assert.equal(response.statusCode, 404);
  assert.equal(activity.auth + activity.mail + activity.writes.length, 0);
});
test("UUID inválido no consulta detalle; válido conserva 200", async t => {
  const { app, activity } = await fixture(t);
  const invalid = await app.inject({ method: "GET", url: "/personas/empleados/invalid" });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error.code, "PERSONAS_EMPLOYEE_ID_INVALID");
  assert.equal(activity.sql.length, 0);
  assert.equal((await app.inject({ method: "GET", url: `/personas/empleados/${E}` })).statusCode, 200);
});
for (const field of ["nombres", "apellidos"]) for (const value of [null, "", "   "]) test(`rechaza ${field}=${JSON.stringify(value)} sin UPDATE`, async t => {
  const { app, activity } = await fixture(t);
  const r = await app.inject({ method: "PATCH", url: `/personas/usuarios/${U}`, payload: { persona: { [field]: value } } });
  assert.equal(r.statusCode, 400); assert.equal(activity.writes.length, 0);
});
for (const persona of [{ nombres: " Nombre ", apellidos: " Apellido " }, { telefono_principal: "sintetico" }]) test("actualización personal válida " + JSON.stringify(Object.keys(persona)), async t => {
  const { app, activity } = await fixture(t);
  const r = await app.inject({ method: "PATCH", url: `/personas/usuarios/${U}`, payload: { persona } });
  assert.equal(r.statusCode, 200); assert.equal(activity.writes.length, 1);
});
