import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CONFIG_SCRIPT = `
  const module = await import('./src/config/db-connection.js');
  const db = module.getDbConfig();
  const listen = module.getDbListenConfig();
  process.stdout.write(JSON.stringify({
    dbRejectUnauthorized: db.ssl?.rejectUnauthorized,
    dbPort: db.port ?? new URL(db.connectionString).port,
    listenPort: listen.port ?? new URL(listen.connectionString).port,
  }));
`;

function runConfig(overrides = {}) {
  const env = {
    ...process.env,
    DATABASE_URL: "",
    DATABASE_LISTEN_URL: "",
    DB_HOST: "aws-0-us-east-1.pooler.supabase.com",
    DB_PORT: "5432",
    DB_USER: "postgres.jgipiyhjtpgyaujfhghf",
    DB_PASSWORD: "test-only-password",
    DB_NAME: "postgres",
    DB_SSL: "true",
    DB_SSL_REJECT_UNAUTHORIZED: "true",
    SUPABASE_URL: "https://jgipiyhjtpgyaujfhghf.supabase.co",
    NODE_ENV: "development",
    ENTORNO: "development",
    ...overrides,
  };

  return spawnSync(process.execPath, ["--input-type=module", "--eval", CONFIG_SCRIPT], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("acepta pooler de sesion cuando DB_USER coincide con SUPABASE_URL", () => {
  const config = assertSuccess(runConfig());
  assert.equal(config.dbPort, 5432);
  assert.equal(config.listenPort, 5432);
  assert.equal(config.dbRejectUnauthorized, true);
});

test("acepta pooler transaccional con DATABASE_LISTEN_URL de sesion del mismo proyecto", () => {
  const config = assertSuccess(runConfig({
    DATABASE_URL: "postgresql://postgres.jgipiyhjtpgyaujfhghf:test-only-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    DATABASE_LISTEN_URL: "postgresql://postgres.jgipiyhjtpgyaujfhghf:test-only-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  }));

  assert.equal(config.dbPort, "6543");
  assert.equal(config.listenPort, "5432");
});

test("rechaza pooler cuando DB_USER pertenece a otro proyecto", () => {
  const result = runConfig({ DB_USER: "postgres.otroproyecto" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DB_USER usa PROJECT_REF/);
});

for (const environment of ["production", "staging"]) {
  test(`rechaza TLS sin validacion de certificado en ${environment}`, () => {
    const result = runConfig({
      NODE_ENV: environment,
      ENTORNO: environment,
      DB_SSL_REJECT_UNAUTHORIZED: "false",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DB_SSL_REJECT_UNAUTHORIZED debe estar activado/);
  });

  test(`rechaza DB_SSL desactivado en ${environment}`, () => {
    const result = runConfig({
      NODE_ENV: environment,
      ENTORNO: environment,
      DB_SSL: "false",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DB_SSL no puede estar desactivado/);
  });
}

test("mantiene disponible TLS sin validacion solo en desarrollo", () => {
  const config = assertSuccess(runConfig({ DB_SSL_REJECT_UNAUTHORIZED: "false" }));
  assert.equal(config.dbRejectUnauthorized, false);
});
