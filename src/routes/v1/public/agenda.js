import {
  AppError,
  sendError,
} from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  buildCuratedSlotExposure,
  buildCuratedSlotExposureDebug,
  buildDayAvailability,
  expireStaleAppointmentReservations,
  findFirstAvailableBarber,
  getBarberScheduleBounds,
  getBookingSelectionDetails,
  getMinSellableServiceMinutes,
  listAvailabilityByDateRange,
  listBarbersForBranch,
  mapBarbersForResponse,
  mapDayAvailabilityForResponse,
  mapSlotsForResponse,
  parseDateOnly,
  SLOT_INTERVAL_MINUTES,
} from "../../../services/agendaService.js";

const requestIdSchema = { type: "string" };

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

const barberSchema = {
  type: "object",
  properties: {
    id_empleado: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: ["string", "null"] },
    nombre_completo: { type: "string" },
    nombres: { type: "string" },
    apellidos: { type: "string" },
    alias_publico: { type: ["string", "null"] },
    resumen_publico: { type: ["string", "null"] },
    certificaciones_titulos: { type: "array", items: { type: "string" } },
    visible_en_landing: { type: "boolean" },
    foto_perfil_url: { type: ["string", "null"] },
    foto_perfil_updated_at: { type: ["string", "null"], format: "date-time" },
  },
  required: [
    "id_empleado",
    "id_sucursal",
    "nombre_sucursal",
    "nombre_completo",
    "nombres",
    "apellidos",
    "alias_publico",
    "resumen_publico",
    "certificaciones_titulos",
    "visible_en_landing",
    "foto_perfil_url",
    "foto_perfil_updated_at",
  ],
  additionalProperties: false,
};

const availabilityDaySchema = {
  type: "object",
  properties: {
    fecha: { type: "string", format: "date" },
    disponible: { type: "boolean" },
    barberos_disponibles: { type: "integer" },
    primer_horario_disponible: { type: ["string", "null"] },
    barbero_autoasignado: {
      anyOf: [
        barberSchema,
        { type: "null" },
      ],
    },
  },
  required: ["fecha", "disponible", "barberos_disponibles", "primer_horario_disponible", "barbero_autoasignado"],
  additionalProperties: false,
};

const slotSchema = {
  type: "object",
  properties: {
    hora: { type: "string" },
    inicio_at: { type: "string", format: "date-time" },
    fin_at: { type: "string", format: "date-time" },
    disponible: { type: "boolean" },
    duracion_visible_min: { type: "integer" },
    hora_fin_visible: { type: "string" },
    period_key: { type: "string", enum: ["manana", "tarde", "noche"] },
    range_label: { type: "string" },
  },
  required: ["hora", "inicio_at", "fin_at", "disponible", "duracion_visible_min", "hora_fin_visible", "period_key", "range_label"],
  additionalProperties: false,
};

const curatedPeriodSchema = {
  type: "object",
  properties: {
    recommended: {
      anyOf: [slotSchema, { type: "null" }],
    },
    alternatives: { type: "array", items: slotSchema },
    overflow: { type: "array", items: slotSchema },
    has_more: { type: "boolean" },
    total: { type: "integer" },
  },
  required: ["recommended", "alternatives", "overflow", "has_more", "total"],
  additionalProperties: false,
};

function sendHandled(reply, request, error, message, code) {
  const errorCode = String(error?.code || "").trim().toUpperCase();
  const errorMessage = String(error?.message || "");
  const isPoolSaturated = errorCode === "53300"
    || errorMessage.includes("MAXCONNSESSION")
    || /too many clients/i.test(errorMessage)
    || /max clients reached/i.test(errorMessage);
  if (isPoolSaturated) {
    return sendError(reply, 503, "Servicio de agenda temporalmente saturado. Intenta nuevamente en unos minutos.", {
      code: "PUBLIC_AGENDA_DB_POOL_SATURATED",
      requestId: request.id,
    });
  }
  if (error instanceof AppError) {
    request.log.warn(
      {
        requestId: request.id,
        statusCode: error.statusCode,
        code: error.code,
        details: error.details,
      },
      "Public agenda handled AppError"
    );
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    requestId: request.id,
  });
}

function canExposeSlotDebug(request) {
  const askDebug = String(request.query?.debug || "").trim().toLowerCase();
  if (!["1", "true", "yes"].includes(askDebug)) return false;
  const roles = Array.isArray(request.claims?.roles) ? request.claims.roles : [];
  return roles.includes("admin") || roles.includes("super_admin") || roles.includes("barbero");
}

function mapDiscardedReasonSummary(discarded) {
  const counts = new Map();
  (Array.isArray(discarded) ? discarded : []).forEach((entry) => {
    const code = String(entry?.reason || "").trim();
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
  });
  return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
}

async function expireReservationsBestEffort(app, request, dbClient = null) {
  try {
    await expireStaleAppointmentReservations(dbClient || app.db, { logger: request.log });
  } catch (error) {
    request.log.warn(
      {
        requestId: request.id,
        code: error?.code || null,
        message: error?.message || null,
      },
      "No se pudieron expirar reservas vencidas en agenda publica; se continua con la consulta"
    );
  }
}

export default async function publicAgendaRoutes(app) {
  app.get(
    "/barberos",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
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
                  barberos: { type: "array", items: barberSchema },
                },
                required: ["barberos"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const barberos = await listBarbersForBranch(dbClient, idSucursal);
        return sendOk(reply, {
          barberos: mapBarbersForResponse(barberos),
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar el catalogo de barberos", "PUBLIC_AGENDA_BARBERS_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/disponibilidad",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "fecha_desde", "fecha_hasta"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            servicios: { type: "string" },
            id_paquete: { type: "string", format: "uuid" },
            fecha_desde: { type: "string", format: "date" },
            fecha_hasta: { type: "string", format: "date" },
            id_barbero: { type: "string", format: "uuid" },
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
                  disponibilidad: { type: "array", items: availabilityDaySchema },
                  duracion_total_min: { type: "integer" },
                  buffer_total_min: { type: "integer" },
                },
                required: ["disponibilidad", "duracion_total_min", "buffer_total_min"],
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const fechaDesde = parseDateOnly(request.query?.fecha_desde, "fecha_desde");
        const fechaHasta = parseDateOnly(request.query?.fecha_hasta, "fecha_hasta");
        const dateDesde = new Date(fechaDesde);
        const dateHasta = new Date(fechaHasta);
        if (dateHasta < dateDesde) {
          throw new AppError(400, "fecha_hasta no puede ser menor a fecha_desde", { code: "PUBLIC_AGENDA_DATES_INVALID" });
        }
        const diffTime = Math.abs(dateHasta - dateDesde);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 60) {
          throw new AppError(400, "El rango de fechas no puede superar los 60 dias", { code: "PUBLIC_AGENDA_DATE_RANGE_TOO_LARGE" });
        }
        const serviceSelection = await getBookingSelectionDetails(dbClient, {
          id_sucursal: idSucursal,
          selection_type: request.query?.selection_type,
          servicios: request.query?.servicios,
          id_paquete: request.query?.id_paquete ?? null,
          id_barbero: idBarbero,
        });
        const disponibilidad = await listAvailabilityByDateRange(
          dbClient,
          idSucursal,
          serviceSelection,
          fechaDesde,
          fechaHasta,
          idBarbero
        );

        return sendOk(reply, {
          disponibilidad: mapDayAvailabilityForResponse(disponibilidad),
          duracion_total_min: serviceSelection.duracion_total_min,
          buffer_total_min: serviceSelection.buffer_total_min,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo calcular disponibilidad", "PUBLIC_AGENDA_AVAILABILITY_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/horarios",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "fecha"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            servicios: { type: "string" },
            id_paquete: { type: "string", format: "uuid" },
            fecha: { type: "string", format: "date" },
            id_barbero: { type: "string", format: "uuid" },
            debug: { type: "boolean" },
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
                  fecha: { type: "string", format: "date" },
                  id_barbero: { type: ["string", "null"], format: "uuid" },
                  barbero: {
                    anyOf: [
                      barberSchema,
                      { type: "null" },
                    ],
                  },
                  horarios: { type: "array", items: slotSchema },
                  horarios_curados: {
                    type: "object",
                    properties: {
                      manana: curatedPeriodSchema,
                      tarde: curatedPeriodSchema,
                      noche: curatedPeriodSchema,
                    },
                    required: ["manana", "tarde", "noche"],
                    additionalProperties: false,
                  },
                  hora_inicio: { type: ["string", "null"] },
                  hora_fin: { type: ["string", "null"] },
                  duracion_total_min: { type: "integer" },
                  buffer_total_min: { type: "integer" },
                  slot_step_min: { type: "integer" },
                  debug: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
                },
                required: [
                  "fecha",
                  "id_barbero",
                  "barbero",
                  "horarios",
                  "horarios_curados",
                  "hora_inicio",
                  "hora_fin",
                  "duracion_total_min",
                  "buffer_total_min",
                  "slot_step_min",
                  "debug",
                ],
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const fecha = parseDateOnly(request.query?.fecha, "fecha");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const minSellableDurationMin = await getMinSellableServiceMinutes(dbClient);
        const includeDebug = canExposeSlotDebug(request);
        const serviceSelection = await getBookingSelectionDetails(dbClient, {
          id_sucursal: idSucursal,
          selection_type: request.query?.selection_type,
          servicios: request.query?.servicios,
          id_paquete: request.query?.id_paquete ?? null,
          id_barbero: idBarbero,
        });
        const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;

        if (idBarbero) {
          const availability = await buildDayAvailability(dbClient, idSucursal, serviceSelection, fecha, idBarbero, {
            minSellableDurationMin,
            includeDiscardReasons: includeDebug,
          });
          const horarios = mapSlotsForResponse(availability.slots, {
            duracion_visible_min: serviceSelection.duracion_total_min,
          });
          const horariosCurados = buildCuratedSlotExposure(horarios, {
            minSellableDurationMin,
          });
          const debugPayload = includeDebug
            ? {
                discarded_reason_codes: mapDiscardedReasonSummary(availability?.discarded_slots),
                discarded_slots: Array.isArray(availability?.discarded_slots)
                  ? availability.discarded_slots.slice(0, 120)
                  : [],
                curated_ranking: buildCuratedSlotExposureDebug(horarios, {
                  minSellableDurationMin,
                }),
              }
            : null;
          return sendOk(reply, {
            fecha,
            id_barbero: idBarbero,
            barbero: availability.barbero_autoasignado
              ? mapBarbersForResponse([availability.barbero_autoasignado])[0]
              : null,
            horarios,
            horarios_curados: horariosCurados,
            hora_inicio: availability.hora_inicio ?? null,
            hora_fin: availability.hora_fin ?? null,
            duracion_total_min: serviceSelection.duracion_total_min,
            buffer_total_min: serviceSelection.buffer_total_min,
            slot_step_min: SLOT_INTERVAL_MINUTES,
            debug: debugPayload,
          });
        }

        const result = await findFirstAvailableBarber(dbClient, idSucursal, fecha, serviceTotalMinutes, {
          minSellableDurationMin,
        });
        const bounds = result?.barber
          ? await getBarberScheduleBounds(dbClient, result.barber.id_empleado, fecha)
          : { hora_inicio: null, hora_fin: null };
        const horarios = mapSlotsForResponse(result?.slots ?? [], {
          duracion_visible_min: serviceSelection.duracion_total_min,
        });
        const horariosCurados = buildCuratedSlotExposure(horarios, {
          minSellableDurationMin,
        });
        const debugPayload = includeDebug
          ? {
              curated_ranking: buildCuratedSlotExposureDebug(horarios, {
                minSellableDurationMin,
              }),
            }
          : null;
        return sendOk(reply, {
          fecha,
          id_barbero: result?.barber?.id_empleado ?? null,
          barbero: result?.barber ? mapBarbersForResponse([result.barber])[0] : null,
          horarios,
          horarios_curados: horariosCurados,
          hora_inicio: bounds.hora_inicio ?? null,
          hora_fin: bounds.hora_fin ?? null,
          duracion_total_min: serviceSelection.duracion_total_min,
          buffer_total_min: serviceSelection.buffer_total_min,
          slot_step_min: SLOT_INTERVAL_MINUTES,
          debug: debugPayload,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudieron consultar los horarios del dia", "PUBLIC_AGENDA_SLOTS_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );
}
