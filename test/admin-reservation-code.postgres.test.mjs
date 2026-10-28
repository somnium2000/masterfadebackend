import assert from "node:assert/strict";
import crypto from "node:crypto";
import { findReservationGroupIds } from "../src/services/adminReservationLookup.js";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const RUN = process.env.RUN_ADMIN_RESERVATION_PG === "true";

function runPgBinary(binDir, name, args) {
  const executable = path.join(binDir, process.platform === "win32" ? `${name}.exe` : name);
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
}

async function startIsolatedPostgres17() {
  const detected = spawnSync("pg_config", ["--bindir"], { encoding: "utf8", windowsHide: true });
  const binDir = process.env.MASTERFADE_TEST_PG_BIN
    || (detected.status === 0 ? detected.stdout.trim() : "C:/Program Files/PostgreSQL/17/bin");
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-vip-identity-pg-"));
  const dataDir = path.join(directory, "data");
  const logFile = path.join(directory, "postgres.log");
  let started = false;
  try {
    runPgBinary(binDir, "initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    await appendFile(path.join(dataDir, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
    runPgBinary(binDir, "pg_ctl", ["-D", dataDir, "-l", logFile, "-w", "start"]);
    started = true;
    return {
      connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      async stop() {
        if (started) runPgBinary(binDir, "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
        started = false;
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
        assert.ok(path.basename(resolved).startsWith("masterfade-vip-identity-pg-"));
        await rm(resolved, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started) runPgBinary(binDir, "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
    try { error.message += `\n${await readFile(logFile, "utf8")}`; } catch {
      // AM: El diagnóstico principal de arranque se conserva aunque el log no exista.
    }
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("masterfade-vip-identity-pg-"));
    await rm(resolved, { recursive: true, force: true });
    throw error;
  }
}


test("PostgreSQL 17: codigo publico, colisiones y aislamiento de reserva", { skip: !RUN }, async (t) => {
  const isolated = await startIsolatedPostgres17();
  const pool = new pg.Pool({ connectionString: isolated.connectionString, ssl: false });
  t.after(async () => { await pool.end(); await isolated.stop(); });
  assert.ok(Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num) >= 170000);
  await pool.query("CREATE TABLE public.citas (id_cita uuid PRIMARY KEY, id_grupo_cita uuid, id_sucursal uuid, id_empleado_barbero uuid, deleted_at timestamptz, estado_cita_codigo text)");
  const branch = crypto.randomUUID(), otherBranch = crypto.randomUUID(), barber = crypto.randomUUID();
  const groups = Array.from({ length: 100 }, () => crypto.randomUUID());
  function publicCode(id) {
    let h = 0;
    for (const char of id.toUpperCase()) h = ((h << 5) - h + char.charCodeAt(0)) | 0;
    return (Math.abs(h) % (36 ** 5)).toString(36).toUpperCase().padStart(5, "0");
  }
  for (const id of groups) await pool.query("INSERT INTO public.citas VALUES ($1,$2,$3,$4,NULL,'completada')", [crypto.randomUUID(), id, branch, barber]);
  for (const group of groups) {
    const matches = await findReservationGroupIds(pool, { code: publicCode(group), branchIds: [branch], barberId: barber });
    assert.ok(matches.includes(group));
    assert.deepEqual(await findReservationGroupIds(pool, { code: publicCode(group), branchIds: [otherBranch] }), []);
  }
  // AM: Buscar colision reproducible para probar que ambas reservas se conservan.
  const seen = new Map(); let collision;
  for (let i = 0; i < 100000; i++) {
    const id = crypto.randomUUID(), code = publicCode(id);
    if (seen.has(code)) { collision = [seen.get(code), id, code]; break; }
    seen.set(code, id);
  }
  assert.ok(collision);
  for (const group of collision.slice(0, 2)) await pool.query("INSERT INTO public.citas VALUES ($1,$2,$3,$4,NULL,'confirmada')", [crypto.randomUUID(), group, branch, barber]);
  const matches = await findReservationGroupIds(pool, { code: collision[2], branchIds: [branch] });
  assert.ok(matches.includes(collision[0]) && matches.includes(collision[1]));
  assert.deepEqual(await findReservationGroupIds(pool, { code: collision[2], branchIds: [branch], barberId: crypto.randomUUID() }), []);
});

