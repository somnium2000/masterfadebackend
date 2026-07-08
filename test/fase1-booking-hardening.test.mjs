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

function createPreflightPool({
  omitRelation = "",
  omitColumn = "",
  omitFunction = "",
  omitIndex = "",
  omitConstraint = "",
  omitTrigger = "",
  wrongFunctionSignature = false,
  wrongTriggerTable = false,
  disabledTrigger = false,
  omitCron = false,
  inactiveCron = false,
  wrongCronSchedule = false,
} = {}) {
  const calls = [];
  const functionRows = [
    { schema_name: "app_private", function_name: "crear_reserva_canonica_v1", identity_args: "jsonb" },
    { schema_name: "app_private", function_name: "obtener_reserva_idempotente_v1", identity_args: "uuid, text, text" },
    { schema_name: "app_private", function_name: "finalizar_reserva_idempotente_v1", identity_args: "uuid, text, text, jsonb" },
    { schema_name: "app_private", function_name: "confirmar_reserva_pagada_v1", identity_args: "uuid, text, timestamp with time zone" },
    {
      schema_name: "app_private",
      function_name: "registrar_evento_agenda_v1",
      identity_args: wrongFunctionSignature ? "text, uuid" : "text, uuid, text, text, uuid, uuid, date, date, timestamp with time zone, timestamp with time zone",
    },
    { schema_name: "app_private", function_name: "limpiar_agenda_eventos_outbox_v1", identity_args: "interval, integer" },
  ].filter((row) => row.function_name !== omitFunction);

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
    ["public", "citas_admin_beneficios_resumen", "id_grupo_cita", "uuid"],
    ["public", "citas_admin_beneficios_resumen", "resumen_beneficios", "jsonb"],
    ["public", "citas_admin_beneficios_resumen", "total_pagar_hnl"],
    ["public", "citas_admin_beneficios_resumen", "recompensa_context_token", "text"],
    ["public", "citas_admin_beneficios_resumen", "cortesia_aplicada", "boolean"],
    ["public", "citas_admin_beneficios_resumen", "membresia_aplicada", "boolean"],
    ["public", "citas_admin_beneficios_resumen", "recompensa_aplicada", "boolean"],
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
    ["app_private", "agenda_eventos_outbox", "id_evento", "bigint"],
    ["app_private", "agenda_eventos_outbox", "tipo_evento", "text"],
    ["app_private", "agenda_eventos_outbox", "motivo", "text"],
    ["app_private", "agenda_eventos_outbox", "id_sucursal", "uuid"],
    ["app_private", "agenda_eventos_outbox", "id_empleado_barbero", "uuid"],
    ["app_private", "agenda_eventos_outbox", "fecha_desde", "date"],
    ["app_private", "agenda_eventos_outbox", "fecha_hasta", "date"],
    ["app_private", "agenda_eventos_outbox", "inicio_at", "timestamp with time zone"],
    ["app_private", "agenda_eventos_outbox", "fin_at", "timestamp with time zone"],
    ["app_private", "agenda_eventos_outbox", "origen_tabla", "text"],
    ["app_private", "agenda_eventos_outbox", "origen_id", "uuid"],
    ["app_private", "agenda_eventos_outbox", "operacion", "text"],
    ["app_private", "agenda_eventos_outbox", "txid_origen", "bigint"],
    ["app_private", "agenda_eventos_outbox", "payload", "jsonb"],
    ["app_private", "agenda_eventos_outbox", "created_at", "timestamp with time zone"],
  ];

  const indexRows = [
    { schemaname: "app_private", indexname: "idx_reserva_idempotencia_scope_fingerprint" },
    { schemaname: "public", indexname: "uq_citas_detalles_cita_line_key" },
    { schemaname: "public", indexname: "idx_citas_promociones_line_key" },
    { schemaname: "public", indexname: "citas_admin_beneficios_resumen_pkey" },
    { schemaname: "public", indexname: "idx_citas_admin_beneficios_resumen_recompensa" },
    { schemaname: "public", indexname: "idx_payment_intents_activos_expires" },
    { schemaname: "app_private", indexname: "agenda_eventos_outbox_pkey" },
    { schemaname: "app_private", indexname: "idx_agenda_eventos_outbox_created_at" },
    { schemaname: "app_private", indexname: "idx_agenda_eventos_outbox_sucursal_evento" },
    { schemaname: "app_private", indexname: "idx_agenda_eventos_outbox_sucursal_barbero_evento" },
  ].filter((row) => row.indexname !== omitIndex);

  const triggerRows = [
    ["public", "citas", "tr_agenda_outbox_citas"],
    ["public", "bloqueos_agenda", "tr_agenda_outbox_bloqueos"],
    ["public", "horarios_semanales_sucursales", "tr_agenda_outbox_horarios_sucursal"],
    ["public", "horarios_semanales_sucursales_bloques", "tr_agenda_outbox_horarios_sucursal_bloques"],
    ["public", "horarios_semanales_empleados", "tr_agenda_outbox_horarios_empleado"],
    ["public", "sucursales", "tr_agenda_outbox_sucursales"],
    ["public", "empleados", "tr_agenda_outbox_empleados"],
    ["public", "servicios_tarifas", "tr_agenda_outbox_servicios_tarifas"],
    ["public", "servicios", "tr_agenda_outbox_servicios_iu"],
    ["public", "servicios", "tr_agenda_outbox_servicios_d"],
    ["public", "parametros_sistema", "tr_agenda_outbox_parametros_sistema"],
  ].filter(([, , name]) => name !== omitTrigger);

  const client = {
    calls,
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("pg_catalog.pg_proc")) {
        return { rows: functionRows };
      }
      if (text.includes("information_schema.tables")) {
        return {
          rows: omitRelation === "app_private.agenda_eventos_outbox" ? [] : [
            { table_schema: "app_private", table_name: "agenda_eventos_outbox", table_type: "BASE TABLE" },
          ],
        };
      }
      if (text.includes("information_schema.columns")) {
        return {
          rows: columns
            .filter(([, table, column]) => `${table}.${column}` !== omitColumn)
            .map(([table_schema, table_name, column_name, data_type = "text"]) => ({
              table_schema,
              table_name,
              column_name,
              data_type,
            })),
        };
      }
      if (text.includes("pg_catalog.pg_indexes")) {
        return { rows: indexRows };
      }
      if (text.includes("pg_catalog.pg_constraint")) {
        return {
          rows: omitConstraint ? [] : [{
            table_schema: "app_private",
            table_name: "agenda_eventos_outbox",
            constraint_name: "ck_agenda_eventos_outbox_motivo",
            definition: "CHECK motivo IN ('hold_created','hold_released','hold_expired','booking_confirmed','booking_cancelled','booking_rescheduled','availability_released','block_changed','branch_schedule_changed','barber_schedule_changed','branch_availability_changed','barber_availability_changed','service_availability_changed','booking_rules_changed')",
          }],
        };
      }
      if (text.includes("pg_catalog.pg_trigger")) {
        return {
          rows: triggerRows.map(([table_schema, table_name, trigger_name]) => ({
            table_schema,
            table_name: wrongTriggerTable && trigger_name === "tr_agenda_outbox_citas" ? "empleados" : table_name,
            trigger_name,
            enabled: disabledTrigger && trigger_name === "tr_agenda_outbox_citas" ? "D" : "O",
          })),
        };
      }
      if (text.includes("cron.job")) {
        return {
          rows: omitCron ? [] : [{
            jobname: "masterfade-clean-agenda-events",
            schedule: wrongCronSchedule ? "*/5 * * * *" : "0 * * * *",
            active: !inactiveCron,
          }],
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
  assert.equal(pool.client.calls.length, 8);
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

test("database schema preflight detecta tabla outbox ausente", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitRelation: "app_private.agenda_eventos_outbox",
  })), (error) => error.details.missing.some((item) => item.type === "relation"));
});

test("database schema preflight detecta funcion outbox ausente", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitFunction: "registrar_evento_agenda_v1",
  })), (error) => error.details.missing.some((item) => item.type === "function"));
});

test("database schema preflight detecta firma outbox incorrecta", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    wrongFunctionSignature: true,
  })), (error) => error.details.missing.some((item) => item.type === "function"));
});

test("database schema preflight detecta indice outbox ausente", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitIndex: "idx_agenda_eventos_outbox_created_at",
  })), (error) => error.details.missing.some((item) => item.type === "index"));
});

test("database schema preflight detecta constraint de motivos ausente", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitConstraint: "ck_agenda_eventos_outbox_motivo",
  })), (error) => error.details.missing.some((item) => item.type === "constraint"));
});

test("database schema preflight detecta trigger ausente", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitTrigger: "tr_agenda_outbox_citas",
  })), (error) => error.details.missing.some((item) => item.type === "trigger"));
});

test("database schema preflight detecta trigger asociado a tabla incorrecta", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    wrongTriggerTable: true,
  })), (error) => error.details.missing.some((item) => item.type === "trigger"));
});

test("database schema preflight detecta trigger deshabilitado", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    disabledTrigger: true,
  })), (error) => error.details.missing.some((item) => item.type === "trigger_disabled"));
});

test("database schema preflight detecta cron ausente, inactivo y schedule incorrecto", async () => {
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    omitCron: true,
  })), (error) => error.details.missing.some((item) => item.type === "cron"));
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    inactiveCron: true,
  })), (error) => error.details.missing.some((item) => item.type === "cron_inactive"));
  await assert.rejects(() => runDatabaseSchemaPreflight(createPreflightPool({
    wrongCronSchedule: true,
  })), (error) => error.details.missing.some((item) => item.type === "cron_schedule"));
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
