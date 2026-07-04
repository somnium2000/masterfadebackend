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

export const DB_SCHEMA_OUTDATED_CODE = "DB_SCHEMA_OUTDATED";
export const DB_SCHEMA_OUTDATED_MESSAGE = "El servicio de reservas está temporalmente en mantenimiento.";

const OUTDATED_SCHEMA_SQLSTATES = new Set([
  "42883",
  "42703",
  "42P01",
  "42704",
]);

export function isDatabaseSchemaOutdatedError(error) {
  const code = String(error?.code || error?.cause?.code || "").trim().toUpperCase();
  if (code === DB_SCHEMA_OUTDATED_CODE || OUTDATED_SCHEMA_SQLSTATES.has(code)) return true;

  const haystack = [
    error?.message,
    error?.detail,
    error?.hint,
    error?.where,
    error?.cause?.message,
  ].map((value) => String(value || "")).join("\n");

  return /function .* does not exist|column .* does not exist|relation .* does not exist|no existe la funci[oó]n|no existe la columna|no existe la relaci[oó]n/i.test(haystack);
}

export function toDatabaseSchemaOutdatedError(error) {
  if (!isDatabaseSchemaOutdatedError(error)) return error;
  if (error instanceof AppError && error.code === DB_SCHEMA_OUTDATED_CODE) return error;
  return new AppError(503, DB_SCHEMA_OUTDATED_MESSAGE, {
    code: DB_SCHEMA_OUTDATED_CODE,
  });
}

function shouldExposeDetails(statusCode, code, exposeDetails) {
  if (exposeDetails === true) return true;
  if (statusCode === 429) return true;
  if (code === "VALIDATION_ERROR") return true;
  if (String(code || "").trim().toUpperCase() === DB_SCHEMA_OUTDATED_CODE) return false;
  return false;
}

function sanitizeClientMessage(statusCode, code, message) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedMessage = String(message || "").trim();

  if (normalizedCode === DB_SCHEMA_OUTDATED_CODE) {
    return DB_SCHEMA_OUTDATED_MESSAGE;
  }

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
  const normalizedError = toDatabaseSchemaOutdatedError(error);
  if (normalizedError instanceof AppError) {
    return sendError(reply, normalizedError.statusCode, normalizedError.message, {
      code: normalizedError.code,
      details: normalizedError.details,
      requestId: request.id,
      exposeDetails: false,
    });
  }

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

  // AM: Fastify rate-limit puede propagar un payload estructurado sin statusCode
  // al handler global. Si no lo normalizamos aqui, termina en 500.
  if (error && typeof error === "object" && error.error?.code === "RATE_LIMIT_EXCEEDED") {
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
