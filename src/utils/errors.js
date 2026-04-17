/**
 * Utilidades de manejo de errores para Master Fade API.
 *
 * Formato estandar de error:
 * {
 *   ok: false,
 *   error: { code, message, details? },
 *   requestId
 * }
 */

export class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.code]
   * @param {*}      [options.details]
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code || `ERR_${statusCode}`;
    this.details = details;
  }
}

function shouldExposeDetails(statusCode, code, exposeDetails) {
  if (exposeDetails === true) return true;
  if (statusCode === 429) return true;
  if (code === "VALIDATION_ERROR") return true;
  return false;
}

function sanitizeClientMessage(statusCode, code, message) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedMessage = String(message || "").trim();

  const sensitiveCodes = new Set([
    "DB_NOT_CONFIGURED",
    "JWT_SECRET_MISSING",
    "SUPABASE_NOT_CONFIGURED",
    "SUPABASE_ADMIN_NOT_CONFIGURED",
    "MAILER_NOT_CONFIGURED",
    "INTERNAL_ERROR",
    "AUTH_CLAIMS_ERROR",
    "AUTH_ME_ERROR",
    "AUTH_EXCHANGE_ERROR",
    "AUTH_LOGIN_ERROR",
    "AUTH_RESET_ERROR",
    "PAGOS_CREATE_INTENT_ERROR",
    "PAGOS_WEBHOOK_ERROR",
    "STORAGE_PREPARE_ERROR",
    "STORAGE_READ_URL_ERROR",
  ]);

  if (statusCode >= 500 || sensitiveCodes.has(normalizedCode)) {
    return "No se pudo procesar la solicitud.";
  }

  // AM: Evita revelar configuracion interna aunque venga con status != 500.
  if (/supabase|jwt_secret|db|database|smtp|provider|configur/i.test(normalizedMessage)) {
    return "No se pudo procesar la solicitud.";
  }

  return normalizedMessage || "Solicitud invalida.";
}

/**
 * Envia una respuesta de error con formato estandar.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {number} statusCode
 * @param {string} message
 * @param {object} [options]
 * @param {string}  [options.code]
 * @param {*}       [options.details]
 * @param {string}  [options.requestId]
 * @param {boolean} [options.exposeDetails]
 */
export function sendError(reply, statusCode, message, { code, details, requestId, exposeDetails } = {}) {
  const errorCode = code || `ERR_${statusCode}`;
  const includeDetails = shouldExposeDetails(statusCode, errorCode, exposeDetails);
  const safeMessage = sanitizeClientMessage(statusCode, errorCode, message);

  return reply.code(statusCode).send({
    ok: false,
    error: {
      code: errorCode,
      message: safeMessage,
      ...(includeDetails && details !== undefined ? { details } : {}),
    },
    requestId: requestId || reply.request?.id,
  });
}

/**
 * Fastify error handler global.
 * Registrar con: app.setErrorHandler(globalErrorHandler)
 */
export function globalErrorHandler(error, request, reply) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
      exposeDetails: false,
    });
  }

  if (error.validation) {
    return sendError(reply, 400, "Error de validacion en la solicitud", {
      code: "VALIDATION_ERROR",
      details: error.validation,
      requestId: request.id,
      exposeDetails: true,
    });
  }

  if (error.statusCode === 429) {
    return sendError(reply, 429, "Demasiadas solicitudes. Intenta mas tarde.", {
      code: "RATE_LIMIT_EXCEEDED",
      requestId: request.id,
      exposeDetails: false,
    });
  }

  const statusCode = error.statusCode || 500;
  request.log.error(error);

  return sendError(reply, statusCode, "Error interno del servidor", {
    code: "INTERNAL_ERROR",
    requestId: request.id,
    exposeDetails: false,
  });
}
