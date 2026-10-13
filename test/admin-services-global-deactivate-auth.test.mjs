import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import catalogRoutes from "../src/routes/v1/admin/catalog.js";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const BRANCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function buildApp(roles) {
  const calls = [];
  let connections = 0;
  const query = async (sql) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    calls.push(text);
    if (text.includes("FROM public.servicios s") && text.includes("LIMIT 1")) {
      return { rows: [{ id_servicio: SERVICE, deleted_at: null }] };
    }
    if (text.includes("total_citas_futuras")) return { rows: [{ total_citas_futuras: 0 }] };
    if (text.includes("SELECT 1 FROM public.sucursales")) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles.some((role) => allowed.includes(role))) {
      return reply.code(403).send({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Acceso no permitido" } });
    }
    request.claims = { roles, branch_ids: [BRANCH] };
  });
  app.decorate("db", { query, connect: async () => {
    connections += 1;
    return { query, release() {} };
  } });
  await app.register(catalogRoutes, { prefix: "/v1/admin/catalog" });
  await app.ready();
  return { app, calls, connections: () => connections };
}

test("admin recibe 403 en desactivación global antes de adquirir conexión o escribir", async (t) => {
  const { app, calls, connections } = await buildApp(["admin"]);
  t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/admin/catalog/servicios/${SERVICE}/desactivar-global` });
  assert.equal(response.statusCode, 403);
  assert.equal(connections(), 0);
  assert.deepEqual(calls, []);
});

for (const roles of [["super_admin"], ["admin", "super_admin"]]) {
  test(`${roles.join("+")} conserva desactivación global y transacción`, async (t) => {
    const { app, calls } = await buildApp(roles);
    t.after(() => app.close());
    const response = await app.inject({ method: "PATCH", url: `/v1/admin/catalog/servicios/${SERVICE}/desactivar-global` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().data, { id_servicio: SERVICE, activo: false, visible_publico: false, agendable: false });
    assert.ok(calls.includes("BEGIN"));
    assert.ok(calls.some((sql) => sql.startsWith("UPDATE public.servicios SET")));
    assert.ok(calls.includes("COMMIT"));
    assert.ok(!calls.includes("ROLLBACK"));
  });
}

test("admin conserva consultas administrativas de servicios por sucursal", async (t) => {
  const { app, calls } = await buildApp(["admin"]);
  t.after(() => app.close());
  for (const path of ["servicios", "servicios/agrupados"]) {
    const response = await app.inject({ method: "GET", url: `/v1/admin/catalog/${path}?id_sucursal=${BRANCH}` });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.ok(!calls.some((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql)));
});
