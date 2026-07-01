import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import publicAgendaRoutes from "../src/routes/v1/public/agenda.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PACKAGE_A = "23232323-2323-4232-8232-232323232323";

function createAgendaClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes("UPDATE public.citas_holds")) return { rows: [] };
      if (text.includes("UPDATE public.payment_intents")) return { rows: [], rowCount: 0 };
      if (text.includes("UPDATE public.citas c") && text.includes("no_show")) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
    release() {},
  };
}

async function createAgendaApp(client) {
  const app = Fastify({ logger: false });
  app.decorate("config", { bookingIsvEnabled: false });
  app.decorate("db", {
    async connect() {
      return client;
    },
  });
  await app.register(publicAgendaRoutes, { prefix: "/v1/public/agenda" });
  return app;
}

test("ruta real GET /v1/public/agenda/disponibilidad bloquea package y mixed con 409", async () => {
  for (const selectionType of ["package", "mixed"]) {
    const client = createAgendaClient();
    const app = await createAgendaApp(client);
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/disponibilidad?id_sucursal=${BRANCH_A}&selection_type=${selectionType}&id_paquete=${PACKAGE_A}&fecha_desde=2026-07-15&fecha_hasta=2026-07-15`,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "BOOKING_PACKAGE_FLOW_PENDING_2B");
    assert.ok(client.calls.some((call) => call.sql.includes("UPDATE public.citas_holds")));
    assert.ok(!client.calls.some((call) => call.sql.includes("FROM public.servicios_tarifas")));
    await app.close();
  }
});

test("ruta real GET /v1/public/agenda/horarios bloquea package y mixed con 409", async () => {
  for (const selectionType of ["package", "mixed"]) {
    const client = createAgendaClient();
    const app = await createAgendaApp(client);
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=${selectionType}&id_paquete=${PACKAGE_A}&fecha=2026-07-15`,
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "BOOKING_PACKAGE_FLOW_PENDING_2B");
    assert.ok(!client.calls.some((call) => call.sql.includes("FROM public.servicios_tarifas")));
    await app.close();
  }
});

test("ruta real GET /v1/public/agenda/horarios con servicios usa el pipeline real de agenda", async () => {
  const client = createAgendaClient();
  const app = await createAgendaApp(client);
  const response = await app.inject({
    method: "GET",
    url: `/v1/public/agenda/horarios?id_sucursal=${BRANCH_A}&selection_type=services&servicios=${SERVICE_A}&fecha=2026-07-15`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE public.citas_holds")));
  assert.ok(client.calls.length > 0);
  await app.close();
});
