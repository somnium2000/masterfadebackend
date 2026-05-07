import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { assertUuid, parseDateOnly, resolveBranchIdsForClaims } from "../../../services/agendaService.js";

// JK: Modulo de reportes administrativos para BI operativo (citas + pagos + membresias).
const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
const SUCCESS_PAYMENT_STATES = ["capturado", "conciliado", "manual_pagado"];
const NON_ACTIVE_SUBSCRIPTION_STATES = ["cancelada", "expirada", "inactiva", "vencida"];
const REPORTS_TIMEZONE = "America/Tegucigalpa";

const WEEKDAY_LABELS = {
  1: "Lunes",
  2: "Martes",
  3: "Miercoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sabado",
  7: "Domingo",
};

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    details: error instanceof Error ? error.message : "Unknown admin reportes error",
    requestId: request.id,
  });
}

function formatDateOnly(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// JK: Obtiene partes de fecha/hora en una zona horaria fija para cortes diarios consistentes.
function getDatePartsInTimeZone(dateValue, timeZone = REPORTS_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  formatter.formatToParts(dateValue).forEach((part) => {
    if (part.type === "literal") return;
    parts[part.type] = part.value;
  });
  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 0),
    day: Number(parts.day || 0),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
  };
}

function addDaysToDateOnly(dateOnly, daysDelta = 0) {
  const [year, month, day] = String(dateOnly || "").split("-").map((chunk) => Number(chunk));
  if (!year || !month || !day) return "";
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + Number(daysDelta || 0));
  return formatDateOnly(value);
}

function getDateOnlyInTimeZone(dateValue = new Date(), timeZone = REPORTS_TIMEZONE) {
  const parts = getDatePartsInTimeZone(dateValue, timeZone);
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTimeZoneOffsetMs(dateValue, timeZone = REPORTS_TIMEZONE) {
  const parts = getDatePartsInTimeZone(dateValue, timeZone);
  const utcFromZoneClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return utcFromZoneClock - dateValue.getTime();
}

// JK: Convierte inicio de dia local (zona de reportes) al instante UTC equivalente.
function zonedDateStartToUtcIso(dateOnly, timeZone = REPORTS_TIMEZONE) {
  const [year, month, day] = String(dateOnly || "").split("-").map((chunk) => Number(chunk));
  if (!year || !month || !day) return "";

  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let utcMillis = utcGuess - firstOffset;

  // JK: Segunda pasada para cubrir cambios de offset (DST) sin depender de librerias externas.
  const secondOffset = getTimeZoneOffsetMs(new Date(utcMillis), timeZone);
  if (secondOffset !== firstOffset) {
    utcMillis = utcGuess - secondOffset;
  }

  return new Date(utcMillis).toISOString();
}

function getDefaultDateRange(days = 30) {
  const fechaHasta = getDateOnlyInTimeZone(new Date(), REPORTS_TIMEZONE);
  const fechaDesde = addDaysToDateOnly(fechaHasta, -(Math.max(1, days) - 1));
  return {
    fechaDesde,
    fechaHasta,
  };
}

function normalizeOptionalUuid(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return assertUuid(raw, field);
}

function normalizeCommissionRate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new AppError(400, "commission_rate debe estar entre 0 y 100", {
      code: "REPORTES_COMMISSION_RATE_INVALID",
      details: { value },
    });
  }
  return parsed;
}

function normalizeDateRange(query = {}) {
  const defaults = getDefaultDateRange(30);
  const fechaDesde = parseDateOnly(query.fecha_desde || defaults.fechaDesde, "fecha_desde");
  const fechaHasta = parseDateOnly(query.fecha_hasta || defaults.fechaHasta, "fecha_hasta");

  if (fechaDesde > fechaHasta) {
    throw new AppError(400, "fecha_desde no puede ser mayor que fecha_hasta", {
      code: "REPORTES_DATE_RANGE_INVALID",
      details: { fecha_desde: fechaDesde, fecha_hasta: fechaHasta },
    });
  }

  const fromIso = zonedDateStartToUtcIso(fechaDesde, REPORTS_TIMEZONE);
  const toIsoExclusive = zonedDateStartToUtcIso(addDaysToDateOnly(fechaHasta, 1), REPORTS_TIMEZONE);

  return {
    fechaDesde,
    fechaHasta,
    fromIso,
    toIsoExclusive,
  };
}

async function resolveScope(app, claims, requestedBranchId) {
  const branchIds = await resolveBranchIdsForClaims(app, claims);
  if (!branchIds.length) {
    throw new AppError(403, "No tienes sucursales activas dentro de tu alcance para reportes", {
      code: "REPORTES_SCOPE_EMPTY",
    });
  }

  if (!requestedBranchId) return { branchIds, selectedBranchId: null };

  const safeBranchId = assertUuid(requestedBranchId, "id_sucursal");
  if (!branchIds.includes(safeBranchId)) {
    throw new AppError(403, "La sucursal solicitada no pertenece a tu alcance", {
      code: "REPORTES_BRANCH_FORBIDDEN",
      details: { id_sucursal: safeBranchId },
    });
  }

  return { branchIds, selectedBranchId: safeBranchId };
}

async function resolveBarberScope(client, { branchIds, selectedBranchId, requestedBarberId }) {
  if (!requestedBarberId) return null;

  const safeBarberId = assertUuid(requestedBarberId, "id_barbero");
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_barbero
      FROM public.empleados e
      JOIN public.personas p ON p.id_persona = e.id_persona
      WHERE e.id_empleado = $1::uuid
        AND e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND e.id_sucursal = ANY($2::uuid[])
      LIMIT 1
    `,
    [safeBarberId, branchIds]
  );

  const barber = rows[0] ?? null;
  if (!barber) {
    throw new AppError(404, "El barbero indicado no existe dentro de tu alcance", {
      code: "REPORTES_BARBER_NOT_FOUND",
      details: { id_barbero: safeBarberId },
    });
  }

  if (selectedBranchId && barber.id_sucursal !== selectedBranchId) {
    throw new AppError(409, "El barbero no pertenece a la sucursal seleccionada", {
      code: "REPORTES_BARBER_BRANCH_MISMATCH",
      details: {
        id_barbero: safeBarberId,
        id_sucursal_barbero: barber.id_sucursal,
        id_sucursal_filtro: selectedBranchId,
      },
    });
  }

  return {
    id_empleado: barber.id_empleado,
    id_sucursal: barber.id_sucursal,
    nombre_barbero: barber.nombre_barbero,
  };
}

async function listContextData(client, branchIds) {
  const [branchesResult, barbersResult] = await Promise.all([
    client.query(
      `
        SELECT id_sucursal, nombre_sucursal
        FROM public.sucursales
        WHERE id_sucursal = ANY($1::uuid[])
          AND deleted_at IS NULL
          AND estado IS TRUE
        ORDER BY nombre_sucursal ASC
      `,
      [branchIds]
    ),
    client.query(
      `
        SELECT
          e.id_empleado,
          e.id_sucursal,
          COALESCE(NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''), 'Sin nombre') AS nombre_barbero
        FROM public.empleados e
        JOIN public.personas p ON p.id_persona = e.id_persona
        WHERE e.deleted_at IS NULL
          AND e.estado IS TRUE
          AND e.es_barbero IS TRUE
          AND e.id_sucursal = ANY($1::uuid[])
        ORDER BY nombre_barbero ASC
      `,
      [branchIds]
    ),
  ]);

  return {
    sucursales: branchesResult.rows.map((row) => ({
      id_sucursal: row.id_sucursal,
      nombre_sucursal: row.nombre_sucursal,
    })),
    barberos: barbersResult.rows.map((row) => ({
      id_empleado: row.id_empleado,
      id_sucursal: row.id_sucursal,
      nombre_barbero: row.nombre_barbero,
    })),
  };
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function roundMoney(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function dayLabel(dayNumber) {
  return WEEKDAY_LABELS[dayNumber] || `Dia ${dayNumber}`;
}

function appendCsvSection(lines, title, columns, rows) {
  lines.push(`# ${title}`);
  lines.push(columns.join(","));
  if (!Array.isArray(rows) || rows.length === 0) {
    lines.push("sin_datos");
    lines.push("");
    return;
  }

  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row?.[column])).join(","));
  }
  lines.push("");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const normalized = String(value);
  if (/["\r\n,]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
}

function createHtmlTable(title, columns, rows) {
  const th = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = Array.isArray(rows) && rows.length
    ? rows
        .map(
          (row) =>
            `<tr>${columns.map((column) => `<td>${escapeHtml(row?.[column] ?? "")}</td>`).join("")}</tr>`
        )
        .join("")
    : `<tr><td colspan="${columns.length}">sin datos</td></tr>`;

  return `
    <h3>${escapeHtml(title)}</h3>
    <table>
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function escapeHtml(value) {
  const text = String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeExportType(value) {
  const normalized = String(value || "resumen").trim().toLowerCase();
  const allowed = new Set([
    "resumen",
    "ingresos_fecha",
    "ingresos_servicio",
    "ingresos_barbero",
    "ingresos_sucursal",
    "productividad",
    "concurrencia_dias",
    "concurrencia_horas",
    "membresias_planes",
    "membresias_activas",
  ]);
  if (!allowed.has(normalized)) {
    throw new AppError(400, "export_type invalido", {
      code: "REPORTES_EXPORT_TYPE_INVALID",
      details: { export_type: normalized },
    });
  }
  return normalized;
}

function pickExportRows(snapshot, exportType) {
  if (exportType === "ingresos_fecha") return snapshot.ventas_ingresos.ingresos_por_fecha;
  if (exportType === "ingresos_servicio") return snapshot.ventas_ingresos.ingresos_por_servicio;
  if (exportType === "ingresos_barbero") return snapshot.ventas_ingresos.ingresos_por_barbero;
  if (exportType === "ingresos_sucursal") return snapshot.ventas_ingresos.ingresos_por_sucursal;
  if (exportType === "productividad") return snapshot.productividad_barberos.resumen;
  if (exportType === "concurrencia_dias") return snapshot.concurrencia_clientes.trafico_por_dia_semana;
  if (exportType === "concurrencia_horas") return snapshot.concurrencia_clientes.horas_pico;
  if (exportType === "membresias_planes") return snapshot.membresias.ingresos_por_planes;
  if (exportType === "membresias_activas") return snapshot.membresias.suscripciones_activas_por_plan;
  return null;
}

function flattenKpis(kpis) {
  return [
    { kpi: "ingresos_servicios_hnl", valor: kpis.ingresos_servicios_hnl },
    { kpi: "ingresos_membresias_hnl", valor: kpis.ingresos_membresias_hnl },
    { kpi: "ingresos_totales_hnl", valor: kpis.ingresos_totales_hnl },
    { kpi: "total_citas", valor: kpis.total_citas },
    { kpi: "citas_pagadas", valor: kpis.citas_pagadas },
    { kpi: "planes_vendidos_periodo", valor: kpis.planes_vendidos_periodo },
    { kpi: "clientes_con_membresia_activa", valor: kpis.clientes_con_membresia_activa },
    { kpi: "porcentaje_clientes_con_membresia", valor: kpis.porcentaje_clientes_con_membresia },
    { kpi: "barbero_destacado", valor: kpis.barbero_destacado?.nombre_barbero || "" },
  ];
}

async function buildReportsSnapshot(client, params) {
  const {
    fechaDesde,
    fechaHasta,
    fromIso,
    toIsoExclusive,
    branchIds,
    selectedBranchId,
    selectedBarberId,
    selectedBarber,
    commissionRate,
  } = params;

  const [
    validationResult,
    servicesSummaryResult,
    totalAppointmentsResult,
    incomeByDateServicesResult,
    incomeByDateMembershipsResult,
    incomeByServiceResult,
    incomeByBarberResult,
    servicesDoneByBarberResult,
    incomeByBranchResult,
    trafficByDayResult,
    trafficByHourResult,
    noShowSummaryResult,
    membershipsSummaryResult,
    soldPlansResult,
    activeMembershipClientsResult,
    activeClientsResult,
    membershipByPlanRevenueResult,
    activeMembershipsByPlanResult,
  ] = await Promise.all([
    // JK: Validacion de disponibilidad de datos para no inventar metricas sin base.
    client.query(
      `
        SELECT
          (SELECT COUNT(*)::int
           FROM public.citas c
           WHERE c.deleted_at IS NULL
             AND c.id_sucursal = ANY($1::uuid[])
             AND c.inicio_at >= $2::timestamptz
             AND c.inicio_at < $3::timestamptz
             AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
             AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)) AS citas_en_rango,
          (SELECT COUNT(*)::int
           FROM public.citas_detalles cd
           JOIN public.citas c ON c.id_cita = cd.id_cita
           WHERE c.deleted_at IS NULL
             AND c.id_sucursal = ANY($1::uuid[])
             AND c.inicio_at >= $2::timestamptz
             AND c.inicio_at < $3::timestamptz
             AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
             AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)) AS detalles_en_rango,
          (SELECT COUNT(*)::int
           FROM public.payments p
           JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
           JOIN public.citas c ON c.id_cita = pi.id_cita
           WHERE p.estado_pago_codigo = ANY($6::text[])
             AND p.paid_at IS NOT NULL
             AND p.paid_at >= $2::timestamptz
             AND p.paid_at < $3::timestamptz
             AND c.deleted_at IS NULL
             AND c.id_sucursal = ANY($1::uuid[])
             AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
             AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)) AS pagos_servicios_en_rango,
          (SELECT COUNT(*)::int FROM public.servicios s WHERE s.deleted_at IS NULL) AS servicios_catalogo,
          (SELECT COUNT(*)::int
           FROM public.empleados e
           WHERE e.deleted_at IS NULL
             AND e.estado IS TRUE
             AND e.es_barbero IS TRUE
             AND e.id_sucursal = ANY($1::uuid[])
             AND ($4::uuid IS NULL OR e.id_sucursal = $4::uuid)
             AND ($5::uuid IS NULL OR e.id_empleado = $5::uuid)) AS barberos_scope,
          (SELECT COUNT(*)::int
           FROM public.clientes cl
           WHERE cl.deleted_at IS NULL
             AND cl.estado IS TRUE
             AND cl.id_sucursal_origen = ANY($1::uuid[])
             AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)) AS clientes_scope,
          (SELECT COUNT(*)::int
           FROM public.sucursales s
           WHERE s.deleted_at IS NULL
             AND s.estado IS TRUE
             AND s.id_sucursal = ANY($1::uuid[])) AS sucursales_scope,
          (SELECT COUNT(*)::int FROM public.membership_plans mp WHERE COALESCE(mp.activo, TRUE) IS TRUE) AS planes_activos,
          (SELECT COUNT(*)::int
           FROM public.subscriptions su
           JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
           WHERE cl.deleted_at IS NULL
             AND cl.id_sucursal_origen = ANY($1::uuid[])
             AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)) AS subscriptions_scope,
          (SELECT COUNT(*)::int
           FROM public.subscription_payments sp
           JOIN public.subscriptions su ON su.id_suscripcion = sp.id_suscripcion
           JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
           WHERE cl.deleted_at IS NULL
             AND cl.id_sucursal_origen = ANY($1::uuid[])
             AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)) AS subscription_payments_scope
      `,
      [
        branchIds,
        fromIso,
        toIsoExclusive,
        selectedBranchId,
        selectedBarberId,
        SUCCESS_PAYMENT_STATES,
      ]
    ),
    client.query(
      `
        SELECT
          COALESCE(SUM(p.monto_hnl), 0)::numeric AS ingresos_servicios_hnl,
          COUNT(*)::int AS pagos_confirmados,
          COUNT(DISTINCT c.id_cita)::int AS citas_pagadas
        FROM public.payments p
        JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
        JOIN public.citas c ON c.id_cita = pi.id_cita
        WHERE p.estado_pago_codigo = ANY($1::text[])
          AND p.paid_at IS NOT NULL
          AND p.paid_at >= $2::timestamptz
          AND p.paid_at < $3::timestamptz
          AND c.deleted_at IS NULL
          AND c.id_sucursal = ANY($4::uuid[])
          AND ($5::uuid IS NULL OR c.id_sucursal = $5::uuid)
          AND ($6::uuid IS NULL OR c.id_empleado_barbero = $6::uuid)
      `,
      [
        SUCCESS_PAYMENT_STATES,
        fromIso,
        toIsoExclusive,
        branchIds,
        selectedBranchId,
        selectedBarberId,
      ]
    ),
    client.query(
      `
        SELECT COUNT(*)::int AS total_citas
        FROM public.citas c
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= $1::timestamptz
          AND c.inicio_at < $2::timestamptz
          AND c.id_sucursal = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
          AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId, selectedBarberId]
    ),
    client.query(
      `
        SELECT
          (p.paid_at AT TIME ZONE '${REPORTS_TIMEZONE}')::date AS fecha,
          COALESCE(SUM(p.monto_hnl), 0)::numeric AS ingresos_servicios_hnl,
          COUNT(*)::int AS pagos_servicios
        FROM public.payments p
        JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
        JOIN public.citas c ON c.id_cita = pi.id_cita
        WHERE p.estado_pago_codigo = ANY($1::text[])
          AND p.paid_at IS NOT NULL
          AND p.paid_at >= $2::timestamptz
          AND p.paid_at < $3::timestamptz
          AND c.deleted_at IS NULL
          AND c.id_sucursal = ANY($4::uuid[])
          AND ($5::uuid IS NULL OR c.id_sucursal = $5::uuid)
          AND ($6::uuid IS NULL OR c.id_empleado_barbero = $6::uuid)
        GROUP BY (p.paid_at AT TIME ZONE '${REPORTS_TIMEZONE}')::date
        ORDER BY fecha ASC
      `,
      [
        SUCCESS_PAYMENT_STATES,
        fromIso,
        toIsoExclusive,
        branchIds,
        selectedBranchId,
        selectedBarberId,
      ]
    ),
    client.query(
      `
        SELECT
          (COALESCE(sp.paid_at, sp.created_at) AT TIME ZONE '${REPORTS_TIMEZONE}')::date AS fecha,
          COALESCE(SUM(sp.monto_hnl), 0)::numeric AS ingresos_membresias_hnl,
          COUNT(*)::int AS cobros_membresia
        FROM public.subscription_payments sp
        JOIN public.subscriptions su ON su.id_suscripcion = sp.id_suscripcion
        JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        WHERE LOWER(COALESCE(sp.estado, '')) = 'pagado'
          AND COALESCE(sp.paid_at, sp.created_at) >= $1::timestamptz
          AND COALESCE(sp.paid_at, sp.created_at) < $2::timestamptz
          AND cl.deleted_at IS NULL
          AND cl.id_sucursal_origen = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)
        GROUP BY (COALESCE(sp.paid_at, sp.created_at) AT TIME ZONE '${REPORTS_TIMEZONE}')::date
        ORDER BY fecha ASC
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId]
    ),
    client.query(
      `
        WITH pagos_ok AS (
          SELECT
            p.id_payment,
            p.monto_hnl,
            pi.id_cita,
            c.subtotal_servicios_hnl
          FROM public.payments p
          JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
          JOIN public.citas c ON c.id_cita = pi.id_cita
          WHERE p.estado_pago_codigo = ANY($1::text[])
            AND p.paid_at IS NOT NULL
            AND p.paid_at >= $2::timestamptz
            AND p.paid_at < $3::timestamptz
            AND c.deleted_at IS NULL
            AND c.id_sucursal = ANY($4::uuid[])
            AND ($5::uuid IS NULL OR c.id_sucursal = $5::uuid)
            AND ($6::uuid IS NULL OR c.id_empleado_barbero = $6::uuid)
        ),
        detalle_reparto AS (
          SELECT
            po.id_payment,
            po.monto_hnl,
            po.id_cita,
            po.subtotal_servicios_hnl,
            cd.id_servicio,
            s.nombre_servicio,
            COALESCE(cd.cantidad, 0) AS cantidad,
            COALESCE(cd.subtotal_hnl, 0) AS subtotal_hnl,
            COUNT(*) OVER (PARTITION BY po.id_payment) AS detalles_por_pago
          FROM pagos_ok po
          JOIN public.citas_detalles cd ON cd.id_cita = po.id_cita
          JOIN public.servicios s ON s.id_servicio = cd.id_servicio
        )
        SELECT
          dr.id_servicio,
          MAX(dr.nombre_servicio) AS nombre_servicio,
          SUM(dr.cantidad)::int AS servicios_realizados,
          COUNT(DISTINCT dr.id_cita)::int AS citas_pagadas,
          COALESCE(
            SUM(
              CASE
                WHEN COALESCE(dr.subtotal_servicios_hnl, 0) > 0 THEN dr.monto_hnl * (dr.subtotal_hnl / dr.subtotal_servicios_hnl)
                WHEN dr.detalles_por_pago > 0 THEN dr.monto_hnl / dr.detalles_por_pago
                ELSE 0
              END
            ),
            0
          )::numeric AS ingresos_hnl
        FROM detalle_reparto dr
        GROUP BY dr.id_servicio
        ORDER BY ingresos_hnl DESC, nombre_servicio ASC
      `,
      [
        SUCCESS_PAYMENT_STATES,
        fromIso,
        toIsoExclusive,
        branchIds,
        selectedBranchId,
        selectedBarberId,
      ]
    ),
    client.query(
      `
        SELECT
          c.id_empleado_barbero AS id_empleado,
          c.id_sucursal,
          s.nombre_sucursal,
          COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Sin nombre') AS nombre_barbero,
          COUNT(DISTINCT c.id_cita)::int AS citas_pagadas,
          COALESCE(SUM(p.monto_hnl), 0)::numeric AS ingresos_hnl
        FROM public.payments p
        JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
        JOIN public.citas c ON c.id_cita = pi.id_cita
        JOIN public.empleados e ON e.id_empleado = c.id_empleado_barbero
        JOIN public.personas pb ON pb.id_persona = e.id_persona
        JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE p.estado_pago_codigo = ANY($1::text[])
          AND p.paid_at IS NOT NULL
          AND p.paid_at >= $2::timestamptz
          AND p.paid_at < $3::timestamptz
          AND c.deleted_at IS NULL
          AND c.id_sucursal = ANY($4::uuid[])
          AND ($5::uuid IS NULL OR c.id_sucursal = $5::uuid)
          AND ($6::uuid IS NULL OR c.id_empleado_barbero = $6::uuid)
        GROUP BY c.id_empleado_barbero, c.id_sucursal, s.nombre_sucursal, pb.nombres, pb.apellidos
        ORDER BY ingresos_hnl DESC, nombre_barbero ASC
      `,
      [
        SUCCESS_PAYMENT_STATES,
        fromIso,
        toIsoExclusive,
        branchIds,
        selectedBranchId,
        selectedBarberId,
      ]
    ),
    client.query(
      `
        SELECT
          c.id_empleado_barbero AS id_empleado,
          COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Sin nombre') AS nombre_barbero,
          COUNT(DISTINCT c.id_cita) FILTER (WHERE c.estado_cita_codigo = 'completada')::int AS citas_completadas,
          COUNT(DISTINCT c.id_cita) FILTER (WHERE c.estado_cita_codigo = 'no_show')::int AS no_show,
          COALESCE(SUM(cd.cantidad) FILTER (WHERE c.estado_cita_codigo = 'completada'), 0)::int AS servicios_realizados
        FROM public.citas c
        JOIN public.empleados e ON e.id_empleado = c.id_empleado_barbero
        JOIN public.personas pb ON pb.id_persona = e.id_persona
        LEFT JOIN public.citas_detalles cd ON cd.id_cita = c.id_cita
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= $1::timestamptz
          AND c.inicio_at < $2::timestamptz
          AND c.id_sucursal = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
          AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)
        GROUP BY c.id_empleado_barbero, pb.nombres, pb.apellidos
        ORDER BY servicios_realizados DESC, nombre_barbero ASC
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId, selectedBarberId]
    ),
    client.query(
      `
        SELECT
          c.id_sucursal,
          s.nombre_sucursal,
          COUNT(DISTINCT c.id_cita)::int AS citas_pagadas,
          COALESCE(SUM(p.monto_hnl), 0)::numeric AS ingresos_hnl
        FROM public.payments p
        JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
        JOIN public.citas c ON c.id_cita = pi.id_cita
        JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE p.estado_pago_codigo = ANY($1::text[])
          AND p.paid_at IS NOT NULL
          AND p.paid_at >= $2::timestamptz
          AND p.paid_at < $3::timestamptz
          AND c.deleted_at IS NULL
          AND c.id_sucursal = ANY($4::uuid[])
          AND ($5::uuid IS NULL OR c.id_sucursal = $5::uuid)
          AND ($6::uuid IS NULL OR c.id_empleado_barbero = $6::uuid)
        GROUP BY c.id_sucursal, s.nombre_sucursal
        ORDER BY ingresos_hnl DESC, nombre_sucursal ASC
      `,
      [
        SUCCESS_PAYMENT_STATES,
        fromIso,
        toIsoExclusive,
        branchIds,
        selectedBranchId,
        selectedBarberId,
      ]
    ),
    client.query(
      `
        SELECT
          EXTRACT(ISODOW FROM c.inicio_at)::int AS dia_semana_num,
          COUNT(*)::int AS total_citas,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'no_show')::int AS no_show,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'completada')::int AS completadas
        FROM public.citas c
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= $1::timestamptz
          AND c.inicio_at < $2::timestamptz
          AND c.id_sucursal = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
          AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)
        GROUP BY EXTRACT(ISODOW FROM c.inicio_at)::int
        ORDER BY dia_semana_num ASC
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId, selectedBarberId]
    ),
    client.query(
      `
        SELECT
          EXTRACT(HOUR FROM c.inicio_at)::int AS hora,
          COUNT(*)::int AS total_citas,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'no_show')::int AS no_show,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'completada')::int AS completadas
        FROM public.citas c
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= $1::timestamptz
          AND c.inicio_at < $2::timestamptz
          AND c.id_sucursal = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
          AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)
        GROUP BY EXTRACT(HOUR FROM c.inicio_at)::int
        ORDER BY total_citas DESC, hora ASC
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId, selectedBarberId]
    ),
    client.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'no_show')::int AS total_no_show,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo = 'completada')::int AS total_completadas,
          COUNT(*) FILTER (WHERE c.estado_cita_codigo IN ('completada', 'no_show'))::int AS total_citas_base
        FROM public.citas c
        WHERE c.deleted_at IS NULL
          AND c.inicio_at >= $1::timestamptz
          AND c.inicio_at < $2::timestamptz
          AND c.id_sucursal = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR c.id_sucursal = $4::uuid)
          AND ($5::uuid IS NULL OR c.id_empleado_barbero = $5::uuid)
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId, selectedBarberId]
    ),
    client.query(
      `
        SELECT
          COALESCE(SUM(sp.monto_hnl), 0)::numeric AS ingresos_membresias_hnl,
          COUNT(*)::int AS cobros_membresia
        FROM public.subscription_payments sp
        JOIN public.subscriptions su ON su.id_suscripcion = sp.id_suscripcion
        JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        WHERE LOWER(COALESCE(sp.estado, '')) = 'pagado'
          AND COALESCE(sp.paid_at, sp.created_at) >= $1::timestamptz
          AND COALESCE(sp.paid_at, sp.created_at) < $2::timestamptz
          AND cl.deleted_at IS NULL
          AND cl.id_sucursal_origen = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId]
    ),
    client.query(
      `
        SELECT COUNT(*)::int AS planes_vendidos_periodo
        FROM public.subscriptions su
        JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        WHERE su.created_at >= $1::timestamptz
          AND su.created_at < $2::timestamptz
          AND cl.deleted_at IS NULL
          AND cl.id_sucursal_origen = ANY($3::uuid[])
          AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId]
    ),
    client.query(
      `
        SELECT COUNT(DISTINCT su.id_cliente)::int AS clientes_con_membresia_activa
        FROM public.subscriptions su
        JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        WHERE su.inicio_at <= now()
          AND su.fin_at >= now()
          AND LOWER(COALESCE(su.estado_suscripcion_codigo, '')) <> ALL($1::text[])
          AND cl.deleted_at IS NULL
          AND cl.id_sucursal_origen = ANY($2::uuid[])
          AND ($3::uuid IS NULL OR cl.id_sucursal_origen = $3::uuid)
      `,
      [NON_ACTIVE_SUBSCRIPTION_STATES, branchIds, selectedBranchId]
    ),
    client.query(
      `
        SELECT COUNT(*)::int AS total_clientes_activos
        FROM public.clientes cl
        WHERE cl.deleted_at IS NULL
          AND cl.estado IS TRUE
          AND cl.id_sucursal_origen = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR cl.id_sucursal_origen = $2::uuid)
      `,
      [branchIds, selectedBranchId]
    ),
    client.query(
      `
        SELECT
          mp.id_plan,
          mp.nombre_plan,
          COUNT(sp.id_sub_payment)::int AS pagos_registrados,
          COALESCE(SUM(sp.monto_hnl), 0)::numeric AS ingresos_hnl
        FROM public.membership_plans mp
        LEFT JOIN public.subscriptions su ON su.id_plan = mp.id_plan
        LEFT JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        LEFT JOIN public.subscription_payments sp
          ON sp.id_suscripcion = su.id_suscripcion
         AND LOWER(COALESCE(sp.estado, '')) = 'pagado'
         AND COALESCE(sp.paid_at, sp.created_at) >= $1::timestamptz
         AND COALESCE(sp.paid_at, sp.created_at) < $2::timestamptz
        WHERE COALESCE(mp.activo, TRUE) IS TRUE
          AND (
            cl.id_cliente IS NULL OR (
              cl.deleted_at IS NULL
              AND cl.id_sucursal_origen = ANY($3::uuid[])
              AND ($4::uuid IS NULL OR cl.id_sucursal_origen = $4::uuid)
            )
          )
        GROUP BY mp.id_plan, mp.nombre_plan
        ORDER BY ingresos_hnl DESC, mp.nombre_plan ASC
      `,
      [fromIso, toIsoExclusive, branchIds, selectedBranchId]
    ),
    client.query(
      `
        SELECT
          mp.id_plan,
          mp.nombre_plan,
          COUNT(su.id_suscripcion)::int AS suscripciones_activas
        FROM public.membership_plans mp
        LEFT JOIN public.subscriptions su
          ON su.id_plan = mp.id_plan
         AND su.inicio_at <= now()
         AND su.fin_at >= now()
         AND LOWER(COALESCE(su.estado_suscripcion_codigo, '')) <> ALL($1::text[])
        LEFT JOIN public.clientes cl ON cl.id_cliente = su.id_cliente
        WHERE COALESCE(mp.activo, TRUE) IS TRUE
          AND (
            cl.id_cliente IS NULL OR (
              cl.deleted_at IS NULL
              AND cl.id_sucursal_origen = ANY($2::uuid[])
              AND ($3::uuid IS NULL OR cl.id_sucursal_origen = $3::uuid)
            )
          )
        GROUP BY mp.id_plan, mp.nombre_plan
        ORDER BY suscripciones_activas DESC, mp.nombre_plan ASC
      `,
      [NON_ACTIVE_SUBSCRIPTION_STATES, branchIds, selectedBranchId]
    ),
  ]);

  const validation = validationResult.rows[0] ?? {};
  const serviceSummary = servicesSummaryResult.rows[0] ?? {};
  const totalAppointments = totalAppointmentsResult.rows[0] ?? {};
  const membershipSummary = membershipsSummaryResult.rows[0] ?? {};
  const soldPlans = soldPlansResult.rows[0] ?? {};
  const activeMembershipClients = activeMembershipClientsResult.rows[0] ?? {};
  const activeClients = activeClientsResult.rows[0] ?? {};
  const noShowSummary = noShowSummaryResult.rows[0] ?? {};

  const serviceIncomeByDateMap = new Map();
  for (const row of incomeByDateServicesResult.rows) {
    const key = row.fecha;
    serviceIncomeByDateMap.set(key, {
      fecha: key,
      ingresos_servicios_hnl: roundMoney(row.ingresos_servicios_hnl),
      ingresos_membresias_hnl: 0,
      ingresos_totales_hnl: roundMoney(row.ingresos_servicios_hnl),
      pagos_servicios: toInt(row.pagos_servicios),
      cobros_membresia: 0,
    });
  }

  for (const row of incomeByDateMembershipsResult.rows) {
    const key = row.fecha;
    if (!serviceIncomeByDateMap.has(key)) {
      serviceIncomeByDateMap.set(key, {
        fecha: key,
        ingresos_servicios_hnl: 0,
        ingresos_membresias_hnl: roundMoney(row.ingresos_membresias_hnl),
        ingresos_totales_hnl: roundMoney(row.ingresos_membresias_hnl),
        pagos_servicios: 0,
        cobros_membresia: toInt(row.cobros_membresia),
      });
      continue;
    }
    const current = serviceIncomeByDateMap.get(key);
    current.ingresos_membresias_hnl = roundMoney(row.ingresos_membresias_hnl);
    current.ingresos_totales_hnl = roundMoney(current.ingresos_servicios_hnl + current.ingresos_membresias_hnl);
    current.cobros_membresia = toInt(row.cobros_membresia);
  }

  const ingresosPorFecha = Array.from(serviceIncomeByDateMap.values()).sort(
    (a, b) => String(a.fecha).localeCompare(String(b.fecha))
  );

  const servicesDoneByBarberMap = new Map(
    servicesDoneByBarberResult.rows.map((row) => [
      row.id_empleado,
      {
        citas_completadas: toInt(row.citas_completadas),
        no_show: toInt(row.no_show),
        servicios_realizados: toInt(row.servicios_realizados),
      },
    ])
  );

  const ingresosPorBarbero = incomeByBarberResult.rows.map((row) => {
    const productivity = servicesDoneByBarberMap.get(row.id_empleado) || {
      citas_completadas: 0,
      no_show: 0,
      servicios_realizados: 0,
    };
    const ingresos = roundMoney(row.ingresos_hnl);
    return {
      id_empleado: row.id_empleado,
      nombre_barbero: row.nombre_barbero,
      id_sucursal: row.id_sucursal,
      nombre_sucursal: row.nombre_sucursal,
      citas_pagadas: toInt(row.citas_pagadas),
      citas_completadas: productivity.citas_completadas,
      no_show: productivity.no_show,
      servicios_realizados: productivity.servicios_realizados,
      ingresos_hnl: ingresos,
      comision_estimada_hnl: commissionRate == null ? null : roundMoney((ingresos * commissionRate) / 100),
    };
  });

  const productividadResumen = servicesDoneByBarberResult.rows.map((row) => {
    const ingresosRow = ingresosPorBarbero.find((item) => item.id_empleado === row.id_empleado);
    const ingresos = ingresosRow ? ingresosRow.ingresos_hnl : 0;
    return {
      id_empleado: row.id_empleado,
      nombre_barbero: row.nombre_barbero,
      citas_completadas: toInt(row.citas_completadas),
      no_show: toInt(row.no_show),
      servicios_realizados: toInt(row.servicios_realizados),
      ingresos_hnl: roundMoney(ingresos),
      comision_estimada_hnl: commissionRate == null ? null : roundMoney((ingresos * commissionRate) / 100),
    };
  });

  const totalComision = commissionRate == null
    ? null
    : roundMoney(productividadResumen.reduce((acc, row) => acc + toNumber(row.comision_estimada_hnl), 0));

  const ingresosServicios = roundMoney(serviceSummary.ingresos_servicios_hnl);
  const ingresosMembresias = roundMoney(membershipSummary.ingresos_membresias_hnl);
  const ingresosTotales = roundMoney(ingresosServicios + ingresosMembresias);

  const clientesConMembresiaActiva = toInt(activeMembershipClients.clientes_con_membresia_activa);
  const totalClientesActivos = toInt(activeClients.total_clientes_activos);
  const porcentajeAdopcion = totalClientesActivos > 0
    ? roundMoney((clientesConMembresiaActiva / totalClientesActivos) * 100)
    : 0;
  const porcentajeIngresoMembresia = ingresosTotales > 0
    ? roundMoney((ingresosMembresias / ingresosTotales) * 100)
    : 0;

  const barberoDestacado = ingresosPorBarbero.length
    ? {
        id_empleado: ingresosPorBarbero[0].id_empleado,
        nombre_barbero: ingresosPorBarbero[0].nombre_barbero,
        ingresos_hnl: ingresosPorBarbero[0].ingresos_hnl,
        servicios_realizados: ingresosPorBarbero[0].servicios_realizados,
      }
    : null;

  const noShowBase = toInt(noShowSummary.total_citas_base);
  const noShowRate = noShowBase > 0
    ? roundMoney((toInt(noShowSummary.total_no_show) / noShowBase) * 100)
    : 0;

  return {
    filtros_aplicados: {
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      id_sucursal: selectedBranchId,
      id_barbero: selectedBarberId,
      sucursales_en_alcance: branchIds.length,
      moneda: "HNL",
      commission_rate: commissionRate,
    },
    validacion_datos: {
      citas_en_rango: toInt(validation.citas_en_rango),
      detalles_en_rango: toInt(validation.detalles_en_rango),
      pagos_servicios_en_rango: toInt(validation.pagos_servicios_en_rango),
      servicios_catalogo: toInt(validation.servicios_catalogo),
      barberos_scope: toInt(validation.barberos_scope),
      clientes_scope: toInt(validation.clientes_scope),
      sucursales_scope: toInt(validation.sucursales_scope),
      planes_activos: toInt(validation.planes_activos),
      subscriptions_scope: toInt(validation.subscriptions_scope),
      subscription_payments_scope: toInt(validation.subscription_payments_scope),
      pagos_servicios_con_datos: toInt(validation.pagos_servicios_en_rango) > 0,
      membresias_con_datos:
        toInt(validation.subscriptions_scope) > 0 || toInt(validation.subscription_payments_scope) > 0,
    },
    kpis: {
      ingresos_servicios_hnl: ingresosServicios,
      ingresos_membresias_hnl: ingresosMembresias,
      ingresos_totales_hnl: ingresosTotales,
      total_citas: toInt(totalAppointments.total_citas),
      citas_pagadas: toInt(serviceSummary.citas_pagadas),
      planes_vendidos_periodo: toInt(soldPlans.planes_vendidos_periodo),
      clientes_con_membresia_activa: clientesConMembresiaActiva,
      total_clientes_activos: totalClientesActivos,
      porcentaje_clientes_con_membresia: porcentajeAdopcion,
      porcentaje_ingresos_membresia: porcentajeIngresoMembresia,
      barbero_destacado: barberoDestacado,
    },
    ventas_ingresos: {
      ingresos_por_fecha: ingresosPorFecha,
      ingresos_por_servicio: incomeByServiceResult.rows.map((row) => ({
        id_servicio: row.id_servicio,
        nombre_servicio: row.nombre_servicio,
        servicios_realizados: toInt(row.servicios_realizados),
        citas_pagadas: toInt(row.citas_pagadas),
        ingresos_hnl: roundMoney(row.ingresos_hnl),
      })),
      ingresos_por_barbero: ingresosPorBarbero,
      ingresos_por_sucursal: incomeByBranchResult.rows.map((row) => ({
        id_sucursal: row.id_sucursal,
        nombre_sucursal: row.nombre_sucursal,
        citas_pagadas: toInt(row.citas_pagadas),
        ingresos_hnl: roundMoney(row.ingresos_hnl),
      })),
    },
    productividad_barberos: {
      resumen: productividadResumen,
      comisiones: {
        habilitado: commissionRate != null,
        porcentaje: commissionRate,
        total_estimado_hnl: totalComision,
      },
    },
    concurrencia_clientes: {
      trafico_por_dia_semana: trafficByDayResult.rows.map((row) => ({
        dia_semana_num: toInt(row.dia_semana_num),
        dia_semana_label: dayLabel(toInt(row.dia_semana_num)),
        total_citas: toInt(row.total_citas),
        no_show: toInt(row.no_show),
        completadas: toInt(row.completadas),
      })),
      horas_pico: trafficByHourResult.rows.map((row) => ({
        hora: toInt(row.hora),
        total_citas: toInt(row.total_citas),
        no_show: toInt(row.no_show),
        completadas: toInt(row.completadas),
      })),
      citas_vs_no_show: {
        total_citas_base: toInt(noShowSummary.total_citas_base),
        total_no_show: toInt(noShowSummary.total_no_show),
        total_completadas: toInt(noShowSummary.total_completadas),
        tasa_no_show: noShowRate,
      },
    },
    membresias: {
      ingresos_por_planes: membershipByPlanRevenueResult.rows.map((row) => ({
        id_plan: row.id_plan,
        nombre_plan: row.nombre_plan,
        pagos_registrados: toInt(row.pagos_registrados),
        ingresos_hnl: roundMoney(row.ingresos_hnl),
      })),
      suscripciones_activas_por_plan: activeMembershipsByPlanResult.rows.map((row) => ({
        id_plan: row.id_plan,
        nombre_plan: row.nombre_plan,
        suscripciones_activas: toInt(row.suscripciones_activas),
      })),
      adopcion: {
        clientes_con_membresia_activa: clientesConMembresiaActiva,
        total_clientes_activos: totalClientesActivos,
        porcentaje_clientes_con_membresia: porcentajeAdopcion,
      },
      comparativo_servicios_vs_membresias: {
        ingresos_servicios_hnl: ingresosServicios,
        ingresos_membresias_hnl: ingresosMembresias,
        ingresos_totales_hnl: ingresosTotales,
        diferencia_hnl: roundMoney(ingresosServicios - ingresosMembresias),
      },
      uso_beneficios: {
        disponible: false,
        mensaje:
          "No existe trazabilidad de redencion/uso de beneficios de membresia en la base actual.",
      },
    },
    limitaciones: [
      "Los ingresos de servicios usan pagos confirmados en payments por paid_at.",
      "La productividad usa citas por inicio_at y estado de cita.",
      "Membresias no se relacionan con barbero; filtro de barbero no afecta esos KPIs.",
      "Comisiones solo se estiman si envias commission_rate (no hay tabla de comisiones).",
      "Uso de beneficios de membresia no se puede calcular sin tabla de redenciones.",
    ],
    metodologia: {
      pagos_servicios_estados_exitosos: SUCCESS_PAYMENT_STATES,
      suscripcion_no_activa_estados_descartados: NON_ACTIVE_SUBSCRIPTION_STATES,
      periodo_ingresos: "paid_at",
      periodo_operativo_citas: "inicio_at",
      scope_barbero: selectedBarber
        ? {
            id_empleado: selectedBarber.id_empleado,
            nombre_barbero: selectedBarber.nombre_barbero,
            id_sucursal: selectedBarber.id_sucursal,
          }
        : null,
    },
  };
}

function buildCsvFromSnapshot(snapshot, exportType) {
  const lines = [];
  lines.push("JK_REPORTES_MASTERFADE");
  lines.push(`fecha_desde,${csvEscape(snapshot.filtros_aplicados.fecha_desde)}`);
  lines.push(`fecha_hasta,${csvEscape(snapshot.filtros_aplicados.fecha_hasta)}`);
  lines.push(`id_sucursal,${csvEscape(snapshot.filtros_aplicados.id_sucursal || "")}`);
  lines.push(`id_barbero,${csvEscape(snapshot.filtros_aplicados.id_barbero || "")}`);
  lines.push("");

  if (exportType !== "resumen") {
    const rows = pickExportRows(snapshot, exportType) || [];
    const columns = rows.length ? Object.keys(rows[0]) : ["sin_datos"];
    appendCsvSection(lines, exportType, columns, rows);
    return `${lines.join("\n")}\n`;
  }

  appendCsvSection(lines, "kpis", ["kpi", "valor"], flattenKpis(snapshot.kpis));
  appendCsvSection(
    lines,
    "ingresos_por_fecha",
    ["fecha", "ingresos_servicios_hnl", "ingresos_membresias_hnl", "ingresos_totales_hnl", "pagos_servicios", "cobros_membresia"],
    snapshot.ventas_ingresos.ingresos_por_fecha
  );
  appendCsvSection(
    lines,
    "ingresos_por_servicio",
    ["id_servicio", "nombre_servicio", "servicios_realizados", "citas_pagadas", "ingresos_hnl"],
    snapshot.ventas_ingresos.ingresos_por_servicio
  );
  appendCsvSection(
    lines,
    "ingresos_por_barbero",
    [
      "id_empleado",
      "nombre_barbero",
      "id_sucursal",
      "nombre_sucursal",
      "citas_pagadas",
      "citas_completadas",
      "no_show",
      "servicios_realizados",
      "ingresos_hnl",
      "comision_estimada_hnl",
    ],
    snapshot.ventas_ingresos.ingresos_por_barbero
  );
  appendCsvSection(
    lines,
    "ingresos_por_sucursal",
    ["id_sucursal", "nombre_sucursal", "citas_pagadas", "ingresos_hnl"],
    snapshot.ventas_ingresos.ingresos_por_sucursal
  );
  appendCsvSection(
    lines,
    "concurrencia_dias",
    ["dia_semana_num", "dia_semana_label", "total_citas", "no_show", "completadas"],
    snapshot.concurrencia_clientes.trafico_por_dia_semana
  );
  appendCsvSection(
    lines,
    "concurrencia_horas",
    ["hora", "total_citas", "no_show", "completadas"],
    snapshot.concurrencia_clientes.horas_pico
  );
  appendCsvSection(
    lines,
    "membresias_ingresos_planes",
    ["id_plan", "nombre_plan", "pagos_registrados", "ingresos_hnl"],
    snapshot.membresias.ingresos_por_planes
  );
  appendCsvSection(
    lines,
    "membresias_activas_plan",
    ["id_plan", "nombre_plan", "suscripciones_activas"],
    snapshot.membresias.suscripciones_activas_por_plan
  );

  return `${lines.join("\n")}\n`;
}

function buildExcelFromSnapshot(snapshot, exportType) {
  const title = `Reporte MasterFade (${snapshot.filtros_aplicados.fecha_desde} a ${snapshot.filtros_aplicados.fecha_hasta})`;
  const sections = [];

  if (exportType !== "resumen") {
    const rows = pickExportRows(snapshot, exportType) || [];
    const columns = rows.length ? Object.keys(rows[0]) : ["sin_datos"];
    sections.push(createHtmlTable(exportType, columns, rows));
  } else {
    sections.push(createHtmlTable("KPIs", ["kpi", "valor"], flattenKpis(snapshot.kpis)));
    sections.push(
      createHtmlTable(
        "Ingresos por fecha",
        ["fecha", "ingresos_servicios_hnl", "ingresos_membresias_hnl", "ingresos_totales_hnl", "pagos_servicios", "cobros_membresia"],
        snapshot.ventas_ingresos.ingresos_por_fecha
      )
    );
    sections.push(
      createHtmlTable(
        "Ingresos por servicio",
        ["id_servicio", "nombre_servicio", "servicios_realizados", "citas_pagadas", "ingresos_hnl"],
        snapshot.ventas_ingresos.ingresos_por_servicio
      )
    );
    sections.push(
      createHtmlTable(
        "Ingresos por barbero",
        [
          "id_empleado",
          "nombre_barbero",
          "id_sucursal",
          "nombre_sucursal",
          "citas_pagadas",
          "citas_completadas",
          "no_show",
          "servicios_realizados",
          "ingresos_hnl",
          "comision_estimada_hnl",
        ],
        snapshot.ventas_ingresos.ingresos_por_barbero
      )
    );
    sections.push(
      createHtmlTable(
        "Ingresos por sucursal",
        ["id_sucursal", "nombre_sucursal", "citas_pagadas", "ingresos_hnl"],
        snapshot.ventas_ingresos.ingresos_por_sucursal
      )
    );
    sections.push(
      createHtmlTable(
        "Concurrencia por dia",
        ["dia_semana_num", "dia_semana_label", "total_citas", "no_show", "completadas"],
        snapshot.concurrencia_clientes.trafico_por_dia_semana
      )
    );
    sections.push(
      createHtmlTable(
        "Concurrencia por hora",
        ["hora", "total_citas", "no_show", "completadas"],
        snapshot.concurrencia_clientes.horas_pico
      )
    );
    sections.push(
      createHtmlTable(
        "Membresias ingresos por plan",
        ["id_plan", "nombre_plan", "pagos_registrados", "ingresos_hnl"],
        snapshot.membresias.ingresos_por_planes
      )
    );
    sections.push(
      createHtmlTable(
        "Membresias activas por plan",
        ["id_plan", "nombre_plan", "suscripciones_activas"],
        snapshot.membresias.suscripciones_activas_por_plan
      )
    );
  }

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; font-size: 12px; color: #111; }
          h1 { font-size: 18px; margin-bottom: 2px; }
          h2 { font-size: 13px; margin-top: 0; color: #444; }
          h3 { margin-top: 20px; margin-bottom: 6px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
          th, td { border: 1px solid #aaa; padding: 4px 6px; text-align: left; }
          th { background: #f1f1f1; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        <h2>Moneda: HNL</h2>
        ${sections.join("\n")}
      </body>
    </html>
  `;
}

async function resolveRequestParams(app, client, request) {
  const dateRange = normalizeDateRange(request.query || {});
  const requestedBranchId = normalizeOptionalUuid(request.query?.id_sucursal, "id_sucursal");
  const requestedBarberId = normalizeOptionalUuid(request.query?.id_barbero, "id_barbero");
  const commissionRate = normalizeCommissionRate(request.query?.commission_rate);

  const scope = await resolveScope(app, request.claims, requestedBranchId);
  const selectedBarber = await resolveBarberScope(client, {
    branchIds: scope.branchIds,
    selectedBranchId: scope.selectedBranchId,
    requestedBarberId,
  });

  return {
    ...dateRange,
    branchIds: scope.branchIds,
    selectedBranchId: scope.selectedBranchId,
    selectedBarberId: selectedBarber?.id_empleado ?? null,
    selectedBarber,
    commissionRate,
  };
}

export default async function adminReportesRoutes(app) {
  // JK: Contexto para filtros del frontend (sucursales + barberos dentro de alcance).
  app.get("/contexto", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const requestedBranchId = normalizeOptionalUuid(request.query?.id_sucursal, "id_sucursal");
      const scope = await resolveScope(app, request.claims, requestedBranchId);
      const context = await listContextData(app.db, scope.branchIds);
      return sendOk(reply, {
        ...context,
        rango_default: getDefaultDateRange(30),
      });
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo cargar el contexto de reportes",
        "ADMIN_REPORTES_CONTEXT_ERROR"
      );
    }
  });

  // JK: Snapshot consolidado para KPIs, graficos y tablas del modulo de reportes.
  app.get("/dashboard", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const client = await app.db.connect();
    try {
      const params = await resolveRequestParams(app, client, request);
      const snapshot = await buildReportsSnapshot(client, params);
      return sendOk(reply, snapshot, { requestId: request.id });
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo construir el dashboard de reportes",
        "ADMIN_REPORTES_DASHBOARD_ERROR"
      );
    } finally {
      client.release();
    }
  });

  // JK: Exportacion CSV obligatoria para reporte detallado o por seccion.
  app.get("/export/csv", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const client = await app.db.connect();
    try {
      const exportType = normalizeExportType(request.query?.export_type);
      const params = await resolveRequestParams(app, client, request);
      const snapshot = await buildReportsSnapshot(client, params);
      const csv = buildCsvFromSnapshot(snapshot, exportType);

      const filename = `reportes_${exportType}_${snapshot.filtros_aplicados.fecha_desde}_${snapshot.filtros_aplicados.fecha_hasta}.csv`;
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csv);
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo exportar el reporte CSV",
        "ADMIN_REPORTES_EXPORT_CSV_ERROR"
      );
    } finally {
      client.release();
    }
  });

  // JK: Exportacion Excel viable sin dependencia externa (HTML compatible .xls).
  app.get("/export/excel", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    const client = await app.db.connect();
    try {
      const exportType = normalizeExportType(request.query?.export_type);
      const params = await resolveRequestParams(app, client, request);
      const snapshot = await buildReportsSnapshot(client, params);
      const workbookHtml = buildExcelFromSnapshot(snapshot, exportType);

      const filename = `reportes_${exportType}_${snapshot.filtros_aplicados.fecha_desde}_${snapshot.filtros_aplicados.fecha_hasta}.xls`;
      return reply
        .header("Content-Type", "application/vnd.ms-excel; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(workbookHtml);
    } catch (error) {
      return sendHandled(
        reply,
        request,
        error,
        "No se pudo exportar el reporte Excel",
        "ADMIN_REPORTES_EXPORT_EXCEL_ERROR"
      );
    } finally {
      client.release();
    }
  });
}
