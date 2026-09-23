import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/20260923030000_audit_function_search_path.sql",
  import.meta.url
);
const assertionUrl = new URL(
  "./sql/microfase2a2/assert_audit_function_search_path.sql",
  import.meta.url
);

test("migracion fija el search_path de auditoria sin alterar cuerpo, privilegios ni triggers", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/i);
  assert.match(sql, /SET LOCAL statement_timeout = '120s'/i);
  assert.match(sql, /to_regprocedure\('public\.fn_auditar_bitacora\(\)'\)/i);
  assert.match(sql, /ALTER FUNCTION public\.fn_auditar_bitacora\(\)\s+SET search_path = pg_catalog, public;/i);
  assert.match(sql, /COMMIT;/i);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION|SECURITY DEFINER|ALTER TRIGGER|DROP TRIGGER/i);
});

test("assert exige funcion invoker y search_path exacto", async () => {
  const sql = await readFile(assertionUrl, "utf8");

  assert.match(sql, /NOT p\.prosecdef/i);
  assert.match(sql, /p\.proconfig = ARRAY\['search_path=pg_catalog, public'\]::text\[\]/i);
});
