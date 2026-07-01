import { randomUUID } from "node:crypto";
import { resolveBookingIsvEnabled } from "../config/bookingConfig.js";
import {
  buildCanonicalLineKey,
  buildDiscountPlan,
  normalizeMoney as normalizeDiscountMoney,
} from "./bookingDiscounts.js";
import { recordPromotionApplications } from "./promociones/promocionesService.js";
import { AppError } from "../utils/errors.js";

function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function normalizePercentage(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Number(parsed.toFixed(2));
}

function calculateLineIsv({ subtotalHnl, descuentoHnl, isvPorcentaje, incluyeIsv }) {
  const taxableBase = normalizeMoney(Math.max(0, Number(subtotalHnl || 0) - Number(descuentoHnl || 0)));
  const percentage = normalizePercentage(isvPorcentaje);
  if (percentage <= 0) return 0;
  if (incluyeIsv) {
    return normalizeMoney(taxableBase - (taxableBase / (1 + (percentage / 100))));
  }
  return normalizeMoney((taxableBase * percentage) / 100);
}

function calculateLineTotal({ subtotalHnl, descuentoHnl, isvHnl, incluyeIsv }) {
  const taxableBase = normalizeMoney(Math.max(0, Number(subtotalHnl || 0) - Number(descuentoHnl || 0)));
  return normalizeMoney(Math.max(0, taxableBase + (incluyeIsv ? 0 : Number(isvHnl || 0))));
}

export function calculateReservationTiming(selection) {
  const startDateTime = selection?.startDateTime instanceof Date
    ? selection.startDateTime
    : new Date(selection?.startDateTime || "");
  if (Number.isNaN(startDateTime.getTime())) {
    throw new TypeError("startDateTime invalido para reserva");
  }

  const serviceSelection = selection?.serviceSelection || selection || {};
  const durationMin = Math.max(0, Math.trunc(Number(serviceSelection.duracion_total_min || 0)));
  const bufferMin = Math.max(0, Math.trunc(Number(serviceSelection.buffer_total_min || 0)));
  const totalMin = durationMin + bufferMin;

  return {
    inicio_at: startDateTime.toISOString(),
    fin_at: new Date(startDateTime.getTime() + totalMin * 60 * 1000).toISOString(),
    duracion_total_min: durationMin,
    buffer_total_min: bufferMin,
    duracion_con_buffer_min: totalMin,
  };
}

export function assertBookingSelectionCreationSupported(selectionType) {
  const normalized = String(selectionType || "services").trim().toLowerCase();
  if (normalized === "package" || normalized === "mixed") {
    throw new AppError(409, "El flujo de paquetes/mixed sera habilitado en Microfase 2B.", {
      code: "BOOKING_PACKAGE_FLOW_PENDING_2B",
    });
  }
  return normalized || "services";
}

export function buildAppointmentDetailRows(serviceItems = [], {
  descuentoTotalHnl = 0,
  discountPlan = null,
  origenItemCodigo = "servicio_manual",
  ordenIntegrante = 1,
  bookingIsvEnabled = resolveBookingIsvEnabled(),
} = {}) {
  const isvEnabled = bookingIsvEnabled === true;
  const grouped = new Map();
  const occurrenceByGroup = new Map();
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    const serviceId = String(item?.id_servicio || "").trim();
    if (!serviceId) continue;
    const tariffId = item?.id_tarifa || null;
    const originCode = item?.origen_item_codigo || origenItemCodigo;
    const groupKey = [serviceId, tariffId || "sin_tarifa", originCode].join("|");
    if (!grouped.has(groupKey)) {
      const occurrenceKey = [
        Math.max(1, Math.trunc(Number(ordenIntegrante || 1))),
        serviceId,
        tariffId || "sin_tarifa",
        originCode,
      ].join("|");
      const occurrence = (occurrenceByGroup.get(occurrenceKey) || 0) + 1;
      occurrenceByGroup.set(occurrenceKey, occurrence);
      grouped.set(groupKey, {
        line_key: item?.line_key || buildCanonicalLineKey({
          orden_integrante: ordenIntegrante,
          id_servicio: serviceId,
          id_tarifa: tariffId,
          origen_item_codigo: originCode,
          occurrence,
        }),
        id_servicio: serviceId,
        id_tarifa: tariffId,
        cantidad: 0,
        duracion_min: Math.max(1, Math.trunc(Number(item?.duracion_min || 0))),
        buffer_min: Math.max(0, Math.trunc(Number(item?.buffer_min || 0))),
        nombre_servicio_snapshot: String(item?.nombre_servicio || "Servicio").trim() || "Servicio",
        precio_referencia_hnl: normalizeMoney(item?.precio_hnl),
        precio_unitario_hnl: normalizeMoney(item?.precio_hnl),
        incluye_isv_snapshot: isvEnabled && (item?.incluye_isv_snapshot === true || item?.incluye_isv === true),
        isv_porcentaje: isvEnabled ? normalizePercentage(item?.isv_porcentaje) : 0,
        subtotal_hnl: 0,
        descuento_hnl: 0,
        isv_hnl: 0,
        total_linea_hnl: 0,
        origen_item_codigo: originCode,
      });
    }
    const row = grouped.get(groupKey);
    row.cantidad += 1;
    row.subtotal_hnl = normalizeMoney(row.precio_unitario_hnl * row.cantidad);
  }

  const rows = [...grouped.values()];
  const subtotal = normalizeMoney(rows.reduce((sum, row) => sum + row.subtotal_hnl, 0));
  const planByLine = discountPlan instanceof Map
    ? discountPlan
    : (discountPlan ? buildDiscountPlan(rows, Object.values(discountPlan).flatMap((entry) => entry.allocations || [])) : null);
  let remainingDiscount = Math.min(normalizeMoney(descuentoTotalHnl), subtotal);
  rows.forEach((row, index) => {
    if (planByLine) {
      row.descuento_hnl = normalizeMoney(planByLine.get(row.line_key)?.descuento_total_hnl || 0);
    } else {
      const discount = index === rows.length - 1
        ? remainingDiscount
        : normalizeMoney(subtotal > 0 ? (normalizeMoney(descuentoTotalHnl) * row.subtotal_hnl) / subtotal : 0);
      row.descuento_hnl = normalizeMoney(Math.max(0, Math.min(discount, remainingDiscount, row.subtotal_hnl)));
      remainingDiscount = normalizeMoney(Math.max(0, remainingDiscount - row.descuento_hnl));
    }
    if (row.descuento_hnl > row.subtotal_hnl) {
      throw new AppError(409, "El descuento supera el subtotal de la linea", {
        code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
      });
    }
    row.isv_hnl = calculateLineIsv({
      subtotalHnl: row.subtotal_hnl,
      descuentoHnl: row.descuento_hnl,
      isvPorcentaje: row.isv_porcentaje,
      incluyeIsv: row.incluye_isv_snapshot,
    });
    row.total_linea_hnl = calculateLineTotal({
      subtotalHnl: row.subtotal_hnl,
      descuentoHnl: row.descuento_hnl,
      isvHnl: row.isv_hnl,
      incluyeIsv: row.incluye_isv_snapshot,
    });
  });

  if (planByLine) {
    const assigned = normalizeMoney(rows.reduce((sum, row) => sum + Number(row.descuento_hnl || 0), 0));
    const requested = normalizeDiscountMoney([...planByLine.values()].reduce((sum, row) => sum + Number(row.descuento_total_hnl || 0), 0));
    if (assigned !== requested) {
      throw new AppError(409, "La suma de descuentos por linea no coincide con el plan canonico", {
        code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
      });
    }
  }

  return rows;
}

export function summarizeAppointmentDetailRows(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  return {
    subtotalHnl: normalizeMoney(source.reduce((sum, row) => sum + Number(row.subtotal_hnl || 0), 0)),
    descuentoHnl: normalizeMoney(source.reduce((sum, row) => sum + Number(row.descuento_hnl || 0), 0)),
    isvHnl: normalizeMoney(source.reduce((sum, row) => sum + Number(row.isv_hnl || 0), 0)),
    totalHnl: normalizeMoney(source.reduce((sum, row) => sum + Number(row.total_linea_hnl || 0), 0)),
  };
}

export async function createBookingGroup(client, {
  idSucursal,
  idPersonaTitular = null,
  idClienteTitular = null,
  idUsuarioTitular = null,
  origenCodigo,
  notas = null,
}) {
  const codigoReserva = `MF${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const result = await client.query(
    `
      INSERT INTO public.citas_grupos (
        id_sucursal,
        id_persona_titular,
        id_cliente_titular,
        id_usuario_titular,
        origen_codigo,
        codigo_reserva,
        estado_grupo_codigo,
        notas
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, 'activo', $7)
      RETURNING id_grupo_cita, estado_grupo_codigo
    `,
    [idSucursal, idPersonaTitular, idClienteTitular, idUsuarioTitular, origenCodigo, codigoReserva, notas]
  );
  return result.rows[0];
}

export async function updateBookingGroupTotal(client, { idGrupoCita, totalHnl }) {
  await client.query(
    `
      UPDATE public.citas_grupos
      SET total_hnl = $2::numeric,
          updated_at = now()
      WHERE id_grupo_cita = $1::uuid
    `,
    [idGrupoCita, normalizeMoney(totalHnl)]
  );
}

export async function createAppointmentCore(client, {
  groupId = null,
  order = null,
  alias = null,
  branchId,
  barberId,
  personId,
  clientId = null,
  createdByUserId = null,
  autoAssigned = false,
  state = "en_espera",
  selection,
  subtotalHnl,
  descuentoHnl = 0,
  totalHnl = null,
  isRewardRedeem = false,
  contactName = null,
  contactEmail = null,
  contactPhone = null,
  notes = null,
}) {
  const timing = calculateReservationTiming(selection);
  const serviceSelection = selection.serviceSelection;
  const subtotal = normalizeMoney(subtotalHnl ?? serviceSelection.monto_total_hnl);
  const discount = normalizeMoney(descuentoHnl);
  const total = normalizeMoney(totalHnl ?? Math.max(0, subtotal - discount));
  const result = await client.query(
    `
      INSERT INTO public.citas (
        id_grupo_cita,
        orden_integrante,
        alias_integrante,
        id_sucursal,
        id_empleado_barbero,
        id_persona_cliente,
        id_cliente,
        creada_por_usuario_id,
        asignada_automaticamente,
        estado_cita_codigo,
        inicio_at,
        fin_at,
        duracion_total_min,
        buffer_total_min,
        subtotal_servicios_hnl,
        descuento_hnl,
        total_pagar_hnl,
        es_canje_recompensa,
        selection_type,
        id_paquete,
        contacto_nombre,
        contacto_email,
        contacto_telefono,
        notas
      )
      VALUES (
        $1::uuid, $2::int, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
        $8::uuid, $9::boolean, $10::text, $11::timestamptz, $12::timestamptz,
        $13::int, $14::int, $15::numeric, $16::numeric, $17::numeric,
        $18::boolean, $19::text, $20::uuid, $21, $22, $23, $24
      )
      RETURNING id_cita
    `,
    [
      groupId,
      order,
      alias,
      branchId,
      barberId,
      personId,
      clientId,
      createdByUserId,
      autoAssigned,
      state,
      timing.inicio_at,
      timing.fin_at,
      timing.duracion_total_min,
      timing.buffer_total_min,
      subtotal,
      discount,
      total,
      isRewardRedeem,
      serviceSelection.selection_type || "services",
      serviceSelection.id_paquete || null,
      contactName,
      contactEmail,
      contactPhone,
      notes,
    ]
  );
  return { id_cita: result.rows[0].id_cita, timing };
}

export async function insertAppointmentDetails(
  client,
  { citaId, serviceItems, descuentoTotalHnl = 0, detailRows = null, bookingIsvEnabled = resolveBookingIsvEnabled() }
) {
  const rows = Array.isArray(detailRows)
    ? detailRows
    : buildAppointmentDetailRows(serviceItems, { descuentoTotalHnl, bookingIsvEnabled });
  const insertedRows = [];
  for (const row of rows) {
    const result = await client.query(
      `
        INSERT INTO public.citas_detalles (
          id_cita,
          id_servicio,
          id_tarifa,
          cantidad,
          duracion_min,
          buffer_min,
          nombre_servicio_snapshot,
          precio_referencia_hnl,
          precio_unitario_hnl,
          subtotal_hnl,
          descuento_hnl,
          incluye_isv_snapshot,
          isv_porcentaje,
          isv_hnl,
          total_linea_hnl,
          origen_item_codigo
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::int, $7::text,
          $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::boolean,
          $13::numeric, $14::numeric, $15::numeric, $16::text
        )
        RETURNING id_cita_detalle
      `,
      [
        citaId,
        row.id_servicio,
        row.id_tarifa,
        row.cantidad,
        row.duracion_min,
        row.buffer_min,
        row.nombre_servicio_snapshot,
        row.precio_referencia_hnl,
        row.precio_unitario_hnl,
        row.subtotal_hnl,
        row.descuento_hnl,
        row.incluye_isv_snapshot,
        row.isv_porcentaje,
        row.isv_hnl,
        row.total_linea_hnl,
        row.origen_item_codigo,
      ]
    );
    insertedRows.push({
      ...row,
      id_cita_detalle: result.rows?.[0]?.id_cita_detalle || row.id_cita_detalle || null,
    });
  }
  return insertedRows;
}

export async function createAppointmentHold(client, {
  citaId,
  userId = null,
  state = "activo",
  expiresAt,
  returning = false,
}) {
  const result = await client.query(
    `
      INSERT INTO public.citas_holds (
        id_cita,
        id_usuario,
        estado_hold_codigo,
        expires_at
      )
      VALUES ($1::uuid, $2::uuid, $3::text, $4::timestamptz)
      ${returning ? "RETURNING id_hold, expires_at" : ""}
    `,
    [citaId, userId, state, expiresAt]
  );
  return returning ? result.rows[0] : null;
}

export async function createBookingReservation(client, {
  groupRecord = null,
  appointment,
  hold = null,
  promotions = null,
  discountPlan = null,
  updateGroupTotalHnl = null,
  bookingIsvEnabled = resolveBookingIsvEnabled(),
} = {}) {
  if (!appointment?.selection) {
    throw new TypeError("appointment.selection es obligatorio");
  }

  const serviceItems = appointment.selection?.serviceSelection?.items || [];
  const preparedDetailRows = buildAppointmentDetailRows(serviceItems, {
    descuentoTotalHnl: appointment.descuentoHnl || 0,
    discountPlan,
    ordenIntegrante: appointment.order || 1,
    bookingIsvEnabled,
  });
  const detailTotals = summarizeAppointmentDetailRows(preparedDetailRows);
  const createdAppointment = await createAppointmentCore(client, {
    ...appointment,
    subtotalHnl: detailTotals.subtotalHnl,
    descuentoHnl: detailTotals.descuentoHnl,
    totalHnl: detailTotals.totalHnl,
  });
  const citaId = createdAppointment.id_cita;
  const detailRows = await insertAppointmentDetails(client, {
    citaId,
    serviceItems,
    descuentoTotalHnl: appointment.descuentoHnl || 0,
    detailRows: preparedDetailRows,
    bookingIsvEnabled,
  });
  if (promotions?.result) {
    await recordPromotionApplications(
      client,
      {
        ...(promotions.context || {}),
        id_grupo_cita: promotions.context?.id_grupo_cita || groupRecord?.id_grupo_cita || appointment.groupId || null,
        id_cita: promotions.context?.id_cita || citaId,
        id_cliente: promotions.context?.id_cliente || appointment.clientId || null,
        id_persona: promotions.context?.id_persona || appointment.personId || null,
        detailRows,
        discountPlan,
        serviceItems,
      },
      promotions.result,
      { formal: promotions.formal === true, usageState: promotions.usageState || null }
    );
  }
  const holdRecord = hold
    ? await createAppointmentHold(client, {
        citaId,
        ...hold,
      })
    : null;

  if (groupRecord?.id_grupo_cita && updateGroupTotalHnl != null) {
    await updateBookingGroupTotal(client, {
      idGrupoCita: groupRecord.id_grupo_cita,
      totalHnl: updateGroupTotalHnl,
    });
  }

  return {
    appointment: createdAppointment,
    citaId,
    detailRows,
    totals: detailTotals,
    hold: holdRecord,
  };
}
