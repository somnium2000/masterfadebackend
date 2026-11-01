import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { startPostgres17 } from "./helpers/postgres17.mjs";

const RUN = process.env.RUN_PROMOS_B_PG_INTEGRATION === "true";

test("PostgreSQL 17: contrato PROMOS_b es aditivo, idempotente y protege holds/cupos", { skip: !RUN }, async () => {
  const isolated = await startPostgres17();
  const { client } = isolated;
  try {
    await client.query(`
      CREATE TABLE public.citas_holds (id_hold uuid PRIMARY KEY);
      CREATE TABLE public.citas_promociones (id_cita_promocion uuid PRIMARY KEY);
      CREATE TABLE public.promociones_usos (
        id_promocion_uso uuid PRIMARY KEY,
        estado_uso_codigo text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.promociones_reglas_agendamiento (
        id_promocion_regla uuid PRIMARY KEY,
        tipo_descuento_codigo text NOT NULL,
        activo boolean NOT NULL DEFAULT true
      );
    `);
    const migration = await readFile(new URL("../db/migrations/20261101192424_promos_b_hold_and_group_contract.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);

    const columns = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND (
          (table_name='citas_promociones' AND column_name IN ('id_hold','calculado_en_codigo'))
          OR (table_name='promociones_usos' AND column_name IN ('id_hold','reservado_expires_at','liberado_at','idempotency_key'))
          OR (table_name='promociones_reglas_agendamiento' AND column_name IN ('cantidad_requerida','cantidad_bonificada','bonificacion_modo_codigo','scope_evaluacion_codigo'))
        )
    `);
    assert.equal(columns.rowCount, 10);

    const hold = "11111111-1111-4111-8111-111111111111";
    await client.query("INSERT INTO public.citas_holds(id_hold) VALUES ($1)", [hold]);
    await client.query(
      "INSERT INTO public.citas_promociones(id_cita_promocion,id_hold,calculado_en_codigo) VALUES ($1,$2,'hold')",
      ["22222222-2222-4222-8222-222222222222", hold]
    );
    await assert.rejects(
      client.query(
        "INSERT INTO public.citas_promociones(id_cita_promocion,calculado_en_codigo) VALUES ($1,'caller')",
        ["33333333-3333-4333-8333-333333333333"]
      ),
      /ck_citas_promociones_calculado_en/
    );

    await client.query(
      "INSERT INTO public.promociones_usos(id_promocion_uso,estado_uso_codigo,id_hold,idempotency_key) VALUES ($1,'reservado',$2,'same-key')",
      ["44444444-4444-4444-8444-444444444444", hold]
    );
    await assert.rejects(
      client.query(
        "INSERT INTO public.promociones_usos(id_promocion_uso,estado_uso_codigo,idempotency_key) VALUES ($1,'reservado','same-key')",
        ["55555555-5555-4555-8555-555555555555"]
      ),
      /uq_promociones_usos_idempotency/
    );

    await client.query(
      `INSERT INTO public.promociones_reglas_agendamiento
       (id_promocion_regla,tipo_descuento_codigo,activo,cantidad_requerida,cantidad_bonificada,bonificacion_modo_codigo,scope_evaluacion_codigo)
       VALUES ($1,'bonificacion',true,2,1,'menor_precio','grupo_cita')`,
      ["66666666-6666-4666-8666-666666666666"]
    );
    await assert.rejects(
      client.query(
        `INSERT INTO public.promociones_reglas_agendamiento
         (id_promocion_regla,tipo_descuento_codigo,activo,cantidad_requerida,cantidad_bonificada,bonificacion_modo_codigo,scope_evaluacion_codigo)
         VALUES ($1,'bonificacion',true,1,1,'menor_precio','grupo_cita')`,
        ["77777777-7777-4777-8777-777777777777"]
      ),
      /ck_promociones_reglas_cantidades_2x1/
    );
  } finally {
    await isolated.stop();
  }
});
