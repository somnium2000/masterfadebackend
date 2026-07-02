import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import pg from "pg";
import {
  assertKnownIdempotencyState,
  buildDeterministicPublicReleaseToken,
  buildReservationRequestFingerprint,
  finalizeReservationIdempotency,
  getReservationIdempotencyState,
  resolveReservationRequestId,
} from "../src/services/bookingCanonicalReservationService.js";
import { AppError } from "../src/utils/errors.js";

const { Pool } = pg;
const SHOULD_RUN = process.env.RUN_CANONICAL_BOOKING_INTEGRATION === "true";
const REQUEST_A = "aaaaaaaa-2222-4222-8222-aaaaaaaa2222";
const REQUEST_B = "bbbbbbbb-2222-4222-8222-bbbbbbbb2222";
const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function createPool() {
  return new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "masterfade_microfase_2a2",
    max: 4,
  });
}

async function createIdempotencyApp(pool) {
  const app = Fastify({ logger: false });
  let expensiveCalls = 0;

  app.get("/stats", async () => ({ expensiveCalls }));
  app.post("/v1/public/citas/hold", async (request, reply) => {
    const client = await pool.connect();
    try {
      const requestId = resolveReservationRequestId(request.headers["x-idempotency-key"]);
      reply.header("x-idempotency-key", requestId);
      const fingerprint = buildReservationRequestFingerprint({
        scope: "integration:public:hold",
        actor: { tipo: "publico", email: request.body?.titular?.email || null },
        body: request.body,
      });
      const state = await getReservationIdempotencyState(client, {
        requestId,
        scope: "integration:public:hold",
        requestFingerprint: fingerprint,
      });
      const status = assertKnownIdempotencyState(state);
      if (status === "completed") {
        return reply.code(state.statusCode || 201).send({
          ok: true,
          data: state.data,
          requestId: request.id,
        });
      }

      expensiveCalls += 1;
      const releaseToken = buildDeterministicPublicReleaseToken(
        requestId,
        "masterfade-integration-release-token-secret"
      );
      const responsePayload = {
        request_id: requestId,
        id_grupo_cita: `itest-${requestId}`,
        release_token: releaseToken,
        echo: request.body?.titular?.email || null,
      };
      await client.query("BEGIN");
      await finalizeReservationIdempotency(client, {
        requestId,
        scope: "integration:public:hold",
        requestFingerprint: fingerprint,
        responsePayload,
        statusCode: 201,
      });
      await client.query("COMMIT");
      return reply.code(201).send({ ok: true, data: responsePayload, requestId: request.id });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {
        // no-op
      }
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({
          ok: false,
          error: { code: error.code, message: error.message },
          requestId: request.id,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  return app;
}

if (SHOULD_RUN) test("canonical booking integration: idempotencia temprana y token estable con app.inject y PostgreSQL", async () => {
  const pool = createPool();
  const app = await createIdempotencyApp(pool);
  await pool.query(
    "DELETE FROM app_private.reserva_idempotencia WHERE request_id = ANY($1::uuid[])",
    [[REQUEST_A, REQUEST_B]]
  );

  const payload = {
    id_sucursal: BRANCH_A,
    titular: { email: "cliente.integration@example.com" },
    servicios: [{ id_servicio: SERVICE_A }],
  };
  const first = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    headers: { "x-idempotency-key": REQUEST_A },
    payload,
  });
  const replay = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    headers: { "x-idempotency-key": REQUEST_A },
    payload,
  });

  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.json().data, first.json().data);
  assert.equal(first.headers["x-idempotency-key"], REQUEST_A);
  assert.equal(first.json().data.release_token, replay.json().data.release_token);
  assert.equal((await app.inject({ method: "GET", url: "/stats" })).json().expensiveCalls, 1);

  const mismatch = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    headers: { "x-idempotency-key": REQUEST_A },
    payload: { ...payload, titular: { email: "otro.integration@example.com" } },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error.code, "BOOKING_IDEMPOTENCY_PAYLOAD_MISMATCH");

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    headers: { "x-idempotency-key": "no-es-uuid" },
    payload,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "BOOKING_IDEMPOTENCY_KEY_INVALID");

  const generated = await app.inject({
    method: "POST",
    url: "/v1/public/citas/hold",
    payload,
  });
  assert.equal(generated.statusCode, 201);
  assert.match(generated.json().data.request_id, /^[0-9a-f-]{36}$/i);
  assert.equal(generated.headers["x-idempotency-key"], generated.json().data.request_id);

  await app.close();
  await pool.end();
});

if (SHOULD_RUN) test("canonical booking integration: dos conexiones reales y line_key transaccional", async () => {
  const pool = createPool();
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  try {
    const [pidA, pidB] = await Promise.all([
      clientA.query("SELECT pg_backend_pid() AS pid"),
      clientB.query("SELECT pg_backend_pid() AS pid"),
    ]);
    assert.notEqual(pidA.rows[0].pid, pidB.rows[0].pid);

    await clientA.query("BEGIN");
    const groupId = "cccccccc-2222-4222-8222-cccccccc2222";
    const citaId = "dddddddd-2222-4222-8222-dddddddd2222";
    await clientA.query("INSERT INTO public.citas_grupos (id_grupo_cita, id_sucursal) VALUES ($1::uuid, $2::uuid)", [groupId, BRANCH_A]);
    await clientA.query(
      `
        INSERT INTO public.citas (
          id_cita, id_grupo_cita, id_sucursal, id_empleado_barbero, inicio_at, fin_at,
          duracion_total_min, buffer_total_min, subtotal_servicios_hnl, total_pagar_hnl
        )
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-07-20T15:00:00Z', '2026-07-20T15:35:00Z', 30, 5, 300, 300)
      `,
      [citaId, groupId, BRANCH_A, BARBER_A]
    );
    const detail = await clientA.query(
      `
        INSERT INTO public.citas_detalles (
          id_cita, id_servicio, cantidad, duracion_min, buffer_min,
          precio_unitario_hnl, subtotal_hnl, nombre_servicio_snapshot
        )
        VALUES ($1::uuid, $2::uuid, 1, 30, 5, 300, 300, 'Corte integration')
        RETURNING line_key, orden_linea
      `,
      [citaId, SERVICE_A]
    );
    assert.ok(detail.rows[0].line_key);
    assert.equal(detail.rows[0].orden_linea, 1);
    await clientA.query("ROLLBACK");
  } finally {
    clientA.release();
    clientB.release();
    await pool.end();
  }
});
