import assert from "node:assert/strict";
import test from "node:test";
import {
  getServiceSelectionDetails,
  OCCUPIED_APPOINTMENT_STATES,
} from "../src/services/agendaService.js";
import {
  buildAppointmentDetailRows,
  calculateReservationTiming,
} from "../src/services/bookingReservationService.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const TARIFF_A = "44444444-4444-4444-8444-444444444444";
const TARIFF_B = "55555555-5555-4555-8555-555555555555";

function createTariffClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (String(sql).includes("parametros_sistema")) {
        return { rows: [{ agenda_buffer_global_min: 7 }] };
      }
      return { rows };
    },
  };
}

test("servicio simple persiste tarifa, snapshot, duracion y buffer de servicios_tarifas", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte premium",
    duracion_min: 35,
    buffer_min: 12,
    precio_hnl: "180.00",
  }]);

  const selection = await getServiceSelectionDetails(
    client,
    BRANCH_A,
    [SERVICE_A],
    null,
    "2026-07-15T09:00:00-06:00"
  );
  const detailRows = buildAppointmentDetailRows(selection.items);

  assert.equal(selection.items[0].id_tarifa, TARIFF_A);
  assert.equal(selection.items[0].precio_hnl, 180);
  assert.equal(selection.duracion_total_min, 35);
  assert.equal(selection.buffer_total_min, 12);
  assert.equal(detailRows[0].nombre_servicio_snapshot, "Corte premium");
  assert.equal(detailRows[0].precio_unitario_hnl, 180);
  assert.equal(detailRows[0].origen_item_codigo, "servicio_manual");
});

test("dos servicios suman duracion y aplican buffer una sola vez con MAX para calcular fin_at", () => {
  const selection = {
    startDateTime: new Date("2026-07-20T15:00:00.000Z"),
    serviceSelection: {
      duracion_total_min: 65,
      buffer_total_min: 15,
    },
  };

  const timing = calculateReservationTiming(selection);

  assert.equal(timing.duracion_total_min, 65);
  assert.equal(timing.buffer_total_min, 15);
  assert.equal(timing.fin_at, "2026-07-20T16:20:00.000Z");
});

test("tarifa futura usa la fecha operativa de la cita y no CURRENT_DATE", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte futuro",
    duracion_min: 40,
    buffer_min: 10,
    precio_hnl: "250.00",
  }]);

  await getServiceSelectionDetails(client, BRANCH_A, [SERVICE_A], null, "2026-12-20T10:00:00-06:00");
  const tariffCall = client.calls.find((call) => String(call.sql).includes("servicios_tarifas"));

  assert.equal(tariffCall.params[3], "2026-12-20");
  assert.ok(!String(tariffCall.sql).includes("CURRENT_DATE"));
});

test("tarifa especifica por barbero tiene precedencia sobre tarifa base", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_B,
    nombre_servicio: "Corte barbero",
    duracion_min: 45,
    buffer_min: 20,
    precio_hnl: "300.00",
  }]);

  const selection = await getServiceSelectionDetails(
    client,
    BRANCH_A,
    [SERVICE_A],
    BARBER_A,
    "2026-07-15T09:00:00-06:00"
  );
  const tariffCall = client.calls.find((call) => String(call.sql).includes("servicios_tarifas"));

  assert.equal(tariffCall.params[2], BARBER_A);
  assert.match(tariffCall.sql, /st\.id_empleado = \$3::uuid THEN 0/);
  assert.equal(selection.items[0].id_tarifa, TARIFF_B);
  assert.equal(selection.items[0].precio_hnl, 300);
});

test("no permite resolver tarifa de otra sucursal", async () => {
  const client = createTariffClient([]);

  await assert.rejects(
    () => getServiceSelectionDetails(client, BRANCH_B, [SERVICE_A], BARBER_A, "2026-07-15T09:00:00-06:00"),
    (error) => error?.code === "AGENDA_SERVICE_NOT_FOUND"
  );
  const tariffCall = client.calls.find((call) => String(call.sql).includes("servicios_tarifas"));
  assert.equal(tariffCall.params[0], BRANCH_B);
});

test("cambio posterior de tarifa no altera snapshots ya preparados para citas_detalles", () => {
  const sourceItem = {
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte original",
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: 120,
  };
  const rows = buildAppointmentDetailRows([sourceItem]);

  sourceItem.id_tarifa = TARIFF_B;
  sourceItem.nombre_servicio = "Corte actualizado";
  sourceItem.precio_hnl = 999;

  assert.equal(rows[0].id_tarifa, TARIFF_A);
  assert.equal(rows[0].nombre_servicio_snapshot, "Corte original");
  assert.equal(rows[0].precio_unitario_hnl, 120);
});

test("concurrencia cubre estados operativos que bloquean solapamiento", () => {
  assert.deepEqual(OCCUPIED_APPOINTMENT_STATES, [
    "en_espera",
    "pendiente_pago",
    "confirmada",
    "en_salon",
    "en_atencion",
  ]);
});

test("detalles consolidados persisten cantidad, descuento y total_linea completos", () => {
  const rows = buildAppointmentDetailRows([
    { id_servicio: SERVICE_A, id_tarifa: TARIFF_A, nombre_servicio: "Corte", duracion_min: 30, buffer_min: 5, precio_hnl: 100 },
    { id_servicio: SERVICE_A, id_tarifa: TARIFF_A, nombre_servicio: "Corte", duracion_min: 30, buffer_min: 5, precio_hnl: 100 },
    { id_servicio: SERVICE_B, id_tarifa: TARIFF_B, nombre_servicio: "Barba", duracion_min: 20, buffer_min: 10, precio_hnl: 50 },
  ], { descuentoTotalHnl: 25 });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].cantidad, 2);
  assert.equal(rows[0].subtotal_hnl, 200);
  assert.equal(rows.reduce((sum, row) => sum + row.descuento_hnl, 0), 25);
  assert.equal(rows.reduce((sum, row) => sum + row.total_linea_hnl, 0), 225);
});
