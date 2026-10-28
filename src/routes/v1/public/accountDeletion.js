import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { orchestrateClientAccountDeletion } from "../../../services/accountDeletionService.js";

const ACCOUNT_DELETION_REFERENCE_PATTERN = "^DEL-[A-F0-9]{12}$";

function sendHandled(reply, request, error) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, "No se pudo ejecutar la continuacion de eliminacion de cuenta");
  return sendError(reply, 500, "No fue posible completar correctamente el proceso de eliminacion.", {
    code: "CLIENT_ACCOUNT_DELETION_EXECUTION_ERROR",
    requestId: request.id,
  });
}

export default async function publicAccountDeletionRoutes(app) {
  app.post(
    "/requests/:reference/execute",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          groupId: "account-deletion-execute",
          keyGenerator: (request) => `${request.ip}:${request.params?.reference || ""}`,
        },
      },
      schema: {
        params: {
          type: "object",
          required: ["reference"],
          properties: {
            reference: { type: "string", pattern: ACCOUNT_DELETION_REFERENCE_PATTERN },
          },
          additionalProperties: false,
        },
        body: {
          type: "object",
          required: ["execution_token"],
          properties: {
            execution_token: { type: "string", minLength: 40, maxLength: 100 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: { type: "string" },
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          503: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: { type: "string" },
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await orchestrateClientAccountDeletion(app, {
          reference: request.params.reference,
          executionToken: request.body?.execution_token,
          traceRequestId: request.id,
        });

        return sendOk(reply, result, {
          statusCode: result.httpStatus || 200,
          requestId: request.id,
        });
      } catch (error) {
        return sendHandled(reply, request, error);
      }
    }
  );
}
