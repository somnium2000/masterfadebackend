import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  getClientePointsSummary,
  redeemReward,
} from "../../services/pointsService.js";

const CLIENT_ALLOWED_ROLES = ["cliente"];

const requestIdSchema = { type: "string" };

const canjearBodySchema = {
  type: "object",
  required: ["id_servicio", "id_sucursal"],
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

function ensureClienteContext(request) {
  const clienteId = String(request.claims?.cliente_id || "").trim();
  if (!clienteId) {
    throw new AppError(409, "No tienes un perfil de cliente activo", {
      code: "CLIENTE_CONTEXT_REQUIRED",
    });
  }
  return {
    clienteId,
    usuario: request.claims?.user ?? null,
  };
}

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

export default async function clientePointsRoutes(app) {
  app.get(
    "/resumen",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
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
        const { clienteId } = ensureClienteContext(request);
        const data = await getClientePointsSummary(app, clienteId, { historyLimit: 20 });
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo cargar el resumen de puntos", "CLIENT_POINTS_SUMMARY_ERROR");
      }
    }
  );

  app.post(
    "/canjear",
    {
      preHandler: app.requireRoles(CLIENT_ALLOWED_ROLES),
      schema: {
        body: canjearBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id_servicio_canje: { type: "string", format: "uuid" },
                  servicio_nombre: { type: "string" },
                  id_sucursal: { type: "string", format: "uuid" },
                  canje_preparado: { type: "boolean" },
                  puntos_requeridos: { type: "integer" },
                  saldo_actual: { type: "integer" },
                  canje_activo: { type: "boolean" },
                  canje_context_token: { type: "string" },
                },
                required: [
                  "id_servicio_canje",
                  "servicio_nombre",
                  "id_sucursal",
                  "canje_preparado",
                  "puntos_requeridos",
                  "saldo_actual",
                  "canje_activo",
                  "canje_context_token",
                ],
                additionalProperties: true,
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
        const { clienteId, usuario } = ensureClienteContext(request);
        const redemption = await redeemReward(app, {
          idCliente: clienteId,
          idServicioCanje: request.body?.id_servicio,
          idSucursal: request.body?.id_sucursal,
          usuario,
          motivo: "Canje de superpuntos (pendiente de asociacion a hold/cita)",
        });

        return sendOk(reply, {
          id_servicio_canje: redemption.id_servicio_canje,
          servicio_nombre: redemption.servicio_nombre,
          id_sucursal: redemption.id_sucursal,
          canje_preparado: redemption.canje_preparado === true,
          puntos_requeridos: redemption.puntos_requeridos,
          saldo_actual: redemption.saldo_actual,
          canje_activo: true,
          canje_context_token: redemption.canje_context_token,
          canje_pendiente_asociacion_hold: true,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo canjear la recompensa", "CLIENT_POINTS_REDEEM_ERROR");
      }
    }
  );
}
