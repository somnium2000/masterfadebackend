import crypto from "node:crypto";
import { AppError } from "../utils/errors.js";
import {
  getAgendamientoConfig,
  resolveBookingSelection,
} from "./agendaService.js";
import { validarYAplicarPromocionesAgendamiento } from "./agendamientoPromocionesService.js";
import { crearComprobanteAgendamientoNoFiscal } from "./comprobanteAgendamientoService.js";
import { calcularCoberturaCanjeSobreSeleccion } from "./agendamientoBeneficiosService.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  const safe = String(value || "").trim();
  return safe || null;
}

function normalizePromotionSelection(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    const normalized = normalizeText(item);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function splitGuestFullName(rawValue) {
  const normalized = String(rawValue || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { nombres: "Cliente", apellidos: "Invitado" };
  }
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 1) {
    return { nombres: tokens[0], apellidos: "Invitado" };
  }
  return {
    nombres: tokens.slice(0, -1).join(" "),
    apellidos: tokens[tokens.length - 1],
  };
}

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

const NORMALIZED_DETAIL_ORIGINS = new Set([
  "servicio_manual",
  "servicio_extra",
  "paquete_incluido",
]);

function parseNonNegativeMoney(value, { field, code = "BOOKING_DETAIL_AMOUNT_INVALID" } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(409, "No fue posible calcular los montos de la reserva.", {
      code,
      details: { field },
    });
  }
  return roundMoney(parsed);
}

function parseDurationMinutes(value, { field, code = "BOOKING_DETAIL_AMOUNT_INVALID" } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(409, "No fue posible calcular los montos de la reserva.", {
      code,
      details: { field },
    });
  }
  return parsed;
}

function parseBufferMinutes(value, { field, code = "BOOKING_DETAIL_AMOUNT_INVALID" } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(409, "No fue posible calcular los montos de la reserva.", {
      code,
      details: { field },
    });
  }
  return parsed;
}

function getPromotionDiscountByDetail(promocionesResult) {
  const discountByDetail = new Map();
  for (const app of Array.isArray(promocionesResult?.aplicaciones) ? promocionesResult.aplicaciones : []) {
    const detailId = normalizeText(app?.id_cita_detalle);
    if (!detailId) continue;
    const current = Number(discountByDetail.get(detailId) || 0);
    discountByDetail.set(detailId, roundMoney(current + Number(app?.descuento_hnl || 0)));
  }
  return discountByDetail;
}

function getServiceNameFromSelection(normalizedSelection, serviceId) {
  const targetId = normalizeText(serviceId);
  if (!targetId) return "Servicio";
  const details = Array.isArray(normalizedSelection?.detalles) ? normalizedSelection.detalles : [];
  const found = details.find((item) => normalizeText(item?.id_servicio) === targetId);
  return normalizeText(found?.nombre_servicio_snapshot) || "Servicio";
}

function calculateMembershipCoverageForSelection({
  membresiaAgendamiento = null,
  member = null,
  normalizedSelection = null,
  persistedSelection = null,
  promocionesResult = null,
  totalDespuesPromocionesHnl = 0,
} = {}) {
  const tracker = membresiaAgendamiento?.coverageTracker || null;
  const totalBase = roundMoney(totalDespuesPromocionesHnl);
  if (!tracker?.hasPlan || tracker.coverageEnabled === false || member?.rol_integrante_codigo !== "titular") {
    return {
      aplica: false,
      monto_cubierto_hnl: 0,
      monto_pendiente_hnl: totalBase,
      servicios_cubiertos: [],
    };
  }

  const discountByDetail = getPromotionDiscountByDetail(promocionesResult);
  const detalles = Array.isArray(persistedSelection?.detalles) ? persistedSelection.detalles : [];
  const serviciosCubiertos = [];
  let montoCubierto = 0;

  for (const detalle of detalles) {
    const origin = String(detalle?.origen_item_codigo || "").trim().toLowerCase();
    if (!["servicio_manual", "servicio_extra"].includes(origin)) continue;

    const serviceId = normalizeText(detalle?.id_servicio);
    if (!serviceId) continue;

    const remaining = Number(tracker.serviceRemaining?.get(serviceId) || 0);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;

    const lineTotal = roundMoney(detalle?.total_linea_hnl || 0);
    const lineDiscount = roundMoney(discountByDetail.get(normalizeText(detalle?.id_cita_detalle)) || 0);
    const lineEligible = roundMoney(Math.max(0, lineTotal - lineDiscount));
    if (lineEligible <= 0) continue;

    tracker.serviceRemaining.set(serviceId, remaining - 1);
    montoCubierto = roundMoney(montoCubierto + lineEligible);
    serviciosCubiertos.push({
      id_servicio: serviceId,
      nombre_servicio: getServiceNameFromSelection(normalizedSelection, serviceId),
      monto_cubierto_hnl: lineEligible,
      origen_item_codigo: origin,
    });
  }

  montoCubierto = roundMoney(Math.min(totalBase, montoCubierto));
  return {
    aplica: montoCubierto > 0,
    monto_cubierto_hnl: montoCubierto,
    monto_pendiente_hnl: roundMoney(Math.max(0, totalBase - montoCubierto)),
    servicios_cubiertos: serviciosCubiertos,
  };
}

function forceIsvZeroIfDisabled({
  isvHabilitado,
  isvPorcentaje,
  isvHnl,
  logger = null,
  context = null,
}) {
  if (isvHabilitado) {
    return {
      isvPorcentaje: parseNonNegativeMoney(isvPorcentaje ?? 0, { field: `${context || "isv"}.isv_porcentaje` }),
      isvHnl: parseNonNegativeMoney(isvHnl ?? 0, { field: `${context || "isv"}.isv_hnl` }),
    };
  }

  const safeIsvPorcentaje = parseNonNegativeMoney(isvPorcentaje ?? 0, { field: `${context || "isv"}.isv_porcentaje` });
  const safeIsvHnl = parseNonNegativeMoney(isvHnl ?? 0, { field: `${context || "isv"}.isv_hnl` });

  if ((safeIsvPorcentaje > 0 || safeIsvHnl > 0) && logger?.warn) {
    logger.warn(
      {
        code: "BOOKING_ISV_FORCED_ZERO",
        context: context || null,
      },
      "ISV recibido mayor a cero mientras ISV esta deshabilitado. Se fuerza a cero."
    );
  }
  return {
    isvPorcentaje: 0,
    isvHnl: 0,
  };
}

export async function findActiveAccountByEmail(client, email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return null;
  const activeUserResult = await client.query(
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
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [safeEmail]
  );
  if (activeUserResult.rows[0]) {
    return {
      account_type: "usuario",
      id_usuario: activeUserResult.rows[0].id_usuario,
    };
  }

  const activeClientResult = await client.query(
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
    [safeEmail]
  );
  if (activeClientResult.rows[0]) {
    return {
      account_type: "cliente",
      id_cliente: activeClientResult.rows[0].id_cliente,
      id_persona: activeClientResult.rows[0].id_persona,
    };
  }
  return null;
}

function buildNormalizedMembers({ integrantes, titular, actor }) {
  const base = Array.isArray(integrantes) ? integrantes : [];
  if (!base.length) {
    throw new AppError(400, "No existe un titular valido para la reserva.", {
      code: "INVALID_BOOKING_HOLDER",
    });
  }

  const actorUsuarioId = actor?.id_usuario || null;
  const actorPersonaId = actor?.id_persona || null;
  const actorClienteId = actor?.id_cliente || null;

  return base.map((item, index) => {
    const isTitular = index === 0;
    const contact = item?.contacto || {};
    const email = normalizeEmail(contact.email);
    const nombre = normalizeText(contact.nombre) || normalizeText(item?.alias) || (isTitular ? "Titular" : `Acompanante ${index}`);
    const alias = normalizeText(item?.alias) || (isTitular ? "Titular" : `Acompanante ${index}`);
    const telefono = normalizeText(contact.telefono);

    const rawUsuario = normalizeText(item?.id_usuario);
    const rawPersona = normalizeText(item?.id_persona);
    const rawCliente = normalizeText(item?.id_cliente);

    const idUsuario = isTitular
      ? (titular?.id_usuario || rawUsuario || actorUsuarioId || null)
      : rawUsuario;
    const idPersona = isTitular
      ? (titular?.id_persona || rawPersona || actorPersonaId || null)
      : rawPersona;
    const idCliente = isTitular
      ? (titular?.id_cliente || rawCliente || actorClienteId || null)
      : rawCliente;

    const tipoClienteCodigo = idUsuario || idPersona || idCliente ? "autenticado" : "invitado";

    return {
      index,
      isTitular,
      orden_integrante: index + 1,
      rol_integrante_codigo: isTitular ? "titular" : "acompanante",
      tipo_cliente_codigo: tipoClienteCodigo,
      id_usuario: idUsuario,
      id_persona: idPersona,
      id_cliente: idCliente,
      alias_integrante: alias,
      contacto_nombre_snapshot: nombre || "Cliente",
      contacto_email_snapshot: email || null,
      contacto_telefono_snapshot: telefono || null,
      selection_type: String(item?.selection_type || "services").trim().toLowerCase() || "services",
      id_paquete: item?.id_paquete || null,
      serviceIds: Array.isArray(item?.serviceIds) ? item.serviceIds : [],
      promotionIds: normalizePromotionSelection(item?.promotionIds),
      id_barbero: item?.id_barbero || null,
      fecha_inicio: item?.fecha_inicio,
    };
  });
}

async function validateMemberEmailsAgainstActiveUsers(client, members, actor, logger = null) {
  const actorUsuario = normalizeText(actor?.id_usuario);
  for (const member of members) {
    if (member.tipo_cliente_codigo !== "invitado") continue;
    if (!member.contacto_email_snapshot) continue;
    const active = await findActiveAccountByEmail(client, member.contacto_email_snapshot);
    if (!active) continue;
    if (actorUsuario && actorUsuario === active.id_usuario) continue;

    if (logger?.warn) {
      logger.warn(
        {
          code: "EMAIL_BELONGS_TO_ACTIVE_USER",
          blockIndex: member.index,
          field: member.isTitular ? "titular.email" : "contacto.email",
        },
        "Intento de reserva con correo perteneciente a usuario activo."
      );
    }
    throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar.", {
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      details: {
        field: member.isTitular ? "titular.email" : "contacto.email",
        blockIndex: member.index,
        email: member.contacto_email_snapshot,
        rol_integrante_codigo: member.isTitular ? "titular" : "acompanante",
        orden_integrante: Number(member.orden_integrante || member.index + 1),
        alias: member.alias_integrante || null,
      },
    });
  }
}

async function ensureGuestPersonaForMember(client, member) {
  if (member?.id_persona) return member;

  const splitName = splitGuestFullName(member?.contacto_nombre_snapshot || member?.alias_integrante || "Cliente Invitado");
  const { rows } = await client.query(
    `
      INSERT INTO public.personas (nombres, apellidos, telefono_principal)
      VALUES ($1::text, $2::text, $3::text)
      RETURNING id_persona
    `,
    [
      splitName.nombres,
      splitName.apellidos,
      member?.contacto_telefono_snapshot || null,
    ]
  );
  const idPersona = rows[0]?.id_persona || null;
  if (!idPersona) return member;

  if (member?.contacto_email_snapshot) {
    await client.query(
      `
        INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
        VALUES ($1::uuid, $2::text, FALSE, FALSE)
        ON CONFLICT DO NOTHING
      `,
      [idPersona, member.contacto_email_snapshot]
    );
  }

  return {
    ...member,
    id_persona: idPersona,
  };
}

async function insertGrupo(client, {
  idSucursal,
  titular,
  origenCodigo,
  notas,
  releaseToken = null,
}) {
  const { rows } = await client.query(
    `
      INSERT INTO public.citas_grupos (
        id_sucursal,
        id_persona_titular,
        id_cliente_titular,
        id_usuario_titular,
        origen_codigo,
        estado_grupo_codigo,
        notas,
        release_token
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::text,
        'activo',
        $6,
        $7
      )
      RETURNING id_grupo_cita, estado_grupo_codigo
    `,
    [
      idSucursal,
      titular?.id_persona || null,
      titular?.id_cliente || null,
      titular?.id_usuario || null,
      origenCodigo || "publico",
      notas || null,
      releaseToken || null,
    ]
  );
  return rows[0];
}

async function insertIntegrante(client, idGrupoCita, member) {
  const { rows } = await client.query(
    `
      INSERT INTO public.citas_integrantes (
        id_grupo_cita,
        orden_integrante,
        rol_integrante_codigo,
        tipo_cliente_codigo,
        id_usuario,
        id_persona,
        id_cliente,
        contacto_nombre_snapshot,
        contacto_email_snapshot,
        contacto_telefono_snapshot,
        alias_integrante
      )
      VALUES (
        $1::uuid,
        $2::int,
        $3::text,
        $4::text,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8,
        $9,
        $10,
        $11
      )
      RETURNING id_cita_integrante
    `,
    [
      idGrupoCita,
      member.orden_integrante,
      member.rol_integrante_codigo,
      member.tipo_cliente_codigo,
      member.id_usuario,
      member.id_persona,
      member.id_cliente,
      member.contacto_nombre_snapshot || "Cliente",
      member.contacto_email_snapshot || null,
      member.contacto_telefono_snapshot || null,
      member.alias_integrante || null,
    ]
  );
  return rows[0]?.id_cita_integrante || null;
}

async function insertCitaLegacyCompatible(client, {
  idGrupoCita,
  idCitaIntegrante,
  idSucursal,
  member,
  selection,
  notas,
  estadoCitaCodigo,
}) {
  const startAt = selection.startDateTime;
  const finAt = new Date(startAt.getTime() + Number(selection.serviceSelection.duracion_total_min || 0) * 60 * 1000);
  const subtotalServicios = roundMoney(selection.serviceSelection.monto_total_hnl || 0);
  const normalizedSelection = selection?.serviceSelection?.normalizedSelection || null;
  const totalPagar = roundMoney(normalizedSelection?.total_hnl ?? subtotalServicios);

  const { rows } = await client.query(
    `
      INSERT INTO public.citas (
        id_grupo_cita,
        id_cita_integrante,
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
        selection_type,
        id_paquete,
        contacto_nombre,
        contacto_email,
        contacto_telefono,
        notas
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::int,
        $4,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::uuid,
        $9::uuid,
        $10::boolean,
        $11::text,
        $12::timestamptz,
        $13::timestamptz,
        $14::int,
        $15::int,
        $16::numeric,
        $17::numeric,
        $18::numeric,
        $19::text,
        $20::uuid,
        $21,
        $22,
        $23,
        $24
      )
      RETURNING id_cita
    `,
    [
      idGrupoCita,
      idCitaIntegrante,
      member.orden_integrante,
      member.alias_integrante,
      idSucursal,
      selection.barber.id_empleado,
      member.id_persona,
      member.id_cliente,
      member.id_usuario,
      !member.id_barbero,
      estadoCitaCodigo || "en_espera",
      startAt.toISOString(),
      finAt.toISOString(),
      Number(selection.serviceSelection.duracion_total_min || 0),
      Number(selection.serviceSelection.buffer_total_min || 0),
      subtotalServicios,
      0,
      totalPagar,
      selection.serviceSelection.selection_type || member.selection_type || "services",
      selection.serviceSelection.id_paquete || member.id_paquete || null,
      member.contacto_nombre_snapshot || member.alias_integrante,
      member.contacto_email_snapshot || null,
      member.contacto_telefono_snapshot || null,
      notas || null,
    ]
  );

  return {
    id_cita: rows[0]?.id_cita || null,
    finAt,
    subtotalServicios,
    totalPagar,
  };
}

async function insertCitaPaquete(client, {
  idCita,
  normalizedSelection,
  isvHabilitado,
  logger = null,
}) {
  const selectionType = String(normalizedSelection?.selection_type || "").trim().toLowerCase();
  const packageSnapshot = normalizedSelection?.paquete || null;
  if ((selectionType === "package" || selectionType === "mixed") && !packageSnapshot) {
    throw new AppError(409, "No fue posible preparar el paquete seleccionado.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
      details: { selection_type: selectionType || null },
    });
  }
  if (!packageSnapshot) return null;

  const idPaquete = normalizeText(packageSnapshot.id_paquete);
  if (!idPaquete) {
    throw new AppError(409, "No fue posible preparar el paquete seleccionado.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
    });
  }

  const duracionTotalMin = parseBufferMinutes(packageSnapshot.duracion_total_min ?? 0, {
    field: "paquete.duracion_total_min",
    code: "BOOKING_PACKAGE_DETAILS_INVALID",
  });
  const precioLista = parseNonNegativeMoney(packageSnapshot.precio_lista_hnl ?? 0, {
    field: "paquete.precio_lista_hnl",
    code: "BOOKING_PACKAGE_DETAILS_INVALID",
  });
  const descuento = parseNonNegativeMoney(packageSnapshot.descuento_hnl ?? 0, {
    field: "paquete.descuento_hnl",
    code: "BOOKING_PACKAGE_DETAILS_INVALID",
  });
  const total = parseNonNegativeMoney(packageSnapshot.total_hnl ?? 0, {
    field: "paquete.total_hnl",
    code: "BOOKING_PACKAGE_DETAILS_INVALID",
  });
  const forcedIsv = forceIsvZeroIfDisabled({
    isvHabilitado,
    isvPorcentaje: packageSnapshot.isv_porcentaje ?? 0,
    isvHnl: packageSnapshot.isv_hnl ?? 0,
    logger,
    context: "paquete",
  });

  const { rows } = await client.query(
    `
      INSERT INTO public.citas_paquetes (
        id_cita,
        id_paquete,
        id_paquete_sucursal,
        origen_paquete_codigo,
        nombre_paquete_snapshot,
        descripcion_paquete_snapshot,
        duracion_total_min,
        precio_lista_hnl,
        descuento_hnl,
        isv_porcentaje,
        isv_hnl,
        total_hnl
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5,
        $6,
        $7::int,
        $8::numeric,
        $9::numeric,
        $10::numeric,
        $11::numeric,
        $12::numeric
      )
      RETURNING id_cita_paquete
    `,
    [
      idCita,
      idPaquete,
      packageSnapshot.id_paquete_sucursal || null,
      "seleccion_cliente",
      normalizeText(packageSnapshot.nombre_paquete_snapshot) || "Paquete",
      normalizeText(packageSnapshot.descripcion_paquete_snapshot),
      duracionTotalMin,
      precioLista,
      descuento,
      forcedIsv.isvPorcentaje,
      forcedIsv.isvHnl,
      total,
    ]
  );

  return rows[0]?.id_cita_paquete || null;
}

async function insertCitaDetalleNormalizado(client, {
  idCita,
  idCitaPaquete,
  detalle,
  isvHabilitado,
  logger = null,
}) {
  const origin = String(detalle?.origen_item_codigo || "").trim().toLowerCase();
  if (!NORMALIZED_DETAIL_ORIGINS.has(origin)) {
    throw new AppError(409, "No fue posible preparar los detalles de la reserva.", {
      code: "BOOKING_DETAIL_ORIGIN_INVALID",
      details: { origen_item_codigo: origin || null },
    });
  }

  const idServicio = normalizeText(detalle?.id_servicio);
  if (!idServicio) {
    throw new AppError(409, "No fue posible calcular los montos de la reserva.", {
      code: "BOOKING_DETAIL_AMOUNT_INVALID",
      details: { field: "detalle.id_servicio" },
    });
  }

  const isPackageIncluded = origin === "paquete_incluido";
  if (isPackageIncluded && !idCitaPaquete) {
    throw new AppError(409, "No fue posible preparar el paquete seleccionado.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
    });
  }

  const duracionMin = parseDurationMinutes(detalle?.duracion_min, {
    field: "detalle.duracion_min",
  });
  const bufferMin = parseBufferMinutes(detalle?.buffer_min ?? 0, {
    field: "detalle.buffer_min",
  });
  const precioReferencia = parseNonNegativeMoney(detalle?.precio_referencia_hnl ?? 0, {
    field: "detalle.precio_referencia_hnl",
  });

  const forcedIsv = forceIsvZeroIfDisabled({
    isvHabilitado,
    isvPorcentaje: detalle?.isv_porcentaje ?? 0,
    isvHnl: detalle?.isv_hnl ?? 0,
    logger,
    context: `detalle.${origin}`,
  });

  const precioUnitario = isPackageIncluded
    ? 0
    : parseNonNegativeMoney(detalle?.precio_unitario_hnl ?? 0, { field: "detalle.precio_unitario_hnl" });
  const subtotal = isPackageIncluded
    ? 0
    : parseNonNegativeMoney(detalle?.subtotal_hnl ?? 0, { field: "detalle.subtotal_hnl" });
  const descuento = isPackageIncluded
    ? 0
    : parseNonNegativeMoney(detalle?.descuento_hnl ?? 0, { field: "detalle.descuento_hnl" });
  const totalLinea = isPackageIncluded
    ? 0
    : parseNonNegativeMoney(detalle?.total_linea_hnl ?? 0, { field: "detalle.total_linea_hnl" });

  const { rows } = await client.query(
    `
      INSERT INTO public.citas_detalles (
        id_cita,
        id_servicio,
        id_cita_paquete,
        origen_item_codigo,
        nombre_servicio_snapshot,
        cantidad,
        duracion_min,
        buffer_min,
        precio_referencia_hnl,
        precio_unitario_hnl,
        subtotal_hnl,
        descuento_hnl,
        isv_porcentaje,
        isv_hnl,
        total_linea_hnl
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5,
        1,
        $6::int,
        $7::int,
        $8::numeric,
        $9::numeric,
        $10::numeric,
        $11::numeric,
        $12::numeric,
        $13::numeric,
        $14::numeric
      )
      RETURNING id_cita_detalle
    `,
    [
      idCita,
      idServicio,
      isPackageIncluded ? idCitaPaquete : null,
      origin,
      normalizeText(detalle?.nombre_servicio_snapshot),
      duracionMin,
      bufferMin,
      precioReferencia,
      precioUnitario,
      subtotal,
      descuento,
      forcedIsv.isvPorcentaje,
      forcedIsv.isvHnl,
      totalLinea,
    ]
  );

  return {
    id_cita_detalle: rows[0]?.id_cita_detalle || null,
    id_servicio: idServicio,
    id_cita_paquete: isPackageIncluded ? idCitaPaquete : null,
    origen_item_codigo: origin,
    total_linea_hnl: totalLinea,
  };
}

async function insertNormalizedPackageAndDetails(client, {
  idCita,
  normalizedSelection,
  isvHabilitado,
  logger = null,
}) {
  if (!normalizedSelection || typeof normalizedSelection !== "object") {
    throw new AppError(409, "No fue posible preparar los detalles de la reserva.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
    });
  }

  const selectionType = String(normalizedSelection.selection_type || "").trim().toLowerCase();
  if ((selectionType === "package" || selectionType === "mixed") && !normalizedSelection.paquete) {
    throw new AppError(409, "No fue posible preparar el paquete seleccionado.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
      details: { selection_type: selectionType || null },
    });
  }

  const idCitaPaquete = await insertCitaPaquete(client, {
    idCita,
    normalizedSelection,
    isvHabilitado,
    logger,
  });

  const detalles = Array.isArray(normalizedSelection.detalles) ? normalizedSelection.detalles : [];
  const requiresPackageLink = detalles.some((item) => String(item?.origen_item_codigo || "").trim().toLowerCase() === "paquete_incluido");
  if (requiresPackageLink && !idCitaPaquete) {
    throw new AppError(409, "No fue posible preparar el paquete seleccionado.", {
      code: "BOOKING_PACKAGE_DETAILS_INVALID",
    });
  }

  const detallesPersistidos = [];
  for (const detalle of detalles) {
    const insertedDetail = await insertCitaDetalleNormalizado(client, {
      idCita,
      idCitaPaquete,
      detalle,
      isvHabilitado,
      logger,
    });
    detallesPersistidos.push(insertedDetail);
  }

  return {
    id_cita_paquete: idCitaPaquete,
    detalles: detallesPersistidos,
  };
}

async function insertHold(client, {
  idCita,
  idUsuario,
  expiresAt,
  holdState,
}) {
  await client.query(
    `
      INSERT INTO public.citas_holds (
        id_cita,
        id_usuario,
        estado_hold_codigo,
        expires_at
      )
      VALUES ($1::uuid, $2::uuid, $3::text, $4::timestamptz)
    `,
    [idCita, idUsuario || null, holdState || "activo", expiresAt.toISOString()]
  );
}

async function updateCitaTotalsAfterPromotions(client, {
  idCita,
  descuentoTotalHnl,
  totalPagarHnl,
  esCanjeRecompensa = false,
}) {
  const descuento = roundMoney(descuentoTotalHnl || 0);
  const totalPagar = roundMoney(Math.max(0, totalPagarHnl || 0));
  await client.query(
    `
      UPDATE public.citas
      SET descuento_hnl = $2::numeric,
          total_pagar_hnl = $3::numeric,
          es_canje_recompensa = $4::boolean,
          updated_at = now()
      WHERE id_cita = $1::uuid
    `,
    [idCita, descuento, totalPagar, Boolean(esCanjeRecompensa)]
  );
}

export async function crearReservaHoldBaseNormalizada({
  client,
  logger = null,
  actor = null,
  titular = null,
  integrantes = [],
  id_sucursal,
  origen_codigo = "publico",
  notas = null,
  agendamientoConfig = null,
  hold_state = "activo",
  appointment_state = "en_espera",
  beneficioAgendamiento = null,
  membresiaAgendamiento = null,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new AppError(500, "No se pudo crear la reserva en este momento.", {
      code: "BOOKING_CREATION_FAILED",
    });
  }

  const normalizedMembers = buildNormalizedMembers({
    integrantes,
    titular,
    actor,
  });
  const titulares = normalizedMembers.filter((member) => member.rol_integrante_codigo === "titular");
  if (titulares.length !== 1 || titulares[0].orden_integrante !== 1) {
    throw new AppError(400, "No existe un titular valido para la reserva.", {
      code: "INVALID_BOOKING_HOLDER",
    });
  }
  if (!titulares[0].id_persona) {
    throw new AppError(409, "No se pudo identificar al titular de la reserva.", {
      code: "INVALID_BOOKING_HOLDER",
    });
  }

  const effectiveConfig = agendamientoConfig || await getAgendamientoConfig(client, { logger });
  const maxAcompanantes = Math.max(0, Math.trunc(Number(effectiveConfig.maxAcompanantes ?? 4)));
  const maxPromocionesPorReserva = Math.max(0, Math.trunc(Number(effectiveConfig.maxPromocionesPorReserva ?? 5)));
  const requestedPromotionsInReservation = [
    ...new Set(normalizedMembers.flatMap((member) => Array.isArray(member.promotionIds) ? member.promotionIds : [])),
  ];
  if (requestedPromotionsInReservation.length > maxPromocionesPorReserva) {
    throw new AppError(409, "Has seleccionado mas promociones de las permitidas.", {
      code: "MAX_PROMOTIONS_EXCEEDED",
      details: { maxPromotions: maxPromocionesPorReserva },
    });
  }
  const companionsCount = normalizedMembers.filter((member) => member.rol_integrante_codigo === "acompanante").length;
  if (companionsCount > maxAcompanantes) {
    throw new AppError(409, `Solo se permiten hasta ${maxAcompanantes} acompanantes por reserva.`, {
      code: "MAX_COMPANIONS_EXCEEDED",
      details: { maxCompanions: maxAcompanantes },
    });
  }
  if (beneficioAgendamiento?.aplica && requestedPromotionsInReservation.length > 0) {
    throw new AppError(409, "El canje seleccionado no aplica a esta reserva.", {
      code: "REDEEM_NOT_APPLICABLE",
    });
  }

  const releaseToken = String(origen_codigo || "").trim().toLowerCase() === "publico"
    ? crypto.randomBytes(32).toString("hex")
    : null;

  let txStarted = false;
  try {
    await client.query("BEGIN");
    txStarted = true;

    await validateMemberEmailsAgainstActiveUsers(client, normalizedMembers, actor, logger);

    const membersForPersist = [];
    for (const member of normalizedMembers) {
      const hydratedMember = await ensureGuestPersonaForMember(client, member);
      membersForPersist.push(hydratedMember);
    }

    const groupRecord = await insertGrupo(client, {
      idSucursal: id_sucursal,
      titular: membersForPersist[0],
      origenCodigo: origen_codigo,
      notas,
      releaseToken,
    });
    const holdDurationMin = Math.max(1, Number(effectiveConfig.holdTtlMinutos || 5));
    const expiresAt = new Date(Date.now() + holdDurationMin * 60 * 1000);

    const bloques = [];
    const citas = [];
    let subtotalGrupo = 0;
    let descuentoGrupo = 0;
    let totalGrupo = 0;
    let titularResolved = null;
    let beneficioAplicadoResumen = null;
    let membresiaCubiertoGrupo = 0;
    const membresiaServiciosCubiertos = new Map();

    for (const member of membersForPersist) {
      const selection = await resolveBookingSelection(client, {
        id_sucursal,
        selection_type: member.selection_type,
        servicios: member.serviceIds,
        id_paquete: member.id_paquete,
        fecha_inicio: member.fecha_inicio,
        id_barbero: member.id_barbero,
        agendamientoConfig: effectiveConfig,
        logger,
      });

      const horaMatch = String(member.fecha_inicio || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      const memberFecha = horaMatch?.[1] || null;
      const memberHora = horaMatch?.[2] || null;

      if (member.rol_integrante_codigo === "acompanante" && titulares[0]?.fecha_inicio) {
        const titularMatch = String(titulares[0].fecha_inicio).trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        const titularFecha = titularMatch?.[1] || null;
        if (memberFecha && titularFecha && memberFecha !== titularFecha) {
          throw new AppError(409, "Los acompanantes deben agendarse en la misma fecha del titular", {
            code: "SLOT_NOT_AVAILABLE",
            details: { field: "fecha_inicio", blockIndex: member.index },
          });
        }
      }

      if (
        member.rol_integrante_codigo === "acompanante"
        && titularResolved
        && memberHora
        && memberHora === titularResolved.hora
        && selection.barber.id_empleado === titularResolved.id_barbero
      ) {
        throw new AppError(409, "Un acompanante no puede tomar la misma hora del titular con el mismo barbero", {
          code: "SLOT_NOT_AVAILABLE",
          details: { field: "fecha_inicio", blockIndex: member.index },
        });
      }

      if (member.rol_integrante_codigo === "titular") {
        titulares[0].fecha_inicio = member.fecha_inicio;
        titularResolved = {
          hora: memberHora,
          id_barbero: selection.barber.id_empleado,
        };
      }

      const idCitaIntegrante = await insertIntegrante(client, groupRecord.id_grupo_cita, member);
      const citaInsert = await insertCitaLegacyCompatible(client, {
        idGrupoCita: groupRecord.id_grupo_cita,
        idCitaIntegrante,
        idSucursal: id_sucursal,
        member,
        selection,
        notas,
        estadoCitaCodigo: appointment_state,
      });

      const normalizedSelection = selection?.serviceSelection?.normalizedSelection || null;
      const persistedSelection = await insertNormalizedPackageAndDetails(client, {
        idCita: citaInsert.id_cita,
        normalizedSelection,
        isvHabilitado: Boolean(effectiveConfig?.isvHabilitado),
        logger,
      });

      const promocionesResult = await validarYAplicarPromocionesAgendamiento({
        client,
        logger,
        agendamientoConfig: effectiveConfig,
        id_grupo_cita: groupRecord.id_grupo_cita,
        id_cita: citaInsert.id_cita,
        id_cita_integrante: idCitaIntegrante,
        id_sucursal,
        id_barbero: selection.barber.id_empleado,
        fecha_inicio: selection.startDateTime,
        normalizedSelection,
        promocionesSolicitadas: member.promotionIds,
        actor,
        integrante: member,
        detallesPersistidos: persistedSelection?.detalles || [],
        idCitaPaquete: persistedSelection?.id_cita_paquete || null,
      });

      const totalDespuesPromociones = roundMoney(
        promocionesResult?.totalDespuesPromocionesHnl
          ?? normalizedSelection?.total_hnl
          ?? citaInsert.totalPagar
      );
      const subtotalCita = roundMoney(
        normalizedSelection?.total_hnl
          ?? citaInsert.totalPagar
      );
      const descuentoPromociones = roundMoney(promocionesResult?.descuentoTotalHnl || 0);
      const membresiaCita = calculateMembershipCoverageForSelection({
        membresiaAgendamiento,
        member,
        normalizedSelection,
        persistedSelection,
        promocionesResult,
        totalDespuesPromocionesHnl: totalDespuesPromociones,
      });
      const descuentoMembresia = roundMoney(membresiaCita?.monto_cubierto_hnl || 0);
      const totalDespuesMembresia = roundMoney(
        membresiaCita?.aplica
          ? membresiaCita.monto_pendiente_hnl
          : totalDespuesPromociones
      );
      const beneficioCitaFinal = calcularCoberturaCanjeSobreSeleccion({
        beneficioAgendamiento,
        member,
        normalizedSelection,
        totalDespuesPromocionesHnl: totalDespuesMembresia,
      });
      const descuentoCanje = roundMoney(beneficioCitaFinal?.monto_cubierto_hnl || 0);
      const descuentoTotal = roundMoney(descuentoPromociones + descuentoMembresia + descuentoCanje);
      const totalFinalCita = roundMoney(
        beneficioCitaFinal?.aplica
          ? beneficioCitaFinal.monto_pendiente_hnl
          : totalDespuesMembresia
      );

      await updateCitaTotalsAfterPromotions(client, {
        idCita: citaInsert.id_cita,
        descuentoTotalHnl: descuentoTotal,
        totalPagarHnl: totalFinalCita,
        esCanjeRecompensa: Boolean(beneficioCitaFinal?.aplica),
      });

      await insertHold(client, {
        idCita: citaInsert.id_cita,
        idUsuario: normalizedMembers.length > 1 ? null : (actor?.id_usuario || member.id_usuario || null),
        expiresAt,
        holdState: hold_state,
      });

      const totalCita = totalFinalCita;
      subtotalGrupo += subtotalCita;
      descuentoGrupo += descuentoTotal;
      totalGrupo += totalCita;

      if (membresiaCita?.aplica) {
        membresiaCubiertoGrupo = roundMoney(membresiaCubiertoGrupo + descuentoMembresia);
        for (const service of Array.isArray(membresiaCita.servicios_cubiertos) ? membresiaCita.servicios_cubiertos : []) {
          const serviceId = normalizeText(service?.id_servicio);
          if (!serviceId || membresiaServiciosCubiertos.has(serviceId)) continue;
          membresiaServiciosCubiertos.set(serviceId, {
            id_servicio: serviceId,
            nombre_servicio: normalizeText(service?.nombre_servicio) || "Servicio",
          });
        }
      }

      if (beneficioCitaFinal?.aplica) {
        beneficioAplicadoResumen = {
          aplica: true,
          tipo_beneficio_codigo: beneficioAgendamiento?.tipo_beneficio_codigo || "canje_recompensa",
          canje_context_token: beneficioAgendamiento?.canje_context_token || null,
          id_points_tx_canje: beneficioAgendamiento?.id_points_tx_canje || null,
          id_servicio_objetivo: beneficioCitaFinal.id_servicio_objetivo || beneficioAgendamiento?.id_servicio_objetivo || null,
          puntos_requeridos: Number(beneficioAgendamiento?.puntos_requeridos || 0),
          monto_cubierto_hnl: roundMoney(beneficioCitaFinal.monto_cubierto_hnl || 0),
          monto_pendiente_hnl: roundMoney(beneficioCitaFinal.monto_pendiente_hnl || 0),
          consumir_en_confirmacion: Boolean(beneficioAgendamiento?.consumir_en_confirmacion),
          metadata_segura: beneficioAgendamiento?.metadata_segura || null,
        };
      }

      bloques.push({
        id_cita: citaInsert.id_cita,
        orden_integrante: member.orden_integrante,
        alias: member.alias_integrante,
        id_barbero: selection.barber.id_empleado,
        nombre_barbero: selection.barber.nombre_completo,
        fecha: memberFecha || "",
        hora: memberHora || "",
        fecha_inicio: selection.startDateTime.toISOString(),
        estado_cita_codigo: appointment_state,
        monto_total_hnl: totalCita,
        descuento_promociones_hnl: descuentoPromociones,
        cubierto_por_plan_hnl: descuentoMembresia,
        beneficio_canje_hnl: descuentoCanje,
        total_pagar_hnl: totalCita,
        duracion_total_min: Number(selection.serviceSelection.duracion_total_min || 0),
        buffer_total_min: Number(selection.serviceSelection.buffer_total_min || 0),
      });

      citas.push({
        id_cita: citaInsert.id_cita,
        id_cita_integrante: idCitaIntegrante,
        orden_integrante: member.orden_integrante,
        rol_integrante_codigo: member.rol_integrante_codigo,
        id_barbero: selection.barber.id_empleado,
        fecha_inicio: selection.startDateTime.toISOString(),
        fecha_fin: citaInsert.finAt.toISOString(),
        selection_type: selection.serviceSelection.selection_type || member.selection_type,
        total_hnl: totalCita,
        descuento_promociones_hnl: descuentoPromociones,
        cubierto_por_plan_hnl: descuentoMembresia,
        beneficio_canje_hnl: descuentoCanje,
      });
    }

    await client.query(
      `
        UPDATE public.citas_grupos
        SET total_hnl = $2::numeric,
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
      `,
      [groupRecord.id_grupo_cita, roundMoney(totalGrupo)]
    );

    let comprobanteResult = null;
    await client.query("SAVEPOINT booking_receipt_sp");
    try {
      comprobanteResult = await crearComprobanteAgendamientoNoFiscal({
        client,
        logger,
        agendamientoConfig: effectiveConfig,
        id_grupo_cita: groupRecord.id_grupo_cita,
      });
      await client.query("RELEASE SAVEPOINT booking_receipt_sp");
    } catch (receiptError) {
      await client.query("ROLLBACK TO SAVEPOINT booking_receipt_sp");
      await client.query("RELEASE SAVEPOINT booking_receipt_sp");
      logger?.warn?.(
        {
          err: receiptError,
          code: "BOOKING_RECEIPT_CREATE_NON_BLOCKING_FAILED",
          id_grupo_cita: groupRecord.id_grupo_cita,
        },
        "No se pudo generar comprobante durante hold. Se continua sin bloquear la reserva temporal."
      );
      comprobanteResult = null;
    }

    await client.query("COMMIT");
    txStarted = false;

    return {
      id_grupo_cita: groupRecord.id_grupo_cita,
      estado_grupo_codigo: groupRecord.estado_grupo_codigo || "activo",
      expires_at: expiresAt.toISOString(),
      subtotal_hnl: roundMoney(subtotalGrupo),
      descuento_total_hnl: roundMoney(descuentoGrupo),
      total_pagar_hnl: roundMoney(totalGrupo),
      extras_a_pagar_hnl: roundMoney(totalGrupo),
      total_hnl: roundMoney(totalGrupo),
      monto_total_hnl: roundMoney(totalGrupo),
      citas,
      bloques,
      beneficio: beneficioAplicadoResumen,
      membresia: {
        cobertura_activa: Boolean(membresiaAgendamiento?.coverageTracker?.hasPlan && membresiaCubiertoGrupo > 0),
        id_suscripcion: membresiaAgendamiento?.coverageTracker?.idSuscripcion || null,
        id_sucursal_contratada: membresiaAgendamiento?.coverageTracker?.idSucursalContratada || null,
        sucursal_plan_nombre: membresiaAgendamiento?.coverageTracker?.sucursalPlanNombre || null,
        nombre_plan: membresiaAgendamiento?.coverageTracker?.planName || null,
        estado_plan: membresiaAgendamiento?.estado_plan || (membresiaAgendamiento?.coverageTracker?.hasPlan ? "activo" : "sin_plan_activo"),
        mensaje: membresiaAgendamiento?.mensaje || null,
        servicios_cubiertos: [...membresiaServiciosCubiertos.values()],
        servicios_forzados: [],
        cubierto_por_plan_hnl: roundMoney(membresiaCubiertoGrupo),
        extras_a_pagar_hnl: roundMoney(totalGrupo),
      },
      comprobante: comprobanteResult,
      release_token: releaseToken,
    };
  } catch (error) {
    if (txStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
    }
    throw error;
  }
}
