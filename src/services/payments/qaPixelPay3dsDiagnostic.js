import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { OFFICIAL_QA_CARD_HASHES } from './qaPixelPayOfficialCases.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CARD_HASHES = new Set([
  '9437b269faa268b21d82ac4d61427916332f584498a00debe3d69ab90a0d744c',
  'ca4ce285007723743c0e3d7126dfb1cdde0edd50ea4fbf456a216808917a128a',
]);
const RESPONSE_CLASSES = new Set(['Response', 'Object', 'ErrorResponse', 'FailureResponse', 'InputErrorResponse',
  'TimeoutResponse', 'SuccessResponse', 'PreconditionalResponse', 'PaymentDeclinedResponse', 'PayloadResponse',
  'NotFoundResponse', 'NoAccessResponse', 'NetworkFailureResponse']);
export const QA_3DS_WINDOW_MS = 10 * 60 * 1000;
export const QA_SANDBOX_SESSION_MS = 4 * 60 * 60 * 1000;

export function resolveQaPixelPay3dsDiagnostic(env, { bookingEnabled = false, now = Date.now() } = {}) {
  const sessionFlag = String(env.QA_PIXELPAY_SANDBOX_SESSION_ENABLED || 'false').trim();
  if (!['true', 'false'].includes(sessionFlag)) throw new Error('Sesion Sandbox invalida.');
  const sessionMode = sessionFlag === 'true';
  if (sessionMode && String(env.QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED || 'false').trim() !== 'false') {
    throw new Error('Usa sesion Sandbox o diagnostico por intent, no ambos.');
  }
  const flag = sessionMode ? 'true' : String(env.QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED || 'false').trim();
  const intentId = String(env.QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID || '').trim().toLowerCase();
  if (!['true', 'false'].includes(flag) || (intentId && !UUID.test(intentId))) throw new Error('Configuracion de diagnostico QA 3DS invalida.');
  if (flag === 'false') return Object.freeze({ enabled: false, intentId: intentId || null, until: 0 });
  const untilText = String((sessionMode ? env.QA_PIXELPAY_SANDBOX_SESSION_UNTIL : env.QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL) || '').trim();
  const until = Date.parse(untilText);
  const url = value => String(value || '').trim().replace(/\/$/, '') === 'https://pixelpay.dev';
  const off = name => String(env[name] || 'false').trim() === 'false';
  if (!bookingEnabled || (!sessionMode && !intentId) || env.NODE_ENV !== 'development' || env.ENTORNO !== 'qa'
    || env.PAYMENT_PROVIDER !== 'pixelpay' || env.PIXELPAY_IMPLEMENTATION !== 'sdk' || env.PIXELPAY_ENV !== 'sandbox'
    || !url(env.PIXELPAY_ENDPOINT) || !url(env.PIXELPAY_APP_URL)
    || !off('QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED') || !off('QA_PRIVATE_COMMERCE_SALE_ENABLED')
    || !off('PRIVATE_COMMERCE_PILOT_ENABLED') || !off('ENABLE_QA_PAYMENT_SIMULATION') || !off('ENABLE_QA_VIP_PURCHASE_SIMULATION')
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(untilText)
    || !Number.isFinite(until) || ![new Date(until).toISOString(), new Date(until).toISOString().replace('.000Z', 'Z')].includes(untilText)
    || until > now + (sessionMode ? QA_SANDBOX_SESSION_MS : QA_3DS_WINDOW_MS)) {
    throw new Error('Diagnostico QA 3DS requiere una cuenta QA Sandbox, un intent nuevo y una ventana UTC de hasta diez minutos.');
  }
  return Object.freeze({ enabled: true, intentId: sessionMode ? null : intentId, until,
    ...(sessionMode ? { sessionMode: true, since: now } : {}) });
}

export function qa3dsWindowOpen(config, now = Date.now()) {
  return config?.enabled === true && Number.isFinite(config.until) && now < config.until;
}

export function isQa3dsIntent(config, intentId) {
  // AM: Session scope never grants identity; the existing backend session/owner gate remains mandatory.
  if (config?.sessionMode === true) return typeof intentId === 'string' && UUID.test(intentId);
  return Boolean(config?.intentId && typeof intentId === 'string' && config.intentId === intentId.toLowerCase());
}

export function isQa3dsCardHashAllowed(hash, config) { return (config?.sessionMode ? OFFICIAL_QA_CARD_HASHES : CARD_HASHES).has(hash); }

export function assertQa3dsCardAllowed(cardNumber, config) {
  const normalized = String(cardNumber || '').replace(/\D+/g, '');
  if (!isQa3dsCardHashAllowed(createHash('sha256').update(normalized).digest('hex'), config)) {
    throw new AppError(422, 'La tarjeta no pertenece al caso oficial autorizado para esta observacion.', { code: 'QA_3DS_CARD_NOT_ALLOWED' });
  }
}

export function assertQa3dsInitialPayload(body) {
  const allowed = new Set(['id_grupo_cita', 'id_intent', 'titular_email', 'card_number', 'card_holder', 'card_expire', 'card_cvv',
    'billing_address', 'billing_country', 'billing_state', 'billing_city', 'billing_phone']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) {
    throw new AppError(400, 'Solicitud invalida.', { code: 'QA_3DS_INITIAL_ONLY' });
  }
}

export function assertQa3dsFreshIntent(config, intent, amount, hasPreviousAttempt, now = Date.now()) {
  if (!qa3dsWindowOpen(config, now) || !isQa3dsIntent(config, intent?.id_intent)) {
    throw new AppError(403, 'Observacion Sandbox no disponible.', { code: 'QA_3DS_DIAGNOSTIC_RESTRICTED' });
  }
  if (intent.estado_intent_codigo !== 'link_generado' || hasPreviousAttempt || intent.referencia_externa
    || (config.sessionMode && (!Number.isFinite(Date.parse(intent.created_at)) || Date.parse(intent.created_at) < config.since || Date.parse(intent.created_at) > now))
    || intent.provider_session_id || intent.link_pago_url || Number(amount) !== 1 || Number(intent.monto_hnl) !== 1 || intent.moneda_codigo !== 'HNL'
    || intent.orden_compra !== `MF-PIXELPAY-${intent.id_intent.replaceAll('-', '').toUpperCase()}`) {
    throw new AppError(409, 'La observacion requiere una orden nueva de un lempira.', { code: 'QA_3DS_FRESH_INTENT_REQUIRED' });
  }
}

export function sanitizeQa3dsObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const boolean = name => typeof value[name] === 'boolean' ? value[name] : null;
  const status = name => Number.isInteger(value[name]) && value[name] >= 100 && value[name] <= 599 ? value[name] : null;
  return {
    upstream_http_status: status('upstream_http_status'),
    response_class: RESPONSE_CLASSES.has(value.response_class) ? value.response_class : null,
    transaction_type: ['songbird', 'payload', 'router', 'other', 'absent'].includes(value.transaction_type) ? value.transaction_type : 'absent',
    continuation_required: boolean('continuation_required'), opaque_payload_present: boolean('opaque_payload_present'),
    public_key_request_attempted: boolean('public_key_request_attempted'), public_key_response_received: boolean('public_key_response_received'),
    public_key_http_status: status('public_key_http_status'), public_key_obtained: boolean('public_key_obtained'),
    encryption_completed: boolean('encryption_completed'), stopped_before_continuation: boolean('stopped_before_continuation'),
    browser_authentication_data_exposed: false, continuation_accredited: false,
  };
}
