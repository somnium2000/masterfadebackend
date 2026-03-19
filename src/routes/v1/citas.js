import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  OCCUPIED_APPOINTMENT_STATES,
  resolveBookingSelection,
  parseDateOnly,
  assertUuid,
} from "../../services/agendaService.js";

const CLIENT_ALLOWED_ROLES = ["cliente", "admin", "super_admin"];
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

export default async function citasRoutes(app) {
  app.post(
    "/",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal", "fecha_inicio", "servicios"],
          properties: {
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            id_sucursal: { type: "string", format: "uuid" },
            fecha_inicio: { type: "string", format: "date-time" },
            servicios: {
              type: "array",
              minItems: 1,
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
                  expires_at: { type: "string", format: "date-time" },
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
        const serviceIds = request.body.servicios.map((item) => item.id_servicio);
        const selection = await resolveBookingSelection(dbClient, {
          id_sucursal: request.body.id_sucursal,
          servicios: serviceIds,
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
              $13
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
            new Date(selection.startDateTime.getTime() + (selection.serviceSelection.duracion_total_min + selection.serviceSelection.buffer_total_min) * 60 * 1000).toISOString(),
            selection.serviceSelection.duracion_total_min,
            selection.serviceSelection.buffer_total_min,
            selection.serviceSelection.monto_total_hnl,
            selection.serviceSelection.monto_total_hnl,
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

        await dbClient.query("COMMIT");

        return sendOk(
          reply,
          {
            id_cita: citaId,
            estado_cita_codigo: "en_espera",
            id_barbero: selection.barber.id_empleado,
            nombre_barbero: selection.barber.nombre_completo,
            asignada_automaticamente: !request.body.id_barbero,
            expires_at: new Date(holdInsert.rows[0].expires_at).toISOString(),
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
