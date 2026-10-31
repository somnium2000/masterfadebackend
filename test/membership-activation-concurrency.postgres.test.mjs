import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { closeSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  processMembershipSimulatorEvent,
  recoverMembershipPixelPayApproval,
  reconcileMembershipPixelPayStatus,
} from "../src/services/membershipService.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const FIXTURE = new URL("./fixtures/membership-activation-concurrency.sql", import.meta.url);
const IDS = {
  person: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  client: "10000000-0000-4000-8000-000000000003",
  branch: "10000000-0000-4000-8000-000000000004",
  plan: "10000000-0000-4000-8000-000000000005",
  offer: "10000000-0000-4000-8000-000000000006",
  provider: "10000000-0000-4000-8000-000000000007",
  order: "10000000-0000-4000-8000-000000000008",
  intent: "10000000-0000-4000-8000-000000000009",
};
const PROVIDER_PAYMENT = "20000000-0000-4000-8000-000000000001";
const SERVER_CONTEXT = { paymentProvider: "todopago", mode: "preprod_simulated", simulatedEnabled: true, explicitlyEnabled: true, nodeEnv: "test" };

function run(binDir, name, args, outputFile) {
  const executable = path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`);
  const output = outputFile ? openSync(outputFile, "w") : null;
  let result;
  try {
    result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 30_000,
      stdio: output === null ? ["ignore", "pipe", "pipe"] : ["ignore", output, output] });
  } finally { if (output !== null) closeSync(output); }
  const diagnostic = outputFile ? readFileSync(outputFile, "utf8") : result.stderr || result.stdout;
  assert.equal(result.status, 0, `${name}: ${result.error?.message || diagnostic}`);
}

async function startPostgres17() {
  const binDir = process.env.MASTERFADE_TEST_PG_BIN || "C:/Program Files/PostgreSQL/17/bin";
  const directory = await mkdtemp(path.join(tmpdir(), "masterfade-vip-activation-pg17-"));
  const dataDir = path.join(directory, "data");
  const log = path.join(directory, "postgres.log");
  run(binDir, "initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"]);
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await appendFile(path.join(dataDir, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\n`);
  run(binDir, "pg_ctl", ["-D", dataDir, "-l", log, "-t", "20", "-w", "start"]);
  const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", ssl: false, max: 8 });
  assert.equal(Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num) >= 170000, true);
  const stop = async () => {
    await pool.end();
    run(binDir, "pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("masterfade-vip-activation-pg17-"));
    await rm(directory, { recursive: true, force: true });
  };
  return { pool, stop };
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function resetScenario(pool, { activeMembership = false, duplicateEvent = false, failAccounting = false } = {}) {
  await pool.query(`TRUNCATE public.subscription_consumptions, public.subscription_payments, public.payments,
    public.payment_events, public.payment_intents, public.membership_purchase_orders, public.subscriptions,
    public.membership_plans_sucursal, public.payment_providers, public.membership_plans,
    public.sucursales, public.clientes, public.usuarios, app_private.solicitudes_eliminacion_cuenta CASCADE`);
  const expiry = new Date(Date.now() + 300_000);
  const received = new Date(Date.now() - 5_000);
  const benefits = { version: 1, items: [{ tipo: "servicio", id_servicio: "30000000-0000-4000-8000-000000000001", cantidad: 2 }] };
  await pool.query("INSERT INTO public.usuarios(id_usuario,id_persona) VALUES ($1,$2)", [IDS.user, IDS.person]);
  await pool.query("INSERT INTO public.clientes(id_cliente,id_usuario,id_persona) VALUES ($1,$2,$3)", [IDS.client, IDS.user, IDS.person]);
  await pool.query("INSERT INTO public.sucursales VALUES ($1,'Sucursal sintética')", [IDS.branch]);
  await pool.query("INSERT INTO public.membership_plans(id_plan,nombre_plan,periodo_membresia_codigo,beneficios) VALUES ($1,'VIP sintético','mensual',$2)", [IDS.plan, benefits]);
  await pool.query("INSERT INTO public.payment_providers VALUES ($1,'pixelpay')", [IDS.provider]);
  await pool.query(`INSERT INTO public.membership_purchase_orders
      (id_order,id_cliente,id_usuario,id_plan,id_plan_sucursal,id_sucursal,estado_orden_codigo,total_hnl,moneda_codigo,expires_at,plan_snapshot,cliente_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,'pendiente_pago',800,'HNL',$7,
        jsonb_build_object('nombre_plan','VIP sintético','periodo_membresia_codigo','mensual','beneficios',$8::jsonb),
        jsonb_build_object('nombre_completo','Cliente sintético','email','synthetic@example.invalid'));
    `, [IDS.order, IDS.client, IDS.user, IDS.plan, IDS.offer, IDS.branch, expiry, benefits]);
  await pool.query(`INSERT INTO public.payment_intents
      (id_intent,id_provider,id_membership_order,origen_pago_codigo,estado_intent_codigo,monto_hnl,moneda_codigo,expires_at,created_by_usuario_id)
      VALUES ($1,$2,$3,'membership','pendiente_confirmacion',800,'HNL',$4,$5)`,
    [IDS.intent, IDS.provider, IDS.order, expiry, IDS.user]);
  const payload = { id_order: IDS.order, id_intent: IDS.intent, provider: "pixelpay", payment_uuid: PROVIDER_PAYMENT,
    transaction_id: "synthetic-provider-transaction", amount: 800, currency: "HNL", payment_hash_valid: true, amount_matches: true };
  await pool.query(`INSERT INTO public.payment_events
    (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
    VALUES ($1,'verified-first','membership.pixelpay.approved_verified',TRUE,$2,$3,$4)`, [IDS.provider, payload, IDS.intent, received]);
  if (duplicateEvent) await pool.query(`INSERT INTO public.payment_events
    (id_provider,provider_event_id,evento_tipo,firma_valida,payload_esencial,id_intent,recibido_at)
    VALUES ($1,'verified-later','membership.pixelpay.approved_verified',TRUE,$2,$3,$4)`,
    [IDS.provider, payload, IDS.intent, new Date(received.getTime() + 2_000)]);
  if (activeMembership) await pool.query(`INSERT INTO public.subscriptions
    (id_cliente,id_plan,estado_suscripcion_codigo,inicio_at,fin_at,renovacion_auto,cancelada_al_fin,created_by_usuario_id,id_sucursal_contratada,beneficios_snapshot)
    VALUES ($1,$2,'activa',now()-interval '1 day',now()+interval '20 days',FALSE,FALSE,$3,$4,$5)`,
    [IDS.client, IDS.plan, IDS.user, IDS.branch, benefits]);
  await pool.query("UPDATE public.test_membership_failures SET fail_subscription_payment=$1", [failAccounting]);
  return { received: received.toISOString(), benefits };
}

async function state(pool) {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::int FROM public.payments) payments,
    (SELECT count(*)::int FROM public.subscriptions WHERE created_at > now()-interval '10 minutes') recent_subscriptions,
    (SELECT count(*)::int FROM public.subscriptions WHERE estado_suscripcion_codigo='activa') active_subscriptions,
    (SELECT count(*)::int FROM public.subscription_payments) subscription_payments,
    (SELECT count(*)::int FROM public.subscription_consumptions) consumptions,
    (SELECT count(*)::int FROM public.subscriptions WHERE beneficios_snapshot IS NOT NULL) benefit_sets,
    (SELECT estado_orden_codigo FROM public.membership_purchase_orders WHERE id_order=$1) order_state,
    (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent=$2) intent_state`, [IDS.order, IDS.intent])).rows[0];
  return row;
}

function recovery(pool) {
  return transaction(pool, client => recoverMembershipPixelPayApproval(client, { idPaymentIntent: IDS.intent, clienteId: IDS.client }));
}

function simulatorConfirmation(pool) {
  return transaction(pool, client => processMembershipSimulatorEvent(client, {
    idPaymentIntent: IDS.intent, clienteId: IDS.client, montoPruebaHnl: 1, serverContext: SERVER_CONTEXT,
  }));
}

function assertSingleActivation(actual, { active = 1, recent = 1 } = {}) {
  assert.equal(actual.payments, 1);
  assert.equal(actual.recent_subscriptions, recent);
  assert.equal(actual.active_subscriptions, active);
  assert.equal(actual.subscription_payments, 1);
  assert.equal(actual.consumptions, 0);
  assert.equal(actual.benefit_sets, recent);
  assert.equal(actual.order_state, "pagada");
  assert.equal(actual.intent_state, "confirmado");
}

test("PostgreSQL 17 real serializes VIP activation races and rollback", async t => {
  const isolated = await startPostgres17();
  t.after(isolated.stop);
  const { pool } = isolated;
  await pool.query(await readFile(FIXTURE, "utf8"));

  await t.test("two confirmations of one intent", async () => {
    await resetScenario(pool);
    const results = await Promise.allSettled([simulatorConfirmation(pool), simulatorConfirmation(pool)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length >= 1, true,
      JSON.stringify(results.map(result => result.status === "fulfilled" ? result.value : { code: result.reason?.code, message: result.reason?.message })));
    assertSingleActivation(await state(pool));
  });

  await t.test("two simultaneous durable recoveries and idempotent retry", async () => {
    await resetScenario(pool);
    const results = await Promise.allSettled([recovery(pool), recovery(pool)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length >= 1, true);
    const retry = await recovery(pool);
    assert.equal(retry.duplicate, true);
    assertSingleActivation(await state(pool));
  });

  await t.test("confirmation races polling without provider Status", async () => {
    await resetScenario(pool);
    let statusCalls = 0;
    PaymentProviderFactory._instance = {
      async queryPaymentStatus() {
        statusCalls += 1;
        throw new Error("PixelPay Status must not run in this isolated race");
      },
    };
    const app = { db: pool };
    const poll = () => reconcileMembershipPixelPayStatus(app, { idPaymentIntent: IDS.intent, clienteId: IDS.client });
    try {
      const results = await Promise.allSettled([simulatorConfirmation(pool), poll()]);
      assert.equal(results.filter(result => result.status === "fulfilled").length >= 1, true);
      assert.equal(statusCalls, 0);
      assertSingleActivation(await state(pool));
    } finally {
      PaymentProviderFactory.reset();
    }
  });

  await t.test("duplicate verified transaction creates one financial effect", async () => {
    const { received } = await resetScenario(pool, { duplicateEvent: true });
    await Promise.allSettled([recovery(pool), recovery(pool)]);
    assertSingleActivation(await state(pool));
    const times = await pool.query(`SELECT p.paid_at, o.paid_at order_paid_at, sp.paid_at subscription_paid_at
      FROM public.payments p JOIN public.membership_purchase_orders o ON o.id_order=$1
      JOIN public.subscription_payments sp ON sp.id_payment=p.id_payment` , [IDS.order]);
    assert.equal(times.rows[0].paid_at.toISOString(), received);
    assert.equal(times.rows[0].order_paid_at.toISOString(), received);
    assert.equal(times.rows[0].subscription_paid_at.toISOString(), received);
  });

  await t.test("existing active membership is replaced once", async () => {
    await resetScenario(pool, { activeMembership: true });
    await Promise.allSettled([recovery(pool), recovery(pool)]);
    const actual = await state(pool);
    assertSingleActivation(actual, { active: 1, recent: 2 });
    assert.equal(Number((await pool.query("SELECT count(*) n FROM public.subscriptions WHERE estado_suscripcion_codigo='cancelada' AND motivo_fin_codigo='reemplazo'")).rows[0].n), 1);
  });

  await t.test("failure after subscription insert rolls back every activation write", async () => {
    await resetScenario(pool, { failAccounting: true });
    await assert.rejects(recovery(pool), /TEST_SUBSCRIPTION_PAYMENT_FAILURE/);
    assert.deepEqual(await state(pool), {
      payments: 0, recent_subscriptions: 0, active_subscriptions: 0,
      subscription_payments: 0, consumptions: 0, benefit_sets: 0,
      order_state: "pendiente_pago", intent_state: "pendiente_confirmacion",
    });
    assert.equal(Number((await pool.query("SELECT count(*) n FROM public.payment_events")).rows[0].n), 1);
  });
});
