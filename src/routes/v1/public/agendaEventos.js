import { sendError } from "../../../utils/errors.js";
import { isDecimalEventId } from "../../../services/agendaEventDispatcher.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOrigin(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return raw;
  }
}

function setSseCorsHeaders(app, request, reply) {
  const originHeader = String(request.headers?.origin || "").trim();
  if (!originHeader) return;
  const allowedOrigins = Array.isArray(app.config?.corsOrigins) && app.config.corsOrigins.length > 0
    ? app.config.corsOrigins
    : ["http://localhost:5173"];
  const allowedOriginSet = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  if (!allowedOriginSet.has(normalizeOrigin(originHeader))) return;
  reply.raw.setHeader("Access-Control-Allow-Origin", originHeader);
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
  reply.raw.setHeader("Vary", "Origin");
}

function resolveLastEventId(request) {
  const queryValue = request.query?.last_event_id;
  if (queryValue !== undefined && queryValue !== null && String(queryValue).trim() !== "") {
    return String(queryValue).trim();
  }
  const headerValue = request.headers?.["last-event-id"];
  if (headerValue !== undefined && headerValue !== null && String(headerValue).trim() !== "") {
    return String(headerValue).trim();
  }
  return null;
}

async function loadBranch(pool, idSucursal) {
  const result = await pool.query(
    `
      SELECT id_sucursal, estado, deleted_at
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
      LIMIT 1
    `,
    [idSucursal]
  );
  return result.rows?.[0] || null;
}

export async function subscribeAgendaRealtimeSafely({
  app,
  request,
  idSucursal,
  lastEventId,
  write,
  closeRaw,
  isClosed,
}) {
  const createdSubscriber = await app.agendaRealtime.subscribe({
    idSucursal,
    ip: request.ip,
    write,
    close: closeRaw,
    lastEventId,
  });
  if (isClosed()) {
    app.agendaRealtime.unsubscribe(createdSubscriber.id);
    closeRaw();
    return null;
  }
  return createdSubscriber;
}

export default async function agendaEventosRoutes(app) {
  app.get("/eventos", async (request, reply) => {
    if (!app.agendaRealtime?.enabled) {
      return sendError(reply, 503, "Realtime de agenda deshabilitado.", {
        code: "AGENDA_REALTIME_DISABLED",
        requestId: request.id,
      });
    }

    const idSucursal = String(request.query?.id_sucursal || "").trim();
    if (!idSucursal) {
      return sendError(reply, 400, "id_sucursal es requerido.", {
        code: "VALIDATION_ERROR",
        requestId: request.id,
      });
    }
    if (!UUID_RE.test(idSucursal)) {
      return sendError(reply, 400, "id_sucursal invalido.", {
        code: "VALIDATION_ERROR",
        requestId: request.id,
      });
    }

    const lastEventId = resolveLastEventId(request);
    if (lastEventId !== null && !isDecimalEventId(lastEventId)) {
      return sendError(reply, 400, "last_event_id invalido.", {
        code: "VALIDATION_ERROR",
        requestId: request.id,
      });
    }

    const branch = await loadBranch(app.db, idSucursal);
    if (!branch) {
      return sendError(reply, 404, "Sucursal no encontrada.", {
        code: "AGENDA_BRANCH_NOT_FOUND",
        requestId: request.id,
      });
    }
    if (branch.deleted_at || branch.estado !== true) {
      return sendError(reply, 409, "Sucursal no disponible.", {
        code: "AGENDA_BRANCH_INACTIVE",
        requestId: request.id,
      });
    }

    const connectionCheck = app.agendaRealtime.canAcceptConnection(request.ip);
    if (!connectionCheck.ok) {
      const stats = typeof app.agendaRealtime.getStats === "function" ? app.agendaRealtime.getStats() : null;
      request.log.warn({
        request_id: request.id,
        ip: request.ip,
        reason: connectionCheck.reason,
        subscribers: stats?.subscribers,
        perIp: stats?.perIp,
      }, "Agenda SSE connection rejected");
      reply.header("Retry-After", "30");
      return sendError(reply, 429, "Demasiadas conexiones de agenda abiertas.", {
        code: "AGENDA_SSE_CONNECTION_LIMIT",
        requestId: request.id,
      });
    }

    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.setHeader("Content-Encoding", "identity");
    setSseCorsHeaders(app, request, reply);

    if (typeof reply.hijack === "function") reply.hijack();
    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();

    let closed = false;
    let subscriber = null;
    let heartbeat = null;

    const closeRaw = () => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try {
        reply.raw.end();
      } catch {
        // noop
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (subscriber) {
        app.agendaRealtime.unsubscribe(subscriber.id);
        subscriber = null;
      }
    };

    request.raw.once("close", cleanup);
    request.raw.once("aborted", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("finish", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.on("drain", () => subscriber?.onDrain?.());

    const write = (frame) => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return true;
      return reply.raw.write(frame);
    };

    write(`retry: ${app.config.agendaSse.retryMs}\n\n: connected\n\n`);

    heartbeat = setInterval(() => {
      write(": heartbeat\n\n");
    }, app.config.agendaSse.heartbeatMs);
    heartbeat.unref?.();

    try {
      subscriber = await subscribeAgendaRealtimeSafely({
        app,
        request,
        idSucursal,
        lastEventId,
        write,
        closeRaw,
        isClosed: () => closed,
      });
    } catch (error) {
      request.log.error({ err: { message: error?.message, code: error?.code } }, "Agenda SSE initialization failed");
      write("event: agenda.resync.required\ndata: {\"reason\":\"stream_initialization_failed\"}\n\n");
      cleanup();
      closeRaw();
    }
  });
}
