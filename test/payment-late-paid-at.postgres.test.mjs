import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { openSync, closeSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import Fastify from "fastify";
import paymentRecoveryRoutes from "../src/routes/v1/paymentRecovery.js";
import { installPrivatePilot } from "./helpers/privatePilotApp.mjs";
import { reconcilePixelPayFromDurableApproval, reconcilePixelPayPaid } from "../src/routes/v1/public/pagos.js";
import { loadDurablePixelPayApproval } from "../src/services/payments/pixelPayDurableApproval.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const migrationUrl = new URL("../db/migrations/pixel/20261011213325_payment_late_uses_paid_at_v1.sql", import.meta.url);
const baselineUrl = new URL("./sql/payments/qa_payment_triggers_20261011.sql", import.meta.url);
const RUN = process.env.RUN_PAYMENT_LATE_PG_INTEGRATION === "true";
const RUN_FINANCIAL_CONTRACT = process.env.RUN_FINANCIAL_CONTRACT_PG === "true";
const financialContractUrl = new URL("../db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql", import.meta.url);
const INTENT = "9b1626eb-0c04-4ce3-ae93-5296ddcb02fe";
const GROUP = "1cc40753-b888-4452-82b5-8e384d590fbc";
const CITA = "05f53173-ab1a-4b35-8a70-88f2f40d22f2";
const HOLD = "1dcc3717-bec0-4b31-be58-20f0821c947a";
const PERSON = "11111111-1111-4111-8111-111111111111";
const BARBER = "9f7192ec-f8ee-41be-91c4-b0f4024e63a2";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const OTHER_PROVIDER = "33333333-3333-4333-8333-333333333333";
const OTHER_INTENT = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_INTENT = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID = "S-a2f5612c-5084-4134-ad5f-feeb0ae6d8c8";
const TX = "1f694eee-4715-45b8-a545-000000000000";
const PAID_AT = "2026-10-11T19:43:29.880935Z";
const FINALIZED_AT = "2026-10-11T19:43:28.123456Z";
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
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

async function seedDurableSale(client) {
  const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,finalized_at,outcome,
    sdk_response_class,upstream_http_status,uncertain,response_success,response_approved,response_incomplete,
    transaction_result_valid,transaction_result_parsed,payment_uuid_present,transaction_id_present,payment_hash_present,
    payment_hash_valid,transaction_amount_matches,approved_amount_matches,amount_matches)
    VALUES ($1,$2,$3,'approved','SuccessResponse',200,false,true,true,false,true,true,true,true,true,true,true,true,true)`,
  [INTENT, attemptId, FINALIZED_AT]);
  await client.query(`INSERT INTO public.payment_events
    (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
    VALUES ($1,$2,'pixelpay.sale.approved_verified',TRUE,$3,$4,$5)`, [PROVIDER, `pixelpay_sale_${attemptId}`, {
    payment_attempt_id: attemptId, payment_uuid: UUID, transaction_id: TX, amount: 1, currency: "HNL",
    payment_hash_valid: true, amount_matches: true,
  }, INTENT, PAID_AT]);
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
      await seedDurableSale(client);
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

test("PostgreSQL 17: recovery usa recibido_at exacto con contrato financiero vigente", {
  skip: !RUN_FINANCIAL_CONTRACT,
}, async (t) => {
  const isolated = await startIsolatedPostgres();
  const { client } = isolated;
  const previousProvider = PaymentProviderFactory._instance;
  const provider = { saleCalls: 0, statusCalls: 0,
    async sale() { this.saleCalls++; throw new Error("Sale prohibida"); },
    async queryPaymentStatus() { this.statusCalls++; throw new Error("Status prohibido"); },
  };
  PaymentProviderFactory._instance = provider;
  let primaryError;
  try {
    const historical = await readFile(new URL("../db/migrations/pixel/20260924010000_pixelpay_reconciliation_window.sql", import.meta.url), "utf8");
    await client.query(await readFile(new URL("./sql/microfase2a2/pre_2a2_schema.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("./sql/payments/late_payment_support.sql", import.meta.url), "utf8"));
    await client.query(await readFile(baselineUrl, "utf8"));
    await client.query(functionSql(historical, "public.fn_payment_intents_capture_paid_at"));
    await client.query(`CREATE TRIGGER tr_payment_intents_capture_paid_at BEFORE INSERT OR UPDATE OF estado_intent_codigo,paid_at
      ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.fn_payment_intents_capture_paid_at()`);
    await client.query(functionSql(historical, "app_private.confirmar_reserva_pagada_v1"));
    await client.query(await readFile(new URL("../db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql", import.meta.url), "utf8"));
    await client.query(await readFile(financialContractUrl, "utf8"));
    const reset = async (options = {}) => {
      // AM: Solo fixtures del cluster temporal; ninguna conexion externa ni dato historico.
      await client.query(`TRUNCATE public.payment_events,app_private.pixelpay_sale_attempts,public.payments,
        public.payment_intents,public.citas_holds,public.citas,public.citas_grupos,public.correos,
        public.personas,public.payment_providers CASCADE`);
      await seed(client, options);
      if (options.holdState === "activo") await client.query("UPDATE public.citas_grupos SET estado_grupo_codigo='activo'");
      await seedDurableSale(client);
    };
    const recover = (connection = client) => reconcilePixelPayFromDurableApproval(connection, {
      idGrupoCita: GROUP, idIntent: INTENT, titularEmail: EMAIL,
    });
    const assertConfirmedOnce = async () => {
      const state = (await client.query(`SELECT p.paid_at=$2::timestamptz exact_payment_time,
        i.paid_at=$2::timestamptz exact_intent_time, p.paid_at<>a.finalized_at distinct_from_final,
        p.paid_at::text paid_at, p.pago_tardio, i.estado_intent_codigo,h.estado_hold_codigo,c.estado_cita_codigo
        FROM public.payments p JOIN public.payment_intents i USING(id_intent)
        JOIN app_private.pixelpay_sale_attempts a USING(id_intent)
        JOIN public.citas_holds h ON h.id_hold=i.id_hold JOIN public.citas c ON c.id_cita=i.id_cita
        WHERE i.id_intent=$1`, [INTENT, PAID_AT])).rows;
      assert.equal(state.length, 1);
      assert.deepEqual(state[0], { exact_payment_time: true, exact_intent_time: true, distinct_from_final: true,
        paid_at: "2026-10-11 19:43:29.880935+00", pago_tardio: false,
        estado_intent_codigo: "confirmado", estado_hold_codigo: "consumido", estado_cita_codigo: "confirmada" });
      assert.equal((await recover()).duplicate, true);
      assert.equal((await client.query("SELECT count(*)::int count FROM public.payments")).rows[0].count, 1);
    };
    await t.test("aprobacion con hold vigente y duplicado preservan seis decimales", async () => {
      await reset({ intentExpiry: "2099-01-01", holdExpiry: "2099-01-01", holdState: "activo", citaState: "pendiente_pago" });
      assert.equal((await recover()).booking_confirmed, true);
      await assertConfirmedOnce();
    });
    await t.test("recuperacion tardia y duplicado conservan evidencia previa al vencimiento", async () => {
      await reset();
      assert.equal((await recover()).booking_confirmed, true);
      await assertConfirmedOnce();
    });
    await t.test("dos recuperaciones realmente concurrentes esperan el mismo lock y capturan una sola vez", async () => {
      await reset();
      const options = { host: "127.0.0.1", port: client.connectionParameters.port,
        user: "postgres", password: "", database: "postgres", ssl: false, query_timeout: 10000 };
      const peers = [new pg.Client(options), new pg.Client(options)];
      let outcomes;
      let pending;
      let lockHeld = false;
      try {
        await Promise.all(peers.map((peer) => peer.connect()));
        const pids = await Promise.all(peers.map(async (peer) => (await peer.query("SELECT pg_backend_pid() pid")).rows[0].pid));
        await client.query("BEGIN");
        lockHeld = true;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [`pixelpay-sale:${INTENT}`]);
        pending = Promise.allSettled(peers.map((peer) => recover(peer)));
        const deadline = Date.now() + 5000;
        let waiting = 0;
        do {
          waiting = (await client.query(`SELECT count(*)::int count FROM pg_locks
            WHERE locktype='advisory' AND NOT granted AND pid=ANY($1::int[])`, [pids])).rows[0].count;
          if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        } while (waiting < 2 && Date.now() < deadline);
        // AM: Probar solapamiento real, no solo invocar promesas que podrian serializarse.
        assert.equal(waiting, 2);
        await client.query("COMMIT");
        lockHeld = false;
        outcomes = await pending;
      } finally {
        if (lockHeld) await client.query("ROLLBACK");
        if (pending) await pending;
        await Promise.all(peers.map((peer) => peer.end()));
      }
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
      assert.equal(outcomes.filter((outcome) => outcome.value.duplicate === true).length, 1);
      assert.ok(outcomes.every((outcome) => outcome.value.booking_confirmed === true));
      await assertConfirmedOnce();
    });
    await t.test("segunda ruta valida paidAt contra evento, no finalized_at", async () => {
      await reset();
      await client.query("UPDATE public.citas_grupos SET estado_grupo_codigo='activo'");
      const reconcile = (paidAt) => reconcilePixelPayPaid(client, { idGrupoCita: GROUP, idIntent: INTENT,
        titularEmail: EMAIL, paymentUuid: UUID, providerTransactionId: TX, expectedAmount: 1,
        allowExpiredRecovery: true, paidAt });
      for (const wrong of [FINALIZED_AT, "2026-10-11T19:43:29.880934Z"]) {
        assert.equal((await reconcile(wrong)).manual_reconciliation_required, true);
        assert.equal((await client.query("SELECT count(*)::int count FROM public.payments")).rows[0].count, 0);
      }
      assert.equal((await reconcile("2026-10-11T13:43:29.880935-06:00")).booking_confirmed, true);
      await assertConfirmedOnce();
    });
    await t.test("rollback posterior al INSERT conserva evidencia y permite reintento local unico", async () => {
      await reset();
      let inserted = false;
      const failingClient = { async query(sql, ...args) {
        if (sql.includes("app_private.confirmar_reserva_pagada_v1")) {
          assert.equal(inserted, true);
          throw new Error("fixture fallo posterior al INSERT");
        }
        const result = await client.query(sql, ...args);
        if (sql.includes("INSERT INTO public.payments")) inserted = true;
        return result;
      } };
      await assert.rejects(recover(failingClient), /fixture fallo posterior al INSERT/);
      const state = (await client.query(`SELECT (SELECT count(*)::int FROM public.payments) payments,
        (SELECT count(*)::int FROM public.payment_events) events,
        (SELECT count(*)::int FROM app_private.pixelpay_sale_attempts) attempts,
        i.estado_intent_codigo,h.estado_hold_codigo,c.estado_cita_codigo
        FROM public.payment_intents i JOIN public.citas_holds h ON h.id_hold=i.id_hold
        JOIN public.citas c ON c.id_cita=i.id_cita`)).rows[0];
      assert.deepEqual(state, { payments: 0, events: 1, attempts: 1, estado_intent_codigo: "pendiente_confirmacion",
        estado_hold_codigo: "expirado", estado_cita_codigo: "expirada" });
      assert.equal((await recover()).booking_confirmed, true);
      await assertConfirmedOnce();
    });
    const invalidEvidence = [
      ["sin evento", "DELETE FROM public.payment_events"],
      ["firma no verificada", "UPDATE public.payment_events SET firma_valida=FALSE"],
      ["tipo incorrecto", "UPDATE public.payment_events SET evento_tipo='pixelpay.callback'"],
      ["identificador de evento incorrecto", "UPDATE public.payment_events SET provider_event_id='other'"],
      ["FINAL tardio por un microsegundo", "UPDATE app_private.pixelpay_sale_attempts SET finalized_at=$1::timestamptz+interval '1 microsecond'", [EXPIRY]],
      ["evento tardio por un microsegundo", "UPDATE public.payment_events SET recibido_at=$1::timestamptz+interval '1 microsecond'", [EXPIRY]],
      ["intent vencido antes del evento", "UPDATE public.payment_intents SET expires_at=$1::timestamptz-interval '1 microsecond'", [PAID_AT]],
      ...Object.entries({ payment_uuid: "other", transaction_id: "other", payment_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 2, currency: "USD", payment_hash_valid: false, amount_matches: false })
        .map(([key, value]) => [key, "UPDATE public.payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ [key]: value }]]),
      ["monto con tipo incorrecto", "UPDATE public.payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ amount: "1" }]],
      ["dos FINAL aprobados, uno sin evento", `INSERT INTO app_private.pixelpay_sale_attempts
        SELECT (jsonb_populate_record(NULL::app_private.pixelpay_sale_attempts,
          to_jsonb(a) || jsonb_build_object('id_sale_attempt',gen_random_uuid(),
            'payment_attempt_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))).*
        FROM app_private.pixelpay_sale_attempts a`],
    ];
    for (const [name, sql, params] of invalidEvidence) {
      await t.test(`rechaza ${name} sin escribir pagos`, async () => {
        await reset();
        await client.query(sql, params);
        assert.equal((await recover()).manual_reconciliation_required, true);
        assert.equal((await client.query("SELECT count(*)::int count FROM public.payments")).rows[0].count, 0);
      });
    }
    await t.test("rechaza eventos ambiguos y evento unico de otro intento no aprobado", async () => {
      await reset();
      await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id)
        VALUES ($1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`, [INTENT]);
      await client.query(`INSERT INTO public.payment_events
        (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
        VALUES ($1,'pixelpay_sale_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`, [PROVIDER, {
        payment_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", payment_uuid: UUID, transaction_id: TX,
        amount: 1, currency: "HNL", payment_hash_valid: true, amount_matches: true,
      }, INTENT, PAID_AT]);
      assert.equal((await recover()).manual_reconciliation_required, true);
      await client.query("DELETE FROM public.payment_events WHERE provider_event_id='pixelpay_sale_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
      assert.equal(await loadDurablePixelPayApproval(client, { idIntent: INTENT, groupRows: [{ expires_at: EXPIRY }] }), null);
      assert.equal((await recover()).manual_reconciliation_required, true);
      assert.equal((await client.query("SELECT count(*)::int count FROM public.payments")).rows[0].count, 0);
    });
    await t.test("HTTP con compras suspendidas recupera solo la reserva propia sin proveedor", async (sub) => {
      await reset();
      // AM: Ampliar solo el esquema sintetico local para el contexto de identidad autenticada.
      await client.query(`ALTER TABLE public.clientes ADD COLUMN anonimizado boolean NOT NULL DEFAULT false;
        ALTER TABLE public.usuarios ADD COLUMN estado_acceso text NOT NULL DEFAULT 'activo';
        CREATE TABLE app_private.solicitudes_eliminacion_cuenta
          (id_cliente uuid,id_usuario uuid,id_persona uuid,estado_codigo text);
        CREATE TABLE public.membership_purchase_orders (id_order uuid PRIMARY KEY,id_cliente uuid,id_usuario uuid);
        CREATE TABLE public.points_transactions (id_cliente uuid,puntos integer);
        CREATE FUNCTION public.fn_points_materialize_expired_cycles(uuid) RETURNS integer
          LANGUAGE sql AS 'SELECT 0';
        CREATE FUNCTION public.fn_points_get_effective_rule(uuid) RETURNS TABLE(puntos_para_premio integer)
          LANGUAGE sql AS 'SELECT 10'`);
      // AM: Puntos fuera de alcance: fixture al tope, sin canje ni ciclos; triggers financieros reales intactos.
      await client.query("INSERT INTO public.points_transactions VALUES($1,10)", [PERSON]);
      await client.query("INSERT INTO public.usuarios(id_usuario,id_persona) VALUES($1,$1)", [PERSON]);
      await client.query("INSERT INTO public.clientes(id_cliente,id_persona,id_usuario) VALUES($1,$1,$1)", [PERSON]);
      await client.query(`UPDATE public.citas_grupos SET id_cliente_titular=$1,id_usuario_titular=$1,
        origen_codigo='cliente_autenticado'`, [PERSON]);
      await client.query("UPDATE public.citas SET id_cliente=$1", [PERSON]);
      await client.query("UPDATE public.payment_intents SET created_by_usuario_id=$1", [PERSON]);
      const pool = new pg.Pool({ host: "127.0.0.1", port: client.connectionParameters.port,
        user: "postgres", password: "", database: "postgres", ssl: false });
      const app = Fastify();
      app.decorate("config", { paymentProvider: "pixelpay", adminDataEntryMode: false });
      app.decorate("db", pool);
      const session = await installPrivatePilot(app, sub, { userId: PERSON, clientId: PERSON, enabled: false });
      await app.register(paymentRecoveryRoutes, { prefix: "/v1/cliente/pagos" });
      const request = (method = "POST") => ({ method, url: `/v1/cliente/pagos/${INTENT}${method === "POST" ? "/conciliar" : ""}`,
        headers: session.headers, ...(method === "POST" ? { payload: {} } : {}) });
      try {
        assert.equal((await app.inject(request("GET"))).json().data.estado_intent_codigo, "pendiente_confirmacion");
        const recovered = await app.inject(request());
        assert.equal(recovered.statusCode, 200, recovered.body);
        assert.equal(recovered.json().data.booking_confirmed, true);
        assert.equal((await app.inject(request())).json().data.duplicate, true);
        const read = await app.inject(request("GET"));
        assert.equal(read.json().data.paid_at, "2026-10-11 19:43:29.880935+00");
        await assertConfirmedOnce();
        await client.query("BEGIN");
        try {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('masterfade.account_deletion'),hashtext($1::text))", [PERSON]);
          assert.equal((await app.inject(request())).statusCode, 409);
        } finally { await client.query("ROLLBACK"); }
        // AM: El creador de un intent publico puede ser del sistema; la titularidad exige los tres IDs.
        await client.query("UPDATE public.citas_grupos SET origen_codigo='publico'");
        await client.query("UPDATE public.payment_intents SET created_by_usuario_id=$1", [BARBER]);
        assert.equal((await app.inject(request())).json().data.duplicate, true);
        // AM: Un cambio de propietario posterior al precheck no puede superar el control bajo locks.
        await assert.rejects(reconcilePixelPayFromDurableApproval(client, {
          idGrupoCita: GROUP, idIntent: INTENT, titularEmail: EMAIL,
          owner: { clienteId: PERSON, personaId: PERSON, usuarioId: BARBER },
        }), { code: "PAYMENT_RECOVERY_ACCOUNT_UNAVAILABLE" });
        await client.query("UPDATE public.clientes SET anonimizado=TRUE");
        assert.equal((await app.inject(request())).statusCode, 403);
        assert.equal((await client.query("SELECT count(*)::int count FROM payments")).rows[0].count, 1);
      } finally { await app.close(); await pool.end(); }
    });
    assert.equal(provider.saleCalls, 0);
    assert.equal(provider.statusCalls, 0);
  } catch (error) { primaryError = error; throw error; }
  finally {
    PaymentProviderFactory._instance = previousProvider;
    await cleanupPreservingError(isolated.stop, primaryError);
  }
});

test("PostgreSQL 17: contrato financiero exige evidencia y deshabilita pagos manuales nuevos", {
  skip: !RUN_FINANCIAL_CONTRACT,
}, async () => {
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
    await client.query(await readFile(new URL("../db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql", import.meta.url), "utf8"));

    await seed(client, { intentExpiry: "2099-01-01T16:00:00.000Z", holdExpiry: "2099-01-01T16:00:00.000Z",
      holdState: "activo", intentState: "pendiente_confirmacion", citaState: "pendiente_pago" });
    await client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'manual_pagado','legacy-manual',1,'HNL',NULL,TRUE)`, [INTENT]);
    await client.query(`INSERT INTO public.payment_intents
      (id_intent,id_provider,id_membership_order,origen_pago_codigo,estado_intent_codigo,monto_hnl,moneda_codigo,
       referencia_externa,provider_session_id,expires_at,paid_at)
      SELECT ('70000000-0000-4000-8000-' || lpad(gs::text,12,'0'))::uuid,$1,gen_random_uuid(),
        'membership','confirmado',1,'HNL','legacy-tx-' || gs,'legacy-uuid-' || gs,$2,NULL
      FROM generate_series(1,7) gs`, [PROVIDER, EXPIRY]);

    await client.query(await readFile(financialContractUrl, "utf8"));
    assert.equal((await client.query(`SELECT count(*)::int count FROM public.payment_intents
      WHERE origen_pago_codigo='membership' AND estado_intent_codigo='confirmado' AND paid_at IS NULL`)).rows[0].count, 7);
    assert.equal((await client.query("SELECT count(*)::int count FROM public.payments WHERE provider_tx_id='legacy-manual'")).rows[0].count, 1);
    await client.query("DELETE FROM public.payments WHERE provider_tx_id='legacy-manual'");

    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'manual_pagado','new-manual',1,'HNL',$2,TRUE)`, [INTENT, PAID_AT]),
    /MF_MANUAL_PAYMENT_DISABLED/);
    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'capturado','missing-evidence',1,'HNL',NULL,FALSE)`, [INTENT]),
    /MF_PAYMENT_PAID_AT_REQUIRED/);

    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'capturado','arbitrary-timestamp',1,'HNL',$2,FALSE)`, [INTENT, PAID_AT]),
    /MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED/);
    await assert.rejects(client.query(`UPDATE public.payment_intents
      SET paid_at=$2 WHERE id_intent=$1`, [INTENT, PAID_AT]),
    /MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED/);

    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,finalized_at,outcome,
      sdk_response_class,upstream_http_status,uncertain,response_success,response_approved,response_incomplete,
      transaction_result_valid,transaction_result_parsed,payment_uuid_present,transaction_id_present,payment_hash_present,
      payment_hash_valid,transaction_amount_matches,approved_amount_matches,amount_matches)
      VALUES ($1,$2,$3,'approved','SuccessResponse',200,false,true,true,false,
        true,true,true,true,true,true,true,true,true)`, [INTENT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", FINALIZED_AT]);

    await client.query("INSERT INTO public.payment_providers(id_provider,codigo) VALUES ($1,'pixelpay-shadow')", [OTHER_PROVIDER]);
    await client.query(`INSERT INTO public.payment_intents(id_intent,id_cita,id_hold,id_grupo_cita,id_provider,monto_hnl,
      moneda_codigo,expires_at,estado_intent_codigo,provider_session_id,referencia_externa)
      SELECT $1,id_cita,id_hold,id_grupo_cita,id_provider,monto_hnl,moneda_codigo,expires_at,
        'creado',provider_session_id,referencia_externa FROM public.payment_intents WHERE id_intent=$2`, [OTHER_INTENT, INTENT]);

    const eventPayload = {
      payment_uuid: UUID, transaction_id: TX, amount: 1, currency: "HNL",
      payment_hash_valid: true, amount_matches: true,
      payment_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'wrong-provider','pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`,
    [OTHER_PROVIDER, eventPayload, INTENT, PAID_AT]);
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'wrong-intent','pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`,
    [PROVIDER, eventPayload, OTHER_INTENT, PAID_AT]);
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'false-evidence','pixelpay.sale.approved_verified',FALSE,$2,$3,$4)`,
    [PROVIDER, eventPayload, INTENT, PAID_AT]);
    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,created_at)
      VALUES ($1,$2,$3)`, [INTENT, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", FINALIZED_AT]);
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'pixelpay_sale_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`, [PROVIDER, {
      payment_uuid: UUID, transaction_id: TX, currency: "HNL",
      payment_hash_valid: true, amount_matches: true,
      payment_attempt_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }, INTENT, PAID_AT]);
    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'capturado','invalid-events',1,'HNL',$2,FALSE)`, [INTENT, PAID_AT]),
    /MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED/);

    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'pixelpay_sale_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`, [PROVIDER, eventPayload, INTENT, PAID_AT]);

    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'capturado',$3,1,'HNL',$2::timestamptz + interval '1 second',FALSE)`, [INTENT, PAID_AT, UUID]),
    /MF_PAYMENT_PAID_AT_EVIDENCE_MISMATCH/);

    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,finalized_at,outcome)
      VALUES ($1,$2,$3,'approved')`, [INTENT, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", FINALIZED_AT]);
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'pixelpay_sale_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'pixelpay.sale.approved_verified',TRUE,$2,$3,$4)`, [PROVIDER, {
      ...eventPayload, payment_attempt_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    }, INTENT, PAID_AT]);
    await assert.rejects(client.query(`INSERT INTO public.payments
      (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
      VALUES ($1,'capturado',$3,1,'HNL',$2,FALSE)`, [INTENT, PAID_AT, UUID]),
    /MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED/);
    await client.query("DELETE FROM public.payment_events WHERE provider_event_id='pixelpay_sale_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'");

    const evidenceDiagnostic = await client.query(`SELECT
      pe.id_provider=pi.id_provider provider_matches,
      pe.provider_event_id=('pixelpay_sale_' || (pe.payload_esencial->>'payment_attempt_id')) event_id_matches,
      (pe.payload_esencial->>'payment_uuid')=pi.provider_session_id uuid_matches,
      (pe.payload_esencial->>'transaction_id')=pi.referencia_externa transaction_matches,
      a.id_intent=pe.id_intent attempt_matches
      FROM public.payment_events pe
      JOIN public.payment_intents pi ON pi.id_intent=$1
      JOIN app_private.pixelpay_sale_attempts a
        ON a.payment_attempt_id::text=pe.payload_esencial->>'payment_attempt_id'
      WHERE pe.provider_event_id LIKE 'pixelpay_sale_%'`, [INTENT]);
    assert.ok(evidenceDiagnostic.rows.some((row) => Object.values(row).every(Boolean)),
      JSON.stringify(evidenceDiagnostic.rows));
    const canonicalEvidence = await client.query(`SELECT count(*)::int count,min(pe.recibido_at)::text paid_at
      FROM public.payment_events pe
      JOIN app_private.pixelpay_sale_attempts a ON a.id_intent=pe.id_intent
       AND a.payment_attempt_id::text=(pe.payload_esencial->>'payment_attempt_id')
      JOIN public.payment_intents pi ON pi.id_intent=pe.id_intent
      WHERE pe.id_intent=$1 AND pe.id_provider=pi.id_provider
       AND pe.evento_tipo='pixelpay.sale.approved_verified' AND pe.firma_valida IS TRUE
       AND pe.provider_event_id='pixelpay_sale_' || (pe.payload_esencial->>'payment_attempt_id')
       AND (pe.payload_esencial->>'payment_uuid')=pi.provider_session_id
       AND (pe.payload_esencial->>'transaction_id')=pi.referencia_externa
       AND CASE WHEN jsonb_typeof(pe.payload_esencial->'amount')='number'
         THEN (pe.payload_esencial->>'amount')::numeric END=pi.monto_hnl
       AND upper(pe.payload_esencial->>'currency')=upper(pi.moneda_codigo)
       AND (pe.payload_esencial->>'payment_hash_valid')='true'
       AND (pe.payload_esencial->>'amount_matches')='true'`, [INTENT]);
    assert.equal(canonicalEvidence.rows[0].count, 1);
    assert.equal(new Date(canonicalEvidence.rows[0].paid_at).toISOString(), new Date(PAID_AT).toISOString());

    let payment;
    try {
      payment = await client.query(`INSERT INTO public.payments
        (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
        VALUES ($1,'capturado',$3,1,'HNL',$2,FALSE)
        RETURNING paid_at::text,pago_tardio`, [INTENT, PAID_AT, UUID]);
    } catch (error) {
      error.message += `\n${error.where || "no-context"}`;
      throw error;
    }
    assert.equal(new Date(payment.rows[0].paid_at).toISOString(), new Date(PAID_AT).toISOString());
    assert.equal(payment.rows[0].pago_tardio, false);
    const applied = (await client.query(`SELECT i.estado_intent_codigo,i.paid_at::text,h.estado_hold_codigo,c.estado_cita_codigo
      FROM public.payment_intents i JOIN public.citas_holds h ON h.id_hold=i.id_hold
      JOIN public.citas c ON c.id_cita=i.id_cita WHERE i.id_intent=$1`, [INTENT])).rows[0];
    assert.equal(applied.estado_intent_codigo, "confirmado");
    assert.equal(new Date(applied.paid_at).toISOString(), new Date(PAID_AT).toISOString());
    assert.equal(applied.estado_hold_codigo, "consumido");
    assert.equal(applied.estado_cita_codigo, "confirmada");

    await client.query(`CREATE TABLE public.membership_purchase_orders (
      id_order uuid PRIMARY KEY, estado_orden_codigo text NOT NULL, paid_at timestamptz
    );
    CREATE TABLE public.subscriptions (
      id_suscripcion uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_intent uuid NOT NULL UNIQUE
    );
    CREATE TABLE public.subscription_benefits (
      id_benefit uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_suscripcion uuid NOT NULL UNIQUE
    );`);
    await client.query(`INSERT INTO public.membership_purchase_orders(id_order,estado_orden_codigo)
      VALUES ($1,'pendiente_pago')`, [MEMBERSHIP_ORDER]);
    await client.query(`INSERT INTO public.payment_intents
      (id_intent,id_provider,id_membership_order,origen_pago_codigo,estado_intent_codigo,monto_hnl,moneda_codigo,
       referencia_externa,provider_session_id,expires_at)
      VALUES ($1,$2,$3,'membership','pendiente_confirmacion',1,'HNL',$4,$5,$6)`,
    [MEMBERSHIP_INTENT, PROVIDER, MEMBERSHIP_ORDER, TX, `${UUID}-membership`, EXPIRY]);
    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,created_at)
      VALUES ($1,$2,$3)`, [MEMBERSHIP_INTENT, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", FINALIZED_AT]);
    await client.query(`INSERT INTO public.payment_events
      (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
      VALUES ($1,'pixelpay_membership_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'membership.pixelpay.approved_verified',TRUE,$2,$3,$4)`, [PROVIDER, {
      provider: "pixelpay", id_intent: MEMBERSHIP_INTENT, id_order: MEMBERSHIP_ORDER,
      payment_uuid: `${UUID}-membership`, transaction_id: TX, amount: 1, currency: "HNL",
      payment_hash_valid: true, amount_matches: true,
      payment_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }, MEMBERSHIP_INTENT, PAID_AT]);
    const activateMembership = async () => {
      await client.query("BEGIN");
      try {
        await client.query(`UPDATE public.payment_intents
          SET estado_intent_codigo='confirmado',paid_at=$2 WHERE id_intent=$1`, [MEMBERSHIP_INTENT, PAID_AT]);
        await client.query(`INSERT INTO public.payments
          (id_intent,estado_pago_codigo,provider_tx_id,monto_hnl,moneda_codigo,paid_at,registrado_manualmente)
          VALUES ($1,'capturado',$2,1,'HNL',$3,FALSE)
          ON CONFLICT(provider_tx_id) DO UPDATE SET updated_at=now()
          WHERE public.payments.id_intent=EXCLUDED.id_intent`,
        [MEMBERSHIP_INTENT, `${UUID}-membership`, PAID_AT]);
        const subscription = await client.query(`INSERT INTO public.subscriptions(id_intent) VALUES ($1)
          ON CONFLICT(id_intent) DO UPDATE SET id_intent=EXCLUDED.id_intent RETURNING id_suscripcion`,
        [MEMBERSHIP_INTENT]);
        await client.query(`INSERT INTO public.subscription_benefits(id_suscripcion) VALUES ($1)
          ON CONFLICT(id_suscripcion) DO NOTHING`, [subscription.rows[0].id_suscripcion]);
        await client.query(`UPDATE public.membership_purchase_orders
          SET estado_orden_codigo='pagada',paid_at=$2 WHERE id_order=$1`, [MEMBERSHIP_ORDER, PAID_AT]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };
    await activateMembership();
    await activateMembership();
    const membershipCounts = (await client.query(`SELECT
      (SELECT count(*)::int FROM public.payments WHERE id_intent=$1) payments,
      (SELECT count(*)::int FROM public.subscriptions WHERE id_intent=$1) subscriptions,
      (SELECT count(*)::int FROM public.subscription_benefits sb JOIN public.subscriptions s USING(id_suscripcion)
        WHERE s.id_intent=$1) benefits`, [MEMBERSHIP_INTENT])).rows[0];
    assert.deepEqual(membershipCounts, { payments: 1, subscriptions: 1, benefits: 1 });
    const membershipTimes = (await client.query(`SELECT pi.origen_pago_codigo,pi.paid_at::text intent_paid_at,
      p.paid_at::text payment_paid_at,mpo.paid_at::text order_paid_at
      FROM public.payment_intents pi JOIN public.payments p USING(id_intent)
      JOIN public.membership_purchase_orders mpo ON mpo.id_order=pi.id_membership_order
      WHERE pi.id_intent=$1`, [MEMBERSHIP_INTENT])).rows[0];
    assert.equal(membershipTimes.origen_pago_codigo, "membership");
    for (const value of [membershipTimes.intent_paid_at, membershipTimes.payment_paid_at, membershipTimes.order_paid_at]) {
      assert.equal(new Date(value).toISOString(), new Date(PAID_AT).toISOString());
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPreservingError(isolated.stop, primaryError);
  }
});
