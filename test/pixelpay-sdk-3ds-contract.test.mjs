import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const load = (name) => require(`@pixelpay/sdk-core/lib/${name}`).default;
const Transaction = load('services/Transaction');
const SaleTransaction = load('requests/SaleTransaction');
const ServiceBehaviour = load('base/ServiceBehaviour');
const Helpers = load('base/Helpers');
const CardinalManager = load('libraries/CardinalManager');
const LookupTransaction = load('requests/LookupTransaction');
const Loading = load('libraries/PixelPayLoading');
const Modal = load('libraries/PixelPayModal');
const Settings = load('models/Settings');
const approvedData = {
  payment_uuid: 'P-SYNTHETIC', transaction_id: 'TX-SYNTHETIC',
  response_approved: true, response_code: '00', transaction_amount: '1.00',
};
const parse = (status, data, action = null) => new ServiceBehaviour({})
  .parseResponse({ success: status === 200, data, action }, status);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// AM: These stubs characterize SDK control flow; they do not authenticate a real card or browser.
async function withContractFixture(run) {
  const globalNames = ['window', 'document'];
  const descriptors = globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const originals = {
    post: ServiceBehaviour.prototype.post,
    script: Helpers.addScriptToWebsite,
    form: Helpers.addSecureForm,
    remove: Helpers.removeElementById,
    emv: LookupTransaction.prototype.setRequiredEMVFields,
    show: Loading.show, hide: Loading.hide,
    modalShow: Modal.show, modalHide: Modal.hide,
    connect: net.Socket.prototype.connect,
  };
  const handlers = new Map();
  const calls = { routes: [], scripts: [], forms: 0, challenges: 0, socketAttempts: 0 };
  const documentFixture = {};
  const windowFixture = {
    document: documentFixture,
    Cardinal: {
      configure() {}, setup() {},
      on(name, callback) { handlers.set(name, callback); },
      off(name) { handlers.delete(name); },
      continue() { calls.challenges++; },
    },
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name) { handlers.delete(name); },
  };
  Object.defineProperty(globalThis, 'window', { value: windowFixture, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: documentFixture, configurable: true });
  Helpers.addScriptToWebsite = async (url) => { calls.scripts.push(url); };
  Helpers.addSecureForm = () => ({ submit() { calls.forms++; } });
  Helpers.removeElementById = () => {};
  LookupTransaction.prototype.setRequiredEMVFields = () => {};
  Loading.show = Loading.hide = Modal.show = Modal.hide = () => {};
  net.Socket.prototype.connect = function () {
    calls.socketAttempts++;
    throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
  };
  const settings = new Settings();
  settings.endpoint = 'https://provider.invalid';
  settings.setupSandbox();
  const sale = new SaleTransaction();
  sale.order_id = 'ORDER-SYNTHETIC';
  sale.order_currency = 'HNL';
  try {
    await run({ handlers, calls, settings, sale });
    assert.equal(calls.socketAttempts, 0);
  } finally {
    ServiceBehaviour.prototype.post = originals.post;
    Helpers.addScriptToWebsite = originals.script;
    Helpers.addSecureForm = originals.form;
    Helpers.removeElementById = originals.remove;
    LookupTransaction.prototype.setRequiredEMVFields = originals.emv;
    Loading.show = originals.show; Loading.hide = originals.hide;
    Modal.show = originals.modalShow; Modal.hide = originals.modalHide;
    net.Socket.prototype.connect = originals.connect;
    Transaction.busy = false;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('SDK authentication preparation sets a flag and does not collect browser evidence', () => {
  const sale = new SaleTransaction();
  sale.withAuthenticationRequest();
  assert.equal(sale.authentication_request, true);
  assert.equal(sale.authentication_identifier, undefined);
});

test('SDK rejects explicit 3DS in Node before any Sale HTTP call', async () => {
  assert.equal(Helpers.checkIsBrowser(), false);
  const service = new Transaction(new Settings());
  const sale = new SaleTransaction();
  sale.withAuthenticationRequest();
  let sends = 0;
  service.post = async () => { sends++; };
  await assert.rejects(service.doSale(sale), /platform not support 3DS/);
  assert.equal(sends, 0);
});

for (const type of ['songbird', 'payload']) {
  test(`raw SDK ${type} after provider 202 requires document in Node`, async () => {
    const service = new Transaction(new Settings());
    let sends = 0;
    service.post = async () => { sends++; return parse(202, { transaction_type: type, payload: 'SYNTHETIC' }); };
    await assert.rejects(service.doSale(new SaleTransaction()), /document is not defined/);
    assert.equal(sends, 1);
    assert.equal(Transaction.busy, false);
  });
}

for (const action of ['SUCCESS', 'NOACTION', 'ERROR']) {
  test(`synthetic Cardinal ${action} demonstrates SDK continuation posts`, async () => {
    await withContractFixture(async ({ handlers, calls, settings, sale }) => {
      ServiceBehaviour.prototype.post = async function (route) {
        calls.routes.push(route);
        if (route.endsWith('/lookup')) return this.parseResponse({ success: true, action: 'continue', data: { identifier: 'AUTH-SYNTHETIC', continue_url: 'https://acs.invalid', continue_payload: 'SYNTHETIC', transaction_id: 'TX-SYNTHETIC' } }, 200);
        if (route.endsWith('/continue')) return parse(200, {});
        if (route.endsWith('/sale')) return parse(200, approvedData);
        throw new Error('UNEXPECTED_ROUTE');
      };
      const manager = new CardinalManager(settings, sale);
      const pending = manager.init('JWT-SYNTHETIC');
      await flush();
      assert.equal(calls.scripts.length, 1);
      assert.match(calls.scripts[0], /songbirdstag\.cardinalcommerce\.com/);
      await handlers.get('payments.setupComplete')({ sessionId: 'SESSION-SYNTHETIC' });
      assert.equal(calls.challenges, 1);
      assert.equal(sale.authentication_identifier, 'AUTH-SYNTHETIC');
      await handlers.get('payments.validated')({ ActionCode: action }, action === 'SUCCESS' ? 'JWT-RESULT-SYNTHETIC' : undefined);
      const response = await pending;
      if (action === 'ERROR') {
        assert.equal(response.status, 520);
        assert.deepEqual(calls.routes, ['api/v2/cardinal/authentication/lookup']);
      } else {
        assert.equal(response.status, 200);
        assert.deepEqual(calls.routes, [
          'api/v2/cardinal/authentication/lookup',
          ...(action === 'SUCCESS' ? ['api/v2/cardinal/authentication/continue'] : []),
          'api/v2/transaction/sale',
        ]);
      }
    });
  });
}

test('synthetic complete doSale songbird flow emits a second Sale POST inside SDK', async () => {
  await withContractFixture(async ({ handlers, calls, settings, sale }) => {
    let sales = 0;
    ServiceBehaviour.prototype.post = async function (route) {
      calls.routes.push(route);
      if (route.endsWith('/sale')) return ++sales === 1 ? parse(202, { transaction_type: 'songbird', payload: 'JWT-SYNTHETIC' }) : parse(200, approvedData);
      if (route.endsWith('/lookup')) return this.parseResponse({ success: true, action: 'complete', data: { identifier: 'AUTH-SYNTHETIC' } }, 200);
      throw new Error('UNEXPECTED_ROUTE');
    };
    sale.withAuthenticationRequest();
    const pending = new Transaction(settings).doSale(sale);
    await flush();
    await handlers.get('payments.setupComplete')({ sessionId: 'SESSION-SYNTHETIC' });
    assert.equal((await pending).status, 200);
    assert.equal(sales, 2);
    assert.equal(sale.authentication_identifier, 'AUTH-SYNTHETIC');
  });
});

for (const scenario of ['close', 'disconnect', 'reload']) {
  test(`synthetic ${scenario} does not resolve SDK payment or persist a resume handle`, async () => {
    await withContractFixture(async ({ handlers, settings, sale }) => {
      let settled = false;
      const manager = new CardinalManager(settings, sale);
      manager.init('JWT-SYNTHETIC').then(() => { settled = true; });
      await flush();
      if (scenario === 'close') handlers.get('ui.close')();
      else handlers.clear();
      await flush();
      assert.equal(settled, false);
      assert.equal(sale.authentication_identifier, undefined);
    });
  });
}

test('synthetic collection URL accepts only expected origins before lookup', async () => {
  await withContractFixture(async ({ handlers, calls, settings, sale }) => {
    ServiceBehaviour.prototype.post = async function (route) {
      calls.routes.push(route);
      if (route.endsWith('/lookup')) return this.parseResponse({ success: true, action: 'complete', data: { identifier: 'AUTH-SYNTHETIC' } }, 200);
      if (route.endsWith('/sale')) return parse(200, approvedData);
      throw new Error('UNEXPECTED_ROUTE');
    };
    const manager = new CardinalManager(settings, sale);
    const pending = manager.init('JWT-SYNTHETIC', 'https://collection.invalid/collect');
    await flush();
    assert.equal(calls.forms, 1);
    assert.equal(calls.scripts.length, 0);
    await handlers.get('message')({ origin: 'https://untrusted.invalid', data: { MessageType: 'profile.completed', SessionId: 'SESSION-SYNTHETIC', Status: true } });
    assert.equal(calls.routes.length, 0);
    await handlers.get('message')({ origin: 'https://collection.invalid', data: { MessageType: 'profile.completed', SessionId: 'SESSION-SYNTHETIC', Status: true } });
    assert.equal((await pending).status, 200);
    assert.deepEqual(calls.routes, ['api/v2/cardinal/authentication/lookup', 'api/v2/transaction/sale']);
  });
});
