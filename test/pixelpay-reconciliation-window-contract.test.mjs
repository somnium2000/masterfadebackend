import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../db/migrations/pixel/20260924010000_pixelpay_reconciliation_window.sql",
  import.meta.url
);
const assertUrl = new URL(
  "../db/migrations/pixel/20260924011000_assert_pixelpay_reconciliation_window.sql",
  import.meta.url
);
const behaviorUrl = new URL(
  "./sql/microfase2a2/assert_pixelpay_reconciliation_window_behavior.sql",
  import.meta.url
);

test("la ventana PixelPay reutiliza la configuracion, protege holds y sincroniza el intent", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /agendamiento_confirmacion_pago_gracia_min[\s\S]*valor_numero = 5/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.proteger_reserva_pago_v1/i);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog, app_private/i);
  assert.match(sql, /FOR UPDATE OF c/i);
  assert.match(sql, /FOR UPDATE OF h/i);
  assert.match(sql, /UPDATE public\.citas_holds[\s\S]*expires_at = GREATEST/i);
  assert.match(sql, /SELECT min\(h\.expires_at\)[\s\S]*UPDATE public\.payment_intents/i);
  assert.match(sql, /estado_intent_codigo = 'pendiente_confirmacion'/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE/i);
});

test("la migracion y su assert son reentrantes", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const assertion = await readFile(assertUrl, "utf8");

  assert.match(migration, /CREATE OR REPLACE FUNCTION/i);
  assert.match(migration, /UPDATE public\.parametros_sistema/i);
  assert.match(assertion, /valor_numero = 5/i);
  assert.match(assertion, /proteger_reserva_pago_v1/i);
  assert.match(assertion, /search_path=pg_catalog, app_private/i);
});

test("el escenario PostgreSQL cubre proteccion, expiracion y timestamps antes/despues", async () => {
  const sql = await readFile(behaviorUrl, "utf8");

  assert.match(sql, /interval '5 minutes 10 seconds'/i);
  assert.match(sql, /slot was released inside the protection window/i);
  assert.match(sql, /slot was not released after the protection window/i);
  assert.match(sql, /v_protected_until - interval '1 second'/i);
  assert.match(sql, /v_protected_until \+ interval '1 second'/i);
  assert.match(sql, /MF_PAYMENT_AFTER_HOLD_EXPIRY/i);
  assert.match(sql, /active hold confirmation fabricated paid_at/i);
  assert.match(sql, /ROLLBACK/i);
});
