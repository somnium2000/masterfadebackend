import { Worker } from 'node:worker_threads';

// AM: One worker per attempt isolates every SDK import and its static runningTransaction.
// No production route imports this prototype. workerUrl and context are server-owned.
export class DelegatedAttempt {
  constructor({ workerUrl, context, timeoutMs = 15000, lifetimeMs = 120000 }) {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.timeoutMs = timeoutMs;
    this.worker = new Worker(workerUrl, { workerData: context });
    this.worker.on('message', ({ id, value, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (error) pending.reject(new Error('PROTOTYPE_UNCERTAIN'));
      else pending.resolve(value);
    });
    this.worker.on('error', () => this.close());
    this.worker.on('exit', () => this.close());
    this.expiry = setTimeout(() => this.close(), lifetimeMs);
  }

  call(operation, data = {}) {
    if (this.closed) return Promise.reject(new Error('PROTOTYPE_CONTEXT_LOST'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, operation, data });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiry);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('PROTOTYPE_CONTEXT_LOST'));
    }
    this.pending.clear();
    void this.worker.terminate();
  }
}
