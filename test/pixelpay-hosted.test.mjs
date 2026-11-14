import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildHostedRequest, hostedRequestSignature, hostedStatusPayload, processHostedCallback, requestHostedCheckout,
  resolvePixelPayHostedConfig, validateHostedCallback, validateHostedCheckoutUrl,
} from "../src/services/payments/pixelPayHosted.js";

const env = { PIXELPAY_HOSTED_ENABLED: "true", ENTORNO: "qa", PIXELPAY_ENV: "sandbox", PAYMENT_PROVIDER: "pixelpay",
  FRONTEND_URL: "https://qa.masterfadeapp.com", PIXELPAY_HOSTED_KEY_ID: "1234567890", PIXELPAY_HOSTED_SECRET_KEY: "hosted-fixture-secret",
  PIXELPAY_HOSTED_APP_URL: "https://pixelpay.app", PIXELPAY_HOSTED_CALLBACK_URL: "https://qa.masterfadeapp.com/v1/pagos/pixelpay/hosted/callback" };
const config = resolvePixelPayHostedConfig(env);
const idIntent = "11111111-2222-4333-8444-555555555555";
const idGrupoCita = "22222222-2222-4333-8444-555555555555";
const orderId = "MF-PIXELPAY-11111111222243338444555555555555";
const order = { orderId, idIntent, idGrupoCita, amount: 100, currency: "HNL", firstName: "Cliente", lastName: "Prueba",
  email: "fixture@example.invalid", expiresAt: new Date(Date.now() + 600000).toISOString(),
  items: [{ title: "Corte de cabello", code: "CORTE", price: 100, qty: 1, total: 100 }] };
const checkout = "https://pixelpay.app/sandbox/abc123/checkout/example?payload=fixture";
const session = { id_intent: idIntent, id_grupo_cita: idGrupoCita, order_id: orderId, amount_hnl: "100.00", currency: "HNL",
  expires_at: order.expiresAt, creation_state: "checkout_ready", checkout_url: checkout };
const hash = crypto.createHash("md5").update(`${orderId}|${config.keyId}|${config.secretKey}`).digest("hex");
const callback = { order: orderId, ref: orderId, uuid: "S-fixture-payment", amount: 100, currency: "HNL", status: "paid", payment_hash: hash };

test("Hosted desactivado por defecto; Live y configuracion ambigua fallan cerrados", () => {
  assert.deepEqual(resolvePixelPayHostedConfig({}), { enabled: false });
  for (const change of [{ PIXELPAY_HOSTED_ENABLED: "yes" }, { ENTORNO: "production" }, { PIXELPAY_ENV: "live" },
    { PAYMENT_PROVIDER: "disabled" }, { ADMIN_DATA_ENTRY_MODE: "true" }, { PIXELPAY_HOSTED_SECRET_KEY: "" },
    { FRONTEND_URL: "https://masterfadeapp.com" }, { FRONTEND_URL: "https://user:pass@qa.masterfadeapp.com" },
    { PIXELPAY_HOSTED_CALLBACK_URL: "https://qa.masterfadeapp.com/otro" }, { PIXELPAY_HOSTED_APP_URL: "https://pixelpay.dev" }]) {
    assert.throws(() => resolvePixelPayHostedConfig({ ...env, ...change }));
  }
});

test("rollback deshabilita nuevas sesiones pero conserva receptor dedicado QA Sandbox", async () => {
  const rollback = resolvePixelPayHostedConfig({ ...env, PIXELPAY_HOSTED_ENABLED: "false", PAYMENT_PROVIDER: "disabled", ADMIN_DATA_ENTRY_MODE: "true" });
  assert.equal(rollback.enabled, false);
  assert.equal(rollback.receivingEnabled, true);
  assert.throws(() => buildHostedRequest(rollback, order));
  const db = callbackDb();
  const result = await processHostedCallback({ db, config: rollback, body: callback });
  assert.equal(result.pending_confirmation, true);
  assert.equal(result.booking_confirmed, false);
});

test("Hosted Sandbox firma HMAC SHA3-512 en formulario y conserva orden canonica, monto HNL y retornos", () => {
  const params = buildHostedRequest(config, order);
  assert.equal(params.get("_client_signature"), crypto.createHmac("sha3-512", config.secretKey).update(`${config.keyId}|${orderId}|${config.appUrl}`).digest("hex"));
  assert.equal(params.get("_client_signature"), hostedRequestSignature(config, orderId));
  assert.equal(params.get("_order_id"), orderId);
  assert.equal(params.get("_amount"), "100.00");
  assert.equal(params.get("_currency"), "HNL");
  assert.deepEqual(JSON.parse(Buffer.from(params.get("_order_content"), "base64").toString()), order.items);
  for (const key of ["_complete", "_cancel"]) {
    const url = new URL(params.get(key));
    assert.equal(url.origin + url.pathname, "https://qa.masterfadeapp.com/agendar/pagar");
    assert.equal(url.searchParams.get("id_intent"), idIntent);
    assert.equal(url.searchParams.get("id_grupo_cita"), idGrupoCita);
    assert.equal(url.searchParams.has("titular_email"), false);
    assert.equal(url.searchParams.has("secret"), false);
  }
  assert.equal(params.toString().includes(config.secretKey), false);
});

test("datos canonicos invalidos y cita vencida impiden enviar Hosted", () => {
  for (const change of [{ amount: 0 }, { currency: "USD" }, { orderId: "orden-ajena" }, { lastName: "" },
    { expiresAt: new Date(Date.now() - 1).toISOString() }, { items: [{ ...order.items[0], total: 99 }] }]) {
    assert.throws(() => buildHostedRequest(config, { ...order, ...change }));
  }
});

test("solo permite URLs HTTPS de checkout Sandbox oficiales sin credenciales ni redireccion ajena", () => {
  assert.equal(validateHostedCheckoutUrl(checkout), checkout);
  assert.equal(validateHostedCheckoutUrl(checkout.replace("pixelpay.app", "www.pixelpay.app")), checkout.replace("pixelpay.app", "www.pixelpay.app"));
  for (const url of ["http://pixelpay.app/sandbox/a/checkout", "https://pixelpay.app.evil.test/sandbox/a/checkout", "javascript:alert(1)",
    "https://user:pass@pixelpay.app/sandbox/a/checkout", "https://pixelpay.app:8443/sandbox/a/checkout", "https://pixelpay.app/sandbox/a/checkout#secret",
    "https://pixelpay.app/admin", "https://pixelpay.app/live/a/checkout", "//pixelpay.app/sandbox/a/checkout"]) {
    assert.throws(() => validateHostedCheckoutUrl(url), error => error.code === "PIXELPAY_HOSTED_URL_INVALID");
  }
});

test("request real de adaptador solo apunta Sandbox, sin redirects y sin datos de tarjeta", async () => {
  let calls = 0;
  const url = await requestHostedCheckout(config, order, { fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, "https://pixelpay.app/api/v2/transaction/hosted/sandbox");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(request.body.includes(config.secretKey), false);
    assert.doesNotMatch(request.body, /card_number|card_cvv|authHash/);
    return { status: 200, json: async () => ({ success: true, url: checkout }) };
  } });
  assert.equal(url, checkout);
  assert.equal(calls, 1);
});

for (const [name, fetchImpl, code] of [
  ["timeout", async () => { throw new DOMException("timeout-private", "TimeoutError"); }, "PIXELPAY_HOSTED_CREATE_UNCERTAIN"],
  ["red", async () => { throw new Error("private-network-data"); }, "PIXELPAY_HOSTED_CREATE_UNCERTAIN"],
  ["HTML", async () => ({ status: 403, json: async () => { throw new Error("private-html"); } }), "PIXELPAY_HOSTED_CREATE_UNCERTAIN"],
  ["rechazo", async () => ({ status: 422, json: async () => ({ success: false, errors: "private-error" }) }), "PIXELPAY_HOSTED_CREATE_REJECTED"],
  ["redirect", async () => ({ status: 302 }), "PIXELPAY_HOSTED_RESPONSE_INVALID"],
  ["URL ajena", async () => ({ status: 200, json: async () => ({ success: true, url: "https://evil.test/checkout" }) }), "PIXELPAY_HOSTED_URL_INVALID"],
]) test(`adaptador ${name} no reintenta ni expone detalles`, async () => {
  let calls = 0;
  await assert.rejects(requestHostedCheckout(config, order, { fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } }),
    error => error.code === code && !/private-/.test(error.message));
  assert.equal(calls, 1);
});

for (const status of ["paid", "failed", "cancelled"]) test(`callback ${status} solo correlaciona; nunca aprueba`, () => {
  const result = validateHostedCallback(config, session, { ...callback, status });
  assert.equal(result.callback_authenticated, false);
  assert.equal(result.correlation_hash_valid, true);
  const response = hostedStatusPayload({ ...session, provider_status_untrusted: status, callback_received_at: new Date().toISOString() }, { id_intent: idIntent, estado_intent_codigo: "pendiente_confirmacion" });
  assert.equal(response.booking_confirmed, false);
  assert.equal(response.pending_confirmation, true);
  assert.equal(response.automatic_confirmation, false);
  assert.equal(response.manual_reconciliation_required, true);
  assert.equal(JSON.stringify(response).includes(hash), false);
});

for (const [change, code] of [
  [{ payment_hash: "a".repeat(32) }, "PIXELPAY_HOSTED_HASH_INVALID"], [{ payment_hash: "" }, "PIXELPAY_HOSTED_HASH_INVALID"],
  [{ amount: 99 }, "PIXELPAY_HOSTED_AMOUNT_MISMATCH"], [{ amount: "100.001" }, "PIXELPAY_HOSTED_AMOUNT_MISMATCH"],
  [{ currency: "USD" }, "PIXELPAY_HOSTED_CURRENCY_MISMATCH"], [{ order: "MF-PIXELPAY-22222222222243338444555555555555" }, "PIXELPAY_HOSTED_ORDER_MISMATCH"],
  [{ status: "approved" }, "PIXELPAY_HOSTED_RESULT_INVALID"], [{ uuid: "<script>private</script>" }, "PIXELPAY_HOSTED_REFERENCE_INVALID"],
]) test(`callback falsificado/mismatch ${code} rechazado`, () => {
  assert.throws(() => validateHostedCallback(config, session, { ...callback, ...change }), error => error.code === code);
});

test("retorno completo/cancel, estado paid y hash filtrado no constituyen evidencia financiera", () => {
  const forged = validateHostedCallback(config, session, { ...callback, paymentHash: hash, hosted_return: "complete" });
  assert.equal(forged.callback_authenticated, false);
  const response = hostedStatusPayload(session, { id_intent: idIntent, estado_intent_codigo: "expirado" }, new Date(session.expires_at).getTime() + 1);
  assert.equal(response.expired, true);
  assert.equal(response.checkout_url, null);
  assert.equal(response.booking_confirmed, false);
});

test("ref opaca distinta no cambia orden; checkout deja de ofrecerse con paid reportado o reserva cancelada", () => {
  assert.equal(validateHostedCallback(config, session, { ...callback, ref: "prefijo-otra-ref" }).order_id, orderId);
  const intent = { id_intent: idIntent, estado_intent_codigo: "pendiente_confirmacion" };
  assert.equal(hostedStatusPayload({ ...session, provider_status_untrusted: "paid" }, intent).checkout_url, null);
  for (const estado_intent_codigo of ["confirmado", "expirado", "fallido"]) assert.equal(hostedStatusPayload(session, { ...intent, estado_intent_codigo }).checkout_url, null);
  const rows = [{ estado_grupo_codigo: "cancelado", estado_cita_codigo: "pendiente_pago", estado_hold_codigo: "activo", expires_at: session.expires_at }];
  assert.equal(hostedStatusPayload(session, intent, Date.now(), rows).checkout_url, null);
});

function callbackDb(record = structuredClone(session)) {
  const queries = [];
  return { queries, record, async connect() { return { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.startsWith("SELECT *")) return { rows: [record] };
    if (sql.startsWith("UPDATE app_private.pixelpay_hosted_sessions")) {
      record.callback_received_at = new Date().toISOString();
      record.callback_digest = values[1];
      record.callback_digests = [...(record.callback_digests || []), values[1]];
      record.provider_status_untrusted = values[2];
      record.late_payment_reported = new Date(record.expires_at).getTime() <= Date.now();
    }
    return { rows: [] };
  }, release() {} }; } };
}

test("callback duplicado se acusa HTTP 200 sin duplicar ni crear pagos/eventos/ventas", async () => {
  const db = callbackDb();
  const first = await processHostedCallback({ db, config, body: { ...callback, customer_email: "private@example.invalid", extra: { secret: "private-extra" } } });
  const second = await processHostedCallback({ db, config, body: callback });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.queries.filter(q => q.sql.startsWith("UPDATE")).length, 1);
  assert.equal(db.queries.every(q => !/public\.payments|payment_events|UPDATE public\.citas|confirmar_reserva|pixelpay\.sale/.test(q.sql)), true);
  assert.doesNotMatch(JSON.stringify(db.queries), /private@example|private-extra|payment_hash|customer_email/);
});

test("pago reportado tarde queda en revision; no cambia cita ni intento expirado", async () => {
  const db = callbackDb({ ...session, expires_at: new Date(Date.now() - 10000).toISOString() });
  const result = await processHostedCallback({ db, config, body: callback });
  assert.equal(db.record.late_payment_reported, true);
  assert.equal(result.booking_confirmed, false);
  assert.equal(result.pending_confirmation, true);
  assert.equal(db.queries.some(q => /UPDATE public\./.test(q.sql)), false);
});

test("hash invalido no deja recibo y revierte transaccion", async () => {
  const db = callbackDb();
  await assert.rejects(processHostedCallback({ db, config, body: { ...callback, payment_hash: "0".repeat(32) } }));
  assert.equal(db.queries.at(-1).sql, "ROLLBACK");
  assert.equal(db.queries.some(q => q.sql.startsWith("UPDATE")), false);
});
