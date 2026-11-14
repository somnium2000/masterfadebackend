import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import { processHostedCallback } from "../../services/payments/pixelPayHosted.js";

export default async function pixelPayHostedCallbackRoutes(app) {
  app.post("/callback", {
    bodyLimit: 32768,
    config: { rateLimit: { max: 30, timeWindow: "1 minute", groupId: "pixelpay-hosted-callback" } },
    schema: { body: { type: "object", required: ["order", "uuid", "status", "currency", "amount", "payment_hash"],
      properties: { order: { type: "string", maxLength: 64 }, ref: { type: "string", maxLength: 64 },
        uuid: { type: "string", maxLength: 80 }, status: { type: "string", maxLength: 20 }, currency: { type: "string", maxLength: 3 },
        amount: { anyOf: [{ type: "number", minimum: 0 }, { type: "string", maxLength: 20 }] }, payment_hash: { type: "string", maxLength: 32 } },
      additionalProperties: true } },
  }, async (request, reply) => {
    try {
      const result = await processHostedCallback({ db: app.db, config: app.config?.pixelPayHosted, body: request.body });
      return sendOk(reply, result);
    } catch (error) {
      // AM: No registrar payload, hash, credenciales ni errores del transporte del proveedor.
      return sendError(reply, error instanceof AppError ? error.statusCode : 503,
        error instanceof AppError ? error.message : "No se pudo registrar la notificacion", {
          code: error instanceof AppError ? error.code : "PIXELPAY_HOSTED_CALLBACK_UNAVAILABLE", requestId: request.id,
        });
    }
  });
}
