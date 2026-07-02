import assert from "node:assert/strict";
import test from "node:test";
import {
  loadCanonicalPromotionDetailRows,
  mapCanonicalReservationError,
} from "../src/services/bookingCanonicalReservationService.js";
import { runDatabaseSchemaPreflight } from "../src/services/databaseSchemaPreflight.js";
import {
  AppError,
  DB_SCHEMA_OUTDATED_CODE,
  DB_SCHEMA_OUTDATED_MESSAGE,
  toDatabaseSchemaOutdatedError,
} from "../src/utils/errors.js";

function createPreflightPool({ omitColumn = "" } = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("pg_catalog.pg_proc")) {
        return {
          rows: [
            { schema_name: "app_private", function_name: "crear_reserva_canonica_v1", identity_args: "jsonb" },
            { schema_name: "app_private", function_name: "obtener_reserva_idempotente_v1", identity_args: "uuid, text, text" },
            { schema_name: "app_private", function_name: "finalizar_reserva_idempotente_v1", identity_args: "uuid, text, text, jsonb" },
            { schema_name: "app_private", function_name: "confirmar_reserva_pagada_v1", identity_args: "uuid, text, timestamp with time zone" },
          ],
        };
      }
      if (text.includes("information_schema.columns")) {
        const columns = [
          ["public", "citas", "id_grupo_cita"],
          ["public", "citas", "orden_integrante"],
          ["public", "citas", "contacto_nombre"],
          ["public", "citas", "contacto_email"],
          ["public", "citas", "contacto_telefono"],
          ["public", "citas", "total_pagar_hnl"],
          ["public", "citas_detalles", "line_key"],
          ["public", "citas_detalles", "id_cita_detalle"],
          ["public", "citas_promociones", "id_cita_integrante"],
          ["public", "citas_promociones", "id_promocion_codigo"],
          ["public", "citas_promociones", "id_promocion_sucursal"],
          ["public", "citas_promociones", "codigo_promocional_snapshot"],
          ["public", "citas_promociones", "line_key"],
          ["public", "payment_intents", "monto_hnl"],
          ["public", "payment_intents", "idempotency_key"],
          ["public", "notificaciones_email", "estado_notificacion_codigo"],
          ["public", "notificaciones_email", "evento"],
          ["public", "notificaciones_email", "id_cita"],
          ["app_private", "reserva_idempotencia", "request_id"],
          ["app_private", "reserva_idempotencia", "scope"],
          ["app_private", "reserva_idempotencia", "request_fingerprint"],
          ["app_private", "reserva_idempotencia", "response_payload"],
          ["app_private", "reserva_idempotencia", "response_completed_at"],
        ];
        return {
          rows: columns
            .filter(([, table, column]) => `${table}.${column}` !== omitColumn)
            .map(([table_schema, table_name, column_name]) => ({ table_schema, table_name, column_name })),
        };
      }
      if (text.includes("pg_catalog.pg_indexes")) {
        return {
          rows: [
            { schemaname: "app_private", indexname: "idx_reserva_idempotencia_scope_fingerprint" },
            { schemaname: "public", indexname: "uq_citas_detalles_cita_line_key" },
            { schemaname: "public", indexname: "idx_citas_promociones_line_key" },
            { schemaname: "public", indexname: "idx_payment_intents_activos_expires" },
          ],
        };
      }
      if (text.includes("public.estados_notificacion")) {
        return { rows: [{ estado_notificacion_codigo: "procesando" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    client,
    async connect() {
      return client;
    },
  };
}

test("database schema preflight pasa con funciones, columnas, indices y estado requeridos", async () => {
  const pool = createPreflightPool();

  const result = await runDatabaseSchemaPreflight(pool);

  assert.deepEqual(result, { ok: true, missing: [] });
  assert.equal(pool.client.calls.length, 4);
});

test("database schema preflight falla como DB_SCHEMA_OUTDATED y conserva faltantes solo para logs", async () => {
  const pool = createPreflightPool({ omitColumn: "citas_promociones.line_key" });

  await assert.rejects(
    () => runDatabaseSchemaPreflight(pool),
    (error) => {
      assert.equal(error instanceof AppError, true);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, DB_SCHEMA_OUTDATED_CODE);
      assert.equal(error.message, DB_SCHEMA_OUTDATED_MESSAGE);
      assert.equal(error.details.missing[0].name, "public.citas_promociones.line_key");
      return true;
    }
  );
});

test("errores de esquema PostgreSQL se mapean a 503 seguro", () => {
  const mapped = toDatabaseSchemaOutdatedError({
    code: "42883",
    message: "function app_private.crear_reserva_canonica_v1(jsonb) does not exist",
  });

  assert.equal(mapped instanceof AppError, true);
  assert.equal(mapped.statusCode, 503);
  assert.equal(mapped.code, DB_SCHEMA_OUTDATED_CODE);
  assert.equal(mapped.message, DB_SCHEMA_OUTDATED_MESSAGE);

  const routeMapped = mapCanonicalReservationError({ code: "42703", message: "column line_key does not exist" });
  assert.equal(routeMapped.statusCode, 503);
  assert.equal(routeMapped.code, DB_SCHEMA_OUTDATED_CODE);
});

test("promociones canonicas prefieren detalles retornados por RPC antes de consultar citas_detalles", async () => {
  const client = {
    async query() {
      throw new Error("fallback query should not run");
    },
  };
  const rows = await loadCanonicalPromotionDetailRows(client, {
    idCita: "11111111-1111-4111-8111-111111111111",
    canonicalBlock: {
      detalles: [
        { id_cita_detalle: "22222222-2222-4222-8222-222222222222", line_key: "1|svc|tarifa|servicio_manual|1" },
      ],
    },
    detailRows: [
      { line_key: "1|svc|tarifa|servicio_manual|1", subtotal_hnl: 100 },
    ],
  });

  assert.equal(rows[0].id_cita_detalle, "22222222-2222-4222-8222-222222222222");
});

test("promociones canonicas fallan si line_key no tiene detalle persistido", async () => {
  const client = {
    async query() {
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => loadCanonicalPromotionDetailRows(client, {
      idCita: "11111111-1111-4111-8111-111111111111",
      detailRows: [{ line_key: "missing-line" }],
    }),
    (error) => error?.code === "BOOKING_PROMOTION_ALLOCATION_MISMATCH"
  );
});
