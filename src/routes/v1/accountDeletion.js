import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import {
  cancelInternalAccountDeletionRequest,
  createInternalAccountDeletionRequest,
  evaluateInternalAccountDeletionRequest,
  getCurrentInternalAccountDeletionRequest,
  validateInternalAccountDeletionRequestBody,
  verifyRecentInternalAccountDeletionReauthentication,
} from "../../services/accountDeletionService.js";

const INTERNAL_ALLOWED_ROLES = [
  "admin",
  "barbero",
  "super_admin",
  "root",
  "security_admin",
  "security_auditor",
];

function sendHandled(reply, request, error, fallbackCode = "INTERNAL_ACCOUNT_DELETION_ERROR") {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
      exposeDetails: false,
    });
  }

  request.log.error({ err: error }, "No se pudo procesar la solicitud interna de eliminacion de cuenta");
  return sendError(reply, 500, "No fue posible procesar la solicitud.", {
    code: fallbackCode,
    requestId: request.id,
  });
}

function getInternalContext(request) {
  const usuarioId = String(request.claims?.user?.id_usuario || request.auth?.sub || "").trim();
  const personaId = String(request.claims?.user?.id_persona || "").trim();
  const employeeIdFromClaims = String(
    request.claims?.empleado_id
    || request.claims?.employee_id
    || request.claims?.user?.empleado_id
    || ""
  ).trim();
  const rolesFromClaims = Array.isArray(request.claims?.roles)
    ? request.claims.roles
    : (Array.isArray(request.auth?.roles) ? request.auth.roles : []);

  if (!usuarioId || !personaId) {
    throw new AppError(409, "No fue posible determinar la identidad interna de la sesion.", {
      code: "INTERNAL_ACCOUNT_DELETION_CONTEXT_REQUIRED",
    });
  }

  return {
    usuarioId,
    personaId,
    employeeIdFromClaims,
    rolesFromClaims,
  };
}

async function withSerializableTransaction(app, callback) {
  const client = await app.db.connect();
  let txStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    txStarted = true;
    const result = await callback(client);
    await client.query("COMMIT");
    txStarted = false;
    return result;
  } catch (error) {
    if (txStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

export default async function accountDeletionRoutes(app) {
  const preHandler = app.requireRoles(INTERNAL_ALLOWED_ROLES);

  app.get(
    "/me/preview",
    {
      preHandler,
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes", groupId: "internal-account-deletion-preview" },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const context = getInternalContext(request);
        const preview = await evaluateInternalAccountDeletionRequest(client, context);
        return sendOk(reply, preview, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "INTERNAL_ACCOUNT_DELETION_PREVIEW_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/me/requests/current",
    {
      preHandler,
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes", groupId: "internal-account-deletion-current" },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const context = getInternalContext(request);
        const preview = await evaluateInternalAccountDeletionRequest(client, context);
        const current = preview?.employee_context?.id_empleado
          ? await getCurrentInternalAccountDeletionRequest(client, {
              usuarioId: context.usuarioId,
              empleadoId: preview.employee_context.id_empleado,
            })
          : { request: null };
        return sendOk(reply, current, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "INTERNAL_ACCOUNT_DELETION_CURRENT_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/me/requests",
    {
      preHandler,
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes", groupId: "internal-account-deletion-create" },
      },
      schema: {
        body: {
          type: "object",
          required: [
            "idempotency_key",
            "reauth_token",
            "confirmation_phrase",
            "acknowledge_account_remains_active",
            "acknowledge_operational_dependencies",
            "acknowledge_access_revocation",
            "acknowledge_history_retention",
          ],
          properties: {
            idempotency_key: { type: "string", minLength: 16, maxLength: 160 },
            reauth_token: { type: "string", minLength: 20 },
            confirmation_phrase: { type: "string" },
            acknowledge_account_remains_active: { type: "boolean" },
            acknowledge_operational_dependencies: { type: "boolean" },
            acknowledge_access_revocation: { type: "boolean" },
            acknowledge_history_retention: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = getInternalContext(request);
        validateInternalAccountDeletionRequestBody(request.body || {});

        const result = await withSerializableTransaction(app, async (client) => {
          const reauth = await verifyRecentInternalAccountDeletionReauthentication(app, {
            reauthToken: request.body?.reauth_token,
            expectedUserId: context.usuarioId,
          });

          return createInternalAccountDeletionRequest(client, {
            ...context,
            idempotencyKey: request.body?.idempotency_key,
            requestId: request.id,
            authenticatedAt: reauth.authenticatedAt,
          });
        });

        return sendOk(reply, result, {
          statusCode: result.created ? 201 : 200,
          requestId: request.id,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "INTERNAL_ACCOUNT_DELETION_CREATE_ERROR");
      }
    }
  );

  app.post(
    "/me/requests/:requestId/cancel",
    {
      preHandler,
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes", groupId: "internal-account-deletion-cancel" },
      },
      schema: {
        params: {
          type: "object",
          required: ["requestId"],
          properties: {
            requestId: { type: "string", format: "uuid" },
          },
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: 300 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const context = getInternalContext(request);
        const result = await withSerializableTransaction(app, (client) => cancelInternalAccountDeletionRequest(client, {
          ...context,
          requestId: request.params.requestId,
          traceRequestId: request.id,
        }));
        return sendOk(reply, result, { requestId: request.id });
      } catch (error) {
        return sendHandled(reply, request, error, "INTERNAL_ACCOUNT_DELETION_CANCEL_ERROR");
      }
    }
  );
}

export { INTERNAL_ALLOWED_ROLES };
