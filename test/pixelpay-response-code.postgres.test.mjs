import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const RUN = process.env.RUN_PIXELPAY_RESPONSE_CODE_PG === "true";

function pgBin(binDir, name, args) {
  const executable = path.join(binDir, process.platform === "win32" ? `${name}.exe` : name);
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
}

async function startPostgres17() {
  const detected = spawnSync("pg_config", ["--bindir"], { encoding: "utf8", windowsHide: true });
  const binDir = process.env.MASTERFADE_TEST_PG_BIN
    || (detected.status === 0 ? detected.stdout.trim() : "C:/Program Files/PostgreSQL/17/bin");
  const root = await mkdtemp(path.join(tmpdir(), "masterfade-response-code-pg-"));
  const data = path.join(root, "data");
  const log = path.join(root, "postgres.log");
  pgBin(binDir, "initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await appendFile(path.join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
  pgBin(binDir, "pg_ctl", ["-D", data, "-l", log, "-w", "start"]);
  return {
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      pgBin(binDir, "pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
      assert.ok(path.basename(resolved).startsWith("masterfade-response-code-pg-"));
      await rm(resolved, { recursive: true, force: true });
    },
  };
}

test("PostgreSQL 17 aislado acepta solo response_code financiero seguro", { skip: !RUN }, async (t) => {
  const isolated = await startPostgres17();
  const pool = new pg.Pool({ connectionString: isolated.connectionString, ssl: false, max: 2 });
  t.after(async () => { await pool.end(); await isolated.stop(); });

  const version = Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num);
  assert.ok(version >= 170000 && version < 180000, `PostgreSQL 17 requerido; recibido ${version}`);
  await pool.query("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role");
  await pool.query("CREATE SCHEMA app_private");
  await pool.query("CREATE TABLE app_private.pixelpay_sale_attempts (id_sale_attempt uuid PRIMARY KEY DEFAULT gen_random_uuid())");
  const migration = await readFile(new URL("../db/migrations/pixel/20261028010000_pixelpay_provider_response_code.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);

  for (const code of [null, "00", "05", "N7", "X-1", "A_B.C:D"]) {
    await pool.query("INSERT INTO app_private.pixelpay_sale_attempts(provider_response_code) VALUES ($1)", [code]);
  }
  for (const code of ["4111111111111111", "DECLINED BY ISSUER", "05\nSECRET", "lower", "A".repeat(17)]) {
    await assert.rejects(
      pool.query("INSERT INTO app_private.pixelpay_sale_attempts(provider_response_code) VALUES ($1)", [code]),
      (error) => error.code === "23514" || error.code === "22001",
    );
  }
  const rows = await pool.query("SELECT provider_response_code FROM app_private.pixelpay_sale_attempts ORDER BY provider_response_code NULLS FIRST");
  assert.deepEqual(rows.rows.map((row) => row.provider_response_code), [null, "00", "05", "A_B.C:D", "N7", "X-1"]);
});
