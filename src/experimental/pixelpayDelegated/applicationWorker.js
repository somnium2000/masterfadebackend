import { parentPort, workerData } from 'node:worker_threads';
import { createDelegatedSession } from './session.js';

if (parentPort) {
  const { config, input, attemptId } = workerData;
  // Only the private commerce admission may instantiate the Live worker.
  // SDK provider still enforces the configured keys and app_url server-side.
  const endpoint = String(config.endpoint || '').replace(/\/$/, '');
  const appUrl = String(config.appUrl || '').replace(/\/$/, '');
  const sandbox = config.env === 'sandbox'
    && endpoint === 'https://pixelpay.dev' && appUrl === 'https://pixelpay.dev';
  const live = config.env === 'live'
    && endpoint.startsWith('https://') && appUrl.startsWith('https://')
    && endpoint !== 'https://pixelpay.dev' && appUrl !== 'https://pixelpay.dev';
  if (!sandbox && !live) throw new Error('PIXELPAY_DELEGATED_ENVIRONMENT_INVALID');
  const session = createDelegatedSession({ config, input, attemptId, application: true });
  // AM: The SDK request owns the transient card fields. Keep no second plaintext copy in workerData.
  delete input.card;
  delete input.billing;
  delete input.customer;
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, operation, data }) => {
    queue = queue.then(async () => {
      try {
        parentPort.postMessage({ id, value: await session.execute(operation, data) });
      } catch {
        parentPort.postMessage({ id, error: 'PIXELPAY_DELEGATED_UNCERTAIN' });
      }
    });
  });
}
