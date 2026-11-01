import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startBookingDeadlockPostgres17 } from "./support/bookingDeadlockPostgres17.mjs";

const RUN = process.env.RUN_PRODUCTION_READINESS_PG === "true";
const financialPath = "db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql";
const structuralPath = "db/migrations/20261101025903_production_structural_alignment_v1.sql";
const securityPath = "db/migrations/20261101025905_security_definer_trigger_lockdown_v1.sql";
const structuralPaths = [
  "db/migrations/pixel/20261011043911_pixelpay_sale_attempts.sql",
  "db/migrations/pixel/20261016010000_pixelpay_uncertain_observed_identifiers.sql",
  "db/migrations/pixel/20261018010000_pixelpay_observed_payment_uuid_opaque.sql",
  "db/migrations/pixel/20261028010000_pixelpay_provider_response_code.sql",
  "db/migrations/20261019010000_guest_registration_requests.sql",
  structuralPath,
];

test("contratos SQL no inventan evidencia ni eliminan protecciones", async () => {
  const financial = await readFile(new URL(`../${financialPath}`, import.meta.url), "utf8");
  const structural = await readFile(new URL(`../${structuralPath}`, import.meta.url), "utf8");
  assert.doesNotMatch(financial, /(?:now|clock_timestamp)\s*\(/i);
  assert.match(financial, /MF_PAYMENT_PAID_AT_REQUIRED/);
  assert.match(financial, /min\(p\.paid_at\)/);
  assert.doesNotMatch(structural, /DROP CONSTRAINT ck_payment_intents_/i);
  assert.match(structural, /eliminacion_cuenta/);
  assert.match(structural, /MF_MEMBERSHIP_IDEMPOTENCY_DUPLICATES/);
  assert.match(structural, /ADD COLUMN idempotency_key text[\s\S]*MF_MEMBERSHIP_IDEMPOTENCY_DUPLICATES/);
  assert.doesNotMatch(structural, /WHERE idempotency_key IS NOT NULL[\s\S]*ADD COLUMN idempotency_key/i);
});

test("PostgreSQL 17: seis migraciones estructurales reproducen Produccion y conservan finanzas", { skip: !RUN }, async (t) => {
  const isolated = await startBookingDeadlockPostgres17();
  const { pool } = isolated;
  try {
    await isolated.sqlFile("test/fixtures/production-readiness-schema.sql");
    const protectedBefore = (await pool.query("SELECT conname, pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid='public.payment_intents'::regclass AND conname LIKE 'ck_payment_intents_%' ORDER BY conname")).rows;
    const financialBefore = (await pool.query("SELECT p.proname, pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fn_trg_validar_pago_monto_tiempo','fn_payment_intents_capture_paid_at') ORDER BY p.proname")).rows;

    await t.test("rollback revierte tambien la columna creada antes del preflight", async () => {
      await pool.query("ALTER TABLE payment_intents DROP CONSTRAINT ck_payment_intents_provider_session_not_blank");
      await assert.rejects(isolated.sqlFile(structuralPath), /psql:/);
      assert.equal((await pool.query("SELECT to_regclass('public.membership_purchase_orders') IS NOT NULL AS table_exists")).rows[0].table_exists, true);
      assert.equal((await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='membership_purchase_orders' AND column_name='idempotency_key') present")).rows[0].present, false);
      await pool.query("ALTER TABLE payment_intents ADD CONSTRAINT ck_payment_intents_provider_session_not_blank CHECK (provider_session_id IS NULL OR btrim(provider_session_id) <> '')");
    });

    for (const path of structuralPaths) await isolated.sqlFile(path);

    await t.test("pixelpay_sale_attempts coincide con el contrato QA acumulado", async () => {
      const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='app_private' AND table_name='pixelpay_sale_attempts' ORDER BY ordinal_position")).rows.map(r => r.column_name);
      for (const expected of ['observed_payment_uuid_untrusted','observed_transaction_id_untrusted','observed_transaction_reference_untrusted','provider_response_code']) assert.ok(columns.includes(expected), expected);
      const constraints = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='app_private.pixelpay_sale_attempts'::regclass ORDER BY conname")).rows.map(r => r.conname);
      for (const expected of ['ck_pixelpay_sale_attempts_observed_payment_uuid','ck_pixelpay_sale_attempts_provider_response_code','fk_pixelpay_sale_attempts_intent']) assert.ok(constraints.includes(expected), expected);
      const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='app_private' AND tablename='pixelpay_sale_attempts'")).rows.map(r => r.indexname);
      for (const expected of ['idx_pixelpay_sale_attempts_intent_created','idx_pixelpay_sale_attempts_unfinalized']) assert.ok(indexes.includes(expected), expected);
    });

    await t.test("membresias, guest y eliminacion de cuenta quedan alineados", async () => {
      assert.equal((await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='membership_purchase_orders' AND column_name='idempotency_key') present")).rows[0].present, true);
      assert.equal((await pool.query("SELECT to_regclass('app_private.guest_registration_requests') IS NOT NULL present")).rows[0].present, true);
      for (const table of ['subscriptions','seguridad_sesiones']) {
        const definition = (await pool.query("SELECT pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2", [`public.${table}`, table === 'subscriptions' ? 'ck_sub_motivo_fin' : 'ck_seg_sesiones_motivo_cierre'])).rows[0].definition;
        assert.match(definition, /eliminacion_cuenta/);
      }
    });

    assert.deepEqual((await pool.query("SELECT conname, pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid='public.payment_intents'::regclass AND conname LIKE 'ck_payment_intents_%' ORDER BY conname")).rows, protectedBefore);
    assert.deepEqual((await pool.query("SELECT p.proname, pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fn_trg_validar_pago_monto_tiempo','fn_payment_intents_capture_paid_at') ORDER BY p.proname")).rows, financialBefore);
  } finally {
    await isolated.stop();
  }
});

test("PostgreSQL 17: migraciones fail-closed, idempotencia, ACL y paid_at", { skip: !RUN }, async (t) => {
  const isolated = await startBookingDeadlockPostgres17();
  const { pool } = isolated;
  try {
    await isolated.sqlFile("test/fixtures/production-readiness-schema.sql");
    const financialSql = await readFile(new URL(`../${financialPath}`, import.meta.url), "utf8");
    await pool.query("INSERT INTO membership_purchase_orders(id_order,id_cliente,estado_orden_codigo) VALUES ('70000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','pagada')");
    const validatorBefore = (await pool.query("SELECT pg_get_functiondef('public.fn_trg_validar_pago_monto_tiempo()'::regprocedure) definition")).rows[0].definition;
    await assert.rejects(pool.query(financialSql), /MF_FINANCIAL_EVIDENCE_PREFLIGHT_FAILED/);
    assert.equal((await pool.query("SELECT pg_get_functiondef('public.fn_trg_validar_pago_monto_tiempo()'::regprocedure) definition")).rows[0].definition, validatorBefore);
    assert.equal((await pool.query("SELECT count(*)::int count FROM membership_purchase_orders WHERE estado_orden_codigo='pagada' AND paid_at IS NULL")).rows[0].count, 1);
    await pool.query("DELETE FROM membership_purchase_orders WHERE id_order='70000000-0000-4000-8000-000000000001'");
    const protectedBefore = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='public.payment_intents'::regclass AND conname LIKE 'ck_payment_intents_%' ORDER BY conname")).rows;
    await isolated.sqlFile(financialPath);
    await isolated.sqlFile(structuralPath);
    await isolated.sqlFile(securityPath);

    await t.test("conserva las tres restricciones protectoras", async () => {
      assert.deepEqual((await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='public.payment_intents'::regclass AND conname LIKE 'ck_payment_intents_%' ORDER BY conname")).rows, protectedBefore);
    });
    await t.test("rechaza pago final sin evidencia durable", async () => {
      await pool.query("INSERT INTO citas VALUES ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001')");
      await pool.query("INSERT INTO citas_holds VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-11-01T01:05:00Z','activo')");
      await pool.query("INSERT INTO payment_intents(id_intent,id_cita,id_grupo_cita,id_hold,monto_hnl,moneda_codigo,expires_at,estado_intent_codigo) VALUES ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',100,'HNL','2026-11-01T01:05:00Z','pendiente_confirmacion')");
      await assert.rejects(pool.query("INSERT INTO payments(id_intent,estado_pago_codigo,monto_hnl,moneda_codigo) VALUES ('40000000-0000-4000-8000-000000000001','capturado',100,'HNL')"), /MF_PAYMENT_PAID_AT_REQUIRED/);
    });
    await t.test("evidencia exacta al vencimiento es valida y la posterior es tardia", async () => {
      const exact = await pool.query("INSERT INTO payments(id_intent,estado_pago_codigo,monto_hnl,moneda_codigo,paid_at) VALUES ('40000000-0000-4000-8000-000000000001','capturado',100,'HNL','2026-11-01T01:05:00Z') RETURNING pago_tardio");
      assert.equal(exact.rows[0].pago_tardio, false);
      const late = await pool.query("INSERT INTO payments(id_intent,estado_pago_codigo,monto_hnl,moneda_codigo,paid_at) VALUES ('40000000-0000-4000-8000-000000000001','capturado',100,'HNL','2026-11-01T01:05:00.001Z') RETURNING pago_tardio");
      assert.equal(late.rows[0].pago_tardio, true);
    });
    await t.test("confirmacion toma la primera evidencia persistida", async () => {
      const row = await pool.query("UPDATE payment_intents SET estado_intent_codigo='confirmado' WHERE id_intent='40000000-0000-4000-8000-000000000001' RETURNING paid_at");
      assert.equal(row.rows[0].paid_at.toISOString(), "2026-11-01T01:05:00.000Z");
    });
    await t.test("indice de membresia es realmente unico", async () => {
      await pool.query("INSERT INTO membership_purchase_orders(id_order,id_cliente,idempotency_key) VALUES ('50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','same-key')");
      await assert.rejects(pool.query("INSERT INTO membership_purchase_orders(id_order,id_cliente,idempotency_key) VALUES ('50000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001','same-key')"), /duplicate key/);
    });
    await t.test("funciones trigger ya no son ejecutables por clientes", async () => {
      const acl = await pool.query("SELECT has_function_privilege('anon','public.fn_hold_defaults_y_unico()','EXECUTE') anon, has_function_privilege('authenticated','public.fn_citas_detalles_line_identity_v2()','EXECUTE') authenticated");
      assert.deepEqual(acl.rows[0], { anon: false, authenticated: false });
    });
  } finally {
    await isolated.stop();
  }
});
