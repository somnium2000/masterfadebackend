import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMembershipConsumptionEvidence,
  finalizeReservationIdempotency,
  getReservationIdempotencyState,
  loadMembershipConsumptionEvidence,
} from "../src/services/bookingCanonicalReservationService.js";
import { buildAppointmentDetailRows } from "../src/services/bookingReservationService.js";
import { confirmAdminBookingHold } from "../src/services/booking/adminBookingService.js";

const SUB = "11111111-1111-4111-8111-111111111111";
const CITA = "22222222-2222-4222-8222-222222222222";
const SECOND_CITA = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
const SECOND_SERVICE = "55555555-5555-4555-8555-555555555555";
const THIRD_SERVICE = "66666666-6666-4666-8666-666666666666";

function fixture(items, statuses, { order = 1, origin = "servicio_manual" } = {}) {
  return {
    orden_integrante: order,
    selection: { serviceSelection: { items } },
    detailRows: buildAppointmentDetailRows(items, { ordenIntegrante: order, origenItemCodigo: origin, bookingIsvEnabled: false }),
    _coverage: { items: items.map((item, index) => ({
      id_servicio: item.id_servicio, cantidad: 1, coverage_status: statuses[index],
    })) },
  };
}

function evidence(integrantes, options = {}) {
  return buildMembershipConsumptionEvidence({
    idSuscripcion: SUB,
    integrantes,
    canonicalResult: { bloques: integrantes.map((item, index) => ({
      orden_integrante: item.orden_integrante, id_cita: index ? SECOND_CITA : CITA,
    })) },
    ...options,
  });
}

test("evidencia conserva las tres cuotas por servicio y sus lineas canonicas", () => {
  const items = [SERVICE, SECOND_SERVICE, THIRD_SERVICE].map(id_servicio => ({ id_servicio, precio_hnl: 100 }));
  const titular = fixture(items, items.map(() => "cubierto_plan"));
  const result = evidence([titular]);
  assert.deepEqual(result, {
    version: 1, id_suscripcion: SUB,
    citas: [{ id_cita: CITA, servicios: titular.detailRows.map(row => ({
      id_servicio: row.id_servicio, line_key: row.line_key, cantidad: 1,
    })) }],
  });
});

test("repeticiones agrupan solamente las unidades cubiertas y mantienen el extra del mismo servicio", () => {
  const items = Array.from({ length: 3 }, () => ({ id_servicio: SERVICE, precio_hnl: 100 }));
  const titular = fixture(items, ["cubierto_plan", "cubierto_plan", "extra_pendiente"]);
  const sourceBefore = structuredClone(titular);
  assert.deepEqual(evidence([titular]).citas[0].servicios, [{
    id_servicio: SERVICE, line_key: titular.detailRows[0].line_key, cantidad: 2,
  }]);
  assert.deepEqual(titular, sourceBefore);
});

test("tarifas y origen de paquete diferencian las lineas de un mismo servicio", () => {
  const items = [
    { id_servicio: SERVICE, id_tarifa: "tarifa-a", origen_item_codigo: "servicio_manual", precio_hnl: 100 },
    { id_servicio: SERVICE, id_tarifa: "tarifa-b", origen_item_codigo: "paquete", precio_hnl: 100 },
  ];
  const titular = fixture(items, ["extra_pendiente", "cubierto_plan"]);
  assert.deepEqual(evidence([titular]).citas[0].servicios, [{
    id_servicio: SERVICE, line_key: titular.detailRows[1].line_key, cantidad: 1,
  }]);
});

test("sin cobertura registra evidencia vacia y no atribuye beneficios a acompanantes", () => {
  const items = [{ id_servicio: SERVICE, precio_hnl: 100 }];
  const result = evidence([
    fixture(items, ["extra_pendiente"]),
    fixture(items, ["cubierto_plan"], { order: 2 }),
  ], { idSuscripcion: null });
  assert.deepEqual(result, {
    version: 1, id_suscripcion: null,
    citas: [{ id_cita: CITA, servicios: [] }, { id_cita: SECOND_CITA, servicios: [] }],
  });
});

test("cobertura explicita conserva servicio de precio cero sin inferir desde descuentos", () => {
  const titular = fixture([{ id_servicio: SERVICE, precio_hnl: 0 }], ["cubierto_plan"]);
  assert.equal(evidence([titular]).citas[0].servicios[0].cantidad, 1);
  titular._coverage.items[0].coverage_status = "cubierto_recompensa";
  titular.detailRows[0].descuento_hnl = 500;
  assert.deepEqual(evidence([titular]).citas[0].servicios, []);
});

test("origen administrativo usa exactamente su linea y la cobertura interna administrativa", () => {
  const titular = fixture([{ id_servicio: SERVICE, precio_hnl: 100 }], ["cubierto_plan"], { origin: "admin_servicio_manual" });
  titular._benefits = { coverage: titular._coverage };
  delete titular._coverage;
  assert.deepEqual(evidence([titular], { defaultOriginCode: "admin_servicio_manual" }).citas[0].servicios, [{
    id_servicio: SERVICE, line_key: titular.detailRows[0].line_key, cantidad: 1,
  }]);
});

test("productor vincula la cobertura a la clave real generada por el RPC", async () => {
  const titular = fixture([{ id_servicio: SERVICE, precio_hnl: 100 }], ["cubierto_plan"]);
  const actualKey = "clave-real-del-trigger-sin-paquete";
  let reads = 0;
  const db = { async query(sql, values) {
    reads++;
    assert.ok(sql.includes("FROM public.citas_detalles"));
    assert.deepEqual(values, [[CITA]]);
    return { rows: [{ id_cita: CITA, id_servicio: SERVICE, id_tarifa: null,
      origen_item_codigo: "servicio_manual", cantidad: 1, line_key: actualKey }] };
  } };
  const result = await loadMembershipConsumptionEvidence(db, { idSuscripcion: SUB, integrantes: [titular],
    canonicalResult: { bloques: [{ orden_integrante: 1, id_cita: CITA }] } });
  assert.deepEqual(result.citas[0].servicios, [{ id_servicio: SERVICE, line_key: actualKey, cantidad: 1 }]);
  assert.notEqual(result.citas[0].servicios[0].line_key, titular.detailRows[0].line_key);
  assert.equal(reads, 1);
});

test("claves reales separadas conservan la cuota total y la unidad extra del mismo grupo", () => {
  const items = Array.from({ length: 3 }, () => ({ id_servicio: SERVICE, precio_hnl: 100 }));
  const titular = fixture(items, ["cubierto_plan", "cubierto_plan", "extra_pendiente"]);
  const persistedDetails = ["paquete-real-a", "paquete-real-b", "extra-real-c"].map(line_key => ({
    id_cita: CITA, id_servicio: SERVICE, id_tarifa: null, origen_item_codigo: "servicio_manual", cantidad: 1, line_key,
  }));
  assert.deepEqual(evidence([titular], { persistedDetails }).citas[0].servicios, [
    { id_servicio: SERVICE, line_key: "paquete-real-a", cantidad: 1 },
    { id_servicio: SERVICE, line_key: "paquete-real-b", cantidad: 1 },
  ]);
  assert.throws(() => evidence([titular], { persistedDetails: persistedDetails.slice(0, 1) }),
    error => error.code === "MEMBERSHIP_CONSUMPTION_EVIDENCE_INVALID");
  assert.throws(() => evidence([titular], { persistedDetails: persistedDetails.map(row => ({ ...row, id_tarifa: "otra-tarifa" })) }),
    error => error.code === "MEMBERSHIP_CONSUMPTION_EVIDENCE_INVALID");
});

test("evidencia vacia no lee ni infiere cobertura de otras lineas", async () => {
  const titular = fixture([{ id_servicio: SERVICE, precio_hnl: 100 }], ["extra_pendiente"]);
  const db = { async query() { assert.fail("No debe consultar lineas sin unidades cubiertas"); } };
  assert.deepEqual(await loadMembershipConsumptionEvidence(db, { integrantes: [titular],
    canonicalResult: { bloques: [{ orden_integrante: 1, id_cita: CITA }] } }),
  { version: 1, id_suscripcion: null, citas: [{ id_cita: CITA, servicios: [] }] });
});

test("evidencia incompleta o con cantidad superior a la linea falla antes de persistir", () => {
  const titular = fixture([{ id_servicio: SERVICE, precio_hnl: 100 }], ["cubierto_plan"]);
  const isControlled = error => error.statusCode === 409 && error.code === "MEMBERSHIP_CONSUMPTION_EVIDENCE_INVALID";
  assert.throws(() => evidence([titular], { idSuscripcion: null }), isControlled);
  titular._coverage.items[0].cantidad = 2;
  assert.throws(() => evidence([titular]), isControlled);
  titular._coverage.items[0].cantidad = 1;
  titular._coverage.items[0].id_servicio = SECOND_SERVICE;
  assert.throws(() => evidence([titular]), isControlled);
});

test("metadata durable queda fuera de data y el replay HTTP conserva el contrato original", async () => {
  const data = { id_grupo_cita: "grupo-sintetico", total_pagar_hnl: 100 };
  const consumption = { version: 1, id_suscripcion: null, citas: [{ id_cita: CITA, servicios: [] }] };
  let stored;
  const db = { async query(sql, values) {
    if (sql.includes("finalizar_reserva_idempotente_v1")) {
      stored = values[3];
      return { rows: [] };
    }
    return { rows: [{ estado: { status: "completed", response_payload: stored } }] };
  } };
  const args = { requestId: CITA, scope: "auth:citas:hold", requestFingerprint: "sintetico" };
  await finalizeReservationIdempotency(db, { ...args, responsePayload: data, internalMetadata: { membership_consumption: consumption } });
  assert.deepEqual(stored, { status_code: 201, data, membership_consumption: consumption });
  assert.deepEqual(await getReservationIdempotencyState(db, args), { status: "completed", statusCode: 201, data });
  assert.equal(Object.hasOwn(data, "membership_consumption"), false);
  await finalizeReservationIdempotency(db, { ...args, responsePayload: data });
  assert.deepEqual(stored, { status_code: 201, data });
});

test("confirmacion administrativa no expone la evidencia interna del resumen durable", async () => {
  const group = "77777777-7777-4777-8777-777777777777";
  const visible = { cobertura: { fuente_cobertura_codigo: "membresia" } };
  const stored = { ...visible, membership_consumption: { version: 1, id_suscripcion: SUB, citas: [] } };
  const calls = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
      if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(text)) return { rows: [] };
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: SERVICE, nombre_sucursal: "Sucursal sintetica" }] };
      if (text.includes("FROM public.citas_grupos cg") && text.includes("FOR UPDATE")) return { rows: [{ id_grupo_cita: group, estado_grupo_codigo: "activo" }] };
      if (text.includes("BOOL_OR(c.estado_cita_codigo")) return { rows: [{ id_sucursal: SERVICE, id_cliente: SECOND_SERVICE,
        id_persona: THIRD_SERVICE, citas_count: 1, total_pagar_hnl: 0, has_confirmed: false, has_consumed_hold: false, has_active_hold: true }] };
      if (text.startsWith("SELECT id_cita")) return { rows: [{ id_cita: CITA }] };
      if (text.includes("FROM public.citas_admin_beneficios_resumen")) return { rows: [{ resumen_beneficios: stored,
        descuento_membresia_hnl: 100, total_pagar_hnl: 0, membresia_aplicada: true }] };
      if (text.startsWith("UPDATE public.citas") && text.includes("SET estado_cita_codigo = 'confirmada'")) return { rows: [{ id_cita: CITA, estado_cita_codigo: "confirmada" }] };
      if (/^(?:UPDATE public\.(?:citas_holds|citas_grupos|payment_intents)|INSERT INTO public\.(?:audit_logs|seguridad_audit_logs))/.test(text)) return { rows: [], rowCount: 1 };
      if (text.includes("promociones_usos")) return { rows: [] };
      if (text.includes("FROM public.citas_promociones")) return { rows: [] };
      assert.fail(`Consulta inesperada en fixture de confirmacion administrativa: ${text}`);
    },
  };
  const result = await confirmAdminBookingHold({ db: { connect: async () => client } }, {
    id: "evidencia-admin-sintetica", ip: "127.0.0.1", params: { idGrupoCita: group },
    body: { metodo_pago_codigo: "sin_pago" }, claims: { roles: ["super_admin"], user: { id_usuario: SECOND_CITA } },
  });
  assert.deepEqual(result.beneficios_resumen, visible);
  assert.equal(Object.hasOwn(result.beneficios_resumen, "membership_consumption"), false);
  assert.ok(stored.membership_consumption);
  assert.equal(calls.filter(call => call.sql === "COMMIT").length, 1);
});
