import { parentPort, workerData } from 'node:worker_threads';
import { installSyntheticProvider } from './delegatedPixelPayProvider.mjs';

// AM: Replace only network transport; execute the unmodified application worker, including input erasure.
const fixture = installSyntheticProvider({ ...workerData, application: true, input: structuredClone(workerData.input) });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => post({ ...message, fixtureStats: fixture.stats });
await import('../../src/experimental/pixelpayDelegated/applicationWorker.js');
