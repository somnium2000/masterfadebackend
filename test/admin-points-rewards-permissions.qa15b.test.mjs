import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import Fastify from "fastify";

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const payload = { sin_membresia: [SERVICE_ID], con_membresia: [] };
let calls = [];

const serviceKey = "__mfRewardsPermissionsQa15b";
globalThis[serviceKey] = {
  getMasterPuntosRewardServicesConfig: async () => {
    calls.push({ name: "get" });
    return { regla: {}, servicios_catalogo: [], configuracion: {} };
  },
  updateMasterPuntosRewardServicesConfig: async (...args) => {
    calls.push({ name: "patch", args });
    return { regla: {}, servicios_catalogo: [], configuracion: {} };
  },
};
after(() => { delete globalThis[serviceKey]; });

async function loadPointsRoutes() {
  const url = new URL("../src/routes/v1/admin/puntos.js", import.meta.url);
  const source = readFileSync(url, "utf8")
    .replace(/from "([^"]+)"/g, (_match, specifier) => {
      if (specifier.endsWith("/masterPuntosService.js")) {
        const exports = Object.keys(globalThis[serviceKey])
          .map((name) => `export const ${name} = (...args) => globalThis.${serviceKey}.${name}(...args);`)
          .join("\n");
        return `from ${JSON.stringify(`data:text/javascript,${encodeURIComponent(exports)}`)}`;
      }
      if (specifier.endsWith("/pointsService.js")) {
        const exports = ["addManualPointsAdjustment", "getClientePointsSummary", "searchActiveClientesForAdminPoints"]
          .map((name) => `export const ${name} = () => { throw new Error(${JSON.stringify(`${name}_MUST_NOT_RUN`)}); };`)
          .join("\n");
        return `from ${JSON.stringify(`data:text/javascript,${encodeURIComponent(exports)}`)}`;
      }
      return `from ${JSON.stringify(new URL(specifier, url).href)}`;
    });
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
}

const pointsRoutes = await loadPointsRoutes();

async function setup(t, roles) {
  calls = [];
  const app = Fastify({ logger: false });
  app.decorate("requireRoles", (allowed) => async (request, reply) => {
    if (!roles) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    if (!roles.some((role) => allowed.includes(role))) {
      return reply.code(403).send({ error: { code: "AUTH_FORBIDDEN" } });
    }
    request.claims = { roles, user: { id_usuario: ACTOR_ID }, branch_ids: [] };
  });
  app.decorate("db", {
    query: () => { throw new Error("SQL_MUST_NOT_RUN"); },
    connect: () => { throw new Error("SQL_MUST_NOT_RUN"); },
  });
  await app.register(pointsRoutes, { prefix: "/v1/admin/puntos" });
  t.after(() => app.close());
  return app;
}

test("admin consulta regalías pero no puede actualizarlas", async (t) => {
  const app = await setup(t, ["admin"]);
  const read = await app.inject({ method: "GET", url: "/v1/admin/puntos/regalias" });
  const write = await app.inject({ method: "PATCH", url: "/v1/admin/puntos/regalias", payload });
  assert.equal(read.statusCode, 200);
  assert.equal(write.statusCode, 403);
  assert.deepEqual(calls.map(({ name }) => name), ["get"]);
});

for (const [label, roles] of [
  ["super_admin", ["super_admin"]],
  ["super_admin multirrol", ["admin", "super_admin"]],
]) test(`${label} puede actualizar regalías y transmite claims`, async (t) => {
  const app = await setup(t, roles);
  const response = await app.inject({ method: "PATCH", url: "/v1/admin/puntos/regalias", payload });
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args[1].roles, roles);
  assert.deepEqual(calls[0].args[2], payload);
});

for (const [label, roles] of [
  ["admin multirrol sin super_admin", ["admin", "barbero"]],
  ["cliente", ["cliente"]],
  ["barbero", ["barbero"]],
]) test(`${label} recibe 403 sin ejecutar escritura`, async (t) => {
  const app = await setup(t, roles);
  const response = await app.inject({ method: "PATCH", url: "/v1/admin/puntos/regalias", payload });
  assert.equal(response.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("el servicio rechaza admin antes de abrir una conexión SQL", async () => {
  const { updateMasterPuntosRewardServicesConfig } = await import("../src/services/masterPuntosService.js?qa15b-permissions");
  let connectCalls = 0;
  const app = { db: { connect: () => { connectCalls += 1; throw new Error("SQL_MUST_NOT_RUN"); } } };
  await assert.rejects(
    updateMasterPuntosRewardServicesConfig(app, { roles: ["admin"] }, payload),
    { statusCode: 403, code: "MASTERPUNTOS_GLOBAL_RULE_FORBIDDEN" }
  );
  assert.equal(connectCalls, 0);
});
