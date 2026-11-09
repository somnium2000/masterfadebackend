import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { insertPromotionUsage } from "../src/services/promociones/promocionesRepository.js";
import { startPostgres17 } from "./helpers/postgres17.mjs";

const RUN = process.env.RUN_PROMOS_B_PG_INTEGRATION === "true";

const GROUP = "10000000-0000-4000-8000-000000000001";
const APPLICATION_A = "20000000-0000-4000-8000-000000000001";
const APPLICATION_B = "20000000-0000-4000-8000-000000000002";
const RULE_A = "30000000-0000-4000-8000-000000000001";
const RULE_B = "30000000-0000-4000-8000-000000000002";
const RULE_C = "30000000-0000-4000-8000-000000000003";
const RULE_D = "30000000-0000-4000-8000-000000000004";
const APPLICATION_C = "20000000-0000-4000-8000-000000000003";
const APPLICATION_D = "20000000-0000-4000-8000-000000000004";
const REQUEST_ID = "booking-request-40000000-0000-4000-8000-000000000001";

test("PostgreSQL 17: un requestId admite dos promociones y conserva idempotencia por uso logico", { skip: !RUN }, async () => {
  const isolated = await startPostgres17();
  const { client, connectionOptions } = isolated;
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE public.citas_promociones (
        id_cita_promocion uuid PRIMARY KEY
      );
      CREATE TABLE public.promociones_usos (
        id_promocion_uso uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        id_cita_promocion uuid NOT NULL,
        id_promocion_regla uuid NOT NULL,
        id_grupo_cita uuid NOT NULL,
        id_cita uuid,
        id_cliente uuid,
        id_persona uuid,
        id_promocion_sucursal uuid,
        id_promocion_codigo uuid,
        id_empleado_barbero uuid,
        fecha_operativa date NOT NULL,
        estado_uso_codigo text NOT NULL,
        usado_at timestamptz,
        id_hold uuid,
        reservado_expires_at timestamptz,
        liberado_at timestamptz,
        idempotency_key text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_promociones_usos_idempotency
        ON public.promociones_usos (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    await client.query(
      "INSERT INTO public.citas_promociones(id_cita_promocion) VALUES ($1), ($2)",
      [APPLICATION_A, APPLICATION_B]
    );
    await client.query(
      "INSERT INTO public.citas_promociones(id_cita_promocion) VALUES ($1), ($2)",
      [APPLICATION_C, APPLICATION_D]
    );

    const usage = (idCitaPromocion, idPromocionRegla) => ({
      id_cita_promocion: idCitaPromocion,
      id_promocion_regla: idPromocionRegla,
      id_grupo_cita: GROUP,
      fecha_operativa: "2026-11-01",
      estado_uso_codigo: "reservado",
      idempotency_key: REQUEST_ID,
    });

    const firstA = await insertPromotionUsage(client, usage(APPLICATION_A, RULE_A));
    const firstB = await insertPromotionUsage(client, usage(APPLICATION_B, RULE_B));
    const retryA = await insertPromotionUsage(client, usage(APPLICATION_A, RULE_A));
    const retryB = await insertPromotionUsage(client, usage(APPLICATION_B, RULE_B));

    assert.equal(retryA, firstA);
    assert.equal(retryB, firstB);
    const rows = await client.query(`
      SELECT id_promocion_regla, idempotency_key
      FROM public.promociones_usos
      ORDER BY id_promocion_regla
    `);
    assert.equal(rows.rowCount, 2);
    assert.equal(new Set(rows.rows.map((row) => row.idempotency_key)).size, 2);
    assert.ok(rows.rows.every((row) => row.idempotency_key.startsWith(`${REQUEST_ID}:promotion-use:`)));

    const concurrentA = new pg.Client(connectionOptions);
    const concurrentB = new pg.Client(connectionOptions);
    await Promise.all([concurrentA.connect(), concurrentB.connect()]);
    try {
      const concurrentUsage = usage(APPLICATION_C, RULE_C);
      await concurrentA.query("BEGIN");
      const firstConcurrent = await insertPromotionUsage(concurrentA, concurrentUsage);
      await concurrentB.query("BEGIN");
      const retryPending = insertPromotionUsage(concurrentB, concurrentUsage);
      await concurrentA.query("COMMIT");
      const retryConcurrent = await retryPending;
      await concurrentB.query("COMMIT");
      assert.equal(retryConcurrent, firstConcurrent);
      assert.equal((await client.query(
        "SELECT count(*)::int AS count FROM public.promociones_usos WHERE id_promocion_regla = $1",
        [RULE_C]
      )).rows[0].count, 1);
    } finally {
      await Promise.allSettled([
        concurrentA.query("ROLLBACK").then(() => concurrentA.end()),
        concurrentB.query("ROLLBACK").then(() => concurrentB.end()),
      ]);
    }

    const historicalUsageId = "50000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO public.promociones_usos
       (id_promocion_uso,id_cita_promocion,id_promocion_regla,id_grupo_cita,fecha_operativa,estado_uso_codigo,idempotency_key)
       VALUES ($1,$2,$3,$4,'2026-11-01','reservado',$5)`,
      [historicalUsageId, APPLICATION_D, RULE_D, GROUP, REQUEST_ID]
    );
    assert.equal(await insertPromotionUsage(client, usage(APPLICATION_D, RULE_D)), historicalUsageId);
    assert.equal((await client.query(
      "SELECT idempotency_key FROM public.promociones_usos WHERE id_promocion_uso = $1",
      [historicalUsageId]
    )).rows[0].idempotency_key, REQUEST_ID);
  } finally {
    await isolated.stop();
  }
});
