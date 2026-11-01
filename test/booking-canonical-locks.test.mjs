import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalReservationLockKeys } from "../src/services/bookingCanonicalReservationService.js";

const BARBER_A = "33333333-3333-4333-8333-333333333333";
const BARBER_B = "44444444-4444-4444-8444-444444444444";

function keys({ barber = BARBER_A, start, duration = 30, buffer = 5 }) {
  return buildCanonicalReservationLockKeys({ integrantes: [{ id_empleado_barbero: barber, inicio_at: start,
    detalles: [{ duracion_min: duration, buffer_min: buffer, cantidad: 1 }] }] });
}

test("intervalos solapados del mismo barbero comparten al menos un lock", () => {
  const first = new Set(keys({ start: "2027-01-04T14:00:00Z", duration: 30 }));
  const second = keys({ start: "2027-01-04T14:20:00Z", duration: 30 });
  assert.ok(second.some(key => first.has(key)));
});

test("horarios separados o barberos distintos no comparten locks", () => {
  const first = new Set(keys({ start: "2027-01-04T14:00:00Z", duration: 30, buffer: 0 }));
  assert.equal(keys({ start: "2027-01-04T14:30:00Z", duration: 30, buffer: 0 }).some(key => first.has(key)), false);
  assert.equal(keys({ barber: BARBER_B, start: "2027-01-04T14:00:00Z", duration: 30 }).some(key => first.has(key)), false);
});

test("la union de assignment_attempts se ordena y elimina duplicados", () => {
  const integrante = { id_empleado_barbero: BARBER_A, inicio_at: "2027-01-04T14:00:00Z",
    detalles: [{ duracion_min: 2, buffer_min: 0, cantidad: 1 }] };
  const result = buildCanonicalReservationLockKeys({ assignment_attempts: [
    { integrantes: [integrante] }, { integrantes: [integrante] },
  ] });
  assert.equal(result.length, 2);
  assert.deepEqual(result, result.toSorted());
});
