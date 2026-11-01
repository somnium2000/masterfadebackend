import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binDirectory = process.env.MASTERFADE_TEST_PG_BIN || "C:/Program Files/PostgreSQL/17/bin";

function run(name, args) {
  const executable = path.join(binDirectory, `${name}${process.platform === "win32" ? ".exe" : ""}`);
  const result = spawnSync(executable, args, { cwd: projectDirectory, encoding: "utf8", timeout: 120_000, windowsHide: true });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function startBookingDeadlockPostgres17() {
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-booking-deadlock-pg17-"));
  const data = path.join(directory, "data");
  const log = path.join(directory, "postgres.log");
  const port = await freePort();
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
  await appendFile(path.join(data, "postgresql.conf"), [
    "listen_addresses='127.0.0.1'", `port=${port}`, "unix_socket_directories=''", "max_connections=30",
    "log_lock_waits=on", "deadlock_timeout='25ms'", "log_min_error_statement=error", "log_error_verbosity=verbose",
  ].join("\n") + "\n");
  run("pg_ctl", ["-D", data, "-l", log, "-t", "30", "-w", "start"]);
  const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 20 });
  assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^17\./);
  return {
    pool,
    log,
    async sqlFile(relative) {
      run("psql", ["-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-f", path.resolve(projectDirectory, relative)]);
    },
    readLog: () => readFile(log, "utf8"),
    async stop() {
      await pool.end();
      run("pg_ctl", ["-D", data, "-m", "fast", "-t", "20", "-w", "stop"]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
