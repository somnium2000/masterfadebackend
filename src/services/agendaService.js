import { AppError } from "../utils/errors.js";
import { MockPaymentProvider } from "./payments/MockPaymentProvider.js";
import { PaymentProviderFactory } from "./payments/PaymentProviderFactory.js";
import {
  assertPaymentProviderConfig,
  normalizePaymentProviderCode,
} from "./payments/paymentRuntimeGuard.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OCCUPIED_APPOINTMENT_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon", "en_atencion"];
export const OPERATIONAL_APPOINTMENT_STATES = ["en_espera", "pendiente_pago", "confirmada", "en_salon", "en_atencion"];
export const BOOKING_SELECTION_TYPES = ["services", "package", "mixed"];
export const HOLD_EXPIRABLE_APPOINTMENT_STATES = ["en_espera", "pendiente_pago"];
export const ACTIVE_PAYMENT_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];
export const AUTO_NO_SHOW_GRACE_MINUTES = 5;
export const APPOINTMENT_STATE_TRANSITIONS = {
  en_espera: ["confirmada", "cancelada", "expirada"],
  pendiente_pago: ["confirmada", "cancelada", "expirada"],
  confirmada: ["en_salon", "cancelada", "no_show"],
  en_salon: ["en_atencion", "no_show"],
  en_atencion: ["completada"],
};
export const SYSTEM_PARAMETER_KEYS = [
  "hold_duracion_min",
  "no_show_min",
  "agenda_buffer_global_min",
  "agenda_min_servicio_vendible_min",
  "permitir_acompanantes",
  "pago_total_obligatorio",
  "simulacion_sin_pago",
  "masterpuntos_migracion_manual_habilitada",
];
export const SLOT_INTERVAL_MINUTES = 5;
export const AGENDA_DEFAULT_TIME_ZONE = String(
  process.env.AGENDA_TIME_ZONE
  || process.env.APP_TIME_ZONE
  || "America/Tegucigalpa"
).trim();
export const SERVICE_BARBER_ASSIGNMENTS_ENABLED = String(
  process.env.SERVICE_BARBER_ASSIGNMENTS_ENABLED ?? "false"
).trim().toLowerCase() === "true";
export const SLOT_DISCARD_REASONS = {
  RESIDUAL_GAP_NOT_SELLABLE: "RESIDUAL_GAP_NOT_SELLABLE",
  DURATION_INSUFFICIENT: "DURATION_INSUFFICIENT",
  CONFLICT_WITH_APPOINTMENT: "CONFLICT_WITH_APPOINTMENT",
  CONFLICT_WITH_HOLD: "CONFLICT_WITH_HOLD",
  CONFLICT_WITH_BLOCK: "CONFLICT_WITH_BLOCK",
  CROSS_BLOCK_BOUNDARY: "CROSS_BLOCK_BOUNDARY",
  RESOURCE_UNAVAILABLE: "RESOURCE_UNAVAILABLE",
};
export const AGENDAMIENTO_ISV_ALLOWED_MODES = ["no_aplica"];
export const AGENDAMIENTO_CONFIG_DEFAULTS = {
  maxAcompanantes: 4,
  holdTtlMinutos: 5,
  isvHabilitado: false,
  isvPorcentajeDefault: 0,
  isvModo: "no_aplica",
  permitirSeleccionMixta: true,
  maxPromocionesPorReserva: 5,
  comprobanteEmailHabilitado: true,
  validarPromocionesBackend: true,
  validarPromocionesFrontend: true,
  facturacionCaiHabilitada: false,
  facturacionCaiIntegracionSarHabilitada: false,
  emitirFacturaFiscal: false,
};
const AGENDAMIENTO_CONFIG_PARAMETER_KEYS = [
  "agendamiento_max_acompanantes",
  "agendamiento_hold_ttl_minutos",
  "agendamiento_isv_habilitado",
  "agendamiento_isv_porcentaje_default",
  "agendamiento_isv_modo",
  "agendamiento_permitir_seleccion_mixta",
  "agendamiento_max_promociones_por_reserva",
  "agendamiento_comprobante_email_habilitado",
  "agendamiento_validar_promociones_backend",
  "agendamiento_validar_promociones_frontend",
  "facturacion_cai_habilitada",
  "facturacion_cai_integracion_sar_habilitada",
  "facturacion_emitir_factura_fiscal",
  "hold_duracion_min",
  "permitir_acompanantes",
];

function resolveAgendamientoRawValue(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.valor_booleano !== null && entry.valor_booleano !== undefined) return entry.valor_booleano;
  if (entry.valor_numero !== null && entry.valor_numero !== undefined) return entry.valor_numero;
  if (entry.valor_texto !== null && entry.valor_texto !== undefined) return entry.valor_texto;
  return null;
}
function parseConfigBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "si", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseConfigInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function parseConfigDecimal(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseConfigText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function logAgendamientoConfigWarning(logger, details, message) {
  if (!logger?.warn) return;
  logger.warn(details, message);
}

export async function getAgendamientoConfig(clientOrPool, { logger = null } = {}) {
  const defaults = { ...AGENDAMIENTO_CONFIG_DEFAULTS };
  if (!clientOrPool || typeof clientOrPool.query !== "function") {
    logAgendamientoConfigWarning(logger, { code: "AGENDA_CONFIG_SOURCE_UNAVAILABLE" }, "No hay cliente SQL disponible para leer parametros_sistema");
    return defaults;
  }

  try {
    const { rows } = await clientOrPool.query(
      `
        SELECT clave, valor_texto, valor_numero, valor_booleano
        FROM public.parametros_sistema
        WHERE clave = ANY($1::text[])
      `,
      [AGENDAMIENTO_CONFIG_PARAMETER_KEYS]
    );

    const valuesByKey = {};
    for (const row of rows) {
      valuesByKey[row.clave] = {
        valor_texto: row.valor_texto ?? null,
        valor_numero: row.valor_numero ?? null,
        valor_booleano: row.valor_booleano ?? null,
      };
    }

    const config = { ...defaults };
    const newMaxCompanionsRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_max_acompanantes);
    const newMaxCompanions = parseConfigInt(newMaxCompanionsRaw);
    if (newMaxCompanions != null && newMaxCompanions >= 0 && newMaxCompanions <= 20) {
      config.maxAcompanantes = newMaxCompanions;
    } else if (newMaxCompanionsRaw != null) {
      logAgendamientoConfigWarning(
        logger,
        { clave: "agendamiento_max_acompanantes", value: newMaxCompanionsRaw, fallback: defaults.maxAcompanantes },
        "Parametro de agendamiento invalido: se aplico fallback seguro"
      );
    } else {
      const legacyAllowCompanionsRaw = resolveAgendamientoRawValue(valuesByKey.permitir_acompanantes);
      const legacyAllowCompanions = parseConfigBoolean(legacyAllowCompanionsRaw);
      if (legacyAllowCompanions != null) {
        config.maxAcompanantes = legacyAllowCompanions ? defaults.maxAcompanantes : 0;
      }
    }

    const newHoldTtlRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_hold_ttl_minutos);
    const newHoldTtl = parseConfigInt(newHoldTtlRaw);
    if (newHoldTtl != null && newHoldTtl >= 1 && newHoldTtl <= 120) {
      config.holdTtlMinutos = newHoldTtl;
    } else if (newHoldTtlRaw != null) {
      logAgendamientoConfigWarning(
        logger,
        { clave: "agendamiento_hold_ttl_minutos", value: newHoldTtlRaw, fallback: defaults.holdTtlMinutos },
        "Parametro de agendamiento invalido: se aplico fallback seguro"
      );
    } else {
      const legacyHoldRaw = resolveAgendamientoRawValue(valuesByKey.hold_duracion_min);
      const legacyHold = parseConfigInt(legacyHoldRaw);
      if (legacyHold != null && legacyHold >= 1 && legacyHold <= 120) {
        config.holdTtlMinutos = legacyHold;
      }
    }

    const isvHabilitadoRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_isv_habilitado);
    const isvHabilitado = parseConfigBoolean(isvHabilitadoRaw);
    if (isvHabilitado != null) {
      config.isvHabilitado = isvHabilitado;
    } else if (isvHabilitadoRaw != null) {
      logAgendamientoConfigWarning(
        logger,
        { clave: "agendamiento_isv_habilitado", value: isvHabilitadoRaw, fallback: defaults.isvHabilitado },
        "Parametro de agendamiento invalido: se aplico fallback seguro"
      );
    }

    if (config.isvHabilitado) {
      const isvPercentRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_isv_porcentaje_default);
      const isvPercent = parseConfigDecimal(isvPercentRaw);
      if (isvPercent != null && isvPercent >= 0 && isvPercent <= 100) {
        config.isvPorcentajeDefault = isvPercent;
      } else if (isvPercentRaw != null) {
        logAgendamientoConfigWarning(
          logger,
          { clave: "agendamiento_isv_porcentaje_default", value: isvPercentRaw, fallback: defaults.isvPorcentajeDefault },
          "Parametro de agendamiento invalido: se aplico fallback seguro"
        );
      }

      const isvModeRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_isv_modo);
      const isvMode = parseConfigText(isvModeRaw)?.toLowerCase();
      if (isvMode && AGENDAMIENTO_ISV_ALLOWED_MODES.includes(isvMode)) {
        config.isvModo = isvMode;
      } else if (isvModeRaw != null) {
        logAgendamientoConfigWarning(
          logger,
          { clave: "agendamiento_isv_modo", value: isvModeRaw, fallback: defaults.isvModo },
          "Parametro de agendamiento invalido: se aplico fallback seguro"
        );
      }
    } else {
      config.isvPorcentajeDefault = 0;
      config.isvModo = "no_aplica";
    }

    const boolMappings = [
      ["agendamiento_permitir_seleccion_mixta", "permitirSeleccionMixta"],
      ["agendamiento_comprobante_email_habilitado", "comprobanteEmailHabilitado"],
      ["agendamiento_validar_promociones_backend", "validarPromocionesBackend"],
      ["agendamiento_validar_promociones_frontend", "validarPromocionesFrontend"],
      ["facturacion_cai_habilitada", "facturacionCaiHabilitada"],
      ["facturacion_cai_integracion_sar_habilitada", "facturacionCaiIntegracionSarHabilitada"],
      ["facturacion_emitir_factura_fiscal", "emitirFacturaFiscal"],
    ];

    for (const [key, target] of boolMappings) {
      const rawValue = resolveAgendamientoRawValue(valuesByKey[key]);
      const parsed = parseConfigBoolean(rawValue);
      if (parsed != null) {
        config[target] = parsed;
      } else if (rawValue != null) {
        logAgendamientoConfigWarning(
          logger,
          { clave: key, value: rawValue, fallback: defaults[target] },
          "Parametro de agendamiento invalido: se aplico fallback seguro"
        );
      }
    }

    const maxPromotionsRaw = resolveAgendamientoRawValue(valuesByKey.agendamiento_max_promociones_por_reserva);
    const maxPromotions = parseConfigInt(maxPromotionsRaw);
    if (maxPromotions != null && maxPromotions >= 0 && maxPromotions <= 20) {
      config.maxPromocionesPorReserva = maxPromotions;
    } else if (maxPromotionsRaw != null) {
      logAgendamientoConfigWarning(
        logger,
        {
          clave: "agendamiento_max_promociones_por_reserva",
          value: maxPromotionsRaw,
          fallback: defaults.maxPromocionesPorReserva,
        },
        "Parametro de agendamiento invalido: se aplico fallback seguro"
      );
    }

    return config;
  } catch (error) {
    if (logger?.error) {
      logger.error(
        { err: error, code: "AGENDA_CONFIG_LOAD_ERROR" },
        "Fallo al leer configuracion de agendamiento desde parametros_sistema"
      );
    }
    return defaults;
  }
}

function createProviderAdapterByCode(providerCode) {
  const normalized = normalizePaymentProviderCode(providerCode);
  if (!normalized) return null;

  if (normalized === "mock") {
    try {
      assertPaymentProviderConfig({ ...process.env, PAYMENT_PROVIDER: "mock" });
    } catch {
      return null;
    }
    return new MockPaymentProvider({
      mockResult: String(process.env.MOCK_PAYMENT_RESULT || "PAID"),
    });
  }

  if (normalized === "simulator") {
    try {
      return PaymentProviderFactory.create({ providerCode: normalized });
    } catch {
      return null;
    }
  }

  const envProvider = normalizePaymentProviderCode(process.env.PAYMENT_PROVIDER);
  if (normalized === envProvider) {
    return PaymentProviderFactory.create({ providerCode: normalized });
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

export function parseSinglePackageId(rawValue, { required = false, field = "id_paquete" } = {}) {
  const normalizedValues = Array.isArray(rawValue)
    ? rawValue
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
    : String(rawValue || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  const uniqueValues = Array.from(new Set(normalizedValues));
  if (!uniqueValues.length) {
    if (!required) return null;
    throw new AppError(400, `${field} es obligatorio`, {
      code: "AGENDA_PACKAGE_ID_REQUIRED",
      details: { field },
    });
  }

  if (uniqueValues.length > 1) {
    throw new AppError(400, "Solo se permite un paquete por cita.", {
      code: "ONLY_ONE_PACKAGE_ALLOWED",
      details: { field },
    });
  }

  return assertUuid(uniqueValues[0], field);
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

function extractDateAndTimeKeyFromDateTime(value, field = "fecha_inicio") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError(400, `${field} debe ser una fecha-hora valida`, {
        code: "AGENDA_DATETIME_INVALID",
        details: { field, value: null },
      });
    }
    return {
      dateKey: formatDateOnly(value),
      timeKey: toTimeLabel(value),
    };
  }

  const raw = String(value || "").trim();
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/
  );
  if (!match) {
    throw new AppError(400, `${field} debe ser una fecha-hora valida`, {
      code: "AGENDA_DATETIME_INVALID",
      details: { field, value: raw || null },
    });
  }

  return {
    dateKey: parseDateOnly(match[1], field),
    timeKey: match[2],
  };
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

function isPoolLikeClient(client) {
  return Boolean(
    client
    && typeof client.query === "function"
    && typeof client.connect === "function"
    && typeof client.release !== "function"
  );
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

function getDateTimePartsInTimeZone(dateValue, timeZone) {
  const parsed = dateValue instanceof Date ? dateValue : new Date(dateValue || "");
  if (Number.isNaN(parsed.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(parsed);
  const byType = {};
  for (const part of parts) {
    if (part?.type) byType[part.type] = part.value;
  }
  const year = Number(byType.year);
  const month = Number(byType.month);
  const day = Number(byType.day);
  const hour = Number(byType.hour);
  const minute = Number(byType.minute);
  const second = Number(byType.second);
  if (![year, month, day, hour, minute, second].every((value) => Number.isFinite(value))) {
    return null;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function formatDateOnlyInTimeZone(dateValue, timeZone) {
  const parts = getDateTimePartsInTimeZone(dateValue, timeZone);
  if (!parts) return null;
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(dateValue, timeZone) {
  const parts = getDateTimePartsInTimeZone(dateValue, timeZone);
  if (!parts) return 0;
  const utcFromParts = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return utcFromParts - dateValue.getTime();
}

function buildDateInTimeZone(dateString, hour, minute, second, timeZone) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (![year, month, day, hour, minute, second].every((value) => Number.isFinite(value))) {
    return null;
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(utcGuess);
  const firstOffset = getTimeZoneOffsetMs(candidate, timeZone);
  candidate = new Date(utcGuess - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(candidate, timeZone);
  if (secondOffset !== firstOffset) {
    candidate = new Date(utcGuess - secondOffset);
  }
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function resolveTodaySellableFloorStartAt(dateString, stepMinutes, { now = new Date(), timeZone = AGENDA_DEFAULT_TIME_ZONE } = {}) {
  const safeDate = parseDateOnly(dateString, "fecha");
  const referenceNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(referenceNow.getTime())) return null;

  const todayInZone = formatDateOnlyInTimeZone(referenceNow, timeZone);
  if (!todayInZone || todayInZone !== safeDate) return null;

  const nowParts = getDateTimePartsInTimeZone(referenceNow, timeZone);
  if (!nowParts) return null;
  const safeStep = Math.max(1, Math.trunc(Number(stepMinutes || SLOT_INTERVAL_MINUTES)));
  const minuteWithFractions = (nowParts.hour * 60) + nowParts.minute + (nowParts.second / 60);
  const roundedMinutes = Math.ceil(minuteWithFractions / safeStep) * safeStep;
  if (roundedMinutes >= 24 * 60) {
    return buildDateInTimeZone(safeDate, 23, 59, 59, timeZone);
  }

  const floorHour = Math.floor(roundedMinutes / 60);
  const floorMinute = roundedMinutes % 60;
  return buildDateInTimeZone(safeDate, floorHour, floorMinute, 0, timeZone);
}

function trimIntervalsByMinimumStart(intervals, minimumStartAt) {
  if (!(minimumStartAt instanceof Date) || Number.isNaN(minimumStartAt.getTime())) {
    return Array.isArray(intervals) ? intervals : [];
  }

  const trimmed = [];
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    const normalized = normalizeInterval(interval?.start, interval?.end);
    if (!normalized) continue;
    if (normalized.end.getTime() <= minimumStartAt.getTime()) continue;
    trimmed.push({
      start: normalized.start.getTime() < minimumStartAt.getTime()
        ? new Date(minimumStartAt)
        : normalized.start,
      end: normalized.end,
    });
  }

  return trimmed;
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

const SLOT_OPERATIONAL_CONTEXT_KEY = "__slot_operational_context";

function toSafeIsoString(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

function getSlotOperationalContext(slot) {
  if (!slot || typeof slot !== "object") return null;
  const context = slot[SLOT_OPERATIONAL_CONTEXT_KEY];
  if (!context || typeof context !== "object") return null;
  return context;
}

function setSlotOperationalContext(slot, context) {
  if (!slot || typeof slot !== "object" || !context || typeof context !== "object") return;
  Object.defineProperty(slot, SLOT_OPERATIONAL_CONTEXT_KEY, {
    value: context,
    enumerable: false,
    writable: true,
    configurable: true,
  });
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
  const config = await getAgendamientoConfig(client);
  return Number(config.holdTtlMinutos ?? AGENDAMIENTO_CONFIG_DEFAULTS.holdTtlMinutos);
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

export async function getMinSellableServiceMinutes(client) {
  const { rows } = await client.query(
    `
      SELECT COALESCE(valor_numero, 10)::int AS agenda_min_servicio_vendible_min
      FROM public.parametros_sistema
      WHERE clave = 'agenda_min_servicio_vendible_min'
      LIMIT 1
    `
  );
  const value = Number(rows[0]?.agenda_min_servicio_vendible_min ?? 10);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 10;
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
        p.apellidos,
        bpp.alias_publico,
        bpp.resumen_publico,
        COALESCE(bpp.certificaciones_titulos, ARRAY[]::text[]) AS certificaciones_titulos,
        COALESCE(bpp.visible_en_landing, FALSE) AS visible_en_landing,
        p.foto_perfil_path,
        sa.updated_at AS foto_perfil_updated_at,
        CASE
          WHEN sa.visibility = 'public' THEN COALESCE(sa.public_url, NULL)
          ELSE NULL
        END AS foto_perfil_public_url
      FROM public.empleados e
      JOIN public.personas p
        ON p.id_persona = e.id_persona
      JOIN public.sucursales s
        ON s.id_sucursal = e.id_sucursal
      LEFT JOIN public.barberos_perfiles_publicos bpp
        ON bpp.id_empleado = e.id_empleado
        AND bpp.deleted_at IS NULL
      LEFT JOIN public.storage_assets sa
        ON sa.id_asset = p.foto_perfil_asset_id
        AND sa.deleted_at IS NULL
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
        p.apellidos,
        bpp.alias_publico,
        bpp.resumen_publico,
        COALESCE(bpp.certificaciones_titulos, ARRAY[]::text[]) AS certificaciones_titulos,
        COALESCE(bpp.visible_en_landing, FALSE) AS visible_en_landing,
        p.foto_perfil_path,
        sa.updated_at AS foto_perfil_updated_at,
        CASE
          WHEN sa.visibility = 'public' THEN COALESCE(sa.public_url, NULL)
          ELSE NULL
        END AS foto_perfil_public_url
      FROM public.empleados e
      JOIN public.personas p
        ON p.id_persona = e.id_persona
      JOIN public.sucursales s
        ON s.id_sucursal = e.id_sucursal
      LEFT JOIN public.barberos_perfiles_publicos bpp
        ON bpp.id_empleado = e.id_empleado
        AND bpp.deleted_at IS NULL
      LEFT JOIN public.storage_assets sa
        ON sa.id_asset = p.foto_perfil_asset_id
        AND sa.deleted_at IS NULL
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
  const aliasPublico = String(row.alias_publico || "").trim() || null;
  const resumenPublico = String(row.resumen_publico || "").trim() || null;
  const certificaciones = Array.isArray(row.certificaciones_titulos)
    ? row.certificaciones_titulos
      .map((item) => String(item || "").trim())
      .filter(Boolean)
    : [];
  return {
    id_empleado: row.id_empleado,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    nombres,
    apellidos,
    nombre_completo: `${nombres} ${apellidos}`.trim() || "Sin nombre",
    alias_publico: aliasPublico,
    resumen_publico: resumenPublico,
    certificaciones_titulos: certificaciones,
    visible_en_landing: Boolean(row.visible_en_landing),
    foto_perfil_url: row.foto_perfil_public_url ?? null,
    foto_perfil_updated_at: row.foto_perfil_updated_at ?? null,
    foto_perfil_path: row.foto_perfil_path ?? null,
  };
}

function normalizeBookingSelectionType(rawValue, { required = false } = {}) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    if (required) {
      throw new AppError(400, "selection_type es obligatorio", {
        code: "AGENDA_SELECTION_TYPE_REQUIRED",
      });
    }
    return "services";
  }

  if (!BOOKING_SELECTION_TYPES.includes(normalized)) {
    throw new AppError(400, "selection_type no es valido", {
      code: "AGENDA_SELECTION_TYPE_INVALID",
      details: {
        selection_type: rawValue,
        permitidos: BOOKING_SELECTION_TYPES,
      },
    });
  }

  return normalized;
}

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function findDuplicateIds(values) {
  const duplicates = new Set();
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const safeValue = String(value || "").trim();
    if (!safeValue) continue;
    if (seen.has(safeValue)) {
      duplicates.add(safeValue);
      continue;
    }
    seen.add(safeValue);
  }
  return Array.from(duplicates);
}

function buildChargeableDetail(item, originCode) {
  const unitPrice = roundMoney(item?.precio_hnl);
  return {
    id_servicio: item?.id_servicio ?? null,
    origen_item_codigo: originCode,
    nombre_servicio_snapshot: item?.nombre_servicio ?? null,
    duracion_min: Number(item?.duracion_min ?? 0),
    buffer_min: Number(item?.buffer_min ?? 0),
    precio_referencia_hnl: unitPrice,
    precio_unitario_hnl: unitPrice,
    subtotal_hnl: unitPrice,
    descuento_hnl: 0,
    isv_porcentaje: 0,
    isv_hnl: 0,
    total_linea_hnl: unitPrice,
  };
}

function buildIncludedPackageDetail(item) {
  const refPrice = roundMoney(item?.precio_hnl);
  return {
    id_servicio: item?.id_servicio ?? null,
    origen_item_codigo: "paquete_incluido",
    nombre_servicio_snapshot: item?.nombre_servicio ?? null,
    duracion_min: Number(item?.duracion_min ?? 0),
    buffer_min: Number(item?.buffer_min ?? 0),
    precio_referencia_hnl: refPrice,
    precio_unitario_hnl: 0,
    subtotal_hnl: 0,
    descuento_hnl: 0,
    isv_porcentaje: 0,
    isv_hnl: 0,
    total_linea_hnl: 0,
  };
}

function uniqueIdsFromItems(items) {
  return Array.from(new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => String(item?.id_servicio || "").trim())
      .filter(Boolean)
  ));
}

function buildPackageSnapshot(serviceSelection) {
  const packageInfo = serviceSelection?.paquete || null;
  if (!packageInfo) return null;
  const packageTotal = roundMoney(packageInfo?.precio_hnl ?? serviceSelection?.monto_total_hnl ?? 0);
  return {
    id_paquete: packageInfo.id_paquete ?? null,
    id_paquete_sucursal: packageInfo.id_paquete_sucursal ?? null,
    nombre_paquete_snapshot: packageInfo.nombre_paquete ?? null,
    descripcion_paquete_snapshot: packageInfo.descripcion ?? null,
    duracion_total_min: Number(serviceSelection?.duracion_total_min ?? 0),
    precio_lista_hnl: packageTotal,
    descuento_hnl: 0,
    isv_porcentaje: 0,
    isv_hnl: 0,
    total_hnl: packageTotal,
  };
}

function buildNormalizedSelection({
  selectionType,
  packageSelection = null,
  manualItems = [],
  includedItems = [],
  extraItems = [],
}) {
  const safeManualItems = Array.isArray(manualItems) ? manualItems : [];
  const safeIncludedItems = Array.isArray(includedItems) ? includedItems : [];
  const safeExtraItems = Array.isArray(extraItems) ? extraItems : [];

  const manualDetails = safeManualItems.map((item) => buildChargeableDetail(item, "servicio_manual"));
  const includedDetails = safeIncludedItems.map((item) => buildIncludedPackageDetail(item));
  const extraDetails = safeExtraItems.map((item) => buildChargeableDetail(item, "servicio_extra"));
  const details = [...manualDetails, ...includedDetails, ...extraDetails];

  const packageSnapshot = buildPackageSnapshot(packageSelection);
  const packageTotal = roundMoney(packageSnapshot?.total_hnl ?? 0);
  const chargeableLinesTotal = roundMoney(
    [...manualDetails, ...extraDetails].reduce((sum, detail) => sum + Number(detail.total_linea_hnl || 0), 0)
  );
  const subtotal = roundMoney(packageTotal + chargeableLinesTotal);

  return {
    selection_type: selectionType,
    paquete: packageSnapshot,
    detalles: details,
    serviciosIncluidosIds: uniqueIdsFromItems(safeIncludedItems),
    serviciosExtraIds: uniqueIdsFromItems(safeExtraItems),
    serviciosCobrablesIds: uniqueIdsFromItems([...safeManualItems, ...safeExtraItems]),
    duracion_total_min: Number(
      [...safeManualItems, ...safeIncludedItems, ...safeExtraItems]
        .reduce((sum, item) => sum + Number(item?.duracion_min ?? 0), 0)
    ),
    subtotal_hnl: subtotal,
    descuento_hnl: 0,
    isv_hnl: 0,
    total_hnl: subtotal,
  };
}

export async function getServiceSelectionDetails(client, branchId, serviceIds, barberId = null) {
  const safeBranchId = assertUuid(branchId, "id_sucursal");
  const safeBarberId = barberId ? assertUuid(barberId, "id_barbero") : null;
  const enforceBarberServiceAssignments = SERVICE_BARBER_ASSIGNMENTS_ENABLED && Boolean(safeBarberId);
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
            ORDER BY 
              (CASE WHEN st.id_empleado IS NULL THEN 1 ELSE 2 END) ASC,
              st.vigente_desde DESC, 
              st.updated_at DESC, 
              st.id_tarifa DESC
          ) AS rn
        FROM public.servicios_tarifas st
        WHERE st.id_sucursal = $1::uuid
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            st.id_empleado IS NULL
            OR ($4::boolean IS TRUE AND st.id_empleado = $3::uuid)
            OR ($4::boolean IS FALSE)
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
      [safeBranchId, uniqueIds, safeBarberId, enforceBarberServiceAssignments]
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

export async function getPackageSelectionDetails(client, branchId, packageId, barberId = null) {
  const safeBranchId = assertUuid(branchId, "id_sucursal");
  const safePackageId = parseSinglePackageId(packageId, { required: true, field: "id_paquete" });
  const safeBarberId = barberId ? assertUuid(barberId, "id_barbero") : null;

  const packageResult = await client.query(
    `
      WITH picked_offer AS (
        SELECT
          ps.id_paquete_sucursal,
          ps.id_paquete,
          ps.id_sucursal,
          ps.precio_hnl
        FROM public.paquetes_sucursal ps
        JOIN public.sucursales su
          ON su.id_sucursal = ps.id_sucursal
        WHERE ps.id_paquete = $2::uuid
          AND ps.id_sucursal = $1::uuid
          AND ps.activo IS TRUE
          AND ps.visible_publico IS TRUE
          AND su.deleted_at IS NULL
          AND su.estado IS TRUE
        ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
        LIMIT 1
      )
      SELECT
        p.id_paquete,
        p.nombre_paquete,
        p.descripcion,
        po.id_paquete_sucursal,
        po.precio_hnl
      FROM public.paquetes p
      JOIN picked_offer po
        ON po.id_paquete = p.id_paquete
      WHERE p.deleted_at IS NULL
        AND p.activo IS TRUE
      LIMIT 1
    `,
    [safeBranchId, safePackageId]
  );

  const packageRow = packageResult.rows[0];
  if (!packageRow) {
    throw new AppError(404, "El paquete seleccionado no esta disponible.", {
      code: "PACKAGE_NOT_AVAILABLE",
      details: { id_paquete: safePackageId, id_sucursal: safeBranchId },
    });
  }

  const detailResult = await client.query(
    `
      SELECT
        pd.id_servicio,
        pd.cantidad,
        s.nombre_servicio,
        COALESCE(s.activo, FALSE) AS servicio_activo,
        s.deleted_at
      FROM public.paquetes_detalles pd
      LEFT JOIN public.servicios s
        ON s.id_servicio = pd.id_servicio
      WHERE pd.id_paquete = $1::uuid
      ORDER BY COALESCE(s.nombre_servicio, '') ASC, pd.id_servicio ASC
    `,
    [safePackageId]
  );

  if (detailResult.rows.length < 2) {
    throw new AppError(409, "El paquete requiere al menos 2 servicios configurados", {
      code: "AGENDA_PACKAGE_SERVICES_MIN_REQUIRED",
      details: { id_paquete: safePackageId },
    });
  }

  const containsInactiveServices = detailResult.rows.some((row) => (
    !row?.nombre_servicio
    || row?.deleted_at
    || !row?.servicio_activo
  ));
  if (containsInactiveServices) {
    throw new AppError(409, "El paquete incluye servicios inactivos o no disponibles.", {
      code: "AGENDA_PACKAGE_SERVICES_INACTIVE",
      details: { id_paquete: safePackageId },
    });
  }

  const expandedServiceIds = [];
  for (const row of detailResult.rows) {
    const qty = Math.max(1, Number(row.cantidad || 1));
    for (let index = 0; index < qty; index += 1) {
      expandedServiceIds.push(row.id_servicio);
    }
  }

  const serviceSelection = await getServiceSelectionDetails(client, safeBranchId, expandedServiceIds, safeBarberId);
  const packagePrice = packageRow.precio_hnl == null
    ? Number(serviceSelection.monto_total_hnl || 0)
    : Number(packageRow.precio_hnl);

  return {
    ...serviceSelection,
    selection_type: "package",
    id_paquete: safePackageId,
    paquete: {
      id_paquete: packageRow.id_paquete,
      id_paquete_sucursal: packageRow.id_paquete_sucursal ?? null,
      nombre_paquete: packageRow.nombre_paquete,
      descripcion: packageRow.descripcion ?? null,
      precio_hnl: packagePrice,
    },
    monto_total_hnl: packagePrice,
  };
}

export async function getBookingSelectionDetails(client, {
  id_sucursal,
  selection_type = "services",
  servicios = null,
  id_paquete = null,
  id_barbero = null,
  agendamientoConfig = null,
  logger = null,
} = {}) {
  const effectiveConfig = agendamientoConfig || await getAgendamientoConfig(client, { logger });
  const isMixedAllowed = Boolean(effectiveConfig?.permitirSeleccionMixta);
  const isvWouldBeEnabled = Boolean(
    effectiveConfig?.isvHabilitado
    && Number(effectiveConfig?.isvPorcentajeDefault || 0) > 0
    && String(effectiveConfig?.isvModo || "no_aplica").trim().toLowerCase() !== "no_aplica"
  );
  if (isvWouldBeEnabled && logger?.warn) {
    logger.warn(
      { code: "BOOKING_SELECTION_ISV_FORCED_ZERO_PHASE2" },
      "ISV configurado como habilitado, pero en Fase 2 el resolvedor mantiene ISV en cero."
    );
  }
  const normalizedSelectionType = normalizeBookingSelectionType(selection_type, { required: true });
  const parsedServiceIds = parseUuidList(servicios, { required: false, field: "servicios", unique: false });
  const rawPackageToken = Array.isArray(id_paquete)
    ? id_paquete.map((entry) => String(entry || "").trim()).filter(Boolean).join(",")
    : String(id_paquete || "").trim();
  const duplicatedServiceIds = findDuplicateIds(parsedServiceIds);
  if (duplicatedServiceIds.length > 0) {
    throw new AppError(400, "Hay servicios seleccionados mas de una vez.", {
      code: "DUPLICATED_SERVICE_SELECTION",
      details: { field: "servicios", id_servicio: duplicatedServiceIds[0] },
    });
  }
  if (!parsedServiceIds.length && !rawPackageToken) {
    throw new AppError(400, "Debes seleccionar al menos un servicio o paquete.", {
      code: "EMPTY_BOOKING_SELECTION",
      details: { field: "selection" },
    });
  }

  if (normalizedSelectionType === "package") {
    const safePackageId = parseSinglePackageId(id_paquete, { required: true, field: "id_paquete" });
    const packageSelection = await getPackageSelectionDetails(client, id_sucursal, safePackageId, id_barbero);
    const normalizedSelection = buildNormalizedSelection({
      selectionType: "package",
      packageSelection,
      includedItems: packageSelection.items,
    });
    return {
      ...packageSelection,
      normalizedSelection,
    };
  }

  if (normalizedSelectionType === "mixed") {
    const safePackageId = parseSinglePackageId(id_paquete, { required: true, field: "id_paquete" });
    if (!parsedServiceIds.length) {
      const packageSelection = await getPackageSelectionDetails(client, id_sucursal, safePackageId, id_barbero);
      const normalizedSelection = buildNormalizedSelection({
        selectionType: "mixed",
        packageSelection,
        includedItems: packageSelection.items,
        extraItems: [],
      });
      return {
        ...packageSelection,
        selection_type: "mixed",
        servicios_extra: [],
        monto_total_hnl: Number(packageSelection.monto_total_hnl || 0),
        normalizedSelection,
      };
    }

    if (!isMixedAllowed) {
      throw new AppError(409, "La seleccion mixta no esta disponible en este momento.", {
        code: "MIXED_SELECTION_NOT_ALLOWED",
      });
    }

    const packageSelection = await getPackageSelectionDetails(client, id_sucursal, safePackageId, id_barbero);
    const extraServiceIds = parsedServiceIds;

    const packageServiceIds = new Set(
      (Array.isArray(packageSelection.items) ? packageSelection.items : [])
        .map((item) => item?.id_servicio)
        .filter(Boolean)
    );
    const conflictingServiceIds = extraServiceIds.filter((idServicio) => packageServiceIds.has(idServicio));
    if (conflictingServiceIds.length > 0) {
      throw new AppError(409, "Uno de los servicios seleccionados ya esta incluido en el paquete.", {
        code: "SERVICE_ALREADY_INCLUDED_IN_PACKAGE",
        details: { field: "servicios", id_servicio: conflictingServiceIds[0] },
      });
    }

    const extraSelection = await getServiceSelectionDetails(client, id_sucursal, extraServiceIds, id_barbero);
    const mergedItems = [
      ...(Array.isArray(packageSelection.items) ? packageSelection.items : []),
      ...(Array.isArray(extraSelection.items) ? extraSelection.items : []),
    ];
    const totalDuracion = Number(packageSelection.duracion_total_min || 0) + Number(extraSelection.duracion_total_min || 0);
    const totalMonto = Number(packageSelection.monto_total_hnl || 0) + Number(extraSelection.monto_total_hnl || 0);
    const globalBuffer = Number(extraSelection.buffer_total_min || packageSelection.buffer_total_min || 0);
    const normalizedSelection = buildNormalizedSelection({
      selectionType: "mixed",
      packageSelection,
      includedItems: packageSelection.items,
      extraItems: extraSelection.items,
    });

    return {
      ...packageSelection,
      selection_type: "mixed",
      items: mergedItems,
      servicios_extra: extraSelection.items,
      duracion_total_min: totalDuracion,
      buffer_total_min: mergedItems.length > 0 ? globalBuffer : 0,
      monto_total_hnl: totalMonto,
      normalizedSelection: {
        ...normalizedSelection,
        duracion_total_min: totalDuracion,
      },
    };
  }

  if (!parsedServiceIds.length) {
    throw new AppError(400, "Debes seleccionar al menos un servicio o paquete.", {
      code: "EMPTY_BOOKING_SELECTION",
      details: { field: "servicios" },
    });
  }

  const servicesSelection = await getServiceSelectionDetails(client, id_sucursal, parsedServiceIds, id_barbero);
  const normalizedSelection = buildNormalizedSelection({
    selectionType: "services",
    manualItems: servicesSelection.items,
  });
  return {
    ...servicesSelection,
    selection_type: "services",
    id_paquete: null,
    paquete: null,
    normalizedSelection,
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

async function getBusyIntervalsForBarber(client, empleadoId, dateString, options = {}) {
  const safeDate = parseDateOnly(dateString, "fecha");
  const dayStart = startOfDay(safeDate);
  const dayEnd = endOfDay(safeDate);
  const includeSources = Boolean(options?.includeSources);

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
        SELECT
          inicio_at,
          inicio_at + make_interval(mins => (COALESCE(duracion_total_min, 0) + COALESCE(buffer_total_min, 0))) AS fin_at,
          estado_cita_codigo
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

  const blockedBySchedule = bloqueosResult.rows.map((row) => ({
    start: row.inicio_at,
    end: row.fin_at,
    source: SLOT_DISCARD_REASONS.CONFLICT_WITH_BLOCK,
  }));
  const blockedByAppointments = citasResult.rows.map((row) => {
    const rawState = String(row.estado_cita_codigo || "").trim().toLowerCase();
    const source = (rawState === "en_espera" || rawState === "pendiente_pago")
      ? SLOT_DISCARD_REASONS.CONFLICT_WITH_HOLD
      : SLOT_DISCARD_REASONS.CONFLICT_WITH_APPOINTMENT;
    return {
      start: row.inicio_at,
      end: row.fin_at,
      source,
    };
  });

  const merged = [...blockedBySchedule, ...blockedByAppointments];
  if (!includeSources) {
    return merged.map((entry) => ({ start: entry.start, end: entry.end }));
  }

  return merged;
}

async function getBusyIntervalsForBarberByRange(client, empleadoId, fromDateString, toDateString, options = {}) {
  const includeSources = Boolean(options?.includeSources);
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
        SELECT
          inicio_at,
          inicio_at + make_interval(mins => (COALESCE(duracion_total_min, 0) + COALESCE(buffer_total_min, 0))) AS fin_at,
          estado_cita_codigo
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

  const blockedBySchedule = bloqueosResult.rows.map((row) => ({
    start: row.inicio_at,
    end: row.fin_at,
    source: SLOT_DISCARD_REASONS.CONFLICT_WITH_BLOCK,
  }));
  const blockedByAppointments = citasResult.rows.map((row) => {
    const rawState = String(row.estado_cita_codigo || "").trim().toLowerCase();
    const source = (rawState === "en_espera" || rawState === "pendiente_pago")
      ? SLOT_DISCARD_REASONS.CONFLICT_WITH_HOLD
      : SLOT_DISCARD_REASONS.CONFLICT_WITH_APPOINTMENT;
    return {
      start: row.inicio_at,
      end: row.fin_at,
      source,
    };
  });

  return [
    ...blockedBySchedule,
    ...blockedByAppointments,
  ]
    .map((entry) => ({
      start: entry.start,
      end: entry.end,
      source: entry.source,
    }))
    .map((entry) => {
      const normalized = normalizeInterval(entry.start, entry.end);
      if (!normalized) return null;
      return includeSources
        ? { ...normalized, source: entry.source }
        : normalized;
    })
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

function resolveOperationalDayBoundsFromSchedules(dateString, schedules) {
  let startAt = null;
  let endAt = null;
  for (const row of Array.isArray(schedules) ? schedules : []) {
    const rowStart = normalizeInterval(
      combineDateAndTime(dateString, row?.hora_inicio),
      combineDateAndTime(dateString, row?.hora_fin)
    );
    if (!rowStart) continue;
    if (!startAt || rowStart.start.getTime() < startAt.getTime()) {
      startAt = rowStart.start;
    }
    if (!endAt || rowStart.end.getTime() > endAt.getTime()) {
      endAt = rowStart.end;
    }
  }
  return {
    startAt: startAt ? new Date(startAt) : null,
    endAt: endAt ? new Date(endAt) : null,
  };
}

function buildSlotsFromIntervals(
  intervals,
  serviceDurationMinutes,
  stepMinutes = SLOT_INTERVAL_MINUTES,
  options = {}
) {
  const slots = [];
  const discarded = [];
  const minSellableDurationMin = Math.max(0, Number(options?.minSellableDurationMin || 0));
  const includeDiscarded = Boolean(options?.includeDiscarded);
  const operationalDayStartAt = options?.operationalDayStartAt instanceof Date
    ? new Date(options.operationalDayStartAt)
    : null;
  const operationalDayEndAt = options?.operationalDayEndAt instanceof Date
    ? new Date(options.operationalDayEndAt)
    : null;

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

  function diffMinutes(fromDate, toDate) {
    return Math.max(0, Math.round((toDate.getTime() - fromDate.getTime()) / 60000));
  }

  function pushDiscarded(interval, startAt, endAt, reason, details = {}) {
    if (!includeDiscarded) return;
    discarded.push({
      reason,
      inicio_at: new Date(startAt).toISOString(),
      fin_at: new Date(endAt).toISOString(),
      intervalo_inicio_at: new Date(interval.start).toISOString(),
      intervalo_fin_at: new Date(interval.end).toISOString(),
      details,
    });
  }

  for (const interval of intervals) {
    const intervalDurationMin = diffMinutes(interval.start, interval.end);
    if (intervalDurationMin < serviceDurationMinutes) {
      pushDiscarded(
        interval,
        interval.start,
        interval.end,
        SLOT_DISCARD_REASONS.DURATION_INSUFFICIENT,
        {
          interval_duration_min: intervalDurationMin,
          required_duration_min: serviceDurationMinutes,
        }
      );
      continue;
    }

    let cursor = alignIntervalStartToStep(interval.start);
    while (cursor.getTime() + serviceDurationMinutes * 60 * 1000 <= interval.end.getTime()) {
      const slotEnd = addMinutes(cursor, serviceDurationMinutes);
      const residualBeforeMin = diffMinutes(interval.start, cursor);
      const residualAfterMin = diffMinutes(slotEnd, interval.end);
      const hasUnsellableGap = minSellableDurationMin > 0
        && (
          (residualBeforeMin > 0 && residualBeforeMin < minSellableDurationMin)
          || (residualAfterMin > 0 && residualAfterMin < minSellableDurationMin)
        );

      if (hasUnsellableGap) {
        pushDiscarded(
          interval,
          cursor,
          slotEnd,
          SLOT_DISCARD_REASONS.RESIDUAL_GAP_NOT_SELLABLE,
          {
            residual_before_min: residualBeforeMin,
            residual_after_min: residualAfterMin,
            min_sellable_min: minSellableDurationMin,
          }
        );
        cursor = addMinutes(cursor, stepMinutes);
        continue;
      }

      slots.push({
        inicio_at: new Date(cursor),
        fin_at: slotEnd,
        hora: toTimeLabel(cursor),
      });
      setSlotOperationalContext(slots[slots.length - 1], {
        free_interval_start_at: toSafeIsoString(interval.start),
        free_interval_end_at: toSafeIsoString(interval.end),
        free_interval_duration_min: intervalDurationMin,
        residual_before_min: residualBeforeMin,
        residual_after_min: residualAfterMin,
        operational_day_start_at: toSafeIsoString(operationalDayStartAt),
        operational_day_end_at: toSafeIsoString(operationalDayEndAt),
      });
      cursor = addMinutes(cursor, stepMinutes);
    }
  }
  return includeDiscarded ? { slots, discarded } : { slots, discarded: [] };
}

export async function getAvailableSlotsForBarber(
  client,
  empleadoId,
  dateString,
  serviceTotalMinutes,
  options = {}
) {
  const safeBarberId = assertUuid(empleadoId, "id_barbero");
  const safeDate = parseDateOnly(dateString, "fecha");
  const includeDiscardReasons = Boolean(options?.includeDiscardReasons);
  const minSellableDurationMin = Number.isFinite(Number(options?.minSellableDurationMin))
    ? Math.max(0, Math.trunc(Number(options.minSellableDurationMin)))
    : await getMinSellableServiceMinutes(client);
  const schedules = await getSchedulesForBarberOnDate(client, safeBarberId, safeDate);
  if (!schedules.length) {
    return includeDiscardReasons
      ? { slots: [], discarded: [{ reason: SLOT_DISCARD_REASONS.RESOURCE_UNAVAILABLE, details: { schedule: "missing" } }] }
      : [];
  }

  const baseIntervals = buildBaseIntervalsFromSchedules(safeDate, schedules);
  const operationalDayBounds = resolveOperationalDayBoundsFromSchedules(safeDate, schedules);
  if (!baseIntervals.length) {
    return includeDiscardReasons
      ? { slots: [], discarded: [{ reason: SLOT_DISCARD_REASONS.RESOURCE_UNAVAILABLE, details: { interval: "empty" } }] }
      : [];
  }

  const busyIntervals = await getBusyIntervalsForBarber(client, safeBarberId, safeDate);
  const freeIntervals = subtractIntervals(baseIntervals, busyIntervals);
  const todaySellableFloorStartAt = resolveTodaySellableFloorStartAt(safeDate, SLOT_INTERVAL_MINUTES, {
    now: options?.now,
    timeZone: options?.timeZone || AGENDA_DEFAULT_TIME_ZONE,
  });
  const sellableFreeIntervals = trimIntervalsByMinimumStart(freeIntervals, todaySellableFloorStartAt);
  if (!sellableFreeIntervals.length) {
    if (!includeDiscardReasons) return [];
    const sourceSummary = await getBusyIntervalsForBarber(client, safeBarberId, safeDate, { includeSources: true });
    return {
      slots: [],
      discarded: (Array.isArray(sourceSummary) ? sourceSummary : []).map((entry) => ({
        reason: entry?.source || SLOT_DISCARD_REASONS.RESOURCE_UNAVAILABLE,
        inicio_at: entry?.start ? new Date(entry.start).toISOString() : null,
        fin_at: entry?.end ? new Date(entry.end).toISOString() : null,
      })),
    };
  }

  const buildResult = buildSlotsFromIntervals(
    sellableFreeIntervals,
    serviceTotalMinutes,
    SLOT_INTERVAL_MINUTES,
    {
      minSellableDurationMin,
      includeDiscarded: includeDiscardReasons,
      operationalDayStartAt: operationalDayBounds.startAt,
      operationalDayEndAt: operationalDayBounds.endAt,
    }
  );

  if (!includeDiscardReasons) {
    return buildResult.slots;
  }

  return {
    slots: buildResult.slots,
    discarded: buildResult.discarded,
  };
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

export async function findFirstAvailableBarber(client, branchId, dateString, serviceTotalMinutes, options = {}) {
  const barbers = await listBarbersForBranch(client, branchId);
  const barberConcurrency = isPoolLikeClient(client) ? 1 : 4;
  const withSlots = await mapWithConcurrency(barbers, barberConcurrency, async (barber) => ({
    barber,
    slots: await getAvailableSlotsForBarber(client, barber.id_empleado, dateString, serviceTotalMinutes, {
      minSellableDurationMin: options?.minSellableDurationMin,
    }),
  }));
  const first = withSlots.find((entry) => entry.slots.length > 0) ?? null;
  return first;
}

export async function buildDayAvailability(client, branchId, serviceSelection, dateString, barberId = null, options = {}) {
  const safeDate = parseDateOnly(dateString, "fecha");
  const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;
  const minSellableDurationMin = Number.isFinite(Number(options?.minSellableDurationMin))
    ? Math.max(0, Math.trunc(Number(options.minSellableDurationMin)))
    : await getMinSellableServiceMinutes(client);
  const includeDiscardReasons = Boolean(options?.includeDiscardReasons);

  if (barberId) {
    const preloadedBarber = options?.barber;
    const barber = preloadedBarber?.id_empleado === barberId ? preloadedBarber : await getBarberById(client, barberId);
    if (barber.id_sucursal !== branchId) {
      throw new AppError(409, "El barbero no pertenece a la sucursal solicitada", {
        code: "AGENDA_BARBER_BRANCH_MISMATCH",
        details: { id_barbero: barberId, id_sucursal: branchId },
      });
    }

    const slotsResult = await getAvailableSlotsForBarber(client, barber.id_empleado, safeDate, serviceTotalMinutes, {
      minSellableDurationMin,
      includeDiscardReasons,
    });
    const slots = Array.isArray(slotsResult) ? slotsResult : (slotsResult?.slots || []);
    const discarded = Array.isArray(slotsResult?.discarded) ? slotsResult.discarded : [];
    const bounds = await getBarberScheduleBounds(client, barber.id_empleado, safeDate);
    const discardedReasonCodes = includeDiscardReasons
      ? Array.from(new Set(discarded.map((entry) => String(entry?.reason || "").trim()).filter(Boolean)))
      : [];
    return {
      fecha: safeDate,
      disponible: slots.length > 0,
      barberos_disponibles: slots.length > 0 ? 1 : 0,
      primer_horario_disponible: slots[0]?.hora ?? null,
      barbero_autoasignado: barber,
      hora_inicio: bounds.hora_inicio,
      hora_fin: bounds.hora_fin,
      slots,
      discarded_slots: includeDiscardReasons ? discarded : [],
      discarded_reason_codes: discardedReasonCodes,
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

  const barberConcurrency = isPoolLikeClient(client) ? 1 : 4;
  const withSlots = await mapWithConcurrency(barbers, barberConcurrency, async (barber) => ({
    barber,
    slots: await getAvailableSlotsForBarber(client, barber.id_empleado, safeDate, serviceTotalMinutes, {
      minSellableDurationMin,
    }),
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
  const minSellableDurationMin = await getMinSellableServiceMinutes(client);

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
  const rangeConcurrency = isPoolLikeClient(client) ? 1 : 4;

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
    for (const [weekday, sampleDate] of sampleDateByWeekday.entries()) {
      const schedules = await getSchedulesForBarberOnDate(client, barber.id_empleado, sampleDate);
      schedulesByWeekday.set(weekday, schedules);
    }

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
      const slotsResult = buildSlotsFromIntervals(
        freeIntervals,
        serviceTotalMinutes,
        SLOT_INTERVAL_MINUTES,
        { minSellableDurationMin }
      );
      const slots = slotsResult.slots;

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

  return mapWithConcurrency(dateKeys, rangeConcurrency, (dateKey) =>
    buildDayAvailability(client, branchId, serviceSelection, dateKey, null, { barbers, minSellableDurationMin })
  );
}

export async function resolveBookingSelection(client, {
  id_sucursal,
  servicios,
  fecha_inicio,
  id_barbero = null,
  selection_type = "services",
  id_paquete = null,
  agendamientoConfig = null,
  logger = null,
}) {
  const branch = await ensureActiveBranch(client, id_sucursal);
  const serviceSelection = await getBookingSelectionDetails(client, {
    id_sucursal: branch.id_sucursal,
    selection_type,
    servicios,
    id_paquete,
    id_barbero,
    agendamientoConfig,
    logger,
  });
  const startDateTime = parseDateTime(fecha_inicio, "fecha_inicio");
  const { dateKey, timeKey } = extractDateAndTimeKeyFromDateTime(fecha_inicio, "fecha_inicio");
  const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;
  const minSellableDurationMin = await getMinSellableServiceMinutes(client);

  let selectedBarber;
  if (id_barbero) {
    const barber = await getBarberById(client, id_barbero);
    if (barber.id_sucursal !== branch.id_sucursal) {
      throw new AppError(409, "El barbero no pertenece a la sucursal solicitada", {
        code: "AGENDA_BARBER_BRANCH_MISMATCH",
        details: { id_barbero, id_sucursal: branch.id_sucursal },
      });
    }
    const slots = await getAvailableSlotsForBarber(client, barber.id_empleado, dateKey, serviceTotalMinutes, {
      minSellableDurationMin,
    });
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
      const slots = await getAvailableSlotsForBarber(client, barber.id_empleado, dateKey, serviceTotalMinutes, {
        minSellableDurationMin,
      });
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

function getPeriodKeyFromTimeLabel(timeLabel) {
  const normalized = String(timeLabel || "").trim();
  const match = normalized.match(/^(\d{2}):(\d{2})/);
  if (!match) return "noche";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "noche";
  const totalMinutes = (hour * 60) + minute;
  if (totalMinutes >= 6 * 60 && totalMinutes < 12 * 60) return "manana";
  if (totalMinutes >= 12 * 60 && totalMinutes < 18 * 60) return "tarde";
  return "noche";
}

export function mapSlotsForResponse(slots, { duracion_visible_min = 0 } = {}) {
  const safeVisibleDuration = Math.max(0, Number(duracion_visible_min || 0));
  return (Array.isArray(slots) ? slots : []).map((slot) => {
    const startAt = slot?.inicio_at instanceof Date ? slot.inicio_at : new Date(slot?.inicio_at || "");
    const safeStart = Number.isNaN(startAt.getTime()) ? null : startAt;
    const endAtRaw = slot?.fin_at instanceof Date ? slot.fin_at : new Date(slot?.fin_at || "");
    const safeEnd = Number.isNaN(endAtRaw.getTime()) ? null : endAtRaw;
    const visibleEndAt = safeStart
      ? new Date(safeStart.getTime() + safeVisibleDuration * 60 * 1000)
      : null;
    const horaInicio = String(slot?.hora || "").trim() || (safeStart ? toTimeLabel(safeStart) : "");
    const horaFinVisible = visibleEndAt ? toTimeLabel(visibleEndAt) : horaInicio;
    const periodKey = getPeriodKeyFromTimeLabel(horaInicio);
    const mappedSlot = {
      hora: horaInicio,
      inicio_at: safeStart ? safeStart.toISOString() : null,
      fin_at: safeEnd ? safeEnd.toISOString() : null,
      disponible: true,
      duracion_visible_min: safeVisibleDuration,
      hora_fin_visible: horaFinVisible,
      period_key: periodKey,
      range_label: `${horaInicio} - ${horaFinVisible}`,
    };
    const context = getSlotOperationalContext(slot);
    if (context) {
      setSlotOperationalContext(mappedSlot, context);
    }
    return mappedSlot;
  }).filter((slot) => Boolean(slot.hora && slot.inicio_at && slot.fin_at));
}

function sortSlotsByHour(left, right) {
  const leftKey = String(left?.hora || "").trim();
  const rightKey = String(right?.hora || "").trim();
  return leftKey.localeCompare(rightKey);
}

const CURATED_PERIOD_SEGMENTS = {
  manana: [{ startMin: 6 * 60, endMin: 12 * 60 }],
  tarde: [{ startMin: 12 * 60, endMin: 18 * 60 }],
  noche: [
    { startMin: 0, endMin: 6 * 60 },
    { startMin: 18 * 60, endMin: 24 * 60 },
  ],
};

function getMinutesFromDayStart(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return null;
  return (dateValue.getHours() * 60) + dateValue.getMinutes();
}

function parseSlotDate(value) {
  const dateValue = value instanceof Date ? value : new Date(value || "");
  return Number.isNaN(dateValue.getTime()) ? null : dateValue;
}

function resolveOperationalPeriodMembership(slot) {
  const startAt = parseSlotDate(slot?.inicio_at);
  const endAt = parseSlotDate(slot?.fin_at);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;

  const startMin = getMinutesFromDayStart(startAt);
  const endMin = getMinutesFromDayStart(endAt);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return null;

  for (const [periodKey, segments] of Object.entries(CURATED_PERIOD_SEGMENTS)) {
    for (const segment of segments) {
      if (startMin >= segment.startMin && endMin <= segment.endMin) {
        return {
          periodKey,
          segment,
          startMin,
          endMin,
        };
      }
    }
  }

  return null;
}

function scoreSlotForCuratedPeriod(slot, membership, minSellableDurationMin) {
  const minSellable = Math.max(0, Math.trunc(Number(minSellableDurationMin || 0)));
  const context = getSlotOperationalContext(slot);
  const contextResidualBefore = Number(context?.residual_before_min);
  const contextResidualAfter = Number(context?.residual_after_min);
  const residualBeforeMin = Number.isFinite(contextResidualBefore) && contextResidualBefore >= 0
    ? Math.trunc(contextResidualBefore)
    : Math.max(0, membership.startMin - membership.segment.startMin);
  const residualAfterMin = Number.isFinite(contextResidualAfter) && contextResidualAfter >= 0
    ? Math.trunc(contextResidualAfter)
    : Math.max(0, membership.segment.endMin - membership.endMin);
  const freeIntervalStartAt = parseSlotDate(context?.free_interval_start_at);
  const operationalDayStartAt = parseSlotDate(context?.operational_day_start_at);
  const slotStartAt = parseSlotDate(slot?.inicio_at);

  let score = 0;
  const beforeUnsellable = minSellable > 0 && residualBeforeMin > 0 && residualBeforeMin < minSellable;
  const afterUnsellable = minSellable > 0 && residualAfterMin > 0 && residualAfterMin < minSellable;

  // Prioriza llenar el hueco de izquierda a derecha y evita residuos no vendibles.
  if (beforeUnsellable) score -= 400;
  if (afterUnsellable) score -= 400;

  if (residualBeforeMin === 0) score += 500;
  score -= residualBeforeMin * 6;

  // Cierre limpio del hueco como desempate operativo (secundario frente al borde izquierdo).
  if (residualAfterMin === 0) score += 30;
  if (residualAfterMin >= minSellable && residualAfterMin > 0) {
    score += Math.min(20, residualAfterMin / 10);
  }

  if (residualBeforeMin > 0 && residualAfterMin > 0) {
    score -= 12;
  }

  // Si hay varios huecos, prioriza el que empieza antes en el día operativo real.
  if (freeIntervalStartAt && operationalDayStartAt) {
    const freeStartOffsetMin = Math.max(0, Math.round((freeIntervalStartAt.getTime() - operationalDayStartAt.getTime()) / 60000));
    score -= freeStartOffsetMin * 1;
  }

  // Dentro del hueco real, favorece explícitamente el borde izquierdo.
  if (slotStartAt && freeIntervalStartAt) {
    const offsetWithinIntervalMin = Math.max(0, Math.round((slotStartAt.getTime() - freeIntervalStartAt.getTime()) / 60000));
    score -= offsetWithinIntervalMin * 3;
  }

  return {
    slot,
    score,
    residual_before_min: residualBeforeMin,
    residual_after_min: residualAfterMin,
    free_interval_start_at: context?.free_interval_start_at ?? null,
    free_interval_end_at: context?.free_interval_end_at ?? null,
    operational_day_start_at: context?.operational_day_start_at ?? null,
  };
}

function createEmptyCuratedPeriod() {
  return {
    recommended: null,
    alternatives: [],
    overflow: [],
    has_more: false,
    total: 0,
  };
}

function buildCuratedRankingByPeriod(slots, safeMinSellableDurationMin) {
  const grouped = {
    manana: [],
    tarde: [],
    noche: [],
  };

  for (const slot of Array.isArray(slots) ? slots : []) {
    const membership = resolveOperationalPeriodMembership(slot);
    if (!membership || !grouped[membership.periodKey]) continue;
    grouped[membership.periodKey].push(
      scoreSlotForCuratedPeriod(slot, membership, safeMinSellableDurationMin)
    );
  }

  for (const periodKey of Object.keys(grouped)) {
    grouped[periodKey] = grouped[periodKey]
      .slice()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return sortSlotsByHour(left.slot, right.slot);
      });
  }

  return grouped;
}

function isUnsellableResidual(residualMinutes, minSellableMinutes) {
  return minSellableMinutes > 0
    && residualMinutes > 0
    && residualMinutes < minSellableMinutes;
}

function isScoredEntryEligibleForPublicExposure(entry, minSellableDurationMin) {
  const minSellable = Math.max(0, Math.trunc(Number(minSellableDurationMin || 0)));
  if (!entry?.slot) return false;

  // Filtro defensivo: no exponer slots que impliquen residuos no vendibles.
  const residualBefore = Number(entry?.residual_before_min);
  const residualAfter = Number(entry?.residual_after_min);
  const safeResidualBefore = Number.isFinite(residualBefore) ? Math.max(0, Math.trunc(residualBefore)) : 0;
  const safeResidualAfter = Number.isFinite(residualAfter) ? Math.max(0, Math.trunc(residualAfter)) : 0;

  return !(
    isUnsellableResidual(safeResidualBefore, minSellable)
    || isUnsellableResidual(safeResidualAfter, minSellable)
  );
}

function getSlotStartTimestamp(slot) {
  const startAt = parseSlotDate(slot?.inicio_at);
  if (!startAt) return null;
  return startAt.getTime();
}

function hasMinSpacingFromSelected(selectedStartTimes, candidateStartTime, spacingMinutes) {
  if (!Number.isFinite(candidateStartTime)) return false;
  const spacingMs = Math.max(0, Math.trunc(Number(spacingMinutes || 0))) * 60 * 1000;
  if (spacingMs <= 0) return true;

  for (const selectedStart of Array.isArray(selectedStartTimes) ? selectedStartTimes : []) {
    if (!Number.isFinite(selectedStart)) continue;
    if (Math.abs(candidateStartTime - selectedStart) < spacingMs) {
      return false;
    }
  }
  return true;
}

export function buildCuratedSlotExposure(
  slots,
  { alternativesLimit = 3, minSellableDurationMin = 0, alternativeSpacingMin = 30 } = {}
) {
  const safeAlternativesLimit = Math.max(2, Math.min(3, Math.trunc(Number(alternativesLimit || 3))));
  const safeMinSellableDurationMin = Math.max(0, Math.trunc(Number(minSellableDurationMin || 0)));
  const safeAlternativeSpacingMin = Math.max(0, Math.trunc(Number(alternativeSpacingMin || 0)));
  const periods = {
    manana: createEmptyCuratedPeriod(),
    tarde: createEmptyCuratedPeriod(),
    noche: createEmptyCuratedPeriod(),
  };

  const rankingByPeriod = buildCuratedRankingByPeriod(slots, safeMinSellableDurationMin);
  for (const periodKey of Object.keys(rankingByPeriod)) {
    const orderedByScore = rankingByPeriod[periodKey]
      .filter((entry) => isScoredEntryEligibleForPublicExposure(entry, safeMinSellableDurationMin));
    if (!orderedByScore.length) continue;

    const recommendedEntry = orderedByScore[0] || null;
    const recommended = recommendedEntry?.slot || null;
    const alternatives = [];
    const overflow = [];
    const selectedStartTimes = [];
    const recommendedStartTime = getSlotStartTimestamp(recommended);
    if (Number.isFinite(recommendedStartTime)) {
      selectedStartTimes.push(recommendedStartTime);
    }

    for (const candidate of orderedByScore.slice(1)) {
      const candidateSlot = candidate?.slot;
      if (!candidateSlot) continue;

      const candidateStartTime = getSlotStartTimestamp(candidateSlot);
      const hasSpacing = hasMinSpacingFromSelected(
        selectedStartTimes,
        candidateStartTime,
        safeAlternativeSpacingMin
      );
      if (alternatives.length < safeAlternativesLimit && hasSpacing) {
        alternatives.push(candidateSlot);
        if (Number.isFinite(candidateStartTime)) {
          selectedStartTimes.push(candidateStartTime);
        }
        continue;
      }

      overflow.push(candidateSlot);
    }

    periods[periodKey] = {
      recommended,
      alternatives,
      overflow,
      has_more: overflow.length > 0,
      total: (recommended ? 1 : 0) + alternatives.length + overflow.length,
    };
  }

  return periods;
}

function buildRankingReason(entry, minSellableDurationMin) {
  const minSellable = Math.max(0, Math.trunc(Number(minSellableDurationMin || 0)));
  const reasons = [];

  if (entry?.residual_before_min === 0) {
    reasons.push("touches_interval_left_edge");
  } else {
    reasons.push("offset_from_interval_left_edge");
  }

  if (minSellable > 0) {
    const beforeUnsellable = entry?.residual_before_min > 0 && entry?.residual_before_min < minSellable;
    const afterUnsellable = entry?.residual_after_min > 0 && entry?.residual_after_min < minSellable;
    reasons.push(beforeUnsellable || afterUnsellable ? "penalized_unsellable_residual" : "sellable_residuals");
  }

  if (entry?.residual_after_min === 0) {
    reasons.push("clean_interval_closure");
  }

  return reasons.join("|");
}

export function buildCuratedSlotExposureDebug(
  slots,
  { minSellableDurationMin = 0, maxEntriesPerPeriod = 16 } = {}
) {
  const safeMinSellableDurationMin = Math.max(0, Math.trunc(Number(minSellableDurationMin || 0)));
  const safeMaxEntries = Math.max(1, Math.min(40, Math.trunc(Number(maxEntriesPerPeriod || 16))));
  const rankingByPeriod = buildCuratedRankingByPeriod(slots, safeMinSellableDurationMin);

  const response = {
    manana: { candidates: [], considered_total: 0 },
    tarde: { candidates: [], considered_total: 0 },
    noche: { candidates: [], considered_total: 0 },
  };

  for (const periodKey of Object.keys(rankingByPeriod)) {
    const scoredEntries = rankingByPeriod[periodKey];
    const topCandidates = scoredEntries.slice(0, safeMaxEntries).map((entry, index) => ({
      rank: index + 1,
      hora: entry?.slot?.hora ?? null,
      inicio_at: entry?.slot?.inicio_at ?? null,
      fin_at: entry?.slot?.fin_at ?? null,
      score: Number(entry?.score ?? 0),
      origin_interval_start: entry?.free_interval_start_at ?? null,
      origin_interval_end: entry?.free_interval_end_at ?? null,
      residual_before_interval_min: Number(entry?.residual_before_min ?? 0),
      residual_after_interval_min: Number(entry?.residual_after_min ?? 0),
      ranking_reason: buildRankingReason(entry, safeMinSellableDurationMin),
    }));

    response[periodKey] = {
      candidates: topCandidates,
      considered_total: scoredEntries.length,
    };
  }

  return response;
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
          alias_publico: entry.barbero_autoasignado.alias_publico ?? null,
          resumen_publico: entry.barbero_autoasignado.resumen_publico ?? null,
          certificaciones_titulos: Array.isArray(entry.barbero_autoasignado.certificaciones_titulos)
            ? entry.barbero_autoasignado.certificaciones_titulos
            : [],
          visible_en_landing: Boolean(entry.barbero_autoasignado.visible_en_landing),
          foto_perfil_url: entry.barbero_autoasignado.foto_perfil_url ?? null,
          foto_perfil_updated_at: entry.barbero_autoasignado.foto_perfil_updated_at ?? null,
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
    alias_publico: barber.alias_publico ?? null,
    resumen_publico: barber.resumen_publico ?? null,
    certificaciones_titulos: Array.isArray(barber.certificaciones_titulos) ? barber.certificaciones_titulos : [],
    visible_en_landing: Boolean(barber.visible_en_landing),
    foto_perfil_url: barber.foto_perfil_url ?? null,
    foto_perfil_updated_at: barber.foto_perfil_updated_at ?? null,
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

