import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicPagosRoutes, {
  buildProviderOrderReference,
} from "../src/routes/v1/public/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";
import { TodoPagoPreprodSimulatedProvider } from "../src/services/payments/TodoPagoPreprodSimulatedProvider.js";

const GROUP_A = "11111111-2222-4333-8444-555555555555";
const CITA_A = "66666666-6666-4666-8666-666666666666";
const HOLD_A = "77777777-7777-4777-8777-777777777777";
const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DETAIL_A = "12121212-1212-4121-8121-121212121212";
const PROVIDER_A = "22222222-2222-4222-8222-222222222222";
const USER_A = "88888888-8888-4888-8888-888888888888";
const INTENT_A = "99999999-9999-4999-8999-999999999999";
const PROMO_A = "13131313-1313-4131-8131-131313131313";
const PROMO_RULE_A = "14141414-1414-4141-8141-141414141414";

function makeGroupRow({
  ownerEmail = "cliente@example.com",
  expiresAt = "2099-01-01T16:00:00.000Z",
} = {}) {
  return {
    id_grupo_cita: GROUP_A,
    estado_grupo_codigo: "activo",
    id_cliente_titular: null,
    id_persona_titular: USER_A,
    id_cita: CITA_A,
    orden_integrante: 1,
    estado_cita_codigo: "en_espera",
    total_pagar_hnl: "115.00",
    id_hold: HOLD_A,
    estado_hold_codigo: "activo",
    expires_at: expiresAt,
    direccion_correo: ownerEmail,
    titular_nombres: "Ada",
    titular_apellidos: "Lovelace",
  };
}

function createPagosClient({
  existingIntent = null,
  persistedPromotion = false,
  failProviderUpdate = false,
  throwProviderUpdate = false,
  ownerEmail = "cliente@example.com",
  holdExpiresAt = "2099-01-01T16:00:00.000Z",
  providerCode = "mock",
} = {}) {
  const calls = [];
  let activeIntent = existingIntent ? { ...existingIntent } : null;
  const client = {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM public.citas_grupos cg") && text.includes("co.direccion_correo")) {
        return { rows: [makeGroupRow({ ownerEmail, expiresAt: holdExpiresAt })] };
      }
      if (text.includes("FROM public.citas c") && text.includes("COALESCE(c.subtotal_servicios_hnl")) {
        return {
          rows: [{
            id_cita: CITA_A,
            id_grupo_cita: GROUP_A,
            id_sucursal: BRANCH_A,
            id_empleado_barbero: BARBER_A,
            inicio_at: "2026-07-15T15:00:00.000Z",
            selection_type: "services",
            id_paquete: null,
            subtotal_servicios_hnl: "100.00",
          }],
        };
      }
      if (text.includes("FROM public.citas_detalles") && text.includes("WHERE id_cita = $1::uuid")) {
        return {
          rows: [{
            id_cita_detalle: DETAIL_A,
            id_servicio: SERVICE_A,
            cantidad: 1,
            precio_unitario_hnl: "100.00",
            subtotal_hnl: "100.00",
            descuento_hnl: "0.00",
            incluye_isv_snapshot: false,
            isv_porcentaje: "15.00",
            isv_hnl: "15.00",
            total_linea_hnl: "115.00",
          }],
        };
      }
      if (text.includes("FROM public.citas_promociones") && text.includes("estado_aplicacion_codigo = 'aplicada'")) {
        if (!persistedPromotion) return { rows: [] };
        return {
          rows: [{
            id_cita_promocion: "15151515-1515-4151-8151-151515151515",
            id_grupo_cita: GROUP_A,
            id_cita: CITA_A,
            id_cita_detalle: DETAIL_A,
            id_cita_paquete: null,
            id_promocion: PROMO_A,
            id_promocion_regla: PROMO_RULE_A,
            aplica_a_codigo: "servicio",
            descuento_calculado_hnl: "10.00",
            prioridad_aplicacion: 10,
            es_acumulable: true,
            estado_aplicacion_codigo: "aplicada",
          }],
        };
      }
      if (text.includes("FROM public.promociones_reglas_agendamiento")) {
        throw new Error("promotion engine unavailable");
      }
      if (text.includes("UPDATE public.citas_detalles")) return { rows: [] };
      if (text.includes("UPDATE public.citas") && text.includes("total_pagar_hnl")) return { rows: [] };
      if (text.includes("FROM public.usuarios u")) return { rows: [{ id_usuario: USER_A }] };
      if (text.includes("FROM public.payment_providers")) {
        return { rows: [{ id_provider: PROVIDER_A, codigo: providerCode, nombre: providerCode, activo: true }] };
      }
      if (text.includes("FROM public.payment_intents") && text.includes("estado_intent_codigo = ANY")) {
        return { rows: activeIntent ? [{ ...activeIntent }] : [] };
      }
      if (text.includes("INSERT INTO public.payment_intents")) {
        const idIntent = params[0];
        activeIntent = {
          id_intent: idIntent,
          id_provider: PROVIDER_A,
          id_cita: CITA_A,
          id_hold: HOLD_A,
          link_pago_url: null,
          referencia_externa: null,
          idempotency_key: params[5],
          expires_at: holdExpiresAt,
          monto_hnl: "115.00",
          moneda_codigo: "HNL",
          estado_intent_codigo: "creado",
          id_grupo_cita: GROUP_A,
        };
        return {
          rows: [{ ...activeIntent }],
        };
      }
      if (text.includes("UPDATE public.payment_intents") && text.includes("link_pago_url = $2::text")) {
        if (throwProviderUpdate) throw new Error("database update failed");
        if (failProviderUpdate) return { rows: [] };
        activeIntent = {
          ...activeIntent,
          link_pago_url: params[1],
          referencia_externa: params[2],
          orden_compra: params[3],
          provider_session_id: params[2],
          launch_expires_at: params[4],
          estado_intent_codigo: "link_generado",
        };
        return {
          rows: [{
            ...activeIntent,
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

async function createPagosApp(client, {
  providerCode = "mock",
  providerAdapter = null,
  logs = null,
} = {}) {
  PaymentProviderFactory.reset();
  process.env.PAYMENT_PROVIDER = "mock";
  if (providerAdapter) PaymentProviderFactory._instance = providerAdapter;
  const app = Fastify({
    logger: logs
      ? {
          level: "trace",
          stream: { write: (message) => logs.push(message) },
        }
      : false,
  });
  app.decorate("config", { paymentProvider: providerCode });
  app.decorate("db", {
    async connect() {
      return client;
    },
  });
  await app.register(publicPagosRoutes, { prefix: "/v1/public/pagos" });
  return app;
}

function createIframeProvider({ failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async createIntent(input) {
      calls.push(input);
      if (failure) throw failure;
      return {
        providerIntentId: "todopago-session-001",
        paymentUrl: null,
        launch: {
          type: "iframe_post",
          action: "https://modal.example.test/checkout",
          method: "POST",
          fields: {
            tokenTodomovil: "private-launch-token",
            idTransaccion: "todopago-session-001",
            amount: "115.00",
            customerName: input.metadata.customerName,
            ordenDeCompra: input.metadata.ordenDeCompra,
            currencyCode: input.moneda,
            encrypted: "private-encrypted-payload",
          },
          allowedMessageOrigin: "https://modal.example.test",
          expiresAt: input.metadata.expiresAt,
        },
        raw: {
          token: "private-raw-token",
          encrypted: "private-raw-encrypted",
        },
      };
    },
    async cancelIntent() {},
  };
}

function publicIntentPayload(overrides = {}) {
  return {
    id_grupo_cita: GROUP_A,
    titular_email: "cliente@example.com",
    nombre_apellido: "Nombre suministrado por cliente",
    ...overrides,
  };
}

test("ordenDeCompra es deterministica, unica por provider e intent y no contiene PII", () => {
  const first = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: INTENT_A,
  });
  const repeated = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: INTENT_A,
  });
  const anotherProvider = buildProviderOrderReference({
    providerCode: "mock",
    idIntent: INTENT_A,
  });

  assert.equal(first, repeated);
  assert.notEqual(first, anotherProvider);
  assert.equal(first.includes("cliente@example.com"), false);
  assert.equal(first.includes("Ada"), false);
  assert.match(first, /^MF-TODOPAGO-[0-9A-F]{32}$/);
});

test("iframe_post persiste solo metadatos seguros y devuelve launch una sola vez", async () => {
  const logs = [];
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    headers: { "x-forwarded-for": "203.0.113.99" },
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.data.payment_url, null);
  assert.equal(body.data.launch.type, "iframe_post");
  assert.equal(body.data.launch.fields.tokenTodomovil, "private-launch-token");
  assert.equal(body.data.launch.fields.encrypted, "private-encrypted-payload");
  assert.equal(provider.calls.length, 1);

  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  const providerInput = provider.calls[0];
  const expectedOrder = buildProviderOrderReference({
    providerCode: "todopago",
    idIntent: intentInsert.params[0],
  });
  assert.equal(providerInput.idempotencyKey, intentInsert.params[5]);
  assert.equal(providerInput.montoHnl, 115);
  assert.equal(providerInput.moneda, "HNL");
  assert.equal(providerInput.metadata.customerName, "Ada Lovelace");
  assert.equal(providerInput.metadata.clientIp, "127.0.0.1");
  assert.notEqual(providerInput.metadata.clientIp, "203.0.113.99");
  assert.equal(providerInput.metadata.ordenDeCompra, expectedOrder);
  assert.equal(providerInput.metadata.expiresAt, "2099-01-01T16:00:00.000Z");

  const providerUpdate = client.calls.find((call) =>
    call.sql.includes("UPDATE public.payment_intents")
    && call.sql.includes("provider_session_id = $3::text")
  );
  assert.ok(providerUpdate);
  assert.deepEqual(providerUpdate.params, [
    intentInsert.params[0],
    null,
    "todopago-session-001",
    expectedOrder,
    "2099-01-01T16:00:00.000Z",
    GROUP_A,
  ]);
  assert.equal(providerUpdate.sql.includes("launch.fields"), false);
  assert.equal(providerUpdate.sql.includes("tokenTodomovil"), false);
  assert.equal(providerUpdate.sql.includes("encrypted"), false);

  const persistedDiagnostics = JSON.stringify(client.calls);
  assert.equal(persistedDiagnostics.includes("private-launch-token"), false);
  assert.equal(persistedDiagnostics.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);

  const responseWithoutLaunch = structuredClone(body);
  delete responseWithoutLaunch.data.launch;
  const additionalResponse = JSON.stringify(responseWithoutLaunch);
  assert.equal(additionalResponse.includes("private-launch-token"), false);
  assert.equal(additionalResponse.includes("private-encrypted-payload"), false);
  assert.equal(client.calls.some((call) =>
    call.sql.includes("SET estado_cita_codigo = 'confirmada'")
  ), false);
  assert.equal(client.calls.some((call) => call.sql.includes("INSERT INTO public.payments")), false);

  await app.close();
});

test("hold vencido no llama al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    holdExpiresAt: "2000-01-01T00:00:00.000Z",
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("titular sin propiedad del hold no llama al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload({ titular_email: "intruso@example.com" }),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_GROUP_FORBIDDEN");
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("datos reservados enviados por cliente se ignoran y se derivan en backend", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      ...publicIntentPayload(),
      monto_hnl: 0.01,
      moneda_codigo: "USD",
      ordenDeCompra: "CLIENT-ORDER",
      customerName: "Cliente falso",
      clientIp: "203.0.113.20",
      expiresAt: "2099-12-31T23:59:59.000Z",
      provider_session_id: "client-session",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(provider.calls.length, 1);
  const providerInput = provider.calls[0];
  assert.equal(providerInput.montoHnl, 115);
  assert.equal(providerInput.moneda, "HNL");
  assert.equal(providerInput.metadata.customerName, "Ada Lovelace");
  assert.equal(providerInput.metadata.clientIp, "127.0.0.1");
  assert.equal(providerInput.metadata.expiresAt, "2099-01-01T16:00:00.000Z");
  assert.notEqual(providerInput.metadata.ordenDeCompra, "CLIENT-ORDER");
  await app.close();
});

test("repetir la operacion idempotente no crea otra sesion y devuelve launch null", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().data.id_intent, second.json().data.id_intent);
  assert.equal(first.json().data.launch.type, "iframe_post");
  assert.equal(second.json().data.launch, null);
  assert.equal(provider.calls.length, 1);
  assert.equal(client.calls.filter((call) => call.sql.includes("INSERT INTO public.payment_intents")).length, 1);
  await app.close();
});

test("intent existente sin launch efimero no vuelve a llamar al proveedor", async () => {
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    existingIntent: {
      id_intent: INTENT_A,
      id_hold: HOLD_A,
      link_pago_url: null,
      referencia_externa: null,
      idempotency_key: `masterfade:booking-payment:${INTENT_A}`,
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      estado_intent_codigo: "creado",
    },
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.id_intent, INTENT_A);
  assert.equal(response.json().data.launch, null);
  assert.equal(provider.calls.length, 0);
  await app.close();
});

test("fallo del proveedor no persiste metadatos ni filtra secretos", async () => {
  const logs = [];
  const provider = createIframeProvider({
    failure: Object.assign(new Error("private-launch-token private-encrypted-payload"), {
      code: "TODOPAGO_AUTH_HTTP_ERROR",
    }),
  });
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_CREATE_INTENT_ERROR");
  assert.equal(provider.calls.length, 1);
  assert.equal(client.calls.some((call) => call.sql.includes("provider_session_id = $3::text")), false);
  assert.equal(response.body.includes("private-launch-token"), false);
  assert.equal(response.body.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);
  await app.close();
});

test("fallo de persistencia posterior no devuelve launch", async () => {
  const logs = [];
  const provider = createIframeProvider();
  const client = createPagosClient({
    providerCode: "todopago",
    throwProviderUpdate: true,
  });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: provider,
    logs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_CREATE_INTENT_ERROR");
  assert.equal(provider.calls.length, 1);
  assert.equal(response.body.includes("launch"), false);
  assert.equal(response.body.includes("private-launch-token"), false);
  assert.equal(response.body.includes("private-encrypted-payload"), false);
  assert.equal(logs.join("").includes("private-launch-token"), false);
  assert.equal(logs.join("").includes("private-encrypted-payload"), false);
  assert.equal(client.calls.filter((call) => call.sql === "COMMIT").length, 1);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  await app.close();
});

test("preprod_simulated conserva redirect y payment_url", async () => {
  const client = createPagosClient({ providerCode: "todopago" });
  const app = await createPagosApp(client, {
    providerCode: "todopago",
    providerAdapter: new TodoPagoPreprodSimulatedProvider(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: publicIntentPayload(),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.launch.type, "redirect");
  assert.equal(response.json().data.launch.method, "GET");
  assert.equal(response.json().data.payment_url, response.json().data.launch.action);
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent conserva snapshots y crea intent", async () => {
  const client = createPagosClient();
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.monto_hnl, 115);
  assert.ok(client.calls.some((call) => call.sql === "BEGIN"));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(!client.calls.some((call) => call.sql === "ROLLBACK"));

  const detailUpdate = client.calls.find((call) => call.sql.includes("UPDATE public.citas_detalles"));
  assert.ok(detailUpdate);
  assert.equal(detailUpdate.sql.includes("incluye_isv_snapshot"), false);
  assert.equal(detailUpdate.sql.includes("isv_porcentaje"), false);
  assert.deepEqual(detailUpdate.params, [DETAIL_A, 0, 15, 115]);

  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.ok(intentInsert);
  assert.match(intentInsert.params[0], /^[0-9a-f-]{36}$/i);
  assert.equal(intentInsert.params[4], 115);
  assert.equal(intentInsert.params[5], `masterfade:booking-payment:${intentInsert.params[0]}`);
  assert.equal(intentInsert.params[8], GROUP_A);
  const providerUpdate = client.calls.find((call) =>
    call.sql.includes("UPDATE public.payment_intents")
    && call.sql.includes("link_pago_url = $2::text")
  );
  assert.ok(providerUpdate);
  assert.equal(providerUpdate.params[0], intentInsert.params[0]);
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent retorna intent existente idempotente", async () => {
  const client = createPagosClient({
    existingIntent: {
      id_intent: INTENT_A,
      id_hold: HOLD_A,
      link_pago_url: "http://localhost:5173/pago",
      expires_at: "2099-01-01T16:00:00.000Z",
      monto_hnl: "115.00",
      moneda_codigo: "HNL",
      estado_intent_codigo: "link_generado",
    },
  });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.id_intent, INTENT_A);
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO public.payment_intents")));
  assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent hace rollback si no puede validar promocion persistida", async () => {
  const client = createPagosClient({ persistedPromotion: true });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "BOOKING_PROMOTION_VALIDATION_UNAVAILABLE");
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO public.payment_intents")));
  await app.close();
});

test("ruta real POST /v1/public/pagos/crear-intent conserva intent local si falla update post proveedor", async () => {
  const client = createPagosClient({ failProviderUpdate: true });
  const app = await createPagosApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/v1/public/pagos/crear-intent",
    payload: {
      id_grupo_cita: GROUP_A,
      titular_email: "cliente@example.com",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "PUBLIC_PAGOS_HOLD_EXPIRED");
  const intentInsert = client.calls.find((call) => call.sql.includes("INSERT INTO public.payment_intents"));
  assert.ok(intentInsert);
  const commits = client.calls.filter((call) => call.sql === "COMMIT").length;
  assert.equal(commits, 1);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  await app.close();
});
