import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import envPlugin, { resolveBookingReleaseTokenSecret } from "../src/plugins/env.js";
import { buildDeterministicPublicReleaseToken } from "../src/services/bookingCanonicalReservationService.js";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  process.env = { ...ORIGINAL_ENV };
}

function applyBaseEnv(overrides = {}) {
  restoreEnv();
  Object.assign(process.env, {
    NODE_ENV: "development",
    ENTORNO: "development",
    FRONTEND_URL: "http://localhost:5173",
    JWT_SECRET: "jwt-secret-minimo-para-test-32",
    COOKIE_SECRET: "cookie-secret-minimo-para-test-32",
    CSRF_SECRET: "csrf-secret-minimo-para-test-32",
    PAYMENT_PROVIDER: "mock",
    TODOPAGO_MODE: "preprod_simulated",
    AUTH_COOKIE_SECURE: "false",
    DB_TEST_CONNECTION: "false",
    BOOKING_RELEASE_TOKEN_SECRET: "a".repeat(64),
    ...overrides,
  });
}

async function registerEnv(overrides = {}) {
  applyBaseEnv(overrides);
  const app = Fastify({ logger: false });
  try {
    await app.register(envPlugin);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

test.afterEach(() => {
  restoreEnv();
});

test("development sin BOOKING_RELEASE_TOKEN_SECRET falla antes de iniciar", async () => {
  await assert.rejects(
    registerEnv({ BOOKING_RELEASE_TOKEN_SECRET: "" }),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("development con secreto vacio falla al cargar env", async () => {
  await assert.rejects(
    registerEnv({ BOOKING_RELEASE_TOKEN_SECRET: "   " }),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("development con secreto de 31 caracteres falla al cargar env", async () => {
  await assert.rejects(
    registerEnv({ BOOKING_RELEASE_TOKEN_SECRET: "a".repeat(31) }),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("development con secreto de 32 caracteres inicia", async () => {
  const app = await registerEnv({ BOOKING_RELEASE_TOKEN_SECRET: "b".repeat(32) });
  try {
    assert.equal(app.config.bookingReleaseTokenSecret.length, 32);
  } finally {
    await app.close();
  }
});

test("development con secreto de 64 caracteres inicia", async () => {
  const app = await registerEnv({ BOOKING_RELEASE_TOKEN_SECRET: "c".repeat(64) });
  try {
    assert.equal(app.config.bookingReleaseTokenSecret.length, 64);
  } finally {
    await app.close();
  }
});

test("staging sin secreto falla al cargar env", async () => {
  await assert.rejects(
    registerEnv({
      NODE_ENV: "staging",
      ENTORNO: "staging",
      FRONTEND_URL: "https://masterfadeapp.com",
      AUTH_COOKIE_SECURE: "true",
      BOOKING_RELEASE_TOKEN_SECRET: "",
    }),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("production sin secreto falla al cargar env", async () => {
  await assert.rejects(
    registerEnv({
      NODE_ENV: "production",
      ENTORNO: "production",
      FRONTEND_URL: "https://masterfadeapp.com",
      AUTH_COOKIE_SECURE: "true",
      BOOKING_RELEASE_TOKEN_SECRET: "",
    }),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("test sin secreto usa solo secreto deterministico de pruebas", () => {
  restoreEnv();
  delete process.env.BOOKING_RELEASE_TOKEN_SECRET;
  const secret = resolveBookingReleaseTokenSecret("test");
  assert.equal(secret, "masterfade-test-release-token-secret-32");
  assert.ok(secret.length >= 32);
});

test("resolveBookingReleaseTokenSecret rechaza secreto ausente fuera de test", () => {
  restoreEnv();
  delete process.env.BOOKING_RELEASE_TOKEN_SECRET;
  assert.throws(
    () => resolveBookingReleaseTokenSecret("development"),
    /BOOKING_RELEASE_TOKEN_SECRET debe contener al menos 32 caracteres/
  );
});

test("buildDeterministicPublicReleaseToken es deterministico y sensible a requestId y secreto", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const otherRequestId = "22222222-2222-4222-8222-222222222222";
  const secret = "d".repeat(64);
  const otherSecret = "e".repeat(64);

  const first = buildDeterministicPublicReleaseToken(requestId, secret);
  const replay = buildDeterministicPublicReleaseToken(requestId, secret);
  const differentRequest = buildDeterministicPublicReleaseToken(otherRequestId, secret);
  const differentSecret = buildDeterministicPublicReleaseToken(requestId, otherSecret);

  assert.equal(first, replay);
  assert.notEqual(first, differentRequest);
  assert.notEqual(first, differentSecret);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("buildDeterministicPublicReleaseToken rechaza secreto vacio y corto sin filtrarlo", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const shortSecret = "short-secret-value";

  assert.throws(
    () => buildDeterministicPublicReleaseToken(requestId, ""),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, "BOOKING_RELEASE_TOKEN_SECRET_REQUIRED");
      assert.equal(String(error.message || "").includes(shortSecret), false);
      return true;
    }
  );

  assert.throws(
    () => buildDeterministicPublicReleaseToken(requestId, shortSecret),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, "BOOKING_RELEASE_TOKEN_SECRET_REQUIRED");
      assert.equal(String(error.message || "").includes(shortSecret), false);
      assert.equal(String(error.stack || "").includes(shortSecret), false);
      return true;
    }
  );
});
