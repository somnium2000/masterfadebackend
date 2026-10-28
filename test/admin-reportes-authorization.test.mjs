import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import adminReportesRoutes from "../src/routes/v1/admin/reportes.js";

const ENDPOINTS = [
  "/contexto?id_sucursal=11111111-1111-4111-8111-111111111111",
  "/dashboard?fecha_desde=2026-10-01&fecha_hasta=2026-10-10&id_sucursal=11111111-1111-4111-8111-111111111111",
  "/export/csv?fecha_desde=2026-10-01&fecha_hasta=2026-10-10&export_type=resumen",
  "/export/excel?fecha_desde=2026-10-01&fecha_hasta=2026-10-10&export_type=ingresos_sucursal",
];

async function buildApp(roles = null) {
  let databaseAccesses = 0;
  let databaseConnections = 0;
  const app = Fastify({ logger: false });
  const rejectDatabaseAccess = async () => {
    databaseAccesses += 1;
    throw new Error("REPORTES_TEST_DB_REACHED");
  };

  app.decorate("requireRoles", (allowedRoles = []) => async (request, reply) => {
    if (!Array.isArray(roles)) {
      return reply.code(401).send({ ok: false });
    }
    if (!roles.some((role) => allowedRoles.includes(role))) {
      return reply.code(403).send({ ok: false });
    }
    request.claims = {
      roles,
      branch_ids: ["11111111-1111-4111-8111-111111111111"],
    };
  });
  app.decorate("db", {
    query: rejectDatabaseAccess,
    connect: async () => {
      databaseConnections += 1;
      return {
        query: rejectDatabaseAccess,
        release() {},
      };
    },
  });
  await app.register(adminReportesRoutes, { prefix: "/v1/admin/reportes" });
  await app.ready();

  return {
    app,
    getDatabaseAccesses: () => databaseAccesses,
    getDatabaseConnections: () => databaseConnections,
  };
}

for (const { label, roles, expectedStatus } of [
  { label: "admin", roles: ["admin"], expectedStatus: 403 },
  { label: "barbero", roles: ["barbero"], expectedStatus: 403 },
  { label: "cliente", roles: ["cliente"], expectedStatus: 403 },
  { label: "autenticado sin privilegio", roles: ["security_auditor"], expectedStatus: 403 },
  { label: "sin sesion", roles: null, expectedStatus: 401 },
]) {
  test(`${label} queda bloqueado antes de DB en todos los endpoints de Reportes`, async (t) => {
    const { app, getDatabaseAccesses, getDatabaseConnections } = await buildApp(roles);
    t.after(() => app.close());

    for (const endpoint of ENDPOINTS) {
      const response = await app.inject({ method: "GET", url: `/v1/admin/reportes${endpoint}` });
      assert.equal(response.statusCode, expectedStatus, endpoint);
    }
    assert.equal(getDatabaseAccesses(), 0);
    assert.equal(getDatabaseConnections(), 0);
  });
}

for (const { label, roles } of [
  { label: "super_admin", roles: ["super_admin"] },
  { label: "super_admin + admin", roles: ["super_admin", "admin"] },
]) {
  test(`${label} supera el guard de los cuatro endpoints`, async (t) => {
    const { app, getDatabaseAccesses } = await buildApp(roles);
    t.after(() => app.close());

    for (const endpoint of ENDPOINTS) {
      const previousAccesses = getDatabaseAccesses();
      const response = await app.inject({ method: "GET", url: `/v1/admin/reportes${endpoint}` });
      assert.equal(response.statusCode, 500, endpoint);
      assert.equal(getDatabaseAccesses(), previousAccesses + 1, endpoint);
    }
  });
}
