import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  ensureActiveBranch,
  expireStaleAppointmentReservations,
  OCCUPIED_APPOINTMENT_STATES,
  assertUuid,
  getHoldDurationMinutes,
  getSystemParameters,
  parseSinglePackageId,
  parseDateOnly,
  normalizeOperationalDateTime,
  resolveBookingSelection,
} from "../../services/agendaService.js";
import { confirmAppointmentsWithoutPayment, confirmAppointmentWithoutPayment } from "../../services/appointmentConfirmationService.js";
import {
  createCoverageTracker,
  consumeMembershipForCompletedAppointment,
  consumeCoverageForServices,
  ensureSubscriptionLifecycle,
  filterCoverageTrackerByTariffServices,
  getClienteMembershipState,
} from "../../services/membershipService.js";
import {
  applyRewardRedeemForConfirmedGroup,
  grantEngagementPointsForConfirmedGroup,
  normalizeRedeemContextToken,
  resolveRewardRedeemGateForCliente,
  resolveRedeemContextForHold,
} from "../../services/pointsService.js";
import {
  assertBookingSelectionCreationSupported,
  createBookingGroup,
  createBookingReservation,
  updateBookingGroupTotal,
} from "../../services/bookingReservationService.js";
import {
  previewPromotionsForAppointment,
  markPromotionUsagesForGroup,
} from "../../services/promociones/promocionesService.js";
import { buildCanonicalDiscountLines, buildDiscountPlan } from "../../services/bookingDiscounts.js";

const CLIENT_ALLOWED_ROLES = ["cliente"];
const requestIdSchema = { type: "string" };
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVE_PAYMENT_INTENT_STATES = ["creado", "link_generado", "pendiente_confirmacion"];
const PENDING_EXPIRED_MESSAGE = "Esta reserva ya expiro. Agenda nuevamente.";

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

const citaResumenSchema = {
  type: "object",
  properties: {
    id_cita: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: ["string", "null"] },
    id_empleado_barbero: { type: "string", format: "uuid" },
    nombre_barbero: { type: ["string", "null"] },
    estado_cita_codigo: { type: "string" },
    inicio_at: { type: "string", format: "date-time" },
    fin_at: { type: "string", format: "date-time" },
    duracion_total_min: { type: "integer" },
    buffer_total_min: { type: "integer" },
    total_pagar_hnl: { type: "number" },
    notas: { type: ["string", "null"] },
    tipo_cita_visual: { type: "string" },
    tipo_cita_label: { type: "string" },
    es_canje_recompensa: { type: "boolean" },
    es_membresia: { type: "boolean" },
    tiene_acompanantes: { type: "boolean" },
  },
  required: [
    "id_cita",
    "id_sucursal",
    "nombre_sucursal",
    "id_empleado_barbero",
    "nombre_barbero",
    "estado_cita_codigo",
    "inicio_at",
    "fin_at",
    "duracion_total_min",
    "buffer_total_min",
    "total_pagar_hnl",
    "notas",
    "tipo_cita_visual",
    "tipo_cita_label",
    "es_canje_recompensa",
    "es_membresia",
    "tiene_acompanantes",
  ],
  additionalProperties: false,
};

const citaDetalleItemSchema = {
  type: "object",
  properties: {
    id_cita_detalle: { type: "string", format: "uuid" },
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: ["string", "null"] },
    id_tarifa: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    cantidad: { type: "integer" },
    duracion_min: { type: "integer" },
    buffer_min: { type: "integer" },
    precio_referencia_hnl: { type: "number" },
    precio_unitario_hnl: { type: "number" },
    subtotal_hnl: { type: "number" },
    descuento_hnl: { type: "number" },
    incluye_isv_snapshot: { type: "boolean" },
    isv_porcentaje: { type: "number" },
    isv_hnl: { type: "number" },
    total_linea_hnl: { type: "number" },
    origen_item_codigo: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: [
    "id_cita_detalle",
    "id_servicio",
    "nombre_servicio",
    "id_tarifa",
    "cantidad",
    "duracion_min",
    "buffer_min",
    "precio_referencia_hnl",
    "precio_unitario_hnl",
    "subtotal_hnl",
    "descuento_hnl",
    "incluye_isv_snapshot",
    "isv_porcentaje",
    "isv_hnl",
    "total_linea_hnl",
    "origen_item_codigo",
  ],
  additionalProperties: false,
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
    requestId: request.id,
  });
}

function buildSafeStepError(error) {
  return {
    message: error?.message || null,
    code: error?.code || null,
    constraint: error?.constraint || null,
    detail: error?.detail || null,
    table: error?.table || null,
    column: error?.column || null,
    routine: error?.routine || null,
    stack: error?.stack || null,
  };
}

function ensureClientContext(request) {
  const clienteId = request.claims?.cliente_id ?? null;
  const personaId = request.claims?.user?.id_persona ?? null;

  if (!clienteId || !personaId) {
    throw new AppError(409, "El usuario autenticado no tiene un perfil cliente activo", {
      code: "CITAS_CLIENT_CONTEXT_REQUIRED",
    });
  }

  return {
    clienteId,
    personaId,
    usuarioId: request.claims?.user?.id_usuario,
  };
}

function mapAppointmentRow(row) {
  return {
    id_cita: row.id_cita,
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal ?? null,
    id_empleado_barbero: row.id_empleado_barbero,
    nombre_barbero: row.nombre_barbero ?? null,
    estado_cita_codigo: row.estado_cita_codigo,
    inicio_at: new Date(row.inicio_at).toISOString(),
    fin_at: new Date(row.fin_at).toISOString(),
    duracion_total_min: Number(row.duracion_total_min ?? 0),
    buffer_total_min: Number(row.buffer_total_min ?? 0),
    total_pagar_hnl: Number(row.total_pagar_hnl ?? 0),
    notas: row.notas ?? null,
    tipo_cita_visual: String(row.tipo_cita_visual || "pago_normal"),
    tipo_cita_label: String(row.tipo_cita_label || "Pago normal"),
    es_canje_recompensa: Boolean(row.es_canje_recompensa),
    es_membresia: Boolean(row.es_membresia),
    tiene_acompanantes: Boolean(row.tiene_acompanantes),
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

async function listAppointmentRows(client, { clienteId, personaId, citaId = null, estado = null, fechaDesde = null, fechaHasta = null }) {
  const params = [clienteId, personaId];
  const conditions = [
    "c.deleted_at IS NULL",
    "(c.id_cliente = $1::uuid OR c.id_persona_cliente = $2::uuid)",
  ];

  if (citaId) {
    params.push(citaId);
    conditions.push(`c.id_cita = $${params.length}::uuid`);
  }
  if (estado) {
    params.push(estado);
    conditions.push(`c.estado_cita_codigo = $${params.length}`);
  }
  if (fechaDesde) {
    params.push(fechaDesde);
    conditions.push(`c.inicio_at >= ($${params.length}::date::timestamp AT TIME ZONE 'America/Tegucigalpa')`);
  }
  if (fechaHasta) {
    params.push(fechaHasta);
    conditions.push(`c.inicio_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'America/Tegucigalpa')`);
  }

  const { rows } = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_sucursal,
        s.nombre_sucursal,
        c.id_empleado_barbero,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Sin nombre') AS nombre_barbero,
        c.estado_cita_codigo,
        c.inicio_at,
        c.fin_at,
        c.duracion_total_min,
        c.buffer_total_min,
        c.total_pagar_hnl,
        c.notas,
        CASE
          WHEN c.estado_cita_codigo = 'pendiente_pago' THEN 'pendiente_pago'
          WHEN grp.group_has_reward THEN
            CASE
              WHEN grp.has_companions THEN 'cortesia_acompanantes'
              ELSE 'cortesia'
            END
          WHEN mem.is_membership THEN 'membresia'
          ELSE 'pago_normal'
        END AS tipo_cita_visual,
        CASE
          WHEN c.estado_cita_codigo = 'pendiente_pago' THEN 'Pendiente de pago'
          WHEN grp.group_has_reward THEN
            CASE
              WHEN grp.has_companions THEN 'Cortesía + acompañantes'
              ELSE 'Cortesía'
            END
          WHEN mem.is_membership THEN 'Membresía'
          ELSE 'Pago normal'
        END AS tipo_cita_label,
        grp.group_has_reward AS es_canje_recompensa,
        mem.is_membership AS es_membresia,
        grp.has_companions AS tiene_acompanantes
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      LEFT JOIN LATERAL (
        SELECT
          EXISTS (
            SELECT 1
            FROM public.citas cg
            WHERE cg.id_grupo_cita = c.id_grupo_cita
              AND cg.deleted_at IS NULL
              AND COALESCE(cg.es_canje_recompensa, FALSE) IS TRUE
          ) AS group_has_reward,
          EXISTS (
            SELECT 1
            FROM public.citas ci
            WHERE ci.id_grupo_cita = c.id_grupo_cita
              AND ci.deleted_at IS NULL
              AND COALESCE(ci.orden_integrante, 1) > 1
          ) AS has_companions
      ) grp ON TRUE
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM public.subscription_consumptions sc
          WHERE sc.id_cita = c.id_cita
        ) AS is_membership
      ) mem ON TRUE
      WHERE ${conditions.join(" AND ")}
      ORDER BY c.inicio_at DESC, c.id_cita DESC
    `,
    params
  );

  return rows;
}

async function getAppointmentDetails(client, citaId) {
  const { rows } = await client.query(
    `
      SELECT
        cd.id_cita_detalle,
        cd.id_servicio,
        COALESCE(
          NULLIF(cd.nombre_servicio_snapshot, ''),
          s.nombre_servicio,
          'Servicio no disponible'
        ) AS nombre_servicio,
        cd.id_tarifa,
        cd.cantidad,
        cd.duracion_min,
        cd.buffer_min,
        cd.precio_referencia_hnl,
        cd.precio_unitario_hnl,
        cd.subtotal_hnl,
        cd.descuento_hnl,
        cd.incluye_isv_snapshot,
        cd.isv_porcentaje,
        cd.isv_hnl,
        cd.total_linea_hnl,
        cd.origen_item_codigo
      FROM public.citas_detalles cd
      LEFT JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      WHERE cd.id_cita = $1::uuid
      ORDER BY nombre_servicio ASC, cd.id_cita_detalle ASC
    `,
    [citaId]
  );

  return rows.map((row) => ({
    id_cita_detalle: row.id_cita_detalle,
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio ?? null,
    id_tarifa: row.id_tarifa ?? null,
    cantidad: Number(row.cantidad ?? 1),
    duracion_min: Number(row.duracion_min),
    buffer_min: Number(row.buffer_min ?? 0),
    precio_referencia_hnl: Number(row.precio_referencia_hnl ?? 0),
    precio_unitario_hnl: Number(row.precio_unitario_hnl ?? 0),
    subtotal_hnl: Number(row.subtotal_hnl ?? 0),
    descuento_hnl: Number(row.descuento_hnl ?? 0),
    incluye_isv_snapshot: row.incluye_isv_snapshot === true,
    isv_porcentaje: Number(row.isv_porcentaje ?? 0),
    isv_hnl: Number(row.isv_hnl ?? 0),
    total_linea_hnl: Number(row.total_linea_hnl ?? row.subtotal_hnl ?? 0),
    origen_item_codigo: row.origen_item_codigo ?? null,
  }));
}

function buildCoverageDiscountAllocations(discountLines = [], coverage = {}, {
  idSuscripcion = null,
  rewardSourceId = null,
} = {}) {
  const lines = (Array.isArray(discountLines) ? discountLines : []).map((line) => ({
    ...line,
    remaining_hnl: Number(line.base_disponible_hnl ?? line.subtotal_hnl ?? 0),
  }));
  const allocations = [];
  for (const item of Array.isArray(coverage?.items) ? coverage.items : []) {
    const status = String(item?.coverage_status || "").trim().toLowerCase();
    if (status !== "cubierto_plan" && status !== "cubierto_recompensa") continue;
    const serviceId = String(item?.id_servicio || "").trim();
    let remaining = Number(Number(item?.total_hnl ?? item?.precio_unitario_hnl ?? 0).toFixed(2));
    if (!serviceId || remaining <= 0) continue;
    const sourceType = status === "cubierto_recompensa" ? "reward" : "membership";
    const sourceId = sourceType === "reward" ? rewardSourceId : idSuscripcion;
    for (const line of lines) {
      if (remaining <= 0) break;
      if (String(line.id_servicio || "").trim() !== serviceId) continue;
      const capacity = Number(Number(line.remaining_hnl || 0).toFixed(2));
      if (capacity <= 0) continue;
      const discount = Number(Math.min(capacity, remaining).toFixed(2));
      allocations.push({
        line_key: line.line_key,
        source_type: sourceType,
        source_id: sourceId || null,
        descuento_hnl: discount,
      });
      line.remaining_hnl = Number((capacity - discount).toFixed(2));
      remaining = Number((remaining - discount).toFixed(2));
    }
    if (remaining > 0) {
      throw new AppError(409, "No se pudo asignar la cobertura a las lineas de la cita", {
        code: "BOOKING_DISCOUNT_ALLOCATION_INCOMPLETE",
      });
    }
  }
  return allocations;
}

function applyPlanAsPreviousDiscount(discountLines = [], discountPlan = new Map()) {
  return (Array.isArray(discountLines) ? discountLines : []).map((line) => {
    const previous = Number(discountPlan.get(line.line_key)?.descuento_total_hnl || 0);
    return {
      ...line,
      descuento_previo_hnl: previous,
      base_disponible_hnl: Number(Math.max(0, Number(line.subtotal_hnl || 0) - previous).toFixed(2)),
    };
  });
}

function isPointsTriggerCompileError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code !== "0A000") return false;
  const message = String(error?.message || "").toLowerCase();
  const where = String(error?.where || "").toLowerCase();
  return (
    message.includes("trigger functions can only be called as triggers")
    || where.includes("fn_trg_otorgar_puntos_por_cita")
    || where.includes("fn_trg_otorgar_puntos_plan_confirmada")
  );
}

async function expireReservationsBestEffort(dbClient, request, scope = "citas") {
  try {
    await expireStaleAppointmentReservations(dbClient, { logger: request.log });
  } catch (error) {
    request.log.warn(
      {
        requestId: request.id,
        scope,
        code: error?.code || null,
        message: error?.message || null,
      },
      "No se pudieron expirar reservas vencidas; se continua con la operacion"
    );
  }
}

async function getBranchNameById(client, idSucursal) {
  const id = String(idSucursal || "").trim();
  if (!id) return null;
  const { rows } = await client.query(
    `
      SELECT nombre_sucursal
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
      LIMIT 1
    `,
    [id]
  );
  return rows[0]?.nombre_sucursal ? String(rows[0].nombre_sucursal).trim() : null;
}

async function getGroupAppointmentsForNoPaymentConfirmation(client, { groupId }) {
  const { rows } = await client.query(
    `
      SELECT
        c.id_cita,
        c.id_sucursal,
        c.orden_integrante,
        c.estado_cita_codigo,
        COALESCE(c.es_canje_recompensa, FALSE) AS es_canje_recompensa,
        COALESCE(c.total_pagar_hnl, 0)::numeric AS total_pagar_hnl,
        hold.id_hold,
        hold.estado_hold_codigo,
        hold.expires_at
      FROM public.citas c
      LEFT JOIN LATERAL (
        SELECT h.id_hold, h.estado_hold_codigo, h.expires_at
        FROM public.citas_holds h
        WHERE h.id_cita = c.id_cita
        ORDER BY h.created_at DESC
        LIMIT 1
      ) hold ON TRUE
      WHERE c.id_grupo_cita = $1::uuid
        AND c.deleted_at IS NULL
      ORDER BY c.orden_integrante ASC, c.created_at ASC
    `,
    [groupId]
  );

  return rows;
}

async function getGroupAppointmentConfirmationDetails(client, { groupId }) {
  try {
    const { rows } = await client.query(
      `
        SELECT
          c.id_cita,
          c.estado_cita_codigo,
          c.alias_integrante,
          c.orden_integrante,
          c.contacto_nombre,
          c.contacto_email,
          c.inicio_at,
          COALESCE(c.total_pagar_hnl, 0)::numeric AS monto_total_hnl,
          COALESCE(c.total_pagar_hnl, 0)::numeric AS total_pagar_hnl,
          s.nombre_sucursal,
          COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Barbero') AS nombre_barbero
        FROM public.citas c
        JOIN public.sucursales s
          ON s.id_sucursal = c.id_sucursal
        JOIN public.empleados eb
          ON eb.id_empleado = c.id_empleado_barbero
        JOIN public.personas pb
          ON pb.id_persona = eb.id_persona
        WHERE c.id_grupo_cita = $1::uuid
          AND c.deleted_at IS NULL
        ORDER BY c.orden_integrante ASC, c.created_at ASC
      `,
      [groupId]
    );
    return rows;
  } catch (error) {
    if (error?.code !== "42703") throw error;
    const { rows } = await client.query(
      `
        SELECT
          c.id_cita,
          c.estado_cita_codigo,
          c.alias_integrante,
          c.orden_integrante,
          c.contacto_nombre,
          c.contacto_email,
          c.inicio_at,
          COALESCE(c.total_pagar_hnl, 0)::numeric AS monto_total_hnl,
          COALESCE(c.total_pagar_hnl, 0)::numeric AS total_pagar_hnl,
          NULL::text AS nombre_sucursal,
          NULL::text AS nombre_barbero
        FROM public.citas c
        WHERE c.id_grupo_cita = $1::uuid
          AND c.deleted_at IS NULL
        ORDER BY c.orden_integrante ASC, c.created_at ASC
      `,
      [groupId]
    );
    return rows;
  }
}

async function sendNoPaymentConfirmationEmails(app, logger, {
  groupId,
  confirmationRows,
} = {}) {
  if (!app.mailer?.configured) {
    return { emailEnviado: false, emailOmitido: "mailer_no_configurado" };
  }
  const rows = Array.isArray(confirmationRows) ? confirmationRows : [];
  if (!rows.length) {
    return { emailEnviado: false, emailOmitido: "sin_citas_confirmadas" };
  }

  const recipients = new Map();
  for (const row of rows) {
    const to = normalizeEmail(row?.contacto_email);
    if (!EMAIL_PATTERN.test(to)) continue;
    if (recipients.has(to)) continue;
    recipients.set(to, safeText(row?.contacto_nombre) || safeText(row?.alias_integrante) || "Cliente");
  }
  if (!recipients.size) {
    return { emailEnviado: false, emailOmitido: "sin_destinatario_valido" };
  }

  const bookingCode = buildBookingShortCode(groupId, 5);
  const totalCoveredHnl = rows.reduce((acc, row) => acc + Number(row?.monto_total_hnl || 0), 0);
  const detailLines = rows.map((row) => {
    const alias = safeText(row?.alias_integrante) || `Integrante ${Number(row?.orden_integrante || 1)}`;
    const whenLabel = formatDateTimeHn(row?.inicio_at);
    const branchLabel = safeText(row?.nombre_sucursal) || "Sucursal";
    const barberLabel = safeText(row?.nombre_barbero) || "Barbero";
    return `${alias}: ${whenLabel} en ${branchLabel} con ${barberLabel}`;
  });
  const senderFrom = resolvePaymentsFromAlias();

  let sentCount = 0;
  for (const [to, recipientName] of recipients.entries()) {
    try {
      const template = buildNoPaymentConfirmationEmailTemplate({
        recipientName,
        bookingCode,
        detailLines,
        totalCoveredHnl,
      });
      const delivery = await app.mailer.sendMail({
        to,
        subject: template.subject,
        text: template.text,
        html: template.html,
        from: senderFrom,
      });
      if (delivery?.sent) {
        sentCount += 1;
      } else {
        logger?.warn?.(
          { to, groupId, reason: safeText(delivery?.message) || "smtp_rechazo" },
          "No se pudo enviar correo de confirmacion de cita cubierta por plan"
        );
      }
    } catch (error) {
      logger?.warn?.(
        { err: error, to, groupId },
        "Fallo envio de correo de confirmacion de cita cubierta por plan"
      );
    }
  }

  if (sentCount > 0) {
    return { emailEnviado: true, emailOmitido: null };
  }
  return { emailEnviado: false, emailOmitido: "envio_fallido" };
}

async function getServicesWithActiveTariffByBranch(client, { idSucursal, serviceIds = [], fechaOperativa = null }) {
  const safeBranchId = String(idSucursal || "").trim();
  const normalizedServiceIds = (Array.isArray(serviceIds) ? serviceIds : [])
    .map((serviceId) => String(serviceId || "").trim())
    .filter(Boolean);
  if (!safeBranchId || normalizedServiceIds.length === 0) return [];
  const safeFechaOperativa = fechaOperativa ? parseDateOnly(fechaOperativa, "fecha_operativa") : null;

  const { rows } = await client.query(
    `
      WITH ranked_tariffs AS (
        SELECT
          st.id_servicio,
          ROW_NUMBER() OVER (
            PARTITION BY st.id_servicio
            ORDER BY
              CASE WHEN st.id_empleado IS NULL THEN 1 ELSE 0 END DESC,
              st.vigente_desde DESC,
              st.id_tarifa DESC
          ) AS row_num
        FROM public.servicios_tarifas st
        WHERE st.id_sucursal = $1::uuid
          AND st.id_servicio = ANY($2::uuid[])
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND st.vigente_desde <= COALESCE($3::date, (now() AT TIME ZONE 'America/Tegucigalpa')::date)
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= COALESCE($3::date, (now() AT TIME ZONE 'America/Tegucigalpa')::date))
      )
      SELECT id_servicio
      FROM ranked_tariffs
      WHERE row_num = 1
    `,
    [safeBranchId, normalizedServiceIds, safeFechaOperativa]
  );

  return rows
    .map((row) => String(row.id_servicio || "").trim())
    .filter(Boolean);
}

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function parseIsoDateAndTime(rawDateTime) {
  try {
    const normalized = normalizeOperationalDateTime(rawDateTime, "fecha_inicio");
    return { fecha: normalized.fecha_operativa, hora: normalized.hora_operativa };
  } catch {
    return { fecha: null, hora: null };
  }
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

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

async function getClientPendingPaymentGroupRows(client, { clienteId, personaId, groupId = null }) {
  const params = [clienteId, personaId];
  const groupFilter = groupId ? "AND c.id_grupo_cita = $3::uuid" : "";
  if (groupId) params.push(groupId);

  const { rows } = await client.query(
    `
      SELECT
        c.id_grupo_cita,
        c.id_cita,
        c.orden_integrante,
        c.alias_integrante,
        c.estado_cita_codigo,
        c.inicio_at,
        c.total_pagar_hnl,
        c.id_sucursal,
        s.nombre_sucursal,
        c.id_empleado_barbero,
        COALESCE(NULLIF(TRIM(CONCAT(pb.nombres, ' ', pb.apellidos)), ''), 'Barbero') AS nombre_barbero,
        hold.id_hold,
        hold.estado_hold_codigo,
        hold.expires_at AS hold_expires_at,
        pi.id_intent,
        pi.estado_intent_codigo,
        pi.link_pago_url,
        pi.expires_at AS intent_expires_at,
        pi.monto_hnl AS intent_monto_hnl,
        pi.moneda_codigo AS intent_moneda_codigo
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
      LEFT JOIN LATERAL (
        SELECT h.id_hold, h.estado_hold_codigo, h.expires_at
        FROM public.citas_holds h
        WHERE h.id_cita = c.id_cita
        ORDER BY h.created_at DESC
        LIMIT 1
      ) hold ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          pi.id_intent,
          pi.estado_intent_codigo,
          pi.link_pago_url,
          pi.expires_at,
          pi.monto_hnl,
          pi.moneda_codigo
        FROM public.payment_intents pi
        WHERE pi.id_cita = c.id_cita
        ORDER BY pi.created_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE c.deleted_at IS NULL
        AND c.estado_cita_codigo = 'pendiente_pago'
        AND (c.id_cliente = $1::uuid OR c.id_persona_cliente = $2::uuid)
        ${groupFilter}
      ORDER BY c.created_at DESC, c.orden_integrante ASC
    `,
    params
  );

  return rows;
}

async function getServicesByAppointmentIds(client, citaIds = []) {
  const ids = Array.isArray(citaIds) ? citaIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `
      SELECT
        cd.id_cita,
        cd.id_cita_detalle,
        cd.id_servicio,
        COALESCE(
          NULLIF(cd.nombre_servicio_snapshot, ''),
          s.nombre_servicio,
          'Servicio no disponible'
        ) AS nombre_servicio,
        cd.id_tarifa,
        cd.cantidad,
        cd.duracion_min,
        cd.buffer_min,
        cd.precio_referencia_hnl,
        cd.precio_unitario_hnl,
        cd.subtotal_hnl,
        cd.descuento_hnl,
        cd.incluye_isv_snapshot,
        cd.isv_porcentaje,
        cd.isv_hnl,
        cd.total_linea_hnl,
        cd.origen_item_codigo
      FROM public.citas_detalles cd
      LEFT JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      WHERE cd.id_cita = ANY($1::uuid[])
      ORDER BY cd.created_at ASC, cd.id_cita_detalle ASC
    `,
    [ids]
  );

  const mapped = new Map();
  for (const row of rows) {
    const citaId = String(row.id_cita || "").trim();
    if (!citaId) continue;
    if (!mapped.has(citaId)) mapped.set(citaId, []);
    mapped.get(citaId).push({
      id_cita_detalle: row.id_cita_detalle,
      id_servicio: row.id_servicio,
      nombre_servicio: row.nombre_servicio ?? null,
      id_tarifa: row.id_tarifa ?? null,
      cantidad: Number(row.cantidad ?? 1),
      duracion_min: Number(row.duracion_min ?? 0),
      buffer_min: Number(row.buffer_min ?? 0),
      precio_referencia_hnl: Number(row.precio_referencia_hnl ?? 0),
      precio_unitario_hnl: Number(row.precio_unitario_hnl ?? 0),
      subtotal_hnl: Number(row.subtotal_hnl ?? 0),
      descuento_hnl: Number(row.descuento_hnl ?? 0),
      incluye_isv_snapshot: row.incluye_isv_snapshot === true,
      isv_porcentaje: Number(row.isv_porcentaje ?? 0),
      isv_hnl: Number(row.isv_hnl ?? 0),
      total_linea_hnl: Number(row.total_linea_hnl ?? row.subtotal_hnl ?? 0),
      origen_item_codigo: row.origen_item_codigo ?? null,
    });
  }
  return mapped;
}

async function getDiscardStateCode(client) {
  const { rows } = await client.query(
    `
      SELECT estado_cita_codigo
      FROM public.estados_cita
      WHERE estado_cita_codigo = 'cancelada_por_cliente'
      LIMIT 1
    `
  );
  if (rows[0]?.estado_cita_codigo) return "cancelada_por_cliente";

  // Mantiene compatibilidad operativa si el catalogo no fue sembrado aun en el entorno.
  await client.query(
    `
      INSERT INTO public.estados_cita (estado_cita_codigo, descripcion)
      VALUES ('cancelada_por_cliente', 'Cancelada por cliente desde historial de pendiente')
      ON CONFLICT (estado_cita_codigo) DO NOTHING
    `
  );
  const check = await client.query(
    `
      SELECT estado_cita_codigo
      FROM public.estados_cita
      WHERE estado_cita_codigo = 'cancelada_por_cliente'
      LIMIT 1
    `
  );
  if (check.rows[0]?.estado_cita_codigo) return "cancelada_por_cliente";
  return null;
}

async function markPendingGroupExpired(client, groupId) {
  await client.query(
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
  await client.query(
    `
      UPDATE public.payment_intents pi
      SET estado_intent_codigo = 'expirado',
          updated_at = now()
      FROM public.citas c
      WHERE c.id_grupo_cita = $1::uuid
        AND c.id_cita = pi.id_cita
        AND c.deleted_at IS NULL
        AND pi.estado_intent_codigo = ANY($2::text[])
    `,
    [groupId, ACTIVE_PAYMENT_INTENT_STATES]
  );
  await client.query(
    `
      UPDATE public.citas
      SET estado_cita_codigo = 'expirada',
          updated_at = now()
      WHERE id_grupo_cita = $1::uuid
        AND deleted_at IS NULL
        AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    `,
    [groupId]
  );
}

function buildPendingGroupPayload(groupRows, servicesByCita, { multiplePendingDetected = false } = {}) {
  const rows = Array.isArray(groupRows) ? groupRows : [];
  if (!rows.length) return null;
  const first = rows[0];
  const nowMs = Date.now();
  const holdExpiresMs = first?.hold_expires_at ? new Date(first.hold_expires_at).getTime() : NaN;
  const intentExpiresMs = first?.intent_expires_at ? new Date(first.intent_expires_at).getTime() : NaN;
  const holdActive = String(first?.estado_hold_codigo || "").trim().toLowerCase() === "activo";
  const intentActive = ACTIVE_PAYMENT_INTENT_STATES.includes(String(first?.estado_intent_codigo || "").trim().toLowerCase());
  const holdVigente = holdActive && Number.isFinite(holdExpiresMs) && holdExpiresMs > nowMs;
  const intentVigente = intentActive && Number.isFinite(intentExpiresMs) && intentExpiresMs > nowMs;
  const vigente = holdVigente && intentVigente;

  const citas = rows.map((row) => {
    const citaId = String(row.id_cita || "").trim();
    return {
      id_cita: row.id_cita,
      orden_integrante: Number(row.orden_integrante ?? 1),
      alias_integrante: row.alias_integrante ?? null,
      estado_cita_codigo: row.estado_cita_codigo,
      inicio_at: toIsoOrNull(row.inicio_at),
      id_sucursal: row.id_sucursal,
      nombre_sucursal: row.nombre_sucursal ?? null,
      id_empleado_barbero: row.id_empleado_barbero,
      nombre_barbero: row.nombre_barbero ?? null,
      total_pagar_hnl: Number(row.total_pagar_hnl ?? 0),
      servicios: servicesByCita.get(citaId) || [],
    };
  });

  const totalPendiente = rows.reduce((acc, row) => acc + Number(row.total_pagar_hnl ?? 0), 0);
  const firstDate = rows
    .map((row) => new Date(row.inicio_at))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    id_grupo_cita: first.id_grupo_cita,
    estado: vigente ? "pendiente_pago_vigente" : "expirada",
    vigente,
    multiple_pending_detected: multiplePendingDetected,
    total_pendiente_hnl: Number(totalPendiente.toFixed(2)),
    fecha_hora_referencia: firstDate ? firstDate.toISOString() : null,
    expires_at: toIsoOrNull(first.hold_expires_at),
    sucursal: {
      id_sucursal: first.id_sucursal,
      nombre_sucursal: first.nombre_sucursal ?? null,
    },
    payment_intent: first.id_intent ? {
      id_intent: first.id_intent,
      estado_intent_codigo: first.estado_intent_codigo ?? null,
      payment_url: first.link_pago_url ?? null,
      monto_hnl: Number(first.intent_monto_hnl ?? totalPendiente),
      moneda_codigo: first.intent_moneda_codigo ?? "HNL",
      expires_at: toIsoOrNull(first.intent_expires_at),
      vigente: intentVigente,
    } : null,
    citas,
  };
}

async function resolveClientPendingGroup(client, { clienteId, personaId, groupId = null } = {}) {
  const rows = await getClientPendingPaymentGroupRows(client, { clienteId, personaId, groupId });
  if (!rows.length) return { primary: null, groups: [] };

  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.id_grupo_cita || "").trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const groups = [...grouped.values()];
  const nowMs = Date.now();
  const withRank = groups.map((groupRows) => {
    const first = groupRows[0];
    const holdExpiresMs = first?.hold_expires_at ? new Date(first.hold_expires_at).getTime() : NaN;
    const intentExpiresMs = first?.intent_expires_at ? new Date(first.intent_expires_at).getTime() : NaN;
    const holdActive = String(first?.estado_hold_codigo || "").trim().toLowerCase() === "activo";
    const intentActive = ACTIVE_PAYMENT_INTENT_STATES.includes(String(first?.estado_intent_codigo || "").trim().toLowerCase());
    const vigente = holdActive
      && Number.isFinite(holdExpiresMs)
      && holdExpiresMs > nowMs
      && intentActive
      && Number.isFinite(intentExpiresMs)
      && intentExpiresMs > nowMs;
    const createdAtMs = groupRows
      .map((row) => new Date(row.inicio_at).getTime())
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0] || 0;
    return { groupRows, vigente, createdAtMs };
  });

  const ranked = withRank.sort((left, right) => {
    if (left.vigente !== right.vigente) return left.vigente ? -1 : 1;
    return right.createdAtMs - left.createdAtMs;
  });
  return { primary: ranked[0] || null, groups: ranked };
}

async function consumeMembershipForConfirmedRows(client, request, {
  rows = [],
  clienteId,
  usuarioId,
} = {}) {
  const source = Array.isArray(rows) ? rows : [];
  for (const row of source) {
    if (Number(row?.orden_integrante || 1) > 1) continue;
    const citaId = String(row?.id_cita || "").trim();
    const branchId = String(row?.id_sucursal || "").trim();
    if (!citaId || !branchId) continue;
    try {
      await consumeMembershipForCompletedAppointment(client, {
        idCita: citaId,
        idCliente: clienteId,
        idSucursal: branchId,
        ordenIntegrante: Number(row?.orden_integrante || 1),
        usuarioEjecutorId: usuarioId || null,
      });
    } catch (membershipError) {
      request.log.warn(
        {
          requestId: request.id,
          id_grupo_cita: String(row?.id_grupo_cita || ""),
          id_cita: citaId,
          code: membershipError?.code || null,
          message: membershipError?.message || null,
        },
        "No se pudo registrar consumo de membresia para cita confirmada"
      );
    }
  }
}

function safeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function hashString(value) {
  const source = String(value || "");
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function buildBookingShortCode(value, length = 5) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "N/A";
  const safeLength = Math.max(3, Math.min(5, Number(length) || 5));
  const maxValue = 36 ** safeLength;
  const hashed = hashString(normalized) % maxValue;
  return hashed
    .toString(36)
    .toUpperCase()
    .padStart(safeLength, "0")
    .slice(-safeLength);
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolvePaymentsFromAlias() {
  const fromAddress = safeText(process.env.SMTP_FROM_PAYMENTS) || safeText(process.env.SMTP_FROM) || null;
  if (!fromAddress) return null;
  if (fromAddress.includes("<")) return fromAddress;
  return `MasterFade Pagos <${fromAddress}>`;
}

function formatDateTimeHn(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "Fecha por confirmar";
  return parsed.toLocaleString("es-HN", { timeZone: HONDURAS_TIME_ZONE });
}

function buildNoPaymentConfirmationEmailTemplate({
  recipientName,
  bookingCode,
  detailLines,
  totalCoveredHnl,
} = {}) {
  const safeName = safeText(recipientName) || "Cliente";
  const safeCode = safeText(bookingCode) || "N/A";
  const coveredLabel = `HNL ${Number(totalCoveredHnl || 0).toFixed(2)}`;
  const details = Array.isArray(detailLines) ? detailLines : [];
  const detailText = details.map((line) => `- ${line}`);
  const detailHtml = details
    .map((line) => `<li style="margin:0 0 6px;color:#d9dce4;font-size:14px;line-height:1.6;">${escapeHtml(line)}</li>`)
    .join("");
  const subject = `Reserva confirmada #${safeCode}`;
  const text = [
    subject,
    "",
    `Hola ${safeName},`,
    "",
    "Tu cita fue confirmada y quedo cubierta por tu plan activo.",
    `Codigo de cita: ${safeCode}`,
    `Monto cubierto por tu plan: ${coveredLabel}`,
    "",
    "Detalle:",
    ...detailText,
  ].join("\n");
  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(subject)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#204231 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade Citas</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtml(subject)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">Hola ${escapeHtml(safeName)},</p>
                    <p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">Tu cita fue confirmada y quedo cubierta por tu plan activo.</p>
                    <div style="margin:0 0 14px;border:1px solid #2b2f3f;border-radius:12px;padding:10px 12px;background:#1a1f2e;">
                      <p style="margin:0;color:#f8f9fb;font-size:14px;font-weight:700;">Codigo de cita: ${escapeHtml(safeCode)}</p>
                      <p style="margin:6px 0 0;color:#5fd29b;font-size:14px;">Monto cubierto por tu plan: ${escapeHtml(coveredLabel)}</p>
                    </div>
                    <p style="margin:0 0 8px;color:#f4f6fb;font-size:14px;font-weight:600;">Detalle:</p>
                    <ul style="margin:0 0 10px 18px;padding:0;">${detailHtml}</ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
  return { subject, text, html };
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

  if (!year || !month || !day || !hour || !minute || !second) return null;

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
  const leftKey = [left.year, left.month, left.day, left.hour, left.minute, left.second];
  const rightKey = [right.year, right.month, right.day, right.hour, right.minute, right.second];
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
      code: error?.code || "CITAS_HOLD_INVALID_DATETIME",
      details: { field, value: rawDateTime, time_zone: HONDURAS_TIME_ZONE },
    });
  }

  const parsed = normalized.utcDate;
  const requestParts = getDateTimePartsInTimeZone(parsed, HONDURAS_TIME_ZONE);
  const nowParts = getDateTimePartsInTimeZone(new Date(), HONDURAS_TIME_ZONE);
  if (!requestParts || !nowParts) return parsed;

  if (compareDateTimeParts(requestParts, nowParts) < 0) {
    throw new AppError(400, `${field} no puede estar en el pasado`, {
      code: "CITAS_HOLD_PAST_DATETIME",
      details: { field, value: rawDateTime, time_zone: HONDURAS_TIME_ZONE },
    });
  }

  return parsed;
}

function normalizeHoldBlocksPayload(body) {
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
      fecha_inicio: body.fecha_inicio,
      servicios: body.servicios,
    }]
    : [];

  const rawBlocks = hasGroupedPayload ? body.integrantes : legacyPayload;
  if (!rawBlocks.length) {
    throw new AppError(400, "Debes enviar al menos un integrante para crear la reserva", {
      code: "CITAS_HOLD_BLOCKS_REQUIRED",
    });
  }

  return rawBlocks.map((item, index) => {
    const aliasFallback = index === 0 ? "Titular" : `Acompanante ${index}`;
    const alias = String(item?.alias || aliasFallback).trim().slice(0, 80) || aliasFallback;
    const ordenIntegrante = Number(item?.orden_integrante);
    const selectionType = String(item?.selection_type || "services").trim().toLowerCase();
    const servicios = Array.isArray(item?.servicios) ? item.servicios : [];
    const packageId = parseSinglePackageId(item?.id_paquete, { required: false, field: "id_paquete" });

    if (!["services", "package", "mixed"].includes(selectionType)) {
      throw new AppError(400, `El integrante ${alias} tiene un selection_type invalido`, {
        code: "CITAS_HOLD_BLOCK_SELECTION_TYPE_INVALID",
        details: { alias, index, selection_type: item?.selection_type ?? null },
      });
    }

    if ((selectionType === "services" || selectionType === "mixed") && !servicios.length && !packageId) {
      throw new AppError(400, `El integrante ${alias} no tiene servicios seleccionados`, {
        code: "CITAS_HOLD_BLOCK_SERVICES_REQUIRED",
        details: { alias, index },
      });
    }

    if ((selectionType === "package" || selectionType === "mixed") && !packageId && !servicios.length) {
      throw new AppError(400, `El integrante ${alias} no tiene paquete seleccionado`, {
        code: "CITAS_HOLD_BLOCK_PACKAGE_REQUIRED",
        details: { alias, index },
      });
    }

    const serviceIds = (selectionType === "services" || selectionType === "mixed")
      ? servicios.map((service) => assertUuid(service?.id_servicio, "id_servicio"))
      : [];
    const fechaInicio = String(item?.fecha_inicio || "").trim();
    assertDateTimeNotPastInHonduras(fechaInicio, "fecha_inicio");

    return {
      orden_integrante: Number.isFinite(ordenIntegrante) && ordenIntegrante > 0 ? Math.trunc(ordenIntegrante) : index + 1,
      alias,
      id_barbero: item?.id_barbero ? assertUuid(item.id_barbero, "id_barbero") : null,
      selection_type: selectionType,
      id_paquete: packageId,
      fecha_inicio: fechaInicio,
      serviceIds,
    };
  });
}

function buildUniqueServiceIds(...sources) {
  const set = new Set();
  for (const source of sources) {
    for (const serviceId of Array.isArray(source) ? source : []) {
      const normalized = String(serviceId || "").trim();
      if (!normalized) continue;
      set.add(normalized);
    }
  }
  return [...set];
}

function mapServicesById(serviceItems = []) {
  const map = new Map();
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    const idServicio = String(item?.id_servicio || "").trim();
    if (!idServicio || map.has(idServicio)) continue;
    map.set(idServicio, {
      id_servicio: idServicio,
      nombre_servicio: String(item?.nombre_servicio || "").trim() || "Servicio",
    });
  }
  return map;
}

async function resolveAuthenticatedTitularContact(client, { personaId, claimsUser }) {
  const profileResult = await client.query(
    `
      SELECT
        p.nombres,
        p.apellidos,
        p.telefono_principal,
        COALESCE(
          NULLIF((
            SELECT c.direccion_correo
            FROM public.correos c
            WHERE c.id_persona = p.id_persona
              AND c.deleted_at IS NULL
            ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
            LIMIT 1
          )::text, ''),
          NULLIF($2::text, '')
        ) AS email
      FROM public.personas p
      WHERE p.id_persona = $1::uuid
        AND p.deleted_at IS NULL
      LIMIT 1
    `,
    [personaId, claimsUser?.email ?? null]
  );

  const profileRow = profileResult.rows[0];
  if (!profileRow) {
    throw new AppError(409, "No se pudo resolver el perfil autenticado del titular", {
      code: "CITAS_HOLD_TITULAR_PROFILE_NOT_FOUND",
    });
  }

  const profileNombres = normalizePersonName(profileRow.nombres || "");
  const profileApellidos = normalizePersonName(profileRow.apellidos || "");
  const profilePhone = normalizePhone(profileRow.telefono_principal || "");
  const profileEmail = normalizeEmail(profileRow.email || "");
  // AM: FASE 1A - Perfil mínimo obligatorio para hold autenticado.
  const missingFields = [];
  if (!profileNombres) missingFields.push("nombres");
  if (!profileApellidos) missingFields.push("apellidos");
  if (!profilePhone || profilePhone.length < 8) missingFields.push("telefono_principal");
  if (!EMAIL_PATTERN.test(profileEmail)) missingFields.push("correo_principal");
  if (missingFields.length > 0) {
    throw new AppError(409, "Completa tu perfil antes de agendar una cita.", {
      code: "CLIENT_PROFILE_INCOMPLETE",
      details: { missing_fields: missingFields },
    });
  }

  return {
    fullName: buildFullName(profileNombres, profileApellidos),
    nombres: profileNombres,
    apellidos: profileApellidos,
    email: profileEmail,
    telefono: profilePhone,
  };
}

function isSimulationNoPaymentEnabled(paramsMap) {
  return Boolean(paramsMap?.simulacion_sin_pago?.valor_booleano);
}

export default async function citasRoutes(app) {
  app.post(
    "/",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal", "fecha_inicio"],
          properties: {
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            id_sucursal: { type: "string", format: "uuid" },
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
                  id_cita: { type: "string", format: "uuid" },
                  estado_cita_codigo: { type: "string" },
                  id_barbero: { type: "string", format: "uuid" },
                  nombre_barbero: { type: "string" },
                  asignada_automaticamente: { type: "boolean" },
                  expires_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
                  duracion_total_min: { type: "integer" },
                  buffer_total_min: { type: "integer" },
                  monto_total_hnl: { type: "number" },
                },
                required: [
                  "id_cita",
                  "estado_cita_codigo",
                  "id_barbero",
                  "nombre_barbero",
                  "asignada_automaticamente",
                  "expires_at",
                  "duracion_total_min",
                  "buffer_total_min",
                  "monto_total_hnl",
                ],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        const { clienteId, personaId, usuarioId } = ensureClientContext(request);
        const pendingResolved = await resolveClientPendingGroup(dbClient, { clienteId, personaId });
        if (pendingResolved.primary?.vigente) {
          const pendingRows = pendingResolved.primary.groupRows;
          const servicesByCita = await getServicesByAppointmentIds(
            dbClient,
            pendingRows.map((row) => row.id_cita)
          );
          const pendingPayload = buildPendingGroupPayload(pendingRows, servicesByCita, {
            multiplePendingDetected: pendingResolved.groups.length > 1,
          });
          throw new AppError(
            409,
            "Tienes una reserva pendiente de pago. Completa o descarta esa reserva antes de agendar una nueva cita.",
            {
              code: "CLIENT_PENDING_APPOINTMENT_EXISTS",
              details: {
                id_grupo_cita: pendingPayload?.id_grupo_cita || null,
                fecha_hora: pendingPayload?.fecha_hora_referencia || null,
                id_sucursal: pendingPayload?.sucursal?.id_sucursal || null,
                sucursal: pendingPayload?.sucursal?.nombre_sucursal || null,
                total_pendiente_hnl: Number(pendingPayload?.total_pendiente_hnl || 0),
                expires_at: pendingPayload?.expires_at || null,
                multiple_pending_detected: pendingPayload?.multiple_pending_detected === true,
              },
            }
          );
        }
        const selectionType = String(request.body?.selection_type || "services").trim().toLowerCase();
        assertBookingSelectionCreationSupported(selectionType);
        const serviceIds = Array.isArray(request.body?.servicios)
          ? request.body.servicios.map((item) => item.id_servicio)
          : [];
        const simulationNoPayment = isSimulationNoPaymentEnabled(await getSystemParameters(dbClient));
        const selection = await resolveBookingSelection(dbClient, {
          id_sucursal: request.body.id_sucursal,
          selection_type: selectionType,
          servicios: serviceIds,
          id_paquete: request.body?.id_paquete ?? null,
          fecha_inicio: request.body.fecha_inicio,
          id_barbero: request.body.id_barbero ?? null,
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });

        await dbClient.query("BEGIN");

        const reservation = await createBookingReservation(dbClient, {
          appointment: {
            branchId: selection.branch.id_sucursal,
            barberId: selection.barber.id_empleado,
            personId: personaId,
            clientId: clienteId,
            createdByUserId: usuarioId,
            autoAssigned: !request.body.id_barbero,
            selection,
            subtotalHnl: selection.serviceSelection.monto_total_hnl,
            totalHnl: selection.serviceSelection.monto_total_hnl,
            notes: request.body?.notas ?? null,
          },
          hold: {
            userId: usuarioId,
            expiresAt: selection.expiresAt.toISOString(),
            returning: true,
          },
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });
        const citaId = reservation.citaId;
        const persistedTotals = reservation.totals || {
          subtotalHnl: Number(selection.serviceSelection.monto_subtotal_hnl ?? selection.serviceSelection.monto_total_hnl ?? 0),
          descuentoHnl: 0,
          totalHnl: Number(selection.serviceSelection.monto_total_hnl || 0),
        };

        if (simulationNoPayment) {
          await confirmAppointmentWithoutPayment(dbClient, {
            id_cita: citaId,
            motivo_confirmacion: "simulacion_sin_pago_cliente_simple",
          });
        }

        await dbClient.query("COMMIT");

        return sendOk(
          reply,
          {
            id_cita: citaId,
            estado_cita_codigo: simulationNoPayment ? "confirmada" : "en_espera",
            id_barbero: selection.barber.id_empleado,
            nombre_barbero: selection.barber.nombre_completo,
            asignada_automaticamente: !request.body.id_barbero,
            expires_at: simulationNoPayment ? null : new Date(reservation.hold.expires_at).toISOString(),
            duracion_total_min: selection.serviceSelection.duracion_total_min,
            buffer_total_min: selection.serviceSelection.buffer_total_min,
            monto_total_hnl: persistedTotals.totalHnl,
          },
          { statusCode: 201 }
        );
      } catch (error) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // no-op
        }

        if (isConflictError(error)) {
          return sendError(reply, 409, "Ya existe un hold activo o el horario solicitado no esta disponible", {
            code: "CITA_HOLD_CONFLICTO",
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, error, "No se pudo crear la cita", "CITAS_CREATE_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.post(
    "/hold",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            id_points_tx_canje: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
            canje_context_token: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
            titular: {
              type: "object",
              properties: {
                nombres: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                apellidos: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                telefono: { anyOf: [{ type: "string", minLength: 8, maxLength: 20 }, { type: "null" }] },
                guardar_nombres_apellidos: { type: "boolean" },
                guardar_telefono: { type: "boolean" },
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
                  id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  selection_type: { type: "string", enum: ["services", "package", "mixed"] },
                  id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  fecha_inicio: { type: "string", format: "date-time" },
                  servicios: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id_servicio"],
                      properties: {
                        id_servicio: { type: "string", format: "uuid" },
                      },
                      additionalProperties: true,
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
                additionalProperties: true,
              },
            },
            notas: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      let txStarted = false;
      try {
        const { clienteId, personaId, usuarioId } = ensureClientContext(request);
        await expireReservationsBestEffort(dbClient, request, "citas_hold_create");
        const pendingResolved = await resolveClientPendingGroup(dbClient, { clienteId, personaId });
        if (pendingResolved.primary?.vigente) {
          const pendingRows = pendingResolved.primary.groupRows;
          const servicesByCita = await getServicesByAppointmentIds(
            dbClient,
            pendingRows.map((row) => row.id_cita)
          );
          const pendingPayload = buildPendingGroupPayload(pendingRows, servicesByCita, {
            multiplePendingDetected: pendingResolved.groups.length > 1,
          });
          throw new AppError(
            409,
            "Tienes una reserva pendiente de pago. Completa o descarta esa reserva antes de agendar una nueva cita.",
            {
              code: "CLIENT_PENDING_APPOINTMENT_EXISTS",
              details: {
                id_grupo_cita: pendingPayload?.id_grupo_cita || null,
                fecha_hora: pendingPayload?.fecha_hora_referencia || null,
                id_sucursal: pendingPayload?.sucursal?.id_sucursal || null,
                sucursal: pendingPayload?.sucursal?.nombre_sucursal || null,
                total_pendiente_hnl: Number(pendingPayload?.total_pendiente_hnl || 0),
                expires_at: pendingPayload?.expires_at || null,
                multiple_pending_detected: pendingPayload?.multiple_pending_detected === true,
              },
            }
          );
        }

        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const canjeContextTokenRaw = request.body?.canje_context_token ?? request.body?.id_points_tx_canje;
        const canjeContextToken = canjeContextTokenRaw
          ? normalizeRedeemContextToken(canjeContextTokenRaw)
          : null;
        const branch = await ensureActiveBranch(dbClient, idSucursal);
        const integrantes = normalizeHoldBlocksPayload(request.body);
        const titularOperationalDateTime = normalizeOperationalDateTime(integrantes[0]?.fecha_inicio, "fecha_inicio");

        await dbClient.query("BEGIN");
        txStarted = true;
        const titularContact = await resolveAuthenticatedTitularContact(dbClient, {
          personaId,
          claimsUser: request.claims?.user,
        });
        const rewardRedeemContext = canjeContextToken
          ? await resolveRedeemContextForHold(dbClient, {
            idCliente: clienteId,
            canjeContextToken,
            idSucursal: branch.id_sucursal,
          })
          : null;
        if (!rewardRedeemContext) {
          const rewardGate = await resolveRewardRedeemGateForCliente(dbClient, {
            idCliente: clienteId,
            idSucursal: branch.id_sucursal,
          });
          if (rewardGate.reward_redeem_required) {
            throw new AppError(
              409,
              "Tienes una cortesía disponible. Para continuar, debes canjear tu recompensa antes de agendar una cita normal.",
              {
                code: "REWARD_REDEEM_REQUIRED",
                details: {
                  recompensas_disponibles: Number(rewardGate.recompensas_disponibles || 0),
                  progreso_actual: Number(rewardGate.progreso_actual || 0),
                  puntos_para_premio: Number(rewardGate.puntos_para_premio || 0),
                },
              }
            );
          }
        }
        let rewardAppliedInHold = false;
        let rewardCoveredTotalHnl = 0;
        let rewardLinkedCitaId = null;

        let activeMembership = null;
        let membershipComputationFailed = false;
        try {
          activeMembership = await ensureSubscriptionLifecycle(dbClient, clienteId, { forUpdate: true });
        } catch (membershipError) {
          membershipComputationFailed = true;
          request.log.warn(
            {
              id_cliente: clienteId,
              id_sucursal: branch.id_sucursal,
              code: membershipError?.code || null,
            },
            "No se pudo calcular cobertura de membresia para hold. Se aplicara tarifa normal."
          );
          activeMembership = {
            active: null,
            summary: null,
            time_remaining: null,
            changed: false,
          };
        }
        const contractedBranchId = String(activeMembership?.active?.id_sucursal_contratada || "").trim() || null;
        const contractedBranchName = contractedBranchId
          ? await getBranchNameById(dbClient, contractedBranchId)
          : null;
        const coverageTracker = createCoverageTracker(activeMembership, {
          appointmentBranchId: branch.id_sucursal,
          planBranchName: contractedBranchName,
        });
        if (coverageTracker?.coverageEnabled && Array.isArray(coverageTracker.requiredServiceIds) && coverageTracker.requiredServiceIds.length > 0) {
          const servicesWithActiveTariff = await getServicesWithActiveTariffByBranch(dbClient, {
            idSucursal: branch.id_sucursal,
            serviceIds: coverageTracker.requiredServiceIds,
            fechaOperativa: titularOperationalDateTime.fecha_operativa,
          });
          filterCoverageTrackerByTariffServices(coverageTracker, servicesWithActiveTariff);
        }
        if (membershipComputationFailed) {
          coverageTracker.coverageEnabled = false;
          coverageTracker.coverageDisabledReason = "coverage_resolution_error";
          coverageTracker.coverageDisabledMessage = "No pudimos aplicar tu plan en este momento; calculamos la cita con tarifa normal.";
        }
        if (rewardRedeemContext) {
          coverageTracker.coverageEnabled = false;
          coverageTracker.coverageDisabledReason = "reward_redeem_active";
          coverageTracker.coverageDisabledMessage = "Se aplicara tu recompensa de cortesia al titular. Los extras y acompanantes se cobran normalmente.";
        }
        const hasMembership = Boolean(coverageTracker.hasPlan && coverageTracker.idSuscripcion);

        const groupRecord = await createBookingGroup(dbClient, {
          idSucursal: branch.id_sucursal,
          idPersonaTitular: personaId,
          idClienteTitular: clienteId,
          idUsuarioTitular: usuarioId,
          origenCodigo: "cliente_autenticado",
          notas: request.body?.notas ?? null,
        });
        const holdDurationMin = await getHoldDurationMinutes(dbClient);
        const holdExpiresAt = new Date(Date.now() + holdDurationMin * 60 * 1000);
        const holdUserId = integrantes.length > 1 ? null : usuarioId;
        const bloquesResponse = [];
        let subtotalGrupo = 0;
        let descuentoGrupo = 0;
        let totalGrupo = 0;
        let extrasPendientesGrupo = 0;
        let coveredItemsCount = 0;
        let extraItemsCount = 0;
        const coveredServicesByPlan = new Map();
        const forcedServicesByPlan = new Map();
        if (integrantes[0]) {
          integrantes[0] = {
            ...integrantes[0],
            alias: titularContact.fullName || integrantes[0].alias || "Titular",
          };
        }

        for (let index = 0; index < integrantes.length; index += 1) {
          const integrante = integrantes[index];
          assertBookingSelectionCreationSupported(integrante.selection_type);
          const isTitular = integrante.orden_integrante <= 1;
          const selectionBase = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            selection_type: integrante.selection_type,
            servicios: integrante.serviceIds,
            id_paquete: integrante.id_paquete,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
            bookingIsvEnabled: app.config?.bookingIsvEnabled,
          });
          let selection = selectionBase;
          let forcedServiceIdsApplied = [];

          const requiredServiceIds = (
            isTitular
            && coverageTracker?.coverageEnabled !== false
            && Array.isArray(coverageTracker?.requiredServiceIds)
          )
            ? coverageTracker.requiredServiceIds
            : [];
          if (requiredServiceIds.length > 0) {
            const baseSelectedServiceIds = new Set(
              (Array.isArray(selectionBase?.serviceSelection?.items) ? selectionBase.serviceSelection.items : [])
                .map((item) => String(item?.id_servicio || "").trim())
                .filter(Boolean)
            );
            const missingRequiredServiceIds = requiredServiceIds.filter((serviceId) => !baseSelectedServiceIds.has(serviceId));
            if (missingRequiredServiceIds.length > 0) {
              const forcedSelectionType = ["package", "mixed"].includes(String(integrante.selection_type || "").trim().toLowerCase())
                ? "mixed"
                : "services";
              const mergedServiceIds = buildUniqueServiceIds(integrante.serviceIds, missingRequiredServiceIds);
              try {
                const forcedSelection = await resolveBookingSelection(dbClient, {
                  id_sucursal: branch.id_sucursal,
                  selection_type: forcedSelectionType,
                  servicios: mergedServiceIds,
                  id_paquete: integrante.id_paquete,
                  fecha_inicio: integrante.fecha_inicio,
                  id_barbero: integrante.id_barbero,
                  bookingIsvEnabled: app.config?.bookingIsvEnabled,
                });
                selection = forcedSelection;
                const forcedSelectedServiceIds = new Set(
                  (Array.isArray(forcedSelection?.serviceSelection?.items) ? forcedSelection.serviceSelection.items : [])
                    .map((item) => String(item?.id_servicio || "").trim())
                    .filter(Boolean)
                );
                forcedServiceIdsApplied = missingRequiredServiceIds.filter((serviceId) => forcedSelectedServiceIds.has(serviceId));
              } catch (forcedCoverageError) {
                request.log.warn(
                  {
                    id_cliente: clienteId,
                    id_sucursal: branch.id_sucursal,
                    id_suscripcion: coverageTracker?.idSuscripcion || null,
                    code: forcedCoverageError?.code || null,
                  },
                  "No se pudo forzar servicios del plan en hold. Se aplicara tarifa normal."
                );
                coverageTracker.coverageEnabled = false;
                coverageTracker.coverageDisabledReason = "coverage_resolution_error";
                coverageTracker.coverageDisabledMessage = "No pudimos aplicar tu plan en este momento; calculamos la cita con tarifa normal.";
                forcedServiceIdsApplied = [];
                selection = selectionBase;
              }
            }
          }

          const coverage = consumeCoverageForServices(
            coverageTracker,
            selection.serviceSelection.items,
            { isTitular, forcedServiceIds: forcedServiceIdsApplied }
          );
          const subtotalServicios = Number(
            selection.serviceSelection.monto_subtotal_hnl ?? selection.serviceSelection.monto_total_hnl ?? 0
          );
          let rewardCoveredInBlock = 0;
          if (isTitular && rewardRedeemContext) {
            const rewardServiceId = String(rewardRedeemContext.id_servicio_canje || "").trim();
            const rewardCoverageItem = coverage.items.find((item) => String(item?.id_servicio || "").trim() === rewardServiceId);
            if (!rewardCoverageItem) {
              throw new AppError(409, "El canje no corresponde al servicio seleccionado para el titular", {
                code: "POINTS_REDEEM_SERVICE_MISMATCH",
                details: {
                  canje_context_token: rewardRedeemContext.canje_context_token,
                  id_servicio_canje: rewardRedeemContext.id_servicio_canje,
                },
              });
            }
            rewardCoveredInBlock = Math.max(0, Number(rewardCoverageItem.total_hnl ?? rewardCoverageItem.precio_unitario_hnl ?? 0));
            rewardCoverageItem.coverage_status = "cubierto_recompensa";
            rewardCoverageItem.forced_by_membership = false;
            coverage.coveredTotalHnl += rewardCoveredInBlock;
            coverage.extraTotalHnl = Math.max(0, coverage.extraTotalHnl - rewardCoveredInBlock);
          }
          const descuento = Number(coverage.coveredTotalHnl || 0);
          let totalPagar = Number(coverage.extraTotalHnl || 0);
          let descuentoPromociones = 0;
          let promocionesPreview = null;
          let promocionesContext = null;
          const baseDiscountLines = buildCanonicalDiscountLines(selection.serviceSelection.items || [], {
            orden_integrante: integrante.orden_integrante || index + 1,
          });
          const coverageAllocations = buildCoverageDiscountAllocations(baseDiscountLines, coverage, {
            idSuscripcion: coverageTracker?.idSuscripcion || null,
            rewardSourceId: rewardRedeemContext?.canje_context_token || null,
          });
          const coveragePlan = buildDiscountPlan(baseDiscountLines, coverageAllocations);
          const promotionDiscountLines = applyPlanAsPreviousDiscount(baseDiscountLines, coveragePlan);
          const promoDateTime = normalizeOperationalDateTime(selection.startDateTime, "fecha_inicio");
          promocionesContext = {
            id_sucursal: branch.id_sucursal,
            id_empleado_barbero: selection.barber.id_empleado,
            id_cliente: clienteId,
            id_persona: personaId,
            id_grupo_cita: groupRecord.id_grupo_cita,
            fecha_hora: promoDateTime.iso_utc,
            fecha: promoDateTime.fecha_operativa,
            fecha_operativa: promoDateTime.fecha_operativa,
            hora: promoDateTime.hora_operativa,
            subtotal_hnl: totalPagar,
            servicios: selection.serviceSelection.items || [],
            discount_lines: promotionDiscountLines,
            paquetes: selection.serviceSelection.id_paquete
              ? [{ id_paquete: selection.serviceSelection.id_paquete }]
              : [],
            codigo_promocional: request.body?.codigo_promocional || null,
            canal: "privado",
            es_cliente_autenticado: true,
            es_titular: isTitular,
          };
          promocionesPreview = await previewPromotionsForAppointment(dbClient, promocionesContext);
          if (!promocionesPreview.usedFallbackLegacy) {
            descuentoPromociones = Number(promocionesPreview.descuento_total_hnl || 0);
            totalPagar = Math.max(0, Number((totalPagar - descuentoPromociones).toFixed(2)));
          }
          const descuentoTotal = Number((descuento + descuentoPromociones).toFixed(2));

          if (isTitular && hasMembership) {
            const selectedServiceMap = mapServicesById(selection.serviceSelection.items);
            for (const coveredServiceId of Array.isArray(coverage.coveredServiceIds) ? coverage.coveredServiceIds : []) {
              const mapped = selectedServiceMap.get(coveredServiceId) || {
                id_servicio: coveredServiceId,
                nombre_servicio: "Servicio",
              };
              if (!coveredServicesByPlan.has(mapped.id_servicio)) {
                coveredServicesByPlan.set(mapped.id_servicio, mapped);
              }
            }
            for (const forcedServiceId of Array.isArray(coverage.forcedCoveredServiceIds) ? coverage.forcedCoveredServiceIds : []) {
              const mapped = selectedServiceMap.get(forcedServiceId) || {
                id_servicio: forcedServiceId,
                nombre_servicio: "Servicio",
              };
              if (!forcedServicesByPlan.has(mapped.id_servicio)) {
                forcedServicesByPlan.set(mapped.id_servicio, mapped);
              }
            }
          }

          const promotionAllocations = [];
          if (promocionesPreview && !promocionesPreview.usedFallbackLegacy) {
            for (const promotion of promocionesPreview.promociones_aplicadas || []) {
              for (const allocation of promotion.line_allocations || []) {
                promotionAllocations.push({
                  line_key: allocation.line_key,
                  source_type: "promotion",
                  source_id: promotion.id_promocion_regla,
                  id_promocion: promotion.id_promocion,
                  id_promocion_regla: promotion.id_promocion_regla,
                  descuento_hnl: allocation.descuento_hnl,
                });
              }
            }
          }
          const combinedAllocations = [...coverageAllocations, ...promotionAllocations];
          const discountPlan = combinedAllocations.length
            ? buildDiscountPlan(baseDiscountLines, combinedAllocations)
            : null;
          const reservation = await createBookingReservation(dbClient, {
            groupRecord,
            appointment: {
              groupId: groupRecord.id_grupo_cita,
              order: integrante.orden_integrante,
              alias: integrante.alias,
              branchId: branch.id_sucursal,
              barberId: selection.barber.id_empleado,
              personId: personaId,
              clientId: clienteId,
              createdByUserId: usuarioId,
              autoAssigned: !integrante.id_barbero,
              selection,
              subtotalHnl: subtotalServicios,
              descuentoHnl: descuentoTotal,
              totalHnl: totalPagar,
              isRewardRedeem: Boolean(isTitular && rewardRedeemContext),
              notes: request.body?.notas ?? null,
            },
            hold: {
              userId: holdUserId,
              expiresAt: holdExpiresAt.toISOString(),
            },
            promotions: promocionesPreview && !promocionesPreview.usedFallbackLegacy
              ? {
                  context: promocionesContext,
                  result: promocionesPreview,
                  formal: true,
                  usageState: "reservado",
                }
              : null,
            discountPlan,
            bookingIsvEnabled: app.config?.bookingIsvEnabled,
          });
          const citaId = reservation.citaId;
          const persistedTotals = reservation.totals || {
            subtotalHnl: subtotalServicios,
            descuentoHnl: descuentoTotal,
            totalHnl: totalPagar,
          };
          if (isTitular && rewardRedeemContext) {
            rewardAppliedInHold = true;
            rewardLinkedCitaId = citaId;
            rewardCoveredTotalHnl += rewardCoveredInBlock;
          }

          const { fecha, hora } = parseIsoDateAndTime(selection.startDateTime);
          const coveredCount = coverage.items.filter((entry) =>
            entry.coverage_status === "cubierto_plan" || entry.coverage_status === "cubierto_recompensa"
          ).length;
          const extraCount = coverage.items.filter((entry) => entry.coverage_status === "extra_pendiente").length;
          coveredItemsCount += coveredCount;
          extraItemsCount += extraCount;
          subtotalGrupo += Number(persistedTotals.subtotalHnl || 0);
          descuentoGrupo += Number(persistedTotals.descuentoHnl || 0);
          totalGrupo += Number(persistedTotals.totalHnl || 0);
          extrasPendientesGrupo += Number(persistedTotals.totalHnl || 0);

          bloquesResponse.push({
            id_cita: citaId,
            orden_integrante: integrante.orden_integrante,
            alias: integrante.alias,
            id_barbero: selection.barber.id_empleado,
            nombre_barbero: selection.barber.nombre_completo,
            fecha: fecha || "",
            hora: hora || "",
            fecha_inicio: selection.startDateTime.toISOString(),
            estado_cita_codigo: "en_espera",
            monto_total_hnl: Number(persistedTotals.subtotalHnl || 0),
            descuento_hnl: Number(persistedTotals.descuentoHnl || 0),
            total_pagar_hnl: Number(persistedTotals.totalHnl || 0),
            duracion_total_min: Number(selection.serviceSelection.duracion_total_min || 0),
            buffer_total_min: Number(selection.serviceSelection.buffer_total_min || 0),
            cobertura: {
              items_cubiertos: coveredCount,
              items_extra: extraCount,
            },
          });
        }
        if (rewardRedeemContext && !rewardAppliedInHold) {
          throw new AppError(409, "No se pudo aplicar el canje al titular", {
            code: "POINTS_REDEEM_NOT_APPLIED",
            details: {
              canje_context_token: rewardRedeemContext.canje_context_token,
            },
          });
        }

        const membershipState = await getClienteMembershipState(dbClient, clienteId);
        const planCoveredTotalHnl = rewardRedeemContext ? 0 : descuentoGrupo;
        const hasCoveredAmount = planCoveredTotalHnl > 0;
        let membershipMessage = null;
        if (rewardRedeemContext && rewardAppliedInHold) {
          membershipMessage = "Se aplico tu recompensa de cortesia al servicio seleccionado del titular.";
        } else if (hasMembership && coverageTracker.coverageDisabledReason === "branch_mismatch") {
          const planBranchLabel = coverageTracker.sucursalPlanNombre || "otra sucursal";
          const citaBranchLabel = branch.nombre_sucursal || "la sucursal seleccionada";
          membershipMessage = `Tu plan activo pertenece a ${planBranchLabel}. Si agendas en ${citaBranchLabel}, esta cita no sera cubierta por tu plan y deberas pagar el total.`;
        } else if (hasMembership && coverageTracker.coverageDisabledReason === "missing_contracted_branch") {
          membershipMessage = "Tu plan no tiene una sucursal valida asociada; calculamos la cita con tarifa normal.";
        } else if (hasMembership && coverageTracker.coverageDisabledReason === "services_without_active_tariff") {
          membershipMessage = "Tu plan no tiene servicios con tarifa activa en esta sucursal; calculamos la cita con tarifa normal.";
        } else if (hasMembership && coverageTracker.coverageDisabledReason === "coverage_resolution_error") {
          membershipMessage = coverageTracker.coverageDisabledMessage
            || "No pudimos aplicar beneficios de tu plan en este momento; calculamos la cita con tarifa normal.";
        } else if (hasMembership && (!coverageTracker.hasServiceBenefitsAvailable || !hasCoveredAmount)) {
          membershipMessage = "Tu plan no tiene beneficios disponibles para cubrir esta cita.";
        } else if (!hasMembership && membershipComputationFailed) {
          membershipMessage = "No pudimos validar beneficios de plan en este momento; calculamos la cita con tarifa normal.";
        }
        const membershipCoverageActive = Boolean(hasMembership && coverageTracker.branchMatch && hasCoveredAmount);
        // AM: Señales explícitas de contrato para UX de membresía en hold autenticado.
        const membershipBranchMismatch = Boolean(hasMembership && coverageTracker.coverageDisabledReason === "branch_mismatch");
        const membershipStateCode = String(membershipState?.estado_plan || "").trim().toLowerCase();
        const hasMembershipHistory = membershipState?.tiene_historial === true;
        let membershipReasonNoAplica = null;
        if (membershipComputationFailed) {
          membershipReasonNoAplica = "ERROR_MEMBRESIA";
        } else if (membershipBranchMismatch) {
          membershipReasonNoAplica = "SUCURSAL_DIFERENTE";
        } else if (membershipCoverageActive) {
          membershipReasonNoAplica = null;
        } else if (!hasMembership && hasMembershipHistory && membershipStateCode && membershipStateCode !== "sin_plan_activo") {
          membershipReasonNoAplica = "PLAN_NO_ACTIVO";
        } else if (!hasMembership) {
          membershipReasonNoAplica = "SIN_PLAN";
        }
        await updateBookingGroupTotal(dbClient, {
          idGrupoCita: groupRecord.id_grupo_cita,
          totalHnl: totalGrupo,
        });
        const coveredServicesList = [...coveredServicesByPlan.values()];
        const forcedServicesList = [...forcedServicesByPlan.values()];
        await dbClient.query("COMMIT");
        txStarted = false;

        return sendOk(reply, {
          id_grupo_cita: groupRecord.id_grupo_cita,
          estado_grupo_codigo: groupRecord.estado_grupo_codigo || "activo",
          expires_at: holdExpiresAt.toISOString(),
          subtotal_hnl: subtotalGrupo,
          monto_total_hnl: subtotalGrupo,
          descuento_total_hnl: descuentoGrupo,
          total_pagar_hnl: totalGrupo,
          extras_pendientes_hnl: extrasPendientesGrupo,
          resumen_cobertura: {
            items_cubiertos: coveredItemsCount,
            items_extra: extraItemsCount,
          },
          recompensa: rewardRedeemContext
            ? {
              aplicada: rewardAppliedInHold,
              id_points_tx_canje: rewardRedeemContext.canje_context_token,
              canje_context_token: rewardRedeemContext.canje_context_token,
              servicio_nombre: rewardRedeemContext.servicio_nombre,
              puntos_requeridos: rewardRedeemContext.puntos_requeridos,
              cubierto_hnl: rewardCoveredTotalHnl,
              extras_a_pagar_hnl: totalGrupo,
              mensaje: rewardAppliedInHold
                ? "Recompensa aplicada correctamente. Los extras y acompanantes se cobran aparte."
                : "No se aplico la recompensa en este hold.",
              id_cita_asociada: rewardLinkedCitaId,
            }
            : {
              aplicada: false,
              id_points_tx_canje: null,
              canje_context_token: null,
              servicio_nombre: null,
              puntos_requeridos: 0,
              cubierto_hnl: 0,
              extras_a_pagar_hnl: totalGrupo,
              mensaje: null,
              id_cita_asociada: null,
            },
          membresia: hasMembership
            ? {
              cobertura_activa: membershipCoverageActive,
              id_suscripcion: coverageTracker.idSuscripcion,
              id_sucursal_contratada: coverageTracker.idSucursalContratada || null,
              sucursal_plan_nombre: coverageTracker.sucursalPlanNombre || null,
              nombre_plan: coverageTracker.planName || null,
              estado_plan: membershipState?.estado_plan || "sin_plan_activo",
              aplica_en_cita: membershipCoverageActive,
              branch_mismatch: membershipBranchMismatch,
              motivo_no_aplica: membershipReasonNoAplica,
              acompanantes_cubiertos: false,
              mensaje: membershipMessage,
              servicios_cubiertos: coveredServicesList,
              servicios_forzados: forcedServicesList,
              cubierto_por_plan_hnl: planCoveredTotalHnl,
              extras_a_pagar_hnl: totalGrupo,
            }
            : {
              cobertura_activa: false,
              id_suscripcion: null,
              id_sucursal_contratada: null,
              sucursal_plan_nombre: null,
              nombre_plan: null,
              estado_plan: "sin_plan_activo",
              aplica_en_cita: false,
              branch_mismatch: membershipBranchMismatch,
              motivo_no_aplica: membershipReasonNoAplica,
              acompanantes_cubiertos: false,
              mensaje: membershipMessage,
              servicios_cubiertos: [],
              servicios_forzados: [],
              cubierto_por_plan_hnl: 0,
              extras_a_pagar_hnl: totalGrupo,
            },
          bloques: bloquesResponse,
        }, {
          statusCode: 201,
          requestId: request.id,
        });
      } catch (error) {
        try {
          if (txStarted) {
            await dbClient.query("ROLLBACK");
          }
        } catch {
          // no-op
        }

        if (isConflictError(error)) {
          return sendError(reply, 409, "Ya existe un conflicto de disponibilidad para uno de los bloques", {
            code: "CITAS_HOLD_CONFLICT",
            requestId: request.id,
          });
        }

        if (isPointsTriggerCompileError(error)) {
          return sendError(reply, 409, "No pudimos procesar la reserva en este momento. Intenta nuevamente en unos minutos.", {
            code: "CITAS_HOLD_POINTS_ENGINE_UNAVAILABLE",
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, error, "No se pudo crear el hold de citas", "CITAS_HOLD_CREATE_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.post(
    "/hold/:id_grupo_cita/confirmar",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
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
          properties: {
            id_points_tx_canje: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
            canje_context_token: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
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
                  id_grupo_cita: { type: "string", format: "uuid" },
                  codigo_cita: { type: "string" },
                  estado_grupo_codigo: { type: "string" },
                  total_pagar_hnl: { type: "number" },
                  confirmado_sin_pago: { type: "boolean" },
                  citas_confirmadas_count: { type: "integer" },
                  recompensa_utilizada: {
                    type: "object",
                    properties: {
                      aplicada: { type: "boolean" },
                      ya_aplicada: { type: "boolean" },
                      puntos_descontados: { type: "integer" },
                      saldo_actual: { type: ["integer", "null"] },
                      mensaje: { type: "string" },
                    },
                    additionalProperties: true,
                  },
                  citas_confirmadas: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id_cita: { type: "string", format: "uuid" },
                        codigo_cita: { type: "string" },
                        estado_cita_codigo: { type: "string" },
                      },
                      required: ["id_cita", "codigo_cita", "estado_cita_codigo"],
                      additionalProperties: false,
                    },
                  },
                  ya_confirmadas: { type: "boolean" },
                  email_enviado: { type: "boolean" },
                  email_omitido: { type: ["string", "null"] },
                },
                required: [
                  "id_grupo_cita",
                  "codigo_cita",
                  "estado_grupo_codigo",
                  "total_pagar_hnl",
                  "confirmado_sin_pago",
                  "recompensa_utilizada",
                  "citas_confirmadas",
                  "citas_confirmadas_count",
                  "ya_confirmadas",
                  "email_enviado",
                  "email_omitido",
                ],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      let txStarted = false;
      let step = "start";
      let groupId = null;
      try {
        step = "ensureClientContext";
        const { clienteId, personaId } = ensureClientContext(request);
        step = "assertGroupId";
        groupId = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
        step = "normalizeRedeemContextToken";
        const canjeContextTokenRaw = request.body?.canje_context_token ?? request.body?.id_points_tx_canje;
        const canjeContextToken = canjeContextTokenRaw
          ? normalizeRedeemContextToken(canjeContextTokenRaw)
          : null;
        step = "expireReservationsBestEffort";
        await expireReservationsBestEffort(dbClient, request, "citas_hold_confirm");

        step = "loadGroup";
        const groupResult = await dbClient.query(
          `
            SELECT id_grupo_cita, id_cliente_titular, id_persona_titular, estado_grupo_codigo
            FROM public.citas_grupos
            WHERE id_grupo_cita = $1::uuid
            LIMIT 1
          `,
          [groupId]
        );
        const group = groupResult.rows[0] || null;
        if (!group) {
          throw new AppError(404, "La reserva indicada no existe", {
            code: "CITAS_GROUP_NOT_FOUND",
          });
        }

        step = "validateGroupOwnership";
        const ownedByClient = String(group.id_cliente_titular || "") === String(clienteId)
          || String(group.id_persona_titular || "") === String(personaId);
        if (!ownedByClient) {
          throw new AppError(403, "No tienes permisos para confirmar esta reserva", {
            code: "CITAS_GROUP_FORBIDDEN",
          });
        }

        step = "getGroupAppointmentsForNoPaymentConfirmation";
        const rows = await getGroupAppointmentsForNoPaymentConfirmation(dbClient, { groupId });
        if (!rows.length) {
          throw new AppError(404, "La reserva indicada no existe", {
            code: "CITAS_GROUP_NOT_FOUND",
          });
        }

        const totalPagar = rows.reduce((acc, row) => acc + Number(row.total_pagar_hnl || 0), 0);
        const pendingRows = rows.filter((row) => String(row.estado_cita_codigo || "").trim().toLowerCase() !== "confirmada");
        if (totalPagar > 0 && pendingRows.length > 0) {
          throw new AppError(409, "La reserva tiene saldo pendiente y debe completar pago", {
            code: "CITAS_CONFIRM_PAYMENT_REQUIRED",
            details: { total_pagar_hnl: totalPagar },
          });
        }

        const codigoCitaGrupo = buildBookingShortCode(group.id_grupo_cita, 5);
        if (pendingRows.length === 0) {
          let rewardFinalization = {
            aplicada: false,
            ya_aplicada: false,
            puntos_descontados: 0,
            saldo_actual: null,
            mensaje: "No se aplico canje en esta confirmacion.",
          };
          step = "tx_begin_already_confirmed";
          await dbClient.query("BEGIN");
          txStarted = true;
          step = "applyRewardRedeemForConfirmedGroup_already_confirmed";
          rewardFinalization = await applyRewardRedeemForConfirmedGroup(dbClient, {
            idGrupoCita: group.id_grupo_cita,
            idCliente: clienteId,
            canjeContextToken,
            motivo: "Canje de recompensa ruta a tu cortesia",
            createdByUserId: request.claims?.user?.id_usuario ?? null,
          });
          step = "markPromotionUsagesForGroup_already_confirmed";
          await markPromotionUsagesForGroup(dbClient, {
            id_grupo_cita: group.id_grupo_cita,
            id_cliente: clienteId,
            id_persona: personaId,
          });
          step = "consumeMembershipForConfirmedRows_already_confirmed";
          await consumeMembershipForConfirmedRows(dbClient, request, {
            rows,
            clienteId,
            usuarioId: request.claims?.user?.id_usuario ?? null,
          });
          step = "grantEngagementPointsForConfirmedGroup_already_confirmed";
          await grantEngagementPointsForConfirmedGroup(dbClient, {
            idGrupoCita: group.id_grupo_cita,
          });
          step = "tx_commit_already_confirmed";
          await dbClient.query("COMMIT");
          txStarted = false;

          const confirmedAppointments = rows.map((row) => ({
            id_cita: row.id_cita,
            codigo_cita: buildBookingShortCode(row.id_cita, 5),
            estado_cita_codigo: String(row.estado_cita_codigo || "").trim().toLowerCase() || "confirmada",
          }));
          return sendOk(reply, {
            id_grupo_cita: group.id_grupo_cita,
            codigo_cita: codigoCitaGrupo,
            estado_grupo_codigo: "confirmada",
            total_pagar_hnl: totalPagar,
            confirmado_sin_pago: true,
            recompensa_utilizada: {
              aplicada: rewardFinalization?.aplicada === true,
              ya_aplicada: rewardFinalization?.ya_aplicada === true,
              puntos_descontados: Number(rewardFinalization?.puntos_descontados || 0),
              saldo_actual: Number.isFinite(Number(rewardFinalization?.saldo_actual))
                ? Number(rewardFinalization.saldo_actual)
                : null,
              mensaje: rewardFinalization?.aplicada
                ? "Recompensa utilizada. Se descontaron 10 puntos de tu ruta."
                : (rewardFinalization?.ya_aplicada
                  ? "La recompensa ya habia sido aplicada para esta cita."
                  : "No se aplico canje en esta confirmacion."),
            },
            citas_confirmadas_count: confirmedAppointments.length,
            citas_confirmadas: confirmedAppointments,
            ya_confirmadas: true,
            email_enviado: false,
            email_omitido: "ya_confirmada",
          }, {
            requestId: request.id,
          });
        }

        const nowMs = Date.now();
        for (const row of pendingRows) {
          const holdState = String(row.estado_hold_codigo || "").trim().toLowerCase();
          if (holdState !== "activo") {
            throw new AppError(409, "El hold de la reserva ya no esta activo", {
              code: "CITAS_HOLD_INACTIVE",
            });
          }
          const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
          if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) {
            throw new AppError(409, "El hold de la reserva expiro", {
              code: "CITAS_HOLD_EXPIRED",
            });
          }
        }

        step = "tx_begin";
        await dbClient.query("BEGIN");
        txStarted = true;
        const citaIds = pendingRows.map((row) => row.id_cita);
        step = "confirmAppointmentsWithoutPayment";
        await confirmAppointmentsWithoutPayment(dbClient, {
          citas: citaIds,
          motivo_confirmacion: "confirmacion_cliente_total_cero",
        });
        step = "applyRewardRedeemForConfirmedGroup";
        const rewardFinalization = await applyRewardRedeemForConfirmedGroup(dbClient, {
          idGrupoCita: group.id_grupo_cita,
          idCliente: clienteId,
          canjeContextToken,
          motivo: "Canje de recompensa ruta a tu cortesia",
          createdByUserId: request.claims?.user?.id_usuario ?? null,
        });
        step = "markPromotionUsagesForGroup";
        await markPromotionUsagesForGroup(dbClient, {
          id_grupo_cita: group.id_grupo_cita,
          id_cliente: clienteId,
          id_persona: personaId,
        });
        step = "consumeMembershipForConfirmedRows";
        await consumeMembershipForConfirmedRows(dbClient, request, {
          rows: pendingRows,
          clienteId,
          usuarioId: request.claims?.user?.id_usuario ?? null,
        });
        step = "grantEngagementPointsForConfirmedGroup";
        await grantEngagementPointsForConfirmedGroup(dbClient, {
          idGrupoCita: group.id_grupo_cita,
        });
        step = "tx_commit";
        await dbClient.query("COMMIT");
        txStarted = false;

        let details = [];
        try {
          step = "getGroupAppointmentConfirmationDetails";
          details = await getGroupAppointmentConfirmationDetails(dbClient, { groupId: group.id_grupo_cita });
        } catch (detailsError) {
          request.log.warn(
            { err: detailsError, id_grupo_cita: group.id_grupo_cita },
            "No se pudo cargar el detalle de citas confirmadas; se responde con fallback seguro"
          );
          details = pendingRows.map((row) => ({
            id_cita: row.id_cita,
            estado_cita_codigo: "confirmada",
            alias_integrante: null,
            orden_integrante: null,
            contacto_nombre: null,
            contacto_email: null,
            inicio_at: null,
            monto_total_hnl: Number(row.total_pagar_hnl || 0),
            total_pagar_hnl: Number(row.total_pagar_hnl || 0),
            nombre_sucursal: null,
            nombre_barbero: null,
          }));
        }
        const citasConfirmadasPayload = details.map((row) => ({
          id_cita: row.id_cita,
          codigo_cita: buildBookingShortCode(row.id_cita, 5),
          estado_cita_codigo: String(row.estado_cita_codigo || "").trim().toLowerCase() || "confirmada",
        }));

        let emailDispatch = { emailEnviado: false, emailOmitido: "sin_destinatario_valido" };
        try {
          step = "sendNoPaymentConfirmationEmails";
          emailDispatch = await sendNoPaymentConfirmationEmails(app, request.log, {
            groupId: group.id_grupo_cita,
            confirmationRows: details,
          });
        } catch (error) {
          request.log.warn(
            { err: error, id_grupo_cita: group.id_grupo_cita },
            "Fallo envio de correo post confirmacion sin pago"
          );
          emailDispatch = { emailEnviado: false, emailOmitido: "envio_fallido" };
        }

        return sendOk(reply, {
          id_grupo_cita: group.id_grupo_cita,
          codigo_cita: codigoCitaGrupo,
          estado_grupo_codigo: "confirmada",
          total_pagar_hnl: 0,
          confirmado_sin_pago: true,
          recompensa_utilizada: {
            aplicada: rewardFinalization?.aplicada === true,
            ya_aplicada: rewardFinalization?.ya_aplicada === true,
            puntos_descontados: Number(rewardFinalization?.puntos_descontados || 0),
            saldo_actual: Number.isFinite(Number(rewardFinalization?.saldo_actual))
              ? Number(rewardFinalization.saldo_actual)
              : null,
            mensaje: rewardFinalization?.aplicada
              ? "Recompensa utilizada. Se descontaron 10 puntos de tu ruta."
              : (rewardFinalization?.ya_aplicada
                ? "La recompensa ya habia sido aplicada para esta cita."
                : "No se aplico canje en esta confirmacion."),
          },
          citas_confirmadas_count: citasConfirmadasPayload.length,
          citas_confirmadas: citasConfirmadasPayload,
          ya_confirmadas: false,
          email_enviado: Boolean(emailDispatch.emailEnviado),
          email_omitido: emailDispatch.emailOmitido ?? null,
        }, {
          requestId: request.id,
        });
      } catch (error) {
        try {
          if (txStarted) {
            await dbClient.query("ROLLBACK");
          }
        } catch {
          // no-op
        }
        request.log.error({
          step,
          err: buildSafeStepError(error),
          id_grupo_cita: groupId,
          tx_started: txStarted,
        }, "CITAS_CONFIRM_NO_PAYMENT_STEP_FAILED");
        if (isPointsTriggerCompileError(error)) {
          return sendError(reply, 409, "No pudimos confirmar la reserva en este momento. Intenta nuevamente en unos minutos.", {
            code: "CITAS_CONFIRM_POINTS_ENGINE_UNAVAILABLE",
            requestId: request.id,
          });
        }
        if (error?.code === "23505" && error?.constraint === "uq_points_tx_canje_por_cita") {
          return sendError(reply, 409, "La recompensa ya fue aplicada para esta cita", {
            code: "POINTS_REDEEM_ALREADY_APPLIED",
            requestId: request.id,
          });
        }
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo confirmar la reserva sin pago",
          "CITAS_CONFIRM_NO_PAYMENT_ERROR"
        );
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/pendiente",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  pendiente: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
                },
                required: ["pendiente"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        const { clienteId, personaId } = ensureClientContext(request);
        await expireReservationsBestEffort(dbClient, request, "citas_pending_get");
        const resolved = await resolveClientPendingGroup(dbClient, { clienteId, personaId });
        if (!resolved.primary) {
          return sendOk(reply, { pendiente: null });
        }
        const primaryRows = resolved.primary.groupRows;
        const primaryGroupId = String(primaryRows[0]?.id_grupo_cita || "").trim();
        const servicesByCita = await getServicesByAppointmentIds(
          dbClient,
          primaryRows.map((row) => row.id_cita)
        );
        const payload = buildPendingGroupPayload(primaryRows, servicesByCita, {
          multiplePendingDetected: resolved.groups.length > 1,
        });
        if (!payload?.vigente && primaryGroupId) {
          await dbClient.query("BEGIN");
          await markPendingGroupExpired(dbClient, primaryGroupId);
          await dbClient.query("COMMIT");
          const refreshed = await resolveClientPendingGroup(dbClient, { clienteId, personaId });
          if (!refreshed.primary) {
            return sendOk(reply, { pendiente: null });
          }
          const refreshedRows = refreshed.primary.groupRows;
          const refreshedServices = await getServicesByAppointmentIds(
            dbClient,
            refreshedRows.map((row) => row.id_cita)
          );
          const refreshedPayload = buildPendingGroupPayload(refreshedRows, refreshedServices, {
            multiplePendingDetected: refreshed.groups.length > 1,
          });
          return sendOk(reply, { pendiente: refreshedPayload });
        }
        return sendOk(reply, { pendiente: payload });
      } catch (error) {
        try { await dbClient.query("ROLLBACK"); } catch {
          // AM: Rollback defensivo; el error original determina la respuesta.
        }
        return sendHandled(reply, request, error, "No se pudo consultar la reserva pendiente", "CITAS_PENDING_GET_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.post(
    "/pendiente/:id_grupo_cita/retomar",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          required: ["id_grupo_cita"],
          properties: {
            id_grupo_cita: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        const { clienteId, personaId } = ensureClientContext(request);
        const groupId = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
        await expireReservationsBestEffort(dbClient, request, "citas_pending_resume");
        const resolved = await resolveClientPendingGroup(dbClient, { clienteId, personaId, groupId });
        if (!resolved.primary) {
          throw new AppError(404, "No se encontro una reserva pendiente para retomar", {
            code: "PENDING_APPOINTMENT_NOT_FOUND",
          });
        }
        const primaryRows = resolved.primary.groupRows;
        const servicesByCita = await getServicesByAppointmentIds(
          dbClient,
          primaryRows.map((row) => row.id_cita)
        );
        const payload = buildPendingGroupPayload(primaryRows, servicesByCita, {
          multiplePendingDetected: resolved.groups.length > 1,
        });
        if (!payload?.vigente || !payload?.payment_intent?.id_intent) {
          await dbClient.query("BEGIN");
          await markPendingGroupExpired(dbClient, groupId);
          await dbClient.query("COMMIT");
          throw new AppError(409, PENDING_EXPIRED_MESSAGE, {
            code: "PENDING_APPOINTMENT_EXPIRED",
            details: {
              id_grupo_cita: groupId,
            },
          });
        }
        return sendOk(reply, {
          id_grupo_cita: payload.id_grupo_cita,
          estado: payload.estado,
          expires_at: payload.expires_at,
          multiple_pending_detected: payload.multiple_pending_detected === true,
          payment_intent: payload.payment_intent,
          total_pendiente_hnl: payload.total_pendiente_hnl,
        });
      } catch (error) {
        try { await dbClient.query("ROLLBACK"); } catch {
          // AM: Rollback defensivo; el error original determina la respuesta.
        }
        return sendHandled(reply, request, error, "No se pudo retomar la reserva pendiente", "CITAS_PENDING_RESUME_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.post(
    "/pendiente/:id_grupo_cita/descartar",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          required: ["id_grupo_cita"],
          properties: {
            id_grupo_cita: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        const { clienteId, personaId } = ensureClientContext(request);
        const groupId = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
        const resolved = await resolveClientPendingGroup(dbClient, { clienteId, personaId, groupId });
        if (!resolved.primary) {
          return sendOk(reply, {
            id_grupo_cita: groupId,
            estado_final: "sin_pendiente",
            descartada: true,
            idempotent: true,
          });
        }
        const discardState = await getDiscardStateCode(dbClient);
        if (!discardState) {
          throw new AppError(409, "No existe estado cancelada_por_cliente configurado. Solicita habilitar el catalogo de estados.", {
            code: "PENDING_DISCARD_STATE_UNAVAILABLE",
          });
        }
        await dbClient.query("BEGIN");
        await dbClient.query(
          `
            UPDATE public.citas
            SET estado_cita_codigo = $2::text,
                updated_at = now()
            WHERE id_grupo_cita = $1::uuid
              AND deleted_at IS NULL
              AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
          `,
          [groupId, discardState]
        );
        await dbClient.query(
          `
            UPDATE public.citas_holds h
            SET estado_hold_codigo = CASE
              WHEN h.estado_hold_codigo = 'consumido' THEN h.estado_hold_codigo
              ELSE 'expirado'
            END,
            updated_at = now()
            FROM public.citas c
            WHERE c.id_grupo_cita = $1::uuid
              AND c.id_cita = h.id_cita
              AND c.deleted_at IS NULL
          `,
          [groupId]
        );
        await dbClient.query(
          `
            UPDATE public.payment_intents pi
            SET estado_intent_codigo = 'expirado',
                updated_at = now()
            FROM public.citas c
            WHERE c.id_grupo_cita = $1::uuid
              AND c.id_cita = pi.id_cita
              AND c.deleted_at IS NULL
              AND pi.estado_intent_codigo = ANY($2::text[])
          `,
          [groupId, ACTIVE_PAYMENT_INTENT_STATES]
        );
        await dbClient.query("COMMIT");
        return sendOk(reply, {
          id_grupo_cita: groupId,
          estado_final: discardState,
          descartada: true,
          idempotent: false,
        });
      } catch (error) {
        try { await dbClient.query("ROLLBACK"); } catch {
          // AM: Rollback defensivo; el error original determina la respuesta.
        }
        return sendHandled(reply, request, error, "No se pudo descartar la reserva pendiente", "CITAS_PENDING_DISCARD_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        querystring: {
          type: "object",
          properties: {
            estado: { type: "string" },
            fecha_desde: { type: "string", format: "date" },
            fecha_hasta: { type: "string", format: "date" },
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
                  citas: { type: "array", items: citaResumenSchema },
                },
                required: ["citas"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = ensureClientContext(request);
        const estado = request.query?.estado ? String(request.query.estado).trim() : null;
        const fechaDesde = request.query?.fecha_desde ? parseDateOnly(request.query.fecha_desde, "fecha_desde") : null;
        const fechaHasta = request.query?.fecha_hasta ? parseDateOnly(request.query.fecha_hasta, "fecha_hasta") : null;

        if (estado && !OCCUPIED_APPOINTMENT_STATES.concat(["expirada", "cancelada", "completada", "no_show"]).includes(estado)) {
          throw new AppError(400, "estado no es valido", {
            code: "CITAS_STATUS_INVALID",
            details: { estado },
          });
        }

        const rows = await listAppointmentRows(app.db, {
          ...context,
          estado,
          fechaDesde,
          fechaHasta,
        });

        return sendOk(reply, {
          citas: rows.map(mapAppointmentRow),
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudieron consultar las citas", "CITAS_LIST_ERROR");
      }
    }
  );

  app.get(
    "/:id",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
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
                  cita: citaResumenSchema,
                  detalles: { type: "array", items: citaDetalleItemSchema },
                },
                required: ["cita", "detalles"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = ensureClientContext(request);
        const citaId = assertUuid(request.params?.id, "id");
        const rows = await listAppointmentRows(app.db, {
          ...context,
          citaId,
        });

        if (!rows[0]) {
          throw new AppError(404, "La cita solicitada no existe", {
            code: "CITAS_NOT_FOUND",
            details: { id_cita: citaId },
          });
        }

        const detalles = await getAppointmentDetails(app.db, citaId);
        return sendOk(reply, {
          cita: mapAppointmentRow(rows[0]),
          detalles,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar el detalle de la cita", "CITAS_DETAIL_ERROR");
      }
    }
  );
}
