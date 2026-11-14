import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import test, { after, afterEach } from "node:test";

const require = createRequire(import.meta.url);
const blockedNetwork = [];
const restorations = [];
let allowedLoopbackPort = null;

function loopbackAllowed(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === "string" || first instanceof URL) {
    try {
      const url = new URL(first);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) === allowedLoopbackPort;
    } catch { return false; }
  }
  const options = first && typeof first === "object" ? first : { port: first, host: args[1] };
  return allowedLoopbackPort !== null && Number(options.port) === allowedLoopbackPort
    && (options.hostname || options.host) === "127.0.0.1";
}

function replace(target, key, allowLoopback = false, allowLiteralLookup = false) {
  const original = target[key];
  target[key] = function (...args) {
    if (allowLiteralLookup && args[0] === "127.0.0.1") return original.apply(this, args);
    if (allowLoopback && loopbackAllowed(args)) return original.apply(this, args);
    blockedNetwork.push(key);
    const error = new Error("LOCAL_TEST_NETWORK_BLOCKED");
    error.code = "LOCAL_TEST_NETWORK_BLOCKED";
    throw error;
  };
  restorations.push(() => { target[key] = original; });
}

// AM: Bloquear todas las salidas antes de cargar SDK/Axios; solo G permite su puerto local efimero.
for (const [name, methods, local] of [
  ["node:http", ["request", "get"], true], ["node:https", ["request", "get"], false],
  ["node:http2", ["connect"], false], ["node:net", ["connect", "createConnection"], true],
  ["node:tls", ["connect"], false], ["node:dgram", ["createSocket"], false],
  ["node:child_process", ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"], false],
]) for (const method of methods) replace(require(name), method, local);
replace(require("node:net").Socket.prototype, "connect", true);
for (const dns of [require("node:dns"), require("node:dns").promises]) {
  for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key) && typeof dns[key] === "function") replace(dns, key, false, key === "lookup");
}
replace(globalThis, "fetch");
if (typeof globalThis.WebSocket === "function") replace(globalThis, "WebSocket");
syncBuiltinESMExports();

const sdk = (await import("@pixelpay/sdk-core")).default;
// AM: El SDK es CommonJS; utilizar su misma instancia Axios evita dos conjuntos de defaults.
const axios = require("axios");
const nacl = (await import("tweetnacl")).default;
const { PixelPaySdkProvider } = await import("../src/services/payments/PixelPaySdkProvider.js");
const originalAdapter = axios.defaults.adapter;
const realHttpAdapter = axios.getAdapter("http");
const publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString("base64");
const ENDPOINT = "https://synthetic-pixelpay.invalid";
const KEY = "synthetic-key-not-real";
const SECRET = "synthetic-secret-not-real";
const AUTH = "synthetic-auth-not-real";
const ORDER = "LOCAL-PIXELPAY-NODE";
const DATA_SENTINEL = "SENSITIVE_BODY_MUST_NOT_APPEAR";
let transport;
let calls = [];
let otherEndpointCalls = 0;

class ObservedProvider extends PixelPaySdkProvider {
  createTransaction(...args) {
    const transaction = super.createTransaction(...args);
    this.lastTransaction = transaction;
    return transaction;
  }
}

function makeProvider(overrides = {}) {
  return new ObservedProvider({ endpoint: ENDPOINT, env: "live", keyId: KEY, secretKey: SECRET,
    authHash: AUTH, appUrl: ENDPOINT, now: () => new Date("2026-11-14T05:40:00Z"), ...overrides });
}

function input(overrides = {}) {
  return { orderId: ORDER, currency: "HNL", amount: 1,
    items: [{ code: "local-item", title: "Synthetic item", price: 1, qty: 1 }],
    customer: { name: "Synthetic customer", email: "local@example.invalid" },
    billing: { address: "Synthetic address", country: "HN", state: "HN-FM", city: "Synthetic", phone: "99999999" },
    card: { number: "4111111111111111", cvv: "987", expire: "3512", holder: "Synthetic customer" }, ...overrides };
}

function approved(overrides = {}) {
  return { transaction_amount: 1, transaction_approved_amount: 1,
    transaction_id: "synthetic-transaction", transaction_auth: "LOCAL",
    payment_uuid: "11111111-1111-4111-8111-111111111111",
    payment_hash: createHash("md5").update(`${ORDER}|${KEY}|${SECRET}`).digest("hex"),
    response_approved: true, response_incomplete: false, response_code: "00", ...overrides };
}

function mockTransport(status, data, options = {}) {
  calls = [];
  otherEndpointCalls = 0;
  transport = async (config, route) => {
    if (route === "public_key") return { status: 200, data: { success: true, data: { public_key: publicKey } } };
    if (options.error) throw options.error(config);
    return { status, data };
  };
}

axios.defaults.adapter = async (config) => {
  if (config.baseURL !== ENDPOINT) otherEndpointCalls += 1;
  assert.equal(config.baseURL, ENDPOINT);
  const pathname = new URL(config.url, `${ENDPOINT}/`).pathname;
  const route = pathname.endsWith("/merchant/public_key") ? "public_key"
    : pathname.endsWith("/transaction/sale") ? "sale" : "unexpected";
  assert.notEqual(route, "unexpected");
  calls.push({ route, method: config.method });
  const response = await transport(config, route);
  return { ...response, statusText: String(response.status), headers: { "content-type": "application/json" }, config };
};

async function execute(provider = makeProvider(), saleInput = input()) {
  const events = [];
  const logger = { info: (event) => events.push(event), warn: (event) => events.push(event) };
  let result;
  let error;
  try { result = await provider.sale(saleInput, { paymentAttemptId: randomUUID(), idIntent: randomUUID(), requestId: "local-node", logger }); }
  catch (caught) { error = caught; }
  const execution = error?.runtimeDiagnostics || provider.lastTransaction?.getSaleExecutionDiagnostics?.();
  const serialized = JSON.stringify({ events, diagnostics: result?.diagnostics, runtime: error?.runtimeDiagnostics });
  for (const sentinel of [KEY, SECRET, AUTH, DATA_SENTINEL, "4111111111111111", '"cvv":', '"card_cvv":']) assert.equal(serialized.includes(sentinel), false);
  assert.equal(otherEndpointCalls, 0, "SDK attempted another endpoint");
  return { result, error, events, execution, saleCalls: calls.filter(c => c.route === "sale").length };
}

function report(t, label, run) {
  t.diagnostic(JSON.stringify({ case: label, outcome: run.result?.outcome ?? (run.error?.uncertain ? "uncertain" : "error"),
    exception: run.error?.errorName ?? run.error?.name ?? null,
    category: run.error?.safeMessageCode ?? run.result?.diagnostics?.safeMessageCode ?? null,
    phase: run.execution?.executionPhase, httpResponseReceived: run.execution?.httpResponseReceived,
    requestMayHaveBeenSent: run.execution?.requestMayHaveBeenSent,
    sdkTransactionType: run.execution?.sdkTransactionType,
    statusCode: run.error?.statusCode ?? run.result?.statusCode ?? null, saleCalls: run.saleCalls }));
}

afterEach(() => { assert.deepEqual(blockedNetwork.splice(0), [], "Unexpected external transport attempt"); });
after(() => {
  axios.defaults.adapter = originalAdapter;
  for (const restore of restorations.reverse()) restore();
  syncBuiltinESMExports();
});

test("guardas impiden HTTP HTTPS DNS TCP TLS y fetch externos", () => {
  const probes = [
    () => require("node:http").request("http://network-probe.invalid"),
    () => require("node:https").request("https://network-probe.invalid"),
    () => require("node:http2").connect("https://network-probe.invalid"),
    () => require("node:net").connect(443, "network-probe.invalid"),
    () => new (require("node:net").Socket)().connect(443, "network-probe.invalid"),
    () => require("node:tls").connect(443, "network-probe.invalid"),
    () => require("node:dns").lookup("network-probe.invalid"),
    () => globalThis.fetch("https://network-probe.invalid"),
  ];
  for (const probe of probes) assert.throws(probe, { code: "LOCAL_TEST_NETWORK_BLOCKED" });
  assert.equal(blockedNetwork.splice(0).length, probes.length);
});

test("SDK real 2.5.8 reproduce document ausente tras HTTP 202 sin habilitar 3DS", async () => {
  assert.equal(require("@pixelpay/sdk-core/package.json").version, "2.5.8");
  mockTransport(202, { success: true, data: { transaction_type: "payload", payload: "synthetic" } });
  const provider = makeProvider();
  const request = provider.buildSaleRequest(input());
  assert.equal(request.authentication_request, false);
  await assert.rejects(provider.createTransaction("synthetic-signature").doSale(request), error => {
    assert.equal(error.name, "ReferenceError");
    assert.equal(error.message, "document is not defined");
    assert.match(error.stack, /PayloadManager\.js:43:/);
    return true;
  });
  assert.equal(calls.filter(c => c.route === "sale").length, 1);
});

test("A aprobacion SDK real conserva contrato financiero completo", async (t) => {
  mockTransport(200, { success: true, data: approved() });
  const run = await execute();
  assert.equal(run.error, undefined);
  assert.equal(run.result.approved, true);
  assert.equal(run.result.outcome, "approved");
  assert.equal(run.result.paymentHashValid, true);
  assert.equal(run.result.amountMatches, true);
  assert.equal(run.saleCalls, 1);
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.execution.statusCode, 200);
  report(t, "A", run);
});

test("B rechazo SDK real conserva respuesta contractual sin aprobacion", async (t) => {
  mockTransport(402, { success: false, data: approved({ response_approved: false, response_code: "05" }) });
  const run = await execute();
  assert.equal(run.error, undefined);
  assert.equal(run.result.approved, false);
  assert.equal(run.result.outcome, "payment_declined");
  assert.equal(run.result.statusCode, 402);
  assert.equal(run.saleCalls, 1);
  report(t, "B", run);
});

for (const [label, body, expectedType = null, expectedCode = "SDK_CONTINUATION_REQUIRED"] of [
  ["C 202 sin cuerpo", undefined], ["D 202 JSON", { success: true, data: { pending: true } }],
  ["E 202 estructura de error", { success: false, message: DATA_SENTINEL, errors: { financial_payload: DATA_SENTINEL } }],
  ["202 payload", { success: true, data: { transaction_type: "payload", payload: DATA_SENTINEL } }, "payload", "SDK_BROWSER_ACTION_REQUIRED"],
  ["202 songbird", { success: true, data: { transaction_type: "songbird", payload: DATA_SENTINEL } }, "songbird", "SDK_BROWSER_ACTION_REQUIRED"],
  ["202 tipo desconocido", { success: true, data: { transaction_type: DATA_SENTINEL } }],
  ["202 router", { success: true, data: { transaction_type: "router", payload: Buffer.from(JSON.stringify({
    client_signature: "synthetic-router-signature", env: "live", auth_key: KEY, auth_hash: AUTH,
    endpoint: "https://synthetic-router.invalid",
  })).toString("base64") } }, "router"],
]) test(`${label} queda incierto con HTTP preservado y sin ejecutar DOM`, async (t) => {
  mockTransport(202, body);
  const run = await execute();
  assert.equal(run.result, undefined);
  assert.equal(run.error.code, "PIXELPAY_NETWORK_ERROR");
  assert.equal(run.error.safeMessageCode, expectedCode);
  assert.equal(run.execution.sdkTransactionType, expectedType);
  assert.equal(run.error.uncertain, true);
  assert.equal(run.error.statusCode, 202);
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.execution.requestMayHaveBeenSent, true);
  assert.equal(run.execution.executionPhase, "response_processing");
  assert.equal(run.saleCalls, 1);
  assert.notEqual(run.error.errorName, "ReferenceError");
  assert.equal(run.events.at(-1).event, "PIXELPAY_SALE_UNCERTAIN");
  assert.equal(run.events.at(-1).sdkTransactionType, expectedType);
  report(t, label, run);
});

test("F HTTP 408 sigue siendo incierto con respuesta recibida", async (t) => {
  mockTransport(408, { success: false, message: "Synthetic upstream timeout" });
  const run = await execute();
  assert.equal(run.error, undefined);
  assert.equal(run.result.outcome, "uncertain");
  assert.equal(run.result.statusCode, 408);
  assert.equal(run.result.diagnostics.safeMessageCode, "SDK_HTTP_TIMEOUT");
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.saleCalls, 1);
  report(t, "F", run);
});

test("G error de red real ECONNRESET exclusivamente en loopback no permite otra Sale", async (t) => {
  const server = require("node:http").createServer((_request, response) => response.socket.destroy());
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  allowedLoopbackPort = server.address().port;
  let originalNetworkCode;
  try {
    mockTransport(0, undefined);
    const mock = transport;
    transport = async (config, route) => {
      if (route !== "sale") return mock(config, route);
      try { return await realHttpAdapter({ ...config, baseURL: `http://127.0.0.1:${allowedLoopbackPort}`,
        url: "/local-reset", proxy: false, maxRedirects: 0 }); }
      catch (error) { originalNetworkCode = error.code; throw error; }
    };
    const run = await execute();
    assert.equal(originalNetworkCode, "ECONNRESET");
    assert.equal(run.error.safeMessageCode, "SDK_NETWORK_ERROR");
    assert.equal(run.error.statusCode, null);
    assert.equal(run.error.uncertain, true);
    assert.equal(run.execution.executionPhase, "sale_transport");
    assert.equal(run.execution.requestMayHaveBeenSent, true);
    assert.equal(run.execution.httpResponseReceived, false);
    assert.equal(run.saleCalls, 1);
    report(t, "G_REAL_LOOPBACK_RESET", run);
  } finally {
    allowedLoopbackPort = null;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("H HTTP 412 permanece rechazo contractual del proveedor", async (t) => {
  mockTransport(412, { success: false, message: "Synthetic precondition" });
  const run = await execute();
  assert.equal(run.error, undefined);
  assert.equal(run.result.approved, false);
  assert.equal(run.result.statusCode, 412);
  assert.equal(run.result.outcome, "request_error_definitive");
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.saleCalls, 1);
  report(t, "H", run);
});

test("I ReferenceError real de JavaScript en preparacion no se clasifica como red", async (t) => {
  mockTransport(200, { success: true, data: approved() });
  class ReferenceTransaction extends sdk.Services.Transaction {
    async post() { throw new ReferenceError("document is not defined"); }
  }
  const run = await execute(makeProvider({ sdk: { ...sdk, Services: { ...sdk.Services, Transaction: ReferenceTransaction } } }));
  assert.equal(run.error.safeMessageCode, "SDK_REFERENCE_ERROR");
  assert.equal(run.error.errorName, "ReferenceError");
  assert.equal(run.error.uncertain, true);
  assert.equal(run.execution.httpResponseReceived, false);
  assert.equal(run.execution.executionPhase, "sdk_preparation");
  assert.equal(run.saleCalls, 0);
  report(t, "I", run);
});

for (const [label, overrides] of [
  ["J respuesta financiera incompleta", { response_incomplete: true }],
  ["K UUID ausente", { payment_uuid: undefined }],
]) test(`${label} no se convierte en aprobacion`, async (t) => {
  mockTransport(200, { success: true, data: approved(overrides) });
  const run = await execute();
  assert.equal(run.error, undefined);
  assert.equal(run.result.approved, false);
  assert.equal(run.result.outcome, "uncertain");
  assert.equal(run.result.statusCode, 200);
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.saleCalls, 1);
  report(t, label, run);
});

test("L construccion rechazada antes de entrar al SDK no inicia HTTP", async (t) => {
  mockTransport(200, { success: true, data: approved() });
  const run = await execute(makeProvider(), input({ items: [] }));
  assert.equal(run.error.code, "PIXELPAY_ORDER_ITEMS_INVALID");
  assert.equal(run.error.uncertain, false);
  assert.equal(run.execution.executionPhase, "request_construction");
  assert.equal(run.execution.httpResponseReceived, false);
  assert.equal(run.execution.requestMayHaveBeenSent, false);
  assert.equal(calls.length, 0);
  assert.equal(run.events.some(e => e.event === "PIXELPAY_SALE_HTTP_STARTED"), false);
  report(t, "L", run);
});

test("M excepcion al interpretar respuesta200 conserva incertidumbre y fase", async (t) => {
  mockTransport(200, { success: true, data: approved() });
  class ParseFailureResult extends sdk.Entities.TransactionResult {
    static validateResponse() { throw new SyntaxError(DATA_SENTINEL); }
  }
  const run = await execute(makeProvider({ sdk: { ...sdk, Entities: { ...sdk.Entities, TransactionResult: ParseFailureResult } } }));
  assert.equal(run.error.safeMessageCode, "SDK_RESPONSE_PARSE_ERROR");
  assert.equal(run.error.uncertain, true);
  assert.equal(run.error.statusCode, 200);
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.execution.requestMayHaveBeenSent, true);
  assert.equal(run.execution.executionPhase, "response_processing");
  assert.equal(run.saleCalls, 1);
  report(t, "M", run);
});

test("timeoutAxios conserva codigo especifico e incertidumbre", async (t) => {
  mockTransport(0, undefined, { error: config => new axios.AxiosError("timeout of 60000ms exceeded", "ECONNABORTED", config, {}) });
  const run = await execute();
  assert.equal(run.error.safeMessageCode, "SDK_HTTP_TIMEOUT");
  assert.equal(run.error.uncertain, true);
  assert.equal(run.execution.httpResponseReceived, false);
  assert.equal(run.execution.requestMayHaveBeenSent, true);
  assert.equal(run.saleCalls, 1);
  report(t, "AXIOS_TIMEOUT", run);
});

test("fallo despues de clave publica200 no fabrica respuesta HTTP de Sale", async (t) => {
  mockTransport(200, { success: true, data: approved() });
  const mock = transport;
  transport = async (config, route) => route === "public_key"
    ? { status: 200, data: { success: true, data: { public_key: "synthetic-invalid-public-key" } } }
    : mock(config, route);
  const run = await execute();
  assert.equal(run.error.uncertain, true);
  assert.equal(run.execution.httpResponseReceived, false);
  assert.equal(run.execution.requestMayHaveBeenSent, false);
  assert.equal(run.execution.statusCode, null);
  assert.equal(run.saleCalls, 0);
  report(t, "PUBLIC_KEY_IS_NOT_SALE_RESPONSE", run);
});

test("HTTP500 no es aprobacion y no reintenta Sale", async (t) => {
  mockTransport(500, { success: false, message: DATA_SENTINEL });
  const run = await execute();
  assert.equal(run.result.outcome, "uncertain");
  assert.equal(run.result.approved, false);
  assert.equal(run.result.statusCode, 500);
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.saleCalls, 1);
  report(t, "HTTP500", run);
});

test("HTTP400 conserva rechazo contractual y solo campos de error permitidos", async (t) => {
  mockTransport(400, { success: false, message: DATA_SENTINEL, errors: { billing_state: [DATA_SENTINEL] } });
  const run = await execute();
  assert.equal(run.result.outcome, "request_error_definitive");
  assert.equal(run.result.approved, false);
  assert.equal(run.result.statusCode, 400);
  assert.equal(run.result.diagnostics.safeMessageCode, "SDK_UPSTREAM_ERROR");
  assert.equal(run.execution.httpResponseReceived, true);
  assert.equal(run.saleCalls, 1);
  assert.deepEqual(run.result.diagnostics.inputErrorFields, ["billing_state"]);
  report(t, "HTTP400", run);
});
