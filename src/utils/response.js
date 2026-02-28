/**
 * Utilidades de respuesta estándar para Master Fade API.
 *
 * Formato de respuesta exitosa:
 * {
 *   ok: true,
 *   data,
 *   meta?,
 *   requestId
 * }
 */

/**
 * Envía una respuesta exitosa con formato estándar.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {*} data          - Payload de la respuesta
 * @param {object} [options]
 * @param {number}  [options.statusCode=200]
 * @param {object}  [options.meta]       - Metadata (paginación, etc.)
 * @param {string}  [options.requestId]
 */
export function sendOk(reply, data, { statusCode = 200, meta, requestId } = {}) {
  return reply.code(statusCode).send({
    ok: true,
    data,
    ...(meta !== undefined && { meta }),
    requestId: requestId || reply.request?.id,
  });
}
