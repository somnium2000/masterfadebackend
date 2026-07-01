import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { normalizeOperationalDateTime } from "../src/services/agendaService.js";
import {
  assertBookingSelectionCreationSupported,
  createBookingReservation,
} from "../src/services/bookingReservationService.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BARBER_A = "33333333-3333-4333-8333-333333333333";
const TARIFF_A = "44444444-4444-4444-8444-444444444444";
const CITA_A = "66666666-6666-4666-8666-666666666666";
const HOLD_A = "77777777-7777-4777-8777-777777777777";
const PERSON_A = "88888888-8888-4888-8888-888888888888";

function createMockClient({ failOnDetails = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("INSERT INTO public.citas ")) {
        return { rows: [{ id_cita: CITA_A }] };
      }
      if (text.includes("INSERT INTO public.citas_detalles")) {
        if (failOnDetails) throw new Error("detail insert failed");
        return { rows: [] };
      }
      if (text.includes("INSERT INTO public.citas_holds")) {
        return { rows: [{ id_hold: HOLD_A, expires_at: "2026-07-15T16:00:00.000Z" }] };
      }
      return { rows: [] };
    },
  };
}

function buildSelection(rawDateTime = "2026-07-15T09:00:00-06:00") {
  const normalized = normalizeOperationalDateTime(rawDateTime, "fecha_inicio");
  return {
    startDateTime: normalized.utcDate,
    serviceSelection: {
      selection_type: "services",
      duracion_total_min: 30,
      buffer_total_min: 5,
      items: [{
        id_servicio: SERVICE_A,
        id_tarifa: TARIFF_A,
        nombre_servicio: "Corte",
        duracion_min: 30,
        buffer_min: 5,
        precio_hnl: 100,
        incluye_isv_snapshot: false,
        isv_porcentaje: 15,
      }],
    },
  };
}

async function createHarnessApp(client) {
  const app = Fastify({ logger: false });
  app.post("/hold", async (request, reply) => {
    try {
      const selectionType = assertBookingSelectionCreationSupported(request.body?.selection_type || "services");
      const selection = buildSelection(request.body?.fecha_inicio);
      await client.query("BEGIN");
      const reservation = await createBookingReservation(client, {
        appointment: {
          branchId: BRANCH_A,
          barberId: BARBER_A,
          personId: PERSON_A,
          autoAssigned: false,
          selection: {
            ...selection,
            serviceSelection: {
              ...selection.serviceSelection,
              selection_type: selectionType,
            },
          },
        },
        hold: {
          userId: null,
          expiresAt: "2026-07-15T16:00:00.000Z",
          returning: true,
        },
      });
      await client.query("COMMIT");
      return reply.code(201).send({
        ok: true,
        id_cita: reservation.citaId,
        total_pagar_hnl: reservation.totals.totalHnl,
        expires_at: reservation.hold.expires_at,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
      const statusCode = Number(error?.statusCode || 400);
      return reply.code(statusCode).send({
        ok: false,
        error: {
          code: error?.code || "HARNESS_ERROR",
          message: error?.message || "error",
        },
      });
    }
  });
  return app;
}

test("Fastify inject crea hold con BEGIN, inserts centralizados y COMMIT", async () => {
  const client = createMockClient();
  const app = await createHarnessApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/hold",
    payload: {
      selection_type: "services",
      fecha_inicio: "2026-07-15T09:00:00-06:00",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().total_pagar_hnl, 115);
  const order = client.calls.map((call) => (
    call.sql === "BEGIN" || call.sql === "COMMIT" || call.sql === "ROLLBACK"
      ? call.sql
      : call.sql.match(/INSERT INTO public\.([a-z_]+)/)?.[1]
  )).filter(Boolean);
  assert.deepEqual(order, ["BEGIN", "citas", "citas_detalles", "citas_holds", "COMMIT"]);
  await app.close();
});

test("Fastify inject hace ROLLBACK y no COMMIT si falla detalle", async () => {
  const client = createMockClient({ failOnDetails: true });
  const app = await createHarnessApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/hold",
    payload: {
      selection_type: "services",
      fecha_inicio: "2026-07-15T09:00:00-06:00",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql === "COMMIT"));
  await app.close();
});

test("Fastify inject bloquea package y mixed con 409", async () => {
  for (const selectionType of ["package", "mixed"]) {
    const client = createMockClient();
    const app = await createHarnessApp(client);
    const response = await app.inject({
      method: "POST",
      url: "/hold",
      payload: {
        selection_type: selectionType,
        fecha_inicio: "2026-07-15T09:00:00-06:00",
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "BOOKING_PACKAGE_FLOW_PENDING_2B");
    assert.ok(!client.calls.some((call) => call.sql === "BEGIN"));
    await app.close();
  }
});

test("Fastify inject rechaza fecha sin timezone antes de insertar", async () => {
  const client = createMockClient();
  const app = await createHarnessApp(client);

  const response = await app.inject({
    method: "POST",
    url: "/hold",
    payload: {
      selection_type: "services",
      fecha_inicio: "2026-07-15T09:00:00",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "AGENDA_DATETIME_TIMEZONE_REQUIRED");
  assert.ok(!client.calls.some((call) => call.sql.includes("INSERT INTO public.citas")));
  await app.close();
});
