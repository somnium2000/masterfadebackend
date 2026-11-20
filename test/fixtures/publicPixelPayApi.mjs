import assert from 'node:assert/strict';
import net from 'node:net';
import { DelegatedAttempt } from '../../src/experimental/pixelpayDelegated/attempt.js';
import { createPagosApp, diagnosticRouteClient } from '../helpers/publicPagosFixture.mjs';

// AM: Full node --test discovery imports fixtures too; start only with an explicit synthetic scenario.
export async function startPublicPixelPayApi(scenario) {
  assert.ok(['challenge', 'frictionless', 'songbird', 'collection-untrusted', 'songbird-continue-false', 'bad-hash'].includes(scenario));
  const cleanups = [], calls = [], logs = [];
  const client = diagnosticRouteClient({ optionsPublic3ds: true });
  let stats, external = 0;
  const app = await createPagosApp(client, {
    providerCode: 'pixelpay', authenticated: true, logs, config: { pixelPayEnv: 'live' },
    privatePilot: { t: { after: fn => cleanups.push(fn) }, enabled: false, publicCommerce: { bookingEnabled: true } },
    providerAdapter: { env: 'live', endpoint: 'https://offline-pixelpay.invalid', appUrl: 'https://offline-shop.invalid',
      keyId: 'synthetic-key', secretKey: 'synthetic-secret', authHash: 'synthetic-hash',
      sale() { assert.fail('LEGACY_SALE_FORBIDDEN'); }, queryPaymentStatus() { assert.fail('EXTERNAL_STATUS_FORBIDDEN'); } },
    public3dsAttemptFactory: options => {
      const worker = new DelegatedAttempt({ ...options,
        workerUrl: new URL('./publicPixelPayApplicationWorker.mjs', import.meta.url),
        context: { ...options.context, scenario },
      });
      worker.worker.on('message', message => { if (message.fixtureStats) stats = message.fixtureStats; });
      return { close: () => worker.close(), async call(operation, data) {
        calls.push(operation);
        return worker.call(operation, data);
      } };
    },
  });
  app.get('/__fixture__/state', async () => ({ calls, stats, external,
    phases: logs.map(line => JSON.parse(line)).filter(row => row.event === 'pixelpay_public_3ds_phase')
      .map(({ phase, state, continuation_diagnostic }) => ({ phase, state, continuation_diagnostic })),
    payments: client.getPayments().length,
    confirmations: client.getGroupState().filter(row => row.estado_cita_codigo === 'confirmada').length,
    dispatches: client.getPaymentEvents().filter(row => row.evento_tipo === 'pixelpay.sale.3ds_continuation_dispatched').length,
    saleAttempts: client.getSaleAttempts().length,
  }));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  // AM: Server and worker deny all external sockets. Only the test browser connects to this loopback listener.
  net.Socket.prototype.connect = function () { external++; throw new Error('EXTERNAL_BLOCKED'); };
  process.stdout.write(JSON.stringify({ address, headers: app.pilotRequest.headers }) + '\n');
  process.stdin.resume();
  process.stdin.once('end', async () => {
    await app.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
}

if (process.argv[2]) await startPublicPixelPayApi(process.argv[2]);
