import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getMasterPuntosClienteMovimientos,
  listMasterPuntosClientes,
} from "../src/services/masterPuntosService.js";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const MIGRATION = new URL(
  "../db/migrations/20261030010000_masterpuntos_readonly_expiration_v1.sql",
  import.meta.url
);

function createReadFixture() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ target: "client", sql: text, params });
      if (text.includes("fn_points_materialize_expired_cycles")) {
        throw new Error("GET_MUST_NOT_MATERIALIZE_EXPIRED_CYCLES");
      }
      if (text.includes("to_regclass('public.points_legacy_migrations')")) {
        return { rows: [{ has_points_legacy_migrations: false }] };
      }
      if (text.includes("SELECT COUNT(*) AS total") && text.includes("FROM public.clientes")) {
        return { rows: [{ total: "0" }] };
      }
      if (text.includes("WITH scoped_clients AS")) return { rows: [] };
      if (text.includes("FROM public.clientes c") && text.includes("JOIN public.personas p")) {
        return { rows: [{ id_cliente: CLIENT, id_sucursal_origen: BRANCH, id_usuario: null }] };
      }
      if (text.includes("SELECT COUNT(*) AS total FROM public.points_ledger")) {
        return { rows: [{ total: "0" }] };
      }
      if (text.includes("FROM public.points_ledger l")) return { rows: [] };
      throw new Error(`SQL_NO_SIMULADO: ${text}`);
    },
    release() {
      calls.push({ target: "client", sql: "RELEASE", params: [] });
    },
  };
  const app = {
    db: {
      async query(sql, params = []) {
        const text = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ target: "db", sql: text, params });
        if (text.includes("FROM public.sucursales")) return { rows: [{ id_sucursal: BRANCH }] };
        throw new Error(`SQL_DB_NO_SIMULADO: ${text}`);
      },
      async connect() {
        return client;
      },
    },
    log: { error() {} },
  };
  return { app, calls };
}

test("listado administrativo repetido no materializa vencimientos", async () => {
  const { app, calls } = createReadFixture();
  const claims = { roles: ["admin"], branch_ids: [BRANCH] };

  await listMasterPuntosClientes(app, claims, { page: 1, limit: 20 });
  await listMasterPuntosClientes(app, claims, { page: 1, limit: 20 });

  assert.equal(calls.some(({ sql }) => sql.includes("fn_points_materialize_expired_cycles")), false);
  assert.equal(calls.some(({ sql }) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("historial legacy conserva contrato sin materializar vencimientos", async () => {
  const { app, calls } = createReadFixture();
  const claims = { roles: ["admin"], branch_ids: [BRANCH] };

  const result = await getMasterPuntosClienteMovimientos(app, claims, CLIENT, { page: 1, limit: 20 });

  assert.deepEqual(result.movimientos, []);
  assert.equal(calls.some(({ sql }) => sql.includes("fn_points_materialize_expired_cycles")), false);
  assert.equal(calls.some(({ sql }) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("migracion conserva contrato de vista y endurece materializacion concurrente", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  assert.match(sql, /CREATE OR REPLACE VIEW public\.vw_points_balance/i);
  assert.match(sql, /estado_ciclo_codigo\s*=\s*'activo'/i);
  assert.match(sql, /pc\.vence_at\s+IS NOT NULL/i);
  assert.match(sql, /pc\.vence_at\s*<=\s*now\(\)/i);
  assert.match(sql, /remaining_points\s*>\s*0/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fn_points_materialize_expired_cycles/i);
  assert.match(sql, /ORDER BY pc\.id_cycle[\s\S]*FOR UPDATE OF pc/i);
  assert.doesNotMatch(sql, /SKIP LOCKED/i);
  assert.match(sql, /ON CONFLICT \(id_cycle, tipo_puntos_codigo\)[\s\S]*DO NOTHING/i);
});

test("proyeccion aprobada equivale a la materializacion para saldos sinteticos", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const scenarios = [
    ["vigente", [{ cycle: "a", state: "activo", due: "2026-11-01", points: 7 }], 7],
    ["vencido pendiente", [{ cycle: "a", state: "activo", due: "2026-10-29", points: 7 }], 0],
    ["materializado", [
      { cycle: "a", state: "expirado", due: "2026-10-29", points: 7 },
      { cycle: "a", state: "expirado", due: "2026-10-29", points: -7 },
    ], 0],
    ["mezclado vencido", [
      { cycle: "a", state: "activo", due: "2026-10-29", points: 10 },
      { cycle: "a", state: "activo", due: "2026-10-29", points: -4 },
    ], 0],
    ["sin vencimiento", [{ cycle: "a", state: "activo", due: null, points: 7 }], 7],
    ["cerrado", [{ cycle: "a", state: "cerrado", due: "2026-10-29", points: 7 }], 7],
    ["sin ciclo", [{ cycle: null, state: null, due: null, points: 5 }], 5],
    ["negativo vencido", [
      { cycle: "a", state: "activo", due: "2026-10-29", points: 3 },
      { cycle: "a", state: "activo", due: "2026-10-29", points: -5 },
    ], -2],
    ["cero", [
      { cycle: "a", state: "activo", due: "2026-10-29", points: 5 },
      { cycle: "a", state: "activo", due: "2026-10-29", points: -5 },
    ], 0],
  ];

  const project = (rows) => {
    const ledger = rows.reduce((sum, row) => sum + row.points, 0);
    const cycles = new Map();
    for (const row of rows) {
      if (!row.cycle) continue;
      const cycle = cycles.get(row.cycle) || { state: row.state, due: row.due, points: 0 };
      cycle.points += row.points;
      cycles.set(row.cycle, cycle);
    }
    let pendingExpiration = 0;
    for (const cycle of cycles.values()) {
      if (cycle.state === "activo" && cycle.due && new Date(cycle.due) <= now && cycle.points > 0) {
        pendingExpiration += cycle.points;
      }
    }
    return ledger - pendingExpiration;
  };

  for (const [name, rows, expected] of scenarios) {
    assert.equal(project(rows), expected, name);
  }
});
