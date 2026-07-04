import {
  assertBookingSelectionCreationSupported,
  buildAppointmentDetailRows,
} from "../bookingReservationService.js";
import {
  assertCanonicalTotalsMatch,
  assertKnownIdempotencyState,
  buildAssignmentAttemptsFromIntegrantes,
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
} from "../bookingCanonicalReservationService.js";
import {
  assertUuid,
  ensureActiveBranch,
  normalizeOperationalDateTime,
  resolveBookingSelection,
  resolveBranchIdsForClaims,
} from "../agendaService.js";
import { confirmAppointmentsWithoutPayment } from "../appointmentConfirmationService.js";
import {
  createCoverageTracker,
  consumeCoverageForServices,
  ensureSubscriptionLifecycle,
} from "../membershipService.js";
import {
  applyRewardRedeemForConfirmedGroup,
  prepareRewardRedeemContextForHold,
  resolveRewardRedeemGateForCliente,
} from "../pointsService.js";
import {
  previewPromotionsForAppointment,
  recordPromotionApplications,
  markPromotionUsagesForGroup,
  revertPromotionUsages,
} from "../promociones/promocionesService.js";
import { buildPromotionResult } from "../promociones/promocionesEngine.js";
import { AppError } from "../../utils/errors.js";
import { buildCanonicalHoldResponse, createBookingHold } from "./bookingHoldOrchestrationService.js";

export const ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE = "admin:citas:hold";
export const ADMIN_BOOKING_ORIGIN_CODE = "admin";
export const ADMIN_BOOKING_UNPAID_PAYMENT_STATE = null;
const ASSISTED_BOOKING_ROLES = new Set(["admin", "super_admin"]);
const MAX_ADMIN_BOOKING_BLOCKS = 5;
const ADMIN_CLOSE_METHODS = new Set(["sin_pago", "efectivo"]);
const REWARD_CONSENT_METHODS = new Set(["presencial", "llamada", "whatsapp", "otro"]);
const FORBIDDEN_PAYMENT_FIELDS = new Set([
  "card_number",
  "cardNumber",
  "numero_tarjeta",
  "pan",
  "cvv",
  "cvc",
  "security_code",
  "codigo_seguridad",
]);

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function normalizeEmail(value) {
  const text = cleanText(value);
  return text ? text.toLowerCase() : null;
}

function normalizePhone(value) {
  const text = cleanText(value);
  return text ? text.replace(/\s+/g, " ") : null;
}

function hasForbiddenPaymentField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenPaymentField(entry));
  return Object.entries(value).some(([key, entry]) => (
    FORBIDDEN_PAYMENT_FIELDS.has(key) || hasForbiddenPaymentField(entry)
  ));
}

function getPrimaryRole(claims = {}) {
  const roles = Array.isArray(claims.roles) ? claims.roles.map((role) => String(role || "").trim()) : [];
  if (roles.includes("super_admin")) return "super_admin";
  if (roles.includes("admin")) return "admin";
  return roles[0] || null;
}

function mapAdminBookingError(error, context = {}) {
  const mapped = mapCanonicalReservationError(error, context);
  if (mapped instanceof AppError) return mapped;
  return new AppError(500, context.safeMessage || "No se pudo completar el agendamiento administrativo", {
    code: context.code || "ADMIN_BOOKING_OPERATION_ERROR",
    details: context.details || {},
  });
}

export function assertAdminBookingRole(claims = {}) {
  const role = getPrimaryRole(claims);
  if (!ASSISTED_BOOKING_ROLES.has(role)) {
    throw new AppError(403, "No tienes permisos para crear agendamiento interno asistido", {
      code: "ADMIN_BOOKING_FORBIDDEN",
    });
  }
  return {
    role,
    isSuperAdmin: role === "super_admin",
    userId: claims?.user?.id_usuario || claims?.id_usuario || null,
  };
}

export function normalizeAdminBookingBody(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "El cuerpo de la solicitud es obligatorio", {
      code: "ADMIN_BOOKING_BODY_REQUIRED",
    });
  }
  if (body.release_token || body.releaseToken) {
    throw new AppError(400, "release_token no aplica al agendamiento interno", {
      code: "ADMIN_BOOKING_RELEASE_TOKEN_FORBIDDEN",
    });
  }
  if (hasForbiddenPaymentField(body)) {
    throw new AppError(400, "El flujo administrativo no recibe datos sensibles de tarjeta", {
      code: "ADMIN_BOOKING_CARD_DATA_FORBIDDEN",
    });
  }
  const blocksSource = Array.isArray(body.integrantes)
    ? body.integrantes
    : (Array.isArray(body.bloques) ? body.bloques : []);
  if (!blocksSource.length) {
    throw new AppError(400, "integrantes es obligatorio", {
      code: "ADMIN_BOOKING_BLOCKS_REQUIRED",
    });
  }
  if (blocksSource.length > MAX_ADMIN_BOOKING_BLOCKS) {
    throw new AppError(400, "Solo se permiten hasta 5 bloques por agendamiento interno", {
      code: "ADMIN_BOOKING_BLOCKS_LIMIT",
      details: { max: MAX_ADMIN_BOOKING_BLOCKS },
    });
  }

  const idCliente = body.id_cliente ? assertUuid(body.id_cliente, "id_cliente") : null;
  const rawNewClient = body.cliente_nuevo || body.nuevo_cliente || null;
  if (!idCliente && !rawNewClient) {
    throw new AppError(400, "Debe seleccionar un cliente existente o crear una ficha de cliente", {
      code: "ADMIN_BOOKING_CUSTOMER_REQUIRED",
    });
  }
  if (idCliente && rawNewClient) {
    throw new AppError(400, "No mezcles cliente existente y cliente nuevo en la misma solicitud", {
      code: "ADMIN_BOOKING_CUSTOMER_MODE_INVALID",
    });
  }

  return {
    idSucursal: assertUuid(body.id_sucursal, "id_sucursal"),
    idCliente,
    clienteNuevo: rawNewClient ? normalizeNewClientPayload(rawNewClient) : null,
    integrantes: blocksSource.map(normalizeAdminBookingBlock),
    notas: cleanText(body.notas),
    metodoPagoCodigo: null,
    beneficios: normalizeAdminBenefits(body),
    motivo: cleanText(body.motivo ?? body.motivo_cortesia ?? body.motivo_modificacion),
  };
}

function normalizeAdminBenefits(body = {}) {
  return {
    membresia: body.membresia || body.membership || null,
    recompensa: body.recompensa || body.reward || null,
    promocion: body.promocion || body.promociones || null,
    promocionManualId: cleanText(body.promocion_manual_id ?? body.id_promocion_manual),
    promocionManualMotivo: cleanText(body.promocion_manual_motivo),
    cortesia: body.cortesia || null,
  };
}

export function normalizeAdminHoldCloseBody(body = {}, { requireReason = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "El cuerpo de la solicitud es obligatorio", {
      code: "ADMIN_BOOKING_BODY_REQUIRED",
    });
  }
  if (hasForbiddenPaymentField(body)) {
    throw new AppError(400, "El flujo administrativo no recibe datos sensibles de tarjeta", {
      code: "ADMIN_BOOKING_CARD_DATA_FORBIDDEN",
    });
  }
  const metodoPagoCodigo = String(body.metodo_pago_codigo || body.metodo || body.intencion || "sin_pago").trim().toLowerCase();
  if (!ADMIN_CLOSE_METHODS.has(metodoPagoCodigo)) {
    throw new AppError(422, "La intencion administrativa de cierre no es valida", {
      code: "ADMIN_BOOKING_CLOSE_METHOD_INVALID",
      details: { metodo_pago_codigo: metodoPagoCodigo },
    });
  }
  const motivo = cleanText(body.motivo ?? body.motivo_cortesia ?? body.motivo_excepcion);
  if (requireReason && !motivo) {
    throw new AppError(422, "El motivo es obligatorio para esta operacion", {
      code: "ADMIN_BOOKING_REASON_REQUIRED",
    });
  }
  const consentimiento = body.consentimiento && typeof body.consentimiento === "object" ? body.consentimiento : null;
  return {
    metodoPagoCodigo,
    motivo,
    consentimiento: consentimiento
      ? {
        metodo: cleanText(consentimiento.metodo ?? consentimiento.medio)?.toLowerCase(),
        referencia: cleanText(consentimiento.referencia),
        confirmado: consentimiento.confirmado === true || consentimiento.confirmed === true,
      }
      : null,
  };
}

export function assertAdminBenefitRequestAllowed(normalized = {}, adminContext = {}) {
  const benefits = normalized.beneficios || {};
  if (benefits.promocionManualId && !adminContext.isSuperAdmin) {
    throw new AppError(403, "Admin no puede seleccionar promociones manuales", {
      code: "ADMIN_BOOKING_MANUAL_PROMOTION_FORBIDDEN",
    });
  }
  if (benefits.promocionManualId && !benefits.promocionManualMotivo) {
    throw new AppError(422, "El motivo de promocion manual es obligatorio", {
      code: "ADMIN_BOOKING_MANUAL_PROMOTION_REASON_REQUIRED",
    });
  }
  if (benefits.cortesia?.aplicar && !adminContext.isSuperAdmin) {
    throw new AppError(403, "Admin no puede aplicar cortesias ni descuentos excepcionales", {
      code: "ADMIN_BOOKING_COURTESY_FORBIDDEN",
    });
  }
  if (benefits.cortesia?.aplicar) normalizeCourtesyRequest(benefits.cortesia);
  if (benefits.recompensa?.aplicar) normalizeRewardRequest(benefits.recompensa, adminContext);
}

function normalizeRewardRequest(reward = {}, adminContext = {}) {
  const consentimiento = reward.consentimiento && typeof reward.consentimiento === "object" ? reward.consentimiento : null;
  const confirmed = consentimiento?.confirmado === true || consentimiento?.confirmed === true;
  const method = cleanText(consentimiento?.medio ?? consentimiento?.metodo)?.toLowerCase();
  if (!confirmed || !REWARD_CONSENT_METHODS.has(method)) {
    throw new AppError(422, "La recompensa requiere consentimiento confirmado y medio valido", {
      code: "ADMIN_BOOKING_REWARD_CONSENT_REQUIRED",
    });
  }
  if (reward.excepcion_super_admin === true) {
    if (!adminContext.isSuperAdmin) {
      throw new AppError(403, "Solo super_admin puede usar excepciones de recompensa", {
        code: "ADMIN_BOOKING_REWARD_EXCEPTION_FORBIDDEN",
      });
    }
    if (!cleanText(reward.motivo_excepcion)) {
      throw new AppError(422, "El motivo de excepcion de recompensa es obligatorio", {
        code: "ADMIN_BOOKING_REWARD_EXCEPTION_REASON_REQUIRED",
      });
    }
  }
  if (cleanText(reward.canje_context_token ?? reward.id_points_tx_canje)) {
    throw new AppError(422, "El contexto de canje administrativo se resuelve internamente", {
      code: "ADMIN_BOOKING_REWARD_CONTEXT_TOKEN_FORBIDDEN",
    });
  }
  return {
    aplicar: true,
    consentimiento: {
      confirmado: true,
      medio: method,
      observacion: cleanText(consentimiento?.observacion ?? consentimiento?.referencia),
    },
    excepcionSuperAdmin: reward.excepcion_super_admin === true,
    motivoExcepcion: cleanText(reward.motivo_excepcion),
  };
}

function normalizeCourtesyRequest(courtesy = {}) {
  const type = String(courtesy.tipo || "").trim().toLowerCase();
  if (!["porcentaje", "monto", "total"].includes(type)) {
    throw new AppError(422, "El tipo de cortesia no es valido", {
      code: "ADMIN_BOOKING_COURTESY_TYPE_INVALID",
    });
  }
  const reason = cleanText(courtesy.motivo);
  if (!reason) {
    throw new AppError(422, "El motivo de cortesia es obligatorio", {
      code: "ADMIN_BOOKING_COURTESY_REASON_REQUIRED",
    });
  }
  const value = Number(courtesy.valor ?? (type === "total" ? 100 : NaN));
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(422, "El valor de cortesia no es valido", {
      code: "ADMIN_BOOKING_COURTESY_VALUE_INVALID",
    });
  }
  if (type === "porcentaje" && value > 100) {
    throw new AppError(422, "La cortesia porcentual no puede superar 100%", {
      code: "ADMIN_BOOKING_COURTESY_VALUE_INVALID",
    });
  }
  return { aplicar: true, tipo: type, valor: value, motivo: reason };
}

function cloneCoverageTracker(tracker) {
  if (!tracker || typeof tracker !== "object") return tracker;
  return {
    ...tracker,
    serviceRemaining: tracker.serviceRemaining instanceof Map ? new Map(tracker.serviceRemaining) : new Map(),
    requiredServiceIds: Array.isArray(tracker.requiredServiceIds) ? [...tracker.requiredServiceIds] : [],
    requiredServices: Array.isArray(tracker.requiredServices) ? tracker.requiredServices.map((item) => ({ ...item })) : [],
  };
}

function normalizeMoney(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Number(parsed.toFixed(2));
}

function normalizeNewClientPayload(raw = {}) {
  const persona = raw.persona && typeof raw.persona === "object" ? raw.persona : raw;
  const nombres = cleanText(persona.nombres ?? raw.nombres);
  const apellidos = cleanText(persona.apellidos ?? raw.apellidos);
  const telefono = normalizePhone(persona.telefono_principal ?? raw.telefono_principal ?? raw.telefono);
  const email = normalizeEmail(persona.correo_principal ?? raw.correo_principal ?? raw.email);
  if (!nombres) {
    throw new AppError(400, "cliente_nuevo.nombres es obligatorio", {
      code: "ADMIN_BOOKING_NEW_CUSTOMER_NAME_REQUIRED",
    });
  }
  if (!apellidos) {
    throw new AppError(400, "cliente_nuevo.apellidos es obligatorio", {
      code: "ADMIN_BOOKING_NEW_CUSTOMER_LASTNAME_REQUIRED",
    });
  }
  if (!telefono) {
    throw new AppError(400, "cliente_nuevo.telefono_principal es obligatorio", {
      code: "ADMIN_BOOKING_NEW_CUSTOMER_PHONE_REQUIRED",
    });
  }
  return {
    nombres,
    apellidos,
    telefono_principal: telefono,
    correo_principal: email,
    observaciones: cleanText(persona.observaciones ?? raw.observaciones),
  };
}

function normalizeAdminBookingBlock(raw = {}, index = 0) {
  const selectionType = String(raw.selection_type || raw.tipo_seleccion || "services").trim().toLowerCase();
  assertBookingSelectionCreationSupported(selectionType);
  const serviceIds = normalizeServiceIds(raw.servicios ?? raw.serviceIds ?? raw.id_servicios);
  if (!serviceIds.length && selectionType === "services") {
    throw new AppError(400, "Cada bloque debe incluir servicios", {
      code: "ADMIN_BOOKING_BLOCK_SERVICES_REQUIRED",
      details: { index },
    });
  }
  const fechaInicio = cleanText(raw.fecha_inicio ?? raw.inicio_at ?? raw.start_at);
  if (!fechaInicio) {
    throw new AppError(400, "Cada bloque debe incluir fecha_inicio", {
      code: "ADMIN_BOOKING_BLOCK_START_REQUIRED",
      details: { index },
    });
  }
  return {
    orden_integrante: Math.max(1, Math.trunc(Number(raw.orden_integrante || index + 1))),
    alias: cleanText(raw.alias) || (index === 0 ? "Titular" : `Acompanante ${index + 1}`),
    selection_type: selectionType,
    serviceIds,
    id_paquete: raw.id_paquete ? assertUuid(raw.id_paquete, "id_paquete") : null,
    fecha_inicio: fechaInicio,
    id_barbero: raw.id_barbero ? assertUuid(raw.id_barbero, "id_barbero") : null,
    notas: cleanText(raw.notas),
  };
}

function normalizeServiceIds(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((entry) => {
      if (entry && typeof entry === "object") {
        return entry.id_servicio ?? entry.value ?? entry.id;
      }
      return entry;
    })
    .filter(Boolean)
    .map((id) => assertUuid(id, "id_servicio"));
}

async function ensureAdminBranchAccess(app, client, claims, idSucursal, adminContext) {
  const branch = await ensureActiveBranch(client, idSucursal);
  if (adminContext.isSuperAdmin) return branch;
  const allowedBranchIds = await resolveBranchIdsForClaims(app, claims);
  if (!allowedBranchIds.includes(branch.id_sucursal)) {
    throw new AppError(403, "Admin solo puede agendar en sus sucursales asignadas", {
      code: "ADMIN_BOOKING_BRANCH_FORBIDDEN",
      details: { id_sucursal: branch.id_sucursal },
    });
  }
  return branch;
}

async function resolveExistingCustomer(client, idCliente) {
  const result = await client.query(
    `
      SELECT
        cl.id_cliente,
        cl.id_persona,
        cl.id_usuario,
        cl.id_sucursal_origen,
        p.nombres,
        p.apellidos,
        p.telefono_principal,
        cp.direccion_correo AS correo_principal
      FROM public.clientes cl
      JOIN public.personas p
        ON p.id_persona = cl.id_persona
       AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT direccion_correo
        FROM public.correos c
        WHERE c.id_persona = p.id_persona
          AND c.deleted_at IS NULL
        ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.created_at ASC
        LIMIT 1
      ) cp ON TRUE
      WHERE cl.id_cliente = $1::uuid
        AND cl.deleted_at IS NULL
        AND COALESCE(cl.estado, TRUE) IS TRUE
      LIMIT 1
    `,
    [idCliente]
  );
  const customer = result.rows[0] || null;
  if (!customer) {
    throw new AppError(404, "El cliente seleccionado no existe o esta inactivo", {
      code: "ADMIN_BOOKING_CUSTOMER_NOT_FOUND",
      details: { id_cliente: idCliente },
    });
  }
  return mapCustomerRow(customer);
}

async function ensureNewCustomerNotDuplicated(client, payload) {
  const result = await client.query(
    `
      SELECT cl.id_cliente
      FROM public.clientes cl
      JOIN public.personas p
        ON p.id_persona = cl.id_persona
       AND p.deleted_at IS NULL
      LEFT JOIN public.correos c
        ON c.id_persona = p.id_persona
       AND c.deleted_at IS NULL
      WHERE cl.deleted_at IS NULL
        AND COALESCE(cl.estado, TRUE) IS TRUE
        AND (
          p.telefono_principal = $1
          OR ($2::text IS NOT NULL AND lower(c.direccion_correo) = $2::text)
        )
      LIMIT 1
    `,
    [payload.telefono_principal, payload.correo_principal]
  );
  if (result.rows[0]) {
    throw new AppError(409, "Ya existe una ficha de cliente con ese telefono o correo", {
      code: "ADMIN_BOOKING_CUSTOMER_DUPLICATE",
      details: { id_cliente: result.rows[0].id_cliente },
    });
  }
}

async function createInternalCustomer(client, { idSucursal, payload }) {
  await ensureNewCustomerNotDuplicated(client, payload);
  const personaResult = await client.query(
    `
      INSERT INTO public.personas (
        nombres,
        apellidos,
        telefono_principal,
        observaciones
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id_persona, nombres, apellidos, telefono_principal
    `,
    [payload.nombres, payload.apellidos, payload.telefono_principal, payload.observaciones]
  );
  const persona = personaResult.rows[0];
  if (payload.correo_principal) {
    await client.query(
      `
        INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
        VALUES ($1::uuid, $2, TRUE, FALSE)
      `,
      [persona.id_persona, payload.correo_principal]
    );
  }
  const clienteResult = await client.query(
    `
      INSERT INTO public.clientes (
        id_persona,
        id_usuario,
        fecha_ingreso,
        id_sucursal_origen,
        estado
      )
      VALUES ($1::uuid, NULL, NOW(), $2::uuid, TRUE)
      RETURNING id_cliente, id_persona, id_usuario, id_sucursal_origen
    `,
    [persona.id_persona, idSucursal]
  );
  return mapCustomerRow({
    ...clienteResult.rows[0],
    nombres: persona.nombres,
    apellidos: persona.apellidos,
    telefono_principal: persona.telefono_principal,
    correo_principal: payload.correo_principal,
  });
}

function mapCustomerRow(row = {}) {
  const fullName = [row.nombres, row.apellidos].map(cleanText).filter(Boolean).join(" ").trim();
  return {
    id_cliente: row.id_cliente,
    id_persona: row.id_persona,
    id_usuario: row.id_usuario || null,
    id_sucursal_origen: row.id_sucursal_origen || null,
    nombres: row.nombres || null,
    apellidos: row.apellidos || null,
    nombre_completo: fullName || "Cliente",
    telefono_principal: row.telefono_principal || null,
    correo_principal: row.correo_principal || null,
  };
}

async function resolveCustomerForBooking(client, normalized, branch) {
  if (normalized.idCliente) return resolveExistingCustomer(client, normalized.idCliente);
  return createInternalCustomer(client, {
    idSucursal: branch.id_sucursal,
    payload: normalized.clienteNuevo,
  });
}

function parseIsoDateAndTime(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return { fecha: "", hora: "" };
  return {
    fecha: date.toISOString().slice(0, 10),
    hora: date.toISOString().slice(11, 16),
  };
}

async function buildAdminCanonicalOption(dbClient, {
  branch,
  customer,
  integrante,
  selection,
  index,
  app,
  request,
  adminContext,
  benefitContext,
}) {
  const isTitular = Number(integrante.orden_integrante || index + 1) <= 1;
  const coverage = consumeCoverageForServices(
    isTitular ? cloneCoverageTracker(benefitContext.coverageTracker) : null,
    selection.serviceSelection.items,
    { isTitular }
  );
  let rewardCoveredHnl = 0;
  if (isTitular && benefitContext.rewardRedeemContext) {
    const rewardServiceId = String(benefitContext.rewardRedeemContext.id_servicio_canje || "").trim();
    const rewardItem = coverage.items.find((item) => String(item?.id_servicio || "").trim() === rewardServiceId);
    if (!rewardItem) {
      throw new AppError(409, "El canje no corresponde al servicio seleccionado para el titular", {
        code: "POINTS_REDEEM_SERVICE_MISMATCH",
      });
    }
    rewardCoveredHnl = normalizeMoney(rewardItem.total_hnl ?? rewardItem.precio_unitario_hnl);
    rewardItem.coverage_status = "cubierto_recompensa";
    coverage.coveredTotalHnl = normalizeMoney(Number(coverage.coveredTotalHnl || 0) + rewardCoveredHnl);
    coverage.extraTotalHnl = normalizeMoney(Math.max(0, Number(coverage.extraTotalHnl || 0) - rewardCoveredHnl));
  }

  let totalPagar = normalizeMoney(coverage.extraTotalHnl);
  const membershipCoveredHnl = isTitular && !benefitContext.rewardRedeemContext
    ? normalizeMoney(coverage.coveredTotalHnl)
    : 0;
  const promoDateTime = normalizeOperationalDateTime(selection.startDateTime, "fecha_inicio");
  const promotionContext = {
    id_sucursal: branch.id_sucursal,
    id_empleado_barbero: selection.barber.id_empleado,
    id_cliente: customer.id_cliente,
    id_persona: customer.id_persona,
    id_grupo_cita: null,
    fecha_hora: promoDateTime.iso_utc,
    fecha: promoDateTime.fecha_operativa,
    fecha_operativa: promoDateTime.fecha_operativa,
    hora: promoDateTime.hora_operativa,
    subtotal_hnl: totalPagar,
    servicios: selection.serviceSelection.items || [],
    paquetes: selection.serviceSelection.id_paquete ? [{ id_paquete: selection.serviceSelection.id_paquete }] : [],
    codigo_promocional: request.body?.codigo_promocional || null,
    canal: "privado",
    es_cliente_autenticado: Boolean(customer.id_usuario),
    es_titular: isTitular,
  };
  let promotionsPreview = await previewPromotionsForAppointment(dbClient, promotionContext);
  promotionsPreview = applyManualPromotionSelection(promotionsPreview, {
    benefits: benefitContext.benefits,
    adminContext,
  });
  const promotionDiscountHnl = promotionsPreview.usedFallbackLegacy ? 0 : normalizeMoney(promotionsPreview.descuento_total_hnl);
  totalPagar = normalizeMoney(Math.max(0, totalPagar - promotionDiscountHnl));

  const courtesy = isTitular
    ? calculateCourtesyDiscount(benefitContext.benefits.cortesia, totalPagar)
    : null;
  const courtesyDiscountHnl = normalizeMoney(courtesy?.descuento_hnl || 0);
  totalPagar = normalizeMoney(Math.max(0, totalPagar - courtesyDiscountHnl));
  const discountTotal = normalizeMoney(membershipCoveredHnl + rewardCoveredHnl + promotionDiscountHnl + courtesyDiscountHnl);

  const detailRows = buildAppointmentDetailRows(selection.serviceSelection.items, {
    descuentoTotalHnl: discountTotal,
    origenItemCodigo: "admin_servicio_manual",
    ordenIntegrante: integrante.orden_integrante || index + 1,
    bookingIsvEnabled: app.config?.bookingIsvEnabled,
  });
  return {
    orden_integrante: integrante.orden_integrante || index + 1,
    id_persona: customer.id_persona,
    id_cliente: customer.id_cliente,
    id_usuario: customer.id_usuario,
    tipo_cliente_codigo: customer.id_usuario ? "autenticado" : "invitado",
    alias: integrante.alias,
    contacto_nombre: customer.nombre_completo,
    contacto_email: customer.correo_principal,
    contacto_telefono: customer.telefono_principal,
    id_empleado_barbero: selection.barber.id_empleado,
    barber_candidate_ids: selection.barber_candidate_ids,
    asignada_automaticamente: !integrante.id_barbero,
    es_canje_recompensa: Boolean(isTitular && benefitContext.rewardRedeemContext),
    selection,
    serviceItems: selection.serviceSelection.items,
    inicio_at: selection.startDateTime.toISOString(),
    notas: integrante.notas,
    detailRows,
    _branch_name: branch.nombre_sucursal,
    _response_totals: {
      subtotal_hnl: normalizeMoney(selection.serviceSelection.monto_subtotal_hnl ?? selection.serviceSelection.monto_total_hnl),
      descuento_hnl: discountTotal,
      total_hnl: totalPagar,
    },
    _benefits: {
      membershipCoveredHnl,
      rewardCoveredHnl,
      promotionDiscountHnl,
      courtesyDiscountHnl,
      coverage,
      promotionsContext: promotionContext,
      promotionsPreview,
      courtesy,
    },
    _dbClient: dbClient ? true : false,
  };
}

function applyManualPromotionSelection(preview = {}, { benefits = {}, adminContext = {} } = {}) {
  const manualId = benefits.promocionManualId;
  if (!manualId) return preview;
  if (!adminContext.isSuperAdmin) {
    throw new AppError(403, "Admin no puede seleccionar promociones manuales", {
      code: "ADMIN_BOOKING_MANUAL_PROMOTION_FORBIDDEN",
    });
  }
  const evaluated = Array.isArray(preview.evaluated) ? preview.evaluated : [];
  const selected = evaluated.find((row) => (
    String(row.id_promocion || "") === manualId || String(row.id_promocion_regla || "") === manualId
  ));
  if (!selected || selected.isValid !== true || Number(selected.descuento_calculado_hnl || 0) <= 0) {
    throw new AppError(422, "La promocion manual seleccionada no es aplicable", {
      code: "ADMIN_BOOKING_MANUAL_PROMOTION_NOT_APPLICABLE",
      details: { promocion_manual_id: manualId },
    });
  }
  const discarded = evaluated
    .filter((row) => row !== selected)
    .map((row) => row.isValid
      ? { ...row, reasonCode: "PROMOCION_MANUAL_NO_SELECCIONADA", reason: "Super admin selecciono otra promocion aplicable." }
      : row);
  return {
    ...buildPromotionResult(preview, { applied: [selected], discarded }),
    evaluated,
    selected_manual: {
      id_promocion: selected.id_promocion,
      id_promocion_regla: selected.id_promocion_regla,
      motivo: benefits.promocionManualMotivo,
    },
    usedFallbackLegacy: false,
  };
}

function calculateCourtesyDiscount(courtesyRequest = null, baseHnl = 0) {
  if (!courtesyRequest?.aplicar) return null;
  const request = normalizeCourtesyRequest(courtesyRequest);
  const base = normalizeMoney(baseHnl);
  let discount = 0;
  if (request.tipo === "total") discount = base;
  else if (request.tipo === "porcentaje") discount = normalizeMoney(base * (request.valor / 100));
  else if (request.tipo === "monto") discount = normalizeMoney(request.valor);
  discount = normalizeMoney(Math.min(base, discount));
  return {
    aplicada: discount > 0,
    tipo: request.tipo,
    valor: request.valor,
    motivo: request.motivo,
    descuento_hnl: discount,
    cubierto_hnl: discount,
  };
}

async function createCanonicalAdminReservation(app, dbClient, {
  request,
  requestId,
  normalized,
  branch,
  customer,
  adminContext,
}) {
  assertAdminBenefitRequestAllowed(normalized, adminContext);
  const benefitContext = await resolveAdminBenefitContext(dbClient, {
    branch,
    customer,
    normalized,
    adminContext,
  });
  const canonicalIntegrantes = [];
  for (let index = 0; index < normalized.integrantes.length; index += 1) {
    const integrante = normalized.integrantes[index];
    const selection = await resolveBookingSelection(dbClient, {
      id_sucursal: branch.id_sucursal,
      selection_type: integrante.selection_type,
      servicios: integrante.serviceIds,
      id_paquete: integrante.id_paquete,
      fecha_inicio: integrante.fecha_inicio,
      id_barbero: integrante.id_barbero,
      bookingIsvEnabled: app.config?.bookingIsvEnabled,
    });
    canonicalIntegrantes.push(await buildAdminCanonicalOption(dbClient, {
      branch,
      customer,
      integrante,
      selection,
      index,
      app,
      request,
      adminContext,
      benefitContext,
    }));
  }

  const canonicalPayload = buildCanonicalReservationPayload({
    requestId,
    idSucursal: branch.id_sucursal,
    idPersonaTitular: customer.id_persona,
    idClienteTitular: customer.id_cliente,
    idUsuarioTitular: customer.id_usuario,
    origenCodigo: ADMIN_BOOKING_ORIGIN_CODE,
    notas: normalized.notas,
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
    context: { route: "admin_citas_hold" },
  });

  const blocksByOrder = new Map((canonicalResult?.bloques || []).map((block) => [
    Number(block.orden_integrante || 0),
    block,
  ]));
  const initialState = {
    estadoCitaCodigo: "en_espera",
    estadoPagoCodigo: ADMIN_BOOKING_UNPAID_PAYMENT_STATE,
    confirmadoSinPago: false,
    estadoHoldCodigo: "activo",
  };
  const totalsByBenefit = selectedIntegrantes.reduce((acc, integrante) => {
    acc.membership += Number(integrante._benefits?.membershipCoveredHnl || 0);
    acc.reward += Number(integrante._benefits?.rewardCoveredHnl || 0);
    acc.promotion += Number(integrante._benefits?.promotionDiscountHnl || 0);
    acc.courtesy += Number(integrante._benefits?.courtesyDiscountHnl || 0);
    return acc;
  }, { membership: 0, reward: 0, promotion: 0, courtesy: 0 });
  for (const key of Object.keys(totalsByBenefit)) totalsByBenefit[key] = normalizeMoney(totalsByBenefit[key]);

  for (const integrante of selectedIntegrantes) {
    const preview = integrante._benefits?.promotionsPreview;
    if (!preview || preview.usedFallbackLegacy) continue;
    const block = blocksByOrder.get(Number(integrante.orden_integrante || 0));
    if (!block?.id_cita) continue;
    const detailRows = await loadCanonicalPromotionDetailRows(dbClient, {
      idCita: block.id_cita,
      detailRows: integrante.detailRows,
      canonicalBlock: block,
    });
    await recordPromotionApplications(
      dbClient,
      {
        ...integrante._benefits.promotionsContext,
        id_grupo_cita: canonicalResult.id_grupo_cita,
        id_cita: block.id_cita,
        id_cita_integrante: block.id_cita_integrante || block.id_integrante || null,
        detailRows,
      },
      preview,
      { formal: true, usageState: "reservado" }
    );
  }

  const bloques = selectedIntegrantes.map((integrante) => {
    const block = blocksByOrder.get(Number(integrante.orden_integrante || 0)) || {};
    const { fecha, hora } = parseIsoDateAndTime(integrante.selection.startDateTime);
    return {
      id_cita: block.id_cita || null,
      orden_integrante: integrante.orden_integrante,
      alias: integrante.alias,
      id_cliente: customer.id_cliente,
      id_barbero: block.id_empleado_barbero || integrante.selection.barber.id_empleado,
      nombre_barbero: integrante.selection.barber.nombre_completo,
      fecha,
      hora,
      fecha_inicio: integrante.selection.startDateTime.toISOString(),
      estado_cita_codigo: initialState.estadoCitaCodigo || block.estado_cita_codigo || "en_espera",
      monto_total_hnl: Number(block.monto_total_hnl ?? block.subtotal_hnl ?? 0),
      descuento_hnl: Number(block.descuento_hnl ?? 0),
      total_pagar_hnl: Number(block.total_pagar_hnl ?? block.total_hnl ?? 0),
      duracion_total_min: Number(integrante.selection.serviceSelection.duracion_total_min || 0),
      buffer_total_min: Number(integrante.selection.serviceSelection.buffer_total_min || 0),
    };
  });

  const responsePayload = buildCanonicalHoldResponse({
    requestId,
    canonicalResult,
    totals: selectedTotals,
    blocks: bloques,
    extensions: {
      origen_codigo: ADMIN_BOOKING_ORIGIN_CODE,
      metodo_pago_codigo: null,
      estado_pago_codigo: initialState.estadoPagoCodigo,
      estado_hold_codigo: initialState.estadoHoldCodigo,
      confirmado_sin_pago: initialState.confirmadoSinPago,
      beneficios: {
        membresia: buildMembershipResponse(benefitContext, totalsByBenefit.membership, selectedTotals.total_hnl),
        recompensa: buildRewardResponse(benefitContext, totalsByBenefit.reward, selectedTotals.total_hnl),
        promociones: buildPromotionsResponse(selectedIntegrantes, totalsByBenefit.promotion),
        cortesia: buildCourtesyResponse(selectedIntegrantes, totalsByBenefit.courtesy),
      },
      descuento_promocion_hnl: totalsByBenefit.promotion,
      descuento_membresia_hnl: totalsByBenefit.membership,
      descuento_recompensa_hnl: totalsByBenefit.reward,
      descuento_cortesia_hnl: totalsByBenefit.courtesy,
      cubierto_por_plan_hnl: totalsByBenefit.membership,
      cubierto_por_recompensa_hnl: totalsByBenefit.reward,
      cubierto_por_cortesia_hnl: totalsByBenefit.courtesy,
      monto_total_hnl: selectedTotals.subtotal_hnl,
      subtotal_hnl: selectedTotals.subtotal_hnl,
      descuento_total_hnl: selectedTotals.descuento_hnl,
      total_pagar_hnl: selectedTotals.total_hnl,
      extras_a_pagar_hnl: selectedTotals.total_hnl,
      total_hnl: selectedTotals.total_hnl,
      cliente: {
        id_cliente: customer.id_cliente,
        id_persona: customer.id_persona,
        id_usuario: customer.id_usuario,
        nombre_completo: customer.nombre_completo,
        telefono_principal: customer.telefono_principal,
        correo_principal: customer.correo_principal,
      },
      auditoria: {
        usuario_ejecutor: request.claims?.user?.id_usuario || null,
        rol: getPrimaryRole(request.claims),
        sucursal: branch.id_sucursal,
        motivo: normalized.motivo,
      },
    },
  });

  await persistAdminBenefitSummary(dbClient, {
    groupId: canonicalResult.id_grupo_cita,
    responsePayload,
    benefitContext,
    totalsByBenefit,
    selectedTotals,
  });
  await auditAdminBooking(dbClient, {
    request,
    requestId,
    branch,
    customer,
    responsePayload,
    normalized,
  });
  return responsePayload;
}

async function resolveAdminBenefitContext(dbClient, {
  branch,
  customer,
  normalized,
  adminContext,
}) {
  const benefits = normalized.beneficios || {};
  let rewardRedeemContext = null;
  const rewardRequest = benefits.recompensa?.aplicar
    ? normalizeRewardRequest(benefits.recompensa, adminContext)
    : null;
  const rewardGate = await resolveRewardRedeemGateForCliente(dbClient, {
    idCliente: customer.id_cliente,
    idSucursal: branch.id_sucursal,
  });
  if (rewardRequest?.aplicar && Number(rewardGate.recompensas_disponibles || 0) < 1) {
    throw new AppError(409, "El cliente no tiene recompensas disponibles", {
      code: "ADMIN_BOOKING_REWARD_NOT_AVAILABLE",
      details: rewardGate,
    });
  }
  if (rewardRequest?.aplicar) {
    const candidateServiceIds = [
      ...new Set((normalized.integrantes || []).flatMap((integrante) => integrante.serviceIds || []).filter(Boolean)),
    ];
    for (const candidateServiceId of candidateServiceIds) {
      try {
        rewardRedeemContext = await prepareRewardRedeemContextForHold(dbClient, {
          idCliente: customer.id_cliente,
          idSucursal: branch.id_sucursal,
          idServicioCanje: candidateServiceId,
        });
        break;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (!["POINTS_REDEEM_SERVICE_FORBIDDEN", "POINTS_REDEEM_SERVICE_BRANCH_MISSING"].includes(error.code)) {
          throw error;
        }
      }
    }
    if (!rewardRedeemContext) {
      throw new AppError(409, "No hay un servicio compatible para canjear la recompensa", {
        code: "ADMIN_BOOKING_REWARD_NO_COMPATIBLE_SERVICE",
      });
    }
  }

  let activeMembership;
  try {
    activeMembership = await ensureSubscriptionLifecycle(dbClient, customer.id_cliente, { forUpdate: true });
  } catch {
    activeMembership = { active: null, summary: null, time_remaining: null };
  }
  const coverageTracker = createCoverageTracker(activeMembership, {
    appointmentBranchId: branch.id_sucursal,
    planBranchName: null,
  });
  if (rewardRedeemContext) {
    coverageTracker.coverageEnabled = false;
    coverageTracker.coverageDisabledReason = "reward_redeem_active";
    coverageTracker.coverageDisabledMessage = "La recompensa activa desactiva cobertura de membresia para el titular.";
  }
  return {
    bookingChannel: "admin",
    executorUserId: adminContext.userId,
    executorRole: adminContext.role,
    beneficiaryClientId: customer.id_cliente,
    beneficiaryPersonId: customer.id_persona,
    beneficiaryUserId: customer.id_usuario,
    branchId: branch.id_sucursal,
    benefits,
    rewardRequest,
    rewardGate,
    rewardRedeemContext,
    activeMembership,
    coverageTracker,
  };
}

function buildMembershipResponse(context = {}, coveredHnl = 0, totalHnl = 0) {
  const tracker = context.coverageTracker || {};
  return {
    detectada: Boolean(tracker.hasPlan),
    aplicada: coveredHnl > 0,
    cobertura_activa: Boolean(tracker.coverageEnabled && coveredHnl > 0),
    id_suscripcion: tracker.idSuscripcion || null,
    id_sucursal_contratada: tracker.idSucursalContratada || null,
    servicios_cubiertos: Array.isArray(tracker.requiredServices) ? tracker.requiredServices : [],
    cubierto_hnl: normalizeMoney(coveredHnl),
    extras_a_pagar_hnl: normalizeMoney(totalHnl),
    motivo_no_aplica: coveredHnl > 0 ? null : (tracker.coverageDisabledReason || "sin_cobertura_aplicada"),
  };
}

function buildRewardResponse(context = {}, coveredHnl = 0, totalHnl = 0) {
  const reward = context.rewardRedeemContext;
  return {
    aplicada: Boolean(reward && coveredHnl > 0),
    canje_context_token: reward?.canje_context_token || null,
    servicio_nombre: reward?.servicio_nombre || null,
    puntos_requeridos: Number(reward?.puntos_requeridos || 0),
    saldo_anterior: Number(reward?.saldo_actual || context.rewardGate?.saldo_total || 0),
    puntos_reservados: reward ? Number(reward.puntos_requeridos || 0) : 0,
    saldo_resultante: reward ? Number(reward.saldo_actual || 0) : Number(context.rewardGate?.saldo_total || 0),
    cubierto_hnl: normalizeMoney(coveredHnl),
    extras_a_pagar_hnl: normalizeMoney(totalHnl),
    consentimiento: context.rewardRequest?.consentimiento || null,
    estado_redencion: reward ? "reservada_en_hold" : "no_aplicada",
  };
}

function buildPromotionsResponse(selectedIntegrantes = [], discountHnl = 0) {
  const previews = selectedIntegrantes.map((item) => item._benefits?.promotionsPreview).filter(Boolean);
  return {
    descuento_promocion_hnl: normalizeMoney(discountHnl),
    evaluadas: previews.flatMap((preview) => Array.isArray(preview.evaluated) ? preview.evaluated : []),
    aplicadas: previews.flatMap((preview) => Array.isArray(preview.promociones_aplicadas) ? preview.promociones_aplicadas : []),
    descartadas: previews.flatMap((preview) => Array.isArray(preview.promociones_descartadas) ? preview.promociones_descartadas : []),
    manual: previews.map((preview) => preview.selected_manual).find(Boolean) || null,
  };
}

function buildCourtesyResponse(selectedIntegrantes = [], discountHnl = 0) {
  const courtesy = selectedIntegrantes.map((item) => item._benefits?.courtesy).find(Boolean) || null;
  return {
    aplicada: Boolean(courtesy?.aplicada),
    descuento_hnl: normalizeMoney(discountHnl),
    cubierto_hnl: normalizeMoney(discountHnl),
    tipo: courtesy?.tipo || null,
    motivo: courtesy?.motivo || null,
  };
}

function buildCoverageSources(summary = {}) {
  const sources = [];
  if (normalizeMoney(summary.membresia_cubierto_hnl) > 0) sources.push("membresia");
  if (normalizeMoney(summary.recompensa_cubierto_hnl) > 0) sources.push("recompensa");
  if (normalizeMoney(summary.promocion_descuento_hnl) > 0) sources.push("promocion");
  if (normalizeMoney(summary.cortesia_cubierto_hnl) > 0) sources.push("cortesia");
  return sources;
}

function resolveFullCoverageSource(summary = {}) {
  if (normalizeMoney(summary.total_pagar_hnl) > 0) return null;
  const sources = buildCoverageSources(summary);
  if (!sources.length) return null;
  return sources.length === 1 ? sources[0] : "mixta";
}

function buildAdminBenefitSummary({
  responsePayload,
  benefitContext,
  totalsByBenefit,
  selectedTotals,
}) {
  const beneficios = responsePayload?.beneficios || {};
  const summary = {
    version: 1,
    id_grupo_cita: responsePayload?.id_grupo_cita || null,
    descuentos: {
      membresia_hnl: normalizeMoney(totalsByBenefit.membership),
      recompensa_hnl: normalizeMoney(totalsByBenefit.reward),
      promocion_hnl: normalizeMoney(totalsByBenefit.promotion),
      cortesia_hnl: normalizeMoney(totalsByBenefit.courtesy),
      total_hnl: normalizeMoney(selectedTotals.descuento_hnl),
    },
    cobertura: {
      fuentes: buildCoverageSources({
        membresia_cubierto_hnl: totalsByBenefit.membership,
        recompensa_cubierto_hnl: totalsByBenefit.reward,
        promocion_descuento_hnl: totalsByBenefit.promotion,
        cortesia_cubierto_hnl: totalsByBenefit.courtesy,
      }),
      fuente_cobertura_codigo: resolveFullCoverageSource({
        total_pagar_hnl: selectedTotals.total_hnl,
        membresia_cubierto_hnl: totalsByBenefit.membership,
        recompensa_cubierto_hnl: totalsByBenefit.reward,
        promocion_descuento_hnl: totalsByBenefit.promotion,
        cortesia_cubierto_hnl: totalsByBenefit.courtesy,
      }),
    },
    total_pagar_hnl: normalizeMoney(selectedTotals.total_hnl),
    subtotal_hnl: normalizeMoney(selectedTotals.subtotal_hnl),
    recompensa_context_token: benefitContext.rewardRedeemContext?.canje_context_token || null,
    cortesia_aplicada: Boolean(beneficios.cortesia?.aplicada),
    membresia_aplicada: Boolean(beneficios.membresia?.aplicada),
    recompensa_aplicada: Boolean(beneficios.recompensa?.aplicada),
    promocion_aplicada: normalizeMoney(totalsByBenefit.promotion) > 0,
    beneficios,
  };
  return summary;
}

async function persistAdminBenefitSummary(dbClient, {
  groupId,
  responsePayload,
  benefitContext,
  totalsByBenefit,
  selectedTotals,
}) {
  const summary = buildAdminBenefitSummary({
    responsePayload,
    benefitContext,
    totalsByBenefit,
    selectedTotals,
  });
  await dbClient.query(
    `
      INSERT INTO public.citas_admin_beneficios_resumen (
        id_grupo_cita,
        resumen_beneficios,
        descuento_membresia_hnl,
        descuento_recompensa_hnl,
        descuento_promocion_hnl,
        descuento_cortesia_hnl,
        total_pagar_hnl,
        recompensa_context_token,
        cortesia_aplicada,
        membresia_aplicada,
        recompensa_aplicada,
        promocion_aplicada
      )
      VALUES (
        $1::uuid,
        $2::jsonb,
        $3::numeric,
        $4::numeric,
        $5::numeric,
        $6::numeric,
        $7::numeric,
        $8::text,
        $9::boolean,
        $10::boolean,
        $11::boolean,
        $12::boolean
      )
      ON CONFLICT (id_grupo_cita) DO UPDATE
      SET resumen_beneficios = EXCLUDED.resumen_beneficios,
          descuento_membresia_hnl = EXCLUDED.descuento_membresia_hnl,
          descuento_recompensa_hnl = EXCLUDED.descuento_recompensa_hnl,
          descuento_promocion_hnl = EXCLUDED.descuento_promocion_hnl,
          descuento_cortesia_hnl = EXCLUDED.descuento_cortesia_hnl,
          total_pagar_hnl = EXCLUDED.total_pagar_hnl,
          recompensa_context_token = EXCLUDED.recompensa_context_token,
          cortesia_aplicada = EXCLUDED.cortesia_aplicada,
          membresia_aplicada = EXCLUDED.membresia_aplicada,
          recompensa_aplicada = EXCLUDED.recompensa_aplicada,
          promocion_aplicada = EXCLUDED.promocion_aplicada,
          updated_at = now()
    `,
    [
      groupId,
      JSON.stringify(summary),
      summary.descuentos.membresia_hnl,
      summary.descuentos.recompensa_hnl,
      summary.descuentos.promocion_hnl,
      summary.descuentos.cortesia_hnl,
      summary.total_pagar_hnl,
      summary.recompensa_context_token,
      summary.cortesia_aplicada,
      summary.membresia_aplicada,
      summary.recompensa_aplicada,
      summary.promocion_aplicada,
    ]
  );
  return summary;
}

async function loadAdminHoldBenefitSummary(client, groupId) {
  const result = await client.query(
    `
      SELECT
        resumen_beneficios,
        COALESCE(descuento_membresia_hnl, 0)::numeric AS descuento_membresia_hnl,
        COALESCE(descuento_recompensa_hnl, 0)::numeric AS descuento_recompensa_hnl,
        COALESCE(descuento_promocion_hnl, 0)::numeric AS descuento_promocion_hnl,
        COALESCE(descuento_cortesia_hnl, 0)::numeric AS descuento_cortesia_hnl,
        COALESCE(total_pagar_hnl, 0)::numeric AS total_pagar_hnl,
        recompensa_context_token,
        COALESCE(cortesia_aplicada, FALSE) AS cortesia_aplicada,
        COALESCE(membresia_aplicada, FALSE) AS membresia_aplicada,
        COALESCE(recompensa_aplicada, FALSE) AS recompensa_aplicada,
        COALESCE(promocion_aplicada, FALSE) AS promocion_aplicada
      FROM public.citas_admin_beneficios_resumen
      WHERE id_grupo_cita = $1::uuid
      LIMIT 1
      FOR UPDATE
    `,
    [groupId]
  );
  const row = result.rows[0] || null;
  if (!row) {
    throw new AppError(409, "El hold administrativo no tiene resumen financiero persistido", {
      code: "ADMIN_BOOKING_BENEFIT_SUMMARY_MISSING",
    });
  }
  return {
    resumen_beneficios: row.resumen_beneficios || {},
    membresia_cubierto_hnl: normalizeMoney(row.descuento_membresia_hnl),
    recompensa_cubierto_hnl: normalizeMoney(row.descuento_recompensa_hnl),
    promocion_descuento_hnl: normalizeMoney(row.descuento_promocion_hnl),
    cortesia_cubierto_hnl: normalizeMoney(row.descuento_cortesia_hnl),
    total_pagar_hnl: normalizeMoney(row.total_pagar_hnl),
    recompensa_context_token: cleanText(row.recompensa_context_token),
    cortesia_aplicada: row.cortesia_aplicada === true,
    membresia_aplicada: row.membresia_aplicada === true,
    recompensa_aplicada: row.recompensa_aplicada === true,
    promocion_aplicada: row.promocion_aplicada === true,
  };
}

async function auditAdminBooking(client, {
  request,
  requestId,
  branch,
  customer,
  responsePayload,
  normalized,
}) {
  await client.query(
    `
      INSERT INTO public.seguridad_audit_logs (
        id_usuario,
        accion,
        entidad,
        entidad_id,
        resultado,
        motivo_codigo,
        ip,
        request_id,
        metadata
      )
      VALUES (
        $1::uuid,
        'admin_booking_hold_created',
        'citas_grupos',
        $2::text,
        'success',
        $3::text,
        $4::inet,
        $5::text,
        jsonb_build_object(
          'rol', $6::text,
          'id_sucursal', $7::uuid,
          'id_cliente', $8::uuid,
          'id_persona', $9::uuid,
          'metodo_pago_codigo', $10::text,
          'total_pagar_hnl', $11::numeric,
          'bloques_count', $12::int
        )
      )
    `,
    [
      request.claims?.user?.id_usuario || null,
      responsePayload.id_grupo_cita,
      normalized.motivo || "agendamiento_interno_asistido",
      request.ip || null,
      requestId,
      getPrimaryRole(request.claims),
      branch.id_sucursal,
      customer.id_cliente,
      customer.id_persona,
      normalized.metodoPagoCodigo || null,
      Number(responsePayload.total_pagar_hnl || 0),
      Array.isArray(responsePayload.bloques) ? responsePayload.bloques.length : 0,
    ]
  );
}

async function auditAdminBookingAction(client, {
  request,
  groupId,
  action,
  result = "success",
  metadata = {},
  motivo = null,
}) {
  await client.query("SAVEPOINT sp_admin_booking_action_audit");
  try {
    await client.query(
      `
        INSERT INTO public.seguridad_audit_logs (
          id_usuario,
          accion,
          entidad,
          entidad_id,
          resultado,
          motivo_codigo,
          ip,
          request_id,
          metadata
        )
        VALUES ($1::uuid, $2::text, 'citas_grupos', $3::text, $4::text, $5::text, $6::inet, $7::text, $8::jsonb)
      `,
      [
        request.claims?.user?.id_usuario || null,
        action,
        groupId,
        result,
        motivo,
        request.ip || null,
        request.id || null,
        JSON.stringify({
          rol: getPrimaryRole(request.claims),
          ...metadata,
        }),
      ]
    );
    await client.query("RELEASE SAVEPOINT sp_admin_booking_action_audit");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT sp_admin_booking_action_audit");
    await client.query("RELEASE SAVEPOINT sp_admin_booking_action_audit");
  }
}

async function loadAdminHoldGroup(app, client, request, groupId, adminContext) {
  const groupResult = await client.query(
    `
      SELECT
        cg.id_grupo_cita,
        cg.estado_grupo_codigo
      FROM public.citas_grupos cg
      WHERE cg.id_grupo_cita = $1::uuid
      FOR UPDATE
    `,
    [groupId]
  );
  const group = groupResult.rows[0];
  if (!group) {
    throw new AppError(404, "No encontramos el hold administrativo indicado", {
      code: "ADMIN_BOOKING_HOLD_NOT_FOUND",
    });
  }
  const summaryResult = await client.query(
    `
      SELECT
        MIN(c.id_sucursal)::uuid AS id_sucursal,
        MIN(c.id_cliente)::uuid AS id_cliente,
        MIN(c.id_persona)::uuid AS id_persona,
        COUNT(c.id_cita)::int AS citas_count,
        COALESCE(SUM(c.total_pagar_hnl), 0)::numeric AS total_pagar_hnl,
        BOOL_OR(c.estado_cita_codigo IN ('confirmada', 'completada')) AS has_confirmed,
        BOOL_OR(h.estado_hold_codigo = 'consumido') AS has_consumed_hold,
        BOOL_OR(h.estado_hold_codigo = 'activo') AS has_active_hold
      FROM public.citas_grupos cg
      JOIN public.citas c
        ON c.id_grupo_cita = cg.id_grupo_cita
       AND c.deleted_at IS NULL
      LEFT JOIN public.citas_holds h
        ON h.id_cita = c.id_cita
      WHERE cg.id_grupo_cita = $1::uuid
      GROUP BY cg.id_grupo_cita
    `,
    [groupId]
  );
  Object.assign(group, summaryResult.rows[0] || {});
  await ensureAdminBranchAccess(app, client, request.claims, group.id_sucursal, adminContext);
  return group;
}

async function getGroupAppointmentIds(client, groupId) {
  const result = await client.query(
    `
      SELECT id_cita
      FROM public.citas
      WHERE id_grupo_cita = $1::uuid
        AND deleted_at IS NULL
      ORDER BY orden_integrante NULLS LAST, created_at ASC
    `,
    [groupId]
  );
  return result.rows.map((row) => row.id_cita).filter(Boolean);
}

export async function createAdminBookingHold(app, request) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", {
      code: "DB_NOT_CONFIGURED",
    });
  }

  const adminContext = assertAdminBookingRole(request.claims);
  const normalized = normalizeAdminBookingBody(request.body);
  const requestId = resolveReservationRequestId(request.headers?.["x-idempotency-key"]);
  const requestFingerprint = buildReservationRequestFingerprint({
    scope: ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE,
    actor: {
      tipo: adminContext.role,
      id_usuario: adminContext.userId,
      id_sucursal: normalized.idSucursal,
    },
    body: request.body,
  });

  const dbClient = await app.db.connect();
  try {
    const idempotencyState = await getReservationIdempotencyState(dbClient, {
      requestId,
      scope: ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE,
      requestFingerprint,
    });
    const idempotencyStatus = assertKnownIdempotencyState(idempotencyState);
    if (idempotencyStatus === "completed") {
      return {
        requestId,
        statusCode: idempotencyState.statusCode || 201,
        data: {
          ...idempotencyState.data,
          request_id: idempotencyState.data?.request_id || requestId,
        },
      };
    }

    const branch = await ensureAdminBranchAccess(app, dbClient, request.claims, normalized.idSucursal, adminContext);
    const data = await createBookingHold({
      dbClient,
      operation: async () => {
        const customer = await resolveCustomerForBooking(dbClient, normalized, branch);
        const responsePayload = await createCanonicalAdminReservation(app, dbClient, {
          request,
          requestId,
          normalized,
          branch,
          customer,
          adminContext,
        });
        await finalizeReservationIdempotency(dbClient, {
          requestId,
          scope: ADMIN_BOOKING_HOLD_IDEMPOTENCY_SCOPE,
          requestFingerprint,
          responsePayload,
          statusCode: 201,
        });
        return responsePayload;
      },
    });
    return { requestId, statusCode: 201, data };
  } catch (error) {
    throw mapAdminBookingError(error, {
      safeMessage: "No se pudo crear el hold administrativo",
      code: "ADMIN_BOOKING_HOLD_CREATE_ERROR",
      details: { route: "admin_citas_hold" },
    });
  } finally {
    dbClient.release();
  }
}

export async function releaseAdminBookingHold(app, request) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", {
      code: "DB_NOT_CONFIGURED",
    });
  }
  const adminContext = assertAdminBookingRole(request.claims);
  const groupId = assertUuid(request.params?.idGrupoCita || request.params?.id_grupo_cita, "id_grupo_cita");
  const dbClient = await app.db.connect();
  try {
    await dbClient.query("BEGIN");
    const group = await loadAdminHoldGroup(app, dbClient, request, groupId, adminContext);
    if (group.has_confirmed || group.has_consumed_hold || String(group.estado_grupo_codigo || "") === "completado") {
      throw new AppError(409, "El hold administrativo ya no puede liberarse", {
        code: "ADMIN_BOOKING_HOLD_RELEASE_FINAL_STATE",
      });
    }
    const citasResult = await dbClient.query(
      `
        UPDATE public.citas
        SET estado_cita_codigo = 'cancelada',
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
          AND deleted_at IS NULL
          AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
      `,
      [groupId]
    );
    const holdsResult = await dbClient.query(
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
    await revertPromotionUsages(dbClient, { id_grupo_cita: groupId });
    await auditAdminBookingAction(dbClient, {
      request,
      groupId,
      action: "admin_booking_hold_released",
      metadata: {
        id_sucursal: group.id_sucursal,
        citas_canceladas: Number(citasResult.rowCount || 0),
        holds_expirados: Number(holdsResult.rowCount || 0),
      },
    });
    await dbClient.query("COMMIT");
    return {
      id_grupo_cita: groupId,
      estado_hold_codigo: "expirado",
      estado_grupo_codigo: "cancelado",
      liberado: true,
      idempotent: Number(citasResult.rowCount || 0) === 0 && Number(holdsResult.rowCount || 0) === 0,
      citas_canceladas: Number(citasResult.rowCount || 0),
      holds_expirados: Number(holdsResult.rowCount || 0),
    };
  } catch (error) {
    try {
      await dbClient.query("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw mapAdminBookingError(error, {
      safeMessage: "No se pudo liberar el hold administrativo",
      code: "ADMIN_BOOKING_HOLD_RELEASE_ERROR",
      details: { route: "admin_citas_hold_release" },
    });
  } finally {
    dbClient.release();
  }
}

export async function confirmAdminBookingHold(app, request) {
  if (!app?.db) {
    throw new AppError(500, "Base de datos no configurada", {
      code: "DB_NOT_CONFIGURED",
    });
  }
  const adminContext = assertAdminBookingRole(request.claims);
  const groupId = assertUuid(request.params?.idGrupoCita || request.params?.id_grupo_cita, "id_grupo_cita");
  const normalized = normalizeAdminHoldCloseBody(request.body);

  const dbClient = await app.db.connect();
  try {
    await dbClient.query("BEGIN");
    const group = await loadAdminHoldGroup(app, dbClient, request, groupId, adminContext);
    if (!group.has_active_hold || group.has_consumed_hold) {
      throw new AppError(409, "El hold administrativo no esta activo", {
        code: "ADMIN_BOOKING_HOLD_NOT_ACTIVE",
      });
    }
    const appointmentIds = await getGroupAppointmentIds(dbClient, groupId);
    if (!appointmentIds.length) {
      throw new AppError(409, "El hold administrativo no tiene citas asociadas", {
        code: "ADMIN_BOOKING_HOLD_EMPTY",
      });
    }

    const benefitSummary = await loadAdminHoldBenefitSummary(dbClient, groupId);
    const estadoPagoCodigo = ADMIN_BOOKING_UNPAID_PAYMENT_STATE;
    const fuenteCoberturaCodigo = resolveFullCoverageSource(benefitSummary);
    const fuentesCobertura = buildCoverageSources(benefitSummary);
    let rewardFinalization = null;
    if (normalized.metodoPagoCodigo === "efectivo") {
      await confirmAppointmentsWithoutPayment(dbClient, {
        citas: appointmentIds,
        motivo_confirmacion: "admin_efectivo_pendiente",
      });
    } else {
      await confirmAppointmentsWithoutPayment(dbClient, {
        citas: appointmentIds,
        motivo_confirmacion: "admin_confirmacion_sin_pago",
      });
    }
    if (benefitSummary.recompensa_aplicada) {
      if (!benefitSummary.recompensa_context_token) {
        throw new AppError(409, "El hold administrativo no tiene contexto de recompensa persistido", {
          code: "ADMIN_BOOKING_REWARD_CONTEXT_MISSING",
        });
      }
      rewardFinalization = await applyRewardRedeemForConfirmedGroup(dbClient, {
        idGrupoCita: groupId,
        idCliente: group.id_cliente,
        canjeContextToken: benefitSummary.recompensa_context_token,
        motivo: normalized.motivo || "Canje administrativo con consentimiento",
        createdByUserId: adminContext.userId,
      });
    }
    await dbClient.query(
      `
        UPDATE public.citas_grupos
        SET estado_grupo_codigo = 'completado',
            updated_at = now()
        WHERE id_grupo_cita = $1::uuid
      `,
      [groupId]
    );
    await markPromotionUsagesForGroup(dbClient, {
      id_grupo_cita: groupId,
      id_cliente: group.id_cliente,
      id_persona: group.id_persona,
    });
    await auditAdminBookingAction(dbClient, {
      request,
      groupId,
      action: "admin_booking_hold_confirmed",
      motivo: normalized.motivo || normalized.metodoPagoCodigo,
      metadata: {
        id_sucursal: group.id_sucursal,
        metodo_pago_codigo: normalized.metodoPagoCodigo,
        estado_pago_codigo: estadoPagoCodigo,
        fuente_cobertura_codigo: fuenteCoberturaCodigo,
        fuentes_cobertura: fuentesCobertura,
        consentimiento: normalized.consentimiento,
        recompensa_utilizada: rewardFinalization,
        beneficios_resumen: benefitSummary.resumen_beneficios,
        total_pagar_hnl: Number(benefitSummary.total_pagar_hnl || group.total_pagar_hnl || 0),
      },
    });
    await dbClient.query("COMMIT");
    return {
      id_grupo_cita: groupId,
      estado_cita_codigo: "confirmada",
      estado_pago_codigo: estadoPagoCodigo,
      metodo_pago_codigo: normalized.metodoPagoCodigo,
      estado_hold_codigo: "consumido",
      fuente_cobertura_codigo: fuenteCoberturaCodigo,
      fuentes_cobertura: fuentesCobertura,
      beneficios_resumen: benefitSummary.resumen_beneficios,
      total_pagar_hnl: Number(benefitSummary.total_pagar_hnl || group.total_pagar_hnl || 0),
      recompensa_utilizada: rewardFinalization,
      confirmado: true,
      pago_registrado: false,
      monto_cobrado_hnl: 0,
    };
  } catch (error) {
    try {
      await dbClient.query("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw mapAdminBookingError(error, {
      safeMessage: "No se pudo confirmar el hold administrativo",
      code: "ADMIN_BOOKING_HOLD_CONFIRM_ERROR",
      details: { route: "admin_citas_hold_confirm" },
    });
  } finally {
    dbClient.release();
  }
}

export async function createAdminBookingPaymentLink(app, request) {
  assertAdminBookingRole(request.claims);
  assertUuid(request.params?.idGrupoCita || request.params?.id_grupo_cita, "id_grupo_cita");
  if (hasForbiddenPaymentField(request.body)) {
    throw new AppError(400, "El flujo administrativo no recibe datos sensibles de tarjeta", {
      code: "ADMIN_BOOKING_CARD_DATA_FORBIDDEN",
    });
  }
  throw new AppError(409, "El proveedor de enlaces de pago administrativo no esta configurado", {
    code: "PAYMENT_LINK_PROVIDER_NOT_CONFIGURED",
    details: {
      delivery_status: "not_sent",
      payment_confirmed: false,
    },
  });
}
