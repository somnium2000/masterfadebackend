import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildTrustProxy } from './trustProxy.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const normalized = value => {
  const ip = String(value || '').replace(/^::ffff:/, '');
  return net.isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
};
const REASONS = new Set(['PILOT_DISABLED', 'ADMIN_DATA_ENTRY', 'PROVIDER_NOT_PIXELPAY',
  'DIRECT_IP_NOT_ALLOWED', 'PROXY_PEER_NOT_ALLOWED', 'PROXY_CHAIN_LENGTH', 'CLIENT_IP_NOT_ALLOWED',
  'SESSION_MISSING', 'AUTH_CONTEXT_REJECTED', 'USER_NOT_ALLOWED', 'IDENTITY_MISMATCH',
  'CLIENT_NOT_ACTIVE', 'ROLE_NOT_CLIENT', 'ELIGIBLE', 'QA_SIMULATION']);
const mask = value => {
  const ip = normalized(value);
  if (net.isIP(ip) === 4) return ip.split('.').slice(0, 2).join('.') + '.*.*';
  if (net.isIP(ip) === 6) return '[IPv6 masked]';
  return '[invalid]';
};
const quiet = { warn() {}, error() {}, info() {}, debug() {}, trace() {}, fatal() {} };

// AM: Absolute UTC expiry survives restarts; monotonic time also bounds clock rollback.
export function createQaCommerceDiagnostic(app, config, env = process.env, clock = Date.now, monotonic = () => performance.now()) {
  const started = clock(), tick = monotonic();
  const trust = buildTrustProxy(env.TRUST_PROXY);
  const until = Date.parse(env.QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL || '');
  const enabled = env.NODE_ENV === 'development' && env.ENTORNO === 'qa'
    && env.QA_PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED === 'true'
    && /Z$/.test(env.QA_PRIVATE_COMMERCE_DIAGNOSTICS_UNTIL || '')
    && until > started && until - started <= WINDOW_MS;
  let attempts = 0;
  const active = () => enabled && clock() < until && monotonic() - tick < until - started;
  return async (request, reason) => {
    if (!active() || attempts >= MAX_ATTEMPTS || request.method !== 'GET'
      || request.routeOptions.url !== '/v1/commerce/eligibility' || !request.cookies?.mf_session) return;
    attempts++;
    try {
      // AM: Isolate authentication and its reply; no session writes, HTTP changes or auth grants.
      const shadow = { cookies: { mf_session: request.cookies.mf_session }, headers: {},
        ip: request.ip, id: request.id, log: quiet };
      const sink = { sent: false, code() { return this; }, send() { this.sent = true; return this; } };
      await app.authenticate(shadow, sink, { readOnly: true });
      if (sink.sent || !shadow.auth || !active()) return;
      const peer = normalized(request.raw.socket.remoteAddress);
      const resolved = normalized(request.ip);
      const chain = request.ips;
      app.log.info({ event: 'QA_PRIVATE_COMMERCE_PROXY_DIAGNOSTIC', utc: new Date(clock()).toISOString(),
        instance: /^[a-f0-9]{12,64}$/.test(os.hostname()) ? os.hostname() : '[instance masked]', pid: process.pid,
        requestId: /^req-[a-z0-9]{1,16}$/.test(request.id) ? request.id : '[request masked]',
        tcpPeerMasked: mask(peer), requestIpMasked: mask(resolved), ipsLength: Array.isArray(chain) ? chain.length : null,
        fastifyTrustsPeer: typeof trust === 'function' && trust(peer, 0) === true,
        peerAllowlisted: config.proxies.includes(peer), clientAllowlisted: config.ips.includes(resolved),
        directPeerAllowlisted: config.ips.includes(peer), reason: REASONS.has(reason) ? reason : 'UNKNOWN',
      }, 'QA private commerce proxy diagnostic');
    } catch { /* AM: Diagnostic failure must not affect the existing eligibility response. */ }
  };
}
