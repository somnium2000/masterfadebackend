import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import adminCitasRoutes from "../src/routes/v1/admin/citas.js";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const BARBER_A = "22222222-2222-4222-8222-222222222222";
const BARBER_B = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";

function appointment(overrides = {}) {
  return {
    id_cita: "66666666-6666-4666-8666-666666666666",
    id_grupo_cita: null,
    orden_integrante: 1,
    alias_integrante: null,
    id_sucursal: BRANCH_ID,
    nombre_sucursal: "Sucursal QA",
    id_empleado_barbero: BARBER_A,
    id_persona_cliente: "55555555-5555-4555-8555-555555555555",
    id_cliente: CLIENT_ID,
    estado_cita_codigo: "confirmada",
    inicio_at: "2026-11-03T14:00:00.000Z",
    fin_at: "2026-11-03T15:00:00.000Z",
    retraso_inicio_min: 0,
    duracion_total_min: 60,
    buffer_total_min: 0,
    selection_type: "services",
    total_pagar_hnl: 250,
    moneda_codigo: "HNL",
    asignada_automaticamente: false,
    nombre_barbero: "Barbero QA",
    nombre_cliente: "Cliente QA",
    servicios: [],
    servicios_detalle: [],
    preferencias_corte: "  degradado bajo y barba corta  ",
    preferencias_corte_historicas: null,
    ...overrides,
  };
}

async function runList({ roles, empleadoId = null, row = appointment() }) {
  let operationalParams = null;
  const db = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: BRANCH_ID }], rowCount: 1 };
      if (text.includes("FROM information_schema.columns")) return { rows: [], rowCount: 0 };
      if (text.includes("COALESCE(srv.servicios")) {
        operationalParams = params;
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = Fastify({ logger: false });
  app.decorate("db", db);
  app.decorate("requireRoles", () => async (request) => {
    request.claims = {
      roles,
      empleado_id: empleadoId,
      branch_ids: [BRANCH_ID],
      user: { id_usuario: "77777777-7777-4777-8777-777777777777" },
    };
  });
  await app.register(adminCitasRoutes, { prefix: "/v1/admin/citas" });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/admin/citas/operativas" });
    return { response, operationalParams };
  } finally {
    await app.close();
  }
}

test("barbero asignado recibe texto normalizado sin alterar alcance de sucursal", async () => {
  const { response, operationalParams } = await runList({ roles: ["barbero"], empleadoId: BARBER_A });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.citas[0].preferencias_corte, "degradado bajo y barba corta");
  assert.deepEqual(operationalParams[0], [BRANCH_ID]);
});

test("otro barbero y admin sin rol barbero no reciben preferencias", async () => {
  const other = await runList({ roles: ["barbero"], empleadoId: BARBER_B });
  assert.equal(other.response.statusCode, 200);
  assert.equal(other.response.json().data.citas[0].preferencias_corte, null);

  const admin = await runList({ roles: ["admin"], empleadoId: BARBER_A });
  assert.equal(admin.response.statusCode, 200);
  assert.equal(admin.response.json().data.citas[0].preferencias_corte, null);
});

test("multirrol barbero asignado conserva verificación por empleado", async () => {
  const assigned = await runList({ roles: ["admin", "barbero"], empleadoId: BARBER_A });
  assert.equal(assigned.response.statusCode, 200);
  assert.equal(assigned.response.json().data.citas[0].preferencias_corte, "degradado bajo y barba corta");

  const unassigned = await runList({ roles: ["super_admin", "barbero"], empleadoId: BARBER_B });
  assert.equal(unassigned.response.statusCode, 200);
  assert.equal(unassigned.response.json().data.citas[0].preferencias_corte, null);
});

test("invitado, acompañante sin cliente y preferencias vacías devuelven null", async () => {
  for (const row of [
    appointment({ id_cliente: null, preferencias_corte: "texto indebido" }),
    appointment({ id_cliente: null, alias_integrante: "Acompañante", preferencias_corte: "texto indebido" }),
    appointment({ preferencias_corte: "   ", preferencias_corte_historicas: "   " }),
  ]) {
    const { response } = await runList({ roles: ["barbero"], empleadoId: BARBER_A, row });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.citas[0].preferencias_corte, null);
  }
});

test("representación histórica textual reconocida se normaliza sin exponer JSON arbitrario", async () => {
  const historical = await runList({
    roles: ["barbero"],
    empleadoId: BARBER_A,
    row: appointment({ preferencias_corte: null, preferencias_corte_historicas: "  tijera arriba  " }),
  });
  assert.equal(historical.response.json().data.citas[0].preferencias_corte, "tijera arriba");

  const arbitrary = await runList({
    roles: ["barbero"],
    empleadoId: BARBER_A,
    row: appointment({ preferencias_corte: { secreto: "no exponer" }, preferencias_corte_historicas: null }),
  });
  assert.equal(arbitrary.response.json().data.citas[0].preferencias_corte, null);
});
