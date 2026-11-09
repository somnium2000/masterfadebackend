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
import Fastify from 'fastify';
import adminCitasRoutes from '../src/routes/v1/admin/citas.js';
import { loadReservationMailContracts } from './helpers/reservationMailContract.mjs';

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
  const groups = ['11111111-2222-4333-8444-555555555555', ...Array.from({ length: 99 }, () => crypto.randomUUID())];
  function publicCode(id) {
    let h = 0;
    for (const char of id.toUpperCase()) h = ((h << 5) - h + char.charCodeAt(0)) | 0;
    return (Math.abs(h) % (36 ** 5)).toString(36).toUpperCase().padStart(5, "0");
  }
  for (const id of groups) await pool.query("INSERT INTO public.citas VALUES ($1,$2,$3,$4,NULL,'completada')", [crypto.randomUUID(), id, branch, barber]);
  const mailContracts = await loadReservationMailContracts();
  const mailCode = mailContracts.buildBookingShortCode(groups[0], 5);
  assert.equal(mailCode, 'S64WZ');
  assert.ok((await findReservationGroupIds(pool, { code: mailCode, branchIds: [branch] })).includes(groups[0]));
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

  await pool.query(`ALTER TABLE public.citas
    ADD COLUMN orden_integrante int, ADD COLUMN alias_integrante text DEFAULT 'Integrante aislado',
    ADD COLUMN id_persona_cliente uuid, ADD COLUMN id_cliente uuid,
    ADD COLUMN inicio_at timestamptz DEFAULT now(), ADD COLUMN fin_at timestamptz DEFAULT now(),
    ADD COLUMN atencion_iniciada_at timestamptz, ADD COLUMN atencion_finalizada_at timestamptz,
    ADD COLUMN retraso_inicio_min int, ADD COLUMN duracion_total_min int, ADD COLUMN buffer_total_min int,
    ADD COLUMN selection_type text, ADD COLUMN id_paquete uuid, ADD COLUMN total_pagar_hnl numeric,
    ADD COLUMN moneda_codigo text, ADD COLUMN asignada_automaticamente boolean, ADD COLUMN notas text;
    CREATE TABLE public.sucursales(id_sucursal uuid, nombre_sucursal text, deleted_at timestamptz, estado boolean);
    CREATE TABLE public.personas(id_persona uuid, nombres text, apellidos text, telefono_principal text);
    CREATE TABLE public.empleados(id_empleado uuid, id_persona uuid);
    CREATE TABLE public.correos(id_correo uuid, id_persona uuid, direccion_correo text, deleted_at timestamptz, es_principal boolean, verificado boolean);
    CREATE TABLE public.citas_detalles(id_cita_detalle uuid, id_cita uuid, id_servicio uuid);
    CREATE TABLE public.servicios(id_servicio uuid, nombre_servicio text);
    CREATE TABLE public.citas_holds(id_cita uuid, estado_hold_codigo text, expires_at timestamptz, created_at timestamptz);
    CREATE TABLE public.payment_intents(id_cita uuid, estado_intent_codigo text, expires_at timestamptz, created_at timestamptz);
    CREATE TABLE public.citas_reagendaciones(id_cita uuid, id_lote_reagendacion uuid, id_cita_causante uuid, retraso_min int, tipo_reagendacion_codigo text, created_at timestamptz, id_reagendacion uuid);`);
  const person = crypto.randomUUID(), otherBarber = crypto.randomUUID();
  await pool.query("INSERT INTO public.sucursales VALUES ($1,'Sucursal autorizada',NULL,true),($2,'Otra sucursal',NULL,true)", [branch, otherBranch]);
  await pool.query("INSERT INTO public.personas VALUES ($1,'Persona','aislada','00000000')", [person]);
  await pool.query("INSERT INTO public.empleados VALUES ($1,$3),($2,$3)", [barber, otherBarber, person]);
  await pool.query("UPDATE public.citas SET id_persona_cliente=$1", [person]);
  await pool.query(`INSERT INTO public.citas(id_cita,id_grupo_cita,id_sucursal,id_empleado_barbero,id_persona_cliente,estado_cita_codigo)
    VALUES ($1,$3,$4,$6,$7,'completada'),($2,$3,$5,$6,$7,'completada'),($8,$3,$4,$9,$7,'confirmada')`,
  [crypto.randomUUID(),crypto.randomUUID(),collision[0],branch,otherBranch,barber,person,crypto.randomUUID(),otherBarber]);
  const snapshot = async () => (await pool.query("SELECT id_cita,estado_cita_codigo FROM public.citas ORDER BY id_cita")).rows;
  const before = await snapshot();
  for (const role of ['admin','barbero']) {
    const app = Fastify();
    app.decorate('db', { query(sql, params) {
      assert.match(typeof sql === 'string' ? sql.trim() : sql.text.trim(), /^(SELECT|WITH)\b/i);
      return pool.query(sql, params);
    } });
    app.decorate('requireRoles', () => async (request) => { request.claims = { roles:[role],branch_ids:[branch],empleado_id:barber }; });
    await app.register(adminCitasRoutes, { prefix:'/v1/admin/citas' });
    try {
      const response = await app.inject({url:`/v1/admin/citas/reservas/buscar?codigo=${collision[2]}`});
      assert.equal(response.statusCode,200,response.body);
      const result=response.json().data.reservas;
      assert.ok(result.some(group=>group.id_grupo_cita===collision[0]) && result.some(group=>group.id_grupo_cita===collision[1]));
      for(const group of result) for(const cita of group.citas) {
        assert.equal(cita.id_grupo_cita,group.id_grupo_cita);
        assert.equal(cita.id_sucursal,branch);
        if(role==='barbero') assert.equal(cita.id_empleado_barbero,barber);
      }
      assert.ok(result.flatMap(group=>group.citas).some(cita=>cita.estado_cita_codigo==='completada'));
    } finally { await app.close(); }
  }
  assert.deepEqual(await snapshot(),before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM public.payment_intents')).rows[0].n,0);
});
