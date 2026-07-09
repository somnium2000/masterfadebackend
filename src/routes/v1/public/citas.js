import { createHash, timingSafeEqual } from "node:crypto";
import { AppError, sendError, toDatabaseSchemaOutdatedError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  ensureActiveBranch,
  expireStaleAppointmentReservations,
  getSystemParameters,
  parseSinglePackageId,
  normalizeOperationalDateTime,
  resolveBookingSelection,
} from "../../../services/agendaService.js";
import {
  getCandidatePromotionRules,
  getPromotionCodesByRules,
  getPromotionCompatibility,
  getPromotionUsageStats,
} from "../../../services/promociones/promocionesRepository.js";
import {
  buildPromotionResult,
  evaluatePromotions,
  resolvePromotionConflicts,
} from "../../../services/promociones/promocionesEngine.js";
import { buildCanonicalDiscountLines, buildDiscountPlan } from "../../../services/bookingDiscounts.js";
import {
  assertBookingSelectionCreationSupported,
  buildAppointmentDetailRows,
} from "../../../services/bookingReservationService.js";
import {
  assertCanonicalTotalsMatch,
  assertKnownIdempotencyState,
  buildAssignmentAttemptsFromIntegrantes,
  buildDeterministicPublicReleaseToken,
  buildCanonicalReservationPayload,
  buildReservationRequestFingerprint,
  createCanonicalReservation,
  finalizeReservationIdempotency,
  getReservationIdempotencyState,
  loadCanonicalPromotionDetailRows,
  mapCanonicalReservationError,
  resolveReservationRequestId,
  selectCanonicalIntegrantesForResult,
  summarizeCanonicalIntegrantes,
} from "../../../services/bookingCanonicalReservationService.js";
import {
  buildCanonicalHoldResponse,
  createBookingHold,
} from "../../../services/booking/bookingHoldOrchestrationService.js";
import {
  isGroupScopedBonificationPromotion,
  previewGroupBonificationPromotions,
  recordPromotionApplications,
} from "../../../services/promociones/promocionesService.js";

const requestIdSchema = { type: "string" };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const MAX_PUBLIC_PROMOTIONS_PER_BOOKING = 5;
const PUBLIC_HOLD_IDEMPOTENCY_SCOPE = "public:citas:hold";
const PUBLIC_RELEASE_TOKEN_COLUMNS = new Set(["release_token_hash", "release_token_created_at"]);
const PUBLIC_RELEASE_REJECTED_APPOINTMENT_STATES = new Set([
  "confirmada",
  "en_salon",
  "en_atencion",
  "completada",
  "no_show",
  "pendiente_pago",
]);
const PUBLIC_RELEASE_CANCELLABLE_APPOINTMENT_STATES = ["en_espera"];
const errorResponseSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
      additionalProperties: true,
    },
    requestId: requestIdSchema,
  },
  required: ["ok", "error"],
  additionalProperties: true,
};

const branchSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string" },
  },
  required: ["id_sucursal", "nombre_sucursal"],
  additionalProperties: false,
};

const contextSchema = {
  type: "object",
  properties: {
    sucursales: { type: "array", items: branchSchema },
    parametros: {
      type: "object",
      properties: {
        hold_duracion_min: { type: "number" },
        no_show_min: { type: "number" },
        agenda_buffer_global_min: { type: "number" },
        permitir_acompanantes: { type: "boolean" },
        pago_total_obligatorio: { type: "boolean" },
        simulacion_sin_pago: { type: "boolean" },
      },
      required: [
        "hold_duracion_min",
        "no_show_min",
        "agenda_buffer_global_min",
        "permitir_acompanantes",
        "pago_total_obligatorio",
        "simulacion_sin_pago",
      ],
      additionalProperties: false,
    },
  },
  required: ["sucursales", "parametros"],
  additionalProperties: false,
};

const holdBlockSchema = {
  type: "object",
  properties: {
    id_cita: { type: "string", format: "uuid" },
    orden_integrante: { type: "integer" },
    alias: { type: "string" },
    id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    nombre_barbero: { type: "string" },
    fecha: { type: "string", format: "date" },
    hora: { type: "string" },
    fecha_inicio: { type: "string", format: "date-time" },
    estado_cita_codigo: { type: "string" },
    monto_total_hnl: { type: "number" },
    descuento_hnl: { type: "number" },
    total_pagar_hnl: { type: "number" },
    duracion_total_min: { type: "integer" },
    buffer_total_min: { type: "integer" },
  },
  required: [
    "id_cita",
    "orden_integrante",
    "alias",
    "id_barbero",
    "nombre_barbero",
    "fecha",
    "hora",
    "fecha_inicio",
    "estado_cita_codigo",
    "monto_total_hnl",
    "descuento_hnl",
    "total_pagar_hnl",
    "duracion_total_min",
    "buffer_total_min",
  ],
  additionalProperties: false,
};

function normalizePublicParams(paramsMap) {
  const hold = paramsMap?.hold_duracion_min?.valor_numero;
  const noShow = paramsMap?.no_show_min?.valor_numero;
  const globalBuffer = paramsMap?.agenda_buffer_global_min?.valor_numero;
  const companions = paramsMap?.permitir_acompanantes?.valor_booleano;
  const fullPayment = paramsMap?.pago_total_obligatorio?.valor_booleano;
  const simulationNoPayment = paramsMap?.simulacion_sin_pago?.valor_booleano;

  return {
    hold_duracion_min: Number.isFinite(Number(hold)) ? Number(hold) : 5,
    no_show_min: Number.isFinite(Number(noShow)) ? Number(noShow) : 10,
    agenda_buffer_global_min: Number.isFinite(Number(globalBuffer)) ? Number(globalBuffer) : 0,
    permitir_acompanantes: typeof companions === "boolean" ? companions : false,
    pago_total_obligatorio: typeof fullPayment === "boolean" ? fullPayment : true,
    simulacion_sin_pago: typeof simulationNoPayment === "boolean" ? simulationNoPayment : false,
  };
}

const PUBLIC_CITAS_SAFE_DETAIL_KEYS = new Set([
  "field",
  "blockIndex",
  "maxCompanions",
  "selection_type",
  "alias",
  "reason",
]);

function sanitizePublicCitasErrorDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails)) return undefined;
  const safeDetails = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!PUBLIC_CITAS_SAFE_DETAIL_KEYS.has(key)) continue;
    if (key === "blockIndex" || key === "maxCompanions") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 20) safeDetails[key] = parsed;
      continue;
    }
    if (value == null) continue;
    safeDetails[key] = String(value).trim().slice(0, 160);
  }
  return Object.keys(safeDetails).length ? safeDetails : undefined;
}

function sendHandled(reply, request, error, message, code) {
  const normalizedError = toDatabaseSchemaOutdatedError(error);
  if (normalizedError instanceof AppError) {
    request.log.warn(
      {
        requestId: request.id,
        statusCode: normalizedError.statusCode,
        code: normalizedError.code,
        details: normalizedError.details,
      },
      "Public citas handled AppError"
    );
    const safeDetails = sanitizePublicCitasErrorDetails(normalizedError.details);
    return sendError(reply, normalizedError.statusCode, normalizedError.message, {
      code: normalizedError.code,
      ...(safeDetails ? { details: safeDetails } : {}),
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    requestId: request.id,
  });
}

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function isAvailabilityConflictError(error) {
  if (isConflictError(error)) return true;
  if (!(error instanceof AppError)) return false;
  if (error.statusCode !== 409) return false;
  const safeCode = String(error.code || "").trim().toUpperCase();
  return safeCode.startsWith("AGENDA_")
    || safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER";
}

function resolveSafeConflictReason(error) {
  if (isConflictError(error)) return "DB_CONFLICT";
  if (!(error instanceof AppError)) return "UNKNOWN_CONFLICT";
  const safeCode = String(error.code || "").trim().toUpperCase();
  if (safeCode.startsWith("AGENDA_")) return safeCode;
  if (safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER") return safeCode;
  return "UNKNOWN_CONFLICT";
}

async function getPublicHoldReleaseTokenSupport(client) {
  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'citas_grupos'
        AND column_name = ANY($1::text[])
    `,
    [Array.from(PUBLIC_RELEASE_TOKEN_COLUMNS)]
  );
  const columns = new Set(rows.map((row) => String(row.column_name || "").trim()));
  return {
    supported: columns.has("release_token_hash") && columns.has("release_token_created_at"),
  };
}

function hashPublicReleaseToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function resolvePublicReleaseTokenSecret(app) {
  return String(app.config?.bookingReleaseTokenSecret || process.env.BOOKING_RELEASE_TOKEN_SECRET || "").trim();
}

function isPublicReleaseTokenValid(token, expectedHash) {
  const normalizedHash = String(expectedHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) return false;
  const actual = Buffer.from(hashPublicReleaseToken(token), "hex");
  const expected = Buffer.from(normalizedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getDeterministicCandidateIds(selection, explicitBarberId = null) {
  const explicit = String(explicitBarberId || "").trim();
  if (explicit) return [explicit];
  return Array.from(new Set(
    (Array.isArray(selection?.barber_candidate_ids) ? selection.barber_candidate_ids : [selection?.barber?.id_empleado])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  )).slice(0, 6);
}

function buildPromotionRecordForOption({ integrante, promotionResult, detailRows }) {
  if (!promotionResult?.aplicadas?.length && !promotionResult?.descartadas?.length) return null;
  return {
    order: integrante.orden_integrante,
    context: promotionResult.context,
    result: {
      promociones_aplicadas: promotionResult.aplicadas || [],
      promociones_descartadas: promotionResult.descartadas || [],
    },
    detailRows,
  };
}

function buildExistingDiscountAllocations(detailRows = []) {
  return (Array.isArray(detailRows) ? detailRows : [])
    .filter((row) => Number(row?.descuento_hnl || 0) > 0 && row?.line_key)
    .map((row) => ({
      line_key: row.line_key,
      source_type: "promotion",
      source_id: "existing_booking_discount",
      descuento_hnl: normalizeMoney(row.descuento_hnl),
    }));
}

function buildGroupPromotionContextFromIntegrantes({
  branch,
  clientProfile,
  integrantes = [],
}) {
  const first = integrantes[0] || {};
  const startDateTime = normalizeOperationalDateTime(first.selection?.startDateTime, "fecha_inicio");
  const discountLines = [];
  const serviceItems = [];
  for (const integrante of integrantes) {
    for (const row of Array.isArray(integrante.detailRows) ? integrante.detailRows : []) {
      const baseLine = {
        ...row,
        orden_integrante: integrante.orden_integrante,
        descuento_previo_hnl: normalizeMoney(row.descuento_hnl),
        base_disponible_hnl: normalizeMoney(Math.max(0, Number(row.subtotal_hnl || 0) - Number(row.descuento_hnl || 0))),
      };
      discountLines.push(baseLine);
      serviceItems.push(baseLine);
    }
  }
  const subtotal = normalizeMoney(discountLines.reduce((sum, row) => sum + Number(row.base_disponible_hnl || 0), 0));
  return {
    id_sucursal: branch.id_sucursal,
    id_empleado_barbero: first.selection?.barber?.id_empleado || null,
    id_cliente: clientProfile.id_cliente,
    id_persona: clientProfile.id_persona,
    id_grupo_cita: null,
    fecha_hora: startDateTime.iso_utc,
    fecha: startDateTime.fecha_operativa,
    fecha_operativa: startDateTime.fecha_operativa,
    hora: startDateTime.hora_operativa,
    subtotal_hnl: subtotal,
    servicios: serviceItems,
    discount_lines: discountLines,
    paquetes: [],
    canal: "public",
    es_cliente_autenticado: false,
    es_titular: true,
  };
}

function filterPromotionResultByLineKeys(result = {}, lineKeys = new Set()) {
  const applied = [];
  for (const promotion of result.promociones_aplicadas || []) {
    const allocations = (promotion.line_allocations || [])
      .filter((allocation) => lineKeys.has(String(allocation?.line_key || "").trim()));
    const discount = normalizeMoney(allocations.reduce((sum, allocation) => sum + Number(allocation.descuento_hnl || 0), 0));
    if (discount <= 0) continue;
    applied.push({
      ...promotion,
      descuento_calculado_hnl: discount,
      line_allocations: allocations,
      targetLineKeys: allocations.map((allocation) => allocation.line_key),
    });
  }
  return {
    promociones_aplicadas: applied,
    promociones_descartadas: [],
  };
}

function applyGroupPromotionResultToIntegrantes(integrantes = [], groupContext = {}, groupResult = {}, {
  bookingIsvEnabled = false,
} = {}) {
  if (!Array.isArray(groupResult.promociones_aplicadas) || !groupResult.promociones_aplicadas.length) return [];
  const records = [];
  for (const integrante of integrantes) {
    const lineKeys = new Set((integrante.detailRows || []).map((row) => String(row?.line_key || "").trim()).filter(Boolean));
    if (!lineKeys.size) continue;
    const filteredResult = filterPromotionResultByLineKeys(groupResult, lineKeys);
    if (!filteredResult.promociones_aplicadas.length) continue;

    const groupAllocations = filteredResult.promociones_aplicadas.flatMap((promotion) => (
      (promotion.line_allocations || []).map((allocation) => ({
        line_key: allocation.line_key,
        source_type: "promotion",
        source_id: promotion.id_promocion_regla,
        id_promocion: promotion.id_promocion,
        id_promocion_regla: promotion.id_promocion_regla,
        descuento_hnl: allocation.descuento_hnl,
      }))
    ));
    const existingAllocations = buildExistingDiscountAllocations(integrante.detailRows);
    const totalDiscount = normalizeMoney([...existingAllocations, ...groupAllocations]
      .reduce((sum, allocation) => sum + Number(allocation.descuento_hnl || 0), 0));
    const discountPlan = buildDiscountPlan(integrante.detailRows, [...existingAllocations, ...groupAllocations]);
    const detailRows = buildAppointmentDetailRows(integrante.selection.serviceSelection.items || [], {
      descuentoTotalHnl: totalDiscount,
      discountPlan,
      ordenIntegrante: integrante.orden_integrante,
      bookingIsvEnabled,
    });
    const subtotal = normalizeMoney(detailRows.reduce((sum, row) => sum + Number(row.subtotal_hnl || 0), 0));
    const total = normalizeMoney(detailRows.reduce((sum, row) => sum + Number(row.total_linea_hnl || 0), 0));

    integrante.detailRows = detailRows;
    integrante.descuentoHnl = totalDiscount;
    integrante.discountPlan = discountPlan;
    integrante._response_totals = {
      subtotalHnl: subtotal,
      descuentoHnl: totalDiscount,
      totalHnl: total,
    };
    integrante._promotion_result = {
      aplicadas: [
        ...(integrante._promotion_result?.aplicadas || []),
        ...filteredResult.promociones_aplicadas,
      ],
      descartadas: integrante._promotion_result?.descartadas || [],
      context: integrante._promotion_result?.context || groupContext,
    };
    const record = {
      order: integrante.orden_integrante,
      context: groupContext,
      result: filteredResult,
      detailRows,
    };
    integrante._group_promotion_record = record;
    records.push(record);
  }
  return records;
}

async function buildPublicCanonicalOption(dbClient, {
  branch,
  clientProfile,
  integrante,
  index,
  selection,
  request,
  app,
}) {
  const subtotalServiciosHnl = normalizeMoney(
    selection.serviceSelection.monto_subtotal_hnl ?? selection.serviceSelection.monto_total_hnl
  );
  const promotionResult = await resolveRequestedPromotionsForPublicHold(dbClient, {
    branch,
    clientProfile,
    groupRecord: { id_grupo_cita: null },
    integrante,
    selection,
    index,
  });
  const descuentoHnl = normalizeMoney(promotionResult.descuento_hnl);
  const discountPlan = promotionResult.aplicadas?.length
    ? buildPromotionDiscountPlan(promotionResult.context, promotionResult.aplicadas)
    : null;
  const totalPagarHnl = normalizeMoney(Math.max(0, subtotalServiciosHnl - descuentoHnl));
  const detailRows = buildAppointmentDetailRows(selection.serviceSelection.items || [], {
    descuentoTotalHnl: descuentoHnl,
    discountPlan,
    ordenIntegrante: integrante.orden_integrante,
    bookingIsvEnabled: app.config?.bookingIsvEnabled,
  });
  const isTitular = index === 0;
  const canonicalIntegrante = {
    orden_integrante: integrante.orden_integrante,
    alias: integrante.alias,
    id_persona: isTitular ? clientProfile.id_persona : null,
    id_cliente: isTitular ? clientProfile.id_cliente : null,
    id_usuario: null,
    tipo_cliente_codigo: "invitado",
    contacto_nombre: integrante.contacto?.nombre || integrante.alias,
    contacto_email: integrante.contacto?.email || null,
    contacto_telefono: integrante.contacto?.telefono || null,
    id_empleado_barbero: selection.barber.id_empleado,
    barber_candidate_ids: [],
    asignada_automaticamente: !integrante.id_barbero,
    selection,
    detailRows,
    descuentoHnl,
    discountPlan,
    inicio_at: selection.startDateTime.toISOString(),
    notas: request.body?.notas ?? null,
    _response_totals: {
      subtotalHnl: subtotalServiciosHnl,
      descuentoHnl,
      totalHnl: totalPagarHnl,
    },
  };
  canonicalIntegrante._promotion_record = buildPromotionRecordForOption({
    integrante,
    promotionResult,
    detailRows,
  });
  canonicalIntegrante._promotion_result = promotionResult;
  return canonicalIntegrante;
}

async function buildPublicCanonicalIntegranteWithAttempts(dbClient, {
  branch,
  clientProfile,
  integrante,
  index,
  selection,
  request,
  app,
}) {
  const candidateIds = getDeterministicCandidateIds(selection, integrante.id_barbero);
  const options = [];
  for (const candidateId of candidateIds) {
    const candidateSelection = String(candidateId) === String(selection.barber.id_empleado)
      ? selection
      : await resolveBookingSelection(dbClient, {
          id_sucursal: branch.id_sucursal,
          selection_type: integrante.selection_type,
          servicios: integrante.serviceIds,
          id_paquete: integrante.id_paquete,
          fecha_inicio: integrante.fecha_inicio,
          id_barbero: candidateId,
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });
    options.push(await buildPublicCanonicalOption(dbClient, {
      branch,
      clientProfile,
      integrante,
      index,
      selection: candidateSelection,
      request,
      app,
    }));
  }
  const primary = options[0] || await buildPublicCanonicalOption(dbClient, {
    branch,
    clientProfile,
    integrante,
    index,
    selection,
    request,
    app,
  });
  return {
    ...primary,
    assignment_options: integrante.id_barbero ? [] : options,
  };
}

function splitFullName(rawName) {
  const normalized = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { nombres: "Cliente", apellidos: "Publico" };
  }

  const parts = normalized.split(" ");
  if (parts.length === 1) {
    return { nombres: parts[0], apellidos: "Publico" };
  }

  return {
    nombres: parts.slice(0, -1).join(" "),
    apellidos: parts[parts.length - 1],
  };
}

function normalizePersonName(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token
      .split(/([-'])/)
      .map((part, index) => {
        if (index % 2 === 1) return part;
        const lower = String(part || "").toLocaleLowerCase("es-HN");
        if (!lower) return "";
        return `${lower.charAt(0).toLocaleUpperCase("es-HN")}${lower.slice(1)}`;
      })
      .join(""))
    .join(" ");
}

function buildFullName(nombres, apellidos) {
  return [normalizePersonName(nombres), normalizePersonName(apellidos)]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function normalizePhone(rawValue) {
  return String(rawValue || "").replace(/[^\d+]/g, "").slice(0, 20);
}

function hasPhoneLetters(rawValue) {
  return /[A-Za-z]/.test(String(rawValue || ""));
}

function hasUnsafeText(rawValue) {
  return /[<>]/.test(String(rawValue || ""));
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function normalizeDocument(rawValue) {
  return String(rawValue || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePublicContactValidationEntry(contacto, fallbackIndex = 0) {
  const blockIndex = Number.isInteger(Number(contacto?.blockIndex))
    ? Math.max(0, Math.trunc(Number(contacto.blockIndex)))
    : fallbackIndex;
  const aliasFallback = blockIndex === 0 ? "Titular" : `Acompanante ${blockIndex}`;
  const alias = String(contacto?.alias || aliasFallback).trim().slice(0, 80) || aliasFallback;
  const rolIntegranteCodigo = String(contacto?.rol_integrante_codigo || (blockIndex === 0 ? "titular" : "acompanante"))
    .trim()
    .toLowerCase();
  const email = normalizeEmail(contacto?.email);
  const rawTelefono = String(contacto?.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);
  const dni = normalizeDocument(contacto?.dni);

  if (email && !EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "El correo del contacto debe ser valido", {
      code: "PUBLIC_CITAS_CONTACT_EMAIL_INVALID",
      details: { field: "contacto.email", alias, blockIndex },
    });
  }
  if (rawTelefono && hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "El telefono del contacto no admite letras", {
      code: "PUBLIC_CITAS_CONTACT_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }
  if (telefono && telefono.length < 8) {
    throw new AppError(400, "El telefono del contacto debe ser valido", {
      code: "PUBLIC_CITAS_CONTACT_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }

  return {
    blockIndex,
    alias,
    rol_integrante_codigo: rolIntegranteCodigo,
    email: email || null,
    telefono: telefono || null,
    dni: dni || null,
  };
}

function buildDuplicateContactConflict(entry, field, message, code = "CONTACTO_DUPLICADO") {
  return {
    blockIndex: entry.blockIndex,
    alias: entry.alias,
    rol_integrante_codigo: entry.rol_integrante_codigo,
    field,
    code,
    message,
    email: entry.email || null,
    telefono: entry.telefono || null,
    dni: entry.dni || null,
  };
}

function collectDuplicateContactConflicts(contactos = []) {
  const groups = new Map();
  const register = (type, value, entry) => {
    if (!value) return;
    const key = `${type}:${value}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  };

  contactos.forEach((entry) => {
    register("email", entry.email, entry);
    register("telefono", entry.telefono, entry);
    register("dni", entry.dni, entry);
  });

  const conflicts = [];
  groups.forEach((entries, key) => {
    if (entries.length <= 1) return;
    const [type] = key.split(":");
    const message = type === "telefono"
      ? "Hay telefonos repetidos en la reserva."
      : type === "dni"
        ? "Hay DNI repetidos en la reserva."
        : "Hay contactos repetidos en la reserva.";
    const field = type === "telefono"
      ? "contacto.telefono"
      : type === "dni"
        ? "contacto.dni"
        : "contacto.email";
    entries.forEach((entry) => {
      conflicts.push(buildDuplicateContactConflict(entry, field, message));
    });
  });
  return conflicts;
}

async function collectExistingActiveEmailConflicts(client, contactos = []) {
  const emails = Array.from(new Set(contactos.map((entry) => entry.email).filter(Boolean)));
  if (!client || emails.length === 0) return [];

  const existingUserRows = await client.query(
    `
      SELECT DISTINCT lower(co.direccion_correo::text) AS email
      FROM public.usuarios u
      JOIN public.personas p
        ON p.id_persona = u.id_persona
       AND p.deleted_at IS NULL
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'activo') = 'activo'
        AND lower(co.direccion_correo::text) = ANY($1::text[])
    `,
    [emails]
  );

  const activeUserEmails = new Set(existingUserRows.rows.map((row) => normalizeEmail(row.email)));
  return contactos
    .filter((entry) => entry.email && activeUserEmails.has(entry.email))
    .map((entry) => ({
      blockIndex: entry.blockIndex,
      alias: entry.alias,
      rol_integrante_codigo: entry.rol_integrante_codigo,
      field: "contacto.email",
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      email: entry.email,
      message: entry.blockIndex === 0
        ? "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar."
        : `El correo de ${entry.alias} pertenece a una cuenta activa. Ese acompanante debe iniciar sesion o usar otro correo.`,
    }));
}

function parseIsoDateAndTime(rawDateTime) {
  try {
    const normalized = normalizeOperationalDateTime(rawDateTime, "fecha_inicio");
    return { fecha: normalized.fecha_operativa, hora: normalized.hora_operativa };
  } catch {
    return { fecha: null, hora: null };
  }
}

function getDateTimePartsInTimeZone(dateValue, timeZone = HONDURAS_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(dateValue);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  if (!year || !month || !day || !hour || !minute || !second) {
    return null;
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

function compareDateTimeParts(left, right) {
  if (!left || !right) return 0;
  const leftKey = [
    left.year,
    left.month,
    left.day,
    left.hour,
    left.minute,
    left.second,
  ];
  const rightKey = [
    right.year,
    right.month,
    right.day,
    right.hour,
    right.minute,
    right.second,
  ];

  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] > rightKey[index]) return 1;
    if (leftKey[index] < rightKey[index]) return -1;
  }
  return 0;
}

function assertDateTimeNotPastInHonduras(rawDateTime, field = "fecha_inicio") {
  let normalized;
  try {
    normalized = normalizeOperationalDateTime(rawDateTime, field);
  } catch (error) {
    throw new AppError(400, `${field} no es valida`, {
      code: error?.code || "PUBLIC_CITAS_INVALID_DATETIME",
      details: { field, value: rawDateTime, time_zone: HONDURAS_TIME_ZONE },
    });
  }
  const parsed = normalized.utcDate;
  const requestParts = getDateTimePartsInTimeZone(parsed, HONDURAS_TIME_ZONE);
  const nowParts = getDateTimePartsInTimeZone(new Date(), HONDURAS_TIME_ZONE);

  if (!requestParts || !nowParts) return parsed;

  if (compareDateTimeParts(requestParts, nowParts) < 0) {
    throw new AppError(400, `${field} no puede estar en el pasado`, {
      code: "PUBLIC_CITAS_PAST_DATETIME",
      details: { field, value: rawDateTime, time_zone: HONDURAS_TIME_ZONE },
    });
  }

  return parsed;
}

function validateClientPayload(titular) {
  const nombres = normalizePersonName(titular?.nombres || "");
  const apellidos = normalizePersonName(titular?.apellidos || "");
  const nombre = buildFullName(nombres, apellidos) || normalizePersonName(titular?.nombre || "");
  const rawTelefono = String(titular?.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);
  const email = normalizeEmail(titular?.email);

  if (!nombre || hasUnsafeText(nombre) || nombre.length < 2 || nombre.length > 120) {
    throw new AppError(400, "titular.nombre es obligatorio", {
      code: "PUBLIC_CITAS_CLIENT_NAME_REQUIRED",
      details: { field: "titular.nombre" },
    });
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "titular.email es obligatorio y debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_EMAIL_REQUIRED",
      details: { field: "titular.email" },
    });
  }
  if (!rawTelefono) {
    throw new AppError(400, "titular.telefono es obligatorio", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_REQUIRED",
      details: { field: "titular.telefono" },
    });
  }
  if (hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "titular.telefono no admite letras", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }
  if (!telefono || telefono.length < 8) {
    throw new AppError(400, "titular.telefono debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }

  return {
    nombre,
    nombres,
    apellidos,
    telefono,
    email,
  };
}

function validateCompanionContactPayload(contacto, { alias, index }) {
  const nombres = normalizePersonName(contacto?.nombres || "");
  const apellidos = normalizePersonName(contacto?.apellidos || "");
  const nombreLegacy = normalizePersonName(contacto?.nombre || "");
  const legacyTokens = nombreLegacy.split(" ").filter(Boolean);
  const effectiveNombres = nombres || (
    legacyTokens.length > 1
      ? normalizePersonName(legacyTokens.slice(0, -1).join(" "))
      : normalizePersonName(legacyTokens[0] || "")
  );
  const effectiveApellidos = apellidos || (
    legacyTokens.length > 1
      ? normalizePersonName(legacyTokens[legacyTokens.length - 1])
      : ""
  );
  const nombre = buildFullName(effectiveNombres, effectiveApellidos);
  const email = normalizeEmail(contacto?.email);
  const rawTelefono = String(contacto?.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);
  const blockIndex = index;

  if (!effectiveNombres || hasUnsafeText(effectiveNombres) || effectiveNombres.length < 2 || effectiveNombres.length > 120) {
    throw new AppError(400, "El nombre del acompanante es obligatorio", {
      code: "PUBLIC_CITAS_COMPANION_NAME_REQUIRED",
      details: { field: "contacto.nombres", alias, blockIndex },
    });
  }
  if (!effectiveApellidos || hasUnsafeText(effectiveApellidos) || effectiveApellidos.length < 2 || effectiveApellidos.length > 120) {
    throw new AppError(400, "El apellido del acompanante es obligatorio", {
      code: "PUBLIC_CITAS_COMPANION_LAST_NAME_REQUIRED",
      details: { field: "contacto.apellidos", alias, blockIndex },
    });
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "El correo del acompanante debe ser valido", {
      code: "PUBLIC_CITAS_COMPANION_EMAIL_INVALID",
      details: { field: "contacto.email", alias, blockIndex },
    });
  }
  if (rawTelefono && hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "El telefono del acompanante no admite letras", {
      code: "PUBLIC_CITAS_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }
  if (telefono && telefono.length < 8) {
    throw new AppError(400, "El telefono del acompanante debe ser valido", {
      code: "PUBLIC_CITAS_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }

  return {
    nombre,
    nombres: effectiveNombres,
    apellidos: effectiveApellidos,
    email: email || null,
    telefono: telefono || null,
  };
}

function normalizeRequestedPromotionEntry(rawPromotion, { alias, index }) {
  const idPromocionRaw = String(rawPromotion?.id_promocion || "").trim();
  const idPromocionReglaRaw = String(rawPromotion?.id_promocion_regla || "").trim();
  if (!idPromocionRaw || !idPromocionReglaRaw) {
    throw new AppError(400, "La promocion seleccionada debe enviar promocion y regla", {
      code: "PUBLIC_CITAS_PROMOTION_CONTRACT_INVALID",
      details: { field: "promociones", alias, blockIndex: index },
    });
  }
  return {
    id_promocion: assertUuid(idPromocionRaw, "id_promocion"),
    id_promocion_regla: assertUuid(idPromocionReglaRaw, "id_promocion_regla"),
  };
}

function normalizeRequestedPromotionsPayload(item, { alias, index }) {
  const rawPromotions = Array.isArray(item?.promociones) && item.promociones.length > 0
    ? item.promociones
    : (
        item?.id_promocion || item?.id_promocion_regla
          ? [{ id_promocion: item?.id_promocion, id_promocion_regla: item?.id_promocion_regla }]
          : []
      );
  if (!rawPromotions.length) return [];
  if (rawPromotions.length > MAX_PUBLIC_PROMOTIONS_PER_BOOKING) {
    throw new AppError(400, "Has seleccionado mas promociones de las permitidas", {
      code: "PUBLIC_CITAS_PROMOTIONS_MAX_EXCEEDED",
      details: { field: "promociones", alias, blockIndex: index },
    });
  }

  const normalized = [];
  const seenKeys = new Set();
  for (const rawPromotion of rawPromotions) {
    const promotion = normalizeRequestedPromotionEntry(rawPromotion, { alias, index });
    const key = `${promotion.id_promocion}:${promotion.id_promocion_regla}`;
    if (seenKeys.has(key)) {
      throw new AppError(400, "Una promocion no puede repetirse en el mismo integrante", {
        code: "PUBLIC_CITAS_PROMOTION_DUPLICATED",
        details: { field: "promociones", alias, blockIndex: index },
      });
    }
    seenKeys.add(key);
    normalized.push(promotion);
  }
  return normalized;
}

function normalizeBlocksPayload(body, titularPayload) {
  const hasGroupedPayload = Array.isArray(body?.integrantes) && body.integrantes.length > 0;
  const hasLegacySelection = body?.selection_type === "package" || body?.selection_type === "mixed"
    ? Boolean(body?.fecha_inicio && body?.id_paquete)
    : Boolean(body?.fecha_inicio && Array.isArray(body?.servicios));
  const legacyPayload = hasLegacySelection
    ? [{
      orden_integrante: 1,
      alias: "Titular",
      id_barbero: body?.id_barbero ?? null,
      selection_type: body?.selection_type ?? "services",
      id_paquete: body?.id_paquete ?? null,
      id_promocion: body?.id_promocion ?? null,
      id_promocion_regla: body?.id_promocion_regla ?? null,
      fecha_inicio: body.fecha_inicio,
      servicios: body.servicios,
    }]
    : [];

  const rawBlocks = hasGroupedPayload ? body.integrantes : legacyPayload;
  if (!rawBlocks.length) {
    throw new AppError(400, "Debes enviar al menos un integrante para crear la reserva", {
      code: "PUBLIC_CITAS_BLOCKS_REQUIRED",
      details: { field: "integrantes" },
    });
  }

  const normalizedBlocks = rawBlocks.map((item, index) => {
    const aliasFallback = index === 0 ? "Titular" : `Acompanante ${index}`;
    const alias = String(item?.alias || aliasFallback).trim().slice(0, 80) || aliasFallback;
    const ordenIntegrante = Number(item?.orden_integrante);
    const selectionType = String(item?.selection_type || "services").trim().toLowerCase();
    const servicios = Array.isArray(item?.servicios) ? item.servicios : [];
    const packageId = parseSinglePackageId(item?.id_paquete, { required: false, field: "id_paquete" });

    if (!["services", "package", "mixed"].includes(selectionType)) {
      throw new AppError(400, `El integrante ${alias} tiene un selection_type invalido`, {
        code: "PUBLIC_CITAS_BLOCK_SELECTION_TYPE_INVALID",
        details: { field: "selection_type", alias, blockIndex: index, selection_type: item?.selection_type ?? null },
      });
    }

    if ((selectionType === "services" || selectionType === "mixed") && !servicios.length && !packageId) {
      throw new AppError(400, `El integrante ${alias} no tiene servicios seleccionados`, {
        code: "PUBLIC_CITAS_BLOCK_SERVICES_REQUIRED",
        details: { field: "servicios", alias, blockIndex: index },
      });
    }

    if ((selectionType === "package" || selectionType === "mixed") && !packageId && !servicios.length) {
      throw new AppError(400, `El integrante ${alias} no tiene paquete seleccionado`, {
        code: "PUBLIC_CITAS_BLOCK_PACKAGE_REQUIRED",
        details: { field: "id_paquete", alias, blockIndex: index },
      });
    }

    const serviceIds = (selectionType === "services" || selectionType === "mixed")
      ? servicios.map((service) => assertUuid(service?.id_servicio, "id_servicio"))
      : [];
    const requestedPromotions = normalizeRequestedPromotionsPayload(item, { alias, index });

    const fechaInicio = String(item?.fecha_inicio || "").trim();
    assertDateTimeNotPastInHonduras(fechaInicio, "fecha_inicio");

    return {
      orden_integrante: Number.isFinite(ordenIntegrante) && ordenIntegrante > 0 ? Math.trunc(ordenIntegrante) : index + 1,
      alias,
      id_barbero: item?.id_barbero ? assertUuid(item.id_barbero, "id_barbero") : null,
      selection_type: selectionType,
      id_paquete: packageId,
      promociones: requestedPromotions,
      fecha_inicio: fechaInicio,
      serviceIds,
      contacto: index === 0
        ? {
            nombre: titularPayload.nombre,
            nombres: titularPayload.nombres || splitFullName(titularPayload.nombre).nombres,
            apellidos: titularPayload.apellidos || splitFullName(titularPayload.nombre).apellidos,
            email: titularPayload.email,
            telefono: titularPayload.telefono || null,
          }
        : validateCompanionContactPayload(item?.contacto, { alias, index }),
    };
  });
  const totalRequestedPromotions = normalizedBlocks.reduce(
    (sum, block) => sum + (Array.isArray(block.promociones) ? block.promociones.length : 0),
    0
  );
  if (totalRequestedPromotions > MAX_PUBLIC_PROMOTIONS_PER_BOOKING) {
    throw new AppError(400, "Has seleccionado mas promociones de las permitidas", {
      code: "PUBLIC_CITAS_PROMOTIONS_MAX_EXCEEDED",
      details: { field: "promociones" },
    });
  }
  return normalizedBlocks;
}

function buildPromotionCodesByRule(codeRows = []) {
  const map = new Map();
  for (const row of codeRows) {
    if (!map.has(row.id_promocion_regla)) map.set(row.id_promocion_regla, []);
    map.get(row.id_promocion_regla).push(row);
  }
  return map;
}

function buildPromotionCompatibilityMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.id_promocion_regla_a, row.id_promocion_regla_b].sort().join(":");
    map.set(key, Boolean(row.compatible));
  }
  return map;
}

function buildPromotionRequestKey(promotion) {
  return `${String(promotion?.id_promocion || "").trim()}:${String(promotion?.id_promocion_regla || "").trim()}`;
}

function buildPromotionDiscountPlan(context = {}, appliedPromotions = []) {
  const allocations = [];
  for (const promotion of Array.isArray(appliedPromotions) ? appliedPromotions : []) {
    for (const allocation of Array.isArray(promotion.line_allocations) ? promotion.line_allocations : []) {
      allocations.push({
        line_key: allocation.line_key,
        source_type: "promotion",
        source_id: promotion.id_promocion_regla,
        id_promocion: promotion.id_promocion,
        id_promocion_regla: promotion.id_promocion_regla,
        descuento_hnl: allocation.descuento_hnl,
      });
    }
  }
  return buildDiscountPlan(context.discount_lines || [], allocations);
}

async function resolveRequestedPromotionsForPublicHold(client, {
  branch,
  clientProfile,
  groupRecord,
  integrante,
  selection,
  index,
}) {
  const requestedPromotions = Array.isArray(integrante?.promociones) ? integrante.promociones : [];
  if (!requestedPromotions.length) {
    return { descuento_hnl: 0, aplicadas: [], descartadas: [] };
  }

  const requestedKeys = new Set(requestedPromotions.map(buildPromotionRequestKey));
  const startDateTime = normalizeOperationalDateTime(selection.startDateTime, "fecha_inicio");
  const promoContext = {
    id_sucursal: branch.id_sucursal,
    id_empleado_barbero: selection.barber.id_empleado,
    id_cliente: clientProfile.id_cliente,
    id_persona: clientProfile.id_persona,
    id_grupo_cita: groupRecord.id_grupo_cita,
    fecha_hora: startDateTime.iso_utc,
    fecha: startDateTime.fecha_operativa,
    fecha_operativa: startDateTime.fecha_operativa,
    hora: startDateTime.hora_operativa,
    subtotal_hnl: Number(selection.serviceSelection.monto_subtotal_hnl ?? selection.serviceSelection.monto_total_hnl ?? 0),
    servicios: selection.serviceSelection.items || [],
    discount_lines: buildCanonicalDiscountLines(selection.serviceSelection.items || [], {
      orden_integrante: integrante.orden_integrante || index + 1,
    }),
    paquetes: selection.serviceSelection.id_paquete
      ? [{ id_paquete: selection.serviceSelection.id_paquete }]
      : [],
    canal: "public",
    es_cliente_autenticado: false,
    es_titular: index === 0,
  };

  const candidates = (await getCandidatePromotionRules(client, promoContext))
    .filter((row) => requestedKeys.has(buildPromotionRequestKey(row)) && row.visible_publico === true);
  const candidateKeys = new Set(candidates.map(buildPromotionRequestKey));
  const missingRequest = requestedPromotions.find((promotion) => !candidateKeys.has(buildPromotionRequestKey(promotion)));
  if (missingRequest) {
    throw new AppError(409, "La promocion seleccionada no aplica para esta reserva", {
      code: "PUBLIC_CITAS_PROMOTION_NOT_APPLICABLE",
      details: {
        field: "promociones",
        alias: integrante.alias,
        blockIndex: index,
        reason: "PROMOCION_NO_DISPONIBLE",
      },
    });
  }

  const groupCandidateKeys = new Set(candidates
    .filter((candidate) => isGroupScopedBonificationPromotion(candidate))
    .map(buildPromotionRequestKey));
  const immediateCandidates = candidates.filter((candidate) => !isGroupScopedBonificationPromotion(candidate));
  if (!immediateCandidates.length) {
    return {
      descuento_hnl: 0,
      aplicadas: [],
      descartadas: [],
      context: promoContext,
    };
  }

  const ruleIds = immediateCandidates.map((row) => row.id_promocion_regla);
  const [codeRows, compatibilityRows, usageStats] = await Promise.all([
    getPromotionCodesByRules(client, ruleIds),
    getPromotionCompatibility(client, ruleIds),
    getPromotionUsageStats(client, promoContext, ruleIds),
  ]);
  const codesByRule = buildPromotionCodesByRule(codeRows);
  const evaluated = evaluatePromotions(
    promoContext,
    immediateCandidates.map((candidate) => ({
      ...candidate,
      codes: codesByRule.get(candidate.id_promocion_regla) || [],
    })),
    usageStats
  );
  const resolved = resolvePromotionConflicts(promoContext, evaluated, buildPromotionCompatibilityMap(compatibilityRows));
  const result = buildPromotionResult(promoContext, resolved);
  const appliedKeys = new Set((result.promociones_aplicadas || []).map(buildPromotionRequestKey));
  const rejectedRequest = requestedPromotions.find((promotion) => {
    const key = buildPromotionRequestKey(promotion);
    return !groupCandidateKeys.has(key) && !appliedKeys.has(key);
  });
  if (rejectedRequest) {
    const rejectedKey = buildPromotionRequestKey(rejectedRequest);
    const discarded = (result.promociones_descartadas || []).find((row) => buildPromotionRequestKey(row) === rejectedKey);
    const evaluatedRejected = evaluated.find((row) => buildPromotionRequestKey(row) === rejectedKey);
    if (isGroupScopedBonificationPromotion(evaluatedRejected || discarded)) {
      return {
        descuento_hnl: normalizeMoney(result.descuento_total_hnl),
        aplicadas: (result.promociones_aplicadas || []).filter((row) => !isGroupScopedBonificationPromotion(row)),
        descartadas: (result.promociones_descartadas || []).filter((row) => !isGroupScopedBonificationPromotion(row)),
        context: promoContext,
      };
    }
    throw new AppError(409, "La promocion seleccionada no aplica para esta reserva", {
      code: "PUBLIC_CITAS_PROMOTION_NOT_APPLICABLE",
      details: {
        field: "promociones",
        alias: integrante.alias,
        blockIndex: index,
        reason: discarded?.motivo_codigo || evaluatedRejected?.reasonCode || "PROMOCION_NO_APLICADA",
      },
    });
  }

  return {
    descuento_hnl: normalizeMoney(result.descuento_total_hnl),
    aplicadas: result.promociones_aplicadas || [],
    descartadas: result.promociones_descartadas || [],
    context: promoContext,
  };
}

async function resolveOrCreatePublicClient(client, payload) {
  const { nombre, nombres, apellidos, telefono, email, idSucursal } = payload;

  const existingActiveUserByEmailResult = await client.query(
    `
      SELECT u.id_usuario
      FROM public.usuarios u
      JOIN public.personas p
        ON p.id_persona = u.id_persona
       AND p.deleted_at IS NULL
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'activo') = 'activo'
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  if (existingActiveUserByEmailResult.rows[0]) {
    throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesión para continuar.", {
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      details: { field: "titular.email" },
    });
  }

  const existingUserClientResult = await client.query(
    `
      SELECT c.id_cliente, c.id_persona
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
       AND p.deleted_at IS NULL
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE c.deleted_at IS NULL
        AND c.estado IS TRUE
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  if (existingUserClientResult.rows[0]) {
    throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesión para continuar.", {
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      details: { field: "titular.email" },
    });
  }

  const existingPersonaResult = await client.query(
    `
      SELECT p.id_persona
      FROM public.personas p
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  let idPersona = existingPersonaResult.rows[0]?.id_persona || null;

  if (!idPersona) {
    const resolvedName = buildFullName(nombres, apellidos) || nombre;
    const splitName = splitFullName(resolvedName);

    const personaInsert = await client.query(
      `
        INSERT INTO public.personas (nombres, apellidos, telefono_principal)
        VALUES ($1, $2, $3)
        RETURNING id_persona
      `,
      [splitName.nombres, splitName.apellidos, telefono || null]
    );
    idPersona = personaInsert.rows[0].id_persona;
  } else if (telefono) {
    await client.query(
      `
        UPDATE public.personas
        SET telefono_principal = COALESCE(NULLIF(telefono_principal, ''), $2),
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [idPersona, telefono]
    );
  }

  void idSucursal;

  await client.query(
    `
      INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
      VALUES ($1::uuid, $2, TRUE, FALSE)
      ON CONFLICT DO NOTHING
    `,
    [idPersona, email]
  );

  return {
    id_cliente: null,
    id_persona: idPersona,
  };
}

export default async function publicCitasRoutes(app) {
  app.post(
    "/validar-contactos",
    {
      schema: {
        body: {
          type: "object",
          required: ["contactos"],
          properties: {
            contactos: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  blockIndex: { type: "integer", minimum: 0 },
                  rol_integrante_codigo: { type: "string", maxLength: 40 },
                  alias: { type: "string", maxLength: 80 },
                  email: { anyOf: [{ type: "string", maxLength: 160 }, { type: "null" }] },
                  telefono: { anyOf: [{ type: "string", maxLength: 20 }, { type: "null" }] },
                  dni: { anyOf: [{ type: "string", maxLength: 32 }, { type: "null" }] },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const contactos = Array.isArray(request.body?.contactos)
          ? request.body.contactos.map((contacto, index) => normalizePublicContactValidationEntry(contacto, index))
          : [];
        if (!contactos.length) {
          throw new AppError(400, "Debes enviar al menos un contacto para validar", {
            code: "PUBLIC_CITAS_CONTACTS_REQUIRED",
            details: { field: "contactos" },
          });
        }

        const duplicateConflicts = collectDuplicateContactConflicts(contactos);
        const activeEmailConflicts = app.db
          ? await collectExistingActiveEmailConflicts(app.db, contactos)
          : [];
        const conflicts = [...duplicateConflicts, ...activeEmailConflicts];

        if (conflicts.length > 0) {
          const hasActiveUserConflict = conflicts.some((conflict) => conflict.code === "EMAIL_BELONGS_TO_ACTIVE_USER");
          const errorCode = hasActiveUserConflict
            ? "PUBLIC_CITAS_CONTACT_EMAIL_CONFLICT"
            : "PUBLIC_CITAS_CONTACT_DUPLICATE_CONFLICT";
          const errorMessage = hasActiveUserConflict
            ? "Hay contactos que ya pertenecen a cuentas activas."
            : "Hay contactos repetidos en la reserva.";

          return reply.code(409).send({
            ok: false,
            valido: false,
            warnings: [],
            errors: [
              {
                code: "CONTACTO_DUPLICADO",
                message: errorMessage,
              },
            ],
            error: {
              code: errorCode,
              message: errorMessage,
              details: {
                conflicts,
              },
            },
            requestId: request.id,
          });
        }

        return reply.code(200).send({
          ok: true,
          valido: true,
          warnings: [],
          errors: [],
          requestId: request.id,
        });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudieron validar los contactos publicos",
          "PUBLIC_CITAS_VALIDATE_CONTACTS_ERROR"
        );
      }
    }
  );

  app.get(
    "/contexto",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: contextSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      try {
        const [branchResult, paramsMap] = await Promise.all([
          app.db.query(
            `
              SELECT id_sucursal, nombre_sucursal
              FROM public.sucursales
              WHERE deleted_at IS NULL
                AND estado IS TRUE
              ORDER BY nombre_sucursal ASC
            `
          ),
          getSystemParameters(app.db),
        ]);

        const sucursales = branchResult.rows.map((row) => ({
          id_sucursal: row.id_sucursal,
          nombre_sucursal: row.nombre_sucursal || "Sucursal",
        }));

        const parametros = normalizePublicParams(paramsMap);

        return sendOk(reply, { sucursales, parametros });
      } catch (error) {
        request.log.error({ err: error }, "Public citas contexto error");
        return sendError(reply, 500, "No se pudo consultar el contexto de citas publicas", {
          code: "PUBLIC_CITAS_CONTEXT_ERROR",
          requestId: request.id,
        });
      }
    }
  );

  app.post(
    "/hold",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal", "titular"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            titular: {
              type: "object",
              required: ["nombre", "email", "telefono"],
              properties: {
                nombre: { type: "string", minLength: 1, maxLength: 120 },
                nombres: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                apellidos: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                email: { type: "string", format: "email", maxLength: 160 },
                telefono: { anyOf: [{ type: "string", minLength: 8, maxLength: 20 }, { type: "null" }] },
              },
              additionalProperties: false,
            },
            integrantes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["fecha_inicio"],
                properties: {
                  orden_integrante: { type: "integer" },
                  alias: { type: "string", maxLength: 80 },
                  rol_integrante_codigo: { type: "string", maxLength: 40 },
                  id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  selection_type: { type: "string", enum: ["services", "package", "mixed"] },
                  id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  contacto: {
                    type: "object",
                    properties: {
                      nombre: { type: "string", minLength: 1, maxLength: 120 },
                      nombres: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                      apellidos: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                      email: { anyOf: [{ type: "string", format: "email", maxLength: 160 }, { type: "null" }] },
                      telefono: { anyOf: [{ type: "string", minLength: 8, maxLength: 20 }, { type: "null" }] },
                    },
                    additionalProperties: false,
                  },
                  fecha_inicio: { type: "string", format: "date-time" },
                  servicios: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id_servicio"],
                      properties: {
                        id_servicio: { type: "string", format: "uuid" },
                      },
                      additionalProperties: false,
                    },
                  },
                  id_promocion: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  id_promocion_regla: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  promociones: {
                    type: "array",
                    maxItems: MAX_PUBLIC_PROMOTIONS_PER_BOOKING,
                    items: {
                      type: "object",
                      required: ["id_promocion", "id_promocion_regla"],
                      properties: {
                        id_promocion: { type: "string", format: "uuid" },
                        id_promocion_regla: { type: "string", format: "uuid" },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            },
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            fecha_inicio: { type: "string", format: "date-time" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            servicios: {
              type: "array",
              items: {
                type: "object",
                required: ["id_servicio"],
                properties: {
                  id_servicio: { type: "string", format: "uuid" },
                },
                additionalProperties: false,
              },
            },
            id_promocion: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            id_promocion_regla: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            notas: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  request_id: { type: "string", format: "uuid" },
                  id_grupo_cita: { type: "string", format: "uuid" },
                  estado_grupo_codigo: { type: "string" },
                  expires_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
                  monto_total_hnl: { type: "number" },
                  subtotal_hnl: { type: "number" },
                  descuento_total_hnl: { type: "number" },
                  total_pagar_hnl: { type: "number" },
                  extras_a_pagar_hnl: { type: "number" },
                  total_hnl: { type: "number" },
                  release_token: { type: "string" },
                  promociones_aplicadas: { type: "array", items: { type: "object", additionalProperties: true } },
                  promociones_descartadas: { type: "array", items: { type: "object", additionalProperties: true } },
                  bloques: { type: "array", items: holdBlockSchema },
                },
                required: ["request_id", "id_grupo_cita", "estado_grupo_codigo", "expires_at", "monto_total_hnl", "bloques"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      let dbClient;
      try {
        const requestId = resolveReservationRequestId(request.headers?.["x-idempotency-key"]);
        reply.header("x-idempotency-key", requestId);
        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const titularPayload = validateClientPayload(request.body?.titular);
        const integrantes = normalizeBlocksPayload(request.body, titularPayload);
        if (integrantes.length > 5) {
          throw new AppError(400, "Solo se permiten hasta 4 acompañantes por reserva", {
            code: "PUBLIC_CITAS_MAX_COMPANIONS",
            details: { field: "integrantes", maxCompanions: 4 },
          });
        }
        const titularDateTime = parseIsoDateAndTime(integrantes[0]?.fecha_inicio || "");
        const requestFingerprint = buildReservationRequestFingerprint({
          scope: PUBLIC_HOLD_IDEMPOTENCY_SCOPE,
          actor: {
            tipo: "publico",
            email: titularPayload.email,
            telefono: titularPayload.telefono,
          },
          body: request.body,
        });

        dbClient = await app.db.connect();
        const idempotencyState = await getReservationIdempotencyState(dbClient, {
          requestId,
          scope: PUBLIC_HOLD_IDEMPOTENCY_SCOPE,
          requestFingerprint,
        });
        const idempotencyStatus = assertKnownIdempotencyState(idempotencyState);
        if (idempotencyStatus === "completed") {
          return sendOk(reply, {
            ...idempotencyState.data,
            request_id: idempotencyState.data?.request_id || requestId,
          }, { statusCode: idempotencyState.statusCode || 201 });
        }
        const branch = await ensureActiveBranch(dbClient, idSucursal);

        const responsePayload = await createBookingHold({
          dbClient,
          operation: async () => {
        const clientProfile = await resolveOrCreatePublicClient(dbClient, {
          ...titularPayload,
          idSucursal: branch.id_sucursal,
        });

        const targetAppointmentState = "en_espera";
        const releaseTokenSupport = await getPublicHoldReleaseTokenSupport(dbClient);
        const releaseToken = releaseTokenSupport.supported
          ? buildDeterministicPublicReleaseToken(requestId, resolvePublicReleaseTokenSecret(app))
          : null;
        const canonicalIntegrantes = [];
        const pendingPromotionRecords = [];
        let subtotalGrupo;
        let descuentoGrupo;
        let totalGrupo;
        const promocionesAplicadasGrupo = [];
        const promocionesDescartadasGrupo = [];

        for (let index = 0; index < integrantes.length; index += 1) {
          const integrante = integrantes[index];
          assertBookingSelectionCreationSupported(integrante.selection_type);
          const splitDateTime = parseIsoDateAndTime(integrante.fecha_inicio);
          if (index > 0 && splitDateTime.fecha !== titularDateTime.fecha) {
            throw new AppError(409, "Los acompañantes deben agendarse en la misma fecha del titular", {
              code: "PUBLIC_CITAS_COMPANION_DATE_MISMATCH",
              details: { field: "fecha_inicio", alias: integrante.alias, blockIndex: index },
            });
          }
          const selection = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            selection_type: integrante.selection_type,
            servicios: integrante.serviceIds,
            id_paquete: integrante.id_paquete,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
            bookingIsvEnabled: app.config?.bookingIsvEnabled,
          });
          const canonicalIntegrante = await buildPublicCanonicalIntegranteWithAttempts(dbClient, {
            branch,
            clientProfile,
            integrante,
            index,
            selection,
            request,
            app,
          });
          canonicalIntegrantes.push(canonicalIntegrante);
        }

        const requestedGroupPromotions = integrantes.flatMap((integrante) => (
          Array.isArray(integrante.promociones) ? integrante.promociones : []
        ));
        const groupPromotionContext = requestedGroupPromotions.length
          ? buildGroupPromotionContextFromIntegrantes({
            branch,
            clientProfile,
            integrantes: canonicalIntegrantes,
          })
          : null;
        const groupPromotionResult = groupPromotionContext
          ? await previewGroupBonificationPromotions(dbClient, groupPromotionContext, {
            requestedPromotions: requestedGroupPromotions,
            publicOnly: true,
          })
          : null;
        const rejectedGroupPromotion = groupPromotionResult?.evaluated?.find((row) => (
          isGroupScopedBonificationPromotion(row)
          && row.isValid !== true
          && requestedGroupPromotions.some((promotion) => buildPromotionRequestKey(promotion) === buildPromotionRequestKey(row))
        ));
        if (rejectedGroupPromotion) {
          throw new AppError(409, "La promocion seleccionada no aplica para esta reserva", {
            code: "PUBLIC_CITAS_PROMOTION_NOT_APPLICABLE",
            details: {
              field: "promociones",
              reason: rejectedGroupPromotion.reasonCode || "PROMOCION_NO_APLICADA",
            },
          });
        }
        if (groupPromotionResult?.promociones_aplicadas?.length) {
          applyGroupPromotionResultToIntegrantes(canonicalIntegrantes, groupPromotionContext, groupPromotionResult, {
            bookingIsvEnabled: app.config?.bookingIsvEnabled,
          });
        }

        const canonicalPayload = buildCanonicalReservationPayload({
          requestId,
          idSucursal: branch.id_sucursal,
          idPersonaTitular: clientProfile.id_persona,
          idClienteTitular: clientProfile.id_cliente,
          idUsuarioTitular: null,
          origenCodigo: "publico",
          notas: request.body?.notas ?? null,
          releaseTokenHash: releaseToken ? hashPublicReleaseToken(releaseToken) : null,
          integrantes: canonicalIntegrantes,
          assignmentAttempts: buildAssignmentAttemptsFromIntegrantes(canonicalIntegrantes),
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });
        const canonicalResult = await createCanonicalReservation(dbClient, canonicalPayload);
        const selectedIntegrantes = selectCanonicalIntegrantesForResult(canonicalIntegrantes, canonicalResult);
        const selectedTotals = summarizeCanonicalIntegrantes(selectedIntegrantes);
        assertCanonicalTotalsMatch({
          expected: selectedTotals,
          result: canonicalResult,
          context: { route: "public_citas_hold" },
        });
        const bloquesByOrder = new Map((canonicalResult?.bloques || []).map((block) => [
          Number(block.orden_integrante || 0),
          block,
        ]));
        pendingPromotionRecords.length = 0;
        promocionesAplicadasGrupo.length = 0;
        promocionesDescartadasGrupo.length = 0;
        subtotalGrupo = selectedTotals.subtotal_hnl;
        descuentoGrupo = selectedTotals.descuento_hnl;
        totalGrupo = selectedTotals.total_hnl;
        for (const integrante of selectedIntegrantes) {
          if (integrante._promotion_record) pendingPromotionRecords.push(integrante._promotion_record);
          if (integrante._group_promotion_record) pendingPromotionRecords.push(integrante._group_promotion_record);
          for (const appliedPromotion of integrante._promotion_result?.aplicadas || []) {
            promocionesAplicadasGrupo.push({
              ...appliedPromotion,
              orden_integrante: integrante.orden_integrante,
              alias: integrante.alias,
            });
          }
          for (const discardedPromotion of integrante._promotion_result?.descartadas || []) {
            promocionesDescartadasGrupo.push({
              ...discardedPromotion,
              orden_integrante: integrante.orden_integrante,
              alias: integrante.alias,
            });
          }
        }
        for (const promotionRecord of pendingPromotionRecords) {
          const block = bloquesByOrder.get(Number(promotionRecord.order || 0));
          if (!block?.id_cita) continue;
          const detailRows = await loadCanonicalPromotionDetailRows(dbClient, {
            idCita: block.id_cita,
            detailRows: promotionRecord.detailRows,
            canonicalBlock: block,
          });
          await recordPromotionApplications(
            dbClient,
            {
              ...promotionRecord.context,
              id_grupo_cita: canonicalResult.id_grupo_cita,
              id_cita: block.id_cita,
              id_cita_integrante: block.id_cita_integrante || block.id_integrante || null,
              id_hold: block.id_hold || null,
              reservado_expires_at: block.expires_at || canonicalResult.expires_at || null,
              idempotency_key: requestId,
              detailRows,
            },
            promotionRecord.result,
            { formal: true, usageState: "reservado" }
          );
        }
        const bloquesResponse = selectedIntegrantes.map((integrante) => {
          const block = bloquesByOrder.get(Number(integrante.orden_integrante || 0)) || {};
          const { fecha, hora } = parseIsoDateAndTime(integrante.selection.startDateTime);
          return {
            id_cita: block.id_cita || null,
            orden_integrante: integrante.orden_integrante,
            alias: integrante.alias,
            id_barbero: block.id_empleado_barbero || integrante.selection.barber.id_empleado,
            nombre_barbero: integrante.selection.barber.nombre_completo,
            fecha: fecha || "",
            hora: hora || "",
            fecha_inicio: integrante.selection.startDateTime.toISOString(),
            estado_cita_codigo: block.estado_cita_codigo || targetAppointmentState,
            monto_total_hnl: Number(block.monto_total_hnl ?? block.subtotal_hnl ?? 0),
            descuento_hnl: Number(block.descuento_hnl ?? 0),
            total_pagar_hnl: Number(block.total_pagar_hnl ?? block.total_hnl ?? 0),
            duracion_total_min: Number(integrante.selection.serviceSelection.duracion_total_min || 0),
            buffer_total_min: Number(integrante.selection.serviceSelection.buffer_total_min || 0),
          };
        });

        const holdResponsePayload = buildCanonicalHoldResponse({
          requestId,
          canonicalResult,
          totals: selectedTotals,
          blocks: bloquesResponse,
          extensions: {
            monto_total_hnl: subtotalGrupo,
            subtotal_hnl: subtotalGrupo,
            descuento_total_hnl: descuentoGrupo,
            total_pagar_hnl: totalGrupo,
            extras_a_pagar_hnl: totalGrupo,
            total_hnl: totalGrupo,
            ...(releaseToken ? { release_token: releaseToken } : {}),
            promociones_aplicadas: promocionesAplicadasGrupo,
            promociones_descartadas: promocionesDescartadasGrupo,
          },
        });
        await finalizeReservationIdempotency(dbClient, {
          requestId,
          scope: PUBLIC_HOLD_IDEMPOTENCY_SCOPE,
          requestFingerprint,
          responsePayload: holdResponsePayload,
          statusCode: 201,
        });
        return holdResponsePayload;
          },
        });

        return sendOk(reply, responsePayload, { statusCode: 201 });
      } catch (error) {
        const mappedError = mapCanonicalReservationError(error, {
          publicRoute: true,
          safeMessage: "No se pudo crear el hold publico",
        });
        if (isAvailabilityConflictError(mappedError)) {
          const reason = resolveSafeConflictReason(mappedError);
          request.log.warn(
            {
              requestId: request.id,
              reason,
              sourceCode: mappedError instanceof AppError ? String(mappedError.code || "") : null,
            },
            "Public hold rejected by agenda conflict"
          );
          return sendError(reply, 409, "La hora seleccionada ya no está disponible.", {
            code: "PUBLIC_CITAS_HOLD_CONFLICT",
            reason,
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, mappedError, "No se pudo crear el hold publico", "PUBLIC_CITAS_HOLD_CREATE_ERROR");
      } finally {
        if (dbClient) dbClient.release();
      }
    }
  );

  app.delete(
    "/hold/:id_grupo_cita",
    {
      schema: {
        params: {
          type: "object",
          required: ["id_grupo_cita"],
          properties: {
            id_grupo_cita: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        body: {
          type: "object",
          required: ["release_token"],
          properties: {
            release_token: { type: "string", minLength: 16, maxLength: 256 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  request_id: { type: "string", format: "uuid" },
                  id_grupo_cita: { type: "string", format: "uuid" },
                  estado_final: { type: "string" },
                  liberado: { type: "boolean" },
                  idempotent: { type: "boolean" },
                  citas_canceladas: { type: "integer" },
                  holds_expirados: { type: "integer" },
                },
                required: ["id_grupo_cita", "estado_final", "liberado", "idempotent"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      const dbClient = await app.db.connect();
      let transactionStarted = false;
      try {
        const groupId = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
        const releaseToken = String(request.body?.release_token || "").trim();
        if (!releaseToken) {
          throw new AppError(400, "Debes enviar el token de liberacion de la reserva temporal", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_TOKEN_REQUIRED",
          });
        }

        await expireStaleAppointmentReservations(dbClient, { logger: request.log });
        const releaseTokenSupport = await getPublicHoldReleaseTokenSupport(dbClient);
        if (!releaseTokenSupport.supported) {
          throw new AppError(409, "La liberacion segura del hold publico no esta configurada", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_NOT_CONFIGURED",
          });
        }

        await dbClient.query("BEGIN");
        transactionStarted = true;

        const groupResult = await dbClient.query(
          `
            SELECT id_grupo_cita, estado_grupo_codigo, release_token_hash
            FROM public.citas_grupos
            WHERE id_grupo_cita = $1::uuid
            FOR UPDATE
          `,
          [groupId]
        );
        const group = groupResult.rows[0];
        if (!group) {
          throw new AppError(404, "No encontramos la reserva temporal indicada", {
            code: "PUBLIC_CITAS_HOLD_NOT_FOUND",
          });
        }
        if (!isPublicReleaseTokenValid(releaseToken, group.release_token_hash)) {
          throw new AppError(403, "No se pudo validar la reserva temporal publica", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_TOKEN_INVALID",
          });
        }

        const citasResult = await dbClient.query(
          `
            SELECT id_cita, estado_cita_codigo
            FROM public.citas
            WHERE id_grupo_cita = $1::uuid
              AND deleted_at IS NULL
            FOR UPDATE
          `,
          [groupId]
        );
        const citas = citasResult.rows;
        const rejectedState = citas.find((row) => (
          PUBLIC_RELEASE_REJECTED_APPOINTMENT_STATES.has(String(row.estado_cita_codigo || "").trim().toLowerCase())
        ));
        if (
          String(group.estado_grupo_codigo || "").trim().toLowerCase() === "completado"
          || rejectedState
        ) {
          throw new AppError(409, "La reserva temporal ya no puede liberarse", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_FINAL_STATE",
          });
        }

        const holdsResult = await dbClient.query(
          `
            SELECT h.id_hold, h.estado_hold_codigo
            FROM public.citas_holds h
            JOIN public.citas c
              ON c.id_cita = h.id_cita
            WHERE c.id_grupo_cita = $1::uuid
              AND c.deleted_at IS NULL
            FOR UPDATE OF h
          `,
          [groupId]
        );
        const hasConsumedHold = holdsResult.rows.some((row) => (
          String(row.estado_hold_codigo || "").trim().toLowerCase() === "consumido"
        ));
        const holdIds = holdsResult.rows.map((row) => row.id_hold).filter(Boolean);
        if (hasConsumedHold) {
          throw new AppError(409, "La reserva temporal ya no puede liberarse", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_CONSUMED",
          });
        }

        const cancelCitasResult = await dbClient.query(
          `
            UPDATE public.citas
            SET estado_cita_codigo = 'cancelada',
                updated_at = now()
            WHERE id_grupo_cita = $1::uuid
              AND deleted_at IS NULL
              AND estado_cita_codigo = ANY($2::text[])
          `,
          [groupId, PUBLIC_RELEASE_CANCELLABLE_APPOINTMENT_STATES]
        );
        const expireHoldsResult = await dbClient.query(
          `
            UPDATE public.citas_holds h
            SET estado_hold_codigo = 'expirado',
                updated_at = now()
            FROM public.citas c
            WHERE c.id_grupo_cita = $1::uuid
              AND c.id_cita = h.id_cita
              AND c.deleted_at IS NULL
              AND h.estado_hold_codigo = 'activo'
          `,
          [groupId]
        );
        await dbClient.query(
          `
            UPDATE public.citas_grupos
            SET estado_grupo_codigo = 'cancelado',
                updated_at = now()
            WHERE id_grupo_cita = $1::uuid
              AND estado_grupo_codigo <> 'cancelado'
          `,
          [groupId]
        );
        await dbClient.query(
          `
            UPDATE public.promociones_usos
            SET estado_uso_codigo = 'cancelado',
                liberado_at = COALESCE(liberado_at, now()),
                updated_at = now()
            WHERE (
                id_hold = ANY($2::uuid[])
                OR (id_hold IS NULL AND id_grupo_cita = $1::uuid)
              )
              AND estado_uso_codigo = 'reservado'
          `,
          [groupId, holdIds]
        );
        await dbClient.query("COMMIT");
        transactionStarted = false;

        const citasCanceladas = Number(cancelCitasResult.rowCount || 0);
        const holdsExpirados = Number(expireHoldsResult.rowCount || 0);
        return sendOk(reply, {
          id_grupo_cita: groupId,
          estado_final: "cancelado",
          liberado: true,
          idempotent: citasCanceladas === 0 && holdsExpirados === 0,
          citas_canceladas: citasCanceladas,
          holds_expirados: holdsExpirados,
        });
      } catch (error) {
        if (transactionStarted) {
          try {
            await dbClient.query("ROLLBACK");
          } catch {
            // no-op
          }
        }
        return sendHandled(reply, request, error, "No se pudo liberar el hold publico", "PUBLIC_CITAS_HOLD_RELEASE_ERROR");
      } finally {
        if (dbClient) dbClient.release();
      }
    }
  );
}
