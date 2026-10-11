import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminPersonasRoutes from "../src/routes/v1/admin/personas.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const PHOTO_PATH = "clientes/11111111-1111-4111-8111-111111111111/perfil.webp";
const SIGNED_URL = "https://storage.test/signed/client-profile";

test("detalle de cliente recupera el asset y genera URL firmada privada", async (t) => {
  const clientRow = {
    id_cliente: CLIENT_ID,
    id_persona: PERSON_ID,
    id_usuario: USER_ID,
    nombres: "Ana",
    apellidos: "Prueba",
    correo_principal: "ana@example.test",
    estado_cliente: true,
    tiene_acceso: true,
    estado_acceso: "activo",
    foto_perfil_asset_id: ASSET_ID,
    foto_perfil_path: PHOTO_PATH,
  };
  const assetRow = {
    id_asset: ASSET_ID,
    bucket_name: "private-client-profile",
    object_path: PHOTO_PATH,
    visibility: "private",
    deleted_at: null,
  };
  const dbClient = {
    async query(sql) {
      assert.match(String(sql), /FROM public\.storage_assets/);
      return { rows: [assetRow], rowCount: 1 };
    },
    release() {},
  };
  const app = Fastify({ logger: false });
  app.decorate("db", {
    async query(sql) {
      assert.match(String(sql), /FROM public\.clientes c/);
      assert.match(String(sql), /p\.foto_perfil_asset_id/);
      assert.match(String(sql), /p\.foto_perfil_path/);
      return { rows: [clientRow], rowCount: 1 };
    },
    async connect() {
      return dbClient;
    },
  });
  app.decorate("supabaseAdmin", {
    storage: {
      from(bucket) {
        assert.equal(bucket, assetRow.bucket_name);
        return {
          async createSignedUrl(path) {
            assert.equal(path, PHOTO_PATH);
            return { data: { signedUrl: SIGNED_URL }, error: null };
          },
        };
      },
    },
  });
  app.decorate("requireRoles", () => async (request) => {
    request.claims = { roles: ["super_admin"], user: { id_usuario: USER_ID } };
  });
  await app.register(adminPersonasRoutes, { prefix: "/personas" });
  await app.ready();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/personas/clientes/${CLIENT_ID}`,
  });

  assert.equal(response.statusCode, 200);
  const cliente = response.json().data.cliente;
  assert.equal(cliente.foto_perfil_asset_id, ASSET_ID);
  assert.equal(cliente.foto_perfil_path, PHOTO_PATH);
  assert.equal(cliente.foto_perfil_signed_url, SIGNED_URL);
});
