import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  createMasterPuntosCanje,
  createMasterPuntosLegacyMigration,
  getMasterPuntosClienteMovimientos,
  getMasterPuntosContext,
  listMasterPuntosClientes,
  updateMasterPuntosRegla,
} from "../../../services/masterPuntosService.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];

const movimientosQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};


const idClienteParamSchema = {
  type: "object",
  required: ["id_cliente"],
  properties: {
    id_cliente: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const clientesQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    q: { type: "string", minLength: 1, maxLength: 120 },
    search: { type: "string", minLength: 1, maxLength: 120 },
    id_sucursal: { type: "string", format: "uuid" },
    solo_premio: { type: "boolean" },
  },
  additionalProperties: false,
};

const reglaBodySchema = {
  type: "object",
  required: [
    "scope",
    "umbral_monto_hnl",
    "puntos_para_premio",
    "expiracion_meses",
    "servicios_redimibles",
    "activo",
  ],
  properties: {
    scope: { type: "string", enum: ["global", "sucursal"] },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    umbral_monto_hnl: { type: "number", minimum: 0 },
    puntos_para_premio: { type: "integer", minimum: 1 },
    expiracion_meses: { type: "integer", minimum: 1 },
    servicios_redimibles: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", format: "uuid" },
    },
    activo: { type: "boolean" },
  },
  additionalProperties: false,
};

const canjeBodySchema = {
  type: "object",
  required: ["id_cliente", "id_servicio"],
  properties: {
    id_cliente: { type: "string", format: "uuid" },
    id_servicio: { type: "string", format: "uuid" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    motivo: { type: ["string", "null"], maxLength: 280 },
  },
  additionalProperties: false,
};

const legacyBodySchema = {
  type: "object",
  required: ["id_cliente", "puntos"],
  properties: {
    id_cliente: { type: "string", format: "uuid" },
    puntos: { type: "integer", minimum: 1 },
    motivo: { type: ["string", "null"], maxLength: 280 },
  },
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

export default async function adminMasterPuntosRoutes(app) {
  app.get("/contexto", { preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const data = await getMasterPuntosContext(app, request.claims);
      return sendOk(reply, data, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo cargar el contexto de masterpuntos", "MASTERPUNTOS_CONTEXT_ERROR");
    }
  });

  app.get(
    "/clientes",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: { querystring: clientesQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listMasterPuntosClientes(app, request.claims, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo listar clientes de masterpuntos", "MASTERPUNTOS_CLIENTS_LIST_ERROR");
      }
    }
  );

  app.get(
    "/clientes/:id_cliente/movimientos",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: { params: idClienteParamSchema, querystring: movimientosQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await getMasterPuntosClienteMovimientos(app, request.claims, request.params.id_cliente, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo listar movimientos del cliente", "MASTERPUNTOS_CLIENT_MOVEMENTS_ERROR");
      }
    }
  );

  app.patch(
    "/reglas",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: { body: reglaBodySchema },
    },
    async (request, reply) => {
      try {
        const data = await updateMasterPuntosRegla(app, request.claims, request.body || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo actualizar la regla de masterpuntos", "MASTERPUNTOS_RULE_UPDATE_ERROR");
      }
    }
  );

  app.post(
    "/canjes",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: { body: canjeBodySchema },
    },
    async (request, reply) => {
      try {
        const data = await createMasterPuntosCanje(app, request.claims, request.body || {});
        return sendOk(reply, data, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo registrar el canje de masterpuntos", "MASTERPUNTOS_REDEEM_CREATE_ERROR");
      }
    }
  );

  app.post(
    "/legacy-migracion",
    {
      preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
      schema: { body: legacyBodySchema },
    },
    async (request, reply) => {
      try {
        const data = await createMasterPuntosLegacyMigration(app, request.claims, request.body || {});
        return sendOk(reply, data, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo registrar la migracion legacy de puntos", "MASTERPUNTOS_LEGACY_MIGRATION_ERROR");
      }
    }
  );
}
