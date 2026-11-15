import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PATH = '/api/v2/transaction/hosted/sandbox';
const SAFE_HEADER_NAMES = ['server', 'content-type', 'cf-mitigated', 'cf-ray', 'cf-cache-status', 'date', 'via', 'allow'];
const PUBLIC_SANDBOX_KEY = '1234567890';
const PUBLIC_SANDBOX_SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';

export function sanitizeHostedProbeResponse({ status, headers, body }) {
  const safeHeaders = Object.fromEntries(SAFE_HEADER_NAMES.map(name => [name, headers.get(name)])
    .filter(([, value]) => value !== null).map(([name, value]) => [name, String(value).slice(0, 180)]));
  const html = String(body);
  let json = null;
  try { json = JSON.parse(html); } catch { /* AM: HTML y errores del edge no son respuestas financieras. */ }
  const edgeChallenge = headers.get('cf-mitigated') === 'challenge';
  const cloudflareChallengeMarkup = /(?:cf-chl-|challenge-platform|Just a moment|Attention Required!.*Cloudflare)/i.test(html);
  const sandboxModuleUnavailable = /El m[oó]dulo de pago sandbox no existe/i.test(html)
    || (typeof json?.message === 'string' && /El m[oó]dulo de pago sandbox no existe/i.test(json.message));
  let checkout = null;
  if (typeof json?.url === 'string') {
    try {
      const url = new URL(json.url);
      checkout = { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())] };
    } catch { checkout = { invalid: true }; }
  }
  let location = null;
  try {
    const redirect = headers.get('location');
    if (redirect) {
      const url = new URL(redirect, 'https://pixelpay.app');
      location = { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())] };
    }
  } catch { location = { invalid: true }; }
  return {
    status, headers: safeHeaders, bodyBytes: Buffer.byteLength(html), bodySha256: createHash('sha256').update(html).digest('hex'),
    signals: { edgeChallenge, cloudflareChallengeMarkup, sandboxModuleUnavailable,
      jsonResponse: Boolean(json && typeof json === 'object'), success: typeof json?.success === 'boolean' ? json.success : null,
      validationErrorFields: json?.errors && typeof json.errors === 'object' ? Object.keys(json.errors).filter(key => /^_[a-z_]+$/.test(key)) : [] },
    checkout, location,
  };
}

export function buildHostedSandboxProbeCases() {
  const order = `MFHOSTEDDIAG${randomUUID().replaceAll('-', '')}`;
  const build = (origin, variant = 'signed') => {
    const params = new URLSearchParams({
      _key: PUBLIC_SANDBOX_KEY, _order_id: order, _amount: '1.00', _currency: 'HNL',
      _first_name: 'Sandbox', _last_name: 'MasterFade', _email: 'sandbox@example.invalid',
      _complete: 'https://example.invalid/hosted-complete', _cancel: 'https://example.invalid/hosted-cancel', json: 'true',
      _client_signature: createHmac('sha3-512', PUBLIC_SANDBOX_SECRET).update([PUBLIC_SANDBOX_KEY, order, origin].join('|')).digest('hex'),
    });
    if (variant === 'bad_signature') params.set('_client_signature', '0'.repeat(128));
    if (variant === 'missing_name') params.delete('_first_name');
    return params;
  };
  // AM: Solo ruta Sandbox documentada; variaciones acotadas distinguen metodo, validacion y dominio de ejemplo.
  return [
    { id: 'app_post_signed', origin: 'https://pixelpay.app', method: 'POST', variant: 'signed' },
    { id: 'app_get_signed', origin: 'https://pixelpay.app', method: 'GET', variant: 'signed' },
    { id: 'app_post_bad_signature', origin: 'https://pixelpay.app', method: 'POST', variant: 'bad_signature' },
    { id: 'app_post_missing_name', origin: 'https://pixelpay.app', method: 'POST', variant: 'missing_name' },
    { id: 'dev_post_signed', origin: 'https://pixelpay.dev', method: 'POST', variant: 'signed' },
    { id: 'dev_get_signed', origin: 'https://pixelpay.dev', method: 'GET', variant: 'signed' },
  ].map(item => ({ ...item, params: build(item.origin, item.variant) }));
}

export async function runHostedSandboxDiagnostic({ fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  for (const item of buildHostedSandboxProbeCases()) {
    const startedAt = new Date().toISOString();
    const url = new URL(PATH, item.origin);
    if (item.method === 'GET') url.search = item.params.toString();
    const request = { case: item.id, origin: item.origin, path: PATH, method: item.method,
      variant: item.variant, fieldNames: [...item.params.keys()], cardFields: false, callbackConfigured: false };
    try {
      const response = await fetchImpl(url, {
        method: item.method, redirect: 'manual',
        headers: { accept: 'application/json', ...(item.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(item.method === 'POST' ? { body: item.params.toString() } : {}), signal: AbortSignal.timeout(15000),
      });
      results.push({ startedAt, completedAt: new Date().toISOString(), request,
        response: sanitizeHostedProbeResponse({ status: response.status, headers: response.headers, body: await response.text() }) });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || '');
      results.push({ startedAt, completedAt: new Date().toISOString(), request,
        transportError: ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(code) ? code : 'REQUEST_FAILED' });
    }
  }
  return { mode: 'sandbox_only_no_card_no_callback', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--run-sandbox-only') throw new Error('Requiere --run-sandbox-only. Nunca usa credenciales ni rutas Live.');
  const result = await runHostedSandboxDiagnostic();
  await writeFile(new URL('../docs/evidence/pixelpay-hosted-sandbox-diagnostic-20261114.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
