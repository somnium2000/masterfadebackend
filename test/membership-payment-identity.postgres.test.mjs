import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const RUN = process.env.RUN_MEMBERSHIP_PAYMENT_IDENTITY_PG === "true";

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

test("PostgreSQL 17 aislado: payment_uuid separa colisiones Sandbox y bloquea reutilizacion", { skip: !RUN }, async (t) => {
  const isolated = process.env.MASTERFADE_VIP_TEST_DATABASE_URL ? null : await startIsolatedPostgres17();
  const connectionString = process.env.MASTERFADE_VIP_TEST_DATABASE_URL || isolated.connectionString;
  const pool = new pg.Pool({ connectionString, ssl: false, max: 4 });
  const schema = `vip_identity_${crypto.randomUUID().replaceAll("-", "")}`;
  const intentA = crypto.randomUUID();
  const intentB = crypto.randomUUID();
  const repeatedTransactionId = "1f694eee-4715-45b8-a545-000000000000";
  const paymentUuidA = crypto.randomUUID();
  const paymentUuidB = crypto.randomUUID();
  const providerId = crypto.randomUUID();
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    await isolated?.stop();
  });
  const version = Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num);
  assert.ok(version >= 170000 && version < 180000, `PostgreSQL 17 requerido; recibido ${version}`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.payment_providers (
    id_provider uuid PRIMARY KEY,
    codigo text NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.membership_purchase_orders (
    id_order uuid PRIMARY KEY,
    id_cliente uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    estado_orden_codigo text NOT NULL,
    id_suscripcion uuid
  )`);
  await pool.query(`CREATE TABLE ${schema}.payment_intents (
    id_intent uuid PRIMARY KEY,
    id_provider uuid REFERENCES ${schema}.payment_providers(id_provider),
    id_membership_order uuid REFERENCES ${schema}.membership_purchase_orders(id_order),
    estado_intent_codigo text,
    monto_hnl numeric(12,2),
    moneda_codigo text,
    last_verified_at timestamptz,
    verification_attempts integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.payments (
    id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_intent uuid NOT NULL,
    provider_tx_id text NOT NULL UNIQUE,
    monto_hnl numeric(12,2) NOT NULL,
    moneda_codigo text NOT NULL,
    paid_at timestamptz NOT NULL,
    pago_tardio boolean NOT NULL DEFAULT false
  )`);
  await pool.query(`CREATE TABLE ${schema}.payment_events (
    id_event uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_provider uuid NOT NULL REFERENCES ${schema}.payment_providers(id_provider),
    provider_event_id text NOT NULL,
    evento_tipo text NOT NULL,
    firma_valida boolean NOT NULL DEFAULT false,
    id_intent uuid REFERENCES ${schema}.payment_intents(id_intent),
    id_payment uuid REFERENCES ${schema}.payments(id_payment),
    payload_esencial jsonb NOT NULL DEFAULT '{}'::jsonb,
    recibido_at timestamptz NOT NULL DEFAULT now(),
    procesado_at timestamptz,
    resultado_procesamiento text
  )`);
  await pool.query(`CREATE TABLE ${schema}.subscriptions (
    id_suscripcion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_intent uuid NOT NULL UNIQUE
  )`);
  await pool.query(`CREATE TABLE ${schema}.subscription_payments (
    id_subscription_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    id_suscripcion uuid NOT NULL UNIQUE,
    id_payment uuid NOT NULL UNIQUE
  )`);
  await pool.query(`CREATE FUNCTION ${schema}.classify_payment_time() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE intent_expiry timestamptz;
    BEGIN
      SELECT expires_at INTO intent_expiry FROM ${schema}.payment_intents WHERE id_intent=NEW.id_intent;
      NEW.pago_tardio := intent_expiry IS NOT NULL AND NEW.paid_at > intent_expiry;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER classify_payment_time BEFORE INSERT OR UPDATE ON ${schema}.payments
    FOR EACH ROW EXECUTE FUNCTION ${schema}.classify_payment_time()`);

  await pool.query(`INSERT INTO ${schema}.payment_providers(id_provider,codigo) VALUES ($1,'pixelpay')`, [providerId]);
  await pool.query(`INSERT INTO ${schema}.payment_intents(id_intent,id_provider,expires_at) VALUES
    ($1,$3,now() + interval '5 minutes'),($2,$3,now() + interval '5 minutes')`, [intentA, intentB, providerId]);
  await pool.query(`INSERT INTO ${schema}.payments(id_intent,provider_tx_id,monto_hnl,moneda_codigo,paid_at)
    VALUES ($1,$2,1,'HNL',now()),($3,$4,1,'HNL',now())`, [intentA, paymentUuidA, intentB, paymentUuidB]);
  await pool.query(`INSERT INTO ${schema}.payment_events
    (id_provider,provider_event_id,evento_tipo,firma_valida,id_intent,payload_esencial) VALUES
    ($5,'event-a','membership.pixelpay.approved_verified',TRUE,$1,$2::jsonb),
    ($5,'event-b','membership.pixelpay.approved_verified',TRUE,$3,$4::jsonb)`, [
    intentA, JSON.stringify({ provider: "pixelpay", payment_uuid: paymentUuidA, transaction_id: repeatedTransactionId }),
    intentB, JSON.stringify({ provider: "pixelpay", payment_uuid: paymentUuidB, transaction_id: repeatedTransactionId }),
    providerId,
  ]);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.payments`)).rows[0].count, 2);
  assert.equal((await pool.query(`SELECT count(DISTINCT payload_esencial->>'transaction_id')::int count FROM ${schema}.payment_events`)).rows[0].count, 1);

  const collisionIntentA = crypto.randomUUID();
  const collisionIntentB = crypto.randomUUID();
  const reusedPaymentUuid = crypto.randomUUID();
  const insert = (idIntent) => pool.query(`INSERT INTO ${schema}.payments(id_intent,provider_tx_id,monto_hnl,moneda_codigo,paid_at)
    VALUES ($1,$2,300,'HNL',now()) ON CONFLICT(provider_tx_id) DO UPDATE SET monto_hnl=EXCLUDED.monto_hnl
    WHERE ${schema}.payments.id_intent=EXCLUDED.id_intent RETURNING id_payment`, [idIntent, reusedPaymentUuid]);
  const results = await Promise.all([insert(collisionIntentA), insert(collisionIntentB)]);
  assert.deepEqual(results.map((result) => result.rowCount).sort(), [0, 1]);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.payments WHERE provider_tx_id=$1`, [reusedPaymentUuid])).rows[0].count, 1);

  const statusIntent = crypto.randomUUID();
  await pool.query(`INSERT INTO ${schema}.payment_intents(id_intent,id_provider,expires_at)
    VALUES ($1,$2,now() + interval '5 minutes')`, [statusIntent, providerId]);
  const claimStatus = () => pool.query(`UPDATE ${schema}.payment_intents
    SET last_verified_at=now(), verification_attempts=verification_attempts+1
    WHERE id_intent=$1 AND (last_verified_at IS NULL OR last_verified_at <= now() - interval '25 seconds')
    RETURNING id_intent`, [statusIntent]);
  const statusClaims = await Promise.all([claimStatus(), claimStatus()]);
  assert.deepEqual(statusClaims.map((result) => result.rowCount).sort(), [0, 1]);
  assert.equal((await pool.query(`SELECT verification_attempts FROM ${schema}.payment_intents WHERE id_intent=$1`,
    [statusIntent])).rows[0].verification_attempts, 1);

  const rollbackClient = await pool.connect();
  try {
    await rollbackClient.query("BEGIN");
    await rollbackClient.query(`INSERT INTO ${schema}.payments(id_intent,provider_tx_id,monto_hnl,moneda_codigo,paid_at)
      VALUES ($1,$2,300,'HNL',now())`, [crypto.randomUUID(), crypto.randomUUID()]);
    await rollbackClient.query("ROLLBACK");
  } finally {
    rollbackClient.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.payments`)).rows[0].count, 3);

  const recoveryIntent = crypto.randomUUID();
  const recoveryPaymentUuid = crypto.randomUUID();
  const recoveryOrder = crypto.randomUUID();
  const recoveryClient = crypto.randomUUID();
  const expiry = new Date(Date.now() - 60_000);
  const verifiedAt = new Date(expiry.getTime() - 60_000);
  await pool.query(`INSERT INTO ${schema}.membership_purchase_orders
    (id_order,id_cliente,expires_at,estado_orden_codigo) VALUES ($1,$2,$3,'pendiente_pago')`,
  [recoveryOrder, recoveryClient, expiry]);
  await pool.query(`INSERT INTO ${schema}.payment_intents
    (id_intent,id_provider,id_membership_order,estado_intent_codigo,monto_hnl,moneda_codigo,expires_at)
    VALUES ($1,$2,$3,'pendiente_confirmacion',1,'HNL',$4)`, [recoveryIntent, providerId, recoveryOrder, expiry]);
  await pool.query(`INSERT INTO ${schema}.payment_events
    (id_provider,provider_event_id,evento_tipo,firma_valida,id_intent,payload_esencial,recibido_at)
    VALUES ($1,'recovery-event','membership.pixelpay.approved_verified',TRUE,$2,$3::jsonb,$4)`, [
    providerId,
    recoveryIntent,
    JSON.stringify({ provider: "pixelpay", payment_uuid: recoveryPaymentUuid,
      transaction_id: repeatedTransactionId, verified_at: verifiedAt.toISOString() }),
    verifiedAt,
  ]);
  const qaColumns = await pool.query(`SELECT column_name, data_type, column_default
    FROM information_schema.columns WHERE table_schema=$1 AND table_name='payment_events'
    ORDER BY ordinal_position`, [schema]);
  assert.deepEqual(qaColumns.rows.map(({ column_name }) => column_name), [
    "id_event", "id_provider", "provider_event_id", "evento_tipo", "firma_valida",
    "id_intent", "id_payment", "payload_esencial", "recibido_at", "procesado_at",
    "resultado_procesamiento",
  ]);
  assert.equal(qaColumns.rows.some(({ column_name }) => column_name === "created_at"), false);
  assert.equal(qaColumns.rows.find(({ column_name }) => column_name === "recibido_at").data_type, "timestamp with time zone");
  const durableResult = await pool.query(`SELECT pi.id_intent, pi.id_provider, pi.id_membership_order,
      pi.estado_intent_codigo, pi.monto_hnl, pi.moneda_codigo, pi.expires_at AS intent_expires_at,
      mpo.id_cliente, mpo.expires_at AS order_expires_at, mpo.estado_orden_codigo,
      mpo.id_suscripcion, pp.codigo AS provider_code,
      pe.payload_esencial, pe.recibido_at AS verified_at
    FROM ${schema}.payment_intents pi
    JOIN ${schema}.membership_purchase_orders mpo ON mpo.id_order = pi.id_membership_order
    JOIN ${schema}.payment_providers pp ON pp.id_provider = pi.id_provider
    JOIN ${schema}.payment_events pe ON pe.id_intent = pi.id_intent AND pe.id_provider = pi.id_provider
    WHERE pi.id_intent = $1::uuid
      AND pi.estado_intent_codigo IN ('pendiente_confirmacion', 'confirmado')
      AND pe.evento_tipo = 'membership.pixelpay.approved_verified'
      AND pe.firma_valida = TRUE
    ORDER BY pe.recibido_at DESC LIMIT 1 FOR UPDATE OF pi`, [recoveryIntent]);
  assert.equal(durableResult.rows[0].provider_code, "pixelpay");
  assert.equal(durableResult.rows[0].id_cliente, recoveryClient);
  assert.equal(new Date(durableResult.rows[0].verified_at).toISOString(), verifiedAt.toISOString());
  const recover = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const paymentResult = await client.query(`INSERT INTO ${schema}.payments
        (id_intent,provider_tx_id,monto_hnl,moneda_codigo,paid_at)
        VALUES ($1,$2,1,'HNL',$3) ON CONFLICT(provider_tx_id) DO UPDATE SET monto_hnl=EXCLUDED.monto_hnl
        WHERE ${schema}.payments.id_intent=EXCLUDED.id_intent RETURNING id_payment,pago_tardio,paid_at`,
      [recoveryIntent, recoveryPaymentUuid, verifiedAt]);
      assert.equal(paymentResult.rows[0].pago_tardio, false);
      const subscription = await client.query(`INSERT INTO ${schema}.subscriptions(id_intent) VALUES ($1)
        ON CONFLICT(id_intent) DO UPDATE SET id_intent=EXCLUDED.id_intent RETURNING id_suscripcion`, [recoveryIntent]);
      await client.query(`INSERT INTO ${schema}.subscription_payments(id_suscripcion,id_payment) VALUES ($1,$2)
        ON CONFLICT(id_payment) DO NOTHING`, [subscription.rows[0].id_suscripcion, paymentResult.rows[0].id_payment]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await recover();
  await recover();
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.payments WHERE id_intent=$1`, [recoveryIntent])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.subscriptions WHERE id_intent=$1`, [recoveryIntent])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int count FROM ${schema}.subscription_payments sp
    JOIN ${schema}.subscriptions s USING(id_suscripcion) WHERE s.id_intent=$1`, [recoveryIntent])).rows[0].count, 1);
  const persisted = (await pool.query(`SELECT paid_at FROM ${schema}.payments WHERE id_intent=$1`, [recoveryIntent])).rows[0];
  assert.equal(new Date(persisted.paid_at).toISOString(), verifiedAt.toISOString());

  const invalidIntent = crypto.randomUUID();
  await pool.query(`INSERT INTO ${schema}.payment_intents(id_intent,id_provider,expires_at) VALUES ($1,$2,$3)`,
  [invalidIntent, providerId, expiry]);
  const invalidPayment = await pool.query(`INSERT INTO ${schema}.payments
    (id_intent,provider_tx_id,monto_hnl,moneda_codigo,paid_at) VALUES ($1,$2,1,'HNL',now()) RETURNING pago_tardio`,
  [invalidIntent, crypto.randomUUID()]);
  assert.equal(invalidPayment.rows[0].pago_tardio, true);
});
