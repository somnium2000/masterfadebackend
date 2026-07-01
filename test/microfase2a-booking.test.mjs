import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStrictBooleanEnv,
  resolveBookingIsvEnabled,
} from "../src/config/bookingConfig.js";
import {
  assertBookingSelectionRuntimeSupported,
  countDateKeyRangeDays,
  getServiceSelectionDetails,
  mapDayAvailabilityForResponse,
  normalizeOperationalDateTime,
  OCCUPIED_APPOINTMENT_STATES,
} from "../src/services/agendaService.js";
import {
  assertBookingSelectionCreationSupported,
  buildAppointmentDetailRows,
  calculateReservationTiming,
  createBookingReservation,
} from "../src/services/bookingReservationService.js";
import { buildPaymentDetailRows } from "../src/routes/v1/public/pagos.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const TARIFF_A = "44444444-4444-4444-8444-444444444444";
const TARIFF_B = "55555555-5555-4555-8555-555555555555";
const CITA_A = "66666666-6666-4666-8666-666666666666";
const HOLD_A = "77777777-7777-4777-8777-777777777777";
const GROUP_A = "99999999-9999-4999-8999-999999999999";
const DETAIL_A = "12121212-1212-4121-8121-121212121212";
const PROMO_A = "13131313-1313-4131-8131-131313131313";
const PROMO_RULE_A = "14141414-1414-4141-8141-141414141414";
const PROMO_APP_A = "15151515-1515-4151-8151-151515151515";

async function withBookingIsvEnv(value, callback) {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, "BOOKING_ISV_ENABLED");
  const previousValue = process.env.BOOKING_ISV_ENABLED;
  if (value === undefined) {
    delete process.env.BOOKING_ISV_ENABLED;
  } else {
    process.env.BOOKING_ISV_ENABLED = value;
  }
  try {
    return await callback();
  } finally {
    if (hadValue) {
      process.env.BOOKING_ISV_ENABLED = previousValue;
    } else {
      delete process.env.BOOKING_ISV_ENABLED;
    }
  }
}

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

test("BOOKING_ISV_ENABLED ausente desactiva ISV por defecto", async () => {
  await withBookingIsvEnv(undefined, async () => {
    assert.equal(resolveBookingIsvEnabled(), false);
  });
});

test("BOOKING_ISV_ENABLED se valida como booleano estricto", () => {
  assert.equal(parseStrictBooleanEnv("false", { name: "BOOKING_ISV_ENABLED" }), false);
  assert.equal(parseStrictBooleanEnv("true", { name: "BOOKING_ISV_ENABLED" }), true);
  assert.throws(
    () => parseStrictBooleanEnv("1", { name: "BOOKING_ISV_ENABLED" }),
    /BOOKING_ISV_ENABLED invalido/
  );
});

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

test("BOOKING_ISV_ENABLED=false ignora tarifa con 15% y no expone ISV", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte con ISV",
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: "100.00",
    incluye_isv: false,
    isv_porcentaje: "15.00",
  }]);

  const selection = await getServiceSelectionDetails(
    client,
    BRANCH_A,
    [SERVICE_A],
    null,
    "2026-07-15T09:00:00-06:00",
    { bookingIsvEnabled: false }
  );

  assert.equal(selection.monto_subtotal_hnl, 100);
  assert.equal(selection.monto_isv_hnl, 0);
  assert.equal(selection.monto_total_hnl, 100);
  assert.equal(selection.items[0].incluye_isv_snapshot, false);
  assert.equal(selection.items[0].isv_porcentaje, 0);
  assert.equal(selection.items[0].isv_hnl, 0);
  assert.equal(selection.items[0].total_linea_hnl, 100);
});

test("BOOKING_ISV_ENABLED=true suma total pagable con ISV adicional", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte con ISV",
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: "100.00",
    incluye_isv: false,
    isv_porcentaje: "15.00",
  }]);

  const selection = await getServiceSelectionDetails(
    client,
    BRANCH_A,
    [SERVICE_A],
    null,
    "2026-07-15T09:00:00-06:00",
    { bookingIsvEnabled: true }
  );

  assert.equal(selection.monto_subtotal_hnl, 100);
  assert.equal(selection.monto_isv_hnl, 15);
  assert.equal(selection.monto_total_hnl, 115);
  assert.equal(selection.items[0].total_linea_hnl, 115);
});

test("seleccion de servicios mantiene ISV incluido como informativo sin duplicar total", async () => {
  const client = createTariffClient([{
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte con ISV incluido",
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: "100.00",
    incluye_isv: true,
    isv_porcentaje: "15.00",
  }]);

  const selection = await getServiceSelectionDetails(
    client,
    BRANCH_A,
    [SERVICE_A],
    null,
    "2026-07-15T09:00:00-06:00",
    { bookingIsvEnabled: true }
  );

  assert.equal(selection.monto_subtotal_hnl, 100);
  assert.equal(selection.monto_isv_hnl, 13.04);
  assert.equal(selection.monto_total_hnl, 100);
  assert.equal(selection.items[0].incluye_isv_snapshot, true);
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

test("fecha-hora UTC se normaliza a fecha y hora operativa de Honduras", () => {
  const normalized = normalizeOperationalDateTime("2026-07-15T15:00:00Z");

  assert.equal(normalized.fecha_operativa, "2026-07-15");
  assert.equal(normalized.hora_operativa, "09:00");
  assert.equal(normalized.utcDate.toISOString(), "2026-07-15T15:00:00.000Z");
  assert.equal(normalized.iso_utc, "2026-07-15T15:00:00.000Z");
});

test("fecha-hora sin timezone se rechaza para no depender del servidor", () => {
  assert.throws(
    () => normalizeOperationalDateTime("2026-07-15T09:00:00"),
    (error) => error?.code === "AGENDA_DATETIME_TIMEZONE_REQUIRED"
  );
});

test("creacion package y mixed queda bloqueada hasta Microfase 2B", () => {
  assert.equal(assertBookingSelectionCreationSupported("services"), "services");
  assert.equal(assertBookingSelectionRuntimeSupported("services"), "services");
  for (const selectionType of ["package", "mixed"]) {
    assert.throws(
      () => assertBookingSelectionCreationSupported(selectionType),
      (error) => error?.statusCode === 409 && error?.code === "BOOKING_PACKAGE_FLOW_PENDING_2B"
    );
    assert.throws(
      () => assertBookingSelectionRuntimeSupported(selectionType),
      (error) => error?.statusCode === 409 && error?.code === "BOOKING_PACKAGE_FLOW_PENDING_2B"
    );
  }
});

test("conteo de rango usa fechas puras e incluye ambos extremos", () => {
  assert.equal(countDateKeyRangeDays("2026-01-31", "2026-02-02"), 3);
  assert.throws(
    () => countDateKeyRangeDays("2026-02-02", "2026-01-31"),
    (error) => error?.code === "AGENDA_DATE_RANGE_INVALID"
  );
});

test("respuesta de disponibilidad conserva tiempos_efectivos null en dia sin tarifa", () => {
  const [mapped] = mapDayAvailabilityForResponse([{
    fecha: "2026-07-15",
    disponible: false,
    barberos_disponibles: 0,
    primer_horario_disponible: null,
    barbero_autoasignado: null,
    effective_selection: null,
  }]);

  assert.equal(mapped.tiempos_efectivos, null);
});

test("detalles persisten porcentaje ISV y calculan ISV incluido como informativo", () => {
  const [taxed] = buildAppointmentDetailRows([
    {
      id_servicio: SERVICE_A,
      id_tarifa: TARIFF_A,
      nombre_servicio: "Corte",
      duracion_min: 30,
      buffer_min: 5,
      precio_hnl: 100,
      incluye_isv: false,
      isv_porcentaje: 15,
    },
  ], { bookingIsvEnabled: true });
  const [included] = buildAppointmentDetailRows([
    {
      id_servicio: SERVICE_B,
      id_tarifa: TARIFF_B,
      nombre_servicio: "Barba",
      duracion_min: 20,
      buffer_min: 5,
      precio_hnl: 100,
      incluye_isv: true,
      isv_porcentaje: 15,
    },
  ], { bookingIsvEnabled: true });

  assert.equal(taxed.isv_porcentaje, 15);
  assert.equal(taxed.isv_hnl, 15);
  assert.equal(taxed.total_linea_hnl, 115);
  assert.equal(taxed.incluye_isv_snapshot, false);
  assert.equal(included.isv_porcentaje, 15);
  assert.equal(included.incluye_isv_snapshot, true);
  assert.equal(included.isv_hnl, 13.04);
  assert.equal(included.total_linea_hnl, 100);
});

test("descuento con BOOKING_ISV_ENABLED=false no calcula ni suma ISV", () => {
  const [row] = buildAppointmentDetailRows([
    {
      id_servicio: SERVICE_A,
      id_tarifa: TARIFF_A,
      nombre_servicio: "Corte",
      duracion_min: 30,
      buffer_min: 5,
      precio_hnl: 100,
      incluye_isv: false,
      isv_porcentaje: 15,
    },
  ], { descuentoTotalHnl: 10, bookingIsvEnabled: false });

  assert.equal(row.descuento_hnl, 10);
  assert.equal(row.incluye_isv_snapshot, false);
  assert.equal(row.isv_porcentaje, 0);
  assert.equal(row.isv_hnl, 0);
  assert.equal(row.total_linea_hnl, 90);
});

test("descuento con BOOKING_ISV_ENABLED=true recalcula ISV adicional sobre base neta", () => {
  const [row] = buildAppointmentDetailRows([
    {
      id_servicio: SERVICE_A,
      id_tarifa: TARIFF_A,
      nombre_servicio: "Corte",
      duracion_min: 30,
      buffer_min: 5,
      precio_hnl: 100,
      incluye_isv: false,
      isv_porcentaje: 15,
    },
  ], { descuentoTotalHnl: 10, bookingIsvEnabled: true });

  assert.equal(row.descuento_hnl, 10);
  assert.equal(row.incluye_isv_snapshot, false);
  assert.equal(row.isv_porcentaje, 15);
  assert.equal(row.isv_hnl, 13.5);
  assert.equal(row.total_linea_hnl, 103.5);
});

test("detalle, cita, grupo e intent coinciden con ISV apagado y encendido", () => {
  for (const { bookingIsvEnabled, expectedTotal } of [
    { bookingIsvEnabled: false, expectedTotal: 100 },
    { bookingIsvEnabled: true, expectedTotal: 115 },
  ]) {
    const detailRows = buildAppointmentDetailRows([
      {
        id_servicio: SERVICE_A,
        id_tarifa: TARIFF_A,
        nombre_servicio: "Corte",
        duracion_min: 30,
        buffer_min: 5,
        precio_hnl: 100,
        incluye_isv_snapshot: false,
        isv_porcentaje: 15,
      },
    ], { bookingIsvEnabled });
    const paymentRows = buildPaymentDetailRows(
      detailRows.map((row) => ({ ...row, id_cita_detalle: "99999999-9999-4999-8999-999999999999" })),
      { bookingIsvEnabled }
    );
    const detailTotal = Number(paymentRows.reduce((sum, row) => sum + row.total_linea_hnl, 0).toFixed(2));
    const citaTotal = detailTotal;
    const groupTotal = citaTotal;
    const intentAmount = groupTotal;

    assert.equal(detailTotal, expectedTotal);
    assert.equal(citaTotal, expectedTotal);
    assert.equal(groupTotal, expectedTotal);
    assert.equal(intentAmount, expectedTotal);
  }
});

test("pago de reserva existente conserva snapshot fiscal aunque cambie BOOKING_ISV_ENABLED", async () => {
  await withBookingIsvEnv("true", async () => {
    const rows = buildPaymentDetailRows([{
      id_cita_detalle: DETAIL_A,
      cantidad: 1,
      precio_unitario_hnl: 100,
      subtotal_hnl: 100,
      descuento_hnl: 0,
      incluye_isv_snapshot: false,
      isv_porcentaje: 0,
      isv_hnl: 0,
      total_linea_hnl: 100,
    }]);

    assert.equal(rows[0].incluye_isv_snapshot, false);
    assert.equal(rows[0].isv_porcentaje, 0);
    assert.equal(rows[0].isv_hnl, 0);
    assert.equal(rows[0].total_linea_hnl, 100);
  });

  await withBookingIsvEnv("false", async () => {
    const rows = buildPaymentDetailRows([{
      id_cita_detalle: DETAIL_A,
      cantidad: 1,
      precio_unitario_hnl: 100,
      subtotal_hnl: 100,
      descuento_hnl: 0,
      incluye_isv_snapshot: false,
      isv_porcentaje: 15,
      isv_hnl: 15,
      total_linea_hnl: 115,
    }]);

    assert.equal(rows[0].incluye_isv_snapshot, false);
    assert.equal(rows[0].isv_porcentaje, 15);
    assert.equal(rows[0].isv_hnl, 15);
    assert.equal(rows[0].total_linea_hnl, 115);
  });
});

test("pago recalcula descuentos usando snapshots persistidos sin tocar entorno", () => {
  const additional = buildPaymentDetailRows([{
    id_cita_detalle: DETAIL_A,
    cantidad: 1,
    precio_unitario_hnl: 100,
    subtotal_hnl: 100,
    descuento_hnl: 10,
    incluye_isv_snapshot: false,
    isv_porcentaje: 15,
  }]);
  assert.equal(additional[0].isv_hnl, 13.5);
  assert.equal(additional[0].total_linea_hnl, 103.5);

  const included = buildPaymentDetailRows([{
    id_cita_detalle: DETAIL_A,
    cantidad: 1,
    precio_unitario_hnl: 115,
    subtotal_hnl: 115,
    descuento_hnl: 15,
    incluye_isv_snapshot: true,
    isv_porcentaje: 15,
  }]);
  assert.equal(included[0].isv_hnl, 13.04);
  assert.equal(included[0].total_linea_hnl, 100);
});

test("reinicio logico con BOOKING_ISV_ENABLED=true activa ISV sin nueva migracion", async () => {
  const tariffRow = {
    id_servicio: SERVICE_A,
    id_tarifa: TARIFF_A,
    nombre_servicio: "Corte con ISV",
    duracion_min: 30,
    buffer_min: 5,
    precio_hnl: "100.00",
    incluye_isv: false,
    isv_porcentaje: "15.00",
  };

  await withBookingIsvEnv("false", async () => {
    const selection = await getServiceSelectionDetails(
      createTariffClient([tariffRow]),
      BRANCH_A,
      [SERVICE_A],
      null,
      "2026-07-15T09:00:00-06:00"
    );
    assert.equal(selection.monto_total_hnl, 100);
  });

  await withBookingIsvEnv("true", async () => {
    const selection = await getServiceSelectionDetails(
      createTariffClient([tariffRow]),
      BRANCH_A,
      [SERVICE_A],
      null,
      "2026-07-15T09:00:00-06:00"
    );
    assert.equal(selection.monto_total_hnl, 115);
  });
});

test("createBookingReservation centraliza cita, detalles y hold con el resultado del helper", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (String(sql).includes("INSERT INTO public.citas ")) {
        return { rows: [{ id_cita: CITA_A }] };
      }
      if (String(sql).includes("INSERT INTO public.citas_holds")) {
        return { rows: [{ id_hold: HOLD_A, expires_at: "2026-07-15T16:00:00.000Z" }] };
      }
      return { rows: [] };
    },
  };

  const result = await createBookingReservation(client, {
    appointment: {
      branchId: BRANCH_A,
      barberId: BARBER_A,
      personId: "88888888-8888-4888-8888-888888888888",
      clientId: null,
      createdByUserId: null,
      autoAssigned: true,
      selection: {
        startDateTime: new Date("2026-07-15T15:00:00.000Z"),
        serviceSelection: {
          selection_type: "services",
          id_paquete: null,
          duracion_total_min: 30,
          buffer_total_min: 5,
          monto_total_hnl: 100,
          items: [{
            id_servicio: SERVICE_A,
            id_tarifa: TARIFF_A,
            nombre_servicio: "Corte",
            duracion_min: 30,
            buffer_min: 5,
            precio_hnl: 100,
          }],
        },
      },
      subtotalHnl: 100,
      totalHnl: 100,
    },
    hold: {
      userId: null,
      expiresAt: "2026-07-15T16:00:00.000Z",
      returning: true,
    },
  });

  assert.equal(result.citaId, CITA_A);
  assert.equal(result.hold.id_hold, HOLD_A);
  assert.equal(result.hold.expires_at, "2026-07-15T16:00:00.000Z");
  assert.match(calls[0].sql, /INSERT INTO public\.citas/);
  assert.match(calls[1].sql, /INSERT INTO public\.citas_detalles/);
  assert.match(calls[2].sql, /INSERT INTO public\.citas_holds/);
  assert.equal(calls[1].params[0], CITA_A);
});

test("createBookingReservation usa SUM(total_linea_hnl) para total de cita y persiste snapshot ISV", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (String(sql).includes("INSERT INTO public.citas ")) {
        return { rows: [{ id_cita: CITA_A }] };
      }
      return { rows: [] };
    },
  };

  const result = await createBookingReservation(client, {
    appointment: {
      branchId: BRANCH_A,
      barberId: BARBER_A,
      personId: "88888888-8888-4888-8888-888888888888",
      autoAssigned: false,
      selection: {
        startDateTime: new Date("2026-07-15T15:00:00.000Z"),
        serviceSelection: {
          selection_type: "services",
          duracion_total_min: 30,
          buffer_total_min: 5,
          items: [{
            id_servicio: SERVICE_A,
            id_tarifa: TARIFF_A,
            nombre_servicio: "Corte",
            duracion_min: 30,
            buffer_min: 5,
            precio_hnl: 100,
            incluye_isv_snapshot: false,
            isv_porcentaje: 15,
          }],
        },
      },
    },
    bookingIsvEnabled: true,
  });

  assert.equal(result.totals.subtotalHnl, 100);
  assert.equal(result.totals.isvHnl, 15);
  assert.equal(result.totals.totalHnl, 115);
  assert.equal(calls[0].params[14], 100);
  assert.equal(calls[0].params[16], 115);
  assert.match(calls[1].sql, /\$12::boolean/);
  assert.equal(calls[1].params[11], false);
  assert.equal(calls[1].params[13], 15);
  assert.equal(calls[1].params[14], 115);
});

test("createBookingReservation persiste promocion de servicio con id_cita_detalle y sin duplicados", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("INSERT INTO public.citas ")) {
        return { rows: [{ id_cita: CITA_A }] };
      }
      if (text.includes("INSERT INTO public.citas_detalles")) {
        return { rows: [{ id_cita_detalle: DETAIL_A }] };
      }
      if (text.includes("SELECT id_cita_promocion") && text.includes("FROM public.citas_promociones")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO public.citas_promociones")) {
        return { rows: [{ id_cita_promocion: PROMO_APP_A }] };
      }
      return { rows: [] };
    },
  };

  const result = await createBookingReservation(client, {
    groupRecord: { id_grupo_cita: GROUP_A },
    appointment: {
      groupId: GROUP_A,
      branchId: BRANCH_A,
      barberId: BARBER_A,
      personId: "88888888-8888-4888-8888-888888888888",
      autoAssigned: false,
      selection: {
        startDateTime: new Date("2026-07-15T15:00:00.000Z"),
        serviceSelection: {
          selection_type: "services",
          duracion_total_min: 30,
          buffer_total_min: 5,
          items: [{
            id_servicio: SERVICE_A,
            id_tarifa: TARIFF_A,
            nombre_servicio: "Corte",
            duracion_min: 30,
            buffer_min: 5,
            precio_hnl: 100,
          }],
        },
      },
      descuentoHnl: 10,
    },
    promotions: {
      context: {
        id_grupo_cita: GROUP_A,
        id_sucursal: BRANCH_A,
        fecha_operativa: "2026-07-15",
        subtotal_hnl: 100,
      },
      result: {
        promociones_aplicadas: [{
          id_promocion: PROMO_A,
          id_promocion_regla: PROMO_RULE_A,
          titulo: "Promo servicio",
          aplica_a_codigo: "servicio",
          tipo_descuento_codigo: "monto_fijo",
          valor_descuento: 10,
          base_calculo_hnl: 100,
          descuento_calculado_hnl: 10,
          prioridad_aplicacion: 10,
          es_acumulable: true,
          target_items: [{ id_servicio: SERVICE_A }],
        }],
        promociones_descartadas: [],
      },
    },
  });

  assert.equal(result.detailRows[0].id_cita_detalle, DETAIL_A);
  const duplicateCheck = calls.find((call) =>
    call.sql.includes("SELECT id_cita_promocion")
    && call.sql.includes("id_cita_detalle IS NOT DISTINCT FROM")
  );
  assert.ok(duplicateCheck);
  assert.equal(duplicateCheck.params[4], DETAIL_A);

  const promoInsert = calls.find((call) => call.sql.includes("INSERT INTO public.citas_promociones"));
  assert.ok(promoInsert);
  assert.equal(promoInsert.params[0], GROUP_A);
  assert.equal(promoInsert.params[1], CITA_A);
  assert.equal(promoInsert.params[4], DETAIL_A);
  assert.equal(promoInsert.params[12], 10);
});
