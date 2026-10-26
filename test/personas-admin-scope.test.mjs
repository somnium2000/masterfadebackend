import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import personasRoutes from "../src/routes/v1/admin/personas.js";
import empleadosRoutes from "../src/routes/v1/admin/empleados.js";
import { getPersonasAdminScope, scopePersonasQuery } from "../src/services/personasAdminScope.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2), ACTOR = uuid(3);
const result = (rows = []) => ({ rows, rowCount: rows.length });
const assignment = (branch, role = "admin", active = true) => ({ branch, role, active });
const record = (n, extra) => ({
  id_persona: uuid(n), id_usuario: uuid(n + 100), id_empleado: uuid(n + 200), id_cliente: uuid(n + 300),
  nombres: `Persona ${n}`, apellidos: "Sintetica", nombre_completo: `Persona ${n} Sintetica`,
  estado_laboral: true, estado_cliente: true, estado: true, estado_acceso: "activo",
  correo_principal: `persona${n}@example.test`, email: `persona${n}@example.test`,
  roles: [], ...extra,
});
const data = [
  record(10, { id_sucursal: A, roles: [{ rol: "barbero", id_sucursal: A }] }),
  record(11, { id_sucursal: B, roles: [{ rol: "barbero", id_sucursal: B }] }),
  record(12, { id_sucursal_origen: A, roles: [{ rol: "cliente", id_sucursal: null }] }),
  record(13, { id_sucursal_origen: B, roles: [{ rol: "cliente", id_sucursal: B }] }),
  record(14, { id_sucursal_origen: null, historicalAppointmentBranch: A }),
  record(15, { id_sucursal: A, roles: [{ rol: "admin", id_sucursal: A }, { rol: "barbero", id_sucursal: B }] }),
  record(16, { id_sucursal: A, is_protected: true, roles: [{ rol: "admin", id_sucursal: A }] }),
  record(17, { id_sucursal: A, roles: [{ rol: "super_admin", id_sucursal: null }] }),
  record(18, { roles: [{ rol: "admin", id_sucursal: A }] }),
  record(19, { id_sucursal: A, id_sucursal_origen: B, roles: [{ rol: "barbero", id_sucursal: A }] }),
  record(20, { id_sucursal: A, roles: [{ rol: "barbero", id_sucursal: B, activo: false }] }),
  record(21, { id_sucursal: A, roles_reactivacion: [{ usuario: uuid(121), rol: "barbero", sucursal: B }] }),
  record(22, { id_sucursal: A, roles: [{ rol: "root", id_sucursal: null }] }),
];
const employeePayload = (branch = A) => ({
  persona: { nombres: "Nueva", apellidos: "Sintetica", dni: "0801199012345", telefono_principal: "99990000" },
  acceso: { correo_principal: "nueva@example.test", roles: ["barbero"] },
  empleado: { id_sucursal: branch, es_barbero: true, salario_base: 1000 },
});
const clientPayload = (branch = A) => ({
  persona: employeePayload().persona,
  acceso: { correo_principal: "nueva@example.test", habilitar_acceso: true },
  cliente: { id_sucursal_origen: branch },
});

// AM: El modelo independiente del doble HTTP representa relaciones, no ejecuta SQL.
function visible(row, branches) {
  const hasEmployee = Object.hasOwn(row, "id_sucursal");
  const hasClient = Object.hasOwn(row, "id_sucursal_origen");
  if (hasEmployee && !branches.includes(row.id_sucursal)) return false;
  if (hasClient && !branches.includes(row.id_sucursal_origen)) return false;
  if (row.is_protected) return false;
  if (row.roles.some((role) => ["root", "super_admin"].includes(role.rol)
    || (role.id_sucursal !== null && !branches.includes(role.id_sucursal))
    || (role.id_sucursal === null && (role.rol !== "cliente" || !hasClient)))) return false;
  if (row.roles_reactivacion?.some((role) => !branches.includes(role.sucursal))) return false;
  return hasEmployee || hasClient || row.roles.some((role) => role.rol === "admin"
    && role.activo !== false && branches.includes(role.id_sucursal));
}

async function fixture(t, { assignments = [assignment(A)], roles = ["admin"], guest = false, revokeAtBegin = false } = {}) {
  const activity = { writes: [], external: [], queries: [], transactions: [], assignments };
  const records = structuredClone(data);
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    activity.queries.push({ text, params });
    if (text.includes("AM: PERSONAS_ADMIN_BRANCHES")) {
      assert.deepEqual(params, [ACTOR]);
      assert.match(text, /ru\.activo IS TRUE/);
      assert.match(text, /r\.nombre = 'admin'/);
      assert.match(text, /ru\.id_usuario = \$1::uuid/);
      return result(activity.assignments.filter((a) => a.role === "admin" && a.active && a.branch)
        .map((a) => ({ id_sucursal: a.branch })));
    }
    if (text.includes("AM: PERSONAS_SCOPE_TARGET")) {
      const key = text.includes("JOIN public.empleados target") ? "id_empleado"
        : text.includes("JOIN public.clientes target") ? "id_cliente"
          : text.includes("JOIN public.usuarios target") ? "id_usuario" : "id_persona";
      return result(records.filter((row) => row[key] === params[0] && visible(row, params[1])));
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
      activity.transactions.push(text);
      if (text === "BEGIN" && revokeAtBegin) activity.assignments = [];
      return result();
    }
    if (/^(INSERT|UPDATE|DELETE)\b/.test(text)) {
      activity.writes.push(text);
      throw new Error("Escritura inesperada en una petición rechazada");
    }
    const scoped = text.includes("AM: PERSONAS_SCOPE_READ");
    let rows = scoped ? records.filter((row) => visible(row, params.at(-1))) : records;
    if (text.includes("FROM public.sucursales")) {
      return result([A, B].filter((branch) => !scoped || params.at(-1).includes(branch))
        .map((id_sucursal) => ({ id_sucursal, nombre_sucursal: id_sucursal === A ? "Sucursal A" : "Sucursal B" })));
    }
    if (text.includes("FROM public.app_protected_users")) return result();
    if (text.startsWith("SELECT 1") && text.includes("r.nombre = 'super_admin'")) return result();
    if (text.includes("SELECT c.id_persona,") && text.includes("FROM public.correos c")) {
      return result(guest ? [{ id_persona: uuid(90), nombres: "Historica", apellidos: "Privada", has_user: false, has_client: false, has_employee: false }] : []);
    }
    if (text.includes("FROM auth.users") && !text.includes("FROM public.usuarios u")) return result();
    if (text.includes("FROM public.roles") && !text.includes("FROM public.usuarios u") && !text.includes("FROM public.empleados e")) {
      return result(["admin", "barbero", "cliente", "super_admin"].filter((name) => !text.includes("WHERE nombre IN") || name !== "super_admin")
        .map((nombre, i) => ({ id_rol: uuid(800 + i), nombre })));
    }
    if (text.includes("FROM public.clientes c") && !text.includes("GROUP BY u.id_usuario")) {
      rows = rows.filter((row) => Object.hasOwn(row, "id_sucursal_origen"));
      if (text.includes("c.id_cliente = $1")) rows = rows.filter((row) => row.id_cliente === params[0]);
      else if (params.length && typeof params[0] === "string" && !params[0].includes("-")) {
        rows = rows.filter((row) => `${row.nombres} ${row.apellidos}`.toLowerCase().includes(params[0].toLowerCase()));
      }
      if (text.includes("SELECT COUNT(*)")) return result([{ total: String(rows.length) }]);
      if (text.includes("LIMIT $2::int OFFSET $3::int")) rows = rows.slice(params[2], params[2] + params[1]);
      return result(rows);
    }
    if (text.includes("FROM public.empleados e") && !text.includes("GROUP BY u.id_usuario")) {
      rows = rows.filter((row) => Object.hasOwn(row, "id_sucursal"));
      if (text.includes("e.id_empleado = $1")) rows = rows.filter((row) => row.id_empleado === params[0]);
      return result(text.includes("AS activo")
        ? rows.map((row) => ({ ...row, roles: row.roles.filter((role) => role.activo !== false).map((role) => role.rol) }))
        : rows);
    }
    if (text.includes("FROM public.usuarios u")) {
      if (text.includes("GROUP BY u.id_usuario")) rows = rows.filter((row) => Object.hasOwn(row, "id_sucursal")
        || Object.hasOwn(row, "id_sucursal_origen") || row.roles.some((role) => role.rol === (scoped ? "admin" : "super_admin")));
      if (params[0] && !Array.isArray(params[0])) rows = rows.filter((row) => row.id_usuario === params[0]);
      return result(rows.map((row) => ({ ...row, tiene_empleado: Object.hasOwn(row, "id_sucursal"), tiene_cliente: Object.hasOwn(row, "id_sucursal_origen") })));
    }
    throw new Error(`Consulta no prevista en el doble HTTP: ${text.slice(0, 120)}`);
  };
  const app = Fastify({ logger: false });
  app.decorate("db", { query, connect: async () => ({ query, release() {} }) });
  const external = (name) => async () => { activity.external.push(name); throw new Error("Efecto externo inesperado"); };
  app.decorate("supabaseAdmin", {
    auth: { admin: { createUser: external("auth-create"), updateUserById: external("auth-update"), generateLink: external("auth-link") } },
    storage: { from() { activity.external.push("storage"); throw new Error("Archivo inesperado"); } },
  });
  app.decorate("mailer", { configured: true, sendPasswordRecoveryEmail: external("smtp") });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ error: { code: "AUTH_FORBIDDEN" } });
    request.claims = { roles, branch_ids: [A, B], user: { id_usuario: ACTOR } };
  });
  await app.register(personasRoutes, { prefix: "/personas" });
  await app.register(empleadosRoutes, { prefix: "/legacy" });
  t.after(() => app.close());
  return { app, activity, call: (method, url, payload) => app.inject({ method, url, payload }) };
}

test("el alcance deriva solo de asignaciones admin activas; Super Admin no consulta asignaciones", async () => {
  let calls = 0;
  const db = { async query(sql, params) {
    calls++;
    assert.match(sql, /JOIN public.roles r/);
    assert.match(sql, /r.nombre = 'admin'/);
    assert.match(sql, /ru.activo IS TRUE/);
    assert.deepEqual(params, [ACTOR]);
    return result([{ id_sucursal: A }, { id_sucursal: A }]);
  } };
  assert.deepEqual(await getPersonasAdminScope(db, { roles: ["admin", "barbero"], branch_ids: [B], user: { id_usuario: ACTOR } }), { global: false, branchIds: [A] });
  assert.deepEqual(await getPersonasAdminScope(db, { roles: ["super_admin", "admin"] }), { global: true, branchIds: [] });
  assert.equal(calls, 1);
});

for (const branch of [A, B]) test(`Admin asignado a ${branch} solo obtiene su alcance en las cinco lecturas`, async (t) => {
  const s = await fixture(t, { assignments: [assignment(branch)] });
  for (const [url, collection, key] of [
    ["/personas/empleados", "empleados", "id_empleado"], ["/legacy/", "empleados", "id_empleado"],
    ["/personas/clientes", "clientes", "id_cliente"], ["/personas/usuarios", "usuarios", "id_usuario"],
  ]) {
    const r = await s.call("GET", url);
    assert.equal(r.statusCode, 200, r.body);
    const expected = data.filter((row) => visible(row, [branch]) && (collection === "usuarios"
      || Object.hasOwn(row, collection === "clientes" ? "id_sucursal_origen" : "id_sucursal")));
    assert.deepEqual(r.json().data[collection].map((row) => row[key]), expected.map((row) => row[key]), url);
  }
  const catalog = await s.call("GET", "/personas/catalogos");
  assert.deepEqual(catalog.json().data.sucursales.map((row) => row.id_sucursal), [branch]);
  assert.ok(!catalog.json().data.roles.some((role) => role.nombre === "super_admin"));
});

test("Admin con varias sucursales puede consultar relaciones comprendidas en ambas", async (t) => {
  const s = await fixture(t, { assignments: [assignment(A), assignment(B)] });
  const r = await s.call("GET", "/personas/empleados");
  assert.equal(r.statusCode, 200, r.body);
  const ids = r.json().data.empleados.map((row) => row.id_empleado);
  for (const n of [10, 11, 15, 19, 20, 21]) assert.ok(ids.includes(uuid(n + 200)));
  for (const n of [16, 17, 22]) assert.ok(!ids.includes(uuid(n + 200)));
});

for (const assignments of [[], [assignment(A, "admin", false)], [assignment(B, "barbero")]]) {
  test(`sin asignación administrativa activa devuelve resultados vacíos: ${JSON.stringify(assignments)}`, async (t) => {
    const s = await fixture(t, { assignments });
    for (const group of ["empleados", "clientes", "usuarios"]) {
      const r = await s.call("GET", `/personas/${group}`);
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json().data[group], []);
    }
    const catalog = await s.call("GET", "/personas/catalogos");
    assert.deepEqual(catalog.json().data.sucursales, []);
    const detail = await s.call("GET", `/personas/empleados/${uuid(210)}`);
    assert.equal(detail.statusCode, 403);
    assert.equal(detail.json().error.code, "AUTH_FORBIDDEN_BRANCH");
  });
}

test("Admin + Barbero en sucursales distintas no hereda el alcance Barbero", async (t) => {
  const s = await fixture(t, { assignments: [assignment(A), assignment(B, "barbero")], roles: ["admin", "barbero"] });
  const r = await s.call("GET", "/personas/empleados");
  assert.deepEqual(r.json().data.empleados.map((row) => row.id_empleado), [uuid(210)]);
  const denied = await s.call("POST", "/personas/empleados", employeePayload(B));
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(s.activity.external, []);
  assert.deepEqual(s.activity.writes, []);
});

test("Super Admin conserva lecturas globales y el detalle del Cliente sin origen", async (t) => {
  const s = await fixture(t, { roles: ["super_admin", "admin"], assignments: [] });
  const employees = await s.call("GET", "/personas/empleados");
  assert.equal(employees.statusCode, 200, employees.body);
  assert.equal(employees.json().data.empleados.length, data.filter((row) => Object.hasOwn(row, "id_sucursal")).length);
  const client = await s.call("GET", `/personas/clientes/${uuid(314)}`);
  assert.equal(client.statusCode, 200, client.body);
  const catalog = await s.call("GET", "/personas/catalogos");
  assert.equal(catalog.json().data.sucursales.length, 2);
  assert.ok(catalog.json().data.roles.some((role) => role.nombre === "super_admin"));
  assert.ok(!s.activity.queries.some(({ text }) => text.includes("AM: PERSONAS_ADMIN_BRANCHES")));
});

for (const [group, id] of [["empleados", uuid(211)], ["clientes", uuid(313)], ["clientes", uuid(314)]]) {
  test(`detalle fuera de alcance no revela datos: ${group}/${id}`, async (t) => {
    const s = await fixture(t);
    const r = await s.call("GET", `/personas/${group}/${id}`);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error.code, "AUTH_FORBIDDEN_BRANCH");
    assert.equal(r.json().data, undefined);
    assert.deepEqual(s.activity.external, []);
  });
}

const rejected = [
  ["PATCH", `/personas/empleados/${uuid(211)}`, employeePayload(B)],
  ["PATCH", `/personas/empleados/${uuid(210)}`, employeePayload(B)],
  ["PATCH", `/personas/clientes/${uuid(313)}`, clientPayload(B)],
  ["PATCH", `/personas/clientes/${uuid(312)}`, clientPayload(B)],
  ["PATCH", `/personas/clientes/${uuid(312)}`, clientPayload(null)],
  ["POST", "/personas/empleados", employeePayload(B)],
  ["POST", "/personas/clientes", clientPayload(B)],
  ["POST", "/personas/clientes", clientPayload(null)],
  ...["activar", "inactivar"].flatMap((suffix) => [
    ["PATCH", `/personas/empleados/${uuid(211)}/${suffix}`],
    ["PATCH", `/personas/clientes/${uuid(313)}/${suffix}`],
    ["PATCH", `/personas/clientes/${uuid(314)}/${suffix}`],
    ["PATCH", `/personas/empleados/${uuid(215)}/${suffix}`],
    ["PATCH", `/personas/empleados/${uuid(219)}/${suffix}`],
  ]),
  ["PATCH", `/personas/usuarios/${uuid(111)}`, { persona: { nombres: "Cambio" } }],
  ...["activar", "inactivar", "bloquear"].map((suffix) => ["PATCH", `/personas/usuarios/${uuid(111)}/${suffix}`]),
  ["PATCH", `/personas/usuarios/${uuid(111)}/estado-acceso`, { estado_acceso: "bloqueado" }],
  ["POST", `/personas/usuarios/${uuid(111)}/enviar-configuracion-password`, {}],
  ["POST", `/personas/usuarios/${uuid(115)}/enviar-configuracion-password`, {}],
];
for (const [method, url, payload] of rejected) test(`rechaza antes de escrituras, archivos, Auth o SMTP: ${method} ${url}`, async (t) => {
  const s = await fixture(t);
  const r = await s.call(method, url, payload);
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(r.json().error.code, "AUTH_FORBIDDEN_BRANCH");
  assert.deepEqual(s.activity.writes, []);
  assert.deepEqual(s.activity.external, []);
  assert.deepEqual(s.activity.transactions, []);
});

test("revocación antes de BEGIN se revalida y revierte antes de la primera escritura", async (t) => {
  const s = await fixture(t, { revokeAtBegin: true });
  const r = await s.call("PATCH", `/personas/usuarios/${uuid(110)}`, { persona: { nombres: "Cambio" } });
  assert.equal(r.statusCode, 403, r.body);
  assert.deepEqual(s.activity.transactions, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(s.activity.writes, []);
  assert.deepEqual(s.activity.external, []);
});

test("invitado sin pertenencia verificable no expone el modal ni permite apropiación por correo", async (t) => {
  const s = await fixture(t, { guest: true });
  for (const confirmed of [false, true]) {
    const payload = employeePayload();
    if (confirmed) payload.vinculacion_persona = { id_persona: uuid(90), confirmar_vinculacion: true };
    const r = await s.call("POST", "/personas/empleados", payload);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error.code, "AUTH_FORBIDDEN_BRANCH");
    assert.doesNotMatch(r.body, /Historica|Privada|000000000090/);
  }
  assert.deepEqual(s.activity.external, []);
  assert.deepEqual(s.activity.writes, []);
});

test("búsqueda, conteo y paginación comparten el alcance antes de LIMIT/OFFSET", async (t) => {
  const s = await fixture(t);
  const r = await s.call("GET", "/personas/clientes?q=Persona&limit=1&page=2");
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().data.clientes, []);
  assert.equal(r.json().data.pagination.total, 1);
  const reads = s.activity.queries.filter(({ text }) => text.includes("AM: PERSONAS_SCOPE_READ"));
  assert.equal(reads.length, 2);
  for (const { text, params } of reads) {
    assert.deepEqual(params.at(-1), [A]);
    assert.match(text, /c.id_sucursal_origen = ANY\(\$[24]::uuid\[\]\)/);
    assert.ok(text.indexOf("AM: PERSONAS_SCOPE_BEGIN") < text.indexOf("LIMIT $2::int") || !text.includes("LIMIT $2::int"));
  }
});

test("SQL bloquea relaciones ajenas, protegidas y roles históricos sin usar citas ni claims", () => {
  const sql = "SELECT * FROM public.usuarios u\n  WHERE u.deleted_at IS NULL AND r_sa.nombre = 'super_admin' GROUP BY u.id_usuario";
  const scoped = scopePersonasQuery(sql, [], { global: false, branchIds: [A] }, "usuario");
  assert.match(scoped.text, /r_sa.nombre = 'admin' AND ru_sa.id_sucursal = ANY\(\$1::uuid\[\]\)/);
  for (const fragment of ["scope_employee.id_sucursal", "scope_client.id_sucursal_origen", "scope_role.activo IS TRUE", "scope_protected.activo IS TRUE", "'root', 'super_admin'", "scope_employee.roles_reactivacion", "scope_role.id_sucursal IS NULL", "scope_client.id_persona IS DISTINCT FROM scope_owner.id_persona"]) assert.ok(scoped.text.includes(fragment), fragment);
  assert.doesNotMatch(scoped.text, /public.citas|branch_ids/);
  assert.deepEqual(scopePersonasQuery(sql, [], { global: true, branchIds: [] }, "usuario"), { text: sql, values: [] });
});

for (const role of ["cliente", "barbero"]) test(`perfil propio ${role} no recibe acceso administrativo implícito`, async (t) => {
  const s = await fixture(t, { roles: [role] });
  const r = await s.call("GET", "/personas/empleados");
  assert.equal(r.statusCode, 403);
  assert.deepEqual(s.activity.queries, []);
});
