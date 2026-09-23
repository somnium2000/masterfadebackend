import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/pixel/20260923020000_payment_status_checks_v1.sql",
  import.meta.url
);

test("payment status checks conserva historial 4FN y un unico punto de resumen", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_private\.payment_status_checks/i);
  assert.match(sql, /FOREIGN KEY \(id_intent\)[\s\S]*REFERENCES public\.payment_intents\(id_intent\)/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.registrar_payment_status_check_v1/i);
  assert.match(sql, /INSERT INTO app_private\.payment_status_checks/i);
  assert.match(sql, /verification_attempts = COALESCE\(verification_attempts, 0\) \+ 1/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.registrar_payment_status_check_v1/i);
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*pixelpay/i);
  assert.doesNotMatch(sql, /^\s*(?:pan|cvv|secret_key|auth_hash|client_signature)\s+(?:text|varchar|jsonb?)/im);
});
