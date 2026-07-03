import { AppError, DB_SCHEMA_OUTDATED_CODE } from "../utils/errors.js";

const REQUIRED_FUNCTIONS = [
  { schema: "app_private", name: "crear_reserva_canonica_v1", args: "jsonb" },
  { schema: "app_private", name: "obtener_reserva_idempotente_v1", args: "uuid, text, text" },
  { schema: "app_private", name: "finalizar_reserva_idempotente_v1", args: "uuid, text, text, jsonb" },
  { schema: "app_private", name: "confirmar_reserva_pagada_v1", args: "uuid, text, timestamp with time zone" },
  {
    schema: "app_private",
    name: "registrar_evento_agenda_v1",
    args: "text, uuid, text, text, uuid, uuid, date, date, timestamp with time zone, timestamp with time zone",
  },
  { schema: "app_private", name: "limpiar_agenda_eventos_outbox_v1", args: "interval, integer" },
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

const REQUIRED_INDEXES = [
  { schema: "app_private", name: "idx_reserva_idempotencia_scope_fingerprint" },
  { schema: "public", name: "uq_citas_detalles_cita_line_key" },
  { schema: "public", name: "idx_citas_promociones_line_key" },
  { schema: "public", name: "idx_payment_intents_activos_expires" },
  { schema: "app_private", name: "agenda_eventos_outbox_pkey" },
  { schema: "app_private", name: "idx_agenda_eventos_outbox_created_at" },
  { schema: "app_private", name: "idx_agenda_eventos_outbox_sucursal_evento" },
  { schema: "app_private", name: "idx_agenda_eventos_outbox_sucursal_barbero_evento" },
];

const REQUIRED_RELATIONS = [
  { schema: "app_private", name: "agenda_eventos_outbox", type: "BASE TABLE" },
];

const REQUIRED_CONSTRAINTS = [
  {
    schema: "app_private",
    table: "agenda_eventos_outbox",
    name: "ck_agenda_eventos_outbox_motivo",
    requiredValues: [
      "hold_created",
      "hold_released",
      "hold_expired",
      "booking_confirmed",
      "booking_cancelled",
      "booking_rescheduled",
      "availability_released",
      "block_changed",
      "branch_schedule_changed",
      "barber_schedule_changed",
      "branch_availability_changed",
      "barber_availability_changed",
      "service_availability_changed",
      "booking_rules_changed",
    ],
  },
];

const REQUIRED_TRIGGERS = [
  { schema: "public", table: "citas", name: "tr_agenda_outbox_citas" },
  { schema: "public", table: "bloqueos_agenda", name: "tr_agenda_outbox_bloqueos" },
  { schema: "public", table: "horarios_semanales_sucursales", name: "tr_agenda_outbox_horarios_sucursal" },
  { schema: "public", table: "horarios_semanales_sucursales_bloques", name: "tr_agenda_outbox_horarios_sucursal_bloques" },
  { schema: "public", table: "horarios_semanales_empleados", name: "tr_agenda_outbox_horarios_empleado" },
  { schema: "public", table: "sucursales", name: "tr_agenda_outbox_sucursales" },
  { schema: "public", table: "empleados", name: "tr_agenda_outbox_empleados" },
  { schema: "public", table: "servicios_tarifas", name: "tr_agenda_outbox_servicios_tarifas" },
  { schema: "public", table: "servicios", name: "tr_agenda_outbox_servicios_iu" },
  { schema: "public", table: "servicios", name: "tr_agenda_outbox_servicios_d" },
  { schema: "public", table: "parametros_sistema", name: "tr_agenda_outbox_parametros_sistema" },
];

const REQUIRED_CRON_JOBS = [
  { name: "masterfade-clean-agenda-events", schedule: "0 * * * *" },
];

const REQUIRED_NOTIFICATION_STATES = ["procesando"];

function normalizeArgs(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeType(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
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

    const relationSchemas = unique(REQUIRED_RELATIONS.map((relation) => relation.schema));
    const relations = await queryRows(
      client,
      `
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = ANY($1::text[])
      `,
      [relationSchemas]
    );
    const relationKeys = new Set(relations.map((row) => (
      `${row.table_schema}.${row.table_name}:${normalizeType(row.table_type)}`
    )));
    for (const relation of REQUIRED_RELATIONS) {
      const key = `${relation.schema}.${relation.name}:${normalizeType(relation.type)}`;
      if (!relationKeys.has(key)) missing.push({ type: "relation", name: `${relation.schema}.${relation.name}` });
    }

    const columnSchemas = unique(REQUIRED_COLUMNS.map(([schema]) => schema));
    const columns = await queryRows(
      client,
      `
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = ANY($1::text[])
      `,
      [columnSchemas]
    );
    const columnKeys = new Set(columns.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
    const columnTypeByKey = new Map(columns.map((row) => [
      `${row.table_schema}.${row.table_name}.${row.column_name}`,
      normalizeType(row.data_type),
    ]));
    for (const [schema, table, column, dataType] of REQUIRED_COLUMNS) {
      const key = `${schema}.${table}.${column}`;
      if (!columnKeys.has(key)) {
        missing.push({ type: "column", name: key });
      } else if (dataType && columnTypeByKey.get(key) !== normalizeType(dataType)) {
        missing.push({ type: "column", name: `${key}:${dataType}` });
      }
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

    const constraints = await queryRows(
      client,
      `
        SELECT
          ns.nspname AS table_schema,
          cls.relname AS table_name,
          con.conname AS constraint_name,
          pg_get_constraintdef(con.oid) AS definition
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class cls
          ON cls.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns
          ON ns.oid = cls.relnamespace
        WHERE ns.nspname = ANY($1::text[])
      `,
      [unique(REQUIRED_CONSTRAINTS.map((constraint) => constraint.schema))]
    );
    const constraintByKey = new Map(constraints.map((row) => [
      `${row.table_schema}.${row.table_name}.${row.constraint_name}`,
      String(row.definition || ""),
    ]));
    for (const constraint of REQUIRED_CONSTRAINTS) {
      const key = `${constraint.schema}.${constraint.table}.${constraint.name}`;
      const definition = constraintByKey.get(key);
      if (!definition) {
        missing.push({ type: "constraint", name: key });
        continue;
      }
      for (const value of constraint.requiredValues || []) {
        if (!definition.includes(`'${value}'`)) {
          missing.push({ type: "constraint", name: `${key}:${value}` });
        }
      }
    }

    const triggers = await queryRows(
      client,
      `
        SELECT
          ns.nspname AS table_schema,
          cls.relname AS table_name,
          trg.tgname AS trigger_name,
          trg.tgenabled AS enabled
        FROM pg_catalog.pg_trigger trg
        JOIN pg_catalog.pg_class cls
          ON cls.oid = trg.tgrelid
        JOIN pg_catalog.pg_namespace ns
          ON ns.oid = cls.relnamespace
        WHERE NOT trg.tgisinternal
          AND ns.nspname = ANY($1::text[])
      `,
      [unique(REQUIRED_TRIGGERS.map((trigger) => trigger.schema))]
    );
    const triggerByName = new Map(triggers.map((row) => [row.trigger_name, row]));
    for (const trigger of REQUIRED_TRIGGERS) {
      const row = triggerByName.get(trigger.name);
      if (!row) {
        missing.push({ type: "trigger", name: `${trigger.schema}.${trigger.table}.${trigger.name}` });
        continue;
      }
      if (row.table_schema !== trigger.schema || row.table_name !== trigger.table) {
        missing.push({ type: "trigger", name: `${trigger.name}:${trigger.schema}.${trigger.table}` });
      }
      if (!["O", "A"].includes(String(row.enabled || ""))) {
        missing.push({ type: "trigger_disabled", name: `${trigger.schema}.${trigger.table}.${trigger.name}` });
      }
    }

    const cronJobs = await queryRows(
      client,
      `
        SELECT jobname, schedule, active
        FROM cron.job
        WHERE jobname = ANY($1::text[])
      `,
      [REQUIRED_CRON_JOBS.map((job) => job.name)]
    );
    const cronByName = new Map(cronJobs.map((row) => [row.jobname, row]));
    for (const job of REQUIRED_CRON_JOBS) {
      const row = cronByName.get(job.name);
      if (!row) {
        missing.push({ type: "cron", name: job.name });
        continue;
      }
      if (row.active !== true) missing.push({ type: "cron_inactive", name: job.name });
      if (String(row.schedule || "").trim() !== job.schedule) {
        missing.push({ type: "cron_schedule", name: `${job.name}:${job.schedule}` });
      }
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
