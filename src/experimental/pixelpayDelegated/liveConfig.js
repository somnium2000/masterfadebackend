import { AppError } from '../../utils/errors.js';

// Explicit, one-shot Live verification. Existing private-commerce allowlist
// supplies authenticated account, verified IP, session and CSRF boundaries.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const LIVE_3DS_TEST_WINDOW_MS = 30 * 60 * 1000;
export const LIVE_3DS_MAX_AMOUNT_HNL = 500;
const strictOff = (env, name) => String(env[name] ?? 'false').trim() === 'false';

function isLiveUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password
      && !url.search && !url.hash && !['pixelpay.dev', 'localhost'].includes(url.hostname);
  } catch { return false; }
}

export function resolveLive3dsDirectConfig(env, privateCommerce, { now = Date.now() } = {}) {
  const flag = String(env.PIXELPAY_LIVE_3DS_TEST_ENABLED ?? 'false').trim();
  if (!['true', 'false'].includes(flag)) throw new Error('PIXELPAY_LIVE_3DS_TEST_ENABLED invalido.');
  if (flag === 'false') return null;
  if (!privateCommerce || privateCommerce.enabled || privateCommerce.qaCapabilities
    || privateCommerce.userIds?.length !== 1 || !privateCommerce.ips?.length
    || env.NODE_ENV !== 'production' || env.ENTORNO !== 'production'
    || env.PAYMENT_PROVIDER !== 'pixelpay' || env.PIXELPAY_IMPLEMENTATION !== 'sdk'
    || env.PIXELPAY_ENV !== 'live'
    || !isLiveUrl(env.PIXELPAY_ENDPOINT) || !isLiveUrl(env.PIXELPAY_APP_URL)
    || !strictOff(env, 'PRIVATE_COMMERCE_PILOT_ENABLED')
    || !strictOff(env, 'PUBLIC_BOOKING_ENABLED') || !strictOff(env, 'PUBLIC_VIP_PURCHASE_ENABLED')
    || !strictOff(env, 'QA_PIXELPAY_DELEGATED_ENABLED')
    || !strictOff(env, 'QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED')
    || !strictOff(env, 'ENABLE_QA_PAYMENT_SIMULATION')
    || !strictOff(env, 'ENABLE_QA_VIP_PURCHASE_SIMULATION')
    || (privateCommerce.proxies?.length
      && !['true', '1', 'yes', 'on'].includes(String(env.TRUST_PROXY || '').trim().toLowerCase()))) {
    throw new Error('Live 3DS requiere SDK Live, reservas publicas cerradas y acceso privado por cuenta/IP.');
  }
  return Object.freeze({ enabled: true, liveTest: true, environment: 'live',
    sessionMode: true, since: now, until: now + LIVE_3DS_TEST_WINDOW_MS,
    maxAmountHnl: LIVE_3DS_MAX_AMOUNT_HNL });
}

export function assertLive3dsFreshIntent(config, intent, amount, hasPreviousAttempt, now = Date.now()) {
  const id = String(intent?.id_intent || '');
  const created = Date.parse(intent?.created_at);
  if (!config?.liveTest || now >= config.until || !UUID.test(id)
    || intent?.estado_intent_codigo !== 'link_generado' || hasPreviousAttempt
    || !Number.isFinite(created) || created < config.since || created > now
    || intent?.referencia_externa || intent?.provider_session_id || intent?.link_pago_url
    || intent?.moneda_codigo !== 'HNL'
    || !Number.isFinite(Number(amount)) || Number(amount) <= 0
    || Number(amount) > config.maxAmountHnl || Number(amount) !== Number(intent?.monto_hnl)
    || intent?.orden_compra !== `MF-PIXELPAY-${id.replaceAll('-', '').toUpperCase()}`) {
    throw new AppError(409, 'La prueba Live requiere una reserva nueva y un unico pago permitido.',
      { code: 'PIXELPAY_LIVE_3DS_TEST_RESTRICTED' });
  }
}
