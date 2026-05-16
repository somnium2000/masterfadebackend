import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  ACTIVE_PAYMENT_INTENT_STATES,
  APPOINTMENT_STATE_TRANSITIONS,
  assertUuid,
  expireStaleAppointmentReservations,
  getSystemParameters,
  mapBlockRow,
  OPERATIONAL_APPOINTMENT_STATES,
  parseDateOnly,
  resolveBookingSelection,
  resolveBranchIdsForClaims,
} from "../../../services/agendaService.js";
import { consumeMembershipForCompletedAppointment } from "../../../services/membershipService.js";

const CONFIG_ALLOWED_ROLES = ["admin", "super_admin"];
const OPERATIONAL_ALLOWED_ROLES = ["admin", "super_admin", "barbero"];
const HISTORY_ALLOWED_ROLES = ["admin", "super_admin"];
const EMERGENCY_ALLOWED_ROLES = ["admin", "super_admin"];
const HISTORICAL_DEFAULT_STATES = ["cancelada", "expirada", "completada", "no_show", "anulada"];
const STATUS_CHANGE_WINDOW_MINUTES = 10;
const OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES = 5;
const FINISH_ALERT_THRESHOLD_MINUTES = 7;
const OPERATIONAL_TIMEZONE = "America/Tegucigalpa";
const OPERATIONAL_DELAY_AFFECTED_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon"];
let appointmentContactColumnsSupportCache = null;

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    const safeMessageByCode = {
      ADMIN_CITAS_STATUS_WINDOW_NOT_OPEN: "La cita aún no está disponible para ese cambio de estado.",
      ADMIN_CITAS_STATUS_TRANSITION_INVALID: "El cambio de estado solicitado no está disponible para esta cita.",
      ADMIN_CITAS_STATUS_START_INVALID: "La cita no se puede actualizar en este momento.",
      ADMIN_CITAS_ARRIVAL_STATE_INVALID: "La cita no se puede marcar en salon en su estado actual.",
      ADMIN_CITAS_START_ATTENTION_STATE_INVALID: "La cita debe estar en salon antes de iniciar atencion.",
      ADMIN_CITAS_FINISH_ATTENTION_STATE_INVALID: "La cita debe estar en atencion antes de finalizarla.",
    };
    const safeCodes = new Set(Object.keys(safeMessageByCode));
    return sendError(reply, error.statusCode, safeMessageByCode[error.code] || error.message, {
      code: error.code,
      details: safeCodes.has(error.code) ? undefined : error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    details: error instanceof Error ? error.message : "Unknown admin citas error",
    requestId: request.id,
  });
}

function cleanText(value) {
  const raw = String(value ?? "").trim();
  return raw.length ? raw : null;
}

function parseDateTime(value, field) {
  const parsed = new Date(String(value || "").trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `${field} debe ser una fecha-hora valida`, {
      code: "ADMIN_CITAS_DATETIME_INVALID",
      details: { field, value: value ?? null },
    });
  }
  return parsed;
}

function subMinutes(dateValue, minutes) {
  return new Date(dateValue.getTime() - (minutes * 60 * 1000));
}

function normalizeTime(value, field) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    throw new AppError(400, `${field} debe tener formato HH:mm o HH:mm:ss`, {
      code: "ADMIN_CITAS_TIME_INVALID",
      details: { field, value: raw || null },
    });
  }
  return `${match[1]}:${match[2]}:${match[3] || "00"}`;
}

function normalizeBoolean(value, field) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new AppError(400, `${field} debe ser booleano`, {
    code: "ADMIN_CITAS_BOOLEAN_INVALID",
    details: { field, value: value ?? null },
  });
}

function mapScheduleRow(row) {
  return {
    id_horario: row.id_horario,
    dia_semana: Number(row.dia_semana),
    hora_inicio: String(row.hora_inicio).slice(0, 8),
    hora_fin: String(row.hora_fin).slice(0, 8),
    almuerzo_inicio: row.almuerzo_inicio ? String(row.almuerzo_inicio).slice(0, 8) : null,
    almuerzo_fin: row.almuerzo_fin ? String(row.almuerzo_fin).slice(0, 8) : null,
    activo: Boolean(row.activo),
  };
}

function mapEmployeeRow(row) {
  return {
    id_empleado: row.id_empleado,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    nombre_completo: row.nombre_completo ?? "Sin nombre",
    es_barbero: Boolean(row.es_barbero),
  };
}

function selectParams(values) {
  return {
    hold_duracion_min: Number(values.hold_duracion_min?.valor_numero ?? 5),
    no_show_min: Number(values.no_show_min?.valor_numero ?? 10),
    agenda_buffer_global_min: Number(values.agenda_buffer_global_min?.valor_numero ?? 0),
    agenda_min_servicio_vendible_min: Number(values.agenda_min_servicio_vendible_min?.valor_numero ?? 10),
    permitir_acompanantes: Boolean(values.permitir_acompanantes?.valor_booleano ?? false),
    pago_total_obligatorio: Boolean(values.pago_total_obligatorio?.valor_booleano ?? true),
    simulacion_sin_pago: Boolean(values.simulacion_sin_pago?.valor_booleano),
    masterpuntos_migracion_manual_habilitada: Boolean(
      values.masterpuntos_migracion_manual_habilitada?.valor_booleano ?? false
    ),
  };
}

async function getScopeBranches(app, claims) {
  const branchIds = await resolveBranchIdsForClaims(app, claims);
  if (!branchIds.length) {
    throw new AppError(403, "No tienes sucursales dentro de tu alcance para admin/citas", {
      code: "ADMIN_CITAS_SCOPE_EMPTY",
    });
  }
  return branchIds;
}

function getRoleScope(claims) {
  const roles = Array.isArray(claims?.roles) ? claims.roles : [];
  const elevated = roles.includes("admin") || roles.includes("super_admin");
  const isBarberOnly = !elevated && roles.includes("barbero");
  const empleadoId = claims?.empleado_id ?? null;

  if (isBarberOnly && !empleadoId) {
    throw new AppError(403, "No tienes perfil de barbero activo para operar citas", {
      code: "ADMIN_CITAS_BARBER_SCOPE_MISSING",
    });
  }

  return {
    elevated,
    barber_empleado_id: isBarberOnly ? empleadoId : null,
    actor_usuario_id: claims?.user?.id_usuario ?? null,
  };
}

function parseLimit(value, fallback = 100, max = 250) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError(400, "limit debe ser un entero positivo", {
      code: "ADMIN_CITAS_LIMIT_INVALID",
      details: { value },
    });
  }
  return Math.min(Math.trunc(parsed), max);
}

function getCurrentDateInTimeZone(timeZone = OPERATIONAL_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function parseStatusFilter(rawValue, fallbackStates = []) {
  const raw = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue || "").trim();
  if (!raw) return Array.from(new Set(fallbackStates.filter(Boolean)));
  return Array.from(new Set(raw.split(",").map((item) => String(item || "").trim()).filter(Boolean)));
}

function mapOperationalAppointment(row) {
  const serviceDetails = Array.isArray(row.servicios_detalle)
    ? row.servicios_detalle.map((item) => ({
        id_servicio: item?.id_servicio ?? null,
        nombre_servicio: item?.nombre_servicio ?? "Servicio",
      }))
    : [];

  return {
    id_cita: row.id_cita,
    id_grupo_cita: row.id_grupo_cita ?? null,
    orden_integrante: row.orden_integrante == null ? null : Number(row.orden_integrante),
    alias_integrante: row.alias_integrante ?? null,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    id_empleado_barbero: row.id_empleado_barbero,
    nombre_barbero: row.nombre_barbero ?? "Sin nombre",
    id_persona_cliente: row.id_persona_cliente,
    id_cliente: row.id_cliente ?? null,
    nombre_cliente: row.nombre_cliente ?? "Sin nombre",
    telefono_cliente: row.telefono_cliente ?? null,
    correo_cliente: row.correo_cliente ?? null,
    estado_cita_codigo: row.estado_cita_codigo,
    inicio_at: new Date(row.inicio_at).toISOString(),
    fin_at: new Date(row.fin_at).toISOString(),
    atencion_iniciada_at: row.atencion_iniciada_at ? new Date(row.atencion_iniciada_at).toISOString() : null,
    atencion_finalizada_at: row.atencion_finalizada_at ? new Date(row.atencion_finalizada_at).toISOString() : null,
    retraso_inicio_min: Number(row.retraso_inicio_min ?? 0),
    duracion_total_min: Number(row.duracion_total_min ?? 0),
    buffer_total_min: Number(row.buffer_total_min ?? 0),
    selection_type: row.selection_type ?? "services",
    id_paquete: row.id_paquete ?? null,
    id_lote_reagendacion: row.id_lote_reagendacion ?? null,
    id_cita_causante_retraso: row.id_cita_causante_retraso ?? null,
    retraso_propagado_min: row.retraso_propagado_min == null ? null : Number(row.retraso_propagado_min),
    total_pagar_hnl: Number(row.total_pagar_hnl ?? 0),
    moneda_codigo: row.moneda_codigo ?? "HNL",
    asignada_automaticamente: Boolean(row.asignada_automaticamente),
    notas: row.notas ?? null,
    servicios: Array.isArray(row.servicios) ? row.servicios : [],
    servicios_detalle: serviceDetails,
    hold_actual: row.hold_estado
      ? {
          estado_hold_codigo: row.hold_estado,
          expires_at: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
        }
      : null,
    intent_actual: row.intent_estado
      ? {
          estado_intent_codigo: row.intent_estado,
          expires_at: row.intent_expires_at ? new Date(row.intent_expires_at).toISOString() : null,
        }
      : null,
  };
}

function resolveDateRange(query = {}) {
  const fechaDesde = query?.fecha_desde ? parseDateOnly(query.fecha_desde, "fecha_desde") : null;
  const fechaHasta = query?.fecha_hasta ? parseDateOnly(query.fecha_hasta, "fecha_hasta") : null;
  if (fechaDesde && fechaHasta && fechaHasta < fechaDesde) {
    throw new AppError(400, "fecha_hasta no puede ser menor que fecha_desde", {
      code: "ADMIN_CITAS_DATE_RANGE_INVALID",
      details: { fecha_desde: fechaDesde, fecha_hasta: fechaHasta },
    });
  }
  return { fechaDesde, fechaHasta };
}

async function getAppointmentContactColumnsSupport(client) {
  if (appointmentContactColumnsSupportCache) return appointmentContactColumnsSupportCache;
  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'citas'
        AND column_name = ANY($1::text[])
    `,
    [["contacto_nombre", "contacto_email", "contacto_telefono"]]
  );
  const names = new Set(rows.map((row) => String(row.column_name || "").trim()));
  appointmentContactColumnsSupportCache = {
    has_contacto_nombre: names.has("contacto_nombre"),
    has_contacto_email: names.has("contacto_email"),
    has_contacto_telefono: names.has("contacto_telefono"),
  };
  return appointmentContactColumnsSupportCache;
}

async function listOperationalAppointments(client, {
  branchIds,
  barberScopeId = null,
  idEmpleadoBarbero = null,
  idSucursal = null,
  states = [],
  q = null,
  fechaDesde = null,
  fechaHasta = null,
  limit = 100,
  sortDirection = "asc",
} = {}) {
  const contactColumnsSupport = await getAppointmentContactColumnsSupport(client);
  const clientNameSql = contactColumnsSupport.has_contacto_nombre
    ? "COALESCE(NULLIF(BTRIM(c.contacto_nombre), ''), NULLIF(TRIM(CONCAT(pc.nombres, ' ', pc.apellidos)), ''), 'Sin nombre')"
    : "COALESCE(NULLIF(TRIM(CONCAT(pc.nombres, ' ', pc.apellidos)), ''), 'Sin nombre')";
  const clientPhoneSql = contactColumnsSupport.has_contacto_telefono
    ? "COALESCE(c.contacto_telefono, pc.telefono_principal)"
    : "pc.telefono_principal";
  const clientEmailSql = contactColumnsSupport.has_contacto_email
    ? "COALESCE(c.contacto_email, cp.email)"
    : "cp.email";

  const params = [branchIds];
  const where = [
    "c.deleted_at IS NULL",
    "c.id_sucursal = ANY($1::uuid[])",
  ];

  if (barberScopeId) {
    params.push(assertUuid(barberScopeId, "id_empleado_barbero"));
    where.push(`c.id_empleado_barbero = $${params.length}::uuid`);
  }
  if (idEmpleadoBarbero) {
    const safeBarberId = assertUuid(idEmpleadoBarbero, "id_empleado_barbero");
    if (barberScopeId && safeBarberId !== barberScopeId) {
      throw new AppError(403, "No puedes consultar citas de otro barbero", {
        code: "ADMIN_CITAS_BARBER_FORBIDDEN",
      });
    }
    params.push(safeBarberId);
    where.push(`c.id_empleado_barbero = $${params.length}::uuid`);
  }

  if (idSucursal) {
    const safeBranch = assertUuid(idSucursal, "id_sucursal");
    if (!branchIds.includes(safeBranch)) {
      throw new AppError(403, "Sucursal fuera de tu alcance", {
        code: "ADMIN_CITAS_BRANCH_FORBIDDEN",
        details: { id_sucursal: safeBranch },
      });
    }
    params.push(safeBranch);
    where.push(`c.id_sucursal = $${params.length}::uuid`);
  }

  if (states.length) {
    params.push(states);
    where.push(`c.estado_cita_codigo = ANY($${params.length}::text[])`);
  }

  if (fechaDesde) {
    params.push(`${fechaDesde}T00:00:00`);
    where.push(`c.inicio_at >= $${params.length}::timestamptz`);
  }

  if (fechaHasta) {
    params.push(`${fechaHasta}T23:59:59.999`);
    where.push(`c.inicio_at <= $${params.length}::timestamptz`);
  }

  if (q) {
    const value = `%${String(q || "").trim().toLowerCase()}%`;
    params.push(value);
    const idx = params.length;
    where.push(`
      (
        lower(coalesce(${clientNameSql}, '')) LIKE $${idx}
        OR lower(coalesce(concat(pb.nombres, ' ', pb.apellidos), '')) LIKE $${idx}
        OR lower(c.id_cita::text) LIKE $${idx}
      )
    `);
  }

  params.push(limit);
  const limitIdx = params.length;

  const normalizedSortDirection = String(sortDirection || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const { rows } = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_grupo_cita,
        c.orden_integrante,
        c.alias_integrante,
        c.id_sucursal,
        s.nombre_sucursal,
        c.id_empleado_barbero,
        c.id_persona_cliente,
        c.id_cliente,
        c.estado_cita_codigo,
        c.inicio_at,
        c.fin_at,
        c.atencion_iniciada_at,
        c.atencion_finalizada_at,
        c.retraso_inicio_min,
        c.duracion_total_min,
        c.buffer_total_min,
        c.selection_type,
        c.id_paquete,
        c.total_pagar_hnl,
        c.moneda_codigo,
        c.asignada_automaticamente,
        c.notas,
        ${clientPhoneSql} AS telefono_cliente,
        ${clientEmailSql} AS correo_cliente,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Sin nombre') AS nombre_barbero,
        ${clientNameSql} AS nombre_cliente,
        COALESCE(srv.servicios, '[]'::jsonb) AS servicios,
        COALESCE(srv.servicios_detalle, '[]'::jsonb) AS servicios_detalle,
        hold.estado_hold_codigo AS hold_estado,
        hold.expires_at AS hold_expires_at,
        intent.estado_intent_codigo AS intent_estado,
        intent.expires_at AS intent_expires_at,
        delay_reag.id_lote_reagendacion,
        delay_reag.id_cita_causante AS id_cita_causante_retraso,
        delay_reag.retraso_min AS retraso_propagado_min
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      JOIN public.personas pc
        ON pc.id_persona = c.id_persona_cliente
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona_cliente
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          jsonb_agg(cd.id_servicio ORDER BY cd.id_cita_detalle),
          '[]'::jsonb
        ) AS servicios,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id_servicio', cd.id_servicio,
              'nombre_servicio', COALESCE(NULLIF(TRIM(s.nombre_servicio), ''), 'Servicio')
            )
            ORDER BY cd.id_cita_detalle
          ),
          '[]'::jsonb
        ) AS servicios_detalle
        FROM public.citas_detalles cd
        LEFT JOIN public.servicios s
          ON s.id_servicio = cd.id_servicio
        WHERE cd.id_cita = c.id_cita
      ) srv ON TRUE
      LEFT JOIN LATERAL (
        SELECT h.estado_hold_codigo, h.expires_at
        FROM public.citas_holds h
        WHERE h.id_cita = c.id_cita
        ORDER BY h.created_at DESC
        LIMIT 1
      ) hold ON TRUE
      LEFT JOIN LATERAL (
        SELECT pi.estado_intent_codigo, pi.expires_at
        FROM public.payment_intents pi
        WHERE pi.id_cita = c.id_cita
        ORDER BY pi.created_at DESC
        LIMIT 1
      ) intent ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          cr.id_lote_reagendacion,
          cr.id_cita_causante,
          cr.retraso_min
        FROM public.citas_reagendaciones cr
        WHERE cr.id_cita = c.id_cita
          AND cr.tipo_reagendacion_codigo = 'retraso_operativo'
        ORDER BY cr.created_at DESC, cr.id_reagendacion DESC
        LIMIT 1
      ) delay_reag ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY c.inicio_at ${normalizedSortDirection}, c.id_cita ${normalizedSortDirection}
      LIMIT $${limitIdx}::int
    `,
    params
  );

  return rows.map(mapOperationalAppointment);
}

async function getScopedAppointment(client, { idCita, branchIds, barberScopeId = null, forUpdate = false }) {
  const safeId = assertUuid(idCita, "id_cita");
  const params = [safeId, branchIds];
  const where = [
    "c.id_cita = $1::uuid",
    "c.deleted_at IS NULL",
    "c.id_sucursal = ANY($2::uuid[])",
  ];

  if (barberScopeId) {
    params.push(assertUuid(barberScopeId, "id_empleado_barbero"));
    where.push(`c.id_empleado_barbero = $${params.length}::uuid`);
  }

  const contactColumnsSupport = await getAppointmentContactColumnsSupport(client);
  const clientNameSql = contactColumnsSupport.has_contacto_nombre
    ? "COALESCE(NULLIF(BTRIM(c.contacto_nombre), ''), NULLIF(TRIM(CONCAT(pc.nombres, ' ', pc.apellidos)), ''), 'Sin nombre')"
    : "COALESCE(NULLIF(TRIM(CONCAT(pc.nombres, ' ', pc.apellidos)), ''), 'Sin nombre')";

  const { rows } = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_grupo_cita,
        c.orden_integrante,
        c.alias_integrante,
        c.id_sucursal,
        s.nombre_sucursal,
        c.id_empleado_barbero,
        c.id_persona_cliente,
        c.id_cliente,
        c.estado_cita_codigo,
        c.inicio_at,
        c.fin_at,
        c.atencion_iniciada_at,
        c.atencion_finalizada_at,
        c.retraso_inicio_min,
        c.duracion_total_min,
        c.buffer_total_min,
        c.selection_type,
        c.id_paquete,
        c.total_pagar_hnl,
        c.moneda_codigo,
        c.asignada_automaticamente,
        c.notas,
        c.llegada_real_at,
        c.no_show_at,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Sin nombre') AS nombre_barbero,
        ${clientNameSql} AS nombre_cliente
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      JOIN public.personas pc
        ON pc.id_persona = c.id_persona_cliente
      WHERE ${where.join(" AND ")}
      ${forUpdate ? "FOR UPDATE" : ""}
      LIMIT 1
    `,
    params
  );

  if (!rows[0]) {
    throw new AppError(404, "Cita no encontrada dentro de tu alcance", {
      code: "ADMIN_CITAS_NOT_FOUND",
      details: { id_cita: safeId },
    });
  }

  return rows[0];
}

async function listAppointmentServiceIds(client, citaId) {
  const { rows } = await client.query(
    `
      SELECT id_servicio
      FROM public.citas_detalles
      WHERE id_cita = $1::uuid
      ORDER BY id_cita_detalle ASC
    `,
    [citaId]
  );

  return rows.map((row) => row.id_servicio);
}

async function registerEmergencyReschedule(client, payload = {}) {
  const {
    id_cita,
    id_sucursal,
    id_empleado_barbero_anterior,
    id_empleado_barbero_nuevo,
    inicio_at_anterior,
    fin_at_anterior,
    inicio_at_nuevo,
    fin_at_nuevo,
    motivo = null,
    id_usuario_accion = null,
  } = payload;

  await client.query(
    `
      INSERT INTO public.citas_reagendaciones (
        id_cita,
        id_sucursal,
        id_empleado_barbero_anterior,
        id_empleado_barbero_nuevo,
        inicio_at_anterior,
        fin_at_anterior,
        inicio_at_nuevo,
        fin_at_nuevo,
        motivo,
        tipo_reagendacion_codigo,
        id_usuario_accion
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::timestamptz,
        $6::timestamptz,
        $7::timestamptz,
        $8::timestamptz,
        $9::text,
        'emergencia',
        $10::uuid
      )
    `,
    [
      id_cita,
      id_sucursal,
      id_empleado_barbero_anterior,
      id_empleado_barbero_nuevo,
      inicio_at_anterior,
      fin_at_anterior,
      inicio_at_nuevo,
      fin_at_nuevo,
      cleanText(motivo),
      id_usuario_accion,
    ]
  );
}

async function performEmergencyReschedule(client, {
  appointment,
  fechaInicioNueva,
  idBarberoNuevo = null,
  motivo = null,
  actorUsuarioId = null,
} = {}) {
  const serviceIds = await listAppointmentServiceIds(client, appointment.id_cita);
  if (!serviceIds.length) {
    throw new AppError(409, "La cita no tiene servicios para recalcular agenda", {
      code: "ADMIN_CITAS_REBOOK_SERVICES_MISSING",
      details: { id_cita: appointment.id_cita },
    });
  }

  const selection = await resolveBookingSelection(client, {
    id_sucursal: appointment.id_sucursal,
    servicios: serviceIds,
    fecha_inicio: fechaInicioNueva,
    id_barbero: idBarberoNuevo,
  });

  const totalMinutes = Number(selection.serviceSelection.duracion_total_min || 0);
  const finAtNuevo = new Date(selection.startDateTime.getTime() + totalMinutes * 60 * 1000);
  const estadoActual = String(appointment.estado_cita_codigo || "");
  const estadoDestino = estadoActual === "en_salon" ? "confirmada" : estadoActual;

  await client.query(
    `
      UPDATE public.citas
      SET id_empleado_barbero = $2::uuid,
          asignada_automaticamente = $3::boolean,
          inicio_at = $4::timestamptz,
          fin_at = $5::timestamptz,
          duracion_total_min = $6::int,
          buffer_total_min = $7::int,
          estado_cita_codigo = $8::text,
          no_show_at = NULL,
          updated_at = now()
      WHERE id_cita = $1::uuid
    `,
    [
      appointment.id_cita,
      selection.barber.id_empleado,
      !idBarberoNuevo,
      selection.startDateTime.toISOString(),
      finAtNuevo.toISOString(),
      Number(selection.serviceSelection.duracion_total_min || appointment.duracion_total_min || 0),
      Number(selection.serviceSelection.buffer_total_min || appointment.buffer_total_min || 0),
      estadoDestino,
    ]
  );

  await registerEmergencyReschedule(client, {
    id_cita: appointment.id_cita,
    id_sucursal: appointment.id_sucursal,
    id_empleado_barbero_anterior: appointment.id_empleado_barbero,
    id_empleado_barbero_nuevo: selection.barber.id_empleado,
    inicio_at_anterior: appointment.inicio_at,
    fin_at_anterior: appointment.fin_at,
    inicio_at_nuevo: selection.startDateTime.toISOString(),
    fin_at_nuevo: finAtNuevo.toISOString(),
    motivo,
    id_usuario_accion: actorUsuarioId,
  });

  return {
    id_cita: appointment.id_cita,
    id_sucursal: appointment.id_sucursal,
    id_empleado_barbero_anterior: appointment.id_empleado_barbero,
    id_empleado_barbero_nuevo: selection.barber.id_empleado,
    nombre_barbero_nuevo: selection.barber.nombre_completo,
    inicio_at_anterior: new Date(appointment.inicio_at).toISOString(),
    fin_at_anterior: new Date(appointment.fin_at).toISOString(),
    inicio_at_nuevo: selection.startDateTime.toISOString(),
    fin_at_nuevo: finAtNuevo.toISOString(),
    estado_cita_codigo: estadoDestino,
    reasignada_automaticamente: !idBarberoNuevo,
  };
}

function calculateDelayMinutes({ plannedStart, actualStart }) {
  const planned = new Date(plannedStart);
  const actual = new Date(actualStart);
  if (Number.isNaN(planned.getTime()) || Number.isNaN(actual.getTime())) return 0;
  return Math.max(0, Math.round((actual.getTime() - planned.getTime()) / 60000));
}

function formatDateTimeInHonduras(isoDateTime) {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) return "N/D";
  return parsed.toLocaleString("es-HN", {
    timeZone: OPERATIONAL_TIMEZONE,
    hour12: true,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function queueOperationalDelayNotifications(client, {
  affectedAppointments = [],
  retrasoMin = 0,
} = {}) {
  const targets = Array.isArray(affectedAppointments) ? affectedAppointments : [];
  for (const item of targets) {
    const targetEmail = String(item?.correo_cliente || "").trim().toLowerCase();
    if (!targetEmail) continue;
    const oldStart = formatDateTimeInHonduras(item.inicio_at_anterior);
    const newStart = formatDateTimeInHonduras(item.inicio_at_nuevo);
    const subject = `Actualizacion de cita - ${item.nombre_sucursal || "MasterFade"}`;
    const body = [
      `Hola ${item.nombre_cliente || "Cliente"},`,
      "",
      "Te informamos un ajuste operativo en tu cita.",
      `Hora original: ${oldStart}`,
      `Nueva hora: ${newStart}`,
      `Sucursal: ${item.nombre_sucursal || "N/D"}`,
      `Barbero: ${item.nombre_barbero || "N/D"}`,
      `Ajuste aplicado: +${Number(retrasoMin || 0)} minutos por retraso operativo.`,
      "",
      "Gracias por tu comprension.",
      "Equipo MasterFade",
    ].join("\n");

    await client.query(
      `
        INSERT INTO public.notificaciones_email (
          evento,
          correo_destino,
          asunto,
          cuerpo,
          estado_notificacion_codigo,
          id_cita
        )
        VALUES (
          'cita_retraso_operativo',
          $1::text,
          $2::text,
          $3::text,
          'pendiente',
          $4::uuid
        )
      `,
      [targetEmail, subject, body, item.id_cita]
    );
  }
}

async function propagateOperationalDelay(client, {
  citaCausante,
  retrasoMin = 0,
  actorUsuarioId = null,
} = {}) {
  const safeDelay = Math.max(0, Number(retrasoMin || 0));
  if (!citaCausante?.id_cita || safeDelay < OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES) {
    return {
      propagated: false,
      threshold_min: OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES,
      retraso_min: safeDelay,
      affected: [],
      id_lote_reagendacion: null,
      notifications_enqueued: 0,
    };
  }

  const affectedResult = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_sucursal,
        c.id_empleado_barbero,
        c.inicio_at,
        c.fin_at,
        c.duracion_total_min,
        c.buffer_total_min,
        COALESCE(NULLIF(TRIM(CONCAT(pc.nombres, ' ', pc.apellidos)), ''), 'Cliente') AS nombre_cliente,
        COALESCE(c.contacto_email, cp.email) AS correo_cliente,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Barbero') AS nombre_barbero,
        s.nombre_sucursal
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.personas pc
        ON pc.id_persona = c.id_persona_cliente
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      LEFT JOIN LATERAL (
        SELECT c2.direccion_correo::text AS email
        FROM public.correos c2
        WHERE c2.id_persona = c.id_persona_cliente
          AND c2.deleted_at IS NULL
        ORDER BY c2.es_principal DESC NULLS LAST, c2.verificado DESC NULLS LAST, c2.id_correo ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE c.deleted_at IS NULL
        AND c.id_empleado_barbero = $1::uuid
        AND c.id_cita <> $2::uuid
        AND c.estado_cita_codigo = ANY($3::text[])
        AND c.inicio_at > $4::timestamptz
        AND (c.inicio_at AT TIME ZONE '${OPERATIONAL_TIMEZONE}')::date = ($4::timestamptz AT TIME ZONE '${OPERATIONAL_TIMEZONE}')::date
      ORDER BY c.inicio_at ASC, c.id_cita ASC
      FOR UPDATE
    `,
    [
      citaCausante.id_empleado_barbero,
      citaCausante.id_cita,
      OPERATIONAL_DELAY_AFFECTED_STATES,
      citaCausante.inicio_at,
    ]
  );

  if (!affectedResult.rows.length) {
    return {
      propagated: false,
      threshold_min: OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES,
      retraso_min: safeDelay,
      affected: [],
      id_lote_reagendacion: null,
      notifications_enqueued: 0,
    };
  }

  const { rows: loteRows } = await client.query(`SELECT gen_random_uuid() AS id_lote_reagendacion`);
  const loteId = loteRows[0]?.id_lote_reagendacion ?? null;
  const affected = [];

  for (const row of affectedResult.rows) {
    const inicioAnterior = new Date(row.inicio_at);
    const finAnterior = new Date(row.fin_at);
    const inicioNuevo = new Date(inicioAnterior.getTime() + safeDelay * 60 * 1000);
    const finNuevo = new Date(finAnterior.getTime() + safeDelay * 60 * 1000);

    await client.query(
      `
        UPDATE public.citas
        SET inicio_at = $2::timestamptz,
            fin_at = $3::timestamptz,
            updated_at = now()
        WHERE id_cita = $1::uuid
      `,
      [row.id_cita, inicioNuevo.toISOString(), finNuevo.toISOString()]
    );

    await client.query(
      `
        INSERT INTO public.citas_reagendaciones (
          id_cita,
          id_sucursal,
          id_empleado_barbero_anterior,
          id_empleado_barbero_nuevo,
          inicio_at_anterior,
          fin_at_anterior,
          inicio_at_nuevo,
          fin_at_nuevo,
          motivo,
          tipo_reagendacion_codigo,
          id_usuario_accion,
          id_cita_causante,
          id_lote_reagendacion,
          retraso_min
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $3::uuid,
          $4::timestamptz,
          $5::timestamptz,
          $6::timestamptz,
          $7::timestamptz,
          $8::text,
          'retraso_operativo',
          $9::uuid,
          $10::uuid,
          $11::uuid,
          $12::int
        )
      `,
      [
        row.id_cita,
        row.id_sucursal,
        row.id_empleado_barbero,
        inicioAnterior.toISOString(),
        finAnterior.toISOString(),
        inicioNuevo.toISOString(),
        finNuevo.toISOString(),
        `Reprogramacion automatica por retraso operativo de ${safeDelay} min`,
        actorUsuarioId,
        citaCausante.id_cita,
        loteId,
        safeDelay,
      ]
    );

    affected.push({
      id_cita: row.id_cita,
      nombre_cliente: row.nombre_cliente,
      correo_cliente: row.correo_cliente,
      nombre_barbero: row.nombre_barbero,
      nombre_sucursal: row.nombre_sucursal,
      inicio_at_anterior: inicioAnterior.toISOString(),
      inicio_at_nuevo: inicioNuevo.toISOString(),
      fin_at_anterior: finAnterior.toISOString(),
      fin_at_nuevo: finNuevo.toISOString(),
    });
  }

  await queueOperationalDelayNotifications(client, {
    affectedAppointments: affected,
    retrasoMin: safeDelay,
  });

  return {
    propagated: true,
    threshold_min: OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES,
    retraso_min: safeDelay,
    affected,
    id_lote_reagendacion: loteId,
    notifications_enqueued: affected.length,
  };
}

async function getEmployeeInScope(client, idEmpleado, branchIds) {
  const safeId = assertUuid(idEmpleado, "id_empleado");
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        e.es_barbero,
        s.nombre_sucursal,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
      FROM public.empleados e
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
      WHERE e.id_empleado = $1::uuid
        AND e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.id_sucursal = ANY($2::uuid[])
      LIMIT 1
    `,
    [safeId, branchIds]
  );
  if (!rows[0]) {
    throw new AppError(404, "Empleado no encontrado en tu alcance", {
      code: "ADMIN_CITAS_EMPLOYEE_NOT_FOUND",
      details: { id_empleado: safeId },
    });
  }
  return mapEmployeeRow(rows[0]);
}

async function listBarbersByBranchInScope(client, branchIds, idSucursal) {
  const safeBranch = assertUuid(idSucursal, "id_sucursal");
  if (!branchIds.includes(safeBranch)) {
    throw new AppError(403, "Sucursal fuera de tu alcance", {
      code: "ADMIN_CITAS_BRANCH_FORBIDDEN",
      details: { id_sucursal: safeBranch },
    });
  }

  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        e.es_barbero,
        s.nombre_sucursal,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
      FROM public.empleados e
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
      WHERE e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND e.id_sucursal = $1::uuid
      ORDER BY nombre_completo ASC
    `,
    [safeBranch]
  );

  return rows.map(mapEmployeeRow);
}

function groupBranchDayOffs(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = [
      item.id_sucursal,
      item.inicio_at,
      item.fin_at,
      item.tipo_bloqueo_codigo,
      item.motivo || "",
    ].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...item,
        id_empleado: null,
        nombre_completo: null,
        total_barberos: 1,
      });
      continue;
    }
    const current = grouped.get(key);
    current.total_barberos += 1;
  }
  return Array.from(grouped.values());
}

async function listBlocks(client, branchIds, { idEmpleado, idSucursal, fechaDesde, fechaHasta } = {}) {
  const params = [branchIds];
  const where = ["b.id_sucursal = ANY($1::uuid[])"];

  if (idEmpleado) {
    params.push(assertUuid(idEmpleado, "id_empleado"));
    where.push(`b.id_empleado = $${params.length}::uuid`);
  }
  if (idSucursal) {
    const safeBranch = assertUuid(idSucursal, "id_sucursal");
    if (!branchIds.includes(safeBranch)) {
      throw new AppError(403, "Sucursal fuera de tu alcance", {
        code: "ADMIN_CITAS_BRANCH_FORBIDDEN",
        details: { id_sucursal: safeBranch },
      });
    }
    params.push(safeBranch);
    where.push(`b.id_sucursal = $${params.length}::uuid`);
  }
  if (fechaDesde || fechaHasta) {
    const desde = parseDateOnly(fechaDesde || fechaHasta, "fecha_desde");
    const hasta = parseDateOnly(fechaHasta || fechaDesde, "fecha_hasta");
    const from = new Date(`${desde}T00:00:00`).toISOString();
    const to = new Date(new Date(`${hasta}T00:00:00`).getTime() + 24 * 60 * 60 * 1000).toISOString();
    params.push(from);
    const fromI = params.length;
    params.push(to);
    const toI = params.length;
    where.push(`b.rango && tstzrange($${fromI}::timestamptz, $${toI}::timestamptz, '[)')`);
  }

  const { rows } = await client.query(
    `
      SELECT
        b.id_bloqueo,
        b.id_empleado,
        b.id_sucursal,
        b.tipo_bloqueo_codigo,
        b.motivo,
        lower(b.rango) AS inicio_at,
        upper(b.rango) AS fin_at,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo,
        s.nombre_sucursal
      FROM public.bloqueos_agenda b
      JOIN public.empleados e ON e.id_empleado = b.id_empleado
      JOIN public.personas p ON p.id_persona = e.id_persona
      JOIN public.sucursales s ON s.id_sucursal = b.id_sucursal
      WHERE ${where.join(" AND ")}
      ORDER BY lower(b.rango) ASC, b.id_bloqueo ASC
    `,
    params
  );

  return rows.map(mapBlockRow);
}

async function ensureBlockType(client, code) {
  const safeCode = cleanText(code);
  if (!safeCode) {
    throw new AppError(400, "tipo_bloqueo_codigo es obligatorio", {
      code: "ADMIN_CITAS_BLOCK_TYPE_REQUIRED",
    });
  }
  const { rows } = await client.query(
    `SELECT tipo_bloqueo_codigo FROM public.tipos_bloqueo_agenda WHERE tipo_bloqueo_codigo = $1 LIMIT 1`,
    [safeCode]
  );
  if (!rows[0]) {
    throw new AppError(404, "tipo_bloqueo_codigo no existe", {
      code: "ADMIN_CITAS_BLOCK_TYPE_NOT_FOUND",
    });
  }
  return safeCode;
}

async function getDayOffType(client) {
  const preferred = ["dia_inhabilitado", "inhabilitado", "bloqueo_dia", "full_day", "vacaciones", "permiso"];
  const found = await client.query(
    `
      SELECT tipo_bloqueo_codigo
      FROM public.tipos_bloqueo_agenda
      WHERE tipo_bloqueo_codigo = ANY($1::text[])
      ORDER BY array_position($1::text[], tipo_bloqueo_codigo)
      LIMIT 1
    `,
    [preferred]
  );
  if (found.rows[0]) return found.rows[0].tipo_bloqueo_codigo;

  const fallback = await client.query(
    `SELECT tipo_bloqueo_codigo FROM public.tipos_bloqueo_agenda ORDER BY tipo_bloqueo_codigo ASC LIMIT 1`
  );
  if (!fallback.rows[0]) {
    throw new AppError(409, "No existe catalogo de tipos de bloqueo", {
      code: "ADMIN_CITAS_BLOCK_TYPE_CATALOG_EMPTY",
    });
  }
  return fallback.rows[0].tipo_bloqueo_codigo;
}

export default async function adminCitasRoutes(app) {
  app.get("/operativas/contexto", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await expireStaleAppointmentReservations(app.db, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);

      const operationalDate = getCurrentDateInTimeZone() || new Date().toISOString().slice(0, 10);
      const [sucursalesResult, barberosResult, estadosResult, retrasoResumenResult] = await Promise.all([
        app.db.query(
          `
            SELECT id_sucursal, nombre_sucursal
            FROM public.sucursales
            WHERE id_sucursal = ANY($1::uuid[])
            ORDER BY nombre_sucursal ASC
          `,
          [branchIds]
        ),
        app.db.query(
          `
            SELECT
              e.id_empleado,
              e.id_sucursal,
              COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
            FROM public.empleados e
            JOIN public.personas p
              ON p.id_persona = e.id_persona
            WHERE e.deleted_at IS NULL
              AND e.estado IS TRUE
              AND e.es_barbero IS TRUE
              AND e.id_sucursal = ANY($1::uuid[])
              ${roleScope.barber_empleado_id ? "AND e.id_empleado = $2::uuid" : ""}
            ORDER BY nombre_completo ASC
          `,
          roleScope.barber_empleado_id ? [branchIds, roleScope.barber_empleado_id] : [branchIds]
        ),
        app.db.query(
          `
            SELECT estado_cita_codigo, descripcion
            FROM public.estados_cita
            ORDER BY estado_cita_codigo ASC
          `
        ),
        app.db.query(
          `
            SELECT
              COUNT(*) FILTER (
                WHERE cr.tipo_reagendacion_codigo = 'retraso_operativo'
              )::int AS citas_reagendadas_hoy,
              COUNT(*) FILTER (
                WHERE ne.evento = 'cita_retraso_operativo'
                  AND ne.estado_notificacion_codigo = 'pendiente'
              )::int AS notificaciones_pendientes_hoy
            FROM public.citas_reagendaciones cr
            LEFT JOIN public.notificaciones_email ne
              ON ne.id_cita = cr.id_cita
            LEFT JOIN public.citas cc
              ON cc.id_cita = cr.id_cita
            WHERE (cr.created_at AT TIME ZONE '${OPERATIONAL_TIMEZONE}')::date = $1::date
              AND cc.id_sucursal = ANY($2::uuid[])
              ${roleScope.barber_empleado_id ? "AND cc.id_empleado_barbero = $3::uuid" : ""}
          `,
          roleScope.barber_empleado_id
            ? [operationalDate, branchIds, roleScope.barber_empleado_id]
            : [operationalDate, branchIds]
        ),
      ]);

      return sendOk(reply, {
        sucursales: sucursalesResult.rows,
        barberos: barberosResult.rows,
        estados: estadosResult.rows,
        estados_operativos_default: OPERATIONAL_APPOINTMENT_STATES,
        retraso_operativo: {
          fecha_operativa: operationalDate,
          umbral_propagacion_min: OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES,
          umbral_alerta_fin_min: FINISH_ALERT_THRESHOLD_MINUTES,
          citas_reagendadas_hoy: Number(retrasoResumenResult.rows[0]?.citas_reagendadas_hoy || 0),
          notificaciones_pendientes_hoy: Number(retrasoResumenResult.rows[0]?.notificaciones_pendientes_hoy || 0),
        },
      });
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo consultar el contexto operativo de citas",
        "ADMIN_CITAS_OPERATIVE_CONTEXT_ERROR"
      );
    }
  });

  app.get("/operativas", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await expireStaleAppointmentReservations(app.db, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const { fechaDesde, fechaHasta } = resolveDateRange(request.query || {});
      const states = parseStatusFilter(request.query?.estado, OPERATIONAL_APPOINTMENT_STATES);
      const citas = await listOperationalAppointments(app.db, {
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        idSucursal: request.query?.id_sucursal ?? null,
        idEmpleadoBarbero: request.query?.id_empleado_barbero ?? null,
        states,
        q: cleanText(request.query?.q),
        fechaDesde,
        fechaHasta,
        limit: parseLimit(request.query?.limit, 120, 400),
      });
      return sendOk(reply, {
        citas,
        filtros: {
          id_sucursal: request.query?.id_sucursal ?? null,
          id_empleado_barbero: request.query?.id_empleado_barbero ?? null,
          estado: states,
          fecha_desde: fechaDesde,
          fecha_hasta: fechaHasta,
          q: cleanText(request.query?.q),
        },
      });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar las citas operativas", "ADMIN_CITAS_OPERATIVE_LIST_ERROR");
    }
  });

  app.get("/operativas/completadas-hoy", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await expireStaleAppointmentReservations(app.db, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const operationalDate = getCurrentDateInTimeZone();
      if (!operationalDate) {
        throw new AppError(500, "No fue posible resolver la fecha operativa actual", {
          code: "ADMIN_CITAS_TODAY_RESOLUTION_FAILED",
        });
      }

      const citas = await listOperationalAppointments(app.db, {
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        idSucursal: request.query?.id_sucursal ?? null,
        idEmpleadoBarbero: request.query?.id_empleado_barbero ?? null,
        states: ["completada"],
        q: cleanText(request.query?.q),
        fechaDesde: operationalDate,
        fechaHasta: operationalDate,
        limit: parseLimit(request.query?.limit, 200, 300),
        sortDirection: "desc",
      });

      return sendOk(reply, {
        citas,
        fecha_operativa: operationalDate,
        filtros: {
          id_sucursal: request.query?.id_sucursal ?? null,
          id_empleado_barbero: request.query?.id_empleado_barbero ?? null,
          estado: ["completada"],
          fecha_desde: operationalDate,
          fecha_hasta: operationalDate,
          q: cleanText(request.query?.q),
        },
      });
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudieron consultar las citas completadas de hoy",
        "ADMIN_CITAS_OPERATIVE_COMPLETED_TODAY_ERROR"
      );
    }
  });

  app.get("/historial", { preHandler: app.requireRoles(HISTORY_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await expireStaleAppointmentReservations(app.db, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const { fechaDesde, fechaHasta } = resolveDateRange(request.query || {});
      const states = parseStatusFilter(request.query?.estado, []);
      const citas = await listOperationalAppointments(app.db, {
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        idSucursal: request.query?.id_sucursal ?? null,
        idEmpleadoBarbero: request.query?.id_empleado_barbero ?? null,
        states,
        q: cleanText(request.query?.q),
        fechaDesde,
        fechaHasta,
        limit: parseLimit(request.query?.limit, 200, 500),
        sortDirection: "desc",
      });
      return sendOk(reply, {
        citas,
        filtros: {
          id_sucursal: request.query?.id_sucursal ?? null,
          id_empleado_barbero: request.query?.id_empleado_barbero ?? null,
          estado: states,
          fecha_desde: fechaDesde,
          fecha_hasta: fechaHasta,
          q: cleanText(request.query?.q),
        },
        estados_historicos_sugeridos: HISTORICAL_DEFAULT_STATES,
      });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el historial de citas", "ADMIN_CITAS_HISTORY_LIST_ERROR");
    }
  });

  app.patch("/:id_cita/estado", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idCita = assertUuid(request.params?.id_cita, "id_cita");
      const estadoDestino = cleanText(request.body?.estado_cita_codigo);
      if (!estadoDestino) {
        throw new AppError(400, "estado_cita_codigo es obligatorio", {
          code: "ADMIN_CITAS_STATUS_REQUIRED",
        });
      }

      await dbClient.query("BEGIN");
      const cita = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        forUpdate: true,
      });
      const estadoOrigen = String(cita.estado_cita_codigo || "");
      const allowedTargets = APPOINTMENT_STATE_TRANSITIONS[estadoOrigen] || [];
      if (!allowedTargets.includes(estadoDestino)) {
        throw new AppError(409, "Transicion de estado no permitida", {
          code: "ADMIN_CITAS_STATUS_TRANSITION_INVALID",
          details: {
            id_cita: idCita,
            estado_origen: estadoOrigen,
            estado_destino: estadoDestino,
            permitidos: allowedTargets,
          },
        });
      }

      if (["en_salon", "completada", "no_show"].includes(estadoDestino)) {
        const inicioAt = new Date(cita.inicio_at);
        const now = new Date();
        const threshold = subMinutes(inicioAt, STATUS_CHANGE_WINDOW_MINUTES);
        if (Number.isNaN(inicioAt.getTime())) {
          throw new AppError(409, "La cita no tiene una hora de inicio válida para cambiar de estado", {
            code: "ADMIN_CITAS_STATUS_START_INVALID",
            details: { id_cita: idCita },
          });
        }
        if (now.getTime() < threshold.getTime()) {
          throw new AppError(
            409,
            `Solo puedes cambiar el estado ${STATUS_CHANGE_WINDOW_MINUTES} minutos antes de la hora de la cita`,
            {
              code: "ADMIN_CITAS_STATUS_WINDOW_NOT_OPEN",
              details: {
                id_cita: idCita,
                estado_destino: estadoDestino,
                inicio_at: inicioAt.toISOString(),
                permitido_desde: threshold.toISOString(),
              },
            }
          );
        }
      }

      let consumoMembresia = null;
      if (estadoDestino === "completada") {
        consumoMembresia = await consumeMembershipForCompletedAppointment(dbClient, {
          idCita,
          idCliente: cita.id_cliente ?? null,
          idSucursal: cita.id_sucursal,
          ordenIntegrante: cita.orden_integrante ?? null,
          usuarioEjecutorId: roleScope.actor_usuario_id ?? null,
        });
      }

      await dbClient.query(
        `
          UPDATE public.citas
          SET estado_cita_codigo = $2::text,
              llegada_real_at = CASE
                WHEN $2::text = 'en_salon' AND llegada_real_at IS NULL THEN now()
                ELSE llegada_real_at
              END,
              no_show_at = CASE
                WHEN $2::text = 'no_show' THEN now()
                WHEN $2::text <> 'no_show' THEN NULL
                ELSE no_show_at
              END,
              updated_at = now()
          WHERE id_cita = $1::uuid
        `,
        [idCita, estadoDestino]
      );

      if (["cancelada", "expirada"].includes(estadoDestino)) {
        await dbClient.query(
          `
            UPDATE public.citas_holds
            SET estado_hold_codigo = CASE
              WHEN $2::text = 'expirada' THEN 'expirado'
              ELSE 'cancelado'
            END,
            updated_at = now()
            WHERE id_cita = $1::uuid
              AND estado_hold_codigo = 'activo'
          `,
          [idCita, estadoDestino]
        );
        await dbClient.query(
          `
            UPDATE public.payment_intents
            SET estado_intent_codigo = 'expirado',
                updated_at = now()
            WHERE id_cita = $1::uuid
              AND estado_intent_codigo = ANY($2::text[])
          `,
          [idCita, ACTIVE_PAYMENT_INTENT_STATES]
        );
      }

      const updated = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
      });
      await dbClient.query("COMMIT");
      return sendOk(reply, {
        cita: mapOperationalAppointment(updated),
        transicion: {
          estado_origen: estadoOrigen,
          estado_destino: estadoDestino,
        },
        consumo_membresia: consumoMembresia,
      });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo actualizar el estado de la cita", "ADMIN_CITAS_STATUS_PATCH_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.post("/:id_cita/registrar-llegada", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idCita = assertUuid(request.params?.id_cita, "id_cita");

      await dbClient.query("BEGIN");
      const cita = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        forUpdate: true,
      });

      const estadoActual = String(cita.estado_cita_codigo || "");
      if (estadoActual !== "confirmada") {
        throw new AppError(409, "La cita no se puede marcar en salon en su estado actual", {
          code: "ADMIN_CITAS_ARRIVAL_STATE_INVALID",
          details: { id_cita: idCita, estado_cita_codigo: estadoActual },
        });
      }

      const now = new Date();
      await dbClient.query(
        `
          UPDATE public.citas
          SET estado_cita_codigo = 'en_salon',
              llegada_real_at = COALESCE(llegada_real_at, $2::timestamptz),
              updated_at = now()
          WHERE id_cita = $1::uuid
        `,
        [idCita, now.toISOString()]
      );

      const citaActualizada = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
      });

      await dbClient.query("COMMIT");
      return sendOk(reply, {
        cita: mapOperationalAppointment(citaActualizada),
        llegada: {
          registrada_at: citaActualizada.llegada_real_at
            ? new Date(citaActualizada.llegada_real_at).toISOString()
            : now.toISOString(),
        },
      });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo registrar la llegada de la cita", "ADMIN_CITAS_REGISTER_ARRIVAL_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.post("/:id_cita/iniciar-atencion", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idCita = assertUuid(request.params?.id_cita, "id_cita");

      await dbClient.query("BEGIN");
      const cita = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        forUpdate: true,
      });

      const estadoActual = String(cita.estado_cita_codigo || "");
      if (estadoActual !== "en_salon") {
        throw new AppError(409, "La cita debe estar en salon para iniciar atencion", {
          code: "ADMIN_CITAS_START_ATTENTION_STATE_INVALID",
          details: { id_cita: idCita, estado_cita_codigo: estadoActual },
        });
      }

      const now = new Date();
      const retrasoMin = calculateDelayMinutes({
        plannedStart: cita.inicio_at,
        actualStart: now.toISOString(),
      });

      await dbClient.query(
        `
          UPDATE public.citas
          SET estado_cita_codigo = 'en_atencion',
              atencion_iniciada_at = COALESCE(atencion_iniciada_at, $2::timestamptz),
              retraso_inicio_min = $3::int,
              updated_at = now()
          WHERE id_cita = $1::uuid
        `,
        [idCita, now.toISOString(), retrasoMin]
      );

      const citaActualizada = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
      });

      const propagation = await propagateOperationalDelay(dbClient, {
        citaCausante: citaActualizada,
        retrasoMin,
        actorUsuarioId: roleScope.actor_usuario_id,
      });

      await dbClient.query("COMMIT");
      return sendOk(reply, {
        cita: mapOperationalAppointment(citaActualizada),
        atencion: {
          iniciada_at: citaActualizada.atencion_iniciada_at
            ? new Date(citaActualizada.atencion_iniciada_at).toISOString()
            : now.toISOString(),
          retraso_inicio_min: retrasoMin,
          umbral_propagacion_min: OPERATIONAL_DELAY_PROPAGATION_THRESHOLD_MINUTES,
        },
        propagacion_retraso: propagation,
      });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo iniciar la atencion", "ADMIN_CITAS_START_ATTENTION_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.post("/:id_cita/finalizar-atencion", { preHandler: app.requireRoles(OPERATIONAL_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idCita = assertUuid(request.params?.id_cita, "id_cita");

      await dbClient.query("BEGIN");
      const cita = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        forUpdate: true,
      });

      if (String(cita.estado_cita_codigo || "") !== "en_atencion") {
        throw new AppError(409, "Solo puedes finalizar citas en atencion", {
          code: "ADMIN_CITAS_FINISH_ATTENTION_STATE_INVALID",
          details: { id_cita: idCita, estado_cita_codigo: cita.estado_cita_codigo },
        });
      }

      const consumoMembresia = await consumeMembershipForCompletedAppointment(dbClient, {
        idCita,
        idCliente: cita.id_cliente ?? null,
        idSucursal: cita.id_sucursal,
        ordenIntegrante: cita.orden_integrante ?? null,
        usuarioEjecutorId: roleScope.actor_usuario_id ?? null,
      });

      const now = new Date();
      await dbClient.query(
        `
          UPDATE public.citas
          SET estado_cita_codigo = 'completada',
              atencion_finalizada_at = COALESCE(atencion_finalizada_at, $2::timestamptz),
              updated_at = now()
          WHERE id_cita = $1::uuid
        `,
        [idCita, now.toISOString()]
      );

      const citaActualizada = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
      });

      await dbClient.query("COMMIT");
      return sendOk(reply, {
        cita: mapOperationalAppointment(citaActualizada),
        atencion: {
          iniciada_at: citaActualizada.atencion_iniciada_at
            ? new Date(citaActualizada.atencion_iniciada_at).toISOString()
            : null,
          finalizada_at: citaActualizada.atencion_finalizada_at
            ? new Date(citaActualizada.atencion_finalizada_at).toISOString()
            : now.toISOString(),
          retraso_inicio_min: Number(citaActualizada.retraso_inicio_min || 0),
        },
        consumo_membresia: consumoMembresia,
      });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo finalizar la atencion", "ADMIN_CITAS_FINISH_ATTENTION_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.get("/reagendacion/afectadas", { preHandler: app.requireRoles(EMERGENCY_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await expireStaleAppointmentReservations(app.db, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const fecha = parseDateOnly(request.query?.fecha, "fecha");
      const idBarbero = cleanText(request.query?.id_empleado_barbero) || roleScope.barber_empleado_id;
      if (!idBarbero) {
        throw new AppError(400, "id_empleado_barbero es obligatorio", {
          code: "ADMIN_CITAS_EMERGENCY_BARBER_REQUIRED",
        });
      }
      if (roleScope.barber_empleado_id && idBarbero !== roleScope.barber_empleado_id) {
        throw new AppError(403, "No puedes consultar citas de otro barbero", {
          code: "ADMIN_CITAS_EMERGENCY_BARBER_FORBIDDEN",
        });
      }

      await getEmployeeInScope(app.db, idBarbero, branchIds);
      const citas = await listOperationalAppointments(app.db, {
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        idEmpleadoBarbero: idBarbero,
        idSucursal: request.query?.id_sucursal ?? null,
        states: OPERATIONAL_APPOINTMENT_STATES,
        fechaDesde: fecha,
        fechaHasta: fecha,
        limit: parseLimit(request.query?.limit, 300, 500),
      });

      return sendOk(reply, {
        id_empleado_barbero: idBarbero,
        fecha,
        citas_afectadas: citas,
      });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar las citas afectadas", "ADMIN_CITAS_EMERGENCY_AFFECTED_ERROR");
    }
  });

  app.post("/:id_cita/reagendar-emergencia", { preHandler: app.requireRoles(EMERGENCY_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idCita = assertUuid(request.params?.id_cita, "id_cita");
      const fechaInicioNueva = new Date(String(request.body?.fecha_inicio_nueva || "").trim());
      if (Number.isNaN(fechaInicioNueva.getTime())) {
        throw new AppError(400, "fecha_inicio_nueva debe ser una fecha-hora valida", {
          code: "ADMIN_CITAS_EMERGENCY_DATETIME_INVALID",
        });
      }

      const idBarberoNuevo = cleanText(request.body?.id_empleado_barbero_nuevo);
      await dbClient.query("BEGIN");

      const cita = await getScopedAppointment(dbClient, {
        idCita,
        branchIds,
        barberScopeId: roleScope.barber_empleado_id,
        forUpdate: true,
      });
      if (!OPERATIONAL_APPOINTMENT_STATES.includes(String(cita.estado_cita_codigo || ""))) {
        throw new AppError(409, "Solo se pueden reagendar citas activas", {
          code: "ADMIN_CITAS_EMERGENCY_STATE_INVALID",
          details: { estado_cita_codigo: cita.estado_cita_codigo },
        });
      }

      if (idBarberoNuevo) {
        const empleadoNuevo = await getEmployeeInScope(dbClient, idBarberoNuevo, branchIds);
        if (!empleadoNuevo.es_barbero) {
          throw new AppError(409, "El empleado de destino no es barbero", {
            code: "ADMIN_CITAS_EMERGENCY_TARGET_NOT_BARBER",
          });
        }
      }

      const resultado = await performEmergencyReschedule(dbClient, {
        appointment: cita,
        fechaInicioNueva: fechaInicioNueva.toISOString(),
        idBarberoNuevo,
        motivo: cleanText(request.body?.motivo),
        actorUsuarioId: roleScope.actor_usuario_id,
      });

      await dbClient.query("COMMIT");
      return sendOk(reply, { reagendacion: resultado });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo reagendar la cita por emergencia",
        "ADMIN_CITAS_EMERGENCY_REBOOK_ERROR"
      );
    } finally {
      dbClient.release();
    }
  });

  app.post("/reagendar-emergencia/lote", { preHandler: app.requireRoles(EMERGENCY_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await expireStaleAppointmentReservations(dbClient, { logger: request.log });
      const branchIds = await getScopeBranches(app, request.claims);
      const roleScope = getRoleScope(request.claims);
      const idBarbero = cleanText(request.body?.id_empleado_barbero) || roleScope.barber_empleado_id;
      const fecha = parseDateOnly(request.body?.fecha, "fecha");
      const motivoGeneral = cleanText(request.body?.motivo);
      const items = Array.isArray(request.body?.items) ? request.body.items : [];

      if (!idBarbero) {
        throw new AppError(400, "id_empleado_barbero es obligatorio para lote", {
          code: "ADMIN_CITAS_EMERGENCY_BATCH_BARBER_REQUIRED",
        });
      }
      if (roleScope.barber_empleado_id && idBarbero !== roleScope.barber_empleado_id) {
        throw new AppError(403, "No puedes reagendar citas de otro barbero", {
          code: "ADMIN_CITAS_EMERGENCY_BATCH_FORBIDDEN",
        });
      }
      if (!items.length) {
        throw new AppError(400, "Debes enviar al menos un item para reagendar", {
          code: "ADMIN_CITAS_EMERGENCY_BATCH_ITEMS_REQUIRED",
        });
      }

      const seen = new Set();
      for (const item of items) {
        const itemId = assertUuid(item?.id_cita, "id_cita");
        if (seen.has(itemId)) {
          throw new AppError(400, "No se permiten id_cita repetidos en lote", {
            code: "ADMIN_CITAS_EMERGENCY_BATCH_DUPLICATED",
            details: { id_cita: itemId },
          });
        }
        seen.add(itemId);
      }

      await getEmployeeInScope(dbClient, idBarbero, branchIds);
      await dbClient.query("BEGIN");
      const resultados = [];

      for (const item of items) {
        const idCita = assertUuid(item?.id_cita, "id_cita");
        const cita = await getScopedAppointment(dbClient, {
          idCita,
          branchIds,
          barberScopeId: roleScope.barber_empleado_id,
          forUpdate: true,
        });
        if (cita.id_empleado_barbero !== idBarbero) {
          throw new AppError(409, "La cita no pertenece al barbero origen indicado", {
            code: "ADMIN_CITAS_EMERGENCY_BATCH_SOURCE_MISMATCH",
            details: { id_cita: idCita, id_empleado_barbero: cita.id_empleado_barbero, esperado: idBarbero },
          });
        }
        const fechaCita = String(new Date(cita.inicio_at).toISOString()).slice(0, 10);
        if (fechaCita !== fecha) {
          throw new AppError(409, "La cita no pertenece a la fecha origen indicada", {
            code: "ADMIN_CITAS_EMERGENCY_BATCH_DATE_MISMATCH",
            details: { id_cita: idCita, fecha_cita: fechaCita, fecha_origen: fecha },
          });
        }
        if (!OPERATIONAL_APPOINTMENT_STATES.includes(String(cita.estado_cita_codigo || ""))) {
          throw new AppError(409, "Solo se pueden reagendar citas activas", {
            code: "ADMIN_CITAS_EMERGENCY_BATCH_STATE_INVALID",
            details: { id_cita: idCita, estado_cita_codigo: cita.estado_cita_codigo },
          });
        }

        const fechaInicioNueva = new Date(String(item?.fecha_inicio_nueva || "").trim());
        if (Number.isNaN(fechaInicioNueva.getTime())) {
          throw new AppError(400, "Cada item debe incluir fecha_inicio_nueva valida", {
            code: "ADMIN_CITAS_EMERGENCY_BATCH_DATETIME_INVALID",
            details: { id_cita: idCita },
          });
        }
        const idBarberoNuevo = cleanText(item?.id_empleado_barbero_nuevo);
        if (idBarberoNuevo) {
          const destino = await getEmployeeInScope(dbClient, idBarberoNuevo, branchIds);
          if (!destino.es_barbero) {
            throw new AppError(409, "El empleado de destino no es barbero", {
              code: "ADMIN_CITAS_EMERGENCY_BATCH_TARGET_NOT_BARBER",
              details: { id_cita: idCita, id_empleado: idBarberoNuevo },
            });
          }
        }

        const resultado = await performEmergencyReschedule(dbClient, {
          appointment: cita,
          fechaInicioNueva: fechaInicioNueva.toISOString(),
          idBarberoNuevo,
          motivo: cleanText(item?.motivo) || motivoGeneral,
          actorUsuarioId: roleScope.actor_usuario_id,
        });
        resultados.push(resultado);
      }

      await dbClient.query("COMMIT");
      return sendOk(reply, {
        total_reagendadas: resultados.length,
        fecha_origen: fecha,
        id_empleado_barbero_origen: idBarbero,
        resultados,
      });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo completar la reagendacion de emergencia por lote",
        "ADMIN_CITAS_EMERGENCY_BATCH_ERROR"
      );
    } finally {
      dbClient.release();
    }
  });

  app.get("/contexto", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const [sucursales, barberos, tiposBloqueo, params] = await Promise.all([
        app.db.query(
          `SELECT id_sucursal, nombre_sucursal FROM public.sucursales WHERE id_sucursal = ANY($1::uuid[]) ORDER BY nombre_sucursal ASC`,
          [branchIds]
        ),
        app.db.query(
          `
            SELECT e.id_empleado, e.id_sucursal,
                   COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_completo
            FROM public.empleados e
            JOIN public.personas p ON p.id_persona = e.id_persona
            WHERE e.deleted_at IS NULL AND e.estado IS TRUE AND e.es_barbero IS TRUE AND e.id_sucursal = ANY($1::uuid[])
            ORDER BY nombre_completo ASC
          `,
          [branchIds]
        ),
        app.db.query(`SELECT tipo_bloqueo_codigo, descripcion FROM public.tipos_bloqueo_agenda ORDER BY tipo_bloqueo_codigo ASC`),
        getSystemParameters(app.db),
      ]);
      return sendOk(reply, {
        sucursales: sucursales.rows,
        barberos: barberos.rows,
        tipos_bloqueo: tiposBloqueo.rows,
        parametros: selectParams(params),
      });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el contexto de citas admin", "ADMIN_CITAS_CONTEXT_ERROR");
    }
  });

  app.get("/horarios/:id_empleado", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(app.db, request.params.id_empleado, branchIds);
      const { rows } = await app.db.query(
        `
          SELECT id_horario, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
          FROM public.horarios_semanales_empleados
          WHERE id_empleado = $1::uuid
          ORDER BY dia_semana ASC, hora_inicio ASC, id_horario ASC
        `,
        [empleado.id_empleado]
      );
      return sendOk(reply, { empleado, horarios: rows.map(mapScheduleRow) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el horario", "ADMIN_CITAS_HORARIOS_GET_ERROR");
    }
  });

  app.put("/horarios/:id_empleado", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(dbClient, request.params.id_empleado, branchIds);
      const horarios = Array.isArray(request.body?.horarios) ? request.body.horarios : [];

      await dbClient.query("BEGIN");
      await dbClient.query(`DELETE FROM public.horarios_semanales_empleados WHERE id_empleado = $1::uuid`, [empleado.id_empleado]);
      for (const item of horarios) {
        const diaSemana = Number(item.dia_semana);
        if (!Number.isInteger(diaSemana) || diaSemana < 0 || diaSemana > 6) {
          throw new AppError(400, "dia_semana debe estar entre 0 y 6", {
            code: "ADMIN_CITAS_HORARIOS_DAY_INVALID",
          });
        }
        const horaInicio = normalizeTime(item.hora_inicio, "hora_inicio");
        const horaFin = normalizeTime(item.hora_fin, "hora_fin");
        if (horaFin <= horaInicio) {
          throw new AppError(400, "hora_fin debe ser mayor que hora_inicio", {
            code: "ADMIN_CITAS_HORARIOS_RANGE_INVALID",
          });
        }
        const almuerzoInicio = item.almuerzo_inicio == null ? null : normalizeTime(item.almuerzo_inicio, "almuerzo_inicio");
        const almuerzoFin = item.almuerzo_fin == null ? null : normalizeTime(item.almuerzo_fin, "almuerzo_fin");
        if ((almuerzoInicio && !almuerzoFin) || (!almuerzoInicio && almuerzoFin)) {
          throw new AppError(400, "almuerzo_inicio y almuerzo_fin deben enviarse juntos", {
            code: "ADMIN_CITAS_HORARIOS_LUNCH_PAIR_INVALID",
          });
        }

        await dbClient.query(
          `
            INSERT INTO public.horarios_semanales_empleados (
              id_empleado, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
            )
            VALUES ($1::uuid, $2::smallint, $3::time, $4::time, $5::time, $6::time, $7::boolean)
          `,
          [empleado.id_empleado, diaSemana, horaInicio, horaFin, almuerzoInicio, almuerzoFin, item.activo !== false]
        );
      }
      await dbClient.query("COMMIT");

      const refreshed = await dbClient.query(
        `
          SELECT id_horario, dia_semana, hora_inicio, hora_fin, almuerzo_inicio, almuerzo_fin, activo
          FROM public.horarios_semanales_empleados
          WHERE id_empleado = $1::uuid
          ORDER BY dia_semana ASC, hora_inicio ASC, id_horario ASC
        `,
        [empleado.id_empleado]
      );
      return sendOk(reply, { empleado, horarios: refreshed.rows.map(mapScheduleRow) });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo actualizar el horario", "ADMIN_CITAS_HORARIOS_PUT_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.get("/bloqueos", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const bloqueos = await listBlocks(app.db, branchIds, {
        idEmpleado: request.query?.id_empleado ?? null,
        idSucursal: request.query?.id_sucursal ?? null,
        fechaDesde: request.query?.fecha_desde ?? null,
        fechaHasta: request.query?.fecha_hasta ?? null,
      });
      return sendOk(reply, { bloqueos });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los bloqueos", "ADMIN_CITAS_BLOCKS_GET_ERROR");
    }
  });

  app.post("/bloqueos", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const empleado = await getEmployeeInScope(app.db, request.body?.id_empleado, branchIds);
      if (!empleado.es_barbero) {
        throw new AppError(409, "Solo se pueden crear bloqueos para barberos", {
          code: "ADMIN_CITAS_BLOCK_EMPLOYEE_NOT_BARBER",
        });
      }
      if (request.body?.id_sucursal && assertUuid(request.body.id_sucursal, "id_sucursal") !== empleado.id_sucursal) {
        throw new AppError(409, "id_sucursal no coincide con la sucursal del empleado", {
          code: "ADMIN_CITAS_BLOCK_BRANCH_MISMATCH",
        });
      }
      const tipoBloqueo = await ensureBlockType(app.db, request.body?.tipo_bloqueo_codigo);
      const inicioAt = parseDateTime(request.body?.inicio_at, "inicio_at");
      const finAt = parseDateTime(request.body?.fin_at, "fin_at");
      if (finAt.getTime() <= inicioAt.getTime()) {
        throw new AppError(400, "fin_at debe ser mayor que inicio_at", {
          code: "ADMIN_CITAS_BLOCK_RANGE_INVALID",
        });
      }

      const inserted = await app.db.query(
        `
          INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
          VALUES ($1::uuid, $2::uuid, $3::text, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, $7::uuid)
          RETURNING id_bloqueo
        `,
        [
          empleado.id_empleado,
          empleado.id_sucursal,
          tipoBloqueo,
          inicioAt.toISOString(),
          finAt.toISOString(),
          cleanText(request.body?.motivo),
          request.claims?.user?.id_usuario ?? null,
        ]
      );
      const bloqueos = await listBlocks(app.db, branchIds, {});
      const bloqueo = bloqueos.find((item) => item.id_bloqueo === inserted.rows[0]?.id_bloqueo) ?? null;
      return sendOk(reply, { bloqueo }, { statusCode: 201 });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo crear el bloqueo", "ADMIN_CITAS_BLOCKS_POST_ERROR");
    }
  });

  app.delete("/bloqueos", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const idBloqueo = assertUuid(request.query?.id_bloqueo, "id_bloqueo");
      const bloqueos = await listBlocks(app.db, branchIds, {});
      const objetivo = bloqueos.find((item) => item.id_bloqueo === idBloqueo) ?? null;
      if (!objetivo) {
        throw new AppError(404, "Bloqueo no encontrado en tu alcance", {
          code: "ADMIN_CITAS_BLOCK_NOT_FOUND",
        });
      }
      await app.db.query(`DELETE FROM public.bloqueos_agenda WHERE id_bloqueo = $1::uuid`, [idBloqueo]);
      return sendOk(reply, { bloqueo: objetivo });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar el bloqueo", "ADMIN_CITAS_BLOCKS_DELETE_ERROR");
    }
  });

  app.get("/dias-inhabilitados", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const bloqueos = await listBlocks(app.db, branchIds, {
        idEmpleado: request.query?.id_empleado ?? null,
        idSucursal: request.query?.id_sucursal ?? null,
        fechaDesde: request.query?.fecha_desde ?? null,
        fechaHasta: request.query?.fecha_hasta ?? null,
      });
      const diasInhabilitados = bloqueos.filter((item) => item.es_dia_completo);
      if (String(request.query?.scope || "").toLowerCase() === "sucursal") {
        return sendOk(reply, { dias_inhabilitados: groupBranchDayOffs(diasInhabilitados) });
      }
      return sendOk(reply, { dias_inhabilitados: diasInhabilitados });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los dias inhabilitados", "ADMIN_CITAS_DAYS_OFF_GET_ERROR");
    }
  });

  app.post("/dias-inhabilitados", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const fecha = parseDateOnly(request.body?.fecha, "fecha");
      const start = new Date(`${fecha}T00:00:00`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const motivo = cleanText(request.body?.motivo);
      const createdBy = request.claims?.user?.id_usuario ?? null;
      const typeCode = await getDayOffType(dbClient);

      let insertedIds = [];

      await dbClient.query("BEGIN");
      if (request.body?.id_empleado) {
        const empleado = await getEmployeeInScope(dbClient, request.body?.id_empleado, branchIds);
        if (!empleado.es_barbero) {
          throw new AppError(409, "Solo se pueden inhabilitar dias para barberos", {
            code: "ADMIN_CITAS_DAY_OFF_EMPLOYEE_NOT_BARBER",
          });
        }

        if (request.body?.id_sucursal && assertUuid(request.body.id_sucursal, "id_sucursal") !== empleado.id_sucursal) {
          throw new AppError(409, "id_sucursal no coincide con la sucursal del empleado", {
            code: "ADMIN_CITAS_DAY_OFF_BRANCH_MISMATCH",
          });
        }

        const inserted = await dbClient.query(
          `
            INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
            VALUES ($1::uuid, $2::uuid, $3::text, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, $7::uuid)
            RETURNING id_bloqueo
          `,
          [
            empleado.id_empleado,
            empleado.id_sucursal,
            typeCode,
            start.toISOString(),
            end.toISOString(),
            motivo,
            createdBy,
          ]
        );
        insertedIds = inserted.rows.map((row) => row.id_bloqueo);
      } else {
        const barberos = await listBarbersByBranchInScope(dbClient, branchIds, request.body?.id_sucursal);
        if (!barberos.length) {
          throw new AppError(409, "La sucursal no tiene barberos activos para aplicar el cierre", {
            code: "ADMIN_CITAS_BRANCH_DAY_OFF_NO_BARBERS",
          });
        }

        const inserted = await dbClient.query(
          `
            INSERT INTO public.bloqueos_agenda (id_empleado, id_sucursal, tipo_bloqueo_codigo, rango, motivo, creado_por)
            SELECT
              e.id_empleado,
              $1::uuid,
              $2::text,
              tstzrange($3::timestamptz, $4::timestamptz, '[)'),
              $5::text,
              $6::uuid
            FROM public.empleados e
            WHERE e.deleted_at IS NULL
              AND e.estado IS TRUE
              AND e.es_barbero IS TRUE
              AND e.id_sucursal = $1::uuid
              AND NOT EXISTS (
                SELECT 1
                FROM public.bloqueos_agenda b
                WHERE b.id_empleado = e.id_empleado
                  AND b.id_sucursal = $1::uuid
                  AND b.tipo_bloqueo_codigo = $2::text
                  AND b.rango = tstzrange($3::timestamptz, $4::timestamptz, '[)')
                  AND COALESCE(b.motivo, '') = COALESCE($5::text, '')
              )
            RETURNING id_bloqueo
          `,
          [
            barberos[0].id_sucursal,
            typeCode,
            start.toISOString(),
            end.toISOString(),
            motivo,
            createdBy,
          ]
        );
        insertedIds = inserted.rows.map((row) => row.id_bloqueo);
        if (!insertedIds.length) {
          throw new AppError(409, "El cierre por sucursal ya existe para esa fecha", {
            code: "ADMIN_CITAS_BRANCH_DAY_OFF_ALREADY_EXISTS",
          });
        }
      }
      await dbClient.query("COMMIT");

      const blocks = await listBlocks(app.db, branchIds, {
        idSucursal: request.body?.id_sucursal ?? null,
        fechaDesde: fecha,
        fechaHasta: fecha,
      });
      const created = blocks.filter((item) => insertedIds.includes(item.id_bloqueo));
      const grouped = groupBranchDayOffs(created);
      return sendOk(
        reply,
        {
          dia_inhabilitado: created[0] ?? null,
          dias_inhabilitados: grouped,
        },
        { statusCode: 201 }
      );
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudo crear el dia inhabilitado", "ADMIN_CITAS_DAYS_OFF_POST_ERROR");
    } finally {
      dbClient.release();
    }
  });

  app.delete("/dias-inhabilitados", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const branchIds = await getScopeBranches(app, request.claims);
      const idBloqueo = assertUuid(request.query?.id_bloqueo, "id_bloqueo");
      const blocks = await listBlocks(app.db, branchIds, {});
      const dayOff = blocks.find((item) => item.id_bloqueo === idBloqueo) ?? null;
      if (!dayOff) {
        throw new AppError(404, "Dia inhabilitado no encontrado en tu alcance", {
          code: "ADMIN_CITAS_DAY_OFF_NOT_FOUND",
        });
      }
      if (!dayOff.es_dia_completo) {
        throw new AppError(409, "El bloqueo indicado no es de dia completo", {
          code: "ADMIN_CITAS_DAY_OFF_NOT_FULL_DAY",
        });
      }
      const scope = String(request.query?.scope || "").toLowerCase();
      if (scope === "sucursal") {
        const deleted = await app.db.query(
          `
            DELETE FROM public.bloqueos_agenda
            WHERE id_sucursal = $1::uuid
              AND tipo_bloqueo_codigo = $2::text
              AND rango = tstzrange($3::timestamptz, $4::timestamptz, '[)')
              AND COALESCE(motivo, '') = COALESCE($5::text, '')
            RETURNING id_bloqueo
          `,
          [dayOff.id_sucursal, dayOff.tipo_bloqueo_codigo, dayOff.inicio_at, dayOff.fin_at, dayOff.motivo]
        );
        return sendOk(reply, {
          dia_inhabilitado: dayOff,
          bloqueos_eliminados: deleted.rows.length,
        });
      }

      await app.db.query(`DELETE FROM public.bloqueos_agenda WHERE id_bloqueo = $1::uuid`, [idBloqueo]);
      return sendOk(reply, { dia_inhabilitado: dayOff, bloqueos_eliminados: 1 });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo eliminar el dia inhabilitado", "ADMIN_CITAS_DAYS_OFF_DELETE_ERROR");
    }
  });

  app.get("/parametros", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      await getScopeBranches(app, request.claims);
      const values = await getSystemParameters(app.db);
      return sendOk(reply, { parametros: selectParams(values) });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudieron consultar los parametros", "ADMIN_CITAS_PARAMS_GET_ERROR");
    }
  });

  app.patch("/parametros", { preHandler: app.requireRoles(CONFIG_ALLOWED_ROLES) }, async (request, reply) => {
    const dbClient = await app.db.connect();
    try {
      await getScopeBranches(app, request.claims);
      const numericUpdates = [];
      const booleanUpdates = [];
      if (request.body?.hold_duracion_min !== undefined) {
        numericUpdates.push(["hold_duracion_min", Number(request.body.hold_duracion_min), "Duracion en minutos del hold de citas"]);
      }
      if (request.body?.no_show_min !== undefined) {
        numericUpdates.push(["no_show_min", Number(request.body.no_show_min), "Minutos para marcar no_show"]);
      }
      if (request.body?.agenda_buffer_global_min !== undefined) {
        numericUpdates.push([
          "agenda_buffer_global_min",
          Number(request.body.agenda_buffer_global_min),
          "Buffer global en minutos entre citas",
        ]);
      }
      if (request.body?.agenda_min_servicio_vendible_min !== undefined) {
        numericUpdates.push([
          "agenda_min_servicio_vendible_min",
          Number(request.body.agenda_min_servicio_vendible_min),
          "Duracion minima vendible en minutos para evitar huecos huerfanos",
        ]);
      }
      if (request.body?.permitir_acompanantes !== undefined) {
        booleanUpdates.push([
          "permitir_acompanantes",
          normalizeBoolean(request.body.permitir_acompanantes, "permitir_acompanantes"),
          "Permite registrar acompanantes en la cita",
        ]);
      }
      if (request.body?.pago_total_obligatorio !== undefined) {
        const pagoTotal = normalizeBoolean(request.body.pago_total_obligatorio, "pago_total_obligatorio");
        if (!pagoTotal) {
          throw new AppError(409, "La regla de negocio exige pago total obligatorio para agendar", {
            code: "ADMIN_CITAS_PAYMENT_RULE_ENFORCED",
          });
        }
        booleanUpdates.push([
          "pago_total_obligatorio",
          true,
          "Define si se exige el pago total para confirmar la cita",
        ]);
      }
      if (request.body?.simulacion_sin_pago !== undefined) {
        booleanUpdates.push([
          "simulacion_sin_pago",
          normalizeBoolean(request.body.simulacion_sin_pago, "simulacion_sin_pago"),
          "Permite habilitar temporalmente el flujo de agendamiento sin cobro para pruebas",
        ]);
      }
      if (request.body?.masterpuntos_migracion_manual_habilitada !== undefined) {
        booleanUpdates.push([
          "masterpuntos_migracion_manual_habilitada",
          normalizeBoolean(
            request.body.masterpuntos_migracion_manual_habilitada,
            "masterpuntos_migracion_manual_habilitada"
          ),
          "Habilita la carga manual unica de puntos legacy en MasterPuntos",
        ]);
      }

      if (!numericUpdates.length && !booleanUpdates.length) {
        throw new AppError(400, "Debes enviar al menos un parametro para actualizar", {
          code: "ADMIN_CITAS_PARAMS_EMPTY",
        });
      }

      await dbClient.query("BEGIN");
      const numericValidationRules = {
        hold_duracion_min: { min: 1, max: 120 },
        no_show_min: { min: 1, max: 240 },
        agenda_buffer_global_min: { min: 0, max: 120 },
        agenda_min_servicio_vendible_min: { min: 1, max: 240 },
      };
      for (const [clave, valor, descripcion] of numericUpdates) {
        const rule = numericValidationRules[clave] || { min: 1, max: 9999 };
        if (
          !Number.isFinite(valor)
          || !Number.isInteger(valor)
          || valor < rule.min
          || valor > rule.max
        ) {
          throw new AppError(400, `${clave} debe estar entre ${rule.min} y ${rule.max}`, {
            code: "ADMIN_CITAS_PARAMS_INVALID",
            details: { clave, min: rule.min, max: rule.max },
          });
        }

        await dbClient.query(
          `
            INSERT INTO public.parametros_sistema (clave, valor_numero, descripcion, updated_at)
            VALUES ($1::text, $2::numeric, $3::text, now())
            ON CONFLICT (clave)
            DO UPDATE SET valor_numero = EXCLUDED.valor_numero, valor_booleano = NULL, updated_at = now()
          `,
          [clave, valor, descripcion]
        );
      }

      for (const [clave, valor, descripcion] of booleanUpdates) {
        await dbClient.query(
          `
            INSERT INTO public.parametros_sistema (clave, valor_booleano, descripcion, updated_at)
            VALUES ($1::text, $2::boolean, $3::text, now())
            ON CONFLICT (clave)
            DO UPDATE SET valor_booleano = EXCLUDED.valor_booleano, valor_numero = NULL, updated_at = now()
          `,
          [clave, Boolean(valor), descripcion]
        );
      }
      await dbClient.query("COMMIT");

      const values = await getSystemParameters(dbClient);
      return sendOk(reply, { parametros: selectParams(values) });
    } catch (error) {
      try {
        await dbClient.query("ROLLBACK");
      } catch {
        // no-op
      }
      return sendHandled(reply, request, error, "No se pudieron actualizar los parametros", "ADMIN_CITAS_PARAMS_PATCH_ERROR");
    } finally {
      dbClient.release();
    }
  });
}

