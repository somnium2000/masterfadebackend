import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicAgendaRoutes from "../src/routes/v1/public/agenda.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const TARIFF_A = "44444444-4444-4444-8444-444444444444";
const TARIFF_B = "55555555-5555-4555-8555-555555555555";
const TARIFF_C = "56565656-5656-4565-8565-565656565656";
const PACKAGE_A = "23232323-2323-4232-8232-232323232323";

function createAgendaClient() {
  const calls = [];
  const barberRow = {
    id_empleado: BARBER_A,
    id_sucursal: BRANCH_A,
    nombre_sucursal: "Sucursal QA",
    nombres: "Ada",
    apellidos: "Lovelace",
    alias_publico: "Ada",
    resumen_publico: null,
    certificaciones_titulos: [],
    visible_en_landing: true,
    foto_perfil_path: null,
    foto_perfil_updated_at: null,
    foto_perfil_public_url: null,
  };
  const tariffRows = new Map([
    [SERVICE_A, {
      id_servicio: SERVICE_A,
      id_tarifa: TARIFF_A,
      nombre_servicio: "Corte",
      duracion_min: 30,
      buffer_min: 5,
      precio_hnl: 100,
      incluye_isv: false,
      isv_porcentaje: 0,
    }],
    [SERVICE_B, {
      id_servicio: SERVICE_B,
      id_tarifa: TARIFF_B,
      nombre_servicio: "Barba",
      duracion_min: 20,
      buffer_min: 10,
      precio_hnl: 150,
      incluye_isv: false,
      isv_porcentaje: 0,
    }],
    [SERVICE_C, {
      id_servicio: SERVICE_C,
      id_tarifa: TARIFF_C,
      nombre_servicio: "Cejas",
      duracion_min: 15,
      buffer_min: 3,
      precio_hnl: 80,
      incluye_isv: false,
      isv_porcentaje: 0,
    }],
  ]);
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("UPDATE public.citas_holds")) return { rows: [] };
      if (text.includes("UPDATE public.payment_intents")) return { rows: [], rowCount: 0 };
      if (text.includes("UPDATE public.citas c") && text.includes("no_show")) return { rows: [], rowCount: 0 };
      if (text.includes("agenda_min_servicio_vendible_min")) return { rows: [{ agenda_min_servicio_vendible_min: 10 }] };
      if (text.includes("agenda_buffer_global_min")) return { rows: [{ agenda_buffer_global_min: 7 }] };
      if (text.includes("FROM public.empleados e") && text.includes("e.id_sucursal = $1::uuid")) {
        return { rows: [barberRow] };
      }
      if (text.includes("FROM public.paquetes p") && text.includes("picked_offer")) {
        return {
          rows: [{
            id_paquete: PACKAGE_A,
            nombre_paquete: "MasterPaquete Pro",
            descripcion: "Paquete de prueba",
            precio_hnl: 250,
          }],
        };
      }
      if (text.includes("FROM public.paquetes_detalles pd")) {
        return {
          rows: [
            { id_servicio: SERVICE_A, cantidad: 1, nombre_servicio: "Corte", servicio_activo: true, servicio_agendable: true, deleted_at: null },
            { id_servicio: SERVICE_B, cantidad: 1, nombre_servicio: "Barba", servicio_activo: true, servicio_agendable: true, deleted_at: null },
          ],
        };
      }
      if (text.includes("FROM public.servicios s") && text.includes("active_tariffs")) {
        const ids = Array.isArray(params[1]) ? params[1] : [];
        return { rows: Array.from(new Set(ids)).map((id) => tariffRows.get(id)).filter(Boolean) };
      }
      if (text.includes("FROM public.horarios_semanales_sucursales_bloques")) {
        return { rows: [{ hora_inicio: "08:00:00", hora_fin: "12:00:00", almuerzo_inicio: null, almuerzo_fin: null }] };
      }
      if (text.includes("FROM public.bloqueos_agenda")) return { rows: [] };
      if (text.includes("FROM public.citas")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
}

async function createAgendaApp(client) {
  const app = Fastify({ logger: false });
  app.decorate("config", { bookingIsvEnabled: false });
  app.decorate("db", {
    async connect() {
      return client;
    },
  });
  await app.register(publicAgendaRoutes, { prefix: "/v1/public/agenda" });
  return app;
}

test("ruta real GET /v1/public/agenda/disponibilidad devuelve 200 para package y mixed", async () => {
  for (const selectionType of ["package", "mixed"]) {
    const client = createAgendaClient();
    const app = await createAgendaApp(client);
    const extraQuery = selectionType === "mixed" ? `&servicios=${SERVICE_A},${SERVICE_C}` : "";
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/disponibilidad?id_sucursal=${BRANCH_A}&selection_type=${selectionType}&id_paquete=${PACKAGE_A}${extraQuery}&fecha_desde=2026-07-15&fecha_hasta=2026-07-15`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().data.duracion_total_min, selectionType === "mixed" ? 65 : 50);
    assert.equal(response.json().data.buffer_total_min, 10);
    assert.notEqual(response.json()?.error?.code, "BOOKING_PACKAGE_FLOW_PENDING_2B");
    assert.ok(client.calls.some((call) => call.sql.includes("UPDATE public.citas_holds")));
    await app.close();
  }
});

test("ruta real GET /v1/public/agenda/horarios devuelve 200 para package y mixed", async () => {
  for (const selectionType of ["package", "mixed"]) {
    const client = createAgendaClient();
    const app = await createAgendaApp(client);
    const extraQuery = selectionType === "mixed" ? `&servicios=${SERVICE_A},${SERVICE_C}` : "";
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=${selectionType}&id_paquete=${PACKAGE_A}${extraQuery}&fecha=2026-07-15`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().data.duracion_total_min, selectionType === "mixed" ? 65 : 50);
    assert.equal(response.json().data.buffer_total_min, 10);
    assert.equal(response.json().data.monto_total_hnl, selectionType === "mixed" ? 330 : 250);
    assert.notEqual(response.json()?.error?.code, "BOOKING_PACKAGE_FLOW_PENDING_2B");
    await app.close();
  }
});

test("ruta real GET /v1/public/agenda/horarios con servicios usa el pipeline real de agenda", async () => {
  const client = createAgendaClient();
  const app = await createAgendaApp(client);
  const response = await app.inject({
    method: "GET",
    url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha=2026-07-15`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE public.citas_holds")));
  assert.ok(client.calls.length > 0);
  await app.close();
});
