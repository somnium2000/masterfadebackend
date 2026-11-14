import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { startPostgres17 } from './helpers/postgres17.mjs';
import { loadDurablePixelPayApproval } from '../src/services/payments/pixelPayDurableApproval.js';
import { processHostedCallback } from '../src/services/payments/pixelPayHosted.js';

const intentId = 'a799b22b-783b-4f94-8666-9dfcb4676f25';
const groupId = '31a65cf8-e948-4ddb-b386-46ea8547755b';
const expiry = '2026-11-14T20:00:00.000Z';
const paidAt = '2026-11-14T19:59:00.123456Z';

async function fixture(client) {
  await client.query(`
    CREATE SCHEMA app_private;
    CREATE TABLE public.payment_intents (
      id_intent uuid PRIMARY KEY, id_grupo_cita uuid,
      payment_channel text NOT NULL DEFAULT 'sdk',
      estado_intent_codigo text NOT NULL DEFAULT 'pendiente_confirmacion', paid_at timestamptz
    );
    CREATE TABLE public.payments (
      id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
      estado_pago_codigo text NOT NULL, paid_at timestamptz
    );
    CREATE TABLE public.citas (id_cita uuid PRIMARY KEY, id_grupo_cita uuid, deleted_at timestamptz);
    CREATE TABLE public.citas_holds (id_cita uuid, expires_at timestamptz);
    CREATE TABLE app_private.pixelpay_sale_attempts (
      id_intent uuid, outcome text DEFAULT 'approved', sdk_response_class text DEFAULT 'SuccessResponse',
      upstream_http_status integer DEFAULT 200, finalized_at timestamptz,
      response_success boolean DEFAULT true, response_approved boolean DEFAULT true,
      response_incomplete boolean DEFAULT false, uncertain boolean DEFAULT false,
      transaction_result_valid boolean DEFAULT true, transaction_result_parsed boolean DEFAULT true,
      payment_uuid_present boolean DEFAULT true, transaction_id_present boolean DEFAULT true,
      payment_hash_present boolean DEFAULT true, payment_hash_valid boolean DEFAULT true,
      transaction_amount_matches boolean DEFAULT true, approved_amount_matches boolean DEFAULT true,
      amount_matches boolean DEFAULT true
    );
  `);
  await client.query('INSERT INTO payment_intents(id_intent,id_grupo_cita) VALUES ($1,$2)', [intentId, groupId]);
  await client.query('INSERT INTO citas(id_cita,id_grupo_cita) VALUES ($1,$2)', [intentId, groupId]);
  await client.query('INSERT INTO citas_holds(id_cita,expires_at) VALUES ($1,$2)', [intentId, expiry]);
  await client.query('INSERT INTO app_private.pixelpay_sale_attempts(id_intent,finalized_at) VALUES ($1,$2)', [intentId, paidAt]);
  await client.query(await readFile(new URL('../db/migrations/pixel/20261114120000_pixelpay_hosted_financial_guard.sql', import.meta.url), 'utf8'));
}

test('PostgreSQL 17: Hosted nunca obtiene evidencia SDK ni altera ingresos o paid_at', async (t) => {
  const isolated = await startPostgres17();
  const client = isolated.client;
  try {
    await fixture(client);
    const args = { idIntent: intentId, groupRows: [], holdRows: [{ expires_at: expiry }] };
    await t.test('SDK conserva aprobacion durable y precision temporal', async () => {
      const approval = await loadDurablePixelPayApproval(client, args);
      assert.ok(approval);
      assert.match(approval.finalized_at, /19:59:00\.123456/);
      await client.query('UPDATE payment_intents SET paid_at=$2, estado_intent_codigo=$3 WHERE id_intent=$1', [intentId, paidAt, 'confirmado']);
      await client.query("INSERT INTO payments(id_intent,estado_pago_codigo,paid_at) VALUES ($1,'capturado',$2)", [intentId, paidAt]);
      await client.query('DELETE FROM payments');
      await client.query("UPDATE payment_intents SET paid_at=NULL,estado_intent_codigo='pendiente_confirmacion' WHERE id_intent=$1", [intentId]);
    });
    await t.test('Hosted excluye evidencia aprobada SDK aun si todos sus indicadores son verdaderos', async () => {
      await client.query("UPDATE payment_intents SET payment_channel='hosted' WHERE id_intent=$1", [intentId]);
      assert.equal(await loadDurablePixelPayApproval(client, args), null);
    });
    await t.test('Hosted bloquea confirmacion y paid_at en intent', async () => {
      await assert.rejects(client.query("UPDATE payment_intents SET estado_intent_codigo='confirmado' WHERE id_intent=$1", [intentId]), /MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE/);
      await assert.rejects(client.query('UPDATE payment_intents SET paid_at=$2 WHERE id_intent=$1', [intentId, paidAt]), /MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE/);
    });
    await t.test('Hosted bloquea cada estado que alimenta reportes financieros', async () => {
      for (const state of ['capturado', 'conciliado', 'manual_pagado']) {
        await assert.rejects(client.query('INSERT INTO payments(id_intent,estado_pago_codigo,paid_at) VALUES ($1,$2,$3)', [intentId, state, paidAt]), /MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE/);
      }
      assert.equal((await client.query('SELECT count(*)::integer AS count FROM payments')).rows[0].count, 0);
      assert.equal((await client.query('SELECT paid_at FROM payment_intents WHERE id_intent=$1', [intentId])).rows[0].paid_at, null);
    });
    await t.test('Expiracion Hosted sigue permitida sin restaurar pago o reserva', async () => {
      await client.query("UPDATE payment_intents SET estado_intent_codigo='expirado' WHERE id_intent=$1", [intentId]);
      assert.equal((await client.query('SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1', [intentId])).rows[0].estado_intent_codigo, 'expirado');
      assert.equal(await loadDurablePixelPayApproval(client, args), null);
    });
    await t.test('Loader SDK soporta periodo previo a migracion de canal', async () => {
      await client.query('DROP TRIGGER tr_hosted_financial_intent_guard ON payment_intents');
      await client.query('ALTER TABLE payment_intents DROP COLUMN payment_channel');
      assert.ok(await loadDurablePixelPayApproval(client, args));
    });
  } finally {
    await isolated.stop();
  }
});

test('PostgreSQL 17: migracion Hosted serializa canales y conserva callbacks sin contaminar pagos', async (t) => {
  const isolated = await startPostgres17();
  const client = isolated.client;
  const providerId = randomUUID();
  const config = { enabled: true, receivingEnabled: true, keyId: 'TESTKEY', secretKey: 'synthetic-test-only' };
  const db = { connect: async () => {
    const connected = new pg.Client(isolated.connectionOptions);
    await connected.connect();
    connected.release = () => connected.end();
    return connected;
  } };
  try {
    await client.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA app_private;
      CREATE TABLE payment_providers(id_provider uuid PRIMARY KEY, codigo text);
      CREATE TABLE citas_grupos(id_grupo_cita uuid PRIMARY KEY);
      CREATE TABLE payment_intents(
        id_intent uuid PRIMARY KEY, id_provider uuid REFERENCES payment_providers,
        id_cita uuid, id_hold uuid, created_by_usuario_id uuid,
        id_grupo_cita uuid REFERENCES citas_grupos, orden_compra text UNIQUE,
        monto_hnl numeric(12,2), moneda_codigo text DEFAULT 'HNL',
        estado_intent_codigo text DEFAULT 'pendiente_confirmacion', paid_at timestamptz,
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE payments(id_intent uuid REFERENCES payment_intents, estado_pago_codigo text, paid_at timestamptz);
      CREATE TABLE app_private.pixelpay_sale_attempts(id_intent uuid REFERENCES payment_intents);
    `);
    await client.query('INSERT INTO payment_providers VALUES ($1,$2)', [providerId, 'pixelpay']);
    for (const migration of ['20261114010000_pixelpay_hosted_qa.sql', '20261114120000_pixelpay_hosted_financial_guard.sql']) {
      await client.query(await readFile(new URL(`../db/migrations/pixel/${migration}`, import.meta.url), 'utf8'));
    }
    async function seed(group = randomUUID()) {
      const id = randomUUID();
      const order = `MF-PIXELPAY-${id.replaceAll('-', '').toUpperCase()}`;
      await client.query('INSERT INTO citas_grupos VALUES ($1) ON CONFLICT DO NOTHING', [group]);
      await client.query('INSERT INTO payment_intents(id_intent,id_provider,id_grupo_cita,orden_compra,monto_hnl) VALUES ($1,$2,$3,$4,100)', [id, providerId, group, order]);
      return { id, group, order };
    }
    async function insertSession(connection, item, expires = new Date(Date.now() + 60000).toISOString()) {
      return connection.query(`INSERT INTO app_private.pixelpay_hosted_sessions(id_intent,id_grupo_cita,order_id,amount_hnl,currency,expires_at)
        VALUES ($1,$2,$3,100,'HNL',$4)`, [item.id, item.group, item.order, expires]);
    }
    function body(item, changes = {}) {
      return { order: item.order, ref: item.order, uuid: 'S-synthetic-reference', status: 'paid', amount: 100, currency: 'HNL',
        payment_hash: createHash('md5').update(`${item.order}|${config.keyId}|${config.secretKey}`).digest('hex'), ...changes };
    }
    await t.test('RLS y permisos no exponen tabla por Data API', async () => {
      const rls = (await client.query("SELECT relrowsecurity FROM pg_class WHERE oid='app_private.pixelpay_hosted_sessions'::regclass")).rows[0];
      assert.equal(rls.relrowsecurity, true);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await client.query("SELECT has_table_privilege($1,'app_private.pixelpay_hosted_sessions','SELECT') allowed", [role])).rows[0].allowed, false);
      }
    });
    const hosted = await seed();
    const hostedOther = await seed(hosted.group);
    await insertSession(client, hosted);
    await client.query("UPDATE payment_intents SET payment_channel='hosted' WHERE id_intent=$1", [hosted.id]);
    await t.test('Sesion unica por grupo, canal e identidad inmutables', async () => {
      await assert.rejects(seed(hosted.group), /MF_HOSTED_GROUP_ORDER_EXISTS/);
      await assert.rejects(insertSession(client, hostedOther), /duplicate key/);
      await assert.rejects(client.query("UPDATE payment_intents SET payment_channel='sdk' WHERE id_intent=$1", [hosted.id]), /MF_HOSTED_PAYMENT_CHANNEL_IMMUTABLE/);
      await assert.rejects(client.query('UPDATE app_private.pixelpay_hosted_sessions SET amount_hnl=101 WHERE id_intent=$1', [hosted.id]), /MF_HOSTED_SESSION_IDENTITY_IMMUTABLE/);
      await assert.rejects(client.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES ($1)', [hostedOther.id]), /MF_HOSTED_PAYMENT_CHANNEL_MISMATCH/);
    });
    await t.test('Callback concurrente duplicado se registra una vez sin pago ni confirmacion', async () => {
      const responses = await Promise.all([processHostedCallback({ db, config, body: body(hosted) }), processHostedCallback({ db, config, body: body(hosted) })]);
      assert.equal(responses.filter(value => value.duplicate).length, 1);
      assert.ok(responses.every(value => !value.processed && value.pending_confirmation && !value.booking_confirmed));
      assert.equal((await client.query('SELECT count(*)::integer count FROM payments')).rows[0].count, 0);
      assert.deepEqual((await client.query('SELECT estado_intent_codigo,paid_at FROM payment_intents WHERE id_intent=$1', [hosted.id])).rows[0], { estado_intent_codigo: 'pendiente_confirmacion', paid_at: null });
    });
    await t.test('Hash/monto/moneda/orden alterados se rechazan sin escritura financiera', async () => {
      for (const [changes, code] of [
        [{ payment_hash: '0'.repeat(32) }, 'PIXELPAY_HOSTED_HASH_INVALID'],
        [{ amount: 101 }, 'PIXELPAY_HOSTED_AMOUNT_MISMATCH'],
        [{ currency: 'USD' }, 'PIXELPAY_HOSTED_CURRENCY_MISMATCH'],
        [{ order: 'MF-PIXELPAY-' + '0'.repeat(32) }, 'PIXELPAY_HOSTED_ORDER_NOT_FOUND'],
      ]) {
        await assert.rejects(processHostedCallback({ db, config, body: body(hosted, changes) }), { code });
      }
      assert.equal((await client.query('SELECT count(*)::integer count FROM payments')).rows[0].count, 0);
    });
    await t.test('Aviso exitoso tardio sobre intent expirado permanece revision', async () => {
      const late = await seed();
      await insertSession(client, late, new Date(Date.now() - 60000).toISOString());
      await client.query("UPDATE payment_intents SET payment_channel='hosted',estado_intent_codigo='expirado' WHERE id_intent=$1", [late.id]);
      await processHostedCallback({ db, config, body: body(late, { status: 'failed' }) });
      const result = await processHostedCallback({ db, config, body: body(late) });
      assert.equal(result.duplicate, false);
      assert.equal(result.booking_confirmed, false);
      assert.equal((await client.query('SELECT late_payment_reported FROM app_private.pixelpay_hosted_sessions WHERE id_intent=$1', [late.id])).rows[0].late_payment_reported, true);
      const duplicate = await processHostedCallback({ db, config, body: body(late) });
      assert.equal(duplicate.duplicate, true);
      await processHostedCallback({ db, config, body: body(late, { status: 'cancelled' }) });
      assert.equal((await client.query('SELECT provider_status_untrusted FROM app_private.pixelpay_hosted_sessions WHERE id_intent=$1', [late.id])).rows[0].provider_status_untrusted, 'paid');
      assert.equal((await client.query('SELECT estado_intent_codigo FROM payment_intents WHERE id_intent=$1', [late.id])).rows[0].estado_intent_codigo, 'expirado');
    });
    for (const sdkFirst of [true, false]) {
      await t.test(`Carrera real transaccional: ${sdkFirst ? 'SDK' : 'Hosted'} primero impide segundo canal`, async () => {
        const first = await seed();
        const second = await seed(first.group);
        const connA = new pg.Client(isolated.connectionOptions);
        const connB = new pg.Client(isolated.connectionOptions);
        await Promise.all([connA.connect(), connB.connect()]);
        try {
          await connA.query('BEGIN');
          if (sdkFirst) await connA.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES ($1)', [first.id]);
          else await insertSession(connA, first);
          const attempted = sdkFirst ? insertSession(connB, second) : connB.query('INSERT INTO app_private.pixelpay_sale_attempts VALUES ($1)', [second.id]);
          const rejected = assert.rejects(attempted, sdkFirst ? /MF_HOSTED_SDK_ATTEMPT_EXISTS/ : /MF_HOSTED_PAYMENT_CHANNEL_MISMATCH/);
          await connA.query('COMMIT');
          await rejected;
        } finally {
          await Promise.all([connA.end(), connB.end()]);
        }
      });
    }
    await t.test('Guard Hosted bloquea promocion financiera pese callback correlacionado', async () => {
      await assert.rejects(client.query("UPDATE payment_intents SET estado_intent_codigo='confirmado',paid_at=now() WHERE id_intent=$1", [hosted.id]), /MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE/);
      await assert.rejects(client.query("INSERT INTO payments VALUES ($1,'capturado',now())", [hosted.id]), /MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE/);
    });
  } finally {
    await isolated.stop();
  }
});
