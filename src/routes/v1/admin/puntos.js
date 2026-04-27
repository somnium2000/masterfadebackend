import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  addManualPointsAdjustment,
  getClientePointsSummary,
  searchActiveClientesForAdminPoints,
} from "../../../services/pointsService.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
const requestIdSchema = { type: "string" };

const idClienteParamSchema = {
  type: "object",
  required: ["id_cliente"],
  properties: {
    id_cliente: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const ajusteBodySchema = {
  type: "object",
  required: ["puntos", "motivo"],
  properties: {
    puntos: { type: "integer" },
    motivo: { type: "string", minLength: 1, maxLength: 300 },
  },
  additionalProperties: false,
};

const buscarClientesQuerySchema = {
  type: "object",
  properties: {
    q: { type: "string", minLength: 0, maxLength: 80 },
    limit: { type: ["integer", "string"] },
  },
  required: ["q"],
  additionalProperties: false,
};

function sendHandled(reply, request, error, fallbackMessage, fallbackCode) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, fallbackMessage);
  return sendError(reply, 500, fallbackMessage, {
    code: fallbackCode,
    requestId: request.id,
  });
}

export default async function adminPointsRoutes(app) {
  app.get(
    "/clientes/buscar",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: buscarClientesQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  clientes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id_cliente: { type: "string", format: "uuid" },
                        nombre_cliente: { type: "string" },
                        correo: { type: ["string", "null"] },
                        telefono: { type: ["string", "null"] },
                        id_usuario: { type: ["string", "null"], format: "uuid" },
                      },
                      required: ["id_cliente", "nombre_cliente", "correo", "telefono", "id_usuario"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["clientes"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const data = await searchActiveClientesForAdminPoints(app, {
          q: request.query?.q,
          limit: request.query?.limit,
        });
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo buscar clientes activos", "ADMIN_POINTS_CLIENT_SEARCH_ERROR");
      }
    }
  );

  app.get(
    "/clientes/:id_cliente/resumen",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        params: idClienteParamSchema,
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
        },
      },
    },
    async (request, reply) => {
      try {
        const data = await getClientePointsSummary(app, request.params.id_cliente, { historyLimit: 20 });
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo obtener el resumen del cliente", "ADMIN_POINTS_SUMMARY_ERROR");
      }
    }
  );

  app.post(
    "/clientes/:id_cliente/ajuste",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: {
        params: idClienteParamSchema,
        body: ajusteBodySchema,
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
        },
      },
    },
    async (request, reply) => {
      try {
        const data = await addManualPointsAdjustment(app, {
          idCliente: request.params.id_cliente,
          puntos: request.body?.puntos,
          motivo: request.body?.motivo,
          usuarioAdmin: request.claims?.user,
        });
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo registrar el ajuste de puntos", "ADMIN_POINTS_ADJUSTMENT_ERROR");
      }
    }
  );
}
