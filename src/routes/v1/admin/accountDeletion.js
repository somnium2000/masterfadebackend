import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  ADMIN_ACCOUNT_DELETION_ADMIN_ROLES,
  approveAdminAccountDeletionRequest,
  getAdminAccountDeletionRequestDetail,
  getAdminActorContext,
  listAdminAccountDeletionRequests,
  rejectAdminAccountDeletionRequest,
  retryAdminAccountDeletionRequest,
  validateAdminAccountDeletionApprovalBody,
  validateAdminAccountDeletionRejectBody,
} from "../../../services/accountDeletionService.js";

const decisionRoles = ["admin", "root", "security_admin", "super_admin"];

const requestIdParamsSchema = {
  type: "object",
  required: ["requestId"],
  properties: {
    requestId: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const listQuerySchema = {
  type: "object",
  properties: {
    subject: { type: "string", enum: ["all", "cliente", "personal"] },
    status: {
      type: "string",
      enum: [
        "all",
        "pendiente_aprobacion",
        "aprobada",
        "rechazada",
        "procesando",
        "storage_pendiente",
        "auth_pendiente",
        "completada",
        "fallida",
        "cancelada",
        "evaluada",
        "bloqueada",
        "pendiente_confirmacion",
      ],
    },
    search: { type: "string", minLength: 1, maxLength: 120 },
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", enum: [10, 20, 30, 50] },
  },
  additionalProperties: false,
};

const approvalBodySchema = {
  type: "object",
  required: ["reauth_token", "confirmation_phrase", "acknowledge_irreversible_action"],
  properties: {
    reauth_token: { type: "string", minLength: 20, maxLength: 4096 },
    confirmation_phrase: { type: "string", const: "APROBAR ELIMINACION DE CUENTA" },
    acknowledge_irreversible_action: { type: "boolean", const: true },
    comment: { type: "string", maxLength: 500 },
  },
  additionalProperties: false,
};

const rejectBodySchema = {
  type: "object",
  required: ["comment"],
  properties: {
    comment: { type: "string", minLength: 10, maxLength: 500 },
  },
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

function statusFromPayload(payload) {
  return Number(payload?.httpStatus || 0) || (payload?.completed === false ? 202 : 200);
}

export default async function adminAccountDeletionRoutes(app) {
  app.get(
    "/requests",
    {
      preHandler: app.requireRoles(ADMIN_ACCOUNT_DELETION_ADMIN_ROLES),
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
      schema: { querystring: listQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminAccountDeletionRequests(app, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar solicitudes de eliminacion.", "ADMIN_ACCOUNT_DELETION_LIST_ERROR");
      }
    }
  );

  app.get(
    "/requests/:requestId",
    {
      preHandler: app.requireRoles(ADMIN_ACCOUNT_DELETION_ADMIN_ROLES),
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
      schema: { params: requestIdParamsSchema },
    },
    async (request, reply) => {
      try {
        const detail = await getAdminAccountDeletionRequestDetail(app, {
          requestId: request.params.requestId,
          actor: getAdminActorContext(request),
        });
        return sendOk(reply, detail, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar detalle de eliminacion.", "ADMIN_ACCOUNT_DELETION_DETAIL_ERROR");
      }
    }
  );

  app.post(
    "/requests/:requestId/approve",
    {
      preHandler: app.requireRoles(decisionRoles),
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        params: requestIdParamsSchema,
        body: approvalBodySchema,
      },
    },
    async (request, reply) => {
      try {
        validateAdminAccountDeletionApprovalBody(request.body || {});
        const result = await approveAdminAccountDeletionRequest(app, {
          requestId: request.params.requestId,
          actor: getAdminActorContext(request),
          reauthToken: request.body.reauth_token,
          comment: request.body.comment,
          traceRequestId: request.id,
        });
        return sendOk(reply, result, { statusCode: statusFromPayload(result.execution), requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo aprobar la solicitud.", "ADMIN_ACCOUNT_DELETION_APPROVE_ERROR");
      }
    }
  );

  app.post(
    "/requests/:requestId/reject",
    {
      preHandler: app.requireRoles(decisionRoles),
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        params: requestIdParamsSchema,
        body: rejectBodySchema,
      },
    },
    async (request, reply) => {
      try {
        validateAdminAccountDeletionRejectBody(request.body || {});
        const result = await rejectAdminAccountDeletionRequest(app, {
          requestId: request.params.requestId,
          actor: getAdminActorContext(request),
          comment: request.body.comment,
          traceRequestId: request.id,
        });
        return sendOk(reply, result, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo rechazar la solicitud.", "ADMIN_ACCOUNT_DELETION_REJECT_ERROR");
      }
    }
  );

  app.post(
    "/requests/:requestId/retry",
    {
      preHandler: app.requireRoles(decisionRoles),
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: { params: requestIdParamsSchema },
    },
    async (request, reply) => {
      try {
        const result = await retryAdminAccountDeletionRequest(app, {
          requestId: request.params.requestId,
          actor: getAdminActorContext(request),
          traceRequestId: request.id,
        });
        return sendOk(reply, result, { statusCode: statusFromPayload(result), requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo reintentar la solicitud.", "ADMIN_ACCOUNT_DELETION_RETRY_ERROR");
      }
    }
  );
}
