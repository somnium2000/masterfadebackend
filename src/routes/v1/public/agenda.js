import {
  AppError,
  sendError,
} from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  buildDayAvailability,
  findFirstAvailableBarber,
  getBarberScheduleBounds,
  getServiceSelectionDetails,
  listAvailabilityByDateRange,
  listBarbersForBranch,
  mapBarbersForResponse,
  mapDayAvailabilityForResponse,
  mapSlotsForResponse,
  parseDateOnly,
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
  },
  required: ["id_empleado", "id_sucursal", "nombre_sucursal", "nombre_completo", "nombres", "apellidos"],
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
  },
  required: ["hora", "inicio_at", "fin_at"],
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
    details: error instanceof Error ? error.message : "Unknown public agenda error",
    requestId: request.id,
  });
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
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const barberos = await listBarbersForBranch(app.db, idSucursal);
        return sendOk(reply, {
          barberos: mapBarbersForResponse(barberos),
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar el catalogo de barberos", "PUBLIC_AGENDA_BARBERS_ERROR");
      }
    }
  );

  app.get(
    "/disponibilidad",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "servicios", "fecha_desde", "fecha_hasta"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            servicios: { type: "string", minLength: 1 },
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
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const fechaDesde = parseDateOnly(request.query?.fecha_desde, "fecha_desde");
        const fechaHasta = parseDateOnly(request.query?.fecha_hasta, "fecha_hasta");
        const serviceSelection = await getServiceSelectionDetails(app.db, idSucursal, request.query?.servicios);
        const disponibilidad = await listAvailabilityByDateRange(
          app.db,
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
      }
    }
  );

  app.get(
    "/horarios",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "servicios", "fecha"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            servicios: { type: "string", minLength: 1 },
            fecha: { type: "string", format: "date" },
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
                  fecha: { type: "string", format: "date" },
                  id_barbero: { type: ["string", "null"], format: "uuid" },
                  barbero: {
                    anyOf: [
                      barberSchema,
                      { type: "null" },
                    ],
                  },
                  horarios: { type: "array", items: slotSchema },
                  hora_inicio: { type: ["string", "null"] },
                  hora_fin: { type: ["string", "null"] },
                  duracion_total_min: { type: "integer" },
                  buffer_total_min: { type: "integer" },
                },
                required: [
                  "fecha",
                  "id_barbero",
                  "barbero",
                  "horarios",
                  "hora_inicio",
                  "hora_fin",
                  "duracion_total_min",
                  "buffer_total_min",
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
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const fecha = parseDateOnly(request.query?.fecha, "fecha");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const serviceSelection = await getServiceSelectionDetails(app.db, idSucursal, request.query?.servicios);
        const serviceTotalMinutes = serviceSelection.duracion_total_min + serviceSelection.buffer_total_min;

        if (idBarbero) {
          const availability = await buildDayAvailability(app.db, idSucursal, serviceSelection, fecha, idBarbero);
          return sendOk(reply, {
            fecha,
            id_barbero: idBarbero,
            barbero: availability.barbero_autoasignado,
            horarios: mapSlotsForResponse(availability.slots),
            hora_inicio: availability.hora_inicio ?? null,
            hora_fin: availability.hora_fin ?? null,
            duracion_total_min: serviceSelection.duracion_total_min,
            buffer_total_min: serviceSelection.buffer_total_min,
          });
        }

        const result = await findFirstAvailableBarber(app.db, idSucursal, fecha, serviceTotalMinutes);
        const bounds = result?.barber
          ? await getBarberScheduleBounds(app.db, result.barber.id_empleado, fecha)
          : { hora_inicio: null, hora_fin: null };
        return sendOk(reply, {
          fecha,
          id_barbero: result?.barber?.id_empleado ?? null,
          barbero: result?.barber ?? null,
          horarios: mapSlotsForResponse(result?.slots ?? []),
          hora_inicio: bounds.hora_inicio ?? null,
          hora_fin: bounds.hora_fin ?? null,
          duracion_total_min: serviceSelection.duracion_total_min,
          buffer_total_min: serviceSelection.buffer_total_min,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudieron consultar los horarios del dia", "PUBLIC_AGENDA_SLOTS_ERROR");
      }
    }
  );
}
