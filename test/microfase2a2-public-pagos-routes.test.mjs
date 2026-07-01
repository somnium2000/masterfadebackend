import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicPagosRoutes from "../src/routes/v1/public/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

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

function makeGroupRow() {
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
    expires_at: "2099-01-01T16:00:00.000Z",
    direccion_correo: "cliente@example.com",
  };
}

function createPagosClient({ existingIntent = null, persistedPromotion = false } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM public.citas_grupos cg") && text.includes("co.direccion_correo")) {
        return { rows: [makeGroupRow()] };
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
        return { rows: [{ id_provider: PROVIDER_A, codigo: "mock", nombre: "Mock", activo: true }] };
      }
      if (text.includes("FROM public.payment_intents") && text.includes("estado_intent_codigo = ANY")) {
        return { rows: existingIntent ? [existingIntent] : [] };
      }
      if (text.includes("INSERT INTO public.payment_intents")) {
        return {
          rows: [{
            id_intent: INTENT_A,
            link_pago_url: "http://localhost:5173/agendar/exito?id_grupo_cita=1",
            expires_at: "2099-01-01T16:00:00.000Z",
            monto_hnl: "115.00",
            moneda_codigo: "HNL",
            estado_intent_codigo: "link_generado",
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

async function createPagosApp(client) {
  PaymentProviderFactory.reset();
  process.env.PAYMENT_PROVIDER = "mock";
  const app = Fastify({ logger: false });
  app.decorate("config", { paymentProvider: "mock" });
  app.decorate("db", {
    async connect() {
      return client;
    },
  });
  await app.register(publicPagosRoutes, { prefix: "/v1/public/pagos" });
  return app;
}

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
  assert.equal(intentInsert.params[3], 115);
  assert.equal(intentInsert.params[9], GROUP_A);
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
