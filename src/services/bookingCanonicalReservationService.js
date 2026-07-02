import crypto from "node:crypto";
import { AppError } from "../utils/errors.js";
import { buildAppointmentDetailRows, summarizeAppointmentDetailRows } from "./bookingReservationService.js";

export function toCents(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_EXCLUDED_KEYS = new Set(["release_token", "release_token_hash"]);
const IDEMPOTENCY_COMPLETED = "completed";
const IDEMPOTENCY_NOT_FOUND = "not_found";
const IDEMPOTENCY_INCOMPLETE = "incomplete";
const IDEMPOTENCY_PAYLOAD_MISMATCH = "payload_mismatch";

export function parseReservationIdempotencyKey(value = null) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!UUID_PATTERN.test(text)) {
    throw new AppError(400, "x-idempotency-key debe ser un UUID valido", {
      code: "BOOKING_IDEMPOTENCY_KEY_INVALID",
    });
  }
  return text;
}

export function resolveReservationRequestId(value = null) {
  return parseReservationIdempotencyKey(value) || crypto.randomUUID();
}

function normalizeFingerprintValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFingerprintValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => !FINGERPRINT_EXCLUDED_KEYS.has(key))
      .sort()
      .reduce((acc, key) => {
        const normalized = normalizeFingerprintValue(value[key]);
        if (normalized !== undefined) acc[key] = normalized;
        return acc;
      }, {});
  }
  if (value === undefined) return undefined;
  return value;
}

export function buildReservationRequestFingerprint({ scope, actor, body } = {}) {
  const canonicalPayload = normalizeFingerprintValue({
    scope: String(scope || "").trim(),
    actor: actor || null,
    body: body || null,
  });
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
}

function normalizeIdempotencyResponsePayload(rawPayload = null) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return { statusCode: 201, data: rawPayload || null };
  }
  if (rawPayload.data && typeof rawPayload.data === "object") {
    return {
      statusCode: Number(rawPayload.status_code || rawPayload.statusCode || 201),
      data: rawPayload.data,
    };
  }
  return { statusCode: Number(rawPayload.status_code || rawPayload.statusCode || 201), data: rawPayload };
}

export async function getReservationIdempotencyState(client, {
  requestId,
  scope,
  requestFingerprint,
} = {}) {
  const result = await client.query(
    `
      SELECT app_private.obtener_reserva_idempotente_v1(
        $1::uuid,
        $2::text,
        $3::text
      ) AS estado
    `,
    [requestId, scope, requestFingerprint]
  );
  const state = result.rows?.[0]?.estado || {};
  const status = String(state.status || state.estado || IDEMPOTENCY_NOT_FOUND).trim().toLowerCase();
  if (status === IDEMPOTENCY_COMPLETED) {
    return {
      status,
      ...normalizeIdempotencyResponsePayload(state.response_payload ?? state.payload ?? null),
    };
  }
  return { status };
}

export async function finalizeReservationIdempotency(client, {
  requestId,
  scope,
  requestFingerprint,
  responsePayload,
  statusCode = 201,
} = {}) {
  await client.query(
    `
      SELECT app_private.finalizar_reserva_idempotente_v1(
        $1::uuid,
        $2::text,
        $3::text,
        $4::jsonb
      )
    `,
    [
      requestId,
      scope,
      requestFingerprint,
      {
        status_code: statusCode,
        data: responsePayload || null,
      },
    ]
  );
}

export function assertKnownIdempotencyState(state = {}) {
  const status = String(state?.status || "").trim().toLowerCase();
  if ([IDEMPOTENCY_NOT_FOUND, IDEMPOTENCY_COMPLETED].includes(status)) return status;
  if (status === IDEMPOTENCY_PAYLOAD_MISMATCH) {
    throw new AppError(409, "La clave de idempotencia ya fue usada con otro payload", {
      code: "BOOKING_IDEMPOTENCY_PAYLOAD_MISMATCH",
    });
  }
  if (status === IDEMPOTENCY_INCOMPLETE) {
    throw new AppError(409, "La reserva con esta clave de idempotencia todavia esta en proceso", {
      code: "BOOKING_IDEMPOTENCY_INCOMPLETE",
    });
  }
  return status || IDEMPOTENCY_NOT_FOUND;
}

export function buildDeterministicPublicReleaseToken(requestId, secret) {
  const normalizedRequestId = parseReservationIdempotencyKey(requestId);
  const normalizedSecret = String(secret || "").trim();
  if (!normalizedSecret) {
    throw new AppError(500, "BOOKING_RELEASE_TOKEN_SECRET no esta configurado", {
      code: "BOOKING_RELEASE_TOKEN_SECRET_REQUIRED",
    });
  }
  return crypto
    .createHmac("sha256", normalizedSecret)
    .update(`masterfade:public-hold:${normalizedRequestId}`, "utf8")
    .digest("hex");
}

export function buildAssignmentAttemptsFromIntegrantes(integrantes = [], { maxAttempts = 64 } = {}) {
  const source = Array.isArray(integrantes) ? integrantes : [];
  const optionGroups = source.map((integrante) => {
    const explicitBarber = String(integrante?.id_empleado_barbero || "").trim();
    if (explicitBarber) return [{ ...integrante, barber_candidate_ids: [], id_empleado_barbero: explicitBarber }];
    const candidateIds = Array.from(new Set(
      (Array.isArray(integrante?.barber_candidate_ids) ? integrante.barber_candidate_ids : [])
        .map((id) => String(id || "").trim())
        .filter((id) => UUID_PATTERN.test(id))
    )).slice(0, 6);
    const fallback = String(integrante?.selection?.barber?.id_empleado || "").trim();
    const resolvedCandidates = candidateIds.length ? candidateIds : (UUID_PATTERN.test(fallback) ? [fallback] : []);
    return resolvedCandidates.map((id) => ({
      ...integrante,
      id_empleado_barbero: id,
      barber_candidate_ids: [],
    }));
  });

  const attempts = [];
  const walk = (index, selected) => {
    if (attempts.length > maxAttempts) return;
    if (index >= optionGroups.length) {
      const occupied = new Set();
      for (const integrante of selected) {
        const barberId = String(integrante?.id_empleado_barbero || "").trim();
        const start = String(integrante?.inicio_at || "").trim();
        const key = `${barberId}:${start}`;
        if (barberId && start && occupied.has(key)) return;
        occupied.add(key);
      }
      attempts.push({ integrantes: selected });
      return;
    }
    for (const option of optionGroups[index] || []) {
      walk(index + 1, selected.concat(option));
    }
  };
  walk(0, []);
  if (attempts.length > maxAttempts) {
    throw new AppError(409, "Demasiadas combinaciones de autoasignacion para evaluar", {
      code: "BOOKING_ASSIGNMENT_COMBINATIONS_LIMIT",
    });
  }
  return attempts;
}

function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function normalizeDetails(detailRows = []) {
  return (Array.isArray(detailRows) ? detailRows : []).map((row, index) => ({
    line_key: row.line_key || null,
    orden_linea: Math.max(1, Math.trunc(Number(row.orden_linea || index + 1))),
    id_servicio: row.id_servicio,
    id_tarifa: row.id_tarifa || null,
    cantidad: Math.max(1, Math.trunc(Number(row.cantidad || 1))),
    duracion_min: Math.max(1, Math.trunc(Number(row.duracion_min || 0))),
    buffer_min: Math.max(0, Math.trunc(Number(row.buffer_min || 0))),
    nombre_servicio_snapshot: String(row.nombre_servicio_snapshot || row.nombre_servicio || "Servicio").trim(),
    precio_referencia_hnl: normalizeMoney(row.precio_referencia_hnl ?? row.precio_unitario_hnl),
    precio_unitario_hnl: normalizeMoney(row.precio_unitario_hnl),
    descuento_hnl: normalizeMoney(row.descuento_hnl),
    incluye_isv_snapshot: row.incluye_isv_snapshot === true,
    isv_porcentaje: normalizeMoney(row.isv_porcentaje),
    origen_item_codigo: String(row.origen_item_codigo || "servicio_manual").trim(),
  }));
}

export function buildCanonicalReservationPayload({
  requestId,
  idSucursal,
  idPersonaTitular = null,
  idClienteTitular = null,
  idUsuarioTitular = null,
  origenCodigo = "publico",
  notas = null,
  releaseTokenHash = null,
  integrantes = [],
  assignmentAttempts = null,
  bookingIsvEnabled,
} = {}) {
  const request_id = resolveReservationRequestId(requestId);
  const normalizeIntegrantes = (sourceIntegrantes = []) => (Array.isArray(sourceIntegrantes) ? sourceIntegrantes : []).map((integrante, index) => {
    const selection = integrante.selection || {};
    const serviceItems = selection.serviceSelection?.items || integrante.serviceItems || [];
    const detailRows = Array.isArray(integrante.detailRows)
      ? integrante.detailRows
      : buildAppointmentDetailRows(serviceItems, {
          descuentoTotalHnl: integrante.descuentoHnl || 0,
          discountPlan: integrante.discountPlan || null,
          origenItemCodigo: integrante.origenItemCodigo || "servicio_manual",
          ordenIntegrante: integrante.orden_integrante || index + 1,
          bookingIsvEnabled,
        });
    const totals = summarizeAppointmentDetailRows(detailRows);
    return {
      orden_integrante: Math.max(1, Math.trunc(Number(integrante.orden_integrante || index + 1))),
      id_persona: integrante.id_persona || null,
      id_cliente: integrante.id_cliente || null,
      id_usuario: integrante.id_usuario || null,
      tipo_cliente_codigo: integrante.tipo_cliente_codigo || (integrante.id_usuario ? "autenticado" : "invitado"),
      alias: integrante.alias || null,
      contacto_nombre: integrante.contacto_nombre || null,
      contacto_email: integrante.contacto_email || null,
      contacto_telefono: integrante.contacto_telefono || null,
      id_empleado_barbero: integrante.id_empleado_barbero || null,
      barber_candidate_ids: Array.isArray(integrante.barber_candidate_ids)
        ? integrante.barber_candidate_ids.filter((id) => UUID_PATTERN.test(String(id || "").trim()))
        : [],
      asignada_automaticamente: integrante.asignada_automaticamente === true,
      es_canje_recompensa: integrante.es_canje_recompensa === true,
      selection_type: "services",
      inicio_at: integrante.inicio_at instanceof Date ? integrante.inicio_at.toISOString() : integrante.inicio_at,
      notas: integrante.notas || null,
      detalles: normalizeDetails(detailRows),
      _totals: totals,
    };
  });
  const canonicalIntegrantes = normalizeIntegrantes(integrantes);
  const canonicalAssignmentAttempts = Array.isArray(assignmentAttempts)
    ? assignmentAttempts.map((attempt) => ({
        integrantes: normalizeIntegrantes(attempt?.integrantes || []).map(({ _totals, ...integrante }) => integrante),
      })).filter((attempt) => attempt.integrantes.length > 0)
    : [];

  const payload = {
    request_id,
    id_sucursal: idSucursal,
    id_persona_titular: idPersonaTitular || null,
    id_cliente_titular: idClienteTitular || null,
    id_usuario_titular: idUsuarioTitular || null,
    origen_codigo: origenCodigo,
    notas: notas || null,
    release_token_hash: releaseTokenHash || null,
    integrantes: canonicalIntegrantes.map(({ _totals, ...integrante }) => integrante),
    _totals: canonicalIntegrantes.reduce((acc, integrante) => ({
      subtotal_hnl: normalizeMoney(acc.subtotal_hnl + integrante._totals.subtotalHnl),
      descuento_hnl: normalizeMoney(acc.descuento_hnl + integrante._totals.descuentoHnl),
      total_hnl: normalizeMoney(acc.total_hnl + integrante._totals.totalHnl),
    }), { subtotal_hnl: 0, descuento_hnl: 0, total_hnl: 0 }),
  };
  if (canonicalAssignmentAttempts.length > 0) {
    payload.assignment_attempts = canonicalAssignmentAttempts;
  }
  return payload;
}

export async function createCanonicalReservation(client, payload) {
  const result = await client.query(
    "SELECT app_private.crear_reserva_canonica_v1($1::jsonb) AS resultado",
    [payload]
  );
  return result.rows?.[0]?.resultado || null;
}

export async function loadCanonicalPromotionDetailRows(client, { idCita, detailRows = [] } = {}) {
  const sourceRows = Array.isArray(detailRows) ? detailRows : [];
  if (!idCita || !sourceRows.length) return sourceRows;
  const result = await client.query(
    `
      SELECT id_cita_detalle, line_key
      FROM public.citas_detalles
      WHERE id_cita = $1::uuid
      ORDER BY orden_linea ASC, line_key ASC
    `,
    [idCita]
  );
  const byLineKey = new Map(
    (result.rows || []).map((row) => [String(row.line_key || "").trim(), row.id_cita_detalle])
  );
  return sourceRows.map((row) => {
    const lineKey = String(row.line_key || "").trim();
    const detailId = lineKey ? byLineKey.get(lineKey) : null;
    if (!detailId) {
      throw new AppError(409, "No se pudo relacionar una promocion con su detalle canonico", {
        code: "BOOKING_PROMOTION_ALLOCATION_MISMATCH",
      });
    }
    return {
      ...row,
      id_cita: idCita,
      id_cita_detalle: detailId,
    };
  });
}

export async function confirmCanonicalPaidReservation(client, {
  idIntent,
  referenciaExterna = null,
  pagadoAt = null,
} = {}) {
  if (!pagadoAt) {
    throw new AppError(409, "paid_at es obligatorio para confirmar el pago de una reserva", {
      code: "PAYMENT_PAID_AT_REQUIRED",
    });
  }
  const result = await client.query(
    "SELECT app_private.confirmar_reserva_pagada_v1($1::uuid,$2::text,$3::timestamptz) AS resultado",
    [idIntent, referenciaExterna || null, pagadoAt]
  );
  return result.rows?.[0]?.resultado || null;
}

export function assertCanonicalTotalsMatch({ expected = {}, result = {}, context = {} } = {}) {
  const resultBlocks = Array.isArray(result?.bloques) ? result.bloques : [];
  const rpcSubtotal = resultBlocks.reduce((sum, row) => sum + toCents(row?.monto_total_hnl ?? row?.subtotal_hnl), 0);
  const rpcDiscount = resultBlocks.reduce((sum, row) => sum + toCents(row?.descuento_hnl), 0);
  const rpcTotal = toCents(result?.total_pagar_hnl ?? result?.total_hnl);
  if (
    rpcSubtotal !== toCents(expected.subtotal_hnl)
    || rpcDiscount !== toCents(expected.descuento_hnl)
    || rpcTotal !== toCents(expected.total_hnl)
  ) {
    throw new AppError(409, "Los totales de la reserva canonica no coinciden", {
      code: "BOOKING_CANONICAL_TOTAL_MISMATCH",
      details: {
        ...context,
        expected: {
          subtotal_cents: toCents(expected.subtotal_hnl),
          descuento_cents: toCents(expected.descuento_hnl),
          total_cents: toCents(expected.total_hnl),
        },
        rpc: {
          subtotal_cents: rpcSubtotal,
          descuento_cents: rpcDiscount,
          total_cents: rpcTotal,
        },
      },
    });
  }
  return true;
}

const ERROR_MAP = new Map([
  ["MF_SLOT_TAKEN", { statusCode: 409, publicCode: "PUBLIC_CITAS_HOLD_CONFLICT", privateCode: "CITAS_HOLD_CONFLICT" }],
  ["MF_RESERVA_PENDIENTE_EXISTENTE", { statusCode: 409, code: "CLIENT_PENDING_APPOINTMENT_EXISTS" }],
  ["MF_RESERVA_IDEMPOTENCY_PAYLOAD_MISMATCH", { statusCode: 409, code: "BOOKING_IDEMPOTENCY_PAYLOAD_MISMATCH" }],
  ["MF_RESERVA_IDEMPOTENCY_INCOMPLETE", { statusCode: 409, code: "BOOKING_IDEMPOTENCY_INCOMPLETE" }],
  ["BOOKING_IDEMPOTENCY_KEY_INVALID", { statusCode: 400, code: "BOOKING_IDEMPOTENCY_KEY_INVALID" }],
  ["BOOKING_ASSIGNMENT_COMBINATIONS_LIMIT", { statusCode: 409, code: "BOOKING_ASSIGNMENT_COMBINATIONS_LIMIT" }],
  ["BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE", { statusCode: 409, code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE" }],
  ["BOOKING_PROMOTION_ALLOCATION_MISMATCH", { statusCode: 409, code: "BOOKING_PROMOTION_ALLOCATION_MISMATCH" }],
  ["MF_RESERVA_COMPANION_DATE_MISMATCH", { statusCode: 409, code: "MF_RESERVA_COMPANION_DATE_MISMATCH" }],
  ["AGENDA_DATETIME_TIMEZONE_REQUIRED", { statusCode: 400, code: "AGENDA_DATETIME_TIMEZONE_REQUIRED" }],
  ["MF_PAYMENT_AFTER_HOLD_EXPIRY", { statusCode: 409, code: "PAYMENT_HOLD_EXPIRED" }],
  ["MF_PAYMENT_SLOT_ALREADY_RELEASED", { statusCode: 409, code: "PAYMENT_SLOT_ALREADY_RELEASED" }],
  ["MF_PAYMENT_AMOUNT_MISMATCH", { statusCode: 409, code: "PAYMENT_AMOUNT_MISMATCH" }],
  ["PAYMENT_PAID_AT_REQUIRED", { statusCode: 409, code: "PAYMENT_PAID_AT_REQUIRED" }],
  ["BOOKING_CANONICAL_TOTAL_MISMATCH", { statusCode: 409, code: "BOOKING_CANONICAL_TOTAL_MISMATCH" }],
]);

export function mapCanonicalReservationError(error, context = {}) {
  if (error instanceof AppError) return error;
  const haystack = [
    error?.code,
    error?.message,
    error?.detail,
    error?.hint,
    error?.where,
    error?.cause?.message,
    error?.cause?.detail,
  ].map((value) => String(value || "")).join("\n");
  const pgMessage = [...ERROR_MAP.keys()].find((code) => haystack.includes(code));
  const mapped = ERROR_MAP.get(pgMessage);
  if (!mapped) return error;
  const code = mapped.code || (context.publicRoute ? mapped.publicCode : mapped.privateCode);
  return new AppError(mapped.statusCode, context.safeMessage || "No se pudo completar la operacion canonica", {
    code,
    details: {
      rpc_code: pgMessage,
      ...(context.details || {}),
    },
  });
}
