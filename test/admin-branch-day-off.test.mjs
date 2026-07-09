import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import adminCitasRoutes from "../src/routes/v1/admin/citas.js";
import publicAgendaRoutes from "../src/routes/v1/public/agenda.js";
import { buildOperationalDayRange, mapBlockRow } from "../src/services/agendaService.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const BARBER_B = "44444444-4444-4444-8444-444444444444";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARIFF_A = "55555555-5555-4555-8555-555555555555";
const USER_A = "66666666-6666-4666-8666-666666666666";

function createStore() {
  const store = {
    blocks: [],
    calls: [],
    nextBlock: 1,
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
    if (text.includes("FROM public.tipos_bloqueo_agenda") && text.includes("ANY($1::text[])")) {
      return { rows: [{ tipo_bloqueo_codigo: "dia_inhabilitado" }] };
    }
    if (text.includes("INSERT INTO public.bloqueos_agenda") && text.includes("SELECT")) {
      const [branchId, typeCode, startIso, endIso, motivo, createdBy] = params;
      const inserted = barbers
        .filter((barber) => barber.id_sucursal === branchId)
        .map((barber) => {
          const id = `77777777-7777-4777-8777-${String(store.nextBlock).padStart(12, "0")}`;
          store.nextBlock += 1;
          store.blocks.push({
            id_bloqueo: id,
            id_empleado: barber.id_empleado,
            id_sucursal: branchId,
            tipo_bloqueo_codigo: typeCode,
            motivo,
            inicio_at: startIso,
            fin_at: endIso,
            nombre_completo: barber.nombre_completo,
            nombre_sucursal: barber.nombre_sucursal,
            creado_por: createdBy,
          });
          return { id_bloqueo: id };
      });
      return { rows: inserted, rowCount: inserted.length };
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
    if (text.includes("DELETE FROM public.bloqueos_agenda") && text.includes("RETURNING id_bloqueo")) {
      const [branchId, typeCode, startIso, endIso, motivo] = params;
      const deleted = [];
      store.blocks = store.blocks.filter((block) => {
        const matches = block.id_sucursal === branchId
          && block.tipo_bloqueo_codigo === typeCode
          && block.inicio_at === startIso
          && block.fin_at === endIso
          && String(block.motivo || "") === String(motivo || "");
        if (matches) deleted.push({ id_bloqueo: block.id_bloqueo });
        return !matches;
      });
      return { rows: deleted, rowCount: deleted.length };
    }
    if (text.includes("FROM public.bloqueos_agenda b")) {
      return { rows: store.blocks };
    }
    if (text.includes("FROM public.bloqueos_agenda")) {
      const barberId = params[0];
      const rows = store.blocks
        .filter((block) => block.id_empleado === barberId)
        .map((block) => ({ inicio_at: block.inicio_at, fin_at: block.fin_at }));
      return { rows };
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

test("bloqueo por sucursal crea, agrupa, bloquea disponibilidad/horarios y elimina todos los barberos", async () => {
  const { db, store } = createStore();
  const app = await createApp(db);
  try {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/citas/dias-inhabilitados",
      payload: { id_sucursal: BRANCH_A, fecha: "2026-07-15", motivo: "Feriado" },
    });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(store.blocks.length, 2);
    assert.ok(store.blocks.every((block) => block.inicio_at === "2026-07-15T06:00:00.000Z"));
    assert.ok(store.blocks.every((block) => block.fin_at === "2026-07-16T06:00:00.000Z"));
    assert.equal(mapBlockRow(store.blocks[0]).fecha, "2026-07-15");
    assert.equal(mapBlockRow(store.blocks[0]).es_dia_completo, true);

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/admin/citas/dias-inhabilitados?scope=sucursal&id_sucursal=${BRANCH_A}`,
    });
    assert.equal(listResponse.statusCode, 200);
    const grouped = listResponse.json().data.dias_inhabilitados;
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].fecha, "2026-07-15");
    assert.equal(grouped[0].es_dia_completo, true);
    assert.equal(grouped[0].total_barberos, 2);

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
      url: `/v1/admin/citas/dias-inhabilitados?id_bloqueo=${grouped[0].id_bloqueo}&scope=sucursal&id_sucursal=${BRANCH_A}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json().data.bloqueos_eliminados, 2);
    assert.equal(store.blocks.length, 0);

    const availabilityAfterDelete = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/disponibilidad?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha_desde=2026-07-15&fecha_hasta=2026-07-15`,
    });
    assert.equal(availabilityAfterDelete.statusCode, 200);
    assert.equal(availabilityAfterDelete.json().data.disponibilidad[0].disponible, true);
    assert.equal(availabilityAfterDelete.json().data.disponibilidad[0].barberos_disponibles, 2);
  } finally {
    await app.close();
  }
});
