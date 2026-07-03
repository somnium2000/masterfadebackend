import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import agendaEventosRoutes from "../src/routes/v1/public/agendaEventos.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";

async function readUntil(response, needle) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

async function createApp({ enabled = true, connectionLimit = false, branchState = true } = {}) {
  const app = Fastify({ logger: false });
  const subscriptions = [];
  app.decorate("config", {
    agendaSse: {
      retryMs: 5000,
      heartbeatMs: 10000,
    },
    corsOrigins: ["http://localhost:5173"],
  });
  app.decorate("db", {
    async query(sql, params) {
      if (String(sql).includes("FROM public.sucursales")) {
        if (params[0] === BRANCH_B) return { rows: [] };
        return { rows: [{ id_sucursal: params[0], estado: branchState, deleted_at: null }] };
      }
      return { rows: [] };
    },
  });
  app.decorate("agendaRealtime", {
    enabled,
    canAcceptConnection() {
      return connectionLimit ? { ok: false, reason: "global" } : { ok: true };
    },
    async subscribe({ idSucursal, lastEventId, write, close }) {
      const subscriber = {
        id: `sub-${subscriptions.length + 1}`,
        idSucursal,
        lastEventId,
        close,
        onDrain() {},
      };
      subscriptions.push(subscriber);
      setTimeout(() => {
        write([
          "id: 125",
          "event: agenda.availability.changed",
          `data: ${JSON.stringify({
            id_evento: "125",
            id_sucursal: idSucursal,
            id_barbero: null,
            fecha_desde: null,
            fecha_hasta: null,
            inicio_at: null,
            fin_at: null,
            reason: "hold_created",
            occurred_at: "2026-07-03T01:00:00.000Z",
          })}`,
          "",
          "",
        ].join("\n"));
      }, 10).unref?.();
      return subscriber;
    },
    unsubscribe(id) {
      const subscriber = subscriptions.find((item) => item.id === id);
      subscriber?.close?.();
    },
  });
  await app.register(agendaEventosRoutes, { prefix: "/v1/public/agenda" });
  return { app, subscriptions };
}

test("GET /v1/public/agenda/eventos abre stream SSE real con retry, connected y evento live", async () => {
  const { app, subscriptions } = await createApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${baseUrl}/v1/public/agenda/eventos?id_sucursal=${BRANCH_A}`, {
    headers: { Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");

  const body = await readUntil(response, "agenda.availability.changed");
  assert.match(body, /retry: 5000/);
  assert.match(body, /: connected/);
  assert.match(body, /id: 125/);
  assert.match(body, /"id_evento":"125"/);
  assert.equal(subscriptions[0].idSucursal, BRANCH_A);
  await app.close();
});

test("GET /v1/public/agenda/eventos valida feature flag, uuid, sucursal y limite antes del stream", async () => {
  for (const [setup, expectedStatus, expectedCode, url] of [
    [{ enabled: false }, 503, "AGENDA_REALTIME_DISABLED", `/v1/public/agenda/eventos?id_sucursal=${BRANCH_A}`],
    [{}, 400, "VALIDATION_ERROR", "/v1/public/agenda/eventos?id_sucursal=nope"],
    [{}, 404, "AGENDA_BRANCH_NOT_FOUND", `/v1/public/agenda/eventos?id_sucursal=${BRANCH_B}`],
    [{ branchState: false }, 409, "AGENDA_BRANCH_INACTIVE", `/v1/public/agenda/eventos?id_sucursal=${BRANCH_A}`],
    [{ connectionLimit: true }, 429, "AGENDA_SSE_CONNECTION_LIMIT", `/v1/public/agenda/eventos?id_sucursal=${BRANCH_A}`],
  ]) {
    const { app } = await createApp(setup);
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(response.json().error.code, expectedCode);
    await app.close();
  }
});

test("GET /v1/public/agenda/eventos prioriza last_event_id query sobre Last-Event-ID", async () => {
  const { app, subscriptions } = await createApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${baseUrl}/v1/public/agenda/eventos?id_sucursal=${BRANCH_A}&last_event_id=7`, {
    headers: { "Last-Event-ID": "3" },
  });
  assert.equal(response.status, 200);
  await readUntil(response, ": connected");
  assert.equal(subscriptions[0].lastEventId, "7");
  await app.close();
});
