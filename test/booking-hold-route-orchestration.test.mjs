import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

async function readRoute(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function extractHoldHandler(source) {
  const start = source.indexOf('"/hold"');
  assert.notEqual(start, -1);
  const nextRoute = source.indexOf("\n  app.", start + 1);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

test("hold publico delega transaccion al orquestador sin BEGIN/COMMIT/ROLLBACK local", async () => {
  const source = await readRoute("src/routes/v1/public/citas.js");
  const handler = extractHoldHandler(source);
  assert.match(handler, /createBookingHold\(\{/);
  assert.doesNotMatch(handler, /dbClient\.query\("BEGIN"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("COMMIT"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("ROLLBACK"\)/);
  assert.match(handler, /PUBLIC_HOLD_IDEMPOTENCY_SCOPE/);
  assert.match(handler, /release_token/);
  assert.doesNotMatch(handler, /membresia:/);
  assert.doesNotMatch(handler, /recompensa:/);
});

test("hold autenticado delega transaccion al orquestador sin BEGIN/COMMIT/ROLLBACK local", async () => {
  const source = await readRoute("src/routes/v1/citas.js");
  const handler = extractHoldHandler(source);
  assert.match(handler, /createBookingHold\(\{/);
  assert.doesNotMatch(handler, /dbClient\.query\("BEGIN"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("COMMIT"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("ROLLBACK"\)/);
  assert.match(handler, /AUTH_HOLD_IDEMPOTENCY_SCOPE/);
  assert.match(handler, /membresia:/);
  assert.match(handler, /recompensa:/);
  assert.doesNotMatch(handler, /release_token/);
});

test("hold administrativo delega al servicio de agendamiento interno sin transacciones locales", async () => {
  const source = await readRoute("src/routes/v1/admin/citas.js");
  const handler = extractHoldHandler(source);
  assert.match(handler, /createAdminBookingHold\(app, request\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("BEGIN"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("COMMIT"\)/);
  assert.doesNotMatch(handler, /dbClient\.query\("ROLLBACK"\)/);
  assert.match(handler, /app\.requireRoles\(CONFIG_ALLOWED_ROLES\)/);
  assert.doesNotMatch(handler, /release_token/);
  assert.doesNotMatch(handler, /membresia:/);
  assert.doesNotMatch(handler, /recompensa:/);
});
