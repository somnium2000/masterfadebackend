import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  ensureActiveBranch,
  expireStaleAppointmentReservations,
  OCCUPIED_APPOINTMENT_STATES,
  assertUuid,
  getSystemParameters,
  parseDateOnly,
  resolveBookingSelection,
} from "../../services/agendaService.js";
import { confirmAppointmentsWithoutPayment, confirmAppointmentWithoutPayment } from "../../services/appointmentConfirmationService.js";
import {
  createCoverageTracker,
  consumeCoverageForServices,
  ensureSubscriptionLifecycle,
  getClienteMembershipState,
} from "../../services/membershipService.js";

const CLIENT_ALLOWED_ROLES = ["cliente"];
const requestIdSchema = { type: "string" };
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";

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
    details: error instanceof Error ? error.message : "Unknown citas error",
    requestId: request.id,
  });
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

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function parseIsoDateAndTime(rawDateTime) {
  const match = String(rawDateTime || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return { fecha: null, hora: null };
  return { fecha: match[1], hora: match[2] };
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

function normalizeHoldBlocksPayload(body) {
  const hasGroupedPayload = Array.isArray(body?.integrantes) && body.integrantes.length > 0;
  const hasLegacySelection = body?.selection_type === "package"
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
    const packageId = item?.id_paquete ? assertUuid(item.id_paquete, "id_paquete") : null;

    if (!["services", "package"].includes(selectionType)) {
      throw new AppError(400, `El integrante ${alias} tiene un selection_type invalido`, {
        code: "CITAS_HOLD_BLOCK_SELECTION_TYPE_INVALID",
        details: { alias, index, selection_type: item?.selection_type ?? null },
      });
    }

    if (selectionType === "services" && !servicios.length) {
      throw new AppError(400, `El integrante ${alias} no tiene servicios seleccionados`, {
        code: "CITAS_HOLD_BLOCK_SERVICES_REQUIRED",
        details: { alias, index },
      });
    }

    if (selectionType === "package" && !packageId) {
      throw new AppError(400, `El integrante ${alias} no tiene paquete seleccionado`, {
        code: "CITAS_HOLD_BLOCK_PACKAGE_REQUIRED",
        details: { alias, index },
      });
    }

    const serviceIds = selectionType === "services"
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

function isSimulationNoPaymentEnabled(paramsMap) {
  return Boolean(paramsMap?.simulacion_sin_pago?.valor_booleano ?? true);
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
            selection_type: { type: "string", enum: ["services", "package"] },
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
        const selectionType = String(request.body?.selection_type || "services").trim().toLowerCase();
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
        });

        await dbClient.query("BEGIN");

        const citaInsert = await dbClient.query(
          `
            INSERT INTO public.citas (
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
              notas
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5::uuid,
              $6::boolean,
              'en_espera',
              $7::timestamptz,
              $8::timestamptz,
              $9::int,
              $10::int,
              $11::numeric,
              0,
              $12::numeric,
              $13::text,
              $14::uuid,
              $15
            )
            RETURNING id_cita
          `,
          [
            selection.branch.id_sucursal,
            selection.barber.id_empleado,
            personaId,
            clienteId,
            usuarioId,
            !request.body.id_barbero,
            selection.startDateTime.toISOString(),
            new Date(selection.startDateTime.getTime() + selection.serviceSelection.duracion_total_min * 60 * 1000).toISOString(),
            selection.serviceSelection.duracion_total_min,
            selection.serviceSelection.buffer_total_min,
            selection.serviceSelection.monto_total_hnl,
            selection.serviceSelection.monto_total_hnl,
            selection.serviceSelection.selection_type || selectionType,
            selection.serviceSelection.id_paquete || request.body?.id_paquete || null,
            request.body?.notas ?? null,
          ]
        );

        const citaId = citaInsert.rows[0].id_cita;

        for (const item of selection.serviceSelection.items) {
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
              item.id_servicio,
              item.duracion_min,
              item.buffer_min,
              item.precio_hnl,
              item.precio_hnl,
            ]
          );
        }

        const holdInsert = await dbClient.query(
          `
            INSERT INTO public.citas_holds (
              id_cita,
              id_usuario,
              estado_hold_codigo,
              expires_at
            )
            VALUES ($1::uuid, $2::uuid, 'activo', $3::timestamptz)
            RETURNING id_hold, expires_at
          `,
          [citaId, usuarioId, selection.expiresAt.toISOString()]
        );

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
            expires_at: simulationNoPayment ? null : new Date(holdInsert.rows[0].expires_at).toISOString(),
            duracion_total_min: selection.serviceSelection.duracion_total_min,
            buffer_total_min: selection.serviceSelection.buffer_total_min,
            monto_total_hnl: selection.serviceSelection.monto_total_hnl,
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
            details: error instanceof Error ? error.message : "Cita conflict",
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
                  selection_type: { type: "string", enum: ["services", "package"] },
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
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            },
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            fecha_inicio: { type: "string", format: "date-time" },
            selection_type: { type: "string", enum: ["services", "package"] },
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
        await expireStaleAppointmentReservations(dbClient, { logger: request.log });

        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const branch = await ensureActiveBranch(dbClient, idSucursal);
        const integrantes = normalizeHoldBlocksPayload(request.body);

        await dbClient.query("BEGIN");
        txStarted = true;
        const simulationNoPayment = isSimulationNoPaymentEnabled(await getSystemParameters(dbClient));

        const activeMembership = await ensureSubscriptionLifecycle(dbClient, clienteId, { forUpdate: true });
        const coverageTracker = createCoverageTracker(activeMembership);
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
        const holdExpiresAt = new Date(Date.now() + (5 * 60 * 1000));
        const holdUserId = integrantes.length > 1 ? null : usuarioId;
        const bloquesResponse = [];
        let subtotalGrupo = 0;
        let descuentoGrupo = 0;
        let totalGrupo = 0;
        let extrasPendientesGrupo = 0;
        let coveredItemsCount = 0;
        let extraItemsCount = 0;
        const createdAppointmentIds = [];

        for (let index = 0; index < integrantes.length; index += 1) {
          const integrante = integrantes[index];
          const selection = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            selection_type: integrante.selection_type,
            servicios: integrante.serviceIds,
            id_paquete: integrante.id_paquete,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
          });

          const isTitular = integrante.orden_integrante <= 1;
          const coverage = consumeCoverageForServices(coverageTracker, selection.serviceSelection.items, { isTitular });
          const subtotalServicios = Number(selection.serviceSelection.monto_total_hnl || 0);
          const descuento = Number(coverage.coveredTotalHnl || 0);
          const totalPagar = Number(coverage.extraTotalHnl || 0);

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
                $17::text,
                $18::uuid,
                $19
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
              descuento,
              totalPagar,
              selection.serviceSelection.selection_type || integrante.selection_type || "services",
              selection.serviceSelection.id_paquete || integrante.id_paquete || null,
              request.body?.notas ?? null,
            ]
          );

          const citaId = citaInsert.rows[0].id_cita;
          createdAppointmentIds.push(citaId);

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
          const coveredCount = coverage.items.filter((entry) => entry.coverage_status === "cubierto_plan").length;
          const extraCount = coverage.items.filter((entry) => entry.coverage_status === "extra_pendiente").length;
          coveredItemsCount += coveredCount;
          extraItemsCount += extraCount;
          subtotalGrupo += subtotalServicios;
          descuentoGrupo += descuento;
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
            estado_cita_codigo: simulationNoPayment ? "confirmada" : "en_espera",
            monto_total_hnl: subtotalServicios,
            descuento_hnl: descuento,
            total_pagar_hnl: totalPagar,
            duracion_total_min: Number(selection.serviceSelection.duracion_total_min || 0),
            buffer_total_min: Number(selection.serviceSelection.buffer_total_min || 0),
            cobertura: {
              items_cubiertos: coveredCount,
              items_extra: extraCount,
            },
          });
        }

        if (simulationNoPayment && createdAppointmentIds.length > 0) {
          await confirmAppointmentsWithoutPayment(dbClient, {
            citas: createdAppointmentIds,
            motivo_confirmacion: "simulacion_sin_pago_cliente_hold",
          });
        }

        const membershipState = await getClienteMembershipState(dbClient, clienteId);
        await dbClient.query("COMMIT");
        txStarted = false;

        return sendOk(reply, {
          id_grupo_cita: groupRecord.id_grupo_cita,
          estado_grupo_codigo: groupRecord.estado_grupo_codigo || "activo",
          expires_at: simulationNoPayment ? null : holdExpiresAt.toISOString(),
          monto_total_hnl: subtotalGrupo,
          descuento_total_hnl: descuentoGrupo,
          total_pagar_hnl: totalGrupo,
          extras_pendientes_hnl: extrasPendientesGrupo,
          resumen_cobertura: {
            items_cubiertos: coveredItemsCount,
            items_extra: extraItemsCount,
          },
          membresia: hasMembership
            ? {
              cobertura_activa: true,
              id_suscripcion: coverageTracker.idSuscripcion,
              nombre_plan: coverageTracker.planName || null,
              estado_plan: membershipState?.estado_plan || "sin_plan_activo",
            }
            : {
              cobertura_activa: false,
              id_suscripcion: null,
              nombre_plan: null,
              estado_plan: "sin_plan_activo",
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
            details: error instanceof Error ? error.message : "Hold conflict",
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, error, "No se pudo crear el hold de citas", "CITAS_HOLD_CREATE_ERROR");
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
