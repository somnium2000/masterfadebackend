import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminPersonasRoutes from "../src/routes/v1/admin/personas.js";
import {
  activateAssetForEntity,
  buildAssetReadUrl,
  buildPersonasClientProfileReadUrl,
  deleteAsset,
  prepareStorageUpload,
  replaceAssetIfNeeded,
  resolveAssetForBinding,
  validateAssetReplacement,
} from "../src/services/storage/storageService.js";

const EMPLOYEE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const OLD_ASSET_ID = "55555555-5555-4555-8555-555555555555";
const BRANCH_ID = "66666666-6666-4666-8666-666666666666";
const OWN_BRANCH_ID = "77777777-7777-4777-8777-777777777777";
const USER_ID = "88888888-8888-4888-8888-888888888888";

function claims(role, branchIds = [OWN_BRANCH_ID], clienteId = null) {
  return {
    roles: [role],
    branch_ids: branchIds,
    cliente_id: clienteId,
    user: { id_usuario: USER_ID },
  };
}

function barberAsset(overrides = {}) {
  return {
    id_asset: ASSET_ID,
    bucket_name: "imagenes_publicas",
    object_path: `barberos/${BRANCH_ID}/perfil.webp`,
    public_url: "https://storage.test/public/barber.webp",
    scope_key: "public_barber_profile",
    visibility: "public",
    entity_type: "barbero",
    entity_id: EMPLOYEE_ID,
    id_sucursal: BRANCH_ID,
    status: "activo",
    deleted_at: null,
    ...overrides,
  };
}

function privateClientAsset(overrides = {}) {
  return {
    id_asset: ASSET_ID,
    bucket_name: "imagenes_privadas",
    object_path: `clientes/${CLIENT_ID}/perfil.webp`,
    scope_key: "private_client_profile",
    visibility: "private",
    entity_type: "cliente",
    entity_id: CLIENT_ID,
    owner_cliente_id: CLIENT_ID,
    id_sucursal: BRANCH_ID,
    status: "activo",
    deleted_at: null,
    ...overrides,
  };
}

function promotionAsset(scopeKey, overrides = {}) {
  return {
    id_asset: ASSET_ID,
    bucket_name: "imagenes_publicas",
    object_path: `promociones/${BRANCH_ID}/${scopeKey}.webp`,
    scope_key: scopeKey,
    visibility: "public",
    entity_type: "promocion",
    entity_id: null,
    id_sucursal: BRANCH_ID,
    status: "activo",
    deleted_at: null,
    ...overrides,
  };
}

function buildHarness({
  assets = [barberAsset()],
  privileged = false,
  historicalSuperAdmin = false,
  cleanupError = null,
} = {}) {
  const activity = { inserts: 0, updates: 0, removes: 0, signedUploads: 0, signedReads: 0 };
  const assetMap = new Map(assets.map((asset) => [asset.id_asset, asset]));
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (text.includes("FROM public.empleados e")) {
        const hasHistoricalRole = historicalSuperAdmin && !text.includes("ru.activo IS TRUE");
        return {
          rows: [{
            id_empleado: EMPLOYEE_ID,
            id_sucursal: BRANCH_ID,
            id_usuario: USER_ID,
            has_super_admin: privileged || hasHistoricalRole,
            is_protected: false,
          }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM public.clientes c") && text.includes("foto_perfil_asset_id")) {
        return { rows: [{ id_cliente: CLIENT_ID, foto_perfil_asset_id: ASSET_ID }], rowCount: 1 };
      }
      if (text.includes("FROM public.clientes c")) {
        return {
          rows: [{ id_cliente: CLIENT_ID, id_sucursal_origen: BRANCH_ID, id_usuario: USER_ID }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM public.storage_assets")) {
        const asset = assetMap.get(params[0]);
        return { rows: asset ? [asset] : [], rowCount: asset ? 1 : 0 };
      }
      if (text.startsWith("INSERT INTO public.storage_assets")) {
        activity.inserts += 1;
        const asset = barberAsset({
          id_asset: ASSET_ID,
          object_path: `barberos/${BRANCH_ID}/prepared.webp`,
          entity_id: params[6],
          status: "temporal",
        });
        assetMap.set(asset.id_asset, asset);
        return { rows: [asset], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.storage_assets")) {
        activity.updates += 1;
        if (cleanupError && params[0] === OLD_ASSET_ID && params[1] === "reemplazado") {
          throw cleanupError;
        }
        const asset = assetMap.get(params[0]);
        const updated = { ...asset, status: params[1] || "activo", entity_id: params[1] || asset?.entity_id };
        assetMap.set(params[0], updated);
        return { rows: [updated], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };
  const app = {
    db: { async connect() { return client; } },
    supabaseAdmin: {
      storage: {
        from() {
          return {
            getPublicUrl(path) { return { data: { publicUrl: `https://storage.test/${path}` } }; },
            async createSignedUploadUrl() {
              activity.signedUploads += 1;
              return { data: { token: "test-token" }, error: null };
            },
            async createSignedUrl() {
              activity.signedReads += 1;
              return { data: { signedUrl: "https://storage.test/signed" }, error: null };
            },
            async remove() {
              activity.removes += 1;
              return { error: null };
            },
          };
        },
      },
    },
  };
  return { app, client, activity };
}

const uploadInput = (actorClaims, idSucursal = BRANCH_ID, entityId = EMPLOYEE_ID) => ({
  claims: actorClaims,
  scopeKey: "public_barber_profile",
  entityType: "barbero",
  entityId,
  idSucursal,
  fileName: "perfil.webp",
  contentType: "image/webp",
  sizeBytes: 1024,
});

test("admin prepara fotografia de barbero propio, transversal y nuevo; super_admin conserva acceso", async () => {
  for (const input of [
    uploadInput(claims("admin", [BRANCH_ID])),
    uploadInput(claims("admin")),
    uploadInput(claims("admin"), BRANCH_ID, null),
    uploadInput(claims("super_admin")),
  ]) {
    const { app, activity } = buildHarness();
    const result = await prepareStorageUpload(app, input);
    assert.equal(result.asset_id, ASSET_ID);
    assert.equal(activity.inserts, 1);
    assert.equal(activity.signedUploads, 1);
  }
});

test("admin transversal asocia, activa, reemplaza y limpia solo fotografia del barbero correcto", async () => {
  const oldAsset = barberAsset({ id_asset: OLD_ASSET_ID });
  const { app, client, activity } = buildHarness({ assets: [barberAsset({ status: "temporal" }), oldAsset] });
  const actor = claims("admin");

  const resolved = await resolveAssetForBinding(client, {
    assetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    idSucursal: BRANCH_ID,
    claims: actor,
  });
  assert.equal(resolved.id_asset, ASSET_ID);

  const activated = await activateAssetForEntity(app, client, {
    assetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    idSucursal: BRANCH_ID,
    claims: actor,
  });
  assert.equal(activated.asset.id_asset, ASSET_ID);

  const checked = await validateAssetReplacement(client, {
    previousAssetId: OLD_ASSET_ID,
    nextAssetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    idSucursal: BRANCH_ID,
    claims: actor,
  });
  await replaceAssetIfNeeded(app, client, {
    previousAssetId: OLD_ASSET_ID,
    nextAssetId: ASSET_ID,
    claims: actor,
    prevalidatedAsset: checked,
  });
  assert.equal(activity.removes, 1);
});

test("la excepcion no se activa para barbero, otros scopes, entidad distinta ni cuenta privilegiada", async () => {
  const { app } = buildHarness();
  await assert.rejects(() => prepareStorageUpload(app, uploadInput(claims("barbero"))), {
    code: "STORAGE_SCOPE_FORBIDDEN",
  });
  await assert.rejects(() => prepareStorageUpload(app, {
    ...uploadInput(claims("admin")),
    scopeKey: "public_service_image",
    entityType: "servicio",
  }), { code: "STORAGE_BRANCH_FORBIDDEN" });

  const wrongEntity = buildHarness({ assets: [barberAsset({ entity_id: OTHER_CLIENT_ID })] });
  await assert.rejects(() => resolveAssetForBinding(wrongEntity.client, {
    assetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    idSucursal: BRANCH_ID,
    claims: claims("admin"),
  }), { code: "STORAGE_ASSET_ENTITY_MISMATCH" });

  const wrongScope = buildHarness({ assets: [barberAsset({ scope_key: "public_gallery_item" })] });
  await assert.rejects(() => resolveAssetForBinding(wrongScope.client, {
    assetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    idSucursal: BRANCH_ID,
    claims: claims("admin"),
  }), { code: "STORAGE_ASSET_SCOPE_MISMATCH" });

  const privileged = buildHarness({ privileged: true });
  await assert.rejects(() => prepareStorageUpload(privileged.app, uploadInput(claims("admin"))), {
    code: "STORAGE_PRIVILEGED_BARBER_FORBIDDEN",
  });

  const historical = buildHarness({ historicalSuperAdmin: true });
  await assert.rejects(() => prepareStorageUpload(historical.app, uploadInput(claims("admin"))), {
    code: "STORAGE_PRIVILEGED_BARBER_FORBIDDEN",
  });
});

test("asociacion transversal exige contexto completo verificado por backend", async () => {
  const unbound = barberAsset({ entity_id: null, status: "temporal" });
  const { client } = buildHarness({ assets: [unbound] });
  await assert.rejects(() => resolveAssetForBinding(client, {
    assetId: ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: null,
    idSucursal: BRANCH_ID,
    claims: claims("admin"),
  }), { code: "STORAGE_BRANCH_FORBIDDEN" });

  await assert.rejects(() => validateAssetReplacement(client, {
    previousAssetId: ASSET_ID,
    nextAssetId: OLD_ASSET_ID,
    scopeKey: "public_barber_profile",
    entityType: "barbero",
    entityId: EMPLOYEE_ID,
    claims: claims("admin"),
  }), { code: "STORAGE_REPLACEMENT_CONTEXT_INCOMPLETE" });
});

test("asociacion inicial rechaza propietario, metadatos, estado, bucket y destino manipulados", async () => {
  const scenarios = [
    {
      asset: barberAsset({ entity_id: null, status: "temporal", owner_user_id: OTHER_CLIENT_ID, uploaded_by: OTHER_CLIENT_ID }),
      code: "STORAGE_BRANCH_FORBIDDEN",
    },
    {
      asset: barberAsset({ entity_id: null, status: "temporal", owner_user_id: USER_ID, uploaded_by: OTHER_CLIENT_ID }),
      code: "STORAGE_BRANCH_FORBIDDEN",
    },
    {
      asset: barberAsset({ entity_id: null, status: "activo", owner_user_id: USER_ID, uploaded_by: USER_ID }),
      code: "STORAGE_BRANCH_FORBIDDEN",
    },
    {
      asset: barberAsset({ entity_id: OTHER_CLIENT_ID, owner_user_id: USER_ID, uploaded_by: USER_ID }),
      code: "STORAGE_ASSET_ENTITY_MISMATCH",
    },
    {
      asset: barberAsset({ entity_id: null, id_sucursal: OWN_BRANCH_ID, owner_user_id: USER_ID, uploaded_by: USER_ID }),
      code: "STORAGE_ASSET_BRANCH_MISMATCH",
    },
    {
      asset: barberAsset({ entity_id: null, bucket_name: "otro_bucket", owner_user_id: USER_ID, uploaded_by: USER_ID }),
      code: "STORAGE_ASSET_BUCKET_MISMATCH",
    },
    {
      asset: barberAsset({ entity_id: null, deleted_at: new Date().toISOString(), owner_user_id: USER_ID, uploaded_by: USER_ID }),
      code: "STORAGE_ASSET_NOT_FOUND",
    },
  ];
  for (const scenario of scenarios) {
    const { client } = buildHarness({ assets: [scenario.asset] });
    await assert.rejects(() => resolveAssetForBinding(client, {
      assetId: ASSET_ID,
      scopeKey: "public_barber_profile",
      entityType: "barbero",
      entityId: EMPLOYEE_ID,
      idSucursal: BRANCH_ID,
      claims: claims("admin"),
    }), { code: scenario.code });
  }
});

test("reemplazos historicos de promociones principal y movil conservan compatibilidad y sucursal", async () => {
  for (const scopeKey of ["public_promotion_main", "public_promotion_mobile"]) {
    for (const nextAssetId of [OLD_ASSET_ID, null]) {
      const asset = promotionAsset(scopeKey);
      const { app, client, activity } = buildHarness({ assets: [asset] });
      const replaced = await replaceAssetIfNeeded(app, client, {
        previousAssetId: ASSET_ID,
        nextAssetId,
        claims: claims("admin", [BRANCH_ID]),
      });
      assert.equal(replaced.id_asset, ASSET_ID);
      assert.equal(activity.removes, 1);
    }
  }

  const restricted = buildHarness({ assets: [promotionAsset("public_promotion_main")] });
  await assert.rejects(() => replaceAssetIfNeeded(restricted.app, restricted.client, {
    previousAssetId: ASSET_ID,
    nextAssetId: null,
    claims: claims("admin"),
  }), { code: "STORAGE_BRANCH_FORBIDDEN" });
});

test("DELETE y READ-URL genericos transversales de admin permanecen restringidos", async () => {
  const { app } = buildHarness({ assets: [privateClientAsset()] });
  await assert.rejects(() => buildAssetReadUrl(app, { claims: claims("admin"), assetId: ASSET_ID }), {
    code: "STORAGE_BRANCH_FORBIDDEN",
  });
  await assert.rejects(() => deleteAsset(app, { claims: claims("admin"), assetId: ASSET_ID }), {
    code: "STORAGE_BRANCH_FORBIDDEN",
  });
});

test("lectura contextual entrega solo la fotografia privada actualmente vinculada al cliente", async () => {
  for (const actor of [claims("admin"), claims("super_admin")]) {
    const { app } = buildHarness({ assets: [privateClientAsset()] });
    const result = await buildPersonasClientProfileReadUrl(app, {
      claims: actor,
      clientId: CLIENT_ID,
      assetId: ASSET_ID,
    });
    assert.equal(result.url, "https://storage.test/signed");
  }

  const ownerHarness = buildHarness({ assets: [privateClientAsset()] });
  const ownerRead = await buildAssetReadUrl(ownerHarness.app, {
    claims: claims("cliente", [], CLIENT_ID),
    assetId: ASSET_ID,
  });
  assert.equal(ownerRead.url, "https://storage.test/signed");
  await assert.rejects(() => buildAssetReadUrl(ownerHarness.app, {
    claims: claims("cliente", [], OTHER_CLIENT_ID),
    assetId: ASSET_ID,
  }), { code: "STORAGE_ASSET_FORBIDDEN" });
});

test("lectura contextual rechaza asset arbitrario, scope, relacion o estado invalidos", async () => {
  for (const asset of [
    privateClientAsset({ scope_key: "public_barber_profile" }),
    privateClientAsset({ entity_id: OTHER_CLIENT_ID }),
    privateClientAsset({ deleted_at: new Date().toISOString() }),
  ]) {
    const { app } = buildHarness({ assets: [asset] });
    await assert.rejects(() => buildPersonasClientProfileReadUrl(app, {
      claims: claims("admin"),
      clientId: CLIENT_ID,
      assetId: ASSET_ID,
    }));
  }
});

test("admin no obtiene escrituras sobre fotografia privada de cliente", async () => {
  const { app } = buildHarness({ assets: [privateClientAsset()] });
  await assert.rejects(() => prepareStorageUpload(app, {
    claims: claims("admin"),
    scopeKey: "private_client_profile",
    entityType: "cliente",
    entityId: CLIENT_ID,
    fileName: "perfil.webp",
    contentType: "image/webp",
    sizeBytes: 1024,
  }), { code: "STORAGE_SCOPE_FORBIDDEN" });
});

async function buildEmployeeUpdateApp({ failCleanup = false, failBeforeCommit = false } = {}) {
  const activity = { commands: [], authEmails: [], cleanupAttempts: 0 };
  const employee = {
    id_empleado: EMPLOYEE_ID,
    id_persona: OTHER_CLIENT_ID,
    id_usuario: USER_ID,
    id_sucursal: BRANCH_ID,
    nombres: "Ana",
    apellidos: "Barbera",
    dni: "0801199012345",
    rtn: null,
    telefono_principal: "99990000",
    correo_principal: "anterior@example.test",
    salario_base: "10000",
    estado_laboral: true,
    es_barbero: true,
    foto_perfil_asset_id: OLD_ASSET_ID,
    foto_perfil_path: "barberos/anterior.webp",
    roles: ["barbero"],
  };
  const assets = new Map([
    [ASSET_ID, barberAsset({ status: "temporal" })],
    [OLD_ASSET_ID, barberAsset({ id_asset: OLD_ASSET_ID, object_path: "barberos/anterior.webp" })],
  ]);
  const dbClient = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
        activity.commands.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.empleados e") && text.includes("e.id_empleado = $1")) {
        if (text.includes("has_super_admin")) {
          return { rows: [{
            id_empleado: EMPLOYEE_ID,
            id_sucursal: BRANCH_ID,
            id_usuario: USER_ID,
            has_super_admin: false,
            is_protected: false,
          }], rowCount: 1 };
        }
        return { rows: [employee], rowCount: 1 };
      }
      if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.roles_usuarios ru") && text.includes("r.nombre = 'super_admin'")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: BRANCH_ID }], rowCount: 1 };
      if (text.includes("regexp_replace") || text.includes("FROM auth.users")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.correos") && text.includes("LOWER")) return { rows: [], rowCount: 0 };
      if (text.includes("SELECT id_correo FROM public.correos")) {
        return { rows: [{ id_correo: CLIENT_ID }], rowCount: 1 };
      }
      if (text === "SELECT id_rol, nombre FROM public.roles") {
        return { rows: [{ id_rol: CLIENT_ID, nombre: "barbero" }], rowCount: 1 };
      }
      if (text.includes("FROM public.storage_assets")) {
        const asset = assets.get(params[0]);
        return { rows: asset ? [asset] : [], rowCount: asset ? 1 : 0 };
      }
      if (text.startsWith("UPDATE public.empleados") && failBeforeCommit) {
        throw new Error("precommit failure");
      }
      if (text.startsWith("UPDATE public.storage_assets")) {
        if (params[0] === OLD_ASSET_ID) {
          activity.cleanupAttempts += 1;
          if (failCleanup) throw new Error("cleanup failure");
        }
        const current = assets.get(params[0]);
        const updated = { ...current, entity_id: EMPLOYEE_ID, status: "activo" };
        assets.set(params[0], updated);
        return { rows: [updated], rowCount: 1 };
      }
      if (text.includes("FROM public.barberos_perfiles_publicos")) return { rows: [], rowCount: 0 };
      if (text.startsWith("UPDATE public.roles_usuarios")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO public.roles_usuarios")) return { rows: [], rowCount: 1 };
      if (/^(UPDATE|INSERT) /i.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };
  const app = Fastify({ logger: false });
  app.decorate("db", { async connect() { return dbClient; } });
  app.decorate("supabaseAdmin", {
    auth: {
      admin: {
        async updateUserById(_userId, payload) {
          activity.authEmails.push(payload.email);
          return { data: {}, error: null };
        },
      },
    },
    storage: {
      from() {
        return { async remove() { return { error: null }; } };
      },
    },
  });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = claims("admin");
  });
  await app.register(adminPersonasRoutes, { prefix: "/personas" });
  await app.ready();
  return { app, activity };
}

function employeeUpdatePayload() {
  return {
    persona: {
      nombres: "Ana",
      apellidos: "Barbera",
      dni: "0801199012345",
      telefono_principal: "99990000",
    },
    acceso: { correo_principal: "nuevo@example.test", roles: ["barbero"] },
    empleado: {
      id_sucursal: BRANCH_ID,
      salario_base: 10000,
      estado: true,
      es_barbero: true,
      foto_perfil_asset_id: ASSET_ID,
    },
    perfil_publico: {},
  };
}

test("fallo de limpieza posterior al COMMIT no revierte ni compensa Auth", async (t) => {
  const { app, activity } = await buildEmployeeUpdateApp({ failCleanup: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}`,
    payload: employeeUpdatePayload(),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(activity.commands, ["BEGIN", "COMMIT"]);
  assert.deepEqual(activity.authEmails, ["nuevo@example.test"]);
  assert.equal(activity.cleanupAttempts, 1);
});

test("fallo anterior al COMMIT conserva rollback y compensacion Auth", async (t) => {
  const { app, activity } = await buildEmployeeUpdateApp({ failBeforeCommit: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: "PATCH",
    url: `/personas/empleados/${EMPLOYEE_ID}`,
    payload: employeeUpdatePayload(),
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(activity.commands, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(activity.authEmails, ["nuevo@example.test", "anterior@example.test"]);
  assert.equal(activity.cleanupAttempts, 0);
});

async function buildNewBarberCreationApp({ assetOverrides = {} } = {}) {
  const activity = { commands: [], authCreated: 0, authDeleted: 0, assetActivated: 0 };
  const temporaryAsset = barberAsset({
    entity_id: null,
    status: "temporal",
    owner_user_id: USER_ID,
    uploaded_by: USER_ID,
    ...assetOverrides,
  });
  const dbClient = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
        activity.commands.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: BRANCH_ID }], rowCount: 1 };
      if (text.includes("regexp_replace") || text.includes("FROM auth.users")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.correos") && text.includes("LOWER")) return { rows: [], rowCount: 0 };
      if (text === "SELECT id_rol, nombre FROM public.roles") {
        return { rows: [{ id_rol: CLIENT_ID, nombre: "barbero" }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO public.personas")) {
        return { rows: [{ id_persona: OTHER_CLIENT_ID }], rowCount: 1 };
      }
      if (text.includes("SELECT id_correo FROM public.correos")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.empleados e") && text.includes("has_super_admin")) {
        return { rows: [{
          id_empleado: EMPLOYEE_ID,
          id_sucursal: BRANCH_ID,
          id_usuario: USER_ID,
          has_super_admin: false,
          is_protected: false,
        }], rowCount: 1 };
      }
      if (text.includes("FROM public.app_protected_users")) return { rows: [], rowCount: 0 };
      if (text.startsWith("UPDATE public.roles_usuarios")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO public.empleados")) {
        return { rows: [{ id_empleado: EMPLOYEE_ID }], rowCount: 1 };
      }
      if (text.includes("FROM public.barberos_perfiles_publicos")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM public.storage_assets")) return { rows: [temporaryAsset], rowCount: 1 };
      if (text.startsWith("UPDATE public.storage_assets")) {
        activity.assetActivated += 1;
        return {
          rows: [{ ...temporaryAsset, entity_id: EMPLOYEE_ID, status: "activo" }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM public.empleados e") && text.includes("u.id_usuario = $1")) {
        return { rows: [{
          id_empleado: EMPLOYEE_ID,
          id_persona: OTHER_CLIENT_ID,
          id_usuario: USER_ID,
          id_sucursal: BRANCH_ID,
          nombres: "Nueva",
          apellidos: "Barbera",
          correo_principal: "nueva@example.test",
          estado_laboral: true,
          estado_usuario: true,
          es_barbero: true,
          foto_perfil_asset_id: ASSET_ID,
          foto_perfil_path: temporaryAsset.object_path,
          roles: ["barbero"],
        }], rowCount: 1 };
      }
      if (/^(UPDATE|INSERT) /i.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };
  const app = Fastify({ logger: false });
  app.decorate("db", { async connect() { return dbClient; } });
  app.decorate("supabaseAdmin", {
    auth: {
      admin: {
        async createUser() {
          activity.authCreated += 1;
          return { data: { user: { id: USER_ID } }, error: null };
        },
        async deleteUser() {
          activity.authDeleted += 1;
          return { error: null };
        },
      },
    },
    storage: { from() { return {}; } },
  });
  app.decorate("mailer", { configured: false });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = claims("admin");
  });
  await app.register(adminPersonasRoutes, { prefix: "/personas" });
  await app.ready();
  return { app, activity };
}

test("admin crea barbero transversal y asocia su asset temporal propio antes del COMMIT", async (t) => {
  const { app, activity } = await buildNewBarberCreationApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/personas/empleados",
    payload: {
      persona: {
        nombres: "Nueva",
        apellidos: "Barbera",
        dni: "0801199012345",
        telefono_principal: "99990000",
      },
      acceso: { correo_principal: "nueva@example.test", roles: ["barbero"] },
      empleado: {
        id_sucursal: BRANCH_ID,
        salario_base: 10000,
        estado: true,
        es_barbero: true,
        foto_perfil_asset_id: ASSET_ID,
      },
      perfil_publico: {},
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(activity.commands, ["BEGIN", "COMMIT"]);
  assert.equal(activity.authCreated, 1);
  assert.equal(activity.authDeleted, 0);
  assert.equal(activity.assetActivated, 1);
});

test("creacion transversal rechaza asset temporal ajeno y compensa antes del COMMIT", async (t) => {
  const { app, activity } = await buildNewBarberCreationApp({
    assetOverrides: { owner_user_id: OTHER_CLIENT_ID, uploaded_by: OTHER_CLIENT_ID },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/personas/empleados",
    payload: {
      persona: {
        nombres: "Nueva",
        apellidos: "Barbera",
        dni: "0801199012345",
        telefono_principal: "99990000",
      },
      acceso: { correo_principal: "nueva@example.test", roles: ["barbero"] },
      empleado: {
        id_sucursal: BRANCH_ID,
        salario_base: 10000,
        estado: true,
        es_barbero: true,
        foto_perfil_asset_id: ASSET_ID,
      },
      perfil_publico: {},
    },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "STORAGE_BRANCH_FORBIDDEN");
  assert.deepEqual(activity.commands, ["BEGIN", "ROLLBACK"]);
  assert.equal(activity.authCreated, 1);
  assert.equal(activity.authDeleted, 1);
  assert.equal(activity.assetActivated, 0);
});
