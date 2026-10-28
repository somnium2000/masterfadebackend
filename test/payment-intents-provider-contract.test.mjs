import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/pixel/20260923010000_payment_intents_provider_contract.sql",
  import.meta.url
);

test("migration payment_intents es reentrante y conserva identificadores provider-agnostic", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const column of [
    "orden_compra text",
    "provider_session_id text",
    "launch_expires_at timestamptz",
    "last_verified_at timestamptz",
    "verification_attempts integer NOT NULL DEFAULT 0",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
  }

  assert.match(sql, /IF NOT EXISTS\s*\([\s\S]*ck_payment_intents_verification_attempts_nonnegative/i);
  assert.match(sql, /CHECK \(verification_attempts >= 0\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_order/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_session/i);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/i);
  assert.doesNotMatch(sql, /pixelpay/i);
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i);
});
