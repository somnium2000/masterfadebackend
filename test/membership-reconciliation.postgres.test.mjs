import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { startPostgres17 } from "./helpers/postgres17.mjs";
import { processMembershipPixelPaySale, recoverMembershipPixelPayApproval } from "../src/services/membershipService.js";
import { PaymentProviderFactory } from "../src/services/payments/PaymentProviderFactory.js";

const RUN = process.env.RUN_MEMBERSHIP_RECONCILIATION_PG === "true";
const IDs = Object.fromEntries(["person", "user", "client", "branch", "plan", "order", "provider", "intent", "attempt"]
  .map((key, index) => [key, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
const received = "2026-11-13T12:00:00.123456Z";
const expiry = "2026-11-13T12:01:00.654321Z";
const paymentUuid = "S-synthetic-membership-recovery";
const transactionId = "synthetic-acquirer-transaction";

function functionSql(source, name) {
  const section = source.slice(source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  const tag = section.match(/AS (\$[a-z_]+\$)/i)?.[1];
  assert.ok(tag);
  return section.slice(0, section.indexOf(`${tag};`, section.indexOf(`AS ${tag}`) + tag.length + 3) + tag.length + 1);
}

test("PostgreSQL 17 v2: recuperacion real de membresia exige evento canonico correlacionado", { skip: !RUN }, async (t) => {
  const isolated = await startPostgres17();
  const { client } = isolated;
  const previousProvider = PaymentProviderFactory._instance;
  let providerCalls = 0;
  const forbiddenProvider = {
    async sale() { providerCalls++; throw new Error("Sale prohibida"); },
    async queryPaymentStatus() { providerCalls++; throw new Error("Status prohibido"); },
  };
  PaymentProviderFactory._instance = forbiddenProvider;
  t.after(async () => { PaymentProviderFactory._instance = previousProvider; await isolated.stop(); });
  for (const file of ["./sql/microfase2a2/pre_2a2_schema.sql", "./sql/payments/late_payment_support.sql",
    "./sql/payments/qa_payment_triggers_20261011.sql"]) await client.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const historical = await readFile(new URL("../db/migrations/pixel/20260924010000_pixelpay_reconciliation_window.sql", import.meta.url), "utf8");
  await client.query(functionSql(historical, "public.fn_payment_intents_capture_paid_at"));
  await client.query(`CREATE TRIGGER tr_payment_intents_capture_paid_at BEFORE INSERT OR UPDATE OF estado_intent_codigo,paid_at
    ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.fn_payment_intents_capture_paid_at()`);
  for (const file of ["../db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql",
    "../db/migrations/pixel/20261016010000_pixelpay_uncertain_observed_identifiers.sql",
    "../db/migrations/pixel/20261018010000_pixelpay_observed_payment_uuid_opaque.sql",
    "../db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql"]) {
    await client.query(await readFile(new URL(file, import.meta.url), "utf8"));
  }
  // AM: Solo esquema sintetico local para ejecutar el servicio real y los triggers v2 intactos.
  await client.query(`ALTER TABLE public.clientes ADD COLUMN anonimizado boolean NOT NULL DEFAULT false;
    ALTER TABLE public.usuarios ADD COLUMN estado_acceso text NOT NULL DEFAULT 'activo';
    ALTER TABLE public.payment_intents ADD COLUMN orden_compra text;
    ALTER TABLE public.payments ADD COLUMN registrado_por_usuario_id uuid;
    CREATE TABLE app_private.solicitudes_eliminacion_cuenta(id_cliente uuid,id_usuario uuid,id_persona uuid,estado_codigo text);
    CREATE TABLE public.membership_plans(id_plan uuid PRIMARY KEY,periodo_membresia_codigo text,beneficios jsonb,nombre_plan text);
    CREATE TABLE public.membership_purchase_orders(id_order uuid PRIMARY KEY,id_cliente uuid,id_usuario uuid,id_plan uuid,
      id_plan_sucursal uuid,id_sucursal uuid,estado_orden_codigo text,total_hnl numeric,moneda_codigo text,
      expires_at timestamptz,id_suscripcion uuid,plan_snapshot jsonb,cliente_snapshot jsonb,paid_at timestamptz,
      updated_at timestamptz DEFAULT now());
    CREATE TABLE public.subscriptions(id_suscripcion uuid PRIMARY KEY DEFAULT gen_random_uuid(),id_cliente uuid,id_plan uuid,
      estado_suscripcion_codigo text,inicio_at timestamptz,fin_at timestamptz,renovacion_auto boolean,cancelada_al_fin boolean,
      created_by_usuario_id uuid,id_sucursal_contratada uuid,beneficios_snapshot jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE public.subscription_payments(id_suscripcion uuid,id_payment uuid UNIQUE,monto_hnl numeric,
      moneda_codigo text,metodo text,estado text,paid_at timestamptz,registrado_por_usuario_id uuid);`);
  const payload = { id_order: IDs.order, id_intent: IDs.intent, provider: "pixelpay",
    payment_attempt_id: IDs.attempt, payment_uuid: paymentUuid, transaction_id: transactionId,
    amount: 800, currency: "HNL", payment_hash_valid: true, amount_matches: true };
  const reset = async () => {
    await client.query(`TRUNCATE public.subscription_payments,public.subscriptions,public.membership_purchase_orders,
      public.membership_plans,public.payment_events,app_private.pixelpay_sale_attempts,public.payment_intents,
      public.payments,public.clientes,public.usuarios,public.personas,public.sucursales,public.payment_providers CASCADE`);
    await client.query("INSERT INTO personas(id_persona) VALUES($1)", [IDs.person]);
    await client.query("INSERT INTO usuarios(id_usuario,id_persona) VALUES($1,$2)", [IDs.user, IDs.person]);
    await client.query("INSERT INTO clientes(id_cliente,id_persona,id_usuario) VALUES($1,$2,$3)", [IDs.client, IDs.person, IDs.user]);
    await client.query("INSERT INTO sucursales(id_sucursal) VALUES($1)", [IDs.branch]);
    await client.query("INSERT INTO payment_providers(id_provider,codigo) VALUES($1,'pixelpay')", [IDs.provider]);
    const snapshot = { periodo_membresia_codigo: "mensual", beneficios: { version: 1, items: [{ tipo: "servicio", id_servicio: IDs.plan, cantidad: 3 }] } };
    await client.query("INSERT INTO membership_plans VALUES($1,'mensual',$2,'Synthetic plan')", [IDs.plan, snapshot.beneficios]);
    await client.query(`INSERT INTO membership_purchase_orders(id_order,id_cliente,id_usuario,id_plan,id_sucursal,
      estado_orden_codigo,total_hnl,moneda_codigo,expires_at,plan_snapshot,cliente_snapshot)
      VALUES($1,$2,$3,$4,$5,'pendiente_pago',800,'HNL',$6,$7,'{}')`,
    [IDs.order, IDs.client, IDs.user, IDs.plan, IDs.branch, expiry, snapshot]);
    await client.query(`INSERT INTO payment_intents(id_intent,id_provider,id_membership_order,origen_pago_codigo,
      estado_intent_codigo,monto_hnl,moneda_codigo,expires_at,provider_session_id,referencia_externa)
      VALUES($1,$2,$3,'membership','pendiente_confirmacion',800,'HNL',$4,$5,$6)`,
    [IDs.intent, IDs.provider, IDs.order, expiry, paymentUuid, transactionId]);
    await client.query(`INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id,finalized_at,outcome)
      VALUES($1,$2,$3,'approved')`, [IDs.intent, IDs.attempt, "2026-11-13T11:59:59.111111Z"]);
    await client.query(`INSERT INTO payment_events(id_provider,provider_event_id,evento_tipo,firma_valida,id_intent,payload_esencial,recibido_at)
      VALUES($1,$2,'membership.pixelpay.approved_verified',TRUE,$3,$4,$5)`,
    [IDs.provider, `pixelpay_membership_${IDs.attempt}`, IDs.intent, payload, received]);
  };
  const recover = async (connection = client) => {
    await connection.query("BEGIN");
    try {
      const result = await recoverMembershipPixelPayApproval(connection, { idPaymentIntent: IDs.intent, clienteId: IDs.client });
      await connection.query("COMMIT");
      return result;
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
  };
  const assertOnce = async (paidAt = received) => {
    const { rows: [state] } = await client.query(`SELECT
      (SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM subscriptions) subscriptions,
      (SELECT count(*)::int FROM subscription_payments) subscription_payments,
      (SELECT bool_and(paid_at=$1::timestamptz) FROM payments) exact_payment,
      (SELECT bool_and(paid_at=$1::timestamptz) FROM payment_intents) exact_intent,
      (SELECT bool_and(paid_at=$1::timestamptz) FROM membership_purchase_orders) exact_order,
      (SELECT bool_and(paid_at=$1::timestamptz) FROM subscription_payments) exact_subscription_payment`, [paidAt]);
    assert.deepEqual(state, { payments: 1, subscriptions: 1, subscription_payments: 1,
      exact_payment: true, exact_intent: true, exact_order: true, exact_subscription_payment: true });
    const sub = (await client.query("SELECT beneficios_snapshot FROM subscriptions")).rows[0];
    assert.equal(sub.beneficios_snapshot.items[0].cantidad, 3);
  };
  await t.test("caida tras evidencia durable: recupera tarde con precision e idempotencia", async () => {
    await reset();
    assert.equal((await recover()).estado, "activa");
    assert.equal((await recover()).duplicate, true);
    await assertOnce();
  });
  await t.test("evento anterior contradictorio no eclipsa el evento canonico valido", async () => {
    await reset();
    await client.query(`INSERT INTO payment_events(id_provider,provider_event_id,evento_tipo,firma_valida,id_intent,payload_esencial,recibido_at)
      VALUES($1,'invalid-first','membership.pixelpay.approved_verified',TRUE,$2,$3,$4::timestamptz-interval '1 second')`,
    [IDs.provider, IDs.intent, { ...payload, payment_uuid: "other", amount: 2 }, received]);
    assert.equal((await recover()).estado, "activa");
    await assertOnce();
  });
  await t.test("rollback tras crear suscripcion no consume evidencia y permite recuperacion", async () => {
    await reset();
    let subscriptionInserted = false;
    const failing = { async query(sql, params) {
      if (sql.includes("INSERT INTO public.subscription_payments")) {
        assert.equal(subscriptionInserted, true);
        throw new Error("synthetic failure after activation");
      }
      const result = await client.query(sql, params);
      if (sql.includes("INSERT INTO public.subscriptions")) subscriptionInserted = true;
      return result;
    } };
    await assert.rejects(recover(failing), /synthetic failure/);
    assert.equal((await client.query("SELECT count(*)::int count FROM subscriptions")).rows[0].count, 0);
    assert.equal((await client.query("SELECT count(*)::int count FROM payments")).rows[0].count, 0);
    assert.equal((await client.query("SELECT count(*)::int count FROM payment_events")).rows[0].count, 1);
    await recover();
    await assertOnce();
  });
  for (const [label, sql, params, code] of [
    ["UUID", "UPDATE payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ payment_uuid: "other" }]],
    ["transaccion", "UPDATE payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ transaction_id: "other" }]],
    ["monto", "UPDATE payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ amount: "800" }]],
    ["hash", "UPDATE payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ payment_hash_valid: false }]],
    ["intento", "UPDATE payment_events SET payload_esencial=payload_esencial || $1::jsonb", [{ payment_attempt_id: IDs.person }]],
    ["un microsegundo fuera de vigencia", "UPDATE payment_events SET recibido_at=$1::timestamptz+interval '1 microsecond'", [expiry],
      "MEMBERSHIP_PIXELPAY_RECOVERY_VERIFIED_AFTER_EXPIRY"],
    ["orden vencida un microsegundo antes del evento", "UPDATE membership_purchase_orders SET expires_at=$1::timestamptz-interval '1 microsecond'", [received],
      "MEMBERSHIP_PIXELPAY_RECOVERY_VERIFIED_AFTER_EXPIRY"],
  ]) {
    await t.test(`rechaza ${label} sin activar beneficios`, async () => {
      await reset(); await client.query(sql, params);
      await assert.rejects(recover(), { code: code || "MEMBERSHIP_PIXELPAY_RECOVERY_EVIDENCE_INVALID" });
      assert.equal((await client.query("SELECT count(*)::int count FROM subscriptions")).rows[0].count, 0);
    });
  }
  await t.test("dos eventos financieramente validos requieren conciliacion manual", async () => {
    await reset();
    await client.query("INSERT INTO app_private.pixelpay_sale_attempts(id_intent,payment_attempt_id) VALUES($1,$2)", [IDs.intent, IDs.person]);
    await client.query(`INSERT INTO payment_events(id_provider,provider_event_id,evento_tipo,firma_valida,id_intent,payload_esencial,recibido_at)
      VALUES($1,$2,'membership.pixelpay.approved_verified',TRUE,$3,$4,$5)`,
    [IDs.provider, `pixelpay_membership_${IDs.person}`, IDs.intent, { ...payload, payment_attempt_id: IDs.person }, received]);
    await assert.rejects(recover(), { code: "MEMBERSHIP_PIXELPAY_RECOVERY_EVIDENCE_INVALID" });
    assert.equal((await client.query("SELECT count(*)::int count FROM payments")).rows[0].count, 0);
  });
  for (const inTime of [false, true]) await t.test(inTime
    ? "Sale aprobada completa pagos, suscripcion y beneficios una vez con precision v2"
    : "Sale aprobada no activa si la orden vence un microsegundo antes del evento", async () => {
    await reset();
    await client.query("DELETE FROM payment_events");
    await client.query("DELETE FROM app_private.pixelpay_sale_attempts");
    await client.query("UPDATE payment_intents SET estado_intent_codigo='link_generado',expires_at='2099-01-01'");
    await client.query("UPDATE membership_purchase_orders SET expires_at='2099-01-01'");
    // AM: Reloj sintetico de recibo, solo en este cluster; triggers financieros v2 intactos.
    await client.query(`CREATE FUNCTION public.synthetic_membership_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.recibido_at := '2030-01-01T00:00:00.123456Z'::timestamptz; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_membership_receipt BEFORE INSERT ON payment_events
      FOR EACH ROW EXECUTE FUNCTION public.synthetic_membership_receipt()`);
    let mockedSaleCalls = 0;
    PaymentProviderFactory._instance = { async sale() {
      mockedSaleCalls++;
      await client.query("UPDATE membership_purchase_orders SET expires_at=$1", [
        inTime ? "2030-01-01T00:00:00.123456Z" : "2030-01-01T00:00:00.123455Z",
      ]);
      return { outcome: "approved", approved: true, paymentHashValid: true, amountMatches: true,
        paymentUuid, transactionId, statusCode: 200, diagnostics: {} };
    } };
    const pool = new pg.Pool(isolated.connectionOptions);
    try {
      const app = { db: pool, config: { pixelPayEnv: "sandbox" } };
      const input = {
        idPaymentIntent: IDs.intent, clienteId: IDs.client,
        card: { number: "4111111111111111", holder: "Synthetic card", expire: "3012", cvv: "123" },
        billing: { address: "Synthetic address" },
      };
      if (inTime) {
        assert.equal((await processMembershipPixelPaySale(app, input)).processed, true);
        assert.equal((await processMembershipPixelPaySale(app, input)).duplicate, true);
        await assertOnce("2030-01-01T00:00:00.123456Z");
      } else {
        await assert.rejects(processMembershipPixelPaySale(app, input), { code: "MEMBERSHIP_PIXELPAY_EVIDENCE_INVALID" });
        assert.equal((await client.query("SELECT count(*)::int count FROM subscriptions")).rows[0].count, 0);
        assert.equal((await client.query("SELECT count(*)::int count FROM payments")).rows[0].count, 0);
      }
      assert.equal(mockedSaleCalls, 1);
      assert.equal((await client.query("SELECT count(*)::int count FROM payment_events")).rows[0].count, 1);
    } finally {
      PaymentProviderFactory._instance = forbiddenProvider;
      await pool.end();
      await client.query("DROP TRIGGER synthetic_membership_receipt ON payment_events; DROP FUNCTION public.synthetic_membership_receipt()");
    }
  });
  await t.test("recuperaciones concurrentes no duplican pago, suscripcion ni beneficios", async () => {
    await reset();
    const connections = [new pg.Client(isolated.connectionOptions), new pg.Client(isolated.connectionOptions)];
    await Promise.all(connections.map(c => c.connect()));
    try {
      let releaseFirst;
      let acquired;
      const locked = new Promise(resolve => { acquired = resolve; });
      const proceed = new Promise(resolve => { releaseFirst = resolve; });
      let paused = false;
      const firstConnection = { async query(sql, params) {
        const result = await connections[0].query(sql, params);
        if (sql.includes("AS deletion_identity_lock") && !paused) {
          paused = true;
          assert.equal(result.rows[0].deletion_identity_lock, true);
          acquired();
          await proceed;
        }
        return result;
      } };
      const first = recover(firstConnection);
      try {
        await locked;
        const lock = await client.query(`SELECT count(*)::int count FROM pg_locks
          WHERE pid=$1 AND locktype='advisory' AND granted`, [connections[0].processID]);
        assert.ok(lock.rows[0].count > 0);
        assert.equal((await client.query("SELECT count(*)::int count FROM payments")).rows[0].count, 0);
        await assert.rejects(recover(connections[1]), { code: "MEMBERSHIP_PAYMENT_ACCOUNT_UNAVAILABLE" });
      } finally { releaseFirst(); }
      assert.equal((await first).estado, "activa");
      assert.equal((await recover()).duplicate, true);
      await assertOnce();
    } finally { await Promise.all(connections.map(c => c.end())); }
  });
  assert.equal(providerCalls, 0);
});
