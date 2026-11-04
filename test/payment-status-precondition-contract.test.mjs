import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/pixel/20261104013000_payment_status_checks_precondition_failed.sql",
  import.meta.url
);

test("payment status checks acepta precondicion_fallida sin ampliar permisos", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /DROP CONSTRAINT IF EXISTS ck_payment_status_checks_resultado/i);
  assert.match(sql, /ADD CONSTRAINT ck_payment_status_checks_resultado[\s\S]*precondicion_fallida/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.registrar_payment_status_check_v1/i);
  assert.match(sql, /p_resultado_consulta_codigo NOT IN \([\s\S]*precondicion_fallida[\s\S]*\) THEN/i);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog, app_private\s+AS \$mf\$/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.registrar_payment_status_check_v1/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.registrar_payment_status_check_v1[\s\S]*TO postgres/i);
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|EXECUTE)[\s\S]*TO\s+(?:PUBLIC|anon|authenticated|service_role)/i);
});

test("lista de resultados conserva valores existentes y solo agrega precondicion_fallida", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const value of [
    "ok",
    "timeout",
    "error_red",
    "error_proveedor",
    "respuesta_invalida",
    "precondicion_fallida",
  ]) {
    assert.match(sql, new RegExp(`'${value}'`, "i"));
  }
  assert.match(sql, /MESSAGE = 'PAYMENT_STATUS_CHECK_RESULT_INVALID'/i);
});
