import crypto from "node:crypto";
import { AppError } from "../../utils/errors.js";

export const HOSTED_CONFIRMATION_BLOCKED = "PIXELPAY_HOSTED_CONFIRMATION_BLOCKED";
export const HOSTED_SANDBOX_ENDPOINT = "https://pixelpay.app/api/v2/transaction/hosted/sandbox";
const CHECKOUT_ORIGINS = new Set(["https://pixelpay.app", "https://www.pixelpay.app", "https://pixelpay.dev"]);
const CHECKOUT_PATH = /^\/sandbox\/[A-Za-z0-9_-]+\/checkout(?:\/[A-Za-z0-9_-]+)?\/?$/;
const text = value => String(value ?? "").trim();

function fail(status, code, message = "No se pudo iniciar el pago seguro") {
  throw new AppError(status, message, { code });
}

export function resolvePixelPayHostedConfig(env = process.env) {
  const flag = text(env.PIXELPAY_HOSTED_ENABLED || "false");
  if (!["true", "false"].includes(flag)) throw new Error("PIXELPAY_HOSTED_ENABLED debe ser true o false.");
  const hasCallbackConfig = Boolean(text(env.PIXELPAY_HOSTED_KEY_ID) || text(env.PIXELPAY_HOSTED_SECRET_KEY) || text(env.PIXELPAY_HOSTED_CALLBACK_URL));
  if (flag === "false" && !hasCallbackConfig) return Object.freeze({ enabled: false });
  if (env.ENTORNO !== "qa" || env.PIXELPAY_ENV !== "sandbox"
    || (flag === "true" && (env.PAYMENT_PROVIDER !== "pixelpay" || text(env.ADMIN_DATA_ENTRY_MODE) === "true"))) {
    throw new Error("Hosted solo se permite en QA con PixelPay Sandbox habilitado.");
  }
  const keyId = text(env.PIXELPAY_HOSTED_KEY_ID);
  const secretKey = text(env.PIXELPAY_HOSTED_SECRET_KEY);
  const appUrl = text(env.PIXELPAY_HOSTED_APP_URL);
  if (!/^[A-Za-z0-9]+$/.test(keyId) || !secretKey || appUrl !== "https://pixelpay.app") {
    throw new Error("Hosted requiere credenciales dedicadas y PIXELPAY_HOSTED_APP_URL=https://pixelpay.app.");
  }
  const frontend = new URL(text(env.FRONTEND_URL));
  const callback = new URL(text(env.PIXELPAY_HOSTED_CALLBACK_URL));
  if (frontend.origin !== "https://qa.masterfadeapp.com" || frontend.username || frontend.password || frontend.port
    || frontend.pathname !== "/" || frontend.search || frontend.hash
    || callback.protocol !== "https:" || callback.username || callback.password || callback.port || callback.search || callback.hash
    || callback.hostname === "masterfadeapp.com" || callback.hostname === "www.masterfadeapp.com"
    || callback.pathname !== "/v1/pagos/pixelpay/hosted/callback") {
    throw new Error("Hosted requiere retorno QA y callback HTTPS dedicado sin parametros.");
  }
  return Object.freeze({ enabled: flag === "true", receivingEnabled: true, keyId, secretKey, appUrl, frontendOrigin: frontend.origin, callbackUrl: callback.href });
}

export function assertHostedAvailable(config) {
  if (config?.enabled !== true) fail(503, "PIXELPAY_HOSTED_DISABLED", "El pago seguro no esta disponible");
}

export function hostedRequestSignature({ keyId, secretKey, appUrl }, orderId) {
  return crypto.createHmac("sha3-512", secretKey).update(`${keyId}|${orderId}|${appUrl}`).digest("hex");
}

export function validateHostedCheckoutUrl(value) {
  let url;
  try { url = new URL(text(value)); } catch { fail(502, "PIXELPAY_HOSTED_URL_INVALID"); }
  if (!CHECKOUT_ORIGINS.has(url.origin) || url.username || url.password || url.port || url.hash
    || !CHECKOUT_PATH.test(url.pathname) || url.href.length > 16000) fail(502, "PIXELPAY_HOSTED_URL_INVALID");
  return url.href;
}

export function buildHostedRequest(config, { orderId, idIntent, idGrupoCita, amount, currency, firstName, lastName, email, expiresAt, items = [] }) {
  assertHostedAvailable(config);
  if (!/^MF-PIXELPAY-[A-F0-9]{32}$/.test(orderId) || currency !== "HNL"
    || !Number.isSafeInteger(Math.round(Number(amount) * 100)) || Number(amount) <= 0
    || text(firstName).length < 3 || text(firstName).length > 120 || text(lastName).length < 2 || text(lastName).length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(email))) fail(409, "PIXELPAY_HOSTED_CANONICAL_DATA_INVALID");
  if (items.length && (items.some(item => text(item.title).length < 3 || text(item.title).length > 60
    || !Number.isFinite(item.price) || item.price < 0 || !Number.isInteger(item.qty) || item.qty < 1
    || Math.round(item.total * 100) !== Math.round(item.price * item.qty * 100))
    || Math.round(items.reduce((sum, item) => sum + item.total, 0) * 100) !== Math.round(Number(amount) * 100))) {
    fail(409, "PIXELPAY_HOSTED_CANONICAL_ITEMS_INVALID");
  }
  const complete = new URL("/agendar/pagar", config.frontendOrigin);
  complete.searchParams.set("id_grupo_cita", idGrupoCita);
  complete.searchParams.set("id_intent", idIntent);
  complete.searchParams.set("hosted_return", "complete");
  const cancel = new URL(complete);
  cancel.searchParams.set("hosted_return", "cancel");
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) fail(409, "PUBLIC_PAGOS_HOLD_EXPIRED");
  // AM: PixelPay no documenta zona horaria para expired_at; el vencimiento local sigue siendo autoritativo.
  const params = new URLSearchParams({
    _key: config.keyId, _client_signature: hostedRequestSignature(config, orderId), _order_id: orderId,
    _amount: Number(amount).toFixed(2), _currency: "HNL", _first_name: text(firstName), _last_name: text(lastName),
    _email: text(email), _callback: config.callbackUrl, _complete: complete.href, _cancel: cancel.href, json: "true",
  });
  if (items.length) params.set("_order_content", Buffer.from(JSON.stringify(items)).toString("base64"));
  return params;
}

export async function requestHostedCheckout(config, order, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const params = buildHostedRequest(config, order);
  try {
    const response = await fetchImpl(HOSTED_SANDBOX_ENDPOINT, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) fail(502, "PIXELPAY_HOSTED_RESPONSE_INVALID");
    const body = await response.json();
    if (response.status >= 400 || body?.success !== true) fail(502, "PIXELPAY_HOSTED_CREATE_REJECTED");
    return validateHostedCheckoutUrl(body.url);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(502, "PIXELPAY_HOSTED_CREATE_UNCERTAIN", "El pago esta pendiente de verificacion. No intentes pagarlo de nuevo");
  }
}

export function validateHostedCallback(config, session, body) {
  const order = text(body?.order);
  if (order !== session.order_id) fail(409, "PIXELPAY_HOSTED_ORDER_MISMATCH");
  const expected = crypto.createHash("md5").update(`${session.order_id}|${config.keyId}|${config.secretKey}`).digest("hex");
  const received = text(body?.payment_hash).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(received) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    fail(401, "PIXELPAY_HOSTED_HASH_INVALID", "Notificacion de pago invalida");
  }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(text(body?.amount))
    || Math.round(Number(body.amount) * 100) !== Math.round(Number(session.amount_hnl) * 100)) fail(409, "PIXELPAY_HOSTED_AMOUNT_MISMATCH");
  if (body?.currency !== "HNL" || session.currency !== "HNL") fail(409, "PIXELPAY_HOSTED_CURRENCY_MISMATCH");
  if (!["paid", "failed", "cancelled"].includes(body?.status)) fail(400, "PIXELPAY_HOSTED_RESULT_INVALID");
  const uuid = text(body?.uuid);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(uuid)) fail(400, "PIXELPAY_HOSTED_REFERENCE_INVALID");
  // AM: El hash estatico es correlacion de orden; no autentica resultado, monto, moneda ni UUID.
  return { order_id: order, provider_status_untrusted: body.status, payment_uuid_untrusted: uuid, callback_authenticated: false,
    correlation_hash_valid: true, amount: Number(body.amount), currency: "HNL" };
}

export function hostedStatusPayload(session, intent, now = Date.now(), groupRows = null) {
  const expired = new Date(session.expires_at).getTime() <= now;
  const groupPayable = groupRows === null || (groupRows.length > 0 && groupRows.every(row => row.estado_grupo_codigo === "activo"
    && ["en_espera", "pendiente_pago"].includes(row.estado_cita_codigo) && row.estado_hold_codigo === "activo"
    && new Date(row.expires_at).getTime() > now));
  const checkoutUrl = !expired && groupPayable && intent.estado_intent_codigo === "pendiente_confirmacion"
    && session.provider_status_untrusted !== "paid" && session.creation_state === "checkout_ready"
    ? validateHostedCheckoutUrl(session.checkout_url) : null;
  return { id_intent: intent.id_intent, payment_channel: "hosted", checkout_url: checkoutUrl, payment_url: checkoutUrl,
    hosted_state: session.creation_state, estado_intent_codigo: intent.estado_intent_codigo, expires_at: session.expires_at,
    pending_confirmation: true, booking_confirmed: false, manual_reconciliation_required: true,
    automatic_confirmation: false, callback_received: Boolean(session.callback_received_at),
    late_payment_reported: session.late_payment_reported === true, expired, code: HOSTED_CONFIRMATION_BLOCKED };
}

export async function loadHostedSession(db, idIntent) {
  return (await db.query("SELECT * FROM app_private.pixelpay_hosted_sessions WHERE id_intent = $1::uuid", [idIntent])).rows[0] || null;
}

export async function processHostedCallback({ db, config, body }) {
  if (config?.receivingEnabled !== true) fail(503, "PIXELPAY_HOSTED_DISABLED", "El pago seguro no esta disponible");
  const orderId = text(body?.order);
  if (!/^MF-PIXELPAY-[A-F0-9]{32}$/.test(orderId)) fail(400, "PIXELPAY_HOSTED_ORDER_INVALID");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM app_private.pixelpay_hosted_sessions WHERE order_id = $1::text FOR UPDATE", [orderId]);
    const session = result.rows[0];
    if (!session) fail(404, "PIXELPAY_HOSTED_ORDER_NOT_FOUND");
    const receipt = validateHostedCallback(config, session, body);
    const digest = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
    const duplicate = (session.callback_digests || []).includes(digest) || session.callback_digest === digest;
    if (!duplicate) {
      await client.query(
        `UPDATE app_private.pixelpay_hosted_sessions SET callback_received_at = COALESCE(callback_received_at, clock_timestamp()),
           callback_digest = $2::text,
           callback_digests = CASE WHEN cardinality(callback_digests) < 16 THEN array_append(callback_digests, $2::text) ELSE callback_digests END,
           provider_status_untrusted = CASE WHEN provider_status_untrusted = 'paid' THEN 'paid' ELSE $3::text END,
           payment_uuid_untrusted = CASE WHEN provider_status_untrusted = 'paid' THEN payment_uuid_untrusted ELSE $4::text END,
           late_payment_reported = late_payment_reported OR ($3::text = 'paid' AND expires_at <= clock_timestamp()), updated_at = clock_timestamp()
         WHERE id_intent = $1::uuid`,
        [session.id_intent, digest, receipt.provider_status_untrusted, receipt.payment_uuid_untrusted]
      );
    }
    await client.query("COMMIT");
    return { processed: false, duplicate, payment_channel: "hosted", callback_authenticated: false,
      correlation_hash_valid: true, pending_confirmation: true, booking_confirmed: false,
      manual_reconciliation_required: true, code: HOSTED_CONFIRMATION_BLOCKED };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* AM: Conserva el error original. */ }
    throw error;
  } finally { client.release(); }
}
