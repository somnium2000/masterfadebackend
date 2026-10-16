import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminCitasRoutes from "../src/routes/v1/admin/citas.js";
import publicAgendaRoutes from "../src/routes/v1/public/agenda.js";
import { buildOperationalDayRange } from "../src/services/agendaService.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const BARBER_B = "44444444-4444-4444-8444-444444444444";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARIFF_A = "55555555-5555-4555-8555-555555555555";
const USER_A = "66666666-6666-4666-8666-666666666666";

function createStore() {
  const store = {
    exceptions: [],
    calls: [],
    nextException: 1,
  };

  const barbers = [
    {
      id_empleado: BARBER_A,
      id_sucursal: BRANCH_A,
      es_barbero: true,
      nombre_sucursal: "Sucursal QA",
      nombre_completo: "Ada Lovelace",
      nombres: "Ada",
      apellidos: "Lovelace",
      alias_publico: "Ada",
      resumen_publico: null,
      certificaciones_titulos: [],
      visible_en_landing: true,
      foto_perfil_path: null,
      foto_perfil_updated_at: null,
      foto_perfil_public_url: null,
    },
    {
      id_empleado: BARBER_B,
      id_sucursal: BRANCH_A,
      es_barbero: true,
      nombre_sucursal: "Sucursal QA",
      nombre_completo: "Grace Hopper",
      nombres: "Grace",
      apellidos: "Hopper",
      alias_publico: "Grace",
      resumen_publico: null,
      certificaciones_titulos: [],
      visible_en_landing: true,
      foto_perfil_path: null,
      foto_perfil_updated_at: null,
      foto_perfil_public_url: null,
    },
  ];

  async function query(sql, params = []) {
    const text = String(sql);
    const compact = text.replace(/\s+/g, " ");
    store.calls.push({ sql: text, params });

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [], rowCount: 0 };
    if (text.includes("UPDATE public.citas_holds")) return { rows: [], rowCount: 0 };
    if (text.includes("UPDATE public.payment_intents")) return { rows: [], rowCount: 0 };
    if (text.includes("UPDATE public.citas c") && text.includes("no_show")) return { rows: [], rowCount: 0 };
    if (text.includes("agenda_min_servicio_vendible_min")) return { rows: [{ agenda_min_servicio_vendible_min: 10 }] };
    if (text.includes("agenda_buffer_global_min")) return { rows: [{ agenda_buffer_global_min: 0 }] };
    if (text.includes("FROM public.sucursales") && text.includes("ORDER BY nombre_sucursal ASC")) {
      return { rows: [{ id_sucursal: BRANCH_A, nombre_sucursal: "Sucursal QA" }] };
    }
    if (text.includes("FROM public.sucursales") && text.includes("WHERE id_sucursal = $1::uuid")) {
      return { rows: params[0] === BRANCH_A ? [{ id_sucursal: BRANCH_A, nombre_sucursal: "Sucursal QA" }] : [] };
    }
    if (text.includes("FROM public.tipos_bloqueo_agenda") && text.includes("ANY($1::text[])")) {
      return { rows: [{ tipo_bloqueo_codigo: "dia_inhabilitado" }] };
    }
    if (text.includes("FROM public.modos_excepcion_sucursal")) {
      return { rows: params[0] === "cierre_total" ? [{ modo_excepcion_codigo: "cierre_total" }] : [] };
    }
    if (text.includes("INSERT INTO public.agenda_excepciones_sucursal (")) {
      const [id_sucursal, fecha, modo_excepcion_codigo, motivo, creado_por] = params;
      const id_excepcion_sucursal = `77777777-7777-4777-8777-${String(store.nextException++).padStart(12, "0")}`;
      store.exceptions.push({ id_excepcion_sucursal, id_sucursal, fecha, modo_excepcion_codigo, motivo,
        creado_por, nombre_sucursal: "Sucursal QA", bloques: [] });
      return { rows: [{ id_excepcion_sucursal }], rowCount: 1 };
    }
    if (text.includes("DELETE FROM public.agenda_excepciones_sucursal")) {
      const before = store.exceptions.length;
      store.exceptions = store.exceptions.filter((item) => item.id_excepcion_sucursal !== params[0]);
      return { rows: [], rowCount: before - store.exceptions.length };
    }
    if (text.includes("FROM public.agenda_excepciones_sucursal")) {
      // AM: Modela por separado duplicados, listado administrativo y disponibilidad real.
      const rows = store.exceptions.filter((item) => {
        if (Array.isArray(params[0])) {
          if (!params[0].includes(item.id_sucursal)) return false;
          const offset = text.includes("e.id_sucursal = $2::uuid") ? 2 : 1;
          if (offset === 2 && item.id_sucursal !== params[1]) return false;
          return !text.includes("e.fecha BETWEEN") || (item.fecha >= params[offset] && item.fecha <= params[offset + 1]);
        }
        return item.id_sucursal === params[0] && item.fecha === params[1]
          && (Array.isArray(params[2]) ? params[2].includes(item.modo_excepcion_codigo)
            : item.modo_excepcion_codigo === params[2] && (item.motivo || "") === (params[3] || ""));
      });
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM public.servicios s") && text.includes("active_tariffs")) {
      return {
        rows: [{
          id_servicio: SERVICE_A,
          id_tarifa: TARIFF_A,
          nombre_servicio: "Corte",
          duracion_min: 30,
          buffer_min: 0,
          precio_hnl: 100,
          incluye_isv: false,
          isv_porcentaje: 0,
        }],
      };
    }
    if (text.includes("horarios_semanales_sucursales_bloques")) {
      return { rows: [{ hora_inicio: "08:00:00", hora_fin: "12:00:00", almuerzo_inicio: null, almuerzo_fin: null }] };
    }
    if (text.includes("horarios_semanales_sucursales") && text.includes("SELECT 1")) {
      return { rows: [] };
    }
    if (text.includes("horarios_semanales_empleados") && text.includes("SELECT")) {
      return { rows: [{ hora_inicio: "08:00:00", hora_fin: "12:00:00", almuerzo_inicio: null, almuerzo_fin: null }] };
    }
    if (compact.includes("FROM public.horarios_semanales_sucursales hss")) {
      return { rows: [] };
    }
    if (text.includes("FROM public.empleados e") && text.includes("e.id_sucursal = $1::uuid")) {
      return { rows: barbers.filter((barber) => barber.id_sucursal === params[0]) };
    }
    if (text.includes("FROM public.empleados e") && text.includes("WHERE e.id_empleado = $1::uuid")) {
      return { rows: barbers.filter((barber) => barber.id_empleado === params[0]) };
    }
    if (text.includes("FROM public.bloqueos_agenda") || text.includes("FROM public.agenda_bloqueos_empleados")) {
      return { rows: [] };
    }
    if (text.includes("FROM public.citas")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }

  return {
    store,
    db: {
      query,
      async connect() {
        return {
          query,
          release() {},
        };
      },
    },
  };
}

async function createApp(db) {
  const app = Fastify({ logger: false });
  app.decorate("config", { bookingIsvEnabled: false });
  app.decorate("db", db);
  app.decorate("requireRoles", () => async (request) => {
    request.claims = {
      roles: ["super_admin"],
      user: { id_usuario: USER_A },
    };
  });
  await app.register(adminCitasRoutes, { prefix: "/v1/admin/citas" });
  await app.register(publicAgendaRoutes, { prefix: "/v1/public/agenda" });
  return app;
}

test("buildOperationalDayRange usa el dia operativo de America/Tegucigalpa aun con TZ=UTC", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const range = buildOperationalDayRange("2026-07-08");
    assert.equal(range.fecha, "2026-07-08");
    assert.equal(range.startAt.toISOString(), "2026-07-08T06:00:00.000Z");
    assert.equal(range.endAtExclusive.toISOString(), "2026-07-09T06:00:00.000Z");
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("cierre total crea una excepcion de sucursal, bloquea disponibilidad/horarios y restaura al eliminar", async () => {
  const { db, store } = createStore();
  const app = await createApp(db);
  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/citas/dias-inhabilitados",
      payload: { id_sucursal: BRANCH_A, fecha: "2026-07-15", modo_excepcion_codigo: "cierre_total", motivo: "Feriado" },
    });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(store.exceptions.length, 1);
    assert.deepEqual(store.exceptions[0], {
      id_excepcion_sucursal: "77777777-7777-4777-8777-000000000001", id_sucursal: BRANCH_A,
      fecha: "2026-07-15", modo_excepcion_codigo: "cierre_total", motivo: "Feriado", creado_por: USER_A,
      nombre_sucursal: "Sucursal QA", bloques: [],
    });
    const created = createResponse.json().data;
    assert.equal(created.dia_inhabilitado.id_excepcion_sucursal, store.exceptions[0].id_excepcion_sucursal);
    assert.equal(created.dias_inhabilitados.length, 1);

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/admin/citas/dias-inhabilitados?scope=sucursal&id_sucursal=${BRANCH_A}`,
    });
    assert.equal(listResponse.statusCode, 200);
    const grouped = listResponse.json().data.dias_inhabilitados;
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].fecha, "2026-07-15");
    assert.equal(grouped[0].id_excepcion_sucursal, store.exceptions[0].id_excepcion_sucursal);
    assert.equal(grouped[0].modo_excepcion_codigo, "cierre_total");
    assert.equal(grouped[0].origen, "agenda_excepciones_sucursal");
    assert.equal(grouped[0].es_dia_completo, true);
    assert.equal(grouped[0].total_barberos, null);

    const availabilityBlocked = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/disponibilidad?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha_desde=2026-07-15&fecha_hasta=2026-07-15`,
    });
    assert.equal(availabilityBlocked.statusCode, 200);
    assert.equal(availabilityBlocked.json().data.disponibilidad[0].disponible, false);
    assert.equal(availabilityBlocked.json().data.disponibilidad[0].barberos_disponibles, 0);

    const slotsBlocked = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha=2026-07-15&id_barbero=${BARBER_A}`,
    });
    assert.equal(slotsBlocked.statusCode, 200);
    assert.deepEqual(slotsBlocked.json().data.horarios, []);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/v1/admin/citas/dias-inhabilitados?id_excepcion_sucursal=${grouped[0].id_excepcion_sucursal}&scope=sucursal&id_sucursal=${BRANCH_A}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json().data.bloqueos_eliminados, 1);
    assert.equal(store.exceptions.length, 0);

    const availabilityAfterDelete = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/disponibilidad?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha_desde=2026-07-15&fecha_hasta=2026-07-15`,
    });
    assert.equal(availabilityAfterDelete.statusCode, 200);
    assert.equal(availabilityAfterDelete.json().data.disponibilidad[0].disponible, true);
    assert.equal(availabilityAfterDelete.json().data.disponibilidad[0].barberos_disponibles, 2);
    const slotsAfterDelete = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha=2026-07-15&id_barbero=${BARBER_A}`,
    });
    assert.equal(slotsAfterDelete.statusCode, 200);
    assert.ok(slotsAfterDelete.json().data.horarios.length > 0);
    assert.equal(store.calls.filter(({ sql }) => sql.includes("INSERT INTO public.agenda_excepciones_sucursal (")).length, 1);
    assert.ok(!store.calls.some(({ sql }) => /INSERT INTO public\.(bloqueos_agenda|agenda_bloqueos_empleados)/.test(sql)));
  } finally {
    await app.close();
  }
});

test("modo de excepcion inexistente es rechazado antes de insertar", async () => {
  const { db, store } = createStore();
  const app = await createApp(db);
  try {
    const response = await app.inject({ method: "POST", url: "/v1/admin/citas/dias-inhabilitados",
      payload: { id_sucursal: BRANCH_A, fecha: "2026-07-15", modo_excepcion_codigo: "modo_inexistente" } });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "ADMIN_CITAS_BRANCH_EXCEPTION_MODE_NOT_FOUND");
    assert.ok(store.calls.some(({ sql, params }) => sql.includes("FROM public.modos_excepcion_sucursal") && params[0] === "modo_inexistente"));
    assert.ok(store.calls.some(({ sql }) => sql === "ROLLBACK"));
    assert.ok(!store.calls.some(({ sql }) => /INSERT|DELETE/.test(sql)));
    assert.deepEqual(store.exceptions, []);
  } finally {
    await app.close();
  }
});
