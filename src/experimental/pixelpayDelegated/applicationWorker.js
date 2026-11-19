import { parentPort, workerData } from 'node:worker_threads';
import { createDelegatedSession } from './session.js';

if (parentPort) {
  const { config, input, attemptId } = workerData;
  // AM: Real Sandbox transport is available only through the QA application entry point.
  if (config.env !== 'sandbox' || config.endpoint.replace(/\/$/, '') !== 'https://pixelpay.dev') {
    throw new Error('PIXELPAY_DELEGATED_SANDBOX_REQUIRED');
  }
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
