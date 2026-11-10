import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fp from "fastify-plugin";
import gate from "../src/plugins/adminDataEntry.js";

import clienteRoutes from "../src/routes/v1/cliente.js";
import citasRoutes from "../src/routes/v1/citas.js";
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

function createDbClient({ profile = createProfile(), failOnClientesUpdate = null, images = false, appointments = false, foreignMembership = false } = {}) {
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
      if (foreignMembership && text.includes('FROM public.subscriptions s') && text.includes('WHERE s.id_suscripcion = $1::uuid')) return {rows:[{id_suscripcion:params[0],id_cliente:PERSONA_ID,estado_suscripcion_codigo:'activa'}]};
      if (appointments && text.includes('FROM public.citas c') && text.includes('c.id_cliente = $1::uuid OR c.id_persona_cliente = $2::uuid')) {
        assert.deepEqual(params.slice(0,2),[state.id_cliente,state.id_persona]);
        return {rows:params.length>2 && params[2]!==state.id_cliente ? [] : [{id_cita:state.id_cliente,id_sucursal:PERSONA_ID,id_empleado_barbero:PERSONA_ID,estado_cita_codigo:'completada',inicio_at:'2026-01-01T10:00:00Z',fin_at:'2026-01-01T11:00:00Z'}]};
      }
      if (images && text.includes('INSERT INTO public.storage_assets')) return { rows: [{ id_asset: PERSONA_ID }] };
      if (images && text.includes('FROM public.storage_assets')) return { rows: [{ id_asset: params[0], scope_key: 'private_client_profile', visibility: 'private', entity_type: 'cliente', entity_id: params[0] === PERSONA_ID ? CLIENTE_ID : PERSONA_ID, owner_cliente_id: params[0] === PERSONA_ID ? CLIENTE_ID : PERSONA_ID, bucket_name: 'imagenes_privadas', object_path: 'synthetic/profile.png' }] };
      if (images && text.includes('UPDATE public.storage_assets')) return { rows: [{ id_asset: PERSONA_ID, status: 'eliminado' }] };
      if (images && text.includes('UPDATE public.personas') && text.includes('foto_perfil_asset_id = NULL')) {
        assert.equal(params[0], state.id_persona);
        state.foto_perfil_asset_id = null; state.foto_perfil_path = null; return { rows: [], rowCount: 1 };
      }
      if (images && text.includes('FROM public.clientes') && !text.includes('JOIN public.personas')) return { rows: [{ id_cliente: CLIENTE_ID, id_usuario: profile.id_usuario, id_persona: PERSONA_ID }] };

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
            {table_name:'personas',column_name:'foto_perfil_asset_id'}, {table_name:'personas',column_name:'foto_perfil_path'},
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
        assert.equal(params[0], state.id_cliente);
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

async function createApp({ client = createDbClient(), authorized = true, clientId = CLIENTE_ID } = {}) {
  const app = Fastify({ logger: false });
  await app.register(fp(async a => { a.decorate("config", { adminDataEntryMode: true, paymentProvider: "disabled" }); }, { name: "env-plugin" }));
  await app.register(gate);
  app.decorate("requireRoles", () => async (request, reply) => {
    if (!authorized) {
      return sendError(reply, 403, "No tienes permisos para realizar esta accion", {
        code: "FORBIDDEN",
        requestId: request.id,
      });
    }
    request.claims = { cliente_id: clientId, roles: ['cliente'], user: { id_usuario: '33333333-3333-4333-8333-333333333333', id_persona: client.state.id_persona } };
  });
  app.decorate("db", { query: client.query.bind(client), async connect() { return client; } });
  app.decorate('supabaseAdmin', { storage: { from: () => ({ createSignedUploadUrl: async () => ({data:{token:'synthetic-upload'}}), createSignedUrl: async () => ({data:{signedUrl:'https://synthetic.invalid/photo'}}), remove: async () => ({error:null}) }) } });
  await app.register(clienteRoutes, { prefix: "/v1/cliente" });
  await app.register(citasRoutes, { prefix: "/v1/citas" });
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

test("guardar sin preferencias sigue permitido y conserva el perfil incompleto", async () => {
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
  assert.equal(response.json().data.profile_completion.is_complete, false);
  assert.equal(response.json().data.profile_completion.completion_percent, 67);
  assert.deepEqual(response.json().data.profile_completion.missing_fields, ["preferencias_corte"]);
  assert.deepEqual(response.json().data.profile_completion.recommended_fields, []);
});

test("preferencias no vacias conservan el texto", async () => {
  const { response, client } = await patchProfile({ preferencias_corte: "  degradado bajo  " });

  assert.equal(response.statusCode, 200);
  assert.equal(client.state.preferencias_corte, "degradado bajo");
  assert.equal(response.json().data.cliente.preferencias_corte, "degradado bajo");
  assert.equal(response.json().data.profile_completion.is_complete, true);
  assert.equal(response.json().data.profile_completion.completion_percent, 100);
});

test("genero y direccion vacios no reducen un perfil completo", async () => {
  const client = createDbClient({
    profile: createProfile({ genero_codigo: null, genero_descripcion: null, direccion_texto: null }),
  });
  const { response } = await patchProfile({ telefono_principal: "+504 9999-0004" }, { client });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.profile_completion.is_complete, true);
  assert.equal(response.json().data.profile_completion.completion_percent, 100);
  assert.deepEqual(response.json().data.profile_completion.missing_fields, []);
});

test("preferencias con solo espacios no cuentan como completadas", async () => {
  const { response } = await patchProfile({ preferencias_corte: "   " });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.cliente.preferencias_corte, null);
  assert.equal(response.json().data.profile_completion.is_complete, false);
  assert.equal(response.json().data.profile_completion.completion_percent, 67);
  assert.deepEqual(response.json().data.profile_completion.missing_fields, ["preferencias_corte"]);
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

test('fotografia propia prepara, lee y elimina; fotografia ajena es rechazada', async t => {
  const client = createDbClient({ images: true, profile: createProfile({ foto_perfil_asset_id: PERSONA_ID, foto_perfil_path: 'synthetic/profile.png' }) });
  const app = await createApp({client}); t.after(() => app.close());
  let response = await app.inject({method:'POST',url:'/v1/cliente/me/profile-image/prepare',payload:{file_name:'photo.png',content_type:'image/png',size_bytes:128}});
  assert.equal(response.statusCode,201,response.body);
  response = await app.inject({method:'POST',url:'/v1/cliente/me/profile-image/read-url',payload:{asset_id:PERSONA_ID}});
  assert.equal(response.statusCode,200,response.body);
  const before = client.calls.filter(x=>x.sql.startsWith('UPDATE')).length;
  response = await app.inject({method:'POST',url:'/v1/cliente/me/profile-image/read-url',payload:{asset_id:'44444444-4444-4444-8444-444444444444'}});
  assert.equal(response.statusCode,403,response.body);
  assert.equal(client.calls.filter(x=>x.sql.startsWith('UPDATE')).length,before);
  response = await app.inject({method:'DELETE',url:'/v1/cliente/me/profile-image'});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(client.state.foto_perfil_asset_id,null);
});

test('dashboard consulta perfil, historial, pendientes y membresias sin activar compras', async t => {
  const client = createDbClient(); const app = await createApp({client}); t.after(()=>app.close());
  for (const url of ['/v1/cliente/me','/v1/citas','/v1/citas/pendiente','/v1/cliente/planes/estado']) {
    const response=await app.inject({url}); assert.equal(response.statusCode,200,url+': '+response.body);
  }
  const detail=await app.inject({url:'/v1/citas/44444444-4444-4444-8444-444444444444'});
  assert.equal(detail.statusCode,404,detail.body);
  const scoped=client.calls.filter(x=>x.sql.includes('c.id_cliente = $1::uuid OR c.id_persona_cliente = $2::uuid'));
  assert.ok(scoped.length>=2);
  for(const call of scoped) assert.deepEqual(call.params.slice(0,2),[CLIENTE_ID,PERSONA_ID]);
  const cancelled=await app.inject({method:'POST',url:'/v1/cliente/planes/cancelar',payload:{}});
  assert.equal(cancelled.statusCode,200,cancelled.body);
  assert.equal(cancelled.json().data.cancelacion.cancelled,false);
});

test('dos identidades conservan perfil y rechazan identidad o foto ajena en escrituras', async t => {
  const other='44444444-4444-4444-8444-444444444444';
  for(const id of [CLIENTE_ID,other]) {
    const client=createDbClient({images:true,profile:createProfile({id_cliente:id})});
    const app=await createApp({client,clientId:id}); t.after(()=>app.close());
    const own=await app.inject({url:'/v1/cliente/me'}); assert.equal(own.statusCode,200,own.body);
    const patch=await app.inject({method:'PATCH',url:'/v1/cliente/me',payload:{id_cliente:id===other?CLIENTE_ID:other,telefono_principal:'99999999'}});
    assert.equal(patch.statusCode,200,patch.body);
    assert.equal(patch.json().data.cliente.id_cliente,id);
    const before=client.calls.filter(x=>x.sql.startsWith('UPDATE')).length;
    const remove=await app.inject({method:'DELETE',url:'/v1/cliente/me/profile-image',payload:{asset_id:other}});
    // DELETE only operates on the authenticated profile, never on an asset supplied by the caller.
    assert.equal(remove.statusCode,200,remove.body);
    assert.equal(remove.json().data.removed,false);
    assert.equal(client.calls.filter(x=>x.sql.startsWith('UPDATE')).length,before);
  }
});

test('dos clientes solo consultan citas propias; no cancelan membresia ajena',async t=>{
  const other='44444444-4444-4444-8444-444444444444';
  for(const id of [CLIENTE_ID,other]) {
    const client=createDbClient({appointments:true,foreignMembership:true,profile:createProfile({id_cliente:id})});
    const app=await createApp({client,clientId:id});t.after(()=>app.close());
    let response=await app.inject({url:'/v1/citas'});assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json().data.citas.map(x=>x.id_cita),[id]);
    response=await app.inject({url:'/v1/citas/'+id});assert.equal(response.statusCode,200,response.body);
    response=await app.inject({url:'/v1/citas/'+(id===other?CLIENTE_ID:other)});assert.equal(response.statusCode,404,response.body);
    response=await app.inject({method:'PATCH',url:'/v1/cliente/planes/'+other+'/cancelar',payload:{}});assert.equal(response.statusCode,403,response.body);
    assert.equal(client.calls.filter(x=>/^\s*(UPDATE|INSERT|DELETE)\b/.test(x.sql)).length,0);
  }
});

test("perfil existente sin cambios de preferencias conserva respuesta compatible", async () => {
  const client = createDbClient({ profile: createProfile({ preferencias_corte: "tijera arriba" }) });
  const { response } = await patchProfile({ direccion_texto: "Valle de Angeles" }, { client });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.cliente.preferencias_corte, "tijera arriba");
  assert.equal(response.json().data.cliente.direccion_texto, "Valle de Angeles");
  assert.equal(response.json().ok, true);
});

