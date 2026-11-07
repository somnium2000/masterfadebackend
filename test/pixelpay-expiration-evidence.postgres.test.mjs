import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { startPostgres17 } from "./helpers/postgres17.mjs";

const migrationUrl = new URL(
  "../db/migrations/pixel/20261106010000_pixelpay_uncertain_expiration_evidence.sql",
  import.meta.url
);

async function prepareSchema(client) {
  await client.query(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA app_private;
    CREATE EXTENSION btree_gist;

    CREATE TABLE public.payment_providers (
      id_provider uuid PRIMARY KEY,
      codigo text NOT NULL
    );
    CREATE TABLE public.citas_grupos (
      id_grupo_cita uuid PRIMARY KEY,
      id_cliente_titular uuid,
      id_usuario_titular uuid,
      id_persona_titular uuid,
      estado_grupo_codigo text NOT NULL
    );
    CREATE TABLE public.citas (
      id_cita uuid PRIMARY KEY,
      id_grupo_cita uuid REFERENCES public.citas_grupos(id_grupo_cita),
      id_empleado_barbero uuid NOT NULL,
      inicio_at timestamptz NOT NULL,
      fin_at timestamptz NOT NULL,
      estado_cita_codigo text NOT NULL,
      deleted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.citas ADD CONSTRAINT ex_cita_barbero_activa
      EXCLUDE USING gist (
        id_empleado_barbero WITH =,
        tstzrange(inicio_at, fin_at, '[)') WITH &&
      ) WHERE (deleted_at IS NULL AND estado_cita_codigo IN ('en_espera','pendiente_pago','confirmada'));
    CREATE TABLE public.citas_holds (
      id_hold uuid PRIMARY KEY,
      id_cita uuid NOT NULL REFERENCES public.citas(id_cita),
      estado_hold_codigo text NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.payment_intents (
      id_intent uuid PRIMARY KEY,
      id_provider uuid NOT NULL REFERENCES public.payment_providers(id_provider),
      id_cita uuid REFERENCES public.citas(id_cita),
      id_hold uuid REFERENCES public.citas_holds(id_hold),
      id_grupo_cita uuid,
      origen_pago_codigo text NOT NULL DEFAULT 'cita',
      estado_intent_codigo text NOT NULL,
      paid_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_private.pixelpay_sale_attempts (
      id_sale_attempt uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
      payment_attempt_id uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finalized_at timestamptz,
      outcome text,
      uncertain boolean
    );
    CREATE TABLE public.payments (
      id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
      provider_tx_id text NOT NULL UNIQUE,
      estado_pago_codigo text NOT NULL,
      paid_at timestamptz NOT NULL
    );
    CREATE TABLE public.citas_promociones (
      id_cita_promocion uuid PRIMARY KEY,
      id_grupo_cita uuid
    );
    CREATE TABLE public.promociones_usos (
      id_promocion_uso uuid PRIMARY KEY,
      id_cita_promocion uuid,
      estado_uso_codigo text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1()
    RETURNS integer LANGUAGE sql STABLE AS 'SELECT 5';
  `);
  await client.query(await readFile(migrationUrl, "utf8"));
}

async function seedReservation(client, {
  providerCode = "pixelpay",
  intentState = "pendiente_confirmacion",
  origin = "cita",
  saleAttempts = [],
  start = "2026-11-07T14:00:00.000Z",
} = {}) {
  const ids = {
    provider: crypto.randomUUID(),
    group: crypto.randomUUID(),
    client: crypto.randomUUID(),
    barber: crypto.randomUUID(),
    cita: crypto.randomUUID(),
    hold: crypto.randomUUID(),
    intent: crypto.randomUUID(),
  };
  const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
  await client.query("INSERT INTO payment_providers(id_provider,codigo) VALUES ($1,$2)", [ids.provider, providerCode]);
  await client.query(`INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,estado_grupo_codigo)
    VALUES ($1,$2,'activo')`, [ids.group, ids.client]);
  await client.query(`INSERT INTO citas(id_cita,id_grupo_cita,id_empleado_barbero,inicio_at,fin_at,estado_cita_codigo)
    VALUES ($1,$2,$3,$4,$5,'pendiente_pago')`, [ids.cita, ids.group, ids.barber, start, end]);
  await client.query(`INSERT INTO citas_holds(id_hold,id_cita,estado_hold_codigo,expires_at)
    VALUES ($1,$2,'activo',$3)`, [ids.hold, ids.cita, "2026-11-07T13:59:00.000Z"]);
  await client.query(`INSERT INTO payment_intents
    (id_intent,id_provider,id_cita,id_hold,id_grupo_cita,origen_pago_codigo,estado_intent_codigo)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ids.intent, ids.provider, ids.cita, ids.hold, ids.group, origin, intentState]);
  for (let index = 0; index < saleAttempts.length; index += 1) {
    const attempt = saleAttempts[index];
    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts
      (id_intent,payment_attempt_id,created_at,finalized_at,outcome,uncertain)
      VALUES ($1,$2,$3,$4,$5,$6)`, [
      ids.intent,
      crypto.randomUUID(),
      new Date(Date.parse("2026-11-07T13:50:00.000Z") + index * 1000).toISOString(),
      attempt.finalized === false ? null : "2026-11-07T13:50:30.000Z",
      attempt.outcome ?? null,
      attempt.uncertain ?? null,
    ]);
  }
  return { ...ids, start, end };
}

async function expireOwnerReservations(client, ids) {
  return (await client.query(
    "SELECT app_private.expirar_reservas_titular_v1($1,NULL,NULL,$2) result",
    [ids.client, "2026-11-07T14:01:00.000Z"],
  )).rows[0].result;
}

async function expireHold(client, ids) {
  await client.query("UPDATE citas_holds SET estado_hold_codigo='expirado' WHERE id_hold=$1", [ids.hold]);
  return (await client.query("SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1", [ids.intent])).rows[0].estado_intent_codigo;
}

test("PostgreSQL 17: expiracion protege solo evidencia durable PixelPay incierta", async (t) => {
  const isolated = await startPostgres17();
  try {
    await prepareSchema(isolated.client);

    await t.test("Sale incierta finalizada conserva el intent y libera el hold", async () => {
      const ids = await seedReservation(isolated.client, {
        saleAttempts: [{ outcome: "uncertain", uncertain: true }],
      });
      assert.equal(await expireHold(isolated.client, ids), "pendiente_confirmacion");
      assert.equal((await isolated.client.query("SELECT estado_hold_codigo FROM citas_holds WHERE id_hold=$1", [ids.hold])).rows[0].estado_hold_codigo, "expirado");
    });

    for (const [name, options] of [
      ["PixelPay sin intento Sale", {}],
      ["PixelPay con START no finalizado", { saleAttempts: [{ finalized: false }] }],
      ["PixelPay con resultado definitivo mas reciente", { saleAttempts: [
        { outcome: "uncertain", uncertain: true },
        { outcome: "request_error_definitive", uncertain: false },
      ] }],
      ["Mock pendiente", { providerCode: "mock" }],
      ["otro proveedor pendiente", { providerCode: "banpais" }],
      ["membresia PixelPay", { origin: "membership", saleAttempts: [{ outcome: "uncertain", uncertain: true }] }],
    ]) {
      await t.test(`${name} expira normalmente`, async () => {
        const ids = await seedReservation(isolated.client, options);
        assert.equal(await expireHold(isolated.client, ids), "expirado");
      });
    }
  } finally {
    await isolated.stop();
  }
});

test("PostgreSQL 17: RPC exacto de QA libera horario sin borrar evidencia incierta", async (t) => {
  const isolated = await startPostgres17();
  try {
    await prepareSchema(isolated.client);

    const uncertain = await seedReservation(isolated.client, {
      saleAttempts: [{ outcome: "uncertain", uncertain: true }],
    });
    const uncertainResult = await expireOwnerReservations(isolated.client, uncertain);
    assert.deepEqual(
      {
        holds: uncertainResult.holds_expirados,
        citas: uncertainResult.citas_expiradas,
        intents: uncertainResult.intents_expirados,
      },
      { holds: 1, citas: 1, intents: 0 },
    );
    const uncertainState = (await isolated.client.query(`SELECT pi.estado_intent_codigo,
      h.estado_hold_codigo,c.estado_cita_codigo FROM payment_intents pi
      JOIN citas_holds h ON h.id_hold=pi.id_hold JOIN citas c ON c.id_cita=pi.id_cita
      WHERE pi.id_intent=$1`, [uncertain.intent])).rows[0];
    assert.deepEqual(uncertainState, {
      estado_intent_codigo: "pendiente_confirmacion",
      estado_hold_codigo: "expirado",
      estado_cita_codigo: "expirada",
    });

    const replacement = crypto.randomUUID();
    await isolated.client.query(`INSERT INTO citas
      (id_cita,id_grupo_cita,id_empleado_barbero,inicio_at,fin_at,estado_cita_codigo)
      VALUES ($1,$2,$3,$4,$5,'confirmada')`, [
      replacement, uncertain.group, uncertain.barber, uncertain.start, uncertain.end,
    ]);
    assert.equal((await isolated.client.query("SELECT count(*)::int count FROM citas WHERE id_cita=$1", [replacement])).rows[0].count, 1);

    for (const [name, options, hourOffset] of [
      ["Mock", { providerCode: "mock" }, 1],
      ["otro proveedor", { providerCode: "banpais" }, 2],
      ["PixelPay definitivo", { saleAttempts: [{ outcome: "request_error_definitive", uncertain: false }] }, 3],
    ]) {
      await t.test(`${name} expira por el RPC`, async () => {
        const ids = await seedReservation(isolated.client, {
          ...options,
          start: new Date(Date.parse(uncertain.start) + hourOffset * 3_600_000).toISOString(),
        });
        const result = await expireOwnerReservations(isolated.client, ids);
        assert.equal(result.intents_expirados, 1);
        assert.equal((await isolated.client.query(
          "SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1",
          [ids.intent],
        )).rows[0].estado_intent_codigo, "expirado");
      });
    }
  } finally {
    await isolated.stop();
  }
});

test("PostgreSQL 17: aprobacion tardia es idempotente y no desplaza una reserva posterior", async () => {
  const isolated = await startPostgres17();
  try {
    await prepareSchema(isolated.client);
    const ids = await seedReservation(isolated.client, {
      saleAttempts: [{ outcome: "uncertain", uncertain: true }],
    });
    assert.equal(await expireHold(isolated.client, ids), "pendiente_confirmacion");
    await isolated.client.query("UPDATE citas SET estado_cita_codigo='expirada' WHERE id_cita=$1", [ids.cita]);

    const laterCita = crypto.randomUUID();
    const laterGroup = crypto.randomUUID();
    await isolated.client.query(`INSERT INTO citas_grupos(id_grupo_cita,id_cliente_titular,estado_grupo_codigo)
      VALUES ($1,$2,'activo')`, [laterGroup, crypto.randomUUID()]);
    await isolated.client.query(`INSERT INTO citas
      (id_cita,id_grupo_cita,id_empleado_barbero,inicio_at,fin_at,estado_cita_codigo)
      VALUES ($1,$2,$3,$4,$5,'confirmada')`, [laterCita, laterGroup, ids.barber, ids.start, ids.end]);

    await isolated.client.query("BEGIN");
    try {
      await isolated.client.query("UPDATE payment_intents SET estado_intent_codigo='confirmado',paid_at=$2 WHERE id_intent=$1", [ids.intent, "2026-11-07T13:58:00.000Z"]);
      await assert.rejects(
        isolated.client.query("UPDATE citas SET estado_cita_codigo='confirmada' WHERE id_cita=$1", [ids.cita]),
        (error) => error?.code === "23P01"
      );
    } finally {
      await isolated.client.query("ROLLBACK");
    }
    assert.equal((await isolated.client.query("SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1", [ids.intent])).rows[0].estado_intent_codigo, "pendiente_confirmacion");
    assert.equal((await isolated.client.query("SELECT estado_cita_codigo FROM citas WHERE id_cita=$1", [ids.cita])).rows[0].estado_cita_codigo, "expirada");

    const paidAt = "2026-11-07T13:58:00.000Z";
    await isolated.client.query(`INSERT INTO payments(id_intent,provider_tx_id,estado_pago_codigo,paid_at)
      VALUES ($1,'late-tx','capturado',$2) ON CONFLICT(provider_tx_id) DO NOTHING`, [ids.intent, paidAt]);
    await isolated.client.query(`INSERT INTO payments(id_intent,provider_tx_id,estado_pago_codigo,paid_at)
      VALUES ($1,'late-tx','capturado',$2) ON CONFLICT(provider_tx_id) DO NOTHING`, [ids.intent, paidAt]);
    const payment = (await isolated.client.query("SELECT count(*)::int count,min(paid_at)::text paid_at FROM payments WHERE id_intent=$1", [ids.intent])).rows[0];
    assert.equal(payment.count, 1);
    assert.equal(new Date(payment.paid_at).toISOString(), paidAt);
  } finally {
    await isolated.stop();
  }
});

test("PostgreSQL 17: expiracion y confirmacion concurrentes terminan en un estado reintentable", async () => {
  const isolated = await startPostgres17();
  const confirmation = new pg.Client(isolated.connectionOptions);
  const expiration = new pg.Client(isolated.connectionOptions);
  try {
    await prepareSchema(isolated.client);
    const ids = await seedReservation(isolated.client, {
      saleAttempts: [{ outcome: "uncertain", uncertain: true }],
    });
    await confirmation.connect();
    await expiration.connect();
    await confirmation.query("BEGIN");
    await expiration.query("BEGIN");
    await confirmation.query("SELECT 1 FROM payment_intents WHERE id_intent=$1 FOR UPDATE", [ids.intent]);
    await confirmation.query(
      "UPDATE payment_intents SET estado_intent_codigo='confirmado',paid_at=$2 WHERE id_intent=$1",
      [ids.intent, "2026-11-07T13:58:00.000Z"],
    );
    const expireHold = expiration.query("UPDATE citas_holds SET estado_hold_codigo='expirado' WHERE id_hold=$1", [ids.hold]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const confirmHold = confirmation.query("UPDATE citas_holds SET estado_hold_codigo='consumido' WHERE id_hold=$1", [ids.hold]);
    const outcomes = await Promise.allSettled([
      confirmHold.then(() => confirmation.query("COMMIT")),
      expireHold.then(() => expiration.query("COMMIT")),
    ]);
    assert.ok(outcomes.some((result) => result.status === "fulfilled"));
    for (const client of [confirmation, expiration]) {
      try { await client.query("ROLLBACK"); } catch { /* AM: una rama ya termino. */ }
    }

    const state = (await isolated.client.query(`SELECT pi.estado_intent_codigo,h.estado_hold_codigo
      FROM payment_intents pi JOIN citas_holds h ON h.id_hold=pi.id_hold WHERE pi.id_intent=$1`, [ids.intent])).rows[0];
    assert.ok([
      "pendiente_confirmacion:expirado",
      "confirmado:consumido",
    ].includes(`${state.estado_intent_codigo}:${state.estado_hold_codigo}`));

    await isolated.client.query("BEGIN");
    try {
      await isolated.client.query("SELECT 1 FROM citas_holds WHERE id_hold=$1 FOR UPDATE", [ids.hold]);
      await isolated.client.query("SELECT 1 FROM payment_intents WHERE id_intent=$1 FOR UPDATE", [ids.intent]);
      await isolated.client.query("UPDATE payment_intents SET estado_intent_codigo='confirmado',paid_at=$2 WHERE id_intent=$1", [ids.intent, "2026-11-07T13:58:00.000Z"]);
      await isolated.client.query("UPDATE citas_holds SET estado_hold_codigo='consumido' WHERE id_hold=$1", [ids.hold]);
      await isolated.client.query("COMMIT");
    } catch (error) {
      await isolated.client.query("ROLLBACK");
      throw error;
    }
    const finalState = (await isolated.client.query(`SELECT pi.estado_intent_codigo,h.estado_hold_codigo
      FROM payment_intents pi JOIN citas_holds h ON h.id_hold=pi.id_hold WHERE pi.id_intent=$1`, [ids.intent])).rows[0];
    assert.deepEqual(finalState, { estado_intent_codigo: "confirmado", estado_hold_codigo: "consumido" });
  } finally {
    await Promise.allSettled([confirmation.end(), expiration.end()]);
    await isolated.stop();
  }
});
