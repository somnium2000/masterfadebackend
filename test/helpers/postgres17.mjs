import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

function binary(binDir, name, args) {
  const executable = path.join(binDir, process.platform === "win32" ? `${name}.exe` : name);
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

export async function startPostgres17() {
  const detected = spawnSync("pg_config", ["--bindir"], { encoding: "utf8", windowsHide: true });
  const binDir = process.env.MASTERFADE_TEST_PG_BIN
    || (detected.status === 0 ? detected.stdout.trim() : "C:/Program Files/PostgreSQL/17/bin");
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-promos-b-pg-"));
  const dataDir = path.join(directory, "data");
  const logFile = path.join(directory, "postgres.log");
  let client;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    if (client) await client.end();
    try {
      const pid = await readFile(path.join(dataDir, "postmaster.pid"), "utf8");
      if (pid) binary(binDir, "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("masterfade-promos-b-pg-"));
    await rm(directory, { recursive: true, force: true });
    stopped = true;
  };

  try {
    binary(binDir, "initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await appendFile(path.join(dataDir, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
    binary(binDir, "pg_ctl", ["-D", dataDir, "-l", logFile, "-t", "20", "-w", "start"]);
    const connectionOptions = { host: "127.0.0.1", port, user: "postgres", database: "postgres", ssl: false };
    client = new pg.Client(connectionOptions);
    await client.connect();
    assert.match((await client.query("show server_version")).rows[0].server_version, /^17\./);
    return { client, connectionOptions, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
