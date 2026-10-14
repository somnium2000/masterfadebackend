import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/configuracion.js";

process.env.COMMUNICATION_SCHEDULER_ENABLED = "false";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROMO = "11111111-1111-4111-8111-111111111111";
const SERVICE = "21111111-1111-4111-8111-111111111111";
const PACKAGE = "31111111-1111-4111-8111-111111111111";
const RULE = "41111111-1111-4111-8111-111111111111";
const USER = "51111111-1111-4111-8111-111111111111";
const OTHER_USER = "61111111-1111-4111-8111-111111111111";
const assignment = (rol, id_sucursal, activo = true, id_usuario = USER) => ({ rol, id_sucursal, activo, id_usuario });
const base = (id_sucursal = A) => ({
  id_promocion: PROMO, id_sucursal, titulo: "Promocion original", slug: "promocion-original",
  subtitulo: "Original", parrafos: ["Descripcion original"], estado: "borrador", visible_publico: false,
  destacada: false, orden_visual: 10, tipo_promocion: "descuento_servicio", aplica_a: "servicio",
  mecanica: "porcentaje", id_servicio_objetivo: SERVICE, id_paquete_objetivo: null, valor_descuento: 10,
  cantidad_requerida: null, cantidad_bonificada: null, imagen_principal_url: "https://example.test/promo.png",
  vigencia_desde: "2027-01-01", vigencia_hasta: "2027-01-31", vigencia_hora_desde: "09:00:00", vigencia_hora_hasta: "18:00:00",
});
const createPayload = (branch = A) => ({ ...base(branch), id_promocion: undefined });

async function buildApp({ roles = ["admin"], branches = [A], assignments = branches.map((id) => assignment("admin", id)), userId = USER, missingUser = false, missingBranch = false, failWrite = false, duplicate = false } = {}) {
  const state = { queries: [], assetCalls: 0, reads: [], writes: [], commit: 0, rollback: 0, row: base() };
  const query = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    state.queries.push({ text, params });
    if (text.startsWith("SELECT 1 FROM public.roles_usuarios ru")) {
      assert.match(text, /JOIN public\.roles r ON r\.id_rol = ru\.id_rol/);
      assert.match(text, /WHERE ru\.id_usuario = \$1::uuid/);
      assert.match(text, /AND ru\.id_sucursal = \$2::uuid/);
      assert.match(text, /AND ru\.activo IS TRUE/);
      assert.match(text, /AND r\.nombre = 'admin'/);
      assert.deepEqual(params.slice(0, 1), [userId]);
      assert.ok(!text.includes(userId) && !text.includes(params[1]));
      const allowed = assignments.some((item) => item.id_usuario === params[0] && item.id_sucursal === params[1] && item.rol === "admin" && item.activo === true);
      return { rows: allowed ? [{}] : [], rowCount: allowed ? 1 : 0 };
    }
    if (text === "BEGIN") return { rows: [], rowCount: 0 };
    if (text === "COMMIT") { state.commit++; return { rows: [], rowCount: 0 }; }
    if (text === "ROLLBACK") { state.rollback++; return { rows: [], rowCount: 0 }; }
    if (text.includes("FROM public.comunicaciones_campanias")) return text.includes("SELECT COUNT(*)::int AS total FROM filtered")
      ? { rows: [{ total: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (text.includes("FROM public.sucursales") && text.startsWith("SELECT 1")) return { rows: missingBranch ? [] : [{}], rowCount: missingBranch ? 0 : 1 };
    if (text.includes("FROM public.promociones p") && text.includes("JOIN public.promociones_sucursal ps")) {
      state.reads.push(params);
      const rows = params.length === 1
        ? (params[0] ? [{ ...state.row, id_sucursal: params[0] }] : [base(A), base(B)])
        : [{ ...state.row, id_sucursal: params[1] }];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("LOWER(TRIM(slug))")) return { rows: duplicate ? [{ id_promocion: PROMO }] : [], rowCount: duplicate ? 1 : 0 };
    if (text.includes("disponible_en_sucursal")) return { rows: [{ id_servicio: SERVICE, id_paquete: PACKAGE, disponible_en_sucursal: true }], rowCount: 1 };
    if (text.includes("SELECT id_promocion_regla")) return { rows: [{ id_promocion_regla: RULE }], rowCount: 1 };
    if (text.startsWith("SELECT 1 FROM public.promociones_sucursal")) return { rows: [], rowCount: 0 };
    if (/^(INSERT|UPDATE|DELETE)/.test(text)) {
      if (failWrite) throw new Error("simulated");
      state.writes.push({ sql: text, params });
      if (text.startsWith("INSERT INTO public.promociones (")) {
        state.row = { ...state.row, slug: params[0], titulo: params[1], subtitulo: params[2], parrafos: JSON.parse(params[3]),
          imagen_principal_url: params[6], imagen_mobile_url: params[9], tipo_promocion: params[11], aplica_a: params[12], mecanica: params[13],
          id_servicio_objetivo: params[14], id_paquete_objetivo: params[15], valor_descuento: params[16], cantidad_requerida: params[17], cantidad_bonificada: params[18], estado: params[19] };
        return { rows: [{ id_promocion: PROMO }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.promociones SET")) {
        state.row = { ...state.row, slug: params[1], titulo: params[2], subtitulo: params[3], parrafos: JSON.parse(params[4]),
          imagen_principal_url: params[7], imagen_mobile_url: params[10], estado: params[12], tipo_promocion: params[13], aplica_a: params[14], mecanica: params[15],
          id_servicio_objetivo: params[16], id_paquete_objetivo: params[17], valor_descuento: params[18], cantidad_requerida: params[19], cantidad_bonificada: params[20] };
      }
      if (text.startsWith("UPDATE public.promociones_sucursal") || text.startsWith("INSERT INTO public.promociones_sucursal")) {
        Object.assign(state.row, { id_sucursal: params[1], visible_publico: params[2], vigencia_desde: params[3], vigencia_hasta: params[4],
          vigencia_hora_desde: params[5], vigencia_hora_hasta: params[6], orden_visual: params[7], destacada: params[8] });
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error("Unexpected mock query");
  };
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ ok: false, error: { code: "AUTH_REQUIRED", message: "Unauthorized" } });
    if (!roles.some((role) => allowed.includes(role))) return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    request.claims = { roles, branch_ids: branches, user: missingUser ? undefined : { id_usuario: userId } };
  });
  app.decorate("db", { connect: async () => ({ query, release() {} }) });
  app.decorate("supabase", { storage: { from() { state.assetCalls++; throw new Error("Unexpected storage operation in authorization test"); } } });
  await app.register(routes, { prefix: "/v1/admin/configuracion" });
  await app.ready();
  return { app, state };
}

const requests = (branch = B) => [
  { method: "GET", url: `/v1/admin/configuracion/promociones?id_sucursal=${branch}` },
  { method: "GET", url: `/v1/admin/configuracion/promociones/${PROMO}?id_sucursal=${branch}` },
  { method: "POST", url: "/v1/admin/configuracion/promociones", payload: createPayload(branch) },
  { method: "PATCH", url: `/v1/admin/configuracion/promociones/${PROMO}`, payload: { id_sucursal: branch, subtitulo: "Nuevo" } },
];

for (const branches of [[A], []]) {
  test(`admin ${branches.length} sucursales no obtiene listado global`, async (t) => {
    const { app, state } = await buildApp({ branches }); t.after(() => app.close());
    assert.equal((await app.inject({ method: "GET", url: "/v1/admin/configuracion/promociones" })).statusCode, 403);
    assert.equal(state.reads.length, 0);
    assert.equal(state.writes.length, 0);
  });
  for (const request of requests()) {
    test(`admin ${branches.length} sucursales rechaza ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp({ branches }); t.after(() => app.close());
      assert.equal((await app.inject(request)).statusCode, 403);
      assert.equal(state.reads.length, 0);
      assert.equal(state.writes.length, 0);
      assert.equal(state.commit, 0);
    });
  }
}

for (const roles of [["admin"], ["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join("+")} conserva las cuatro operaciones autorizadas`, async (t) => {
    const { app, state } = await buildApp({ roles }); t.after(() => app.close());
    for (const request of requests(A)) assert.equal((await app.inject(request)).statusCode, request.method === "POST" ? 201 : 200);
    assert.equal(state.commit, 2);
  });
}

test("super_admin conserva listado global y sucursal ajena a claims", async (t) => {
  const { app } = await buildApp({ roles: ["super_admin"], branches: [] }); t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/admin/configuracion/promociones" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.promociones.map((row) => row.id_sucursal), [A, B]);
  for (const request of requests(B)) assert.equal((await app.inject(request)).statusCode, request.method === "POST" ? 201 : 200);
});

for (const roles of [null, ["cliente"]]) {
  test(`sin autorizacion conserva ${roles ? 403 : 401}`, async (t) => {
    const { app, state } = await buildApp({ roles }); t.after(() => app.close());
    for (const request of requests(A)) assert.equal((await app.inject(request)).statusCode, roles ? 403 : 401);
    assert.equal(state.reads.length + state.writes.length, 0);
  });
}

test("admin con varias sucursales requiere alcance explicito", async (t) => {
  const { app, state } = await buildApp({ branches: [A, B] }); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/configuracion/promociones" })).statusCode, 403);
  assert.equal(state.reads.length, 0);
  for (const request of requests(B)) assert.equal((await app.inject(request)).statusCode, request.method === "POST" ? 201 : 200);
});

test("sucursal inexistente conserva 404 para actor autorizado", async (t) => {
  const { app, state } = await buildApp({ missingBranch: true }); t.after(() => app.close());
  for (const request of requests(A)) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "CONFIG_BRANCH_NOT_FOUND");
  }
  assert.equal(state.reads.length + state.writes.length, 0);
});

test("edicion descriptiva preserva imagen, vigencias y campos comerciales", async (t) => {
  const { app, state } = await buildApp(); t.after(() => app.close());
  const response = await app.inject(requests(A)[3]);
  assert.equal(response.statusCode, 200);
  const row = response.json().data.promocion;
  for (const key of ['titulo', 'slug', 'parrafos', 'tipo_promocion', 'aplica_a', 'mecanica', 'id_servicio_objetivo', 'id_paquete_objetivo', 'valor_descuento', 'cantidad_requerida', 'cantidad_bonificada', 'imagen_principal_url', 'vigencia_desde', 'vigencia_hasta', 'vigencia_hora_desde', 'vigencia_hora_hasta', 'visible_publico', 'destacada', 'estado', 'orden_visual']) {
    assert.deepEqual(row[key], base()[key], key);
  }
  assert.equal(row.subtitulo, 'Nuevo');
  assert.equal(state.commit, 1);
});

for (const commercial of [
  { tipo_promocion: 'descuento_servicio', aplica_a: 'servicio', mecanica: 'porcentaje', id_servicio_objetivo: SERVICE, valor_descuento: 15 },
  { tipo_promocion: 'descuento_paquete', aplica_a: 'paquete', mecanica: 'monto_fijo', id_servicio_objetivo: null, id_paquete_objetivo: PACKAGE, valor_descuento: 50 },
  { tipo_promocion: 'dos_por_uno_servicio', aplica_a: 'servicio', mecanica: 'dos_por_uno', id_servicio_objetivo: SERVICE, valor_descuento: null, cantidad_requerida: 2, cantidad_bonificada: 1 },
]) {
  test(`creacion y publicacion conservan contrato ${commercial.tipo_promocion}`, async (t) => {
    const { app, state } = await buildApp(); t.after(() => app.close());
    const payload = { ...createPayload(A), ...commercial, estado: 'publicada', visible_publico: true, destacada: true };
    const created = await app.inject({ method: 'POST', url: '/v1/admin/configuracion/promociones', payload });
    assert.equal(created.statusCode, 201);
    const row = created.json().data.promocion;
    for (const [key, value] of Object.entries(commercial)) assert.equal(row[key], value, key);
    assert.equal(row.estado, 'publicada');
    assert.equal(row.visible_publico, true);
    assert.equal(row.destacada, true);
    assert.equal(row.imagen_principal_url, base().imagen_principal_url);
    const archived = await app.inject({ method: 'PATCH', url: `/v1/admin/configuracion/promociones/${PROMO}`, payload: { id_sucursal: A, estado: 'archivada', visible_publico: false, destacada: false } });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().data.promocion.estado, 'archivada');
    assert.equal(archived.json().data.promocion.visible_publico, false);
    assert.equal(state.commit, 2);
  });
}

for (const payload of [
  { estado: 'archivada', visible_publico: true },
  { vigencia_hasta: '2026-01-01' },
  { vigencia_desde: '2027-01-01', vigencia_hasta: '2027-01-01', vigencia_hora_desde: '18:00', vigencia_hora_hasta: '09:00' },
]) {
  test(`validacion comercial existente rechaza ${JSON.stringify(payload)}`, async (t) => {
    const { app, state } = await buildApp(); t.after(() => app.close());
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/admin/configuracion/promociones/${PROMO}`, payload: { id_sucursal: A, ...payload } })).statusCode, 400);
    assert.equal(state.writes.length, 0);
    assert.equal(state.commit, 0);
  });
}

test("duplicado conserva 409 y fallo SQL revierte sin commit", async (t) => {
  const duplicate = await buildApp({ duplicate: true }); t.after(() => duplicate.app.close());
  assert.equal((await duplicate.app.inject(requests(A)[2])).statusCode, 409);
  assert.equal(duplicate.state.writes.length, 0);
  const failing = await buildApp({ failWrite: true }); t.after(() => failing.app.close());
  assert.equal((await failing.app.inject(requests(A)[3])).statusCode, 500);
  assert.equal(failing.state.commit, 0);
  assert.equal(failing.state.rollback, 1);
});

for (const request of requests(B)) {
  for (const scenario of [
    { name: "admin A + barbero B", assignments: [assignment("admin", A), assignment("barbero", B)] },
    { name: "admin B inactivo", assignments: [assignment("admin", B, false)] },
    { name: "admin B de otro usuario", assignments: [assignment("admin", B, true, OTHER_USER)] },
    { name: "sin asignaciones", assignments: [] },
  ]) {
    test(`${scenario.name} rechaza ${request.method} ${request.url} antes de leer o escribir`, async (t) => {
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], branches: [A, B], assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "CONFIG_PROMOTION_BRANCH_FORBIDDEN");
      assert.equal(state.reads.length + state.writes.length + state.assetCalls + state.commit, 0);
      assert.ok(state.queries.every(({ text }) => text.startsWith("SELECT 1 FROM public.roles_usuarios ru") || text === "ROLLBACK"));
      const scopeQuery = state.queries.find(({ text }) => text.includes("roles_usuarios"));
      assert.deepEqual(scopeQuery.params, [USER, B]);
    });
  }
}

for (const scenario of [
  { name: "admin A + barbero B opera A", assignments: [assignment("admin", A), assignment("barbero", B)], branch: A },
  { name: "admin A+B opera A", assignments: [assignment("admin", A), assignment("admin", B)], branch: A },
  { name: "admin A+B opera B", assignments: [assignment("admin", A), assignment("admin", B)], branch: B },
]) {
  for (const request of requests(scenario.branch)) {
    test(`${scenario.name}: ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp({ roles: ["admin", "barbero"], branches: [A, B], assignments: scenario.assignments });
      t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      const data = response.json().data;
      assert.equal(data.promocion?.id_sucursal ?? data.promociones[0].id_sucursal, scenario.branch);
      assert.equal(state.queries.filter(({ text }) => text.includes("roles_usuarios")).length, 1);
      if (request.method !== "GET") assert.equal(state.commit, 1);
    });
  }
}

for (const scenario of [{ missingUser: true }, { userId: null }, { userId: "' OR TRUE --" }]) {
  for (const request of requests(A)) {
    test(`identidad invalida ${JSON.stringify(scenario)} rechaza ${request.method} ${request.url}`, async (t) => {
      const { app, state } = await buildApp(scenario); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "CONFIG_PROMOTION_BRANCH_FORBIDDEN");
      assert.equal(state.reads.length + state.writes.length + state.assetCalls, 0);
      assert.ok(state.queries.every(({ text }) => text === "ROLLBACK"));
    });
  }
}

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  for (const request of requests(B)) {
    test(`${roles.join("+")} conserva ${request.method} ${request.url} sin identidad admin`, async (t) => {
      const { app, state } = await buildApp({ roles, branches: [], assignments: [], missingUser: true }); t.after(() => app.close());
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
      assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
    });
  }
  test(`${roles.join("+")} conserva listado global sin asignaciones administrativas`, async (t) => {
    const { app } = await buildApp({ roles, branches: [], assignments: [], missingUser: true }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/configuracion/promociones" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.promociones.map((row) => row.id_sucursal), [A, B]);
  });
}

for (const assignments of [[assignment("admin", A)], [assignment("admin", A), assignment("barbero", B)], [assignment("admin", A), assignment("admin", B)], []]) {
  test(`admin con ${assignments.length} asignaciones requiere id_sucursal explicito`, async (t) => {
    const { app, state } = await buildApp({ branches: [A, B], assignments }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/configuracion/promociones" });
    assert.equal(response.statusCode, 403);
    assert.equal(state.queries.length + state.reads.length + state.writes.length, 0);
  });
}

for (const request of requests(B).filter((item) => item.method !== "GET")) {
  test(`${request.method} rechaza assets de sucursal ajena antes de cualquier operacion de Storage`, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], branches: [A, B], assignments: [assignment("admin", A), assignment("barbero", B)] });
    t.after(() => app.close());
    const response = await app.inject({ ...request, payload: { ...request.payload, imagen_principal_asset_id: SERVICE, imagen_mobile_asset_id: PACKAGE } });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(state.assetCalls + state.reads.length + state.writes.length, 0);
    assert.ok(state.queries.every(({ text }) => text.startsWith("SELECT 1 FROM public.roles_usuarios ru") || text === "ROLLBACK"));
  });
}

for (const branches of [[], [B]]) {
  test(`branch_ids ${JSON.stringify(branches)} no reemplaza la asignacion admin real`, async (t) => {
    const { app } = await buildApp({ branches, assignments: [assignment("admin", A)] }); t.after(() => app.close());
    for (const request of requests(A)) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
    }
  });
}

test("la consulta utiliza el identificador autenticado y no una identidad fija", async (t) => {
  const { app } = await buildApp({ userId: OTHER_USER, branches: [A, B], assignments: [assignment("admin", A), assignment("admin", B, true, OTHER_USER)] });
  t.after(() => app.close());
  for (const request of requests(B)) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, request.method === "POST" ? 201 : 200, response.body);
  }
});

for (const roles of [["admin"], ["super_admin"], ["super_admin", "admin"]]) {
  test(`Comunicacion conserva listado sin alcance administrativo para ${roles.join("+")}`, async (t) => {
    const { app, state } = await buildApp({ roles, branches: [], assignments: [], missingUser: true }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/configuracion/comunicacion/campanias" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data.campanias, []);
    assert.equal(response.json().data.total, 0);
    assert.equal(state.queries.length, 2);
    assert.ok(!state.queries.some(({ text }) => text.includes("roles_usuarios")));
    assert.equal(state.writes.length + state.assetCalls, 0);
  });
}

for (const roles of [null, ["cliente"]]) {
  test(`Comunicacion conserva ${roles ? 403 : 401} para actores no autorizados`, async (t) => {
    const { app, state } = await buildApp({ roles }); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/v1/admin/configuracion/comunicacion/campanias" });
    assert.equal(response.statusCode, roles ? 403 : 401);
    assert.deepEqual(state.queries, []);
  });
}
