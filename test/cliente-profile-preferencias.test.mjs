import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import clienteRoutes from "../src/routes/v1/cliente.js";
import { sendError } from "../src/utils/errors.js";

const CLIENTE_ID = "11111111-1111-4111-8111-111111111111";
const PERSONA_ID = "22222222-2222-4222-8222-222222222222";

function createProfile(overrides = {}) {
  return {
    id_cliente: CLIENTE_ID,
    id_persona: PERSONA_ID,
    id_usuario: "33333333-3333-4333-8333-333333333333",
    id_sucursal_origen: null,
    nombre_sucursal: null,
    estado_cliente: true,
    acepta_terminos: true,
    consentimiento_marketing: false,
    acepta_terminos_at: null,
    consentimiento_marketing_at: null,
    nombres: "Ana",
    apellidos: "Perez",
    fecha_nacimiento: "1990-05-20",
    genero_codigo: "F",
    genero_descripcion: "Femenino",
    telefono_principal: "+504 9999-9999",
    direccion_texto: "Tegucigalpa",
    observaciones: null,
    preferencias_corte: "laterales cortos",
    foto_perfil_asset_id: null,
    foto_perfil_path: null,
    correo_principal: "ana@example.com",
    ...overrides,
  };
}

function createDbClient({ profile = createProfile(), failOnClientesUpdate = null } = {}) {
  const calls = [];
  const state = { ...profile };
  let transactionSnapshot = null;

  return {
    calls,
    state,
    release() {},
    async query(sql, params = []) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });

      if (text === "BEGIN") {
        transactionSnapshot = { ...state };
        return { rows: [] };
      }
      if (text === "COMMIT") {
        transactionSnapshot = null;
        return { rows: [] };
      }
      if (text === "ROLLBACK") {
        Object.assign(state, transactionSnapshot || {});
        transactionSnapshot = null;
        return { rows: [] };
      }
      if (text.includes("FROM information_schema.columns")) {
        return {
          rows: [
            { table_name: "clientes", column_name: "preferencias", data_type: "jsonb", udt_name: "jsonb" },
            { table_name: "clientes", column_name: "updated_at", data_type: "timestamp", udt_name: "timestamp" },
            { table_name: "personas", column_name: "updated_at", data_type: "timestamp", udt_name: "timestamp" },
          ],
        };
      }
      if (text.includes("FROM public.generos")) {
        const code = String(params[0] || "").toUpperCase();
        const allowed = new Map([["F", "Femenino"], ["M", "Masculino"], ["N", "Prefiero no decir"]]);
        return allowed.has(code)
          ? { rows: [{ genero_codigo: code, descripcion: allowed.get(code) }] }
          : { rows: [] };
      }
      if (text.includes("FROM public.clientes c") && text.includes("JOIN public.personas p")) {
        return { rows: [{ ...state }] };
      }
      if (text.includes("FROM public.vw_points_balance")) {
        return { rows: [{ balance: 0 }] };
      }
      if (text.startsWith("UPDATE public.personas")) {
        state.telefono_principal = params[1];
        state.fecha_nacimiento = params[2];
        state.genero_codigo = params[3];
        state.direccion_texto = params[4];
        state.observaciones = params[5];
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("UPDATE public.clientes")) {
        if (failOnClientesUpdate) throw failOnClientesUpdate;
        if (params[1] === null) {
          const error = new Error("null value violates not-null constraint");
          error.code = "23502";
          throw error;
        }
        state.preferencias_corte = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };
}

async function createApp({ client = createDbClient(), authorized = true } = {}) {
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", () => async (request, reply) => {
    if (!authorized) {
      return sendError(reply, 403, "No tienes permisos para realizar esta accion", {
        code: "FORBIDDEN",
        requestId: request.id,
      });
    }
    request.claims = { cliente_id: CLIENTE_ID };
  });
  app.decorate("db", { async connect() { return client; } });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  return app;
}

async function patchProfile(payload, options = {}) {
  const client = options.client || createDbClient(options);
  const app = await createApp({ client, authorized: options.authorized ?? true });
  try {
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/cliente/me",
      payload,
    });
    return { response, client };
  } finally {
    await app.close();
  }
}

function clientesUpdates(client) {
  return client.calls.filter((call) => call.sql.startsWith("UPDATE public.clientes"));
}

test("telefono valido con preferencias vacias persiste JSON vacio no nulo", async () => {
  const { response, client } = await patchProfile({
    telefono_principal: "+504 9999-0000",
    preferencias_corte: null,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.telefono_principal, "+504 9999-0000");
  assert.equal(client.state.preferencias_corte, "");
  assert.deepEqual(clientesUpdates(client)[0].params, [CLIENTE_ID, JSON.stringify("")]);
});

test("perfil completo admite preferencias vacias", async () => {
  const { response, client } = await patchProfile({
    telefono_principal: "+504 9999-0001",
    fecha_nacimiento: "1992-06-15",
    genero_codigo: "F",
    direccion_texto: "Comayaguela",
    preferencias_corte: null,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.preferencias_corte, "");
  assert.equal(response.json().data.cliente.preferencias_corte, null);
});

test("preferencias no vacias conservan el texto", async () => {
  const { response, client } = await patchProfile({ preferencias_corte: "  degradado bajo  " });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.preferencias_corte, "degradado bajo");
  assert.equal(response.json().data.cliente.preferencias_corte, "degradado bajo");
});

test("null borra explicitamente preferencias existentes", async () => {
  const client = createDbClient({ profile: createProfile({ preferencias_corte: "barba corta" }) });
  const { response } = await patchProfile({ preferencias_corte: null }, { client });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.preferencias_corte, "");
  assert.equal(clientesUpdates(client).length, 1);
});

test("PATCH que omite preferencias no sobrescribe el valor existente", async () => {
  const client = createDbClient({ profile: createProfile({ preferencias_corte: "mantener largo" }) });
  const { response } = await patchProfile({ telefono_principal: "+504 9999-0002" }, { client });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.preferencias_corte, "mantener largo");
  assert.equal(clientesUpdates(client).length, 0);
});

test("mantiene validaciones de fecha y genero", async () => {
  const invalidDate = await patchProfile({ fecha_nacimiento: "2099-01-01" });
  assert.equal(invalidDate.response.statusCode, 400);
  assert.equal(invalidDate.response.json().error.code, "CLIENTE_PROFILE_DATE_FUTURE");

  const invalidGender = await patchProfile({ genero_codigo: "INVALIDO" });
  assert.equal(invalidGender.response.statusCode, 422);
  assert.equal(invalidGender.response.json().error.code, "CLIENTE_PROFILE_GENERO_INVALID");
});

test("rechaza usuarios no autorizados antes de consultar la base", async () => {
  const client = createDbClient();
  const { response } = await patchProfile({ preferencias_corte: null }, { client, authorized: false });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "FORBIDDEN");
  assert.equal(client.calls.length, 0);
});

test("error durante la escritura ejecuta rollback y no filtra detalles SQL", async () => {
  const databaseError = new Error("duplicate internal database detail");
  databaseError.code = "XX000";
  const client = createDbClient({
    profile: createProfile({ telefono_principal: "+504 8888-8888", preferencias_corte: "clasico" }),
    failOnClientesUpdate: databaseError,
  });
  const { response } = await patchProfile({
    telefono_principal: "+504 9999-0003",
    preferencias_corte: null,
  }, { client });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "CLIENTE_PROFILE_UPDATE_ERROR");
  assert.equal(response.json().error.message, "No se pudo procesar la solicitud.");
  assert.doesNotMatch(response.body, /duplicate|SQL|XX000/i);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(client.state.telefono_principal, "+504 8888-8888");
  assert.equal(client.state.preferencias_corte, "clasico");
});

test("perfil existente sin cambios de preferencias conserva respuesta compatible", async () => {
  const client = createDbClient({ profile: createProfile({ preferencias_corte: "tijera arriba" }) });
  const { response } = await patchProfile({ direccion_texto: "Valle de Angeles" }, { client });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.cliente.preferencias_corte, "tijera arriba");
  assert.equal(response.json().data.cliente.direccion_texto, "Valle de Angeles");
  assert.equal(response.json().ok, true);
});

