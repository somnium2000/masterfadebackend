import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import adminCatalogRoutes from "../src/routes/v1/admin/catalog.js";

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const CLONE_ID = "33333333-3333-4333-8333-333333333333";
const TARIFF_ID = "44444444-4444-4444-8444-444444444444";
const BRANCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRANCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

async function buildApp({
  roles = ["admin"],
  claimBranches = [BRANCH_A],
  adminBranches = claimBranches,
  shared = false,
  duplicateName = false,
  failMasterUpdate = false,
  activo = true,
} = {}) {
  const state = {
    service: {
      id_servicio: SERVICE_ID,
      nombre_servicio: "Corte clasico",
      descripcion: "Descripcion original",
      duracion_min: 30,
      buffer_min: 5,
      grupo_catalogo: "barberia",
      visible_publico: true,
      agendable: true,
      orden_visual: 100,
      activo,
      id_sucursal: BRANCH_A,
      precio_hnl: 250,
      servicio_informativo: false,
      tarifa_activa: true,
      barberos_ofrecen_total: 0,
      barberos_ofrecen: [],
      deleted_at: null,
    },
    cloneAttempts: 0,
    masterUpdates: 0,
    tariffWrites: 0,
    begin: 0,
    commit: 0,
    rollback: 0,
    released: 0,
  };

  const query = async (sql, params = []) => {
    const text = normalizedSql(sql);
    if (text.startsWith("SELECT DISTINCT ru.id_sucursal")) {
      assert.deepEqual(params, [SERVICE_ID]);
      return { rows: adminBranches.map((id_sucursal) => ({ id_sucursal })), rowCount: adminBranches.length };
    }
    if (text === "BEGIN") {
      state.begin += 1;
      return { rows: [], rowCount: 0 };
    }
    if (text === "COMMIT") {
      state.commit += 1;
      return { rows: [], rowCount: 0 };
    }
    if (text === "ROLLBACK") {
      state.rollback += 1;
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("SELECT 1 FROM public.sucursales WHERE id_sucursal")) {
      return { rows: [{}], rowCount: 1 };
    }
    if (text.startsWith("WITH scoped_tariffs AS") && text.includes("WHERE s.id_servicio = $1::uuid")) {
      return { rows: [{ ...state.service, id_servicio: params[0], id_sucursal: params[1] }], rowCount: 1 };
    }
    if (text.includes("lower(regexp_replace(trim(s.nombre_servicio)") && text.includes("LIMIT 1")) {
      if (duplicateName && params[0] === "Corte premium") {
        return {
          rows: [{ id_servicio: OTHER_SERVICE_ID, nombre_servicio: "Corte premium" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("st.id_sucursal <> $2::uuid")) {
      return { rows: shared ? [{}] : [], rowCount: shared ? 1 : 0 };
    }
    if (text.includes("FROM public.servicios s") && text.includes("s.deleted_at") && text.includes("LIMIT 1")) {
      return { rows: [{ ...state.service, id_servicio: params[0] }], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO public.servicios (") && text.includes("RETURNING id_servicio")) {
      state.cloneAttempts += 1;
      if (params[0] === state.service.nombre_servicio) {
        const error = new Error("duplicate service name");
        error.code = "23505";
        error.constraint = "uq_servicios_nombre_normalizado_vivo";
        throw error;
      }
      state.service = { ...state.service, id_servicio: CLONE_ID, nombre_servicio: params[0] };
      return { rows: [{ id_servicio: CLONE_ID }], rowCount: 1 };
    }
    if (text.startsWith("UPDATE public.servicios_tarifas SET id_servicio =")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE public.servicios SET")) {
      state.masterUpdates += 1;
      if (failMasterUpdate) throw new Error("simulated database failure");
      // AM: Reproduce el efecto real de la asignacion SQL sobre el estado maestro.
      if (/\bactivo\s*=\s*TRUE\b/i.test(text)) state.service.activo = true;
      if (params.length >= 7) {
        state.service = {
          ...state.service,
          id_servicio: params[0],
          nombre_servicio: params[1],
          descripcion: params[2],
          grupo_catalogo: params[3],
          orden_visual: params[4],
          visible_publico: params[5],
          agendable: params[6],
        };
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rows: [{}], rowCount: 1 };
    }
    if (text.includes("FROM public.servicios_tarifas st") && text.includes("LIMIT 1 FOR UPDATE")) {
      return {
        rows: [{
          id_tarifa: TARIFF_ID,
          precio_hnl: state.service.precio_hnl,
          duracion_min: state.service.duracion_min,
          buffer_min: state.service.buffer_min,
          servicio_informativo: false,
          activo: true,
        }],
        rowCount: 1,
      };
    }
    if (text.startsWith("UPDATE public.servicios_tarifas SET")) {
      state.tariffWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${text.slice(0, 180)}`);
  };

  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowedRoles = []) => async (request, reply) => {
    if (!roles.some((role) => allowedRoles.includes(role))) {
      return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
    }
    request.claims = { roles, branch_ids: claimBranches, user: { id_usuario: SERVICE_ID } };
  });
  app.decorate("db", {
    query,
    connect: async () => ({
      query,
      release() {
        state.released += 1;
      },
    }),
  });
  await app.register(adminCatalogRoutes, { prefix: "/v1/admin/catalog" });
  await app.ready();
  return { app, state };
}

async function patchService(app, body) {
  return app.inject({
    method: "PATCH",
    url: `/v1/admin/catalog/servicios/${SERVICE_ID}`,
    payload: body,
  });
}

for (const scenario of [
  { name: "admin A + barbero B edita A", adminBranches: [BRANCH_A], target: BRANCH_A, status: 200 },
  { name: "admin A + barbero B no edita B", adminBranches: [BRANCH_A], target: BRANCH_B, status: 403 },
  { name: "admin A+B edita A", adminBranches: [BRANCH_A, BRANCH_B], target: BRANCH_A, status: 200 },
  { name: "admin A+B edita B", adminBranches: [BRANCH_A, BRANCH_B], target: BRANCH_B, status: 200 },
  { name: "sin asignacion admin no escribe", adminBranches: [], target: BRANCH_A, status: 403 },
]) {
  test(scenario.name, async (t) => {
    const { app, state } = await buildApp({ roles: ["admin", "barbero"], claimBranches: [BRANCH_A, BRANCH_B], adminBranches: scenario.adminBranches });
    t.after(() => app.close());
    const response = await patchService(app, { id_sucursal: scenario.target, descripcion: "Descripcion autorizada" });
    assert.equal(response.statusCode, scenario.status, response.body);
    assert.equal(state.masterUpdates, scenario.status === 200 ? 1 : 0);
    assert.equal(state.commit, scenario.status === 200 ? 1 : 0);
    assert.equal(state.begin, scenario.status === 200 ? 1 : 0);
    if (scenario.status === 200) assert.equal(response.json().data.descripcion, "Descripcion autorizada");
  });
}

for (const activo of [false, true]) {
  for (const shared of [false, true]) {
    for (const [field, value] of [["descripcion", "Descripcion revisada"], ["precio_hnl", 275]]) {
      test(`edicion de ${field} conserva activo=${activo}, compartido=${shared}`, async (t) => {
        const { app, state } = await buildApp({ activo, shared });
        t.after(() => app.close());
        const response = await patchService(app, { id_sucursal: BRANCH_A, [field]: value });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(state.service.activo, activo);
        assert.equal(response.json().data.activo, activo);
        if (field === "descripcion") assert.equal(state.service.descripcion, value);
        else assert.ok(state.tariffWrites > 0);
        assert.equal(state.cloneAttempts, 0);
        assert.equal(state.commit, 1);
        assert.equal(state.rollback, 0);
        assert.equal(state.released, 1);
      });
    }
  }
}

test("reactivacion explicita por endpoint de estado conserva su funcionamiento", async (t) => {
  const { app, state } = await buildApp({ activo: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: "PATCH",
    url: `/v1/admin/catalog/servicios/${SERVICE_ID}/estado`,
    payload: { id_sucursal: BRANCH_A, activo: true, precio_hnl: 275 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(state.service.activo, true);
  assert.equal(response.json().data.activo, true);
  assert.equal(state.commit, 1);
  assert.equal(state.rollback, 0);
});

test("servicio de una sucursal edita descripcion sin clonar", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, nombre_servicio: "Corte clasico", descripcion: "Nueva" });
  assert.equal(response.statusCode, 200);
  assert.equal(state.cloneAttempts, 0);
});

test("servicio compartido edita descripcion con nombre intacto sin clonar", async (t) => {
  const { app, state } = await buildApp({ shared: true });
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, nombre_servicio: "Corte clasico", descripcion: "Nueva" });
  assert.equal(response.statusCode, 200);
  assert.equal(state.cloneAttempts, 0);
  assert.equal(state.commit, 1);
});

test("servicio compartido conserva clonacion cuando cambia realmente el nombre", async (t) => {
  const { app, state } = await buildApp({ shared: true });
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, nombre_servicio: "Corte premium" });
  assert.equal(response.statusCode, 200);
  assert.equal(state.cloneAttempts, 1);
  assert.equal(response.json().data.id_servicio, CLONE_ID);
});

test("rechaza un nombre duplicado perteneciente a otro servicio", async (t) => {
  const { app, state } = await buildApp({ shared: true, duplicateName: true });
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, nombre_servicio: "Corte premium" });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "SERVICE_NAME_DUPLICATE");
  assert.equal(state.cloneAttempts, 0);
});

test("edicion exclusiva de tarifa no clona el maestro", async (t) => {
  const { app, state } = await buildApp({ shared: true });
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, precio_hnl: 275 });
  assert.equal(response.statusCode, 200);
  assert.equal(state.cloneAttempts, 0);
  assert.ok(state.tariffWrites > 0);
});

test("admin autorizado conserva acceso a la edicion", async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, descripcion: "Nueva" });
  assert.equal(response.statusCode, 200);
});

test("admin fuera de sucursal recibe 403 antes de iniciar transaccion", async (t) => {
  const { app, state } = await buildApp();
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_B, descripcion: "Nueva" });
  assert.equal(response.statusCode, 403);
  assert.equal(state.begin, 0);
});

for (const roles of [["super_admin"], ["super_admin", "admin"]]) {
  test(`${roles.join(" + ")} conserva acceso a otra sucursal`, async (t) => {
    const { app } = await buildApp({ roles });
    t.after(() => app.close());
    const response = await patchService(app, { id_sucursal: BRANCH_B, descripcion: "Nueva" });
    assert.equal(response.statusCode, 200);
  });
}

test("error SQL revierte la transaccion y no confirma cambios", async (t) => {
  const { app, state } = await buildApp({ failMasterUpdate: true });
  t.after(() => app.close());
  const response = await patchService(app, { id_sucursal: BRANCH_A, descripcion: "Nueva" });
  assert.equal(response.statusCode, 500);
  assert.equal(state.rollback, 1);
  assert.equal(state.commit, 0);
});

test("payload equivalente al frontend conserva el nombre y evita clon innecesario", async (t) => {
  const { app, state } = await buildApp({ shared: true });
  t.after(() => app.close());
  const response = await patchService(app, {
    id_sucursal: BRANCH_A,
    nombre_servicio: "Corte clasico",
    descripcion: "Descripcion desde formulario",
    orden_visual: 120,
    visible_publico: false,
    agendable: true,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.cloneAttempts, 0);
});
