/**
 * Utilidades de manejo de errores para Master Fade API.
 *
 * Formato estándar de error:
 * {
 *   ok: false,
 *   error: { code, message, details? },
 *   requestId
 * }
 */

export class AppError extends Error {
  /**
   * @param {number} statusCode  - HTTP status code (400, 401, 404, 500, etc.)
   * @param {string} message     - Mensaje legible para el cliente
   * @param {object} [options]
   * @param {string} [options.code]    - Código interno (ej. "AUTH_INVALID_CREDENTIALS")
   * @param {*}      [options.details] - Info extra (validación, hints)
   */
  constructor(statusCode, message, { code, details } = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code || `ERR_${statusCode}`;
    this.details = details;
  }
}

/**
 * Envía una respuesta de error con formato estándar.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {number} statusCode
 * @param {string} message
 * @param {object} [options]
 * @param {string}  [options.code]
 * @param {*}       [options.details]
 * @param {string}  [options.requestId]
 */
export function sendError(reply, statusCode, message, { code, details, requestId } = {}) {
  return reply.code(statusCode).send({
    ok: false,
    error: {
      code: code || `ERR_${statusCode}`,
      message,
      ...(details !== undefined && { details }),
    },
    requestId: requestId || reply.request?.id,
  });
}

/**
 * Fastify error handler global.
 * Registrar con: app.setErrorHandler(globalErrorHandler)
 */
export function globalErrorHandler(error, request, reply) {
  // AppError controlado
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  // Error de validación de Fastify/Ajv
  if (error.validation) {
    return sendError(reply, 400, "Error de validación en la solicitud", {
      code: "VALIDATION_ERROR",
      details: error.validation,
      requestId: request.id,
    });
  }

  // Rate limit
  if (error.statusCode === 429) {
    return sendError(reply, 429, "Demasiadas solicitudes. Intenta más tarde.", {
      code: "RATE_LIMIT_EXCEEDED",
      requestId: request.id,
    });
  }

  // Error genérico — no exponer internals en producción
  const statusCode = error.statusCode || 500;
  request.log.error(error);

  return sendError(reply, statusCode, "Error interno del servidor", {
    code: "INTERNAL_ERROR",
    requestId: request.id,
  });
}
