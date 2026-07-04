const EVENT_NAME = "agenda.availability.changed";
const RESYNC_EVENT = "agenda.resync.required";
const DECIMAL_ID_RE = /^(0|[1-9][0-9]*)$/;

const EVENT_SELECT = `
  SELECT
    id_evento::text AS id_evento,
    tipo_evento,
    motivo,
    id_sucursal,
    id_empleado_barbero,
    fecha_desde,
    fecha_hasta,
    inicio_at,
    fin_at,
    created_at
  FROM app_private.agenda_eventos_outbox
`;

export function isDecimalEventId(value) {
  return DECIMAL_ID_RE.test(String(value ?? "").trim());
}

function toIsoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function toDateOnlyOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function mapAgendaOutboxRow(row) {
  return {
    id_evento: String(row.id_evento),
    id_sucursal: String(row.id_sucursal),
    id_barbero: row.id_empleado_barbero ? String(row.id_empleado_barbero) : null,
    fecha_desde: toDateOnlyOrNull(row.fecha_desde),
    fecha_hasta: toDateOnlyOrNull(row.fecha_hasta),
    inicio_at: toIsoOrNull(row.inicio_at),
    fin_at: toIsoOrNull(row.fin_at),
    reason: String(row.motivo),
    occurred_at: toIsoOrNull(row.created_at),
  };
}

export function createSseFrame({ id, event, data }) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

export function normalizeIp(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw || "unknown";
}

function compareEventIds(a, b) {
  const left = BigInt(String(a));
  const right = BigInt(String(b));
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function createSubscriber({ id, idSucursal, ip, write, close, bufferMax, onClose }) {
  const subscriber = {
    id,
    idSucursal,
    ip,
    state: "buffering",
    lastSentId: null,
    queue: [],
    draining: false,
    closed: false,
    write,
    close,
    onClose,
  };

  subscriber.closeWithResync = (reason) => {
    if (subscriber.closed) return;
    subscriber.enqueueFrame(createSseFrame({
      event: RESYNC_EVENT,
      data: { reason },
    }), null, { force: true });
    subscriber.closed = true;
    try {
      close();
    } finally {
      onClose?.(subscriber);
    }
  };

  subscriber.flush = () => {
    if (subscriber.closed || subscriber.draining) return;
    while (subscriber.queue.length > 0) {
      const item = subscriber.queue[0];
      const ok = write(item.frame);
      if (ok === false) {
        subscriber.draining = true;
        return;
      }
      subscriber.queue.shift();
      if (item.id) subscriber.lastSentId = item.id;
    }
  };

  subscriber.onDrain = () => {
    subscriber.draining = false;
    subscriber.flush();
  };

  subscriber.enqueueFrame = (frame, id = null, { force = false } = {}) => {
    if (subscriber.closed) return;
    if (id && subscriber.lastSentId && compareEventIds(id, subscriber.lastSentId) <= 0) return;
    if (!force && subscriber.queue.length >= bufferMax) {
      subscriber.closeWithResync("client_buffer_overflow");
      return;
    }
    subscriber.queue.push({ frame, id });
    subscriber.flush();
  };

  subscriber.deliver = (row) => {
    if (subscriber.closed || String(row.id_sucursal) !== subscriber.idSucursal) return;
    const id = String(row.id_evento);
    subscriber.enqueueFrame(createSseFrame({
      id,
      event: EVENT_NAME,
      data: mapAgendaOutboxRow(row),
    }), id);
  };

  subscriber.closeLocal = () => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    try {
      close();
    } finally {
      onClose?.(subscriber);
    }
  };

  return subscriber;
}

export function createAgendaEventDispatcher({ pool, config, logger = null }) {
  const subscribers = new Map();
  const perIp = new Map();
  let nextSubscriberId = 0;
  let cursor = "0";
  let running = false;
  let timer = null;
  let activePoll = null;
  let backoffMs = 0;

  const limits = {
    perIp: config.maxConnectionsPerIp,
    global: config.maxConnectionsGlobal,
  };

  function getStats() {
    return {
      running,
      cursor,
      subscribers: subscribers.size,
      perIp: [...perIp.entries()],
      activePoll: Boolean(activePoll),
    };
  }

  function canAcceptConnection(ip) {
    const normalizedIp = normalizeIp(ip);
    if (subscribers.size >= limits.global) return { ok: false, reason: "global" };
    if ((perIp.get(normalizedIp) || 0) >= limits.perIp) return { ok: false, reason: "ip" };
    return { ok: true, ip: normalizedIp };
  }

  function reserveIp(ip) {
    const normalizedIp = normalizeIp(ip);
    perIp.set(normalizedIp, (perIp.get(normalizedIp) || 0) + 1);
    return normalizedIp;
  }

  function releaseIp(ip) {
    const normalizedIp = normalizeIp(ip);
    const current = perIp.get(normalizedIp) || 0;
    if (current <= 1) perIp.delete(normalizedIp);
    else perIp.set(normalizedIp, current - 1);
  }

  async function query(sql, params = []) {
    return pool.query(sql, params);
  }

  async function initializeCursor() {
    const result = await query(`
      SELECT COALESCE(MAX(id_evento), 0)::text AS max_id
      FROM app_private.agenda_eventos_outbox
    `);
    cursor = String(result.rows?.[0]?.max_id || "0");
    return cursor;
  }

  function schedule(delay = config.pollMs) {
    if (!running || config.manualPolling) return;
    timer = setTimeout(() => {
      timer = null;
      void pollOnce();
    }, delay);
    timer.unref?.();
  }

  async function pollOnce() {
    if (!running || activePoll) return;
    activePoll = (async () => {
      try {
        const result = await query(
          `${EVENT_SELECT}
           WHERE id_evento > $1::bigint
           ORDER BY id_evento
           LIMIT $2`,
          [cursor, config.batchSize]
        );
        const rows = result.rows || [];
        for (const row of rows) {
          for (const subscriber of subscribers.values()) {
            try {
              subscriber.deliver(row);
            } catch (error) {
              logger?.warn?.({ err: error, subscriberId: subscriber.id }, "Agenda SSE subscriber delivery failed");
            }
          }
        }
        if (rows.length) cursor = String(rows[rows.length - 1].id_evento);
        backoffMs = 0;
      } catch (error) {
        logger?.error?.({ err: { message: error?.message, code: error?.code } }, "Agenda outbox poll failed");
        backoffMs = Math.min(Math.max(backoffMs * 2 || config.pollMs * 2, config.pollMs), 30000);
      } finally {
        activePoll = null;
        schedule(backoffMs || config.pollMs);
      }
    })();
    await activePoll;
  }

  async function start() {
    if (running) return;
    running = true;
    await initializeCursor();
    schedule(0);
  }

  async function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (activePoll) {
      try {
        await activePoll;
      } catch {
        // Poll errors are already logged and retried while running.
      }
    }
    for (const subscriber of [...subscribers.values()]) subscriber.closeLocal();
    subscribers.clear();
    perIp.clear();
  }

  async function getRetentionBounds() {
    const result = await query(`
      SELECT
        COALESCE(MIN(id_evento), 0)::text AS min_id,
        COALESCE(MAX(id_evento), 0)::text AS max_id
      FROM app_private.agenda_eventos_outbox
    `);
    return {
      minId: String(result.rows?.[0]?.min_id || "0"),
      maxId: String(result.rows?.[0]?.max_id || "0"),
    };
  }

  async function getCurrentWatermark() {
    const result = await query(`
      SELECT COALESCE(MAX(id_evento), 0)::text AS max_id
      FROM app_private.agenda_eventos_outbox
    `);
    return String(result.rows?.[0]?.max_id || "0");
  }

  async function replay(subscriber, { lastEventId, watermark }) {
    if (!isDecimalEventId(lastEventId)) return { ok: false, reason: "invalid_last_event_id" };
    const bounds = await getRetentionBounds();
    if (compareEventIds(lastEventId, bounds.maxId) > 0) return { ok: false, reason: "invalid_last_event_id" };
    if (compareEventIds(bounds.minId, "0") > 0 && compareEventIds(lastEventId, String(BigInt(bounds.minId) - 1n)) < 0) {
      return { ok: false, reason: "history_not_available" };
    }

    let current = lastEventId;
    let delivered = 0;
    while (compareEventIds(current, watermark) < 0) {
      const result = await query(
        `${EVENT_SELECT}
         WHERE id_sucursal = $1::uuid
           AND id_evento > $2::bigint
           AND id_evento <= $3::bigint
         ORDER BY id_evento
         LIMIT $4`,
        [subscriber.idSucursal, current, watermark, config.replayBatchSize]
      );
      const rows = result.rows || [];
      if (!rows.length) break;
      for (const row of rows) {
        delivered += 1;
        if (delivered > config.replayMaxEvents) return { ok: false, reason: "replay_limit_exceeded" };
        subscriber.deliver(row);
        current = String(row.id_evento);
      }
      if (rows.length < config.replayBatchSize) break;
    }
    return { ok: true };
  }

  async function subscribe({ idSucursal, ip, write, close, lastEventId = null }) {
    const normalizedIp = reserveIp(ip);
    const subscriber = createSubscriber({
      id: `agenda-${++nextSubscriberId}`,
      idSucursal: String(idSucursal),
      ip: normalizedIp,
      write,
      close,
      bufferMax: config.clientBufferMax,
      onClose: (closedSubscriber) => {
        subscribers.delete(closedSubscriber.id);
        releaseIp(closedSubscriber.ip);
      },
    });
    subscribers.set(subscriber.id, subscriber);
    try {
      const watermark = await getCurrentWatermark();
      if (lastEventId !== null && lastEventId !== undefined) {
        const replayResult = await replay(subscriber, { lastEventId: String(lastEventId), watermark });
        if (!replayResult.ok) {
          subscriber.enqueueFrame(createSseFrame({
            event: RESYNC_EVENT,
            data: { reason: replayResult.reason },
          }), null, { force: true });
          subscriber.lastSentId = watermark;
        }
      }

      subscriber.state = "live";
      subscriber.flush();
      return subscriber;
    } catch (error) {
      subscriber.closeLocal();
      throw error;
    }
  }

  function unsubscribe(subscriberId) {
    const subscriber = subscribers.get(subscriberId);
    if (subscriber) subscriber.closeLocal();
  }

  return {
    start,
    stop,
    pollOnce,
    subscribe,
    unsubscribe,
    canAcceptConnection,
    getCurrentWatermark,
    getRetentionBounds,
    replay,
    getStats,
    mapAgendaOutboxRow,
  };
}
