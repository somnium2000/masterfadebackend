import { parentPort, workerData } from 'node:worker_threads';
import { installSyntheticProvider } from './delegatedPixelPayProvider.mjs';
import { createDelegatedSession } from '../../src/experimental/pixelpayDelegated/session.js';

// AM: This worker is exclusively a desktop fixture. It cannot contact a real provider.
if (parentPort) {
  const fixture = installSyntheticProvider(workerData);
  const session = createDelegatedSession(workerData);
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, operation, data }) => {
    queue = queue.then(async () => {
      try {
        const value = operation === 'inspect' ? fixture.stats : await session.execute(operation, data);
        parentPort.postMessage({ id, value });
      } catch { parentPort.postMessage({ id, error: 'PROTOTYPE_UNCERTAIN' }); }
    });
  });
}
