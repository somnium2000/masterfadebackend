import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startBookingDeadlockPostgres17 } from "./support/bookingDeadlockPostgres17.mjs";
import { createCanonicalReservation } from "../src/services/bookingCanonicalReservationService.js";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const BARBER = "33333333-3333-4333-8333-333333333333";
const SECOND_BARBER = "34343434-3434-4434-8434-343434343434";
const SERVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RATE = "44444444-4444-4444-8444-444444444444";
const SECOND_RATE = "45454545-4545-4545-8545-454545454545";

function payload(requestId, personId, start, { barber = BARBER, rate = RATE, duration = 30, buffer = 5 } = {}) {
  const integrante = { orden_integrante: 1, id_persona: personId,
      tipo_cliente_codigo: "invitado", alias: "Sintetico", id_empleado_barbero: barber, selection_type: "services",
      inicio_at: start, detalles: [{ id_servicio: SERVICE, id_tarifa: rate, cantidad: 1, duracion_min: duration,
        buffer_min: buffer, nombre_servicio_snapshot: "Corte fixture", precio_referencia_hnl: 300,
        precio_unitario_hnl: 300, descuento_hnl: 0, incluye_isv_snapshot: false, isv_porcentaje: 0,
        origen_item_codigo: "servicio_manual" }] };
  return {
    request_id: requestId, id_sucursal: BRANCH, id_persona_titular: personId,
    origen_codigo: "publico", integrantes: [integrante], assignment_attempts: [{ integrantes: [integrante] }],
  };
}

function slot(index) {
  const businessDay = Math.floor(index / 8);
  const week = Math.floor(businessDay / 6);
  const weekday = businessDay % 6;
  const day = 4 + (week * 7) + weekday;
  const minutes = (index % 8) * 60;
  return new Date(Date.UTC(2027, 0, day, 14 + Math.floor(minutes / 60), minutes % 60)).toISOString();
}

function personId(index, contender) {
  return `50000000-0000-4000-8000-${String(index * 2 + contender).padStart(12, "0")}`;
}

async function reserve(pool, value) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createCanonicalReservation(client, value);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function insertPeople(pool, ids) {
  for (const id of ids) {
    await pool.query(
      "INSERT INTO public.personas(id_persona,nombres,apellidos) VALUES ($1,'Sintetico','Prueba') ON CONFLICT DO NOTHING",
      [id]
    );
  }
}

async function releaseGroup(pool, groupId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.citas SET estado_cita_codigo = 'cancelada', updated_at = now()
        WHERE id_grupo_cita = $1 AND deleted_at IS NULL
          AND estado_cita_codigo = ANY(ARRAY['en_espera','pendiente_pago']::text[])`,
      [groupId]
    );
    await client.query(
      `UPDATE public.citas_holds h SET estado_hold_codigo = 'expirado', updated_at = now()
         FROM public.citas c WHERE c.id_grupo_cita = $1 AND c.id_cita = h.id_cita
          AND c.deleted_at IS NULL AND h.estado_hold_codigo = 'activo'`,
      [groupId]
    );
    await client.query(
      "UPDATE public.citas_grupos SET estado_grupo_codigo = 'cancelado', updated_at = now() WHERE id_grupo_cita = $1",
      [groupId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test("PostgreSQL 17: serializa 200 carreras de doble reserva canonica", async t => {
  const database = await startBookingDeadlockPostgres17();
  t.after(database.stop);
  for (const file of [
    "test/sql/microfase2a2/ci_cron_bootstrap.sql", "test/sql/microfase2a2/pre_2a2_schema.sql",
    "test/sql/microfase2a2/pre_2a2_fixture.sql", "db/migrations/20260701_microfase_2a2_reconciliacion_transaccional.sql",
    "db/migrations/20260701_microfase_2a3_guardia_snapshot_fiscal.sql", "db/migrations/20260701_microfase_2a4_promociones_trazabilidad_cupos.sql",
    "db/migrations/20260701_fase_1_rpc_reserva_atomica_holds.sql", "db/migrations/20260702_fase_1b_reserva_canonica_hardening.sql",
    "db/migrations/20260702_fase_1b1_cierre_reserva_canonica.sql",
  ]) await database.sqlFile(file);

  const races = Number(process.env.MASTERFADE_BOOKING_RACES || 200);
  const errors = [];
  for (let index = 0; index < races; index += 1) {
    const start = slot(index);
    const people = [personId(index, 1), personId(index, 2)];
    await database.pool.query("INSERT INTO public.personas(id_persona,nombres,apellidos) VALUES ($1,'Sintetico','Uno'),($2,'Sintetico','Dos')", people);
    const contenders = [payload(randomUUID(), people[0], start), payload(randomUUID(), people[1], start)];
    const results = await Promise.allSettled(contenders.map(value => reserve(database.pool, value)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    errors.push(...results.filter(result => result.status === "rejected").map(result => result.reason));
  }
  const deadlocks = errors.filter(error => error.code === "40P01");
  const exclusions = errors.filter(error => error.code === "P0001" && /MF_SLOT_TAKEN/.test(error.message));
  const log = await database.readLog();
  assert.equal(exclusions.length + deadlocks.length, races,
    JSON.stringify(errors.slice(0, 10).map(error => ({ code: error.code, message: error.message }))));
  assert.equal(deadlocks.length, 0);
  assert.doesNotMatch(log, /deadlock detected/i);

  const baseIndex = races + 10;
  const scenarioPeople = Array.from({ length: 12 }, (_, index) => personId(baseIndex + index, 1));
  await insertPeople(database.pool, scenarioPeople);
  await database.pool.query(
    `INSERT INTO public.servicios_tarifas
      (id_tarifa,id_servicio,id_sucursal,id_empleado,precio_hnl,incluye_isv,isv_porcentaje,duracion_min,buffer_min,vigente_desde,activo)
     VALUES ($1,$2,$3,$4,300,false,15,30,5,'2026-07-01',true)`,
    [SECOND_RATE, SERVICE, BRANCH, SECOND_BARBER]
  );

  const overlapStart = slot(baseIndex);
  const overlapLater = new Date(new Date(overlapStart).getTime() + 20 * 60_000).toISOString();
  const overlapResults = await Promise.allSettled([
    reserve(database.pool, payload(randomUUID(), scenarioPeople[0], overlapStart, { duration: 30, buffer: 5 })),
    reserve(database.pool, payload(randomUUID(), scenarioPeople[1], overlapLater, { duration: 30, buffer: 5 })),
  ]);
  assert.equal(overlapResults.filter(result => result.status === "fulfilled").length, 1, "horarios solapados");

  const distinctStart = slot(baseIndex + 8);
  const distinctLater = new Date(new Date(distinctStart).getTime() + 40 * 60_000).toISOString();
  const distinctResults = await Promise.allSettled([
    reserve(database.pool, payload(randomUUID(), scenarioPeople[2], distinctStart, { duration: 30, buffer: 5 })),
    reserve(database.pool, payload(randomUUID(), scenarioPeople[3], distinctLater, { duration: 30, buffer: 5 })),
  ]);
  assert.equal(distinctResults.filter(result => result.status === "fulfilled").length, 2, "horarios distintos");

  const barberStart = slot(baseIndex + 16);
  const barberResults = await Promise.allSettled([
    reserve(database.pool, payload(randomUUID(), scenarioPeople[4], barberStart)),
    reserve(database.pool, payload(randomUUID(), scenarioPeople[5], barberStart, { barber: SECOND_BARBER, rate: SECOND_RATE })),
  ]);
  assert.equal(
    barberResults.filter(result => result.status === "fulfilled").length,
    2,
    `barberos distintos: ${JSON.stringify(barberResults.map(result => result.status === "rejected"
      ? { code: result.reason?.code, message: result.reason?.message }
      : { id_grupo_cita: result.value?.id_grupo_cita }))}`
  );

  const idempotencyStart = slot(baseIndex + 24);
  const idempotentPayload = payload(randomUUID(), scenarioPeople[6], idempotencyStart);
  const idempotentResults = await Promise.all([
    reserve(database.pool, idempotentPayload),
    reserve(database.pool, idempotentPayload),
  ]);
  assert.equal(idempotentResults[0].id_grupo_cita, idempotentResults[1].id_grupo_cita);
  assert.equal((await database.pool.query(
    "SELECT count(*)::int AS count FROM public.citas_grupos WHERE id_grupo_cita = $1",
    [idempotentResults[0].id_grupo_cita]
  )).rows[0].count, 1);

  const releaseStart = slot(baseIndex + 32);
  const held = await reserve(database.pool, payload(randomUUID(), scenarioPeople[7], releaseStart));
  const releaseRace = await Promise.allSettled([
    releaseGroup(database.pool, held.id_grupo_cita),
    reserve(database.pool, payload(randomUUID(), scenarioPeople[8], releaseStart)),
  ]);
  assert.equal(releaseRace[0].status, "fulfilled", "liberacion concurrente");
  const activeAtReleasedSlot = await database.pool.query(
    `SELECT count(*)::int AS count FROM public.citas
      WHERE id_empleado_barbero = $1 AND tstzrange(inicio_at, fin_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        AND deleted_at IS NULL AND estado_cita_codigo IN ('en_espera','pendiente_pago','confirmada','en_salon','en_atencion')`,
    [BARBER, releaseStart, new Date(new Date(releaseStart).getTime() + 35 * 60_000).toISOString()]
  );
  assert.ok(activeAtReleasedSlot.rows[0].count <= 1, "liberacion no deja solapamientos activos");

  const beforeFailure = await database.pool.query(
    "SELECT (SELECT count(*) FROM public.citas_grupos)::int AS groups, (SELECT count(*) FROM public.citas)::int AS appointments"
  );
  await database.pool.query(`
    CREATE FUNCTION public.mf_test_fail_booking() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'MF_TEST_INDUCED_FAILURE'; END $$;
    CREATE TRIGGER mf_test_fail_booking AFTER INSERT ON public.citas
      FOR EACH ROW EXECUTE FUNCTION public.mf_test_fail_booking();
  `);
  await assert.rejects(
    reserve(database.pool, payload(randomUUID(), scenarioPeople[9], slot(baseIndex + 40))),
    /MF_TEST_INDUCED_FAILURE/
  );
  await database.pool.query("DROP TRIGGER mf_test_fail_booking ON public.citas; DROP FUNCTION public.mf_test_fail_booking() ");
  const afterFailure = await database.pool.query(
    "SELECT (SELECT count(*) FROM public.citas_grupos)::int AS groups, (SELECT count(*) FROM public.citas)::int AS appointments"
  );
  assert.deepEqual(afterFailure.rows[0], beforeFailure.rows[0], "rollback sin persistencia parcial");

  const overlapAudit = await database.pool.query(`
    SELECT count(*)::int AS count FROM public.citas a JOIN public.citas b
      ON a.id_cita < b.id_cita AND a.id_empleado_barbero = b.id_empleado_barbero
     AND tstzrange(a.inicio_at, a.fin_at, '[)') && tstzrange(b.inicio_at, b.fin_at, '[)')
     AND a.deleted_at IS NULL AND b.deleted_at IS NULL
     AND a.estado_cita_codigo IN ('en_espera','pendiente_pago','confirmada','en_salon','en_atencion')
     AND b.estado_cita_codigo IN ('en_espera','pendiente_pago','confirmada','en_salon','en_atencion')
  `);
  assert.equal(overlapAudit.rows[0].count, 0, "cero solapamientos activos finales");
});
