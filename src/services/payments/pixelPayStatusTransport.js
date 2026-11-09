const CLIENT_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSPORT_CONTEXT = Symbol('pixelpay-status-transport-context');

function resolveClientRequestId(request) {
  const header = request.headers?.['x-request-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  const normalized = String(candidate || '').trim();
  return CLIENT_REQUEST_ID_PATTERN.test(normalized)
    ? normalized
    : String(request.id);
}

export function pixelPayStatusTransportOnRequest(request, reply, done) {
  const clientRequestId = resolveClientRequestId(request);
  request[TRANSPORT_CONTEXT] = {
    clientRequestId,
    startedAt: Date.now(),
  };
  reply.header('X-Request-Id', clientRequestId);
  request.log.info({
    event: 'pixelpay_status_transport_received',
    client_request_id: clientRequestId,
    fastify_request_id: String(request.id),
    method: request.method,
    route: request.routeOptions?.url || '/pixelpay/status',
  });
  done();
}

export function pixelPayStatusTransportOnResponse(request, reply, done) {
  const context = request[TRANSPORT_CONTEXT];
  const clientRequestId = context?.clientRequestId || String(request.id);
  request.log.info({
    event: 'pixelpay_status_transport_completed',
    client_request_id: clientRequestId,
    fastify_request_id: String(request.id),
    http_status: reply.statusCode,
    duration_ms: Math.max(0, Date.now() - (context?.startedAt || Date.now())),
  });
  done();
}
