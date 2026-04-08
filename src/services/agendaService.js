import { AppError } from "../utils/errors.js";
import { MockPaymentProvider } from "./payments/MockPaymentProvider.js";
import { PaymentProviderFactory } from "./payments/PaymentProviderFactory.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OCCUPIED_APPOINTMENT_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon"];
export const OPERATIONAL_APPOINTMENT_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon"];
export const HOLD_EXPIRABLE_APPOINTMENT_STATES = ["en_espera", "pendiente_pago"];
export const ACTIVE_PAYMENT_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];
export const AUTO_NO_SHOW_GRACE_MINUTES = 5;
export const APPOINTMENT_STATE_TRANSITIONS = {
  en_espera: ["confirmada", "cancelada", "expirada"],
  pendiente_pago: ["confirmada", "cancelada", "expirada"],
  confirmada: ["en_salon", "cancelada", "no_show"],
  en_salon: ["completada", "no_show"],
};
export const SYSTEM_PARAMETER_KEYS = [
  "hold_duracion_min",
  "no_show_min",
  "agenda_buffer_global_min",
  "permitir_acompanantes",
  "pago_total_obligatorio",
  "simulacion_sin_pago",
  "masterpuntos_migracion_manual_habilitada",
];
export const SLOT_INTERVAL_MINUTES = 30;

function createProviderAdapterByCode(providerCode) {
  const normalized = String(providerCode || "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === "mock") {
    return new MockPaymentProvider({
      mockResult: String(process.env.MOCK_PAYMENT_RESULT || "PAID"),
    });
  }

  const envProvider = String(process.env.PAYMENT_PROVIDER || "mock").trim().toLowerCase();
  if (normalized === envProvider) {
    return PaymentProviderFactory.create();
  }

  return null;
}

async function cancelProviderIntents(candidates, logger = null) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return 0;

  const byProvider = new Map();
  for (const item of list) {
    if (!item?.referencia_externa || !item?.provider_code) continue;
    const key = String(item.provider_code).toLowerCase();
    if (!byProvider.has(key)) {
      byProvider.set(key, []);
    }
    byProvider.get(key).push(String(item.referencia_externa));
  }

  let cancelled = 0;
  for (const [providerCode, references] of byProvider.entries()) {
    const adapter = createProviderAdapterByCode(providerCode);
    if (!adapter) {
      if (logger?.warn) {
        logger.warn({ providerCode, intents: references.length }, "No existe adaptador de cancelacion para proveedor");
      }
      continue;
    }

    const outcomes = await Promise.allSettled(
      references.map(async (reference) => {
        await adapter.cancelIntent(reference);
        return reference;
      })
    );

    outcomes.forEach((result) => {
      if (result.status === "fulfilled") {
        cancelled += 1;
        return;
      }
      if (logger?.warn) {
        logger.warn(
          { providerCode, err: result.reason instanceof Error ? result.reason.message : result.reason },
          "Fallo la cancelacion del intent en proveedor"
        );
      }
    });
  }

  return cancelled;
}

function assertDb(app) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", {
      code: "DB_NOT_CONFIGURED",
    });
  }
}

export function parseUuidList(rawValue, { required = false, field = "items", unique = true } = {}) {
  const raw = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue || "").trim();
  if (!raw) {
    if (required) {
      throw new AppError(400, `El campo ${field} es obligatorio`, {
        code: "AGENDA_UUID_LIST_REQUIRED",
        details: { field },
      });
    }
    return [];
  }

  const normalizedValues = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const values = unique ? Array.from(new Set(normalizedValues)) : normalizedValues;

  if (!values.length && required) {
    throw new AppError(400, `El campo ${field} es obligatorio`, {
      code: "AGENDA_UUID_LIST_REQUIRED",
      details: { field },
    });
  }

  for (const value of values) {
    if (!UUID_PATTERN.test(value)) {
      throw new AppError(400, `El campo ${field} contiene UUIDs invalidos`, {
        code: "AGENDA_UUID_LIST_INVALID",
        details: { field, value },
      });
    }
  }

  return values;
}

export function assertUuid(value, field) {
  const raw = String(value || "").trim();
  if (!UUID_PATTERN.test(raw)) {
    throw new AppError(400, `${field} debe ser un UUID valido`, {
      code: "AGENDA_UUID_INVALID",
      details: { field, value: raw || null },
    });
  }
  return raw;
}

export function parseDateOnly(value, field = "fecha") {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(400, `${field} debe tener formato YYYY-MM-DD`, {
      code: "AGENDA_DATE_INVALID",
      details: { field, value: raw || null },
    });
  }
  return raw;
}

export function parseDateTime(value, field = "fecha_inicio") {
  const raw = String(value || "").trim();
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `${field} debe ser una fecha-hora valida`, {
      code: "AGENDA_DATETIME_INVALID",
      details: { field, value: raw || null },
    });
  }
  return parsed;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

async function mapWithConcurrency(items, limit, mapper) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, source.length));
  const results = new Array(source.length);
  let cursor = 0;

  async function worker() {
    while (cursor < source.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(source[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
  return results;
}

function startOfDay(dateString) {
  return new Date(`${dateString}T00:00:00`);
}

function endOfDay(dateString) {
  return new Date(`${dateString}T23:59:59.999`);
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function combineDateAndTime(dateString, timeString) {
  return new Date(`${dateString}T${String(timeString).slice(0, 8)}`);
}

function normalizeInterval(start, end) {
  const normalizedStart = new Date(start);
  const normalizedEnd = new Date(end);
  if (normalizedEnd.getTime() <= normalizedStart.getTime()) {
    return null;
  }
  return { start: normalizedStart, end: normalizedEnd };
}

function mergeIntervals(intervals) {
  const prepared = (Array.isArray(intervals) ? intervals : [])
    .filter(Boolean)
    .map((entry) => normalizeInterval(entry.start, entry.end))
    .filter(Boolean)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  if (!prepared.length) return [];

  const merged = [prepared[0]];
  for (const current of prepared.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function subtractIntervals(baseIntervals, busyIntervals) {
  const free = [];
  const mergedBusy = mergeIntervals(busyIntervals);

  for (const base of baseIntervals) {
    let pointer = new Date(base.start);
    for (const busy of mergedBusy) {
      if (busy.end.getTime() <= pointer.getTime()) continue;
      if (busy.start.getTime() >= base.end.getTime()) break;

      if (busy.start.getTime() > pointer.getTime()) {
        free.push({
          start: new Date(pointer),
          end: new Date(Math.min(busy.start.getTime(), base.end.getTime())),
        });
      }

      if (busy.end.getTime() > pointer.getTime()) {
        pointer = new Date(Math.max(pointer.getTime(), busy.end.getTime()));
      }
    }

    if (pointer.getTime() < base.end.getTime()) {
      free.push({
        start: new Date(pointer),
        end: new Date(base.end),
      });
    }
  }

  return free.filter((entry) => entry.end.getTime() > entry.start.getTime());
}

function toTimeLabel(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function toHourMinute(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function isFullDayInterval(start, end) {
  const nextDayStart = startOfDay(formatDateOnly(addMinutes(start, 24 * 60)));
  return start.getHours() === 0
    && start.getMinutes() === 0
    && start.getSeconds() === 0
    && end.getTime() >= nextDayStart.getTime();
}

export async function getHoldDurationMinutes(client) {
  const { rows } = await client.query(
    `
      SELECT COALESCE(valor_numero, 5)::int AS hold_duracion_min
      FROM public.parametros_sistema
      WHERE clave = 'hold_duracion_min'
      LIMIT 1
    `
  );
  return rows[0]?.hold_duracion_min ?? 5;
}

export async function getGlobalBufferMinutes(client) {
  const { rows } = await client.query(
    `
      SELECT COALESCE(valor_numero, 0)::int AS agenda_buffer_global_min
      FROM public.parametros_sistema
      WHERE clave = 'agenda_buffer_global_min'
      LIMIT 1
    `
  );
  const value = Number(rows[0]?.agenda_buffer_global_min ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function getSystemParameters(client) {
  const { rows } = await client.query(
    `
      SELECT clave, valor_texto, valor_numero, valor_booleano, descripcion
      FROM public.parametros_sistema
      WHERE clave = ANY($1::text[])
      ORDER BY clave ASC
    `,
    [SYSTEM_PARAMETER_KEYS]
  );

  const values = {};
  for (const row of rows) {
    values[row.clave] = {
      clave: row.clave,
      valor_texto: row.valor_texto ?? null,
      valor_numero: row.valor_numero == null ? null : Number(row.valor_numero),
      valor_booleano: row.valor_booleano == null ? null : Boolean(row.valor_booleano),
      descripcion: row.descripcion ?? null,
    };
  }
  return values;
}

export async function expireStaleAppointmentReservations(client, { now = new Date(), logger = null } = {}) {
  const referenceNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(referenceNow.getTime())) {
    throw new AppError(400, "Parametro now invalido para expiracion de reservas", {
      code: "AGENDA_EXPIRE_NOW_INVALID",
    });
  }

  const expiredHoldsResult = await client.query(
    `
      UPDATE public.citas_holds h
      SET estado_hold_codigo = 'expirado',
          updated_at = now()
      WHERE h.estado_hold_codigo = 'activo'
        AND h.expires_at <= $1::timestamptz
      RETURNING h.id_hold, h.id_cita
    `,
    [referenceNow.toISOString()]
  );

  const expiredHolds = expiredHoldsResult.rows;
  const expiredHoldIds = expiredHolds.map((row) => row.id_hold);
  const expiredCitaIds = Array.from(new Set(expiredHolds.map((row) => row.id_cita)));

  let citasExpiradas = 0;
  if (expiredCitaIds.length) {
    const citaResult = await client.query(
      `
        UPDATE public.citas c
        SET estado_cita_codigo = 'expirada',
            updated_at = now()
        WHERE c.id_cita = ANY($1::uuid[])
          AND c.estado_cita_codigo = ANY($2::text[])
      `,
      [expiredCitaIds, HOLD_EXPIRABLE_APPOINTMENT_STATES]
    );
    citasExpiradas = Number(citaResult.rowCount || 0);
  }

  const expiredIntentResult = await client.query(
    `
      WITH target_intents AS (
        SELECT
          pi.id_intent,
          pi.referencia_externa,
          pp.codigo AS provider_code
        FROM public.payment_intents pi
        JOIN public.payment_providers pp
          ON pp.id_provider = pi.id_provider
        WHERE pi.estado_intent_codigo = ANY($2::text[])
          AND (
            pi.expires_at <= $1::timestamptz
            OR (cardinality($3::uuid[]) > 0 AND pi.id_hold = ANY($3::uuid[]))
            OR (cardinality($4::uuid[]) > 0 AND pi.id_cita = ANY($4::uuid[]))
          )
      )
      UPDATE public.payment_intents pi
      SET estado_intent_codigo = 'expirado',
          updated_at = now()
      FROM target_intents ti
      WHERE pi.id_intent = ti.id_intent
      RETURNING pi.id_intent, ti.referencia_externa, ti.provider_code
    `,
    [referenceNow.toISOString(), ACTIVE_PAYMENT_INTENT_STATES, expiredHoldIds, expiredCitaIds]
  );

  const cancelledProviderIntents = await cancelProviderIntents(expiredIntentResult.rows, logger);

  const autoNoShowResult = await client.query(
    `
      UPDATE public.citas c
      SET estado_cita_codigo = 'no_show',
          no_show_at = COALESCE(c.no_show_at, now()),
          updated_at = now()
      WHERE c.deleted_at IS NULL
        AND c.estado_cita_codigo = 'confirmada'
        AND c.inicio_at + make_interval(mins => $1::int) <= $2::timestamptz
      RETURNING c.id_cita
    `,
    [AUTO_NO_SHOW_GRACE_MINUTES, referenceNow.toISOString()]
  );

  return {
    expired_holds: expiredHolds.length,
    expired_citas: citasExpiradas,
    expired_intents: expiredIntentResult.rowCount || 0,
    canceled_provider_intents: cancelledProviderIntents,
    auto_no_show: Number(autoNoShowResult.rowCount || 0),
  };
}

export async function resolveBranchIdsForClaims(app, claims) {
  assertDb(app);

  const isSuperAdmin = Array.isArray(claims?.roles) && claims.roles.includes("super_admin");
  if (isSuperAdmin) {
    const { rows } = await app.db.query(
      `
        SELECT id_sucursal
        FROM public.sucursales
        WHERE deleted_at IS NULL
          AND estado IS TRUE
        ORDER BY nombre_sucursal ASC
      `
    );
    return rows.map((row) => row.id_sucursal);
  }

  const branchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.filter(Boolean) : [];
  if (!branchIds.length) {
    return [];
  }

  const { rows } = await app.db.query(
    `
      SELECT id_sucursal
      FROM public.sucursales
      WHERE deleted_at IS NULL
        AND estado IS TRUE
        AND id_sucursal = ANY($1::uuid[])
      ORDER BY nombre_sucursal ASC
    `,
    [branchIds]
  );
  return rows.map((row) => row.id_sucursal);
}

export async function ensureBranchScope(app, claims, branchId) {
  const scopedIds = await resolveBranchIdsForClaims(app, claims);
  if (!scopedIds.includes(branchId)) {
    throw new AppError(403, "La sucursal solicitada no pertenece al alcance del usuario autenticado", {
      code: "AGENDA_BRANCH_FORBIDDEN",
      details: { id_sucursal: branchId },
    });
  }
}

export async function ensureActiveBranch(client, branchId) {
  const safeBranchId = assertUuid(branchId, "id_sucursal");
  const { rows } = await client.query(
    `
      SELECT id_sucursal, nombre_sucursal
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
        AND estado IS TRUE
      LIMIT 1
    `,
    [safeBranchId]
  );
  if (!rows[0]) {
    throw new AppError(404, "La sucursal solicitada no existe o esta inactiva", {
      code: "AGENDA_BRANCH_NOT_FOUND",
      details: { id_sucursal: safeBranchId },
    });
  }
  return rows[0];
}

export async function getBarberById(client, empleadoId) {
  const safeId = assertUuid(empleadoId, "id_barbero");
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        s.nombre_sucursal,
        p.nombres,
        p.apellidos
      FROM public.empleados e
      JOIN public.personas p
        ON p.id_persona = e.id_persona
      JOIN public.sucursales s
        ON s.id_sucursal = e.id_sucursal
      WHERE e.id_empleado = $1::uuid
        AND e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND s.deleted_at IS NULL
        AND s.estado IS TRUE
      LIMIT 1
    `,
    [safeId]
  );

  if (!rows[0]) {
    throw new AppError(404, "El barbero solicitado no existe o esta inactivo", {
      code: "AGENDA_BARBER_NOT_FOUND",
      details: { id_barbero: safeId },
    });
  }
  return mapBarberRow(rows[0]);
}

export async function listBarbersForBranch(client, branchId) {
  const safeBranchId = assertUuid(branchId, "id_sucursal");
  const { rows } = await client.query(
    `
      SELECT
        e.id_empleado,
        e.id_sucursal,
        s.nombre_sucursal,
        p.nombres,
        p.apellidos
      FROM public.empleados e
      JOIN public.personas p
        ON p.id_persona = e.id_persona
      JOIN public.sucursales s
        ON s.id_sucursal = e.id_sucursal
      WHERE e.id_sucursal = $1::uuid
        AND e.deleted_at IS NULL
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND s.deleted_at IS NULL
        AND s.estado IS TRUE
      ORDER BY p.nombres ASC, p.apellidos ASC, e.id_empleado ASC
    `,
    [safeBranchId]
  );

  return rows.map(mapBarberRow);
}

function mapBarberRow(row) {
  const nombres = String(row.nombres || "").trim();
  const apellidos = String(row.apellidos || "").trim();
  return {
    id_empleado: row.id_empleado,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    nombres,
    apellidos,
    nombre_completo: `${nombres} ${apellidos}`.trim() || "Sin nombre",
  };
}

export async function getServiceSelectionDetails(client, branchId, serviceIds, barberId = null) {
  const safeBranchId = assertUuid(branchId, "id_sucursal");
  const safeBarberId = barberId ? assertUuid(barberId, "id_barbero") : null;
  const requestedIds = parseUuidList(serviceIds, { required: true, field: "servicios", unique: false });
  const uniqueIds = Array.from(new Set(requestedIds));

  const [servicesResult, globalBufferMin] = await Promise.all([
    client.query(
      `
      WITH active_tariffs AS (
        SELECT
          st.id_servicio,
          st.precio_hnl,
          COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
          ROW_NUMBER() OVER (
            PARTITION BY st.id_servicio
            ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
          ) AS rn
        FROM public.servicios_tarifas st
        WHERE st.id_sucursal = $1::uuid
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            ($3::uuid IS NULL AND st.id_empleado IS NULL)
            OR ($3::uuid IS NOT NULL AND st.id_empleado = $3::uuid)
          )
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      )
      SELECT
        s.id_servicio,
        s.nombre_servicio,
        s.duracion_min,
        s.buffer_min,
        at.precio_hnl
      FROM public.servicios s
      LEFT JOIN active_tariffs at
        ON at.id_servicio = s.id_servicio
       AND at.rn = 1
      WHERE s.id_servicio = ANY($2::uuid[])
        AND s.deleted_at IS NULL
        AND s.activo IS TRUE
        AND COALESCE(s.agendable, TRUE) IS TRUE
        AND COALESCE(at.servicio_informativo, FALSE) IS FALSE
      ORDER BY s.nombre_servicio ASC
    `,
      [safeBranchId, uniqueIds, safeBarberId]
    ),
    getGlobalBufferMinutes(client),
  ]);
  const { rows } = servicesResult;

  if (rows.length !== uniqueIds.length) {
    throw new AppError(404, "Uno o mas servicios no existen o estan inactivos", {
      code: "AGENDA_SERVICE_NOT_FOUND",
      details: { servicios: uniqueIds, encontrados: rows.map((row) => row.id_servicio) },
    });
  }

  const byId = new Map();
  for (const row of rows) {
    if (row.precio_hnl == null) {
      throw new AppError(409, "Uno o mas servicios no tienen tarifa activa para el alcance solicitado", {
        code: "AGENDA_SERVICE_TARIFF_MISSING",
        details: { id_servicio: row.id_servicio, id_sucursal: safeBranchId, id_barbero: safeBarberId },
      });
    }
    byId.set(row.id_servicio, {
      id_servicio: row.id_servicio,
      nombre_servicio: row.nombre_servicio,
      duracion_min: Number(row.duracion_min),
      buffer_min: Number(row.buffer_min ?? 0),
      precio_hnl: Number(row.precio_hnl),
    });
  }

  const details = requestedIds.map((idServicio) => byId.get(idServicio)).filter(Boolean);

  return {
    branchId: safeBranchId,
    items: details,
    duracion_total_min: details.reduce((total, item) => total + item.duracion_min, 0),
    // El buffer se configura globalmente y se aplica una sola vez por cita.
    buffer_total_min: details.length > 0 ? Number(globalBufferMin || 0) : 0,
    monto_total_hnl: details.reduce((total, item) => total + item.precio_hnl, 0),
  };
}

async function getSchedulesForBarberOnDate(client, empleadoId, dateString) {
  const targetDate = parseDateOnly(dateString, "fecha");
  const dayOfWeek = startOfDay(targetDate).getDay();
  const direct = await client.query(
    `
      SELECT
        hora_inicio,
        hora_fin,
        almuerzo_inicio,
        almuerzo_fin
      FROM public.horarios_semanales_empleados
      WHERE id_empleado = $1::uuid
        AND dia_semana = $2::smallint
        AND activo IS TRUE
      ORDER BY hora_inicio ASC
    `,
    [empleadoId, dayOfWeek]
  );

  if (direct.rows.length) {
    return direct.rows;
  }

  // Si el barbero aun no tiene horario propio, usar la plantilla horaria activa de su sucursal.
  const fallback = await client.query(
    `
      WITH target_branch AS (
        SELECT id_sucursal
        FROM public.empleados
        WHERE id_empleado = $1::uuid
          AND deleted_at IS NULL
          AND estado IS TRUE
        LIMIT 1
      ),
      template_employee AS (
        SELECT e.id_empleado
        FROM public.empleados e
        JOIN target_branch tb
          ON tb.id_sucursal = e.id_sucursal
        WHERE e.deleted_at IS NULL
          AND e.estado IS TRUE
          AND EXISTS (
            SELECT 1
            FROM public.horarios_semanales_empleados hs
            WHERE hs.id_empleado = e.id_empleado
              AND hs.dia_semana = $2::smallint
              AND hs.activo IS TRUE
          )
        ORDER BY e.es_barbero DESC, e.id_empleado ASC
        LIMIT 1
      )
      SELECT
        hs.hora_inicio,
        hs.hora_fin,
        hs.almuerzo_inicio,
        hs.almuerzo_fin
      FROM public.horarios_semanales_empleados hs
      WHERE hs.id_empleado = (SELECT id_empleado FROM template_employee)
        AND hs.dia_semana = $2::smallint
        AND hs.activo IS TRUE
      ORDER BY hs.hora_inicio ASC
    `,
    [empleadoId, dayOfWeek]
  );

  if (fallback.rows.length) {
    return fallback.rows;
  }

  // Fallback defensivo para no dejar el calendario inutilizable si aun no se ha configurado horario por barbero.
  if (dayOfWeek === 0) {
    return [];
  }
  const isWeekend = dayOfWeek === 6;
  return [
    {
      hora_inicio: "08:00:00",
      hora_fin: isWeekend ? "17:00:00" : "19:00:00",
      almuerzo_inicio: "12:00:00",
      almuerzo_fin: "13:00:00",
    },
  ];
}

async function getBusyIntervalsForBarber(client, empleadoId, dateString) {
  const safeDate = parseDateOnly(dateString, "fecha");
  const dayStart = startOfDay(safeDate);
  const dayEnd = endOfDay(safeDate);

  const [bloqueosResult, citasResult] = await Promise.all([
    client.query(
      `
        SELECT lower(rango) AS inicio_at, upper(rango) AS fin_at
        FROM public.bloqueos_agenda
        WHERE id_empleado = $1::uuid
          AND rango && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        ORDER BY lower(rango) ASC
      `,
      [empleadoId, dayStart.toISOString(), dayEnd.toISOString()]
    ),
    client.query(
      `
        SELECT inicio_at, fin_at
        FROM public.citas
        WHERE id_empleado_barbero = $1::uuid
          AND deleted_at IS NULL
          AND estado_cita_codigo = ANY($2::text[])
          AND tstzrange(inicio_at, fin_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        ORDER BY inicio_at ASC
      `,
      [empleadoId, OCCUPIED_APPOINTMENT_STATES, dayStart.toISOString(), dayEnd.toISOString()]
    ),
  ]);

  return [
    ...bloqueosResult.rows.map((row) => ({ start: row.inicio_at, end: row.fin_at })),
    ...citasResult.rows.map((row) => ({ start: row.inicio_at, end: row.fin_at })),
  ];
}

async function getBusyIntervalsForBarberByRange(client, empleadoId, fromDateString, toDateString) {
  const safeFrom = parseDateOnly(fromDateString, "fecha_desde");
  const safeTo = parseDateOnly(toDateString, "fecha_hasta");
  const rangeStart = startOfDay(safeFrom);
  const rangeEndExclusive = addMinutes(startOfDay(safeTo), 24 * 60);

  const [bloqueosResult, citasResult] = await Promise.all([
    client.query(
      `
        SELECT lower(rango) AS inicio_at, upper(rango) AS fin_at
        FROM public.bloqueos_agenda
        WHERE id_empleado = $1::uuid
          AND rango && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        ORDER BY lower(rango) ASC
      `,
      [empleadoId, rangeStart.toISOString(), rangeEndExclusive.toISOString()]
    ),
    client.query(
      `
        SELECT inicio_at, fin_at
        FROM public.citas
        WHERE id_empleado_barbero = $1::uuid
          AND deleted_at IS NULL
          AND estado_cita_codigo = ANY($2::text[])
          AND tstzrange(inicio_at, fin_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        ORDER BY inicio_at ASC
      `,
      [empleadoId, OCCUPIED_APPOINTMENT_STATES, rangeStart.toISOString(), rangeEndExclusive.toISOString()]
    ),
  ]);

  return [
    ...bloqueosResult.rows.map((row) => ({ start: row.inicio_at, end: row.fin_at })),
    ...citasResult.rows.map((row) => ({ start: row.inicio_at, end: row.fin_at })),
  ]
    .map((entry) => normalizeInterval(entry.start, entry.end))
    .filter(Boolean);
}

function buildBaseIntervalsFromSchedules(dateString, schedules) {
  const intervals = [];
  for (const row of schedules) {
    const workInterval = normalizeInterval(
      combineDateAndTime(dateString, row.hora_inicio),
      combineDateAndTime(dateString, row.hora_fin)
    );
    if (!workInterval) continue;

    const blocks = [];
    if (row.almuerzo_inicio && row.almuerzo_fin) {
      const lunchInterval = normalizeInterval(
        combineDateAndTime(dateString, row.almuerzo_inicio),
        combineDateAndTime(dateString, row.almuerzo_fin)
      );
      if (lunchInterval) {
        blocks.push(lunchInterval);
      }
    }

    intervals.push(...subtractIntervals([workInterval], blocks));
  }
  return intervals;
}

function buildSlotsFromIntervals(intervals, serviceDurationMinutes, stepMinutes = SLOT_INTERVAL_MINUTES) {
  const slots = [];

  function alignIntervalStartToStep(dateValue) {
    const aligned = new Date(dateValue);
    aligned.setSeconds(0, 0);
    const minutesFromDayStart = aligned.getHours() * 60 + aligned.getMinutes();
    const remainder = minutesFromDayStart % stepMinutes;
    if (remainder > 0) {
      aligned.setMinutes(aligned.getMinutes() + (stepMinutes - remainder));
    }
    return aligned;
  }

  for (const interval of intervals) {
    let cursor = alignIntervalStartToStep(interval.start);
    while (cursor.getTime() + serviceDurationMinutes * 60 * 1000 <= interval.end.getTime()) {
      const slotEnd = addMinutes(cursor, serviceDurationMinutes);
      slots.push({
        inicio_at: new Date(cursor),
        fin_at: slotEnd,
        hora: toTimeLabel(cursor),
      });
      cursor = addMinutes(cursor, stepMinutes);
    }
  }
  return slots;
}

export async function getAvailableSlotsForBarber(client, empleadoId, dateString, serviceTotalMinutes) {
  const safeBarberId = assertUuid(empleadoId, "id_barbero");
  const safeDate = parseDateOnly(dateString, "fecha");
  const schedules = await getSchedulesForBarberOnDate(client, safeBarberId, safeDate);
  if (!schedules.length) {
    return [];
  }

  const baseIntervals = buildBaseIntervalsFromSchedules(safeDate, schedules);
  if (!baseIntervals.length) {
    return [];
  }

  const busyIntervals = await getBusyIntervalsForBarber(client, safeBarberId, safeDate);
  const freeIntervals = subtractIntervals(baseIntervals, busyIntervals);
  return buildSlotsFromIntervals(freeIntervals, serviceTotalMinutes, SLOT_INTERVAL_MINUTES);
}

export async function getBarberScheduleBounds(client, empleadoId, dateString) {
  const safeBarberId = assertUuid(empleadoId, "id_barbero");
  const safeDate = parseDateOnly(dateString, "fecha");
  const schedules = await getSchedulesForBarberOnDate(client, safeBarberId, safeDate);
  if (!schedules.length) {
    return { hora_inicio: null, hora_fin: null };
  }

  let horaInicio = null;
  let horaFin = null;
  for (const row of schedules) {
    const start = toHourMinute(row?.hora_inicio);
    const end = toHourMinute(row?.hora_fin);
    if (!start || !end) continue;
    if (!horaInicio || start < horaInicio) horaInicio = start;
    if (!horaFin || end > horaFin) horaFin = end;
  }

  return {
    hora_inicio: horaInicio,
    hora_fin: horaFin,
  };
}

export async function findFirstAvailableBarber(client, branchId, dateString, serviceTotalMinutes) {
  const barbers = await listBarbersForBranch(client, branchId);
  const withSlots = await mapWithConcurrency(barbers, 4, async (barber) => ({
    barber,
    slots: await getAvailableSlotsForBarber(client, barber.id_empleado, dateString, serviceTotalMinutes),
  }));
  const first = withSlots.find((entry) => entry.slots.length > 0) ?? null;
  return first;
}

export async function buildDayAvailability(client, branchId, serviceSelection, dateString, barberId = null, options = {}) {
  const safeDate = parseDateOnly(dateString, "fecha");
  const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;

  if (barberId) {
    const preloadedBarber = options?.barber;
    const barber = preloadedBarber?.id_empleado === barberId ? preloadedBarber : await getBarberById(client, barberId);
    if (barber.id_sucursal !== branchId) {
      throw new AppError(409, "El barbero no pertenece a la sucursal solicitada", {
        code: "AGENDA_BARBER_BRANCH_MISMATCH",
        details: { id_barbero: barberId, id_sucursal: branchId },
      });
    }

    const slots = await getAvailableSlotsForBarber(client, barber.id_empleado, safeDate, serviceTotalMinutes);
    const bounds = await getBarberScheduleBounds(client, barber.id_empleado, safeDate);
    return {
      fecha: safeDate,
      disponible: slots.length > 0,
      barberos_disponibles: slots.length > 0 ? 1 : 0,
      primer_horario_disponible: slots[0]?.hora ?? null,
      barbero_autoasignado: barber,
      hora_inicio: bounds.hora_inicio,
      hora_fin: bounds.hora_fin,
      slots,
    };
  }

  const barbers = Array.isArray(options?.barbers) ? options.barbers : await listBarbersForBranch(client, branchId);
  if (!barbers.length) {
    return {
      fecha: safeDate,
      disponible: false,
      barberos_disponibles: 0,
      primer_horario_disponible: null,
      barbero_autoasignado: null,
      hora_inicio: null,
      hora_fin: null,
      slots: [],
    };
  }

  const withSlots = await mapWithConcurrency(barbers, 4, async (barber) => ({
    barber,
    slots: await getAvailableSlotsForBarber(client, barber.id_empleado, safeDate, serviceTotalMinutes),
  }));

  let availableCount = 0;
  let firstSlot = null;
  let autoBarber = null;

  for (const { barber, slots } of withSlots) {
    if (slots.length > 0) {
      availableCount += 1;
      if (!firstSlot || slots[0].inicio_at.getTime() < firstSlot.inicio_at.getTime()) {
        firstSlot = slots[0];
        autoBarber = barber;
      }
    }
  }

  return {
    fecha: safeDate,
    disponible: availableCount > 0,
    barberos_disponibles: availableCount,
    primer_horario_disponible: firstSlot?.hora ?? null,
    barbero_autoasignado: autoBarber,
    hora_inicio: null,
    hora_fin: null,
    slots: [],
  };
}

export async function listAvailabilityByDateRange(client, branchId, serviceSelection, fromDate, toDate, barberId = null) {
  const safeFrom = parseDateOnly(fromDate, "fecha_desde");
  const safeTo = parseDateOnly(toDate, "fecha_hasta");
  const startDate = startOfDay(safeFrom);
  const endDate = startOfDay(safeTo);

  if (endDate.getTime() < startDate.getTime()) {
    throw new AppError(400, "fecha_hasta no puede ser menor que fecha_desde", {
      code: "AGENDA_DATE_RANGE_INVALID",
      details: { fecha_desde: safeFrom, fecha_hasta: safeTo },
    });
  }

  const dateKeys = [];
  for (let current = new Date(startDate); current.getTime() <= endDate.getTime(); current = addMinutes(current, 24 * 60)) {
    dateKeys.push(formatDateOnly(current));
  }

  if (barberId) {
    const barber = await getBarberById(client, barberId);
    if (barber.id_sucursal !== branchId) {
      throw new AppError(409, "El barbero no pertenece a la sucursal solicitada", {
        code: "AGENDA_BARBER_BRANCH_MISMATCH",
        details: { id_barbero: barberId, id_sucursal: branchId },
      });
    }
    const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;
    const sampleDateByWeekday = new Map();
    for (const dateKey of dateKeys) {
      const weekday = startOfDay(dateKey).getDay();
      if (!sampleDateByWeekday.has(weekday)) {
        sampleDateByWeekday.set(weekday, dateKey);
      }
    }

    const schedulesByWeekday = new Map();
    await Promise.all(
      Array.from(sampleDateByWeekday.entries()).map(async ([weekday, sampleDate]) => {
        const schedules = await getSchedulesForBarberOnDate(client, barber.id_empleado, sampleDate);
        schedulesByWeekday.set(weekday, schedules);
      })
    );

    const busyIntervals = await getBusyIntervalsForBarberByRange(client, barber.id_empleado, safeFrom, safeTo);
    const availability = [];

    for (const dateKey of dateKeys) {
      const dayStart = startOfDay(dateKey);
      const dayEnd = endOfDay(dateKey);
      const weekday = dayStart.getDay();
      const schedules = schedulesByWeekday.get(weekday) || [];

      const baseIntervals = buildBaseIntervalsFromSchedules(dateKey, schedules);
      if (!baseIntervals.length) {
        availability.push({
          fecha: dateKey,
          disponible: false,
          barberos_disponibles: 0,
          primer_horario_disponible: null,
          barbero_autoasignado: barber,
          slots: [],
        });
        continue;
      }

      const dayBusyIntervals = busyIntervals.filter(
        (entry) => entry.end.getTime() > dayStart.getTime() && entry.start.getTime() < dayEnd.getTime()
      );
      const freeIntervals = subtractIntervals(baseIntervals, dayBusyIntervals);
      const slots = buildSlotsFromIntervals(freeIntervals, serviceTotalMinutes, SLOT_INTERVAL_MINUTES);

      availability.push({
        fecha: dateKey,
        disponible: slots.length > 0,
        barberos_disponibles: slots.length > 0 ? 1 : 0,
        primer_horario_disponible: slots[0]?.hora ?? null,
        barbero_autoasignado: barber,
        slots: [],
      });
    }

    return availability;
  }

  const barbers = await listBarbersForBranch(client, branchId);
  if (!barbers.length) {
    return dateKeys.map((dateKey) => ({
      fecha: dateKey,
      disponible: false,
      barberos_disponibles: 0,
      primer_horario_disponible: null,
      barbero_autoasignado: null,
      slots: [],
    }));
  }

  return mapWithConcurrency(dateKeys, 4, (dateKey) =>
    buildDayAvailability(client, branchId, serviceSelection, dateKey, null, { barbers })
  );
}

export async function resolveBookingSelection(client, { id_sucursal, servicios, fecha_inicio, id_barbero = null }) {
  const branch = await ensureActiveBranch(client, id_sucursal);
  const serviceSelection = await getServiceSelectionDetails(client, branch.id_sucursal, servicios, id_barbero);
  const startDateTime = parseDateTime(fecha_inicio, "fecha_inicio");
  const dateKey = formatDateOnly(startDateTime);
  const timeKey = toTimeLabel(startDateTime);
  const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;

  let selectedBarber;
  if (id_barbero) {
    const barber = await getBarberById(client, id_barbero);
    if (barber.id_sucursal !== branch.id_sucursal) {
      throw new AppError(409, "El barbero no pertenece a la sucursal solicitada", {
        code: "AGENDA_BARBER_BRANCH_MISMATCH",
        details: { id_barbero, id_sucursal: branch.id_sucursal },
      });
    }
    const slots = await getAvailableSlotsForBarber(client, barber.id_empleado, dateKey, serviceTotalMinutes);
    const matchingSlot = slots.find((slot) => slot.hora === timeKey);
    if (!matchingSlot) {
      throw new AppError(409, "El horario solicitado no esta disponible", {
        code: "AGENDA_SLOT_NOT_AVAILABLE",
        details: { id_barbero: barber.id_empleado, fecha: dateKey, hora: timeKey },
      });
    }
    selectedBarber = barber;
  } else {
    const barbers = await listBarbersForBranch(client, branch.id_sucursal);
    const candidates = [];
    for (const barber of barbers) {
      const slots = await getAvailableSlotsForBarber(client, barber.id_empleado, dateKey, serviceTotalMinutes);
      if (slots.some((slot) => slot.hora === timeKey)) {
        candidates.push(barber);
      }
    }
    if (!candidates.length) {
      throw new AppError(409, "No existe un barbero disponible para el horario solicitado", {
        code: "AGENDA_AUTOASSIGN_NOT_AVAILABLE",
        details: { fecha: dateKey, hora: timeKey, id_sucursal: branch.id_sucursal },
      });
    }
    const randomIndex = Math.floor(Math.random() * candidates.length);
    selectedBarber = candidates[randomIndex];
  }

  return {
    branch,
    barber: selectedBarber,
    serviceSelection,
    startDateTime,
    expiresAt: addMinutes(new Date(), await getHoldDurationMinutes(client)),
  };
}

export async function insertAppointmentNotification(client, payload) {
  const {
    id_usuario_destino = null,
    correo_destino,
    asunto,
    cuerpo,
    evento,
    plantilla_codigo = null,
    estado_notificacion_codigo = "pendiente",
    id_cita = null,
    enviado_en = null,
    ultimo_error = null,
  } = payload || {};

  const { rows } = await client.query(
    `
      INSERT INTO public.notificaciones_email (
        evento,
        id_usuario_destino,
        correo_destino,
        asunto,
        cuerpo,
        plantilla_codigo,
        estado_notificacion_codigo,
        id_cita,
        enviado_en,
        ultimo_error
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9::timestamptz, $10)
      RETURNING id_notificacion, estado_notificacion_codigo, enviado_en, ultimo_error
    `,
    [
      evento,
      id_usuario_destino,
      correo_destino,
      asunto,
      cuerpo,
      plantilla_codigo,
      estado_notificacion_codigo,
      id_cita,
      enviado_en,
      ultimo_error,
    ]
  );

  return rows[0] ?? null;
}

export function mapSlotsForResponse(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => ({
    hora: slot.hora,
    inicio_at: slot.inicio_at.toISOString(),
    fin_at: slot.fin_at.toISOString(),
  }));
}

export function mapDayAvailabilityForResponse(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    fecha: entry.fecha,
    disponible: Boolean(entry.disponible),
    barberos_disponibles: Number(entry.barberos_disponibles ?? 0),
    primer_horario_disponible: entry.primer_horario_disponible ?? null,
    barbero_autoasignado: entry.barbero_autoasignado
      ? {
          id_empleado: entry.barbero_autoasignado.id_empleado,
          nombre_completo: entry.barbero_autoasignado.nombre_completo,
          nombres: entry.barbero_autoasignado.nombres,
          apellidos: entry.barbero_autoasignado.apellidos,
          id_sucursal: entry.barbero_autoasignado.id_sucursal,
          nombre_sucursal: entry.barbero_autoasignado.nombre_sucursal,
        }
      : null,
  }));
}

export function mapBarbersForResponse(barbers) {
  return (Array.isArray(barbers) ? barbers : []).map((barber) => ({
    id_empleado: barber.id_empleado,
    id_sucursal: barber.id_sucursal,
    nombre_sucursal: barber.nombre_sucursal ?? null,
    nombre_completo: barber.nombre_completo,
    nombres: barber.nombres,
    apellidos: barber.apellidos,
  }));
}

export function mapBlockRow(row) {
  const start = new Date(row.inicio_at);
  const end = new Date(row.fin_at);
  return {
    id_bloqueo: row.id_bloqueo,
    id_empleado: row.id_empleado,
    id_sucursal: row.id_sucursal,
    tipo_bloqueo_codigo: row.tipo_bloqueo_codigo,
    motivo: row.motivo ?? null,
    inicio_at: start.toISOString(),
    fin_at: end.toISOString(),
    fecha: formatDateOnly(start),
    es_dia_completo: isFullDayInterval(start, end),
    nombre_completo: row.nombre_completo ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
  };
}
