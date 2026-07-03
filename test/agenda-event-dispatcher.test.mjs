import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgendaEventDispatcher,
  mapAgendaOutboxRow,
} from "../src/services/agendaEventDispatcher.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";

function createPool({ failFirstPoll = false } = {}) {
  const calls = [];
  let pollFailures = failFirstPoll ? 1 : 0;
  const rows = [
    { id_evento: "1", motivo: "hold_created", id_sucursal: BRANCH_A, created_at: "2026-07-03T01:00:00.000Z" },
    { id_evento: "2", motivo: "block_changed", id_sucursal: BRANCH_B, created_at: "2026-07-03T01:01:00.000Z" },
    { id_evento: "3", motivo: "booking_confirmed", id_sucursal: BRANCH_A, created_at: "2026-07-03T01:02:00.000Z" },
  ];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("MAX(id_evento)") && !text.includes("MIN(id_evento)")) {
        return { rows: [{ max_id: "0" }] };
      }
      if (text.includes("MIN(id_evento)")) {
        return { rows: [{ min_id: "1", max_id: "3" }] };
      }
      if (text.includes("WHERE id_sucursal")) {
        return { rows: rows.filter((row) => row.id_sucursal === params[0] && BigInt(row.id_evento) > BigInt(params[1]) && BigInt(row.id_evento) <= BigInt(params[2])) };
      }
      if (text.includes("WHERE id_evento >")) {
        if (pollFailures > 0) {
          pollFailures -= 1;
          throw Object.assign(new Error("temporary"), { code: "TEMP" });
        }
        return { rows: rows.filter((row) => BigInt(row.id_evento) > BigInt(params[0])).slice(0, params[1]) };
      }
      return { rows: [] };
    },
  };
}

const config = {
  pollMs: 250,
  batchSize: 500,
  maxConnectionsPerIp: 1,
  maxConnectionsGlobal: 2,
  clientBufferMax: 10,
  replayBatchSize: 500,
  replayMaxEvents: 5000,
  manualPolling: true,
};

test("dispatcher inicializa cursor y distribuye eventos por sucursal sin convertir id_evento a Number", async () => {
  const pool = createPool();
  const dispatcher = createAgendaEventDispatcher({ pool, config });
  const frames = [];
  await dispatcher.start();
  await dispatcher.subscribe({
    idSucursal: BRANCH_A,
    ip: "127.0.0.1",
    write(frame) {
      frames.push(frame);
      return true;
    },
    close() {},
  });
  await dispatcher.pollOnce();

  assert.equal(dispatcher.getStats().cursor, "3");
  assert.equal(frames.length, 2);
  assert.match(frames[0], /^id: 1/m);
  assert.match(frames[1], /^id: 3/m);
  assert.ok(!frames.some((frame) => frame.includes(BRANCH_B)));
  await dispatcher.stop();
});

test("dispatcher aplica limites globales y por IP", async () => {
  const dispatcher = createAgendaEventDispatcher({ pool: createPool(), config });
  await dispatcher.start();
  await dispatcher.subscribe({
    idSucursal: BRANCH_A,
    ip: "::ffff:127.0.0.1",
    write() {
      return true;
    },
    close() {},
  });
  assert.deepEqual(dispatcher.canAcceptConnection("127.0.0.1"), { ok: false, reason: "ip" });
  await dispatcher.stop();
});

test("dispatcher recupera despues de error temporal sin avanzar cursor", async () => {
  const dispatcher = createAgendaEventDispatcher({ pool: createPool({ failFirstPoll: true }), config });
  await dispatcher.start();
  await dispatcher.pollOnce();
  assert.equal(dispatcher.getStats().cursor, "0");
  await dispatcher.pollOnce();
  assert.equal(dispatcher.getStats().cursor, "3");
  await dispatcher.stop();
});

test("dispatcher replay valida history_not_available e invalid_last_event_id", async () => {
  const dispatcher = createAgendaEventDispatcher({ pool: createPool(), config });
  const frames = [];
  await dispatcher.start();
  await dispatcher.subscribe({
    idSucursal: BRANCH_A,
    ip: "127.0.0.2",
    lastEventId: "999",
    write(frame) {
      frames.push(frame);
      return true;
    },
    close() {},
  });
  assert.ok(frames.some((frame) => frame.includes("invalid_last_event_id")));
  await dispatcher.stop();
});

test("payload SSE usa allowlist y omite propiedades privadas del outbox", () => {
  const payload = mapAgendaOutboxRow({
    id_evento: "125",
    id_sucursal: BRANCH_A,
    id_empleado_barbero: null,
    fecha_desde: "2026-07-03",
    fecha_hasta: "2026-07-03",
    inicio_at: "2026-07-03T15:00:00.000Z",
    fin_at: "2026-07-03T16:00:00.000Z",
    motivo: "hold_created",
    created_at: "2026-07-03T14:00:00.000Z",
    payload: { nombre: "Persona", correo: "x@y.test", release_token: "secret", monto: 10 },
  });
  assert.deepEqual(Object.keys(payload), [
    "id_evento",
    "id_sucursal",
    "id_barbero",
    "fecha_desde",
    "fecha_hasta",
    "inicio_at",
    "fin_at",
    "reason",
    "occurred_at",
  ]);
});
