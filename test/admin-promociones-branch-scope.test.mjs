import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import routes from "../src/routes/v1/admin/configuracion.js";
// AM: El escritor concurrente tambien ejecuta el helper productivo.
import { markAssetStatus } from "../src/services/storage/storageAssetsRepo.js";

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

async function buildApp({ roles = ["admin"], branches = [A], assignments = branches.map((id) => assignment("admin", id)), userId = USER, missingUser = false, missingBranch = false, failWrite = false, duplicate = false, assets = [], initialRow = null, quarantineBeforeLock = false, quarantineBeforeActivation = false, failAfterBind = false, photoReferences = [], otherPromotionUrls = [], onImageLocked = null, beforePromotionPersist = null, restoreImageBeforeCleanup = false, missingPhysical = false } = {}) {
  // AM: Modelo transaccional sintetico para las referencias de imagen y escritores concurrentes.
  const assetMap = new Map(assets.map(asset => [asset.id_asset, structuredClone(asset)]));
  let backup = null;
  let concurrentRow = null;
  const externalChanges = new Map();
  const unlockWaiters = [];
  const state = { lockedAssets: new Set(), assetBinds: 0, removedPaths: [], queries: [], assetCalls: 0, reads: [], writes: [], commit: 0, rollback: 0, row: initialRow ? { ...base(), ...initialRow } : base() };
  state.assets = assetMap;
  // AM: Simular la espera de un segundo escritor por el lock de fila PostgreSQL.
  state.waitUntilUnlocked = async () => {
    if (state.lockedAssets.size) await new Promise(resolve => unlockWaiters.push(resolve));
  };
  const releaseLocks = () => { state.lockedAssets.clear(); for (const resolve of unlockWaiters.splice(0)) resolve(); };
  state.quarantine = id => {
    const value = { ...assetMap.get(id), status: 'fallido', metadata: { account_deletion_storage: { request_id: 'synthetic' } } };
    assetMap.set(id, value); externalChanges.set(id, value);
  };
  const query = async (sql, params = []) => {
    // AM: Los comentarios SQL no cambian la sentencia ejecutada por el doble.
    const text = String(sql).replace(/--[^\r\n]*/g, "").replace(/\s+/g, " ").trim();
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
    if (text === "BEGIN") {
      backup = { row: structuredClone(state.row), assets: structuredClone([...assetMap]) };
      return { rows: [], rowCount: 0 };
    }
    if (text === "COMMIT") { state.commit++; backup = null; releaseLocks(); return { rows: [], rowCount: 0 }; }
    if (text === "ROLLBACK") {
      state.rollback++;
      if (backup) {
        state.row = concurrentRow || backup.row; assetMap.clear(); for (const [id, asset] of backup.assets) assetMap.set(id, asset);
        for (const [id, asset] of externalChanges) assetMap.set(id, asset);
      }
      backup = null; releaseLocks(); return { rows: [], rowCount: 0 };
    }
    if (text.includes('AS image_reference_id')) return { rows: otherPromotionUrls };
    if (text.includes('AS image_shared')) return { rows: [{ image_shared: photoReferences.includes(params[0])
      || (params[2] === null && (state.row.imagen_principal_asset_id === params[0] || state.row.imagen_mobile_asset_id === params[0])) }] };
    if (text.includes('AS image_object_exists')) return { rows: [{ image_object_exists: !missingPhysical && [...assetMap.values()].some(a => a.bucket_name === params[0] && a.object_path === params[1]) }] };
    if (text.startsWith('SELECT * FROM public.storage_assets')) {
      const candidates = text.includes('public_url = $1') ? [...assetMap.values()].filter(a => a.public_url === params[0]) : text.includes('bucket_name = $1')
        ? [...assetMap.values()].filter(a => a.bucket_name === params[0] && a.object_path === params[1])
        : [...assetMap.values()].filter(a => a.id_asset === params[0]);
      if (text.includes('FOR UPDATE')) {
        assert.ok(backup, 'AM: el bloqueo debe ocurrir dentro de BEGIN');
        // AM: Un segundo PATCH confirmado puede restaurar la imagen antes de que la limpieza tome el lock.
        if (restoreImageBeforeCleanup && state.commit > 0 && candidates[0]) {
          const asset = candidates[0];
          concurrentRow = { ...state.row, imagen_principal_asset_id: asset.id_asset,
            imagen_principal_path: asset.object_path, imagen_principal_url: `https://storage.qa-synthetic.invalid/storage/v1/object/public/${asset.bucket_name}/${asset.object_path}` };
          state.row = concurrentRow; restoreImageBeforeCleanup = false;
        }
        if (quarantineBeforeLock && candidates[0]) { state.quarantine(candidates[0].id_asset); quarantineBeforeLock = false; }
        for (const asset of candidates) state.lockedAssets.add(asset.id_asset);
        if (onImageLocked && candidates.length) { const callback = onImageLocked; onImageLocked = null; callback(state); }
      }
      return { rows: candidates.map(a => structuredClone(assetMap.get(a.id_asset))), rowCount: candidates.length };
    }
    if (text.startsWith('UPDATE public.storage_assets')) {
      const asset = assetMap.get(params[0]);
      if (text.includes("status = 'activo'")) {
        assert.ok(backup); assert.ok(state.lockedAssets.has(params[0]));
        if (quarantineBeforeActivation) { state.quarantine(params[0]); quarantineBeforeActivation = false; return { rows: [], rowCount: 0 }; }
        assert.match(text, /AND status IN \('temporal', 'activo'\)/);
        if (!asset || asset.deleted_at || asset.metadata?.account_deletion_storage || !['temporal', 'activo'].includes(asset.status)) return { rows: [], rowCount: 0 };
        const updated = { ...asset, status: 'activo', entity_id: params[1] ?? asset.entity_id, id_sucursal: params[2] ?? asset.id_sucursal };
        state.assetBinds++; assetMap.set(asset.id_asset, updated); return { rows: [updated], rowCount: 1 };
      }
      if (!asset || asset.deleted_at || asset.metadata?.account_deletion_storage) return { rows: [], rowCount: 0 };
      const updated = { ...asset, status: params[1] }; assetMap.set(asset.id_asset, updated); return { rows: [updated], rowCount: 1 };
    }
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
      if (failWrite || (failAfterBind && state.assetBinds > 0)) throw new Error("simulated");
      // AM: El escritor concurrente no debe completar antes de persistir la promocion.
      if (text.startsWith('INSERT INTO public.promociones (') || text.startsWith('UPDATE public.promociones SET')) beforePromotionPersist?.(state);
      // AM: Toda persistencia de un asset debe ocurrir mientras sigue bloqueado.
      if (text.startsWith('INSERT INTO public.promociones (')) for (const id of [params[4], params[7]].filter(Boolean)) assert.ok(state.lockedAssets.has(id));
      if (text.startsWith('UPDATE public.promociones SET')) for (const id of [params[5], params[8]].filter(Boolean)) assert.ok(state.lockedAssets.has(id));
      state.writes.push({ sql: text, params });
      if (text.startsWith("INSERT INTO public.promociones (")) {
        state.row = { ...state.row, slug: params[0], titulo: params[1], subtitulo: params[2], parrafos: JSON.parse(params[3]),
          imagen_principal_asset_id: params[4], imagen_principal_path: params[5], imagen_mobile_asset_id: params[7], imagen_mobile_path: params[8],
          imagen_principal_url: params[6], imagen_mobile_url: params[9], tipo_promocion: params[11], aplica_a: params[12], mecanica: params[13],
          id_servicio_objetivo: params[14], id_paquete_objetivo: params[15], valor_descuento: params[16], cantidad_requerida: params[17], cantidad_bonificada: params[18], estado: params[19] };
        return { rows: [{ id_promocion: PROMO }], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.promociones SET")) {
        state.row = { ...state.row, slug: params[1], titulo: params[2], subtitulo: params[3], parrafos: JSON.parse(params[4]),
          imagen_principal_asset_id: params[5], imagen_principal_path: params[6], imagen_mobile_asset_id: params[8], imagen_mobile_path: params[9],
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
  app.decorate("supabase", { supabaseUrl: 'https://storage.qa-synthetic.invalid', storage: { from(bucket) {
    state.assetCalls++; if (!assets.length) throw new Error("Unexpected storage operation in authorization test");
    return { async remove(paths) { assert.equal(backup, null); state.removedPaths.push(...paths.map(path => `${bucket}/${path}`)); return { error: null }; } };
  } } });
  // AM: Ambos clientes apuntan al mismo doble local; nunca hay llamadas a Supabase real.
  app.decorate("supabaseAdmin", app.supabase);
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
// AM: 01A.3: endpoints productivos, identidades y Storage exclusivamente sinteticos.
const IMAGE = '71111111-1111-4111-8111-111111111111';
const MOBILE_IMAGE = '81111111-1111-4111-8111-111111111111';
const INTERNAL = 'https://storage.qa-synthetic.invalid';
const imageAsset = (overrides = {}) => ({ id_asset: IMAGE, bucket_name: 'imagenes_publicas',
  object_path: `promociones/sucursal/${A}/2026/10/principal/synthetic.png`, scope_key: 'public_promotion_main',
  entity_type: 'promocion', visibility: 'public', entity_id: null, id_sucursal: A,
  status: 'temporal', deleted_at: null, metadata: {}, owner_user_id: USER, uploaded_by: USER,
  ...overrides });
const imageUrl = asset => `${INTERNAL}/storage/v1/object/public/${asset.bucket_name}/${asset.object_path}`;
const promotionRequest = (method, extra = {}) => method === 'POST'
  ? { method, url: '/v1/admin/configuracion/promociones', payload: { ...createPayload(A), ...extra } }
  : { method, url: `/v1/admin/configuracion/promociones/${PROMO}`, payload: { id_sucursal: A, ...extra } };

for (const method of ['POST', 'PATCH']) {
  test(`AM: ${method} conserva URLs externas HTTPS y reglas comerciales`, async t => {
    const { app, state } = await buildApp(); t.after(() => app.close());
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: 'https://cdn.example.test/public.png',
      imagen_mobile_url: 'https://cdn.example.test/mobile.png' }));
    assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
    assert.equal(state.row.imagen_principal_url, 'https://cdn.example.test/public.png');
    assert.equal(state.row.imagen_mobile_url, 'https://cdn.example.test/mobile.png');
    assert.equal(state.row.valor_descuento, 10); assert.equal(state.row.vigencia_desde, '2027-01-01');
    assert.equal(state.assetCalls, 0); assert.equal(state.commit, 1);
  });
  test(`AM: ${method} resuelve URL interna a UUID y persiste bajo bloqueo`, async t => {
    const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(asset) }));
    assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
    assert.equal(state.row.imagen_principal_asset_id, IMAGE); assert.equal(state.row.imagen_principal_path, asset.object_path);
    assert.equal(state.row.imagen_principal_url, imageUrl(asset)); assert.equal(state.assets.get(IMAGE).entity_id, PROMO);
    assert.equal(state.assets.get(IMAGE).status, 'activo'); assert.equal(state.commit, 1);
    assert.ok(state.queries.some(q => q.text.includes('bucket_name = $1') && q.text.includes('FOR UPDATE')));
    assert.equal(state.lockedAssets.size, 0);
  });
  test(`AM: ${method} admite UUID legitimo sin URL y ambas variantes de imagen`, async t => {
    const main = imageAsset(), mobile = imageAsset({ id_asset: MOBILE_IMAGE, scope_key: 'public_promotion_mobile',
      object_path: `promociones/sucursal/${A}/2026/10/mobile/synthetic.png` });
    const { app, state } = await buildApp({ assets: [main, mobile] }); t.after(() => app.close());
    const response = await app.inject(promotionRequest(method, { imagen_principal_asset_id: IMAGE,
      imagen_principal_url: null, imagen_mobile_url: imageUrl(mobile) }));
    assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
    assert.equal(state.row.imagen_principal_asset_id, IMAGE); assert.equal(state.row.imagen_mobile_asset_id, MOBILE_IMAGE);
    assert.equal(state.assetBinds, 2); assert.equal(state.commit, 1);
  });
  for (const [name, overrides] of [
    ['fotografia Barbero', { scope_key: 'public_barber_profile', entity_type: 'barbero' }],
    ['fotografia Cliente', { scope_key: 'private_client_profile', entity_type: 'cliente', owner_cliente_id: OTHER_USER }],
    ['scope mobile usado como principal', { scope_key: 'public_promotion_mobile' }],
    ['sucursal ajena', { id_sucursal: B }],
    ['otra promocion', { entity_id: OTHER_USER }],
    ['temporal de otro cargador', { owner_user_id: OTHER_USER, uploaded_by: OTHER_USER }],
    ['eliminado', { deleted_at: '2026-01-01T00:00:00Z', status: 'eliminado' }],
    ['fallido', { status: 'fallido' }],
    ['reemplazado', { status: 'reemplazado' }],
    ['cuarentena con estado activo', { status: 'activo', metadata: { account_deletion_storage: { request_id: 'synthetic' } } }],
    ['ruta contradictoria', { object_path: 'barberos/synthetic.png' }],
  ]) test(`AM: ${method} rechaza ${name} sin modificar promocion ni terceros`, async t => {
    const asset = imageAsset(overrides), { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
    const before = structuredClone(state.row), beforeAsset = structuredClone(state.assets.get(IMAGE));
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(asset) }));
    assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'CONFIG_PROMOTION_IMAGE_UNAVAILABLE');
    assert.deepEqual(state.row, before); assert.deepEqual(state.assets.get(IMAGE), beforeAsset);
    assert.equal(state.commit, 0); assert.equal(state.rollback, 1); assert.deepEqual(state.removedPaths, []);
  });
  test(`AM: ${method} rechaza URL interna sin asset registrado`, async t => {
    const { app, state } = await buildApp(); t.after(() => app.close()); const before = structuredClone(state.row);
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(imageAsset()) }));
    assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.equal(state.commit, 0);
  });
  test(`AM: ${method} detecta cuarentena que gano antes del lock`, async t => {
    const asset = imageAsset(), { app, state } = await buildApp({ assets: [asset], quarantineBeforeLock: true }); t.after(() => app.close());
    const before = structuredClone(state.row);
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(asset) }));
    assert.equal(response.statusCode, 409); assert.equal(state.commit, 0); assert.deepEqual(state.row, before);
    assert.equal(state.assets.get(IMAGE).status, 'fallido'); assert.deepEqual(state.removedPaths, []);
  });
  test(`AM: ${method} rollback si la condicion atomica rechaza la activacion`, async t => {
    const asset = imageAsset(), { app, state } = await buildApp({ assets: [asset], quarantineBeforeActivation: true }); t.after(() => app.close());
    const before = structuredClone(state.row);
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(asset) }));
    assert.equal(response.statusCode, 409, response.body); assert.equal(state.commit, 0); assert.equal(state.rollback, 1);
    assert.deepEqual(state.row, before); assert.equal(state.assets.get(IMAGE).status, 'fallido');
    assert.deepEqual(state.removedPaths, []);
  });
  test(`AM: ${method} fallo posterior a vinculacion revierte promocion y asset`, async t => {
    const asset = imageAsset(), { app, state } = await buildApp({ assets: [asset], failAfterBind: true }); t.after(() => app.close());
    const before = structuredClone(state.row), beforeAsset = structuredClone(state.assets.get(IMAGE));
    const response = await app.inject(promotionRequest(method, { imagen_principal_url: imageUrl(asset) }));
    assert.equal(response.statusCode, 500); assert.equal(state.commit, 0); assert.equal(state.rollback, 1);
    assert.deepEqual(state.row, before); assert.deepEqual(state.assets.get(IMAGE), beforeAsset);
    assert.deepEqual(state.removedPaths, []);
  });
}

test('AM: PATCH parcial revalida URL interna guardada y registra su UUID', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo' });
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_url: imageUrl(asset) } }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'Solo texto' }));
  assert.equal(response.statusCode, 200, response.body); assert.equal(state.row.imagen_principal_asset_id, IMAGE);
  assert.equal(state.row.subtitulo, 'Solo texto'); assert.ok(state.queries.some(q => q.text.includes('FOR UPDATE OF p, ps')));
});
test('AM: PATCH parcial no conserva imagen interna obsoleta', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'fallido', metadata: { account_deletion_storage: { request_id: 'synthetic' } } });
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: asset.object_path, imagen_principal_url: imageUrl(asset) } }); t.after(() => app.close());
  const before = structuredClone(state.row); const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No guardar' }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.equal(state.commit, 0);
});
test('AM: PATCH permite reparar referencia historica ajena sin eliminar el archivo ajeno', async t => {
  const third = imageAsset({ scope_key: 'public_barber_profile', entity_type: 'barbero', entity_id: OTHER_USER, status: 'activo' });
  const { app, state } = await buildApp({ assets: [third], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: third.object_path, imagen_principal_url: imageUrl(third) } }); t.after(() => app.close());
  const beforeAsset = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_url: 'https://cdn.example.test/repaired.png' }));
  assert.equal(response.statusCode, 200, response.body); assert.equal(state.row.imagen_principal_asset_id, null);
  assert.deepEqual(state.assets.get(IMAGE), beforeAsset); assert.deepEqual(state.removedPaths, []); assert.equal(state.commit, 1);
});
test('AM: PATCH cambia imagen propia por otra y limpia solo la anterior tras COMMIT', async t => {
  const old = imageAsset({ entity_id: PROMO, status: 'activo' });
  const next = imageAsset({ id_asset: MOBILE_IMAGE, object_path: `promociones/sucursal/${A}/2026/10/principal/next.png` });
  const { app, state } = await buildApp({ assets: [old, next], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: old.object_path, imagen_principal_url: imageUrl(old) } }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_asset_id: MOBILE_IMAGE }));
  assert.equal(response.statusCode, 200, response.body); assert.equal(state.row.imagen_principal_asset_id, MOBILE_IMAGE);
  assert.equal(state.assets.get(IMAGE).status, 'reemplazado');
  assert.deepEqual(state.removedPaths, [`imagenes_publicas/${old.object_path}`]);
});
test('AM: rechaza UUID y URL interna contradictorios', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('POST', { imagen_principal_asset_id: IMAGE,
    imagen_principal_url: `${imageUrl(asset)}.otra` }));
  assert.equal(response.statusCode, 409); assert.equal(state.commit, 0); assert.deepEqual(state.removedPaths, []);
});
test('AM: referencia fotografica compartida bloquea sin tocar tercero', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset], photoReferences: [IMAGE] }); t.after(() => app.close());
  const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: imageUrl(asset) }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.assets.get(IMAGE), before); assert.equal(state.commit, 0);
});
for (const value of ['http://cdn.example.test/image.png', 'javascript:alert(1)', '/relative.png',
  'https://user:password@cdn.example.test/image.png', `${INTERNAL}/storage/v1/object/public/imagenes_publicas/%ZZ`]) {
  test('AM: URL invalida no se convierte en referencia externa aceptada', async t => {
    const { app, state } = await buildApp(); t.after(() => app.close());
    const response = await app.inject(promotionRequest('POST', { imagen_principal_url: value }));
    assert.equal(response.statusCode, 409); assert.equal(state.commit, 0); assert.deepEqual(state.removedPaths, []);
  });
}
test('AM: URL HTTPS de otro proyecto permanece externa sin apropiarse de un asset local', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const foreignUrl = imageUrl(asset).replace(INTERNAL, 'https://other-project.example.test');
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: foreignUrl }));
  assert.equal(response.statusCode, 201); assert.equal(state.row.imagen_principal_url, foreignUrl);
  assert.equal(state.row.imagen_principal_asset_id, null); assert.equal(state.assetBinds, 0);
});
test('AM: enlace interno firmado no persiste tokens y utiliza URL publica canonica', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const signed = imageUrl(asset).replace('/object/public/', '/object/sign/') + '?token=SYNTHETIC_NOT_REAL';
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: signed }));
  assert.equal(response.statusCode, 201); assert.equal(state.row.imagen_principal_url, imageUrl(asset));
  assert.doesNotMatch(response.body, /SYNTHETIC_NOT_REAL|token=/);
});
// AM: Cerrar tambien referencias antiguas que solo tenian URL en otra promocion.
test('AM: URL heredada compartida con otra promocion bloquea apropiacion del asset temporal', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset], otherPromotionUrls: [
    { image_reference_id: OTHER_USER, imagen_principal_url: imageUrl(asset).replace('/object/public/', '/object/sign/') + '?token=SYNTHETIC' },
  ] }); t.after(() => app.close()); const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: imageUrl(asset) }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.assets.get(IMAGE), before);
  assert.equal(state.commit, 0); assert.deepEqual(state.removedPaths, []);
});
test('AM: cambio a URL externa conserva objeto propio compartido por URL historica ajena', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo' });
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: asset.object_path, imagen_principal_url: imageUrl(asset) }, otherPromotionUrls: [
    { image_reference_id: OTHER_USER, imagen_mobile_url: imageUrl(asset) },
  ] }); t.after(() => app.close()); const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_url: 'https://cdn.example.test/new.png' }));
  assert.equal(response.statusCode, 200); assert.deepEqual(state.assets.get(IMAGE), before);
  assert.equal(state.row.imagen_principal_url, 'https://cdn.example.test/new.png'); assert.deepEqual(state.removedPaths, []);
});
test('AM: mobile invalida revierte el lote sin activar la principal valida', async t => {
  const asset = imageAsset(), third = imageAsset({ id_asset: MOBILE_IMAGE, scope_key: 'public_barber_profile',
    entity_type: 'barbero', object_path: 'barberos/synthetic.png', entity_id: OTHER_USER });
  const { app, state } = await buildApp({ assets: [asset, third] }); t.after(() => app.close());
  const before = structuredClone([...state.assets]);
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: imageUrl(asset), imagen_mobile_url: imageUrl(third) }));
  assert.equal(response.statusCode, 409); assert.deepEqual([...state.assets], before);
  assert.equal(state.assetBinds, 0); assert.equal(state.commit, 0);
});
test('AM: PATCH conserva imagen propia existente aunque la cargara otro administrador', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo', owner_user_id: OTHER_USER, uploaded_by: OTHER_USER });
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: asset.object_path, imagen_principal_url: imageUrl(asset) } }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'Cambio legitimo' }));
  assert.equal(response.statusCode, 200); assert.equal(state.row.imagen_principal_asset_id, IMAGE);
});
test('AM: UUID y URL compatibles mantienen el contrato del formulario', async t => {
  const asset = imageAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('POST', { imagen_principal_asset_id: IMAGE, imagen_principal_url: imageUrl(asset) }));
  assert.equal(response.statusCode, 201); assert.equal(state.row.imagen_principal_asset_id, IMAGE);
});
test('AM: escritor concurrente espera hasta COMMIT mientras la promocion mantiene el asset bloqueado', async t => {
  const asset = imageAsset(); let writer, completed = false, started = false;
  const { app, state } = await buildApp({ assets: [asset], onImageLocked(current) {
    writer = markAssetStatus({ async query(sql, params) {
      started = true; await current.waitUntilUnlocked();
      assert.equal(current.commit, 1); assert.match(sql, /AND deleted_at IS NULL/);
      const updated = { ...current.assets.get(params[0]), status: params[1] };
      current.assets.set(params[0], updated); completed = true; return { rows: [updated] };
    } }, { idAsset: IMAGE, status: 'fallido' });
  }, beforePromotionPersist() { assert.equal(started, true); assert.equal(completed, false); } });
  t.after(() => app.close());
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: imageUrl(asset) }));
  assert.equal(response.statusCode, 201); await writer;
  assert.equal(completed, true); assert.equal(state.row.imagen_principal_asset_id, IMAGE);
});
// AM: Conservar referencias historicas externas coherentes durante una edicion que no toca imagenes.
test('AM: PATCH parcial preserva URL externa efectiva junto a asset propio existente', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo' });
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: asset.object_path, imagen_principal_url: 'https://cdn.example.test/historical.png' } });
  t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'Solo texto' }));
  assert.equal(response.statusCode, 200); assert.equal(state.row.imagen_principal_url, 'https://cdn.example.test/historical.png');
  assert.equal(state.row.imagen_principal_asset_id, IMAGE); assert.deepEqual(state.removedPaths, []);
});
// AM: La limpieza no debe borrar una imagen que otro PATCH restauro mientras esperaba el lock.
test('AM: reemplazo concurrente que restaura imagen anterior impide su eliminacion fisica', async t => {
  const old = imageAsset({ entity_id: PROMO, status: 'activo' });
  const next = imageAsset({ id_asset: MOBILE_IMAGE, object_path: `promociones/sucursal/${A}/2026/10/principal/next.png` });
  const { app, state } = await buildApp({ assets: [old, next], restoreImageBeforeCleanup: true, initialRow: {
    imagen_principal_asset_id: IMAGE, imagen_principal_path: old.object_path, imagen_principal_url: imageUrl(old) } });
  t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_asset_id: MOBILE_IMAGE }));
  assert.equal(response.statusCode, 200); assert.equal(state.row.imagen_principal_asset_id, IMAGE);
  assert.equal(state.assets.get(IMAGE).status, 'activo'); assert.deepEqual(state.removedPaths, []);
  assert.equal(state.commit, 1); assert.equal(state.rollback, 1);
});
// AM: El formulario completo puede reenviar imagenes externas historicas sin modificarlas.
test('AM: PATCH con UUID y URL externa historica sin cambios conserva su URL efectiva', async t => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo' }); const historical = 'https://cdn.example.test/historical.png';
  const { app, state } = await buildApp({ assets: [asset], initialRow: { imagen_principal_asset_id: IMAGE,
    imagen_principal_path: asset.object_path, imagen_principal_url: historical } }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_asset_id: IMAGE, imagen_principal_url: historical }));
  assert.equal(response.statusCode, 200); assert.equal(state.row.imagen_principal_url, historical);
  assert.deepEqual(state.removedPaths, []);
});
// AM: 01A.3B: misma estructura observada en QA; dominios, UUID y contenidos totalmente sinteticos.
const HISTORICAL_ORIGIN = 'https://historical-project.example.test';
const historicalAsset = (overrides = {}) => {
  const asset = imageAsset({ entity_id: PROMO, status: 'activo', ...overrides });
  return { ...asset, public_url: imageUrl(asset).replace(INTERNAL, HISTORICAL_ORIGIN) };
};
const historicalRow = asset => ({ imagen_principal_asset_id: asset.id_asset,
  imagen_principal_path: asset.object_path, imagen_principal_url: asset.public_url });
for (const payload of [{ subtitulo: 'Solo texto' }, { imagen_principal_asset_id: IMAGE },
  { imagen_principal_url: 'same' }, { imagen_principal_asset_id: IMAGE, imagen_principal_url: 'same' }]) {
  test('AM: PATCH historico conserva public_url alternativa exacta sin reactivar ni migrar el asset', async t => {
    const asset = historicalAsset(), extra = { ...payload };
    if (extra.imagen_principal_url === 'same') extra.imagen_principal_url = asset.public_url;
    const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset) }); t.after(() => app.close());
    const before = structuredClone(state.assets.get(IMAGE));
    const response = await app.inject(promotionRequest('PATCH', extra));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.row.imagen_principal_asset_id, IMAGE); assert.equal(state.row.imagen_principal_url, asset.public_url);
    assert.deepEqual(state.assets.get(IMAGE), before); assert.equal(state.assetBinds, 0); assert.deepEqual(state.removedPaths, []);
    assert.ok(state.queries.some(q => q.text.includes('public_url = $1') && q.text.includes('FOR UPDATE')));
    assert.ok(state.queries.some(q => q.text.includes('AS image_object_exists')));
  });
}
for (const byId of [false, true]) test('AM: POST no se apropia de asset temporal de origen alternativo por URL o UUID', async t => {
  const asset = historicalAsset({ entity_id: null, status: 'temporal' });
  const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('POST', byId
    ? { imagen_principal_asset_id: IMAGE, imagen_principal_url: null } : { imagen_principal_url: asset.public_url }));
  assert.equal(response.statusCode, 409); assert.equal(state.commit, 0); assert.equal(state.rollback, 1);
  assert.deepEqual(state.assets.get(IMAGE), before); assert.deepEqual(state.removedPaths, []);
});
test('AM: PATCH no vincula URL alternativa exacta perteneciente a otra promocion', async t => {
  const asset = historicalAsset({ entity_id: OTHER_USER });
  const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const before = structuredClone(state.row), beforeAsset = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_url: asset.public_url }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.deepEqual(state.assets.get(IMAGE), beforeAsset);
});
for (const overrides of [ { scope_key: 'public_barber_profile', entity_type: 'barbero' },
  { scope_key: 'private_client_profile', entity_type: 'cliente', owner_cliente_id: USER },
  { status: 'fallido' }, { status: 'activo', metadata: { account_deletion_storage: { request_id: 'synthetic' } } },
  { deleted_at: '2026-01-01T00:00:00Z' }, { id_sucursal: B }, { entity_id: OTHER_USER } ]) {
  test('AM: coincidencia public_url alternativa nunca omite scope, estado, cuarentena, sucursal o propiedad', async t => {
    const asset = historicalAsset(overrides);
    const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset) }); t.after(() => app.close());
    const before = structuredClone(state.row), beforeAsset = structuredClone(state.assets.get(IMAGE));
    const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No persistir' }));
    assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.deepEqual(state.assets.get(IMAGE), beforeAsset);
    assert.equal(state.assetBinds, 0); assert.deepEqual(state.removedPaths, []);
  });
}
test('AM: referencia alternativa exacta requiere objeto local presente para conservarla', async t => {
  const asset = historicalAsset(); const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset), missingPhysical: true }); t.after(() => app.close());
  const before = structuredClone(state.row);
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No persistir' }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.equal(state.commit, 0);
});
test('AM: UUID y URL alternativa registrada de otro asset son contradictorios', async t => {
  const own = imageAsset(), other = historicalAsset({ id_asset: MOBILE_IMAGE, object_path: `promociones/sucursal/${A}/2026/10/principal/other.png` });
  const { app, state } = await buildApp({ assets: [own, other] }); t.after(() => app.close()); const before = structuredClone([...state.assets]);
  const response = await app.inject(promotionRequest('POST', { imagen_principal_asset_id: IMAGE, imagen_principal_url: other.public_url }));
  assert.equal(response.statusCode, 409); assert.deepEqual([...state.assets], before); assert.equal(state.commit, 0);
});
test('AM: mismo bucket y ruta en hostname distinto no demuestra equivalencia con UUID', async t => {
  const own = imageAsset(); const { app, state } = await buildApp({ assets: [own] }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('POST', { imagen_principal_asset_id: IMAGE,
    imagen_principal_url: imageUrl(own).replace(INTERNAL, HISTORICAL_ORIGIN) }));
  assert.equal(response.statusCode, 409); assert.equal(state.assetBinds, 0); assert.equal(state.commit, 0);
});
test('AM: no se canonicaliza implicitamente una URL alternativa mediante UUID existente', async t => {
  const asset = historicalAsset(); const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset) }); t.after(() => app.close());
  const before = structuredClone(state.row);
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_asset_id: IMAGE, imagen_principal_url: imageUrl(asset) }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.deepEqual(state.removedPaths, []);
});
for (const external of [true, false]) test('AM: sustituir imagen historica no elimina ni modifica el asset de origen ambiguo', async t => {
  const old = historicalAsset(), next = imageAsset({ id_asset: MOBILE_IMAGE, object_path: `promociones/sucursal/${A}/2026/10/principal/new.png` });
  const { app, state } = await buildApp({ assets: [old, next], initialRow: historicalRow(old) }); t.after(() => app.close());
  const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', external
    ? { imagen_principal_url: 'https://cdn.example.test/new.png' } : { imagen_principal_asset_id: MOBILE_IMAGE }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(state.assets.get(IMAGE), before);
  assert.deepEqual(state.removedPaths, []); assert.equal(state.row.imagen_principal_asset_id, external ? null : MOBILE_IMAGE);
});
test('AM: limpieza evita borrado ante referencia compartida de origen no equivalente con igual bucket/ruta', async t => {
  const old = imageAsset({ entity_id: PROMO, status: 'activo' }); old.public_url = imageUrl(old);
  const { app, state } = await buildApp({ assets: [old], initialRow: historicalRow(old), otherPromotionUrls: [
    { image_reference_id: OTHER_USER, imagen_principal_url: imageUrl(old).replace(INTERNAL, HISTORICAL_ORIGIN) },
  ] }); t.after(() => app.close()); const before = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', { imagen_principal_url: 'https://cdn.example.test/new.png' }));
  assert.equal(response.statusCode, 200); assert.deepEqual(state.assets.get(IMAGE), before); assert.deepEqual(state.removedPaths, []);
});
test('AM: public_url alternativa duplicada se rechaza aun con UUID enviado', async t => {
  const own = historicalAsset(), duplicate = { ...historicalAsset({ id_asset: MOBILE_IMAGE }), public_url: own.public_url };
  const { app, state } = await buildApp({ assets: [own, duplicate], initialRow: historicalRow(own) }); t.after(() => app.close());
  const before = structuredClone(state.row);
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No persistir' }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.equal(state.commit, 0);
});
test('AM: error de persistencia revierte PATCH historico sin alterar asset ni URL', async t => {
  const asset = historicalAsset(); const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset), failWrite: true }); t.after(() => app.close());
  const before = structuredClone(state.row), beforeAsset = structuredClone(state.assets.get(IMAGE));
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'Rollback' }));
  assert.equal(response.statusCode, 500); assert.deepEqual(state.row, before); assert.deepEqual(state.assets.get(IMAGE), beforeAsset);
  assert.equal(state.assetBinds, 0); assert.deepEqual(state.removedPaths, []);
});
// AM: La estructura principal/mobile reproduce las referencias pareadas sin usar registros de QA.
test('AM: PATCH parcial conserva ambas variantes historicas alternativas sin modificar assets', async t => {
  const main = historicalAsset(), mobile = historicalAsset({ id_asset: MOBILE_IMAGE, scope_key: 'public_promotion_mobile',
    object_path: `promociones/sucursal/${A}/2026/10/mobile/historical.png` });
  const { app, state } = await buildApp({ assets: [main, mobile], initialRow: { ...historicalRow(main),
    imagen_mobile_asset_id: mobile.id_asset, imagen_mobile_path: mobile.object_path, imagen_mobile_url: mobile.public_url } });
  t.after(() => app.close()); const before = structuredClone([...state.assets]);
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'Edicion legitima' }));
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual([...state.assets], before);
  assert.equal(state.row.imagen_principal_url, main.public_url); assert.equal(state.row.imagen_mobile_url, mobile.public_url);
  assert.equal(state.assetBinds, 0); assert.deepEqual(state.removedPaths, []);
});
test('AM: public_url exacta con bucket contradictorio nunca valida la propiedad', async t => {
  const asset = historicalAsset(); asset.public_url = asset.public_url.replace('/imagenes_publicas/', '/different-bucket/');
  const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset) }); t.after(() => app.close());
  const before = structuredClone(state.row);
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No persistir' }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.deepEqual(state.removedPaths, []);
});
test('AM: URL externa HTTPS no registrada sigue siendo externa y no vincula assets', async t => {
  const asset = historicalAsset(); const { app, state } = await buildApp({ assets: [asset] }); t.after(() => app.close());
  const response = await app.inject(promotionRequest('POST', { imagen_principal_url: 'https://independent-cdn.example.test/image.png' }));
  assert.equal(response.statusCode, 201); assert.equal(state.row.imagen_principal_asset_id, null);
  assert.equal(state.row.imagen_principal_url, 'https://independent-cdn.example.test/image.png'); assert.equal(state.assetBinds, 0);
});
// AM: La presencia del marcador coincide con el operador JSONB ? usado por el escritor atomico.
for (const value of [null, false]) test('AM: retencion historica no omite cuarentena aunque el marcador sea falsy', async t => {
  const asset = historicalAsset({ metadata: { account_deletion_storage: value } });
  const { app, state } = await buildApp({ assets: [asset], initialRow: historicalRow(asset) }); t.after(() => app.close());
  const before = structuredClone(state.row);
  const response = await app.inject(promotionRequest('PATCH', { subtitulo: 'No persistir' }));
  assert.equal(response.statusCode, 409); assert.deepEqual(state.row, before); assert.equal(state.assetBinds, 0);
});
