import { randomUUID } from "node:crypto";
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
  if (percentage <= 0 || incluyeIsv) return 0;
  return normalizeMoney((taxableBase * percentage) / 100);
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
  origenItemCodigo = "servicio_manual",
} = {}) {
  const grouped = new Map();
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    const serviceId = String(item?.id_servicio || "").trim();
    if (!serviceId) continue;
    if (!grouped.has(serviceId)) {
      grouped.set(serviceId, {
        id_servicio: serviceId,
        id_tarifa: item?.id_tarifa || null,
        cantidad: 0,
        duracion_min: Math.max(1, Math.trunc(Number(item?.duracion_min || 0))),
        buffer_min: Math.max(0, Math.trunc(Number(item?.buffer_min || 0))),
        nombre_servicio_snapshot: String(item?.nombre_servicio || "Servicio").trim() || "Servicio",
        precio_referencia_hnl: normalizeMoney(item?.precio_hnl),
        precio_unitario_hnl: normalizeMoney(item?.precio_hnl),
        incluye_isv: item?.incluye_isv === true,
        isv_porcentaje: normalizePercentage(item?.isv_porcentaje),
        subtotal_hnl: 0,
        descuento_hnl: 0,
        isv_hnl: 0,
        total_linea_hnl: 0,
        origen_item_codigo: origenItemCodigo,
      });
    }
    const row = grouped.get(serviceId);
    row.cantidad += 1;
    row.subtotal_hnl = normalizeMoney(row.precio_unitario_hnl * row.cantidad);
  }

  const rows = [...grouped.values()];
  const subtotal = normalizeMoney(rows.reduce((sum, row) => sum + row.subtotal_hnl, 0));
  let remainingDiscount = Math.min(normalizeMoney(descuentoTotalHnl), subtotal);
  rows.forEach((row, index) => {
    const discount = index === rows.length - 1
      ? remainingDiscount
      : normalizeMoney(subtotal > 0 ? (normalizeMoney(descuentoTotalHnl) * row.subtotal_hnl) / subtotal : 0);
    row.descuento_hnl = normalizeMoney(Math.max(0, Math.min(discount, remainingDiscount, row.subtotal_hnl)));
    remainingDiscount = normalizeMoney(Math.max(0, remainingDiscount - row.descuento_hnl));
    row.isv_hnl = calculateLineIsv({
      subtotalHnl: row.subtotal_hnl,
      descuentoHnl: row.descuento_hnl,
      isvPorcentaje: row.isv_porcentaje,
      incluyeIsv: row.incluye_isv,
    });
    row.total_linea_hnl = normalizeMoney(Math.max(0, row.subtotal_hnl - row.descuento_hnl + row.isv_hnl));
  });

  return rows;
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

export async function insertAppointmentDetails(client, { citaId, serviceItems, descuentoTotalHnl = 0 }) {
  const rows = buildAppointmentDetailRows(serviceItems, { descuentoTotalHnl });
  for (const row of rows) {
    await client.query(
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
          isv_porcentaje,
          isv_hnl,
          total_linea_hnl,
          origen_item_codigo
        )
        VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::int, $7::text,
          $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::numeric,
          $13::numeric, $14::numeric, $15::text
        )
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
        row.isv_porcentaje,
        row.isv_hnl,
        row.total_linea_hnl,
        row.origen_item_codigo,
      ]
    );
  }
  return rows;
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
  updateGroupTotalHnl = null,
} = {}) {
  if (!appointment?.selection) {
    throw new TypeError("appointment.selection es obligatorio");
  }

  const createdAppointment = await createAppointmentCore(client, appointment);
  const citaId = createdAppointment.id_cita;
  const serviceItems = appointment.selection?.serviceSelection?.items || [];
  const detailRows = await insertAppointmentDetails(client, {
    citaId,
    serviceItems,
    descuentoTotalHnl: appointment.descuentoHnl || 0,
  });
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
    hold: holdRecord,
  };
}
