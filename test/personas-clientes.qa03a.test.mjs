import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/personas.js";

const ID = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ROLE = "44444444-4444-4444-8444-444444444444";
const BRANCH = "55555555-5555-4555-8555-555555555555";
const payload = () => ({ persona: { nombres: "Ana", apellidos: "Sintetica", dni: "0801199012345", telefono_principal: "99990000" }, acceso: { correo_principal: "ana@example.test", habilitar_acceso: true }, cliente: {} });
const result = (rows = []) => ({ rows, rowCount: rows.length });

async function fixture(t, options = {}) {
  const state = { row: { id_cliente: ID, id_persona: PERSON, id_usuario: USER, nombres: "Ana", apellidos: "Sintetica", correo_principal: "ana@example.test", estado_cliente: true, tiene_acceso: true, estado_acceso: "activo", id_sucursal_origen: BRANCH, ...options.row }, activeRole: true, queries: [], auth: [], authUserExists: Boolean(options.authIdentity), snapshot: null };
  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    state.queries.push({ text, params });
    if (text === "BEGIN") { state.snapshot = { ...state.row }; return result(); }
    if (text === "COMMIT") return result();
    if (text === "ROLLBACK") { state.row = state.snapshot; return result(); }
    if (text.includes("FROM public.app_protected_users")) return result(options.protected ? [{ exists: 1 }] : []);
    if (text.includes("r.nombre = 'super_admin'")) return result(options.privileged ? [{ exists: 1 }] : []);
    if (text.startsWith("SELECT c.id_persona,") && text.includes("FROM public.correos c")) {
      return result(options.duplicateEmail || options.guestContact ? [{ id_persona: PERSON, nombres: "Ana", apellidos: "Invitada", has_user: false, has_client: false, has_employee: false }] : []);
    }
    if (text.includes("FROM public.clientes c")) {
      if (params[0] === "invalid") throw Object.assign(new Error("invalid input syntax for uuid"), { code: "22P02" });
      return result(options.missing ? [] : [{ ...state.row }]);
    }
    if (text.includes("FROM public.sucursales")) return result([{ id_sucursal: BRANCH }]);
    if (text.includes("FROM public.empleados")) return result();
    if (text.includes("FROM public.personas") && text.includes("regexp_replace")) return result(options.duplicateDni ? [{ id_persona: PERSON }] : []);
    if (text.includes("FROM public.correos") && text.includes("LOWER")) return result(options.duplicateEmail ? [{ id_persona: BRANCH }] : []);
    if (text.includes("FROM auth.users")) return result(state.authUserExists ? [{ id: options.foreignAuthId || USER }] : []);
    if (text === "SELECT id_rol, nombre FROM public.roles") return result([{ id_rol: ROLE, nombre: "cliente" }]);
    if (text.includes("FROM information_schema.columns")) return result([{ column_name: "acepta_terminos_at" }, { column_name: "consentimiento_marketing_at" }]);
    if (text.startsWith("SELECT") && text.includes("FROM public.clientes")) return result([{ consentimiento_marketing: false, acepta_terminos: false }]);
    if (text.startsWith("SELECT id_correo")) return result();
    if (text.startsWith("INSERT INTO public.personas")) return result([{ id_persona: PERSON }]);
    if (text.startsWith("INSERT INTO public.correos")) return result();
    if (text.startsWith("UPDATE public.personas")) { assert.equal(params[0], PERSON); return result(); }
    if (text.startsWith("INSERT INTO public.usuarios")) { state.row.estado_acceso = params[2]; return result(); }
    if (text.startsWith("UPDATE public.usuarios")) {
      if (text.includes("estado = FALSE")) state.row.estado_acceso = params[1];
      else if (text.includes("estado = TRUE")) state.row.estado_acceso = "activo";
      else if (state.row.estado_acceso === params[1]) state.row.estado_acceso = params[2];
      return result();
    }
    if (text.startsWith("UPDATE public.roles_usuarios")) { state.activeRole = !text.includes("activo = FALSE"); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("INSERT INTO public.roles_usuarios")) { state.activeRole = true; return result(); }
    if (text.startsWith("INSERT INTO public.clientes")) {
      if (options.sqlFailure) throw new Error("synthetic insert failure");
      state.row.estado_cliente = params[4] ?? true;
      return result([{ id_cliente: ID }]);
    }
    if (text.startsWith("UPDATE public.clientes")) {
      if (options.fechaIngreso) assert.equal(params[2], options.fechaIngreso.toISOString());
      if (options.sqlFailure) throw new Error("synthetic update failure");
      state.row.estado_cliente = text.includes("estado = FALSE") ? false : text.includes("estado = TRUE") ? true : params[4] ?? state.row.estado_cliente;
      return result();
    }
    throw new Error(`Unexpected query: ${text}`);
  }
  const app = Fastify({ logger: false });
  app.decorate("db", { query, connect: async () => ({ query, release() {} }) });
  app.decorate("supabaseAdmin", { auth: { admin: {
    createUser: async (input) => { state.auth.push(["create", input.email]); if (!options.authFailure) state.authUserExists = true; return options.authFailure ? { error: new Error("synthetic") } : { data: { user: { id: USER } } }; },
    deleteUser: async (id) => { state.auth.push(["delete", id]); state.authUserExists = false; return {}; },
    updateUserById: async (id, input) => { state.auth.push(["update", id, input.email]); return { data: { user: { id } } }; },
  } } });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    const roles = String(request.headers["x-roles"] ?? "").split(",").filter(Boolean);
    if (!roles.length) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ error: { code: "AUTH_FORBIDDEN" } });
    request.claims = { roles, branch_ids: [], user: { id_usuario: ROLE } };
  });
  await app.register(routes, { prefix: "/personas" });
  t.after(() => app.close());
  state.inject = (method, path = `/clientes/${ID}`, body, roles = "admin") => app.inject({ method, url: `/personas${path}`, payload: body, headers: { "x-roles": roles } });
  return state;
}

for (const path of ["", "/activar", "/inactivar"]) test(`admin no modifica cuenta privilegiada mediante Clientes ${path}`, async (t) => {
  const s = await fixture(t, { privileged: true });
  const response = await s.inject("PATCH", `/clientes/${ID}${path}`, path ? undefined : payload());
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "PERSONAS_SUPER_ADMIN_TARGET_FORBIDDEN");
  assert.equal(s.queries.some(({ text }) => /^(BEGIN|UPDATE|INSERT)/.test(text)), false);
});

test("editar cliente inactivo preserva bloqueo y rol desactivado", async (t) => {
  const s = await fixture(t, { row: { estado_cliente: false, estado_acceso: "bloqueado" } });
  s.activeRole = false;
  const r = await s.inject("PATCH", `/clientes/${ID}`, payload());
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(s.activeRole, false);
  assert.equal(s.row.estado_acceso, "bloqueado");
});

for (const method of ["POST", "PATCH"]) test(`${method} estado inactivo bloquea acceso y rol`, async (t) => {
  const s = await fixture(t);
  const body = payload(); body.cliente.estado = false;
  const r = await s.inject(method, method === "POST" ? "/clientes" : `/clientes/${ID}`, body);
  assert.equal(r.statusCode, method === "POST" ? 201 : 200, r.body);
  assert.equal(s.row.estado_acceso, "bloqueado");
  assert.equal(s.activeRole, false);
});

for (const roles of ["admin", "super_admin", "super_admin,admin"]) test(`listado global contractual y edición ordinaria: ${roles}`, async (t) => {
  const s = await fixture(t);
  assert.equal((await s.inject("GET", "/clientes", undefined, roles)).statusCode, 200);
  assert.equal((await s.inject("PATCH", `/clientes/${ID}`, payload(), roles)).statusCode, 200);
  assert.equal(s.row.estado_acceso, "activo");
});
for (const roles of ["", "cliente", "barbero"]) test(`rechazo previo a DB: ${roles || "anónimo"}`, async (t) => {
  const s = await fixture(t);
  for (const [method, path] of [["GET", "/clientes"], ["POST", "/clientes"], ["PATCH", `/clientes/${ID}`], ["PATCH", `/clientes/${ID}/inactivar`]]) {
    assert.equal((await s.inject(method, path, method === "POST" || path.endsWith(ID) && method === "PATCH" ? payload() : undefined, roles)).statusCode, roles ? 403 : 401);
  }
  assert.equal(s.queries.length, 0);
});
test("duplicado de correo invitado no fusiona persona ni crea Auth", async (t) => {
  const s = await fixture(t, { duplicateEmail: true });
  const r = await s.inject("POST", "/clientes", payload());
  assert.equal(r.statusCode, 409);
  assert.equal(s.auth.length, 0);
  assert.equal(s.queries.some(({ text }) => text === "BEGIN"), false);
});
test("invitado requiere confirmacion y luego conserva la Persona historica", async (t) => {
  const s = await fixture(t, { guestContact: true });
  const first = await s.inject("POST", "/clientes", payload());
  assert.equal(first.statusCode, 409);
  assert.equal(first.json().error.code, "PERSONAS_GUEST_LINK_REQUIRED");
  assert.equal(first.json().error.details.id_persona, PERSON);
  assert.equal(first.json().error.details.requiere_confirmacion, true);
  const body = payload();
  body.vinculacion_persona = { id_persona: PERSON, confirmar_vinculacion: true };
  const linked = await s.inject("POST", "/clientes", body);
  assert.equal(linked.statusCode, 201, linked.body);
  assert.equal(s.queries.some(({ text }) => text.startsWith("INSERT INTO public.personas")), false);
});
test("identidad Auth incompleta rechaza alta administrativa", async (t) => {
  const s = await fixture(t, { authIdentity: true, foreignAuthId: BRANCH });
  const response = await s.inject("POST", "/clientes", payload());
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PERSONAS_AUTH_IDENTITY_INCOMPLETE");
  assert.equal(s.auth.length, 0);
});
test("alta crea identidad independiente y compensa fallo SQL", async (t) => {
  const s = await fixture(t, { sqlFailure: true });
  assert.equal((await s.inject("POST", "/clientes", payload())).statusCode, 500);
  assert.deepEqual(s.auth.map(([op]) => op), ["create", "delete"]);
  assert.ok(s.queries.some(({ text }) => text === "ROLLBACK"));
});
test("Auth fallido no abre transacción", async (t) => {
  const s = await fixture(t, { authFailure: true });
  assert.equal((await s.inject("POST", "/clientes", payload())).statusCode, 500);
  assert.equal(s.queries.some(({ text }) => text === "BEGIN"), false);
});
test("inactivar y activar restauran el ciclo; DELETE permanece deshabilitado", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.inject("PATCH", `/clientes/${ID}/inactivar`)).statusCode, 200);
  assert.equal(s.row.estado_acceso, "bloqueado");
  assert.equal((await s.inject("PATCH", `/clientes/${ID}/activar`)).statusCode, 200);
  assert.equal(s.row.estado_acceso, "activo");
  assert.equal((await s.inject("DELETE", `/clientes/${ID}/permanente`)).statusCode, 410);
});
test("identificador inválido no llega al cast PostgreSQL", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.inject("GET", "/clientes/invalid")).statusCode, 400);
  assert.equal(s.queries.length, 0);
});

for (const path of ["", "/activar", "/inactivar"]) test(`protegido nunca mutable ${path}`, async (t) => {
  const s = await fixture(t, { protected: true });
  const r = await s.inject("PATCH", `/clientes/${ID}${path}`, path ? undefined : payload(), "super_admin");
  assert.equal(r.statusCode, 403);
  assert.equal(s.queries.some(({ text }) => /^(BEGIN|UPDATE|INSERT)/.test(text)), false);
});
for (const roles of ["super_admin", "super_admin,admin"]) test(`superadministrador conserva precedencia ${roles}`, async (t) => {
  const s = await fixture(t, { privileged: true });
  assert.equal((await s.inject("PATCH", `/clientes/${ID}/inactivar`, undefined, roles)).statusCode, 200);
});
test("alta válida normaliza correo y crea Persona nueva sin apropiarse del historial", async (t) => {
  const s = await fixture(t); const body = payload(); body.acceso.correo_principal = "ANA@EXAMPLE.TEST";
  assert.equal((await s.inject("POST", "/clientes", body)).statusCode, 201);
  assert.deepEqual(s.auth, [["create", "ana@example.test"]]);
  assert.ok(s.queries.some(({ text }) => text.startsWith("INSERT INTO public.personas")));
  assert.equal(s.queries.some(({ text }) => /UPDATE.*(citas|invitados|reservas)/i.test(text)), false);
});
for (const field of ["nombres", "apellidos", "dni", "telefono_principal"]) test(`alta rechaza campo obligatorio: ${field}`, async (t) => {
  const s = await fixture(t); const body = payload(); body.persona[field] = "";
  assert.equal((await s.inject("POST", "/clientes", body)).statusCode, 400);
  assert.equal(s.auth.length, 0);
});
test("sin acceso es rechazado por contrato; sin Usuario existente puede habilitar cuenta", async (t) => {
  const s = await fixture(t, { row: { id_usuario: null, tiene_acceso: false } });
  const body = payload(); body.acceso.habilitar_acceso = false;
  assert.equal((await s.inject("POST", "/clientes", body)).statusCode, 400);
  body.acceso.habilitar_acceso = true;
  assert.equal((await s.inject("PATCH", `/clientes/${ID}`, body)).statusCode, 200);
  assert.equal(s.auth[0][0], "create");
});
test("cliente ajeno inexistente devuelve 404 sin mutación", async (t) => {
  const s = await fixture(t, { missing: true });
  assert.equal((await s.inject("PATCH", `/clientes/${ID}`, payload())).statusCode, 404);
  assert.equal(s.queries.some(({ text }) => /^(BEGIN|UPDATE|INSERT)/.test(text)), false);
});
test("correo actualizado en Auth se compensa al fallar SQL", async (t) => {
  const s = await fixture(t, { sqlFailure: true }); const body = payload(); body.acceso.correo_principal = "nuevo@example.test";
  assert.equal((await s.inject("PATCH", `/clientes/${ID}`, body)).statusCode, 500);
  assert.deepEqual(s.auth, [["update", USER, "nuevo@example.test"], ["update", USER, "ana@example.test"]]);
  assert.ok(s.queries.some(({ text }) => text === "ROLLBACK"));
});
test("activación explícita por estado mantiene coherencia de acceso", async (t) => {
  const s = await fixture(t, { row: { estado_cliente: false, estado_acceso: "bloqueado" } });
  const body = payload(); body.cliente.estado = true;
  assert.equal((await s.inject("PATCH", `/clientes/${ID}`, body)).statusCode, 200);
  assert.equal(s.row.estado_acceso, "activo");
});

test("PATCH que omite fecha_ingreso conserva Date de pg como ISO válido", async (t) => {
  const date = new Date('2026-10-19T12:00:00Z');
  const s = await fixture(t, { row: { fecha_ingreso: date }, fechaIngreso: date });
  assert.equal((await s.inject('PATCH', `/clientes/${ID}`, payload())).statusCode, 200);
});
