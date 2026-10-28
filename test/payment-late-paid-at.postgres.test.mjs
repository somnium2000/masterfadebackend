import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { openSync, closeSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { reconcilePixelPayFromDurableApproval } from "../src/routes/v1/public/pagos.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const migrationUrl = new URL("../db/migrations/pixel/20261011213325_payment_late_uses_paid_at_v1.sql", import.meta.url);
const baselineUrl = new URL("./sql/payments/qa_payment_triggers_20261011.sql", import.meta.url);
const RUN = process.env.RUN_PAYMENT_LATE_PG_INTEGRATION === "true";
const INTENT = "9b1626eb-0c04-4ce3-ae93-5296ddcb02fe";
const GROUP = "1cc40753-b888-4452-82b5-8e384d590fbc";
const CITA = "05f53173-ab1a-4b35-8a70-88f2f40d22f2";
const HOLD = "1dcc3717-bec0-4b31-be58-20f0821c947a";
const PERSON = "11111111-1111-4111-8111-111111111111";
const BARBER = "9f7192ec-f8ee-41be-91c4-b0f4024e63a2";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const UUID = "S-a2f5612c-5084-4134-ad5f-feeb0ae6d8c8";
const TX = "1f694eee-4715-45b8-a545-000000000000";
const PAID_AT = "2026-10-11T19:43:29.880935Z";
const EXPIRY = "2026-10-11T19:48:29.071048Z";
const EMAIL = "qa-regression@example.invalid";

function functionSql(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `Funcion real ausente: ${name}`);
  const section = source.slice(start);
  const tag = section.match(/AS (\$[a-z_]+\$)/i)?.[1];
  assert.ok(tag);
  return section.slice(0, section.indexOf(`${tag};`, section.indexOf(`AS ${tag}`) + tag.length + 3) + tag.length + 1);
}

test("migration late payment conserva definicion QA salvo reloj y condicion legacy", async () => {
  const baseline = functionSql(await readFile(baselineUrl, "utf8"), "public.fn_trg_validar_pago_monto_tiempo");
  const migration = await readFile(migrationUrl, "utf8");
  const expected = baseline.replace("  v_hold_estado text;", "  v_hold_estado text;\n  v_payment_time timestamptz;")
    .replace("  NEW.pago_tardio := false;", "  -- AM: paid_at explicito representa el instante del pago, no el de reconciliacion.\n  v_payment_time := COALESCE(NEW.paid_at, now());\n  NEW.pago_tardio := false;")
    .replaceAll("now() >", "v_payment_time >")
    .replace("IF v_hold_estado IS NOT NULL AND v_hold_estado <> 'activo' THEN",
      "IF NEW.paid_at IS NULL AND v_hold_estado IS NOT NULL AND v_hold_estado <> 'activo' THEN");
  assert.equal(functionSql(migration, "public.fn_trg_validar_pago_monto_tiempo").replaceAll("\r", ""), expected.replaceAll("\r", ""));
  assert.doesNotMatch(migration, /DROP TRIGGER|CREATE TRIGGER|UPDATE public\.payments|SECURITY DEFINER|GRANT|>=/i);
  assert.match(migration, /PAYMENT_LATE_TRIGGER_REQUIRED/);
});

function runBinary(binDir, name, args, outputFile) {
  const executable = path.join(binDir, process.platform === "win32" ? `${name}.exe` : name);
  const output = outputFile ? openSync(outputFile, "w") : null;
  let result;
  try {
    result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30000,
      stdio: output === null ? ["ignore", "pipe", "pipe"] : ["ignore", output, output] });
  } finally { if (output !== null) closeSync(output); }
  const diagnostic = outputFile ? readFileSync(outputFile, "utf8") : result.stderr || result.stdout;
  assert.equal(result.status, 0, `${name} (exit=${result.status}, signal=${result.signal}): ${result.error?.message || diagnostic}`);
  return (result.stdout || "").trim();
}

async function cleanupPreservingError(stop, primaryError) {
  try { await stop(); }
  catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    primaryError.cleanupError = cleanupError;
    primaryError.message += `\nCleanup failed: ${cleanupError.message}`;
  }
}

async function startIsolatedPostgres({ serverOptions = [] } = {}) {
  const configured = process.env.MASTERFADE_TEST_PG_BIN;
  const detected = spawnSync("pg_config", ["--bindir"], { encoding: "utf8", windowsHide: true });
  const binDir = configured || (detected.status === 0 ? detected.stdout.trim() : "C:/Program Files/PostgreSQL/17/bin");
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-late-payment-pg-"));
  const dataDir = path.join(directory, "data");
  const serverLog = path.join(directory, "postgres.log");
  const startLog = path.join(directory, "pg_ctl-start.log");
  let client;
  let cleaned = false;
  const stop = async () => {
    if (cleaned) return;
    const errors = [];
    if (client) {
      try { await client.end(); } catch (error) { errors.push(error); }
      client = null;
    }
    // A failed/timed-out start may still have launched our server. Never stop without its PID file.
    let pid;
    try { pid = await readFile(path.join(dataDir, "postmaster.pid"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (pid) {
      const lines = pid.split(/\r?\n/);
      assert.match(lines[0], /^[1-9]\d*$/);
      assert.equal(path.resolve(lines[1]), path.resolve(dataDir));
      runBinary(binDir, "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], path.join(directory, "pg_ctl-stop.log"));
    }
    if (errors.length) throw new AggregateError(errors, "PostgreSQL client cleanup failed");
    // AM: Borrar solo el directorio exclusivo creado por mkdtemp, nunca un cluster existente.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("masterfade-late-payment-pg-"));
    await rm(directory, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    runBinary(binDir, "initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    // Only this private cluster is configured. TCP-only avoids Ubuntu's shared Unix socket directory.
    await appendFile(path.join(dataDir, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
    const startArgs = ["-D", dataDir, "-l", serverLog, "-t", "20", "-w", "start"];
    if (serverOptions.length) startArgs.push("-o", serverOptions.join(" "));
    runBinary(binDir, "pg_ctl", startArgs, startLog);
    // AM: No leer DATABASE_URL/PGHOST/credenciales: siempre el cluster temporal propio.
    client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "", database: "postgres", ssl: false,
      connectionTimeoutMillis: 5000, query_timeout: 10000 });
    await client.connect();
    const actual = (await client.query("SHOW data_directory")).rows[0].data_directory;
    assert.equal(path.resolve(actual), path.resolve(dataDir));
    assert.equal((await client.query("SHOW listen_addresses")).rows[0].listen_addresses, "127.0.0.1");
    assert.equal((await client.query("SHOW unix_socket_directories")).rows[0].unix_socket_directories, "");
    return { client, stop };
  } catch (error) {
    for (const log of [startLog, serverLog]) {
      try { error.message += `\n${path.basename(log)}:\n${await readFile(log, "utf8")}`; }
      catch (logError) { if (logError.code !== "ENOENT") error.message += `\nCould not read ${path.basename(log)}: ${logError.message}`; }
    }
    await cleanupPreservingError(stop, error);
    throw error;
  }
}

test("cleanup conserva el error primario y adjunta el fallo secundario", async () => {
  const primary = new Error("primary startup failure");
  const secondary = new Error("secondary cleanup failure");
  await cleanupPreservingError(async () => { throw secondary; }, primary);
  assert.equal(primary.cleanupError, secondary);
  assert.match(primary.message, /^primary startup failure/);
  assert.match(primary.message, /secondary cleanup failure/);
  await assert.rejects(cleanupPreservingError(async () => { throw secondary; }), error => error === secondary);
});

test("PostgreSQL real: fallo de arranque conserva diagnostico sin stop inexistente", { skip: !RUN }, async () => {
  await assert.rejects(startIsolatedPostgres({ serverOptions: ["-c", "port=not-a-port"] }), error => {
    assert.match(error.message, /pg_ctl.*exit=/);
    assert.match(error.message, /not-a-port/);
    assert.doesNotMatch(error.message, /PID file.*does not exist|Cleanup failed/);
    return true;
  });
});

async function seed(client, { paidAt = PAID_AT, intentExpiry = EXPIRY, holdExpiry = EXPIRY,
  holdState = "expirado", intentState = "pendiente_confirmacion", citaState = "expirada" } = {}) {
  await client.query("INSERT INTO public.personas(id_persona) VALUES ($1)", [PERSON]);
  await client.query("INSERT INTO public.correos(id_persona,direccion_correo) VALUES ($1,$2)", [PERSON, EMAIL]);
  await client.query("INSERT INTO public.citas_grupos(id_grupo_cita,id_persona_titular,total_hnl,estado_grupo_codigo) VALUES ($1,$2,1,'cancelado')", [GROUP, PERSON]);
  await client.query(`INSERT INTO public.citas(id_cita,id_grupo_cita,id_sucursal,id_empleado_barbero,inicio_at,fin_at,
    estado_cita_codigo,orden_integrante,total_pagar_hnl,subtotal_servicios_hnl,id_persona_cliente,contacto_email)
    VALUES ($1,$2,$3,$4,'2026-10-12 08:00:00-06','2026-10-12 08:15:00-06',$5,1,1,1,$3,$6)`, [CITA, GROUP, PERSON, BARBER, citaState, EMAIL]);
  await client.query("INSERT INTO public.citas_holds(id_hold,id_cita,expires_at,estado_hold_codigo) VALUES ($1,$2,$3,$4)", [HOLD, CITA, holdExpiry, holdState]);
  await client.query("INSERT INTO public.payment_providers(id_provider,codigo) VALUES ($1,'pixelpay')", [PROVIDER]);
  await client.query(`INSERT INTO public.payment_intents(id_intent,id_cita,id_hold,id_grupo_cita,id_provider,monto_hnl,
    moneda_codigo,expires_at,estado_intent_codigo,provider_session_id,referencia_externa)
    VALUES ($1,$2,$3,$4,$5,1,'HNL',$6,$7,$8,$9)`, [INTENT, CITA, HOLD, GROUP, PROVIDER, intentExpiry, intentState, UUID, TX]);
  return paidAt;
}

async function insertPayment(client, paidAt, amount = 1, currency = "HNL") {
  return client.query(`INSERT INTO public.payments(id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at)
    VALUES ($1,'capturado',$2,$3,$4,$5) RETURNING pago_tardio,paid_at::text`, [INTENT, UUID, amount, currency, paidAt]);
}

test("PostgreSQL real: tr_pay_validar, tr_pay_aplicar y recovery durable en cluster aislado", { skip: !RUN }, async (t) => {
  const isolated = await startIsolatedPostgres();
  const { client } = isolated;
  let primaryError;
  try {
    const historical = await readFile(new URL("../db/migrations/pixel/20260924010000_pixelpay_reconciliation_window.sql", import.meta.url), "utf8");
    await client.query(await readFile(new URL("./sql/microfase2a2/pre_2a2_schema.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("./sql/payments/late_payment_support.sql", import.meta.url), "utf8"));
    await client.query(await readFile(baselineUrl, "utf8"));
    await client.query(functionSql(historical, "public.fn_payment_intents_capture_paid_at"));
    await client.query(`CREATE TRIGGER tr_payment_intents_capture_paid_at BEFORE INSERT OR UPDATE OF estado_intent_codigo,paid_at
      ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.fn_payment_intents_capture_paid_at()`);
    await t.test("baseline QA reproduce pago pre-expiry marcado tardio por reconciliacion posterior", async () => {
      await client.query("BEGIN");
      try {
        await seed(client);
        assert.equal((await insertPayment(client, PAID_AT)).rows[0].pago_tardio, true);
        assert.equal((await client.query("SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1", [INTENT])).rows[0].estado_intent_codigo, "expirado");
      } finally { await client.query("ROLLBACK"); }
    });
    const before = await client.query("SELECT oid,proowner,proacl,prosecdef,proconfig,provolatile,proparallel FROM pg_proc WHERE oid='public.fn_trg_validar_pago_monto_tiempo()'::regprocedure");
    const triggerBefore = await client.query("SELECT oid,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgname='tr_pay_validar'");
    await client.query(await readFile(migrationUrl, "utf8"));
    await client.query(await readFile(migrationUrl, "utf8"));
    const after = await client.query("SELECT oid,proowner,proacl,prosecdef,proconfig,provolatile,proparallel FROM pg_proc WHERE oid='public.fn_trg_validar_pago_monto_tiempo()'::regprocedure");
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual((await client.query("SELECT oid,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgname='tr_pay_validar'")).rows, triggerBefore.rows);
    const clock = (await client.query("SELECT (now()-interval '1 hour')::text past,(now()+interval '1 hour')::text future")).rows[0];
    for (const [name, options, expected] of [
      ["A reconciliacion posterior", {}, false],
      ["B pago realmente tardio", { paidAt: "2026-10-11T19:48:29.071049Z" }, true],
      ["C exactamente en expiry", { paidAt: EXPIRY }, false],
      ["D NULL vigente", { paidAt: null, intentExpiry: clock.future, holdExpiry: clock.future, holdState: "activo" }, false],
      ["E NULL expirado", { paidAt: null, intentExpiry: clock.past, holdExpiry: clock.past }, true],
      ["F NULL hold no activo", { paidAt: null, intentExpiry: clock.future, holdExpiry: clock.future, holdState: "consumido" }, true],
      ["G paid_at valido hold expirado", {}, false],
      ["H despues hold, antes intent", { paidAt: "2026-10-11T19:48:29.071049Z", intentExpiry: clock.future }, true],
      ["I despues intent, antes hold", { paidAt: "2026-10-11T19:48:29.071049Z", holdExpiry: clock.future }, true],
      ["caso real QA microsegundos", {}, false],
    ]) {
      await t.test(name, async () => {
        await client.query("BEGIN");
        try {
          const paidAt = await seed(client, options);
          const payment = (await insertPayment(client, paidAt)).rows[0];
          assert.equal(payment.pago_tardio, expected);
          assert.equal((await client.query("SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1", [INTENT])).rows[0].estado_intent_codigo,
            expected ? "expirado" : "confirmado");
          await client.query("UPDATE payments SET updated_at=now() WHERE id_intent=$1", [INTENT]);
          // AM: Legacy NULL + hold consumido por tr_pay_aplicar sigue siendo tardio al UPDATE.
          const expectedOnUpdate = expected || (paidAt === null && options.holdState === "activo");
          assert.equal((await client.query("SELECT pago_tardio FROM payments WHERE id_intent=$1", [INTENT])).rows[0].pago_tardio, expectedOnUpdate);
        } finally { await client.query("ROLLBACK"); }
      });
    }
    for (const [name, amount, currency, message] of [
      ["monto", 2, "HNL", "MONTO_PAGO_NO_COINCIDE_CON_INTENT"],
      ["moneda", 1, "USD", "MONEDA_PAGO_NO_COINCIDE_CON_INTENT"],
    ]) {
      await t.test(`validacion ${name} intacta`, async () => {
        await client.query("BEGIN");
        try { await seed(client); await assert.rejects(insertPayment(client, PAID_AT, amount, currency), { message }); }
        finally { await client.query("ROLLBACK"); }
      });
    }
    await t.test("intent inexistente conserva error original", async () => {
      await client.query("BEGIN");
      try { await assert.rejects(insertPayment(client, PAID_AT), { message: "INTENT_INEXISTENTE" }); }
      finally { await client.query("ROLLBACK"); }
    });
    await client.query(functionSql(historical, "app_private.confirmar_reserva_pagada_v1"));
    await client.query(await readFile(new URL("../db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql", import.meta.url), "utf8"));
    await t.test("recovery completo con triggers reales, evidencia durable y RPC intacta", async () => {
      await seed(client);
      await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,finalized_at,outcome,
        sdk_response_class,upstream_http_status,uncertain,response_success,response_approved,response_incomplete,
        transaction_result_valid,transaction_result_parsed,payment_uuid_present,transaction_id_present,payment_hash_present,
        payment_hash_valid,transaction_amount_matches,approved_amount_matches,amount_matches)
        VALUES ($1,gen_random_uuid(),$2,'approved','SuccessResponse',200,false,true,true,false,true,true,true,true,true,true,true,true,true)`, [INTENT, PAID_AT]);
      const previousProvider = PaymentProviderFactory._instance;
      const provider = { saleCalls: 0, statusCalls: 0,
        async sale() { this.saleCalls++; throw new Error("Sale prohibida"); },
        async queryPaymentStatus() { this.statusCalls++; throw new Error("Status prohibido"); },
      };
      PaymentProviderFactory._instance = provider;
      try {
        const result = await reconcilePixelPayFromDurableApproval(client, { idGrupoCita: GROUP, idIntent: INTENT, titularEmail: EMAIL });
        assert.equal(result.booking_confirmed, true);
        const actual = (await client.query(`SELECT p.provider_tx_id,p.estado_pago_codigo,p.pago_tardio,
          p.paid_at=$2::timestamptz payment_time_matches,i.paid_at=$2::timestamptz intent_time_matches,
          i.estado_intent_codigo,h.estado_hold_codigo,c.estado_cita_codigo,g.estado_grupo_codigo
          FROM payments p JOIN payment_intents i USING(id_intent) JOIN citas_holds h ON h.id_hold=i.id_hold
          JOIN citas c ON c.id_cita=i.id_cita JOIN citas_grupos g ON g.id_grupo_cita=i.id_grupo_cita
          WHERE i.id_intent=$1`, [INTENT, PAID_AT])).rows[0];
        assert.deepEqual(actual, { provider_tx_id: UUID, estado_pago_codigo: "capturado", pago_tardio: false,
          payment_time_matches: true, intent_time_matches: true, estado_intent_codigo: "confirmado",
          estado_hold_codigo: "consumido", estado_cita_codigo: "confirmada", estado_grupo_codigo: "activo" });
        assert.equal((await reconcilePixelPayFromDurableApproval(client, { idGrupoCita: GROUP, idIntent: INTENT, titularEmail: EMAIL })).duplicate, true);
        assert.equal((await client.query("SELECT count(*)::int count FROM payments WHERE id_intent=$1", [INTENT])).rows[0].count, 1);
        assert.equal(provider.saleCalls, 0);
        assert.equal(provider.statusCalls, 0);
      } finally { PaymentProviderFactory._instance = previousProvider; }
    });
  } catch (error) { primaryError = error; throw error; }
  finally { await cleanupPreservingError(isolated.stop, primaryError); }
});
