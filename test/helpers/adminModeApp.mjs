import Fastify from 'fastify';
import fp from 'fastify-plugin';
import gate from '../../src/plugins/adminDataEntry.js';

export async function adminModeApp() {
  const app = Fastify();
  await app.register(fp(async instance => {
    instance.decorate('config', { adminDataEntryMode: true, paymentProvider: 'disabled' });
  }, { name: 'env-plugin' }));
  await app.register(gate);
  return app;
}
