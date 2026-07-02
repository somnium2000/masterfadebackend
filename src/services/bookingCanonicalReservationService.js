import crypto from "node:crypto";
import { AppError } from "../utils/errors.js";
import { buildAppointmentDetailRows, summarizeAppointmentDetailRows } from "./bookingReservationService.js";

export function toCents(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function normalizeDetails(detailRows = []) {
  return (Array.isArray(detailRows) ? detailRows : []).map((row) => ({
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
  bookingIsvEnabled,
} = {}) {
  const request_id = resolveReservationRequestId(requestId);
  const canonicalIntegrantes = (Array.isArray(integrantes) ? integrantes : []).map((integrante, index) => {
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

  return {
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
      SELECT id_cita_detalle
      FROM public.citas_detalles
      WHERE id_cita = $1::uuid
        AND deleted_at IS NULL
      ORDER BY created_at ASC, id_cita_detalle ASC
    `,
    [idCita]
  );
  return sourceRows.map((row, index) => ({
    ...row,
    id_cita: idCita,
    id_cita_detalle: result.rows?.[index]?.id_cita_detalle || row.id_cita_detalle || null,
  }));
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
  ["MF_RESERVA_COMPANION_DATE_MISMATCH", { statusCode: 409, code: "MF_RESERVA_COMPANION_DATE_MISMATCH" }],
  ["AGENDA_DATETIME_TIMEZONE_REQUIRED", { statusCode: 400, code: "AGENDA_DATETIME_TIMEZONE_REQUIRED" }],
  ["MF_PAYMENT_AFTER_HOLD_EXPIRY", { statusCode: 409, code: "PAYMENT_HOLD_EXPIRED" }],
  ["MF_PAYMENT_SLOT_ALREADY_RELEASED", { statusCode: 409, code: "PAYMENT_SLOT_ALREADY_RELEASED" }],
  ["MF_PAYMENT_AMOUNT_MISMATCH", { statusCode: 409, code: "PAYMENT_AMOUNT_MISMATCH" }],
  ["PAYMENT_PAID_AT_REQUIRED", { statusCode: 409, code: "PAYMENT_PAID_AT_REQUIRED" }],
  ["BOOKING_CANONICAL_TOTAL_MISMATCH", { statusCode: 409, code: "BOOKING_CANONICAL_TOTAL_MISMATCH" }],
  ["BOOKING_PROMOTION_ALLOCATION_MISMATCH", { statusCode: 409, code: "BOOKING_PROMOTION_ALLOCATION_MISMATCH" }],
]);

export function mapCanonicalReservationError(error, context = {}) {
  if (error instanceof AppError) return error;
  const haystack = [
    error?.message,
    error?.detail,
    error?.hint,
    error?.cause?.message,
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
