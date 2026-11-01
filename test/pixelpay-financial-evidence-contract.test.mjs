import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicPaymentsUrl = new URL("../src/routes/v1/public/pagos.js", import.meta.url);
const providerUrl = new URL("../src/services/payments/PixelPaySdkProvider.js", import.meta.url);
const membershipUrl = new URL("../src/services/membershipService.js", import.meta.url);
const migrationUrl = new URL(
  "../db/migrations/pixel/20261101025900_financial_paid_at_contract_v2.sql",
  import.meta.url
);

test("Sale persiste evidencia PixelPay canonica antes de reconciliar", async () => {
  const source = await readFile(publicPaymentsUrl, "utf8");

  assert.match(source, /async function persistVerifiedPixelPayEvidence/i);
  assert.match(source, /pixelpay\.sale\.approved_verified/i);
  const helperStart = source.indexOf("async function persistVerifiedPixelPayEvidence");
  const helperEnd = source.indexOf("async function queryAndRegisterPixelPayStatus", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /SELECT[\s\S]*min\(pe\.recibido_at\)[\s\S]*payment_events/i);
  assert.match(helper, /pe\.evento_tipo\s*=\s*'pixelpay\.sale\.approved_verified'/i);
  assert.doesNotMatch(helper, /pixelpay\.status\.paid_verified/i);
  assert.match(source, /paidAt:\s*durableApproval\.verifiedAt/i);
  assert.doesNotMatch(source, /registerPaymentStatusCheck[\s\S]{0,500}paidAt:\s*new Date/i);
});
test("SDK no convierte transaction_date o transaction_time en evidencia temporal", async () => {
  const source = await readFile(providerUrl, "utf8");

  assert.doesNotMatch(source, /verifiedAt\s*:\s*result\?\.transaction_(?:date|time)/i);
  assert.doesNotMatch(source, /paidAt\s*:\s*result\?\.transaction_(?:date|time)/i);
});

test("membresias propagan el primer recibo durable sin fallback de reloj", async () => {
  const source = await readFile(membershipUrl, "utf8");

  assert.match(source, /ORDER BY pe\.recibido_at ASC/i);
  assert.match(source, /SELECT to_char\(min\(pe\.recibido_at\)/i);
  assert.doesNotMatch(source, /COALESCE\(\$6::timestamptz,\s*now\(\)\)/i);
  assert.doesNotMatch(source, /SET estado_orden_codigo = 'pagada',[\s\S]{0,120}paid_at = now\(\)/i);
});

test("migracion exige evidencia explicita y bloquea nuevos pagos manuales", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /MF_PAYMENT_PAID_AT_REQUIRED/i);
  assert.match(sql, /MF_MANUAL_PAYMENT_DISABLED/i);
  assert.match(sql, /NEW\.estado_pago_codigo\s*=\s*'manual_pagado'/i);
  assert.match(sql, /NEW\.registrado_manualmente\s+IS\s+TRUE/i);
  assert.doesNotMatch(sql, /NEW\.paid_at\s*:=\s*(?:now|clock_timestamp)\(\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+public\.payments[\s\S]*SET\s+paid_at/i);
});

test("migracion usa exclusivamente el origen real membership", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /origen_pago_codigo\s*=\s*'membership'/i);
  assert.match(sql, /v_origin_code\s*=\s*'membership'/i);
  assert.doesNotMatch(sql, /'membresia'/i);
});
