import { AppError, DB_SCHEMA_OUTDATED_CODE } from "../utils/errors.js";

const REQUIRED_FUNCTIONS = [
  { schema: "app_private", name: "crear_reserva_canonica_v1", args: "jsonb" },
  { schema: "app_private", name: "obtener_reserva_idempotente_v1", args: "uuid, text, text" },
  { schema: "app_private", name: "finalizar_reserva_idempotente_v1", args: "uuid, text, text, jsonb" },
  { schema: "app_private", name: "confirmar_reserva_pagada_v1", args: "uuid, text, timestamp with time zone" },
];

const REQUIRED_COLUMNS = [
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

const REQUIRED_INDEXES = [
  { schema: "app_private", name: "idx_reserva_idempotencia_scope_fingerprint" },
  { schema: "public", name: "uq_citas_detalles_cita_line_key" },
  { schema: "public", name: "idx_citas_promociones_line_key" },
  { schema: "public", name: "idx_payment_intents_activos_expires" },
];

const REQUIRED_NOTIFICATION_STATES = ["procesando"];

function normalizeArgs(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows || [];
}

export async function runDatabaseSchemaPreflight(pool, logger = null) {
  if (!pool || typeof pool.connect !== "function") {
    throw new AppError(500, "Pool de base de datos no configurado", {
      code: "DB_NOT_CONFIGURED",
    });
  }

  const client = await pool.connect();
  const missing = [];
  try {
    const schemas = unique(REQUIRED_FUNCTIONS.map((fn) => fn.schema));
    const functions = await queryRows(
      client,
      `
        SELECT
          n.nspname AS schema_name,
          p.proname AS function_name,
          oidvectortypes(p.proargtypes) AS identity_args
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n
          ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1::text[])
      `,
      [schemas]
    );
    const functionKeys = new Set(functions.map((row) => (
      `${row.schema_name}.${row.function_name}(${normalizeArgs(row.identity_args)})`
    )));
    for (const fn of REQUIRED_FUNCTIONS) {
      const key = `${fn.schema}.${fn.name}(${normalizeArgs(fn.args)})`;
      if (!functionKeys.has(key)) missing.push({ type: "function", name: key });
    }

    const columnSchemas = unique(REQUIRED_COLUMNS.map(([schema]) => schema));
    const columns = await queryRows(
      client,
      `
        SELECT table_schema, table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = ANY($1::text[])
      `,
      [columnSchemas]
    );
    const columnKeys = new Set(columns.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
    for (const [schema, table, column] of REQUIRED_COLUMNS) {
      const key = `${schema}.${table}.${column}`;
      if (!columnKeys.has(key)) missing.push({ type: "column", name: key });
    }

    const indexSchemas = unique(REQUIRED_INDEXES.map((index) => index.schema));
    const indexes = await queryRows(
      client,
      `
        SELECT schemaname, indexname
        FROM pg_catalog.pg_indexes
        WHERE schemaname = ANY($1::text[])
      `,
      [indexSchemas]
    );
    const indexKeys = new Set(indexes.map((row) => `${row.schemaname}.${row.indexname}`));
    for (const index of REQUIRED_INDEXES) {
      const key = `${index.schema}.${index.name}`;
      if (!indexKeys.has(key)) missing.push({ type: "index", name: key });
    }

    const states = await queryRows(
      client,
      `
        SELECT estado_notificacion_codigo
        FROM public.estados_notificacion
        WHERE estado_notificacion_codigo = ANY($1::text[])
      `,
      [REQUIRED_NOTIFICATION_STATES]
    );
    const stateKeys = new Set(states.map((row) => String(row.estado_notificacion_codigo || "").trim()));
    for (const state of REQUIRED_NOTIFICATION_STATES) {
      if (!stateKeys.has(state)) missing.push({ type: "catalog_value", name: `estados_notificacion.${state}` });
    }
  } catch (error) {
    logger?.error?.({ err: error }, "Booking database schema preflight failed");
    if (error instanceof AppError) throw error;
    throw new AppError(503, "El servicio de reservas está temporalmente en mantenimiento.", {
      code: DB_SCHEMA_OUTDATED_CODE,
    });
  } finally {
    client.release();
  }

  if (missing.length) {
    logger?.error?.({ missing }, "Booking database schema preflight found missing objects");
    throw new AppError(503, "El servicio de reservas está temporalmente en mantenimiento.", {
      code: DB_SCHEMA_OUTDATED_CODE,
      details: { missing },
    });
  }

  logger?.info?.("Booking database schema preflight passed");
  return { ok: true, missing: [] };
}
