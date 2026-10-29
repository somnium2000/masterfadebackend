import assert from "node:assert/strict";
import { findReservationGroupIds } from "../src/services/adminReservationLookup.js";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const RUN = process.env.RUN_ADMIN_LOOKUP_BENCHMARK === "true";

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



test("benchmark reproducible PostgreSQL17 de busqueda por reserva", { skip: !RUN, timeout: 900000 }, async (t) => {
  const isolated = await startIsolatedPostgres17();
  const pool = new pg.Pool({ connectionString: isolated.connectionString, max: 4, ssl: false });
  pool.on('connect', (client) => { void client.query("SET work_mem='4MB'; SET jit=off"); });
  t.after(async () => { await pool.end(); await isolated.stop(); });
  const version = (await pool.query("SHOW server_version")).rows[0].server_version;
  assert.match(version, /^17\./);
  await pool.query("SET work_mem='4MB'; SET jit=off");
  await pool.query("CREATE TABLE public.citas (id_cita uuid PRIMARY KEY, id_grupo_cita uuid, id_sucursal uuid, id_empleado_barbero uuid, deleted_at timestamptz)");
  await pool.query("CREATE INDEX ON public.citas(id_sucursal) WHERE deleted_at IS NULL");
  const branch = "11111111-1111-4111-8111-111111111111";
  const barber = "22222222-2222-4222-8222-222222222222";
  let query, values;
  await findReservationGroupIds({ async query(sql, params) { query = sql; values = params; return { rows: [] }; } }, { code: "GOXBD", branchIds: [branch], barberId: null });
  const variant = process.env.LOOKUP_BENCHMARK_VARIANT || 'optimized';
  if (variant === 'baseline') {
    const source = spawnSync('git', ['show', '70ec425a8197927f57359c70fda43d28c8e29655:src/services/adminReservationLookup.js'], { encoding: 'utf8', windowsHide: true });
    assert.equal(source.status, 0);
    query = source.stdout.match(/client\.query\(`([\s\S]*?)`, \[/)[1];
  }
  const percentile = (array, p) => [...array].sort((a,b)=>a-b)[Math.ceil(array.length*p)-1];
  const measure = async () => { const start = performance.now(); await pool.query(query, values); return performance.now()-start; };
  process.stdout.write(JSON.stringify({ variant, version, settings: (await pool.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('work_mem','shared_buffers','jit')")).rows, samples: 20, concurrency: 4 })+"\n");
  for (const size of [1000,10000,100000]) {
    await pool.query("TRUNCATE public.citas");
    await pool.query(`INSERT INTO public.citas SELECT md5('cita-'||g)::uuid,md5('grupo-'||g)::uuid,$1::uuid,$2::uuid,NULL FROM generate_series(1,$3::int) g`, [branch,barber,size]);
    await pool.query("ANALYZE public.citas");
    await measure(); await measure();
    const serial = [];
    for(let i=0;i<20;i++) serial.push(await measure());
    const plan = (await pool.query("EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) "+query, values)).rows[0]["QUERY PLAN"][0];
    const nodes=[]; const walk=(node)=>{nodes.push(node);(node.Plans||[]).forEach(walk);};walk(plan.Plan);
    const recursive=nodes.find(node=>node["Node Type"]==="Recursive Union");
    const concurrent=[];
    for(let batch=0;batch<5;batch++) concurrent.push(...await Promise.all(Array.from({length:4}, measure)));
    const pids=(await pool.query("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND datname=current_database()")).rows.map(row=>row.pid);
    const memory=spawnSync("powershell",["-NoProfile","-Command",`Get-Process -Id ${pids.join(',')} | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{encoding:"utf8",windowsHide:true});
    process.stdout.write(JSON.stringify({ groups:size, serial_p50_ms:percentile(serial,.5),serial_p95_ms:percentile(serial,.95),sql_execution_ms:plan["Execution Time"],concurrent4_p50_ms:percentile(concurrent,.5),concurrent4_p95_ms:percentile(concurrent,.95),recursive_rows:recursive?.["Actual Rows"],temp_read_blocks:plan.Plan["Temp Read Blocks"],temp_written_blocks:plan.Plan["Temp Written Blocks"],operator_peak_memory_kb:Math.max(0,...nodes.map(node=>node["Peak Memory Usage"]||0)),rss_after_queries:memory.stdout.trim(),note:"RSS snapshot after load, not peak; operator peak excludes CTE tuplestores; 8KiB temp blocks" })+"\n");
  }
});
