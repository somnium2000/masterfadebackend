import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { startBookingDeadlockPostgres17 } from "./support/bookingDeadlockPostgres17.mjs";

const RUN = process.env.RUN_PRODUCTION_READINESS_PG === "true";
const financialPath = "db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql";
const structuralPath = "db/migrations/20261101025903_production_structural_alignment_v1.sql";
const securityPath = "db/migrations/20261101025905_security_definer_trigger_lockdown_v1.sql";

test("contratos SQL no inventan evidencia ni eliminan protecciones", async () => {
  const financial = await readFile(new URL(`../${financialPath}`, import.meta.url), "utf8");
  const structural = await readFile(new URL(`../${structuralPath}`, import.meta.url), "utf8");
  assert.doesNotMatch(financial, /(?:now|clock_timestamp)\s*\(/i);
  assert.match(financial, /MF_PAYMENT_PAID_AT_REQUIRED/);
  assert.match(financial, /min\(p\.paid_at\)/);
  assert.doesNotMatch(structural, /DROP CONSTRAINT ck_payment_intents_/i);
  assert.match(structural, /eliminacion_cuenta/);
  assert.match(structural, /MF_MEMBERSHIP_IDEMPOTENCY_DUPLICATES/);
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
