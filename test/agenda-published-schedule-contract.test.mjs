import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicAgendaRoutes from "../src/routes/v1/public/agenda.js";
import { buildOperationalDayRange, getAvailableSlotsForBarber } from "../src/services/agendaService.js";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const BARBER = "33333333-3333-4333-8333-333333333333";
const SERVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const barber = { id_empleado: BARBER, id_sucursal: BRANCH, es_barbero: true, nombre_completo: "QA", nombres: "QA", apellidos: "Barber", nombre_sucursal: "QA", visible_en_landing: true, certificaciones_titulos: [] };

function fixture({ published = true, exception = null } = {}) {
  const calls = [];
  const morning = { hora_inicio: "08:00:00", hora_fin: "12:00:00", almuerzo_inicio: null, almuerzo_fin: null };
  async function query(sql, params = []) {
    const q = String(sql);
    calls.push({ q, params });
    if (q.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: BRANCH, nombre_sucursal: "QA", estado: true }] };
    if (q.includes("horarios_semanales_sucursales_bloques")) return { rows: published && params[1] !== 2 ? [morning] : [] };
    if (q.includes("horarios_semanales_sucursales") && q.includes("SELECT 1")) return { rows: published ? [{ exists: 1 }] : [] };
    if (q.includes("horarios_semanales_empleados")) return { rows: [{ ...morning, hora_fin: "20:00:00" }] };
    if (q.includes("agenda_excepciones_sucursal")) return { rows: exception ? [{ id_sucursal: BRANCH, fecha: params[1], modo_excepcion_codigo: exception, bloques: [{ hora_inicio: "13:00:00", hora_fin: "14:00:00" }] }] : [] };
    if (q.includes("FROM public.empleados e")) return { rows: [barber] };
    if (q.includes("FROM public.servicios s") && q.includes("active_tariffs")) return { rows: [{ id_servicio: SERVICE, id_tarifa: "55555555-5555-4555-8555-555555555555", nombre_servicio: "QA", duracion_min: 15, buffer_min: 0, precio_hnl: 5, incluye_isv: false, isv_porcentaje: 0 }] };
    if (q.includes("agenda_min_servicio_vendible_min")) return { rows: [{ agenda_min_servicio_vendible_min: 10 }] };
    if (q.includes("agenda_buffer_global_min")) return { rows: [{ agenda_buffer_global_min: 0 }] };
    return { rows: [], rowCount: 0 };
  }
  return { calls, db: { query, async connect() { return { query, release() {} }; } } };
}

test("ICU h24 midnight cannot move operational Tuesday to Monday", () => {
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function(locale, options) {
    return new Original(locale, { ...options, hour12: undefined, hourCycle: options.hourCycle || "h24" });
  };
  try {
    const range = buildOperationalDayRange("2026-10-13");
    assert.equal(range.startAt.toISOString(), "2026-10-13T06:00:00.000Z");
    assert.equal(range.endAtExclusive.toISOString(), "2026-10-14T06:00:00.000Z");
  } finally { Intl.DateTimeFormat = Original; }
});

test("published closed Tuesday: both public GETs stay closed despite employee legacy schedule", async () => {
  const { db, calls } = fixture();
  const app = Fastify({ logger: false });
  app.decorate("config", { bookingIsvEnabled: false });
  app.decorate("db", db);
  await app.register(publicAgendaRoutes, { prefix: "/v1/public/agenda" });
  const args = `id_sucursal=${BRANCH}&id_barbero=${BARBER}&selection_type=services&servicios=${SERVICE}`;
  try {
    const availability = await app.inject(`/v1/public/agenda/disponibilidad?${args}&fecha_desde=2026-10-13&fecha_hasta=2026-10-13`);
    assert.equal(availability.statusCode, 200);
    assert.equal(availability.json().data.disponibilidad[0].disponible, false);
    const slots = await app.inject(`/v1/public/agenda/horarios?${args}&fecha=2026-10-13`);
    assert.equal(slots.statusCode, 200);
    assert.deepEqual(slots.json().data.horarios, []);
    assert.ok(calls.filter(c => c.q.includes("sucursales_bloques")).every(c => c.params[1] === 2));
    assert.equal(calls.some(c => c.q.includes("horarios_semanales_empleados")), false);
  } finally { await app.close(); }
});

test("published Wednesday slots remain inside the canonical branch block, independent of host TZ", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const { db, calls } = fixture();
    const slots = await getAvailableSlotsForBarber(db, BARBER, "2030-10-16", 15);
    assert.ok(slots.length > 0);
    assert.ok(calls.filter(c => c.q.includes("sucursales_bloques")).every(c => c.params[1] === 3));
    for (const slot of slots) {
      // Canonical published-block containment in Honduras (UTC-06).
      assert.ok(new Date(slot.inicio_at) >= new Date("2030-10-16T08:00:00-06:00"));
      assert.ok(new Date(slot.fin_at) <= new Date("2030-10-16T12:00:00-06:00"));
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("no published schedule preserves employee legacy fallback", async () => {
  const { db, calls } = fixture({ published: false });
  assert.ok((await getAvailableSlotsForBarber(db, BARBER, "2030-10-15", 15)).length > 0);
  assert.ok(calls.some(c => c.q.includes("horarios_semanales_empleados")));
});

for (const exception of ["apertura_extra", "horario_especial"]) {
  test(`${exception} preserves explicit opening on published closed Tuesday`, async () => {
    const { db } = fixture({ exception });
    const slots = await getAvailableSlotsForBarber(db, BARBER, "2030-10-15", 15);
    assert.ok(slots.length > 0);
    assert.ok(slots.every(s => new Date(s.inicio_at) >= new Date("2030-10-15T13:00:00-06:00") && new Date(s.fin_at) <= new Date("2030-10-15T14:00:00-06:00")));
  });
}
