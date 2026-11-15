import { spawn } from 'node:child_process';
import { startPostgres17 } from '../test/helpers/postgres17.mjs';

// AM: Solo el cluster local efimero creado por el harness; nunca una URL de entorno remoto.
const isolated = await startPostgres17();
try {
  await isolated.client.query('CREATE DATABASE guest_registration_02g');
  const url = `postgresql://postgres@127.0.0.1:${isolated.connectionOptions.port}/guest_registration_02g`;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/guest-registration-qa02g.postgres.test.mjs'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, RUN_GUEST_REGISTRATION_PG_INTEGRATION: 'true',
        MASTERFADE_GUEST_TEST_DISPOSABLE: '02g-ci-only', MASTERFADE_GUEST_TEST_DATABASE_URL: url },
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await isolated.stop();
}
