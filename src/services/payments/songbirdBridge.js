import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { songbirdContract } from './songbirdContract.js';

const fail = (code, status = 409) => new AppError(status, 'La autenticacion no puede continuar. Conserva la reserva y no repitas el pago.', { code });
const TERMINAL = new Set(['contract_blocked', 'interrupted', 'expired', 'authentication_complete']);
const STATES = new Set(['awaiting_response', 'handoff_ready', 'browser_leased', 'setup_in_flight', 'challenge_ready', 'validation_in_flight', ...TERMINAL]);
const text = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const jwt = value => typeof value === 'string' && value.length <= 16000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');

export function resolveSongbirdBridgeConfig(env, diagnostic) {
  const qa = env.NODE_ENV === 'development' && env.ENTORNO === 'qa' && env.PIXELPAY_ENV === 'sandbox'
    && env.PAYMENT_PROVIDER === 'pixelpay' && env.PIXELPAY_IMPLEMENTATION === 'sdk'
    && env.PIXELPAY_ENDPOINT === 'https://pixelpay.dev' && env.PIXELPAY_APP_URL === 'https://pixelpay.dev';
  const value = env.QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED || 'false';
  if (!['true', 'false'].includes(value)) throw fail('SONGBIRD_CONFIG_INVALID', 500);
  if (value === 'false') return Object.freeze({ enabled: false, key: null, qa });
  const encoded = env.QA_PIXELPAY_SONGBIRD_BRIDGE_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (!qa || diagnostic?.enabled !== true || key.length !== 32 || key.toString('base64') !== encoded) throw fail('SONGBIRD_CONFIG_INVALID', 500);
  return Object.freeze({ enabled: true, key, qa });
}

export function sealSongbird(value, key, binding) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
export function openSongbird(box, key, binding) {
  const { iv, tag, data } = JSON.parse(box);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8');
}
const binding = row => [row.id_intent, row.payment_attempt_id, row.owner_id, row.order_id].join('|');
export function songbirdView(row) {
  if (!row) return { state: 'unavailable', can_start: false, can_resume: false, financial_finalization_enabled: false };
  return { state: STATES.has(row.state) ? row.state : 'contract_blocked', version: row.version,
    expires_at: new Date(row.expires_at).toISOString(), can_start: row.state === 'handoff_ready', can_resume: false,
    financial_finalization_enabled: false, block_code: row.state === 'contract_blocked' ? 'PIXELPAY_SONGBIRD_CONTRACT_BLOCKED' : null };
}

export class SongbirdBridge {
  // AM: Contract injection is a local test/code seam; production wiring always uses songbirdContract.
  constructor({ repository, config, contract = songbirdContract, clock = Date.now }) {
    this.repository = repository; this.config = config; this.contract = contract; this.clock = clock;
  }
  async reserve(client, context) {
    if (!this.config.enabled) return null;
    const expires = Math.min(Date.parse(context.expiresAt), this.clock() + 120000);
    if (!Number.isFinite(expires) || expires <= this.clock()) throw fail('SONGBIRD_EXPIRED');
    const row = { id_intent: context.idIntent, payment_attempt_id: context.paymentAttemptId, owner_id: context.ownerId,
      group_id: context.groupId, order_id: context.orderId, amount_hnl: context.amount, currency: context.currency,
      expires_at: new Date(expires).toISOString(), version: 0, lease_id: null, payload_box: null, challenge_box: null };
    row.state = 'awaiting_response';
    try { return songbirdView(await this.repository.reserve(client, row)); }
    catch (error) { if (error.code === '42P01') throw fail('SONGBIRD_SCHEMA_REQUIRED', 503); throw error; }
  }
  async capture(id, owner, payload) {
    if (!this.config.enabled) return null;
    return this.repository.mutate(id, owner, row => {
      if (!this.check(row)) return songbirdView(row);
      if (row.state !== 'awaiting_response') return songbirdView(row);
      const accepted = jwt(payload) && this.contract.browserPayloadAccredited === true
        && this.contract.inspect(payload, { ...row }) === true;
      row.state = accepted ? 'handoff_ready' : 'contract_blocked';
      if (accepted) row.payload_box = sealSongbird(payload, this.config.key, binding(row));
      return songbirdView(row);
    });
  }
  async status(id, owner) {
    return this.repository.mutate(id, owner, row => {
      if (row && Date.parse(row.expires_at) <= this.clock()) this.expire(row);
      return songbirdView(row);
    });
  }
  expire(row) { row.state = 'expired'; row.payload_box = null; row.challenge_box = null; }
  check(row) {
    if (!row) throw fail('SONGBIRD_NOT_FOUND', 404);
    if (row.state === 'expired') return false;
    if (Date.parse(row.expires_at) <= this.clock()) { this.expire(row); return false; }
    return true;
  }
  async claim(id, owner) {
    return this.repository.mutate(id, owner, row => {
      if (!this.check(row)) return songbirdView(row);
      if (!this.config.enabled || !this.config.key || this.contract.browserPayloadAccredited !== true || row.state === 'contract_blocked') throw fail('PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
      if (row.state !== 'handoff_ready') throw fail('SONGBIRD_ALREADY_LEASED');
      let payload;
      try { payload = openSongbird(row.payload_box, this.config.key, binding(row)); }
      catch { row.state = 'contract_blocked'; row.payload_box = null; return songbirdView(row); }
      row.lease_id = randomUUID(); row.state = 'browser_leased'; row.payload_box = null;
      // AM: The payload is delivered once, never reissued on reload or response loss.
      return { ...songbirdView(row), handoff: { protocol: 'songbird-sandbox-v1', lease_id: row.lease_id,
        expires_at: row.expires_at, order_id: row.order_id, jwt: payload, ephemeral_contract_verified: true } };
    });
  }
  async interrupt(id, owner, lease) {
    return this.repository.mutate(id, owner, row => {
      if (!this.check(row)) return songbirdView(row);
      if (row.lease_id && row.lease_id !== lease) throw fail('SONGBIRD_LEASE_MISMATCH', 403);
      if (!TERMINAL.has(row.state)) { row.state = 'interrupted'; row.payload_box = null; row.challenge_box = null; }
      return songbirdView(row);
    });
  }
  async step(id, owner, op, lease, value) {
    if (!['setup', 'validated'].includes(op)) throw fail('SONGBIRD_OPERATION_INVALID', 400);
    if ((op === 'setup' && !text(value)) || (op === 'validated' && !jwt(value))) throw fail('SONGBIRD_INPUT_INVALID', 400);
    const claim = await this.repository.mutate(id, owner, row => {
      if (!this.check(row)) return { stopped: songbirdView(row) };
      if (!this.config.enabled || this.contract.browserPayloadAccredited !== true) throw fail('PIXELPAY_SONGBIRD_CONTRACT_BLOCKED');
      if (!lease || row.lease_id !== lease) throw fail('SONGBIRD_LEASE_MISMATCH', 403);
      if (row.state !== (op === 'setup' ? 'browser_leased' : 'challenge_ready')) throw fail('SONGBIRD_PHASE_ALREADY_CLAIMED');
      row.state = op === 'setup' ? 'setup_in_flight' : 'validation_in_flight';
      row.input_hash = digest(value);
      return structuredClone(row);
    });
    if (claim.stopped) return claim.stopped;
    // AM: A durable phase claim commits before any future authentication adapter is called.
    let result;
    try {
      result = op === 'setup' ? await this.contract.lookup({ reference: value, attempt: claim })
        : await this.contract.validate({ jwt: value, attempt: claim });
    } catch { return this.interrupt(id, owner, lease); }
    return this.repository.mutate(id, owner, row => {
      if (!this.check(row)) return songbirdView(row);
      if (row.lease_id !== lease || row.state !== claim.state) return songbirdView(row);
      if (op === 'setup') {
        // AM: Only a provider adapter may validate ACS destinations; arbitrary browser URLs are never relayed.
        if (result?.verified !== true || this.contract.challengeAllowed?.(result.challenge, claim) !== true || typeof result.challenge?.payload !== 'string'
          || !text(result.challenge?.transactionId) || !text(result.challenge?.authenticationId) || typeof result.challenge?.acsUrl !== 'string'
          || !/^https:\/\//.test(result.challenge.acsUrl) || result.challenge.payload.length > 16000) {
          row.state = 'contract_blocked'; return songbirdView(row);
        }
        row.state = 'challenge_ready'; row.authentication_id = result.challenge.authenticationId;
        return { ...songbirdView(row), challenge: { acsUrl: result.challenge.acsUrl, payload: result.challenge.payload,
          transactionId: result.challenge.transactionId, authenticationId: result.challenge.authenticationId } };
      }
      row.state = result?.verified === true ? 'authentication_complete' : 'contract_blocked';
      // AM: Authentication is never payment evidence; there is deliberately no Sale/finalize adapter here.
      return songbirdView(row);
    });
  }
}
