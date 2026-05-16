import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  ensureActiveBranch,
  expireStaleAppointmentReservations,
  OCCUPIED_APPOINTMENT_STATES,
  assertUuid,
  getAgendamientoConfig,
  getHoldDurationMinutes,
  getSystemParameters,
  parseSinglePackageId,
  parseDateOnly,
  resolveBookingSelection,
} from "../../services/agendaService.js";
import { confirmAppointmentsWithoutPayment, confirmAppointmentWithoutPayment } from "../../services/appointmentConfirmationService.js";
import { crearReservaHoldBaseNormalizada } from "../../services/agendamientoReservaService.js";
import { releaseAppointmentHoldGroup } from "../../services/appointmentHoldReleaseService.js";
import { prepararBeneficioCanjeAgendamiento } from "../../services/agendamientoBeneficiosService.js";
import {
  confirmarComprobanteAgendamientoParaEnvio,
  enviarComprobanteAgendamientoNoFiscal,
} from "../../services/comprobanteAgendamientoEmailService.js";
import {
  createCoverageTracker,
  consumeCoverageForServices,
  ensureSubscriptionLifecycle,
  filterCoverageTrackerByTariffServices,
  getClienteMembershipState,
} from "../../services/membershipService.js";
import {
  applyRewardRedeemForConfirmedGroup,
  normalizeRedeemContextToken,
  resolveRedeemContextForHold,
} from "../../services/pointsService.js";
import {
  previewPromotionsForAppointment,
  recordPromotionApplications,
  markPromotionUsagesForGroup,
} from "../../services/promociones/promocionesService.js";

const CLIENT_ALLOWED_ROLES = ["cliente"];
const requestIdSchema = { type: "string" };
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOW_HOLD_CANJE_LEGACY = String(process.env.MF_HOLD_CANJE_USE_LEGACY || "").trim().toLowerCase() === "true"
  && String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

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
  ],
  additionalProperties: false,
};

const citaDetalleItemSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: ["string", "null"] },
    cantidad: { type: "integer" },
    duracion_min: { type: "integer" },
    buffer_min: { type: "integer" },
    precio_unitario_hnl: { type: "number" },
    subtotal_hnl: { type: "number" },
  },
  required: [
    "id_servicio",
    "nombre_servicio",
    "cantidad",
    "duracion_min",
    "buffer_min",
    "precio_unitario_hnl",
    "subtotal_hnl",
  ],
  additionalProperties: false,
};

const CITAS_SAFE_DETAIL_KEYS = new Set([
  "field",
  "blockIndex",
  "alias",
  "email",
  "rol_integrante_codigo",
  "orden_integrante",
]);

function sanitizeCitasErrorDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails)) return undefined;
  const safeDetails = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!CITAS_SAFE_DETAIL_KEYS.has(key)) continue;
    if (key === "blockIndex" || key === "orden_integrante") {
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
  if (error instanceof AppError) {
    const safeDetails = sanitizeCitasErrorDetails(error.details);
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      ...(safeDetails ? { details: safeDetails } : {}),
      requestId: request.id,
      exposeDetails: Boolean(safeDetails),
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
  };
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
    params.push(`${fechaDesde}T00:00:00`);
    conditions.push(`c.inicio_at >= $${params.length}::timestamptz`);
  }
  if (fechaHasta) {
    params.push(`${fechaHasta}T23:59:59.999`);
    conditions.push(`c.inicio_at <= $${params.length}::timestamptz`);
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
        c.notas
      FROM public.citas c
      JOIN public.sucursales s
        ON s.id_sucursal = c.id_sucursal
      JOIN public.empleados eb
        ON eb.id_empleado = c.id_empleado_barbero
      JOIN public.personas pb
        ON pb.id_persona = eb.id_persona
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
        cd.id_servicio,
        s.nombre_servicio,
        cd.cantidad,
        cd.duracion_min,
        cd.buffer_min,
        cd.precio_unitario_hnl,
        cd.subtotal_hnl
      FROM public.citas_detalles cd
      JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      WHERE cd.id_cita = $1::uuid
      ORDER BY s.nombre_servicio ASC, cd.id_cita_detalle ASC
    `,
    [citaId]
  );

  return rows.map((row) => ({
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio ?? null,
    cantidad: Number(row.cantidad ?? 1),
    duracion_min: Number(row.duracion_min),
    buffer_min: Number(row.buffer_min ?? 0),
    precio_unitario_hnl: Number(row.precio_unitario_hnl ?? 0),
    subtotal_hnl: Number(row.subtotal_hnl ?? 0),
  }));
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

async function getServicesWithActiveTariffByBranch(client, { idSucursal, serviceIds = [] }) {
  const safeBranchId = String(idSucursal || "").trim();
  const normalizedServiceIds = (Array.isArray(serviceIds) ? serviceIds : [])
    .map((serviceId) => String(serviceId || "").trim())
    .filter(Boolean);
  if (!safeBranchId || normalizedServiceIds.length === 0) return [];

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
          AND st.vigente_desde <= NOW()
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta > NOW())
      )
      SELECT id_servicio
      FROM ranked_tariffs
      WHERE row_num = 1
    `,
    [safeBranchId, normalizedServiceIds]
  );

  return rows
    .map((row) => String(row.id_servicio || "").trim())
    .filter(Boolean);
}

function resolveMembershipHoldMessage({ hasMembership, coverageTracker, membershipComputationFailed, rewardActive, branchName }) {
  if (rewardActive) {
    return "Se aplicara tu recompensa de cortesia al titular. Los extras y acompanantes se cobran normalmente.";
  }
  if (hasMembership && coverageTracker?.coverageDisabledReason === "branch_mismatch") {
    const planBranchLabel = coverageTracker.sucursalPlanNombre || "otra sucursal";
    const citaBranchLabel = branchName || "la sucursal seleccionada";
    return `Tu plan activo pertenece a ${planBranchLabel}. Si agendas en ${citaBranchLabel}, esta cita no sera cubierta por tu plan y deberas pagar el total.`;
  }
  if (hasMembership && coverageTracker?.coverageDisabledReason === "missing_contracted_branch") {
    return "Tu plan no tiene una sucursal valida asociada; calculamos la cita con tarifa normal.";
  }
  if (hasMembership && coverageTracker?.coverageDisabledReason === "services_without_active_tariff") {
    return "Tu plan no tiene servicios con tarifa activa en esta sucursal; calculamos la cita con tarifa normal.";
  }
  if (hasMembership && coverageTracker?.coverageDisabledReason === "coverage_resolution_error") {
    return coverageTracker.coverageDisabledMessage
      || "No pudimos aplicar beneficios de tu plan en este momento; calculamos la cita con tarifa normal.";
  }
  if (hasMembership && !coverageTracker?.hasServiceBenefitsAvailable) {
    return "Tu plan no tiene beneficios disponibles para cubrir esta cita.";
  }
  if (!hasMembership && membershipComputationFailed) {
    return "No pudimos validar beneficios de plan en este momento; calculamos la cita con tarifa normal.";
  }
  return null;
}

async function buildMembershipContextForNormalizedHold(client, {
  clienteId,
  idSucursal,
  branchName = null,
  rewardActive = false,
  logger = null,
} = {}) {
  let membershipState = null;
  try {
    membershipState = await getClienteMembershipState(client, clienteId);
  } catch (error) {
    logger?.warn?.(
      { id_cliente: clienteId, code: error?.code || null },
      "No se pudo leer estado de membresia para respuesta de hold."
    );
  }

  if (rewardActive) {
    return {
      coverageTracker: createCoverageTracker(null, { appointmentBranchId: idSucursal, planBranchName: null }),
      estado_plan: membershipState?.estado_plan || "sin_plan_activo",
      mensaje: resolveMembershipHoldMessage({ rewardActive: true }),
    };
  }

  let activeMembership = null;
  let membershipComputationFailed = false;
  try {
    activeMembership = await ensureSubscriptionLifecycle(client, clienteId, { forUpdate: false });
  } catch (error) {
    membershipComputationFailed = true;
    logger?.warn?.(
      { id_cliente: clienteId, id_sucursal: idSucursal, code: error?.code || null },
      "No se pudo calcular cobertura de membresia para hold normalizado. Se aplicara tarifa normal."
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
    ? await getBranchNameById(client, contractedBranchId)
    : null;
  const coverageTracker = createCoverageTracker(activeMembership, {
    appointmentBranchId: idSucursal,
    planBranchName: contractedBranchName,
  });

  if (coverageTracker?.coverageEnabled && Array.isArray(coverageTracker.requiredServiceIds) && coverageTracker.requiredServiceIds.length > 0) {
    const servicesWithActiveTariff = await getServicesWithActiveTariffByBranch(client, {
      idSucursal,
      serviceIds: coverageTracker.requiredServiceIds,
    });
    filterCoverageTrackerByTariffServices(coverageTracker, servicesWithActiveTariff);
  }

  if (membershipComputationFailed) {
    coverageTracker.coverageEnabled = false;
    coverageTracker.coverageDisabledReason = "coverage_resolution_error";
    coverageTracker.coverageDisabledMessage = "No pudimos aplicar tu plan en este momento; calculamos la cita con tarifa normal.";
  }

  const hasMembership = Boolean(coverageTracker.hasPlan && coverageTracker.idSuscripcion);
  return {
    coverageTracker,
    estado_plan: membershipState?.estado_plan || (hasMembership ? "activo" : "sin_plan_activo"),
    mensaje: resolveMembershipHoldMessage({
      hasMembership,
      coverageTracker,
      membershipComputationFailed,
      rewardActive: false,
      branchName,
    }),
  };
}

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function parseIsoDateAndTime(rawDateTime) {
  const match = String(rawDateTime || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return { fecha: null, hora: null };
  return { fecha: match[1], hora: match[2] };
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

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
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
  const parsed = new Date(String(rawDateTime || "").trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `${field} no es valida`, {
      code: "CITAS_HOLD_INVALID_DATETIME",
      details: { field, value: rawDateTime },
    });
  }

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

function validateAuthenticatedCompanionContactPayload(contacto, { alias, index }) {
  const payload = contacto && typeof contacto === "object" ? contacto : {};
  const nombre = String(payload.nombre || alias || `Acompanante ${index}`).trim().slice(0, 120) || `Acompanante ${index}`;
  const email = normalizeEmail(payload.email);
  const rawTelefono = String(payload.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);

  if (email && !EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "El correo del acompanante debe ser valido", {
      code: "CITAS_HOLD_COMPANION_EMAIL_INVALID",
      details: { field: "contacto.email", alias, index },
    });
  }
  if (rawTelefono && hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "El telefono del acompanante no admite letras", {
      code: "CITAS_HOLD_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, index },
    });
  }
  if (telefono && telefono.length < 8) {
    throw new AppError(400, "El telefono del acompanante debe ser valido", {
      code: "CITAS_HOLD_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, index },
    });
  }

  return {
    nombre,
    email: email || null,
    telefono: telefono || null,
  };
}

function mapRedeemErrorToSafeAppError(error) {
  if (!(error instanceof AppError)) return null;
  const rawCode = String(error.code || "").trim().toUpperCase();
  if (!rawCode.startsWith("POINTS_REDEEM_")) return null;

  const mappings = {
    POINTS_REDEEM_CONTEXT_INVALID: { statusCode: 409, code: "REDEEM_CONTEXT_INVALID", message: "El contexto de canje no es valido." },
    POINTS_REDEEM_CONTEXT_VERSION_INVALID: { statusCode: 409, code: "REDEEM_CONTEXT_INVALID", message: "El contexto de canje no es valido." },
    POINTS_REDEEM_CONTEXT_EXPIRED: { statusCode: 409, code: "REDEEM_EXPIRED", message: "El contexto de canje expiro. Intenta nuevamente." },
    POINTS_REDEEM_CONTEXT_FORBIDDEN: { statusCode: 403, code: "REDEEM_NOT_OWNED_BY_USER", message: "No puedes usar este canje con la sesion actual." },
    POINTS_REDEEM_CONTEXT_BRANCH_MISMATCH: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje no aplica a la sucursal seleccionada." },
    POINTS_REDEEM_INSUFFICIENT_BALANCE_CONFIRM: { statusCode: 409, code: "REDEEM_AMOUNT_INVALID", message: "No hay puntos suficientes para aplicar el canje." },
    POINTS_REDEEM_SERVICE_MISMATCH: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje no aplica a la seleccion actual." },
    POINTS_REDEEM_SERVICE_INVALID_ON_CONFIRM: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "El canje no aplica a la seleccion actual." },
    POINTS_REDEEM_SERVICE_AMBIGUOUS: { statusCode: 409, code: "REDEEM_NOT_APPLICABLE", message: "No fue posible determinar el servicio del canje." },
    POINTS_REDEEM_ALREADY_APPLIED: { statusCode: 409, code: "REDEEM_TRANSACTION_ALREADY_USED", message: "El canje ya fue utilizado para esta reserva." },
  };
  const mapped = mappings[rawCode];
  if (!mapped) return null;
  return new AppError(mapped.statusCode, mapped.message, { code: mapped.code });
}

function ensureAuthenticatedUserNotCompanion(integrantes, authenticatedEmail) {
  const actorEmail = normalizeEmail(authenticatedEmail);
  if (!actorEmail) return;

  for (let index = 1; index < integrantes.length; index += 1) {
    const email = normalizeEmail(integrantes[index]?.contacto?.email);
    if (!email) continue;
    if (email !== actorEmail) continue;
    throw new AppError(409, "El titular de la sesion no puede agregarse como acompanante.", {
      code: "AUTHENTICATED_USER_CANNOT_BE_COMPANION",
      details: { field: "contacto.email", blockIndex: index },
    });
  }
}

function hasPromotionsRequestedInBlocks(integrantes = []) {
  return (Array.isArray(integrantes) ? integrantes : []).some((item) =>
    Array.isArray(item?.promotionIds) && item.promotionIds.length > 0
  );
}

function normalizeHoldBlocksPayload(body) {
  const normalizePromotionIds = (rawValue, fieldBase) => {
    const list = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
    const unique = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const safeId = assertUuid(list[i], `${fieldBase}[${i}]`);
      if (safeId) unique.add(safeId);
    }
    return [...unique];
  };

  const rootPromotionIds = normalizePromotionIds(
    [
      ...(body?.promotionId ? [body.promotionId] : []),
      ...(Array.isArray(body?.promotionIds) ? body.promotionIds : []),
    ],
    "promotionIds"
  );

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
      promotionId: body?.promotionId ?? null,
      promotionIds: Array.isArray(body?.promotionIds) ? body.promotionIds : [],
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
    const blockPromotionIds = normalizePromotionIds(
      [
        ...(item?.promotionId ? [item.promotionId] : []),
        ...(Array.isArray(item?.promotionIds) ? item.promotionIds : []),
      ],
      `integrantes[${index}].promotionIds`
    );
    const promotionIds = [...new Set([
      ...(index === 0 ? rootPromotionIds : []),
      ...blockPromotionIds,
    ])];
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
      promotionIds,
      contacto: index === 0
        ? { nombre: null, email: null, telefono: null }
        : validateAuthenticatedCompanionContactPayload(item?.contacto, { alias, index }),
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

async function resolveAuthenticatedTitularContact(client, { personaId, claimsUser, titularPayload }) {
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

  if (!EMAIL_PATTERN.test(profileEmail)) {
    throw new AppError(409, "No se pudo validar el correo de la cuenta autenticada", {
      code: "CITAS_HOLD_ACCOUNT_EMAIL_INVALID",
    });
  }

  const payload = titularPayload && typeof titularPayload === "object"
    ? titularPayload
    : {};
  const payloadEmail = normalizeEmail(payload.email || "");
  if (payloadEmail && payloadEmail !== profileEmail) {
    throw new AppError(409, "La informacion del titular no coincide con la sesion activa.", {
      code: "AUTHENTICATED_HOLDER_MISMATCH",
      details: { field: "titular.email" },
    });
  }
  const inputNombres = normalizePersonName(payload.nombres || "");
  const inputApellidos = normalizePersonName(payload.apellidos || "");
  const inputPhoneRaw = String(payload.telefono || "").trim();
  const inputPhone = normalizePhone(inputPhoneRaw);
  const guardarNombresApellidos = Boolean(payload.guardar_nombres_apellidos);
  const guardarTelefono = Boolean(payload.guardar_telefono);

  if (inputPhoneRaw && hasPhoneLetters(inputPhoneRaw)) {
    throw new AppError(400, "El telefono del titular no admite letras", {
      code: "CITAS_HOLD_TITULAR_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }
  if (inputPhoneRaw && inputPhone.length < 8) {
    throw new AppError(400, "El telefono del titular debe ser valido", {
      code: "CITAS_HOLD_TITULAR_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }

  const missingNombres = !profileNombres;
  const missingApellidos = !profileApellidos;
  const missingTelefono = profilePhone.length < 8;

  const effectiveNombres = profileNombres || (missingNombres ? inputNombres : "");
  const effectiveApellidos = profileApellidos || (missingApellidos ? inputApellidos : "");
  const effectivePhone = profilePhone || (missingTelefono ? inputPhone : "");
  const fullName = buildFullName(effectiveNombres, effectiveApellidos);

  if (!effectiveNombres) {
    throw new AppError(400, "El nombre del titular es obligatorio", {
      code: "CITAS_HOLD_TITULAR_NAME_REQUIRED",
      details: { field: "titular.nombres" },
    });
  }
  if (!effectiveApellidos) {
    throw new AppError(400, "El apellido del titular es obligatorio", {
      code: "CITAS_HOLD_TITULAR_LAST_NAME_REQUIRED",
      details: { field: "titular.apellidos" },
    });
  }
  if (!effectivePhone || effectivePhone.length < 8) {
    throw new AppError(400, "El telefono del titular es obligatorio", {
      code: "CITAS_HOLD_TITULAR_PHONE_REQUIRED",
      details: { field: "titular.telefono" },
    });
  }

  if (guardarNombresApellidos && (missingNombres || missingApellidos)) {
    await client.query(
      `
        UPDATE public.personas
        SET nombres = CASE
              WHEN (nombres IS NULL OR btrim(nombres) = '') AND $2::text <> '' THEN $2
              ELSE nombres
            END,
            apellidos = CASE
              WHEN (apellidos IS NULL OR btrim(apellidos) = '') AND $3::text <> '' THEN $3
              ELSE apellidos
            END,
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [personaId, inputNombres, inputApellidos]
    );
  }

  if (guardarTelefono && missingTelefono && inputPhone.length >= 8) {
    await client.query(
      `
        UPDATE public.personas
        SET telefono_principal = CASE
              WHEN telefono_principal IS NULL OR btrim(telefono_principal) = '' THEN $2
              ELSE telefono_principal
            END,
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [personaId, inputPhone]
    );
  }

  return {
    fullName,
    nombres: effectiveNombres,
    apellidos: effectiveApellidos,
    email: profileEmail,
    telefono: effectivePhone,
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
            promotionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            promotionIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
            },
            id_points_tx_canje: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
            canje_context_token: { anyOf: [{ type: "string", minLength: 16, maxLength: 1200 }, { type: "null" }] },
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
        const selectionType = String(request.body?.selection_type || "services").trim().toLowerCase();
        const serviceIds = Array.isArray(request.body?.servicios)
          ? request.body.servicios.map((item) => item.id_servicio)
          : [];
        const promotionIds = [
          ...(request.body?.promotionId ? [request.body.promotionId] : []),
          ...(Array.isArray(request.body?.promotionIds) ? request.body.promotionIds : []),
        ]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const canjeContextToken = String(
          request.body?.canje_context_token
          ?? request.body?.id_points_tx_canje
          ?? ""
        ).trim();
        if (promotionIds.length > 0) {
          throw new AppError(409, "Esta operacion requiere el flujo normalizado de hold.", {
            code: "DIRECT_BOOKING_REQUIRES_NORMALIZED_HOLD",
          });
        }
        if (canjeContextToken) {
          throw new AppError(409, "El canje solo esta disponible en el flujo de hold autenticado.", {
            code: "LEGACY_DIRECT_BOOKING_UNSUPPORTED",
          });
        }
        const packageId = parseSinglePackageId(request.body?.id_paquete, {
          required: false,
          field: "id_paquete",
        });
        const simulationNoPayment = isSimulationNoPaymentEnabled(await getSystemParameters(dbClient));
        const agendamientoConfig = await getAgendamientoConfig(dbClient, { logger: request.log });
        const holdResult = await crearReservaHoldBaseNormalizada({
          client: dbClient,
          logger: request.log,
          actor: {
            tipo: "authenticated",
            id_usuario: usuarioId || null,
            id_persona: personaId || null,
            id_cliente: clienteId || null,
            roles: Array.isArray(request.claims?.roles) ? request.claims.roles : [],
          },
          titular: {
            id_usuario: usuarioId || null,
            id_persona: personaId || null,
            id_cliente: clienteId || null,
          },
          integrantes: [
            {
              orden_integrante: 1,
              alias: "Titular",
              id_barbero: request.body.id_barbero ?? null,
              selection_type: selectionType,
              id_paquete: packageId,
              fecha_inicio: request.body.fecha_inicio,
              serviceIds,
              promotionIds: [],
              contacto: {
                nombre: String(request.claims?.user?.nombre_completo || "").trim() || "Titular",
                email: normalizeEmail(request.claims?.user?.email || "") || null,
                telefono: null,
              },
            },
          ],
          id_sucursal: request.body.id_sucursal,
          origen_codigo: "cliente_autenticado",
          notas: request.body?.notas ?? null,
          agendamientoConfig,
          hold_state: "activo",
          appointment_state: "en_espera",
        });

        const citas = Array.isArray(holdResult?.citas) ? holdResult.citas : [];
        const bloques = Array.isArray(holdResult?.bloques) ? holdResult.bloques : [];
        const primaryCita = citas.find((item) => Number(item?.orden_integrante) === 1) || citas[0] || null;
        const primaryBlock = primaryCita
          ? (bloques.find((item) => String(item?.id_cita || "") === String(primaryCita.id_cita || "")) || null)
          : (bloques[0] || null);

        if (!primaryCita?.id_cita) {
          throw new AppError(500, "No se pudo crear la cita", {
            code: "BOOKING_CREATION_FAILED",
          });
        }

        if (simulationNoPayment) {
          await confirmAppointmentWithoutPayment(dbClient, {
            id_cita: primaryCita.id_cita,
            motivo_confirmacion: "simulacion_sin_pago_cliente_simple",
          });
        }

        return sendOk(
          reply,
          {
            id_cita: primaryCita.id_cita,
            estado_cita_codigo: simulationNoPayment ? "confirmada" : "en_espera",
            id_barbero: primaryCita.id_barbero,
            nombre_barbero: primaryBlock?.nombre_barbero || "Sin nombre",
            asignada_automaticamente: !request.body.id_barbero,
            expires_at: simulationNoPayment ? null : (holdResult?.expires_at || null),
            duracion_total_min: Number(primaryBlock?.duracion_total_min || 0),
            buffer_total_min: Number(primaryBlock?.buffer_total_min || 0),
            monto_total_hnl: Number(
              primaryBlock?.monto_total_hnl
              ?? primaryCita?.total_hnl
              ?? holdResult?.monto_total_hnl
              ?? holdResult?.total_hnl
              ?? 0
            ),
          },
          { statusCode: 201 }
        );
      } catch (error) {
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
                email: { anyOf: [{ type: "string", format: "email", maxLength: 160 }, { type: "null" }] },
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
                  promotionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  promotionIds: {
                    type: "array",
                    items: { type: "string", format: "uuid" },
                  },
                  contacto: {
                    type: "object",
                    properties: {
                      nombre: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
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
            promotionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            promotionIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
            },
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

        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const canjeContextTokenRaw = request.body?.canje_context_token ?? request.body?.id_points_tx_canje;
        const canjeContextToken = canjeContextTokenRaw
          ? normalizeRedeemContextToken(canjeContextTokenRaw)
          : null;
        const branch = await ensureActiveBranch(dbClient, idSucursal);
        const integrantes = normalizeHoldBlocksPayload(request.body);
        const agendamientoConfig = await getAgendamientoConfig(dbClient, { logger: request.log });
        const titularContact = await resolveAuthenticatedTitularContact(dbClient, {
          personaId,
          claimsUser: request.claims?.user,
          titularPayload: request.body?.titular,
        });
        if (integrantes[0]) {
          integrantes[0] = {
            ...integrantes[0],
            alias: titularContact.fullName || integrantes[0].alias || "Titular",
            contacto: {
              nombre: titularContact.fullName,
              nombres: titularContact.nombres,
              apellidos: titularContact.apellidos,
              email: titularContact.email,
              telefono: titularContact.telefono,
            },
          };
        }
        ensureAuthenticatedUserNotCompanion(integrantes, titularContact.email);
        if (canjeContextToken && hasPromotionsRequestedInBlocks(integrantes)) {
          throw new AppError(409, "No es posible combinar canje y promociones en la misma reserva.", {
            code: "REDEEM_NOT_APPLICABLE",
          });
        }

        const requestedLegacyRedeemAdapter = Boolean(
          canjeContextToken
          && String(process.env.MF_HOLD_CANJE_USE_LEGACY || "").trim().toLowerCase() === "true"
        );
        if (requestedLegacyRedeemAdapter && !ALLOW_HOLD_CANJE_LEGACY) {
          request.log.warn(
            {
              requestId: request.id,
              flow: "legacy_redeem_membership_adapter",
              node_env: process.env.NODE_ENV || null,
              guard: "MF_HOLD_CANJE_USE_LEGACY disabled outside production",
            },
            "Intento de activar adapter legacy de canje bloqueado por guard de entorno."
          );
        }
        const useLegacyRedeemAdapter = requestedLegacyRedeemAdapter && ALLOW_HOLD_CANJE_LEGACY;
        if (!useLegacyRedeemAdapter) {
          const beneficioAgendamiento = canjeContextToken
            ? await prepararBeneficioCanjeAgendamiento({
              client: dbClient,
              logger: request.log,
              actor: {
                id_usuario: usuarioId || null,
                id_persona: personaId || null,
                id_cliente: clienteId || null,
              },
              id_sucursal: branch.id_sucursal,
              canje_context_token: canjeContextToken,
              id_points_tx_canje: request.body?.id_points_tx_canje ?? null,
              blocks: integrantes,
              agendamientoConfig,
            })
            : null;
          const membresiaAgendamiento = await buildMembershipContextForNormalizedHold(dbClient, {
            clienteId,
            idSucursal: branch.id_sucursal,
            branchName: branch.nombre_sucursal,
            rewardActive: Boolean(beneficioAgendamiento?.aplica),
            logger: request.log,
          });

          const holdResult = await crearReservaHoldBaseNormalizada({
            client: dbClient,
            logger: request.log,
            actor: {
              tipo: "authenticated",
              id_usuario: usuarioId || null,
              id_persona: personaId || null,
              id_cliente: clienteId || null,
              roles: Array.isArray(request.claims?.roles) ? request.claims.roles : [],
            },
            titular: {
              id_usuario: usuarioId || null,
              id_persona: personaId || null,
              id_cliente: clienteId || null,
            },
            integrantes,
            id_sucursal: branch.id_sucursal,
            origen_codigo: "cliente_autenticado",
            notas: request.body?.notas ?? null,
            agendamientoConfig,
            hold_state: "activo",
            appointment_state: "en_espera",
            beneficioAgendamiento,
            membresiaAgendamiento,
          });

          const bloques = Array.isArray(holdResult?.bloques) ? holdResult.bloques : [];
          const beneficio = holdResult?.beneficio || null;
          const membresia = holdResult?.membresia || null;
          const totalPagarHnl = Number(holdResult?.total_pagar_hnl || 0);
          const membresiaItemsCubiertos = Array.isArray(membresia?.servicios_cubiertos)
            ? membresia.servicios_cubiertos.length
            : 0;
          return sendOk(reply, {
            id_grupo_cita: holdResult.id_grupo_cita,
            estado_grupo_codigo: holdResult.estado_grupo_codigo || "activo",
            expires_at: holdResult.expires_at || null,
            subtotal_hnl: Number(holdResult?.subtotal_hnl || 0),
            monto_total_hnl: Number(holdResult?.monto_total_hnl || totalPagarHnl),
            descuento_total_hnl: Number(holdResult?.descuento_total_hnl || 0),
            total_pagar_hnl: totalPagarHnl,
            extras_pendientes_hnl: Number(holdResult?.extras_a_pagar_hnl ?? totalPagarHnl),
            resumen_cobertura: {
              items_cubiertos: membresiaItemsCubiertos + (beneficio?.aplica ? 1 : 0),
              items_extra: 0,
            },
            recompensa: {
              aplicada: Boolean(beneficio?.aplica),
              id_points_tx_canje: beneficio?.id_points_tx_canje || null,
              canje_context_token: beneficio?.canje_context_token || null,
              servicio_nombre: beneficio?.metadata_segura?.servicio_nombre || null,
              puntos_requeridos: Number(beneficio?.puntos_requeridos || 0),
              cubierto_hnl: Number(beneficio?.monto_cubierto_hnl || 0),
              extras_a_pagar_hnl: Number(beneficio?.monto_pendiente_hnl ?? totalPagarHnl),
              mensaje: beneficio?.aplica
                ? "Recompensa aplicada correctamente. Los extras y acompanantes se cobran aparte."
                : null,
              id_cita_asociada: null,
            },
            membresia: membresia || {
              cobertura_activa: false,
              id_suscripcion: null,
              id_sucursal_contratada: null,
              sucursal_plan_nombre: null,
              nombre_plan: null,
              estado_plan: "sin_plan_activo",
              mensaje: null,
              servicios_cubiertos: [],
              servicios_forzados: [],
              cubierto_por_plan_hnl: 0,
              extras_a_pagar_hnl: totalPagarHnl,
            },
            bloques,
          }, {
            statusCode: 201,
            requestId: request.id,
          });
        }

        request.log.info(
          { requestId: request.id, flow: "legacy_redeem_membership_adapter" },
          "Hold autenticado con canje usa adapter legacy controlado."
        );

        await dbClient.query("BEGIN");
        txStarted = true;
        const rewardRedeemContext = canjeContextToken
          ? await resolveRedeemContextForHold(dbClient, {
            idCliente: clienteId,
            canjeContextToken,
            idSucursal: branch.id_sucursal,
          })
          : null;
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

        const groupInsert = await dbClient.query(
          `
            INSERT INTO public.citas_grupos (
              id_sucursal,
              id_persona_titular,
              id_cliente_titular,
              estado_grupo_codigo,
              notas
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, 'activo', $4)
            RETURNING id_grupo_cita, estado_grupo_codigo
          `,
          [
            branch.id_sucursal,
            personaId,
            clienteId,
            request.body?.notas ?? null,
          ]
        );

        const groupRecord = groupInsert.rows[0];
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
          const isTitular = integrante.orden_integrante <= 1;
          const selectionBase = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            selection_type: integrante.selection_type,
            servicios: integrante.serviceIds,
            id_paquete: integrante.id_paquete,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
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
          const subtotalServicios = Number(selection.serviceSelection.monto_total_hnl || 0);
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

          try {
            const promoContext = {
              id_sucursal: branch.id_sucursal,
              id_empleado_barbero: selection.barber.id_empleado,
              id_cliente: clienteId,
              id_persona: personaId,
              id_grupo_cita: groupRecord.id_grupo_cita,
              fecha_hora: selection.startDateTime.toISOString(),
              fecha: selection.startDateTime.toISOString().slice(0, 10),
              fecha_operativa: selection.startDateTime.toISOString().slice(0, 10),
              hora: selection.startDateTime.toISOString().slice(11, 16),
              subtotal_hnl: totalPagar,
              servicios: selection.serviceSelection.items || [],
              paquetes: selection.serviceSelection.id_paquete
                ? [{ id_paquete: selection.serviceSelection.id_paquete }]
                : [],
              codigo_promocional: request.body?.codigo_promocional || null,
              canal: "privado",
              es_cliente_autenticado: true,
              es_titular: isTitular,
            };
            promocionesPreview = await previewPromotionsForAppointment(dbClient, promoContext);
            if (!promocionesPreview.usedFallbackLegacy) {
              descuentoPromociones = Number(promocionesPreview.descuento_total_hnl || 0);
              totalPagar = Math.max(0, Number((totalPagar - descuentoPromociones).toFixed(2)));
            }
          } catch (promoError) {
            request.log.warn(
              {
                requestId: request.id,
                id_sucursal: branch.id_sucursal,
                id_grupo_cita: groupRecord.id_grupo_cita,
                code: promoError?.code || null,
                message: promoError?.message || null,
              },
              "No se pudo evaluar promociones normalizadas; se mantiene fallback legacy"
            );
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

          const finAt = new Date(selection.startDateTime.getTime() + selection.serviceSelection.duracion_total_min * 60 * 1000);

          const citaInsert = await dbClient.query(
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
                notas
              )
              VALUES (
                $1::uuid,
                $2::int,
                $3,
                $4::uuid,
                $5::uuid,
                $6::uuid,
                $7::uuid,
                $8::uuid,
                $9::boolean,
                'en_espera',
                $10::timestamptz,
                $11::timestamptz,
                $12::int,
                $13::int,
                $14::numeric,
                $15::numeric,
                $16::numeric,
                $17::boolean,
                $18::text,
                $19::uuid,
                $20
              )
              RETURNING id_cita
            `,
            [
              groupRecord.id_grupo_cita,
              integrante.orden_integrante,
              integrante.alias,
              branch.id_sucursal,
              selection.barber.id_empleado,
              personaId,
              clienteId,
              usuarioId,
              !integrante.id_barbero,
              selection.startDateTime.toISOString(),
              finAt.toISOString(),
              selection.serviceSelection.duracion_total_min,
              selection.serviceSelection.buffer_total_min,
              subtotalServicios,
              descuentoTotal,
              totalPagar,
              Boolean(isTitular && rewardRedeemContext),
              selection.serviceSelection.selection_type || integrante.selection_type || "services",
              selection.serviceSelection.id_paquete || integrante.id_paquete || null,
              request.body?.notas ?? null,
            ]
          );

          const citaId = citaInsert.rows[0].id_cita;
          if (promocionesPreview && !promocionesPreview.usedFallbackLegacy) {
            try {
              await recordPromotionApplications(
                dbClient,
                {
                  id_grupo_cita: groupRecord.id_grupo_cita,
                  id_cita: citaId,
                  id_cliente: clienteId,
                  id_persona: personaId,
                  id_sucursal: branch.id_sucursal,
                  fecha_operativa: selection.startDateTime.toISOString().slice(0, 10),
                  subtotal_hnl: Number(coverage.extraTotalHnl || 0),
                },
                promocionesPreview,
                { formal: false }
              );
            } catch (promoPersistError) {
              request.log.warn(
                {
                  requestId: request.id,
                  id_cita: citaId,
                  id_grupo_cita: groupRecord.id_grupo_cita,
                  code: promoPersistError?.code || null,
                  message: promoPersistError?.message || null,
                },
                "No se pudo registrar trazabilidad de promociones en hold; se continua"
              );
            }
          }
          if (isTitular && rewardRedeemContext) {
            rewardAppliedInHold = true;
            rewardLinkedCitaId = citaId;
            rewardCoveredTotalHnl += rewardCoveredInBlock;
          }

          for (const serviceItem of selection.serviceSelection.items) {
            await dbClient.query(
              `
                INSERT INTO public.citas_detalles (
                  id_cita,
                  id_servicio,
                  cantidad,
                  duracion_min,
                  buffer_min,
                  precio_unitario_hnl,
                  subtotal_hnl
                )
                VALUES ($1::uuid, $2::uuid, 1, $3::int, $4::int, $5::numeric, $6::numeric)
              `,
              [
                citaId,
                serviceItem.id_servicio,
                serviceItem.duracion_min,
                serviceItem.buffer_min,
                serviceItem.precio_hnl,
                serviceItem.precio_hnl,
              ]
            );
          }

          await dbClient.query(
            `
              INSERT INTO public.citas_holds (
                id_cita,
                id_usuario,
                estado_hold_codigo,
                expires_at
              )
              VALUES ($1::uuid, $2::uuid, 'activo', $3::timestamptz)
            `,
            [citaId, holdUserId, holdExpiresAt.toISOString()]
          );

          const { fecha, hora } = parseIsoDateAndTime(integrante.fecha_inicio);
          const coveredCount = coverage.items.filter((entry) =>
            entry.coverage_status === "cubierto_plan" || entry.coverage_status === "cubierto_recompensa"
          ).length;
          const extraCount = coverage.items.filter((entry) => entry.coverage_status === "extra_pendiente").length;
          coveredItemsCount += coveredCount;
          extraItemsCount += extraCount;
          subtotalGrupo += subtotalServicios;
          descuentoGrupo += descuentoTotal;
          totalGrupo += totalPagar;
          extrasPendientesGrupo += totalPagar;

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
            monto_total_hnl: subtotalServicios,
            descuento_hnl: descuentoTotal,
            total_pagar_hnl: totalPagar,
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

        const mappedRedeemError = mapRedeemErrorToSafeAppError(error);
        if (mappedRedeemError) {
          return sendError(reply, mappedRedeemError.statusCode, mappedRedeemError.message, {
            code: mappedRedeemError.code,
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, error, "No se pudo crear el hold de citas", "CITAS_HOLD_CREATE_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.delete(
    "/hold/:id_grupo_cita",
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
              data: {
                type: "object",
                properties: {
                  id_grupo_cita: { type: "string", format: "uuid" },
                  released: { type: "boolean" },
                  estado_grupo_codigo: { type: "string" },
                  citas_liberadas: { type: "integer" },
                },
                required: ["id_grupo_cita", "released", "estado_grupo_codigo", "citas_liberadas"],
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
        const { clienteId, personaId } = ensureClientContext(request);
        const groupId = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
        await expireReservationsBestEffort(dbClient, request, "citas_hold_release");
        const releaseResult = await releaseAppointmentHoldGroup(dbClient, {
          groupId,
          mode: "authenticated",
          clienteId,
          personaId,
        });
        return sendOk(reply, releaseResult);
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo liberar el hold autenticado", "CITAS_HOLD_RELEASE_ERROR");
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
          step = "confirmarComprobanteAgendamientoParaEnvio";
          const receiptConfirm = await confirmarComprobanteAgendamientoParaEnvio({
            client: dbClient,
            logger: request.log,
            id_grupo_cita: group.id_grupo_cita,
            resultadoReservaCodigo: "confirmada",
            comprobanteEmailHabilitado: true,
          });

          if (receiptConfirm.found) {
            step = "enviarComprobanteAgendamientoNoFiscal";
            const delivery = await enviarComprobanteAgendamientoNoFiscal({
              app,
              client: dbClient,
              logger: request.log,
              id_grupo_cita: group.id_grupo_cita,
              id_comprobante_agendamiento: receiptConfirm.id_comprobante_agendamiento,
              modo: "post_confirmacion_sin_pago_autenticado",
              comprobanteEmailHabilitado: true,
            });
            emailDispatch = {
              emailEnviado: Number(delivery?.sent || 0) > 0,
              emailOmitido: delivery?.reason || (Number(delivery?.pending || 0) > 0 ? "pendiente_envio" : null),
            };
          } else {
            request.log.warn(
              {
                requestId: request.id,
                id_grupo_cita: group.id_grupo_cita,
                code: "BOOKING_RECEIPT_NOT_FOUND_FALLBACK_LEGACY",
              },
              "Comprobante normalizado no encontrado; se usa fallback legacy de correo."
            );
            step = "sendNoPaymentConfirmationEmails_legacy_fallback";
            emailDispatch = await sendNoPaymentConfirmationEmails(app, request.log, {
              groupId: group.id_grupo_cita,
              confirmationRows: details,
            });
          }
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
