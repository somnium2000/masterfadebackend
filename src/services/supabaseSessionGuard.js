import jwt from 'jsonwebtoken';
import { AppError } from '../utils/errors.js';
import { acquirePasswordOperationLock } from './authRecovery.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new AppError(401, 'La sesión expiró. Inicia sesión nuevamente.', { code: 'AUTH_SUPABASE_INVALID' });
const unavailable = () => new AppError(503, 'No se pudo verificar la sesión. Intenta nuevamente más tarde.', { code: 'AUTH_SUPABASE_SESSION_UNAVAILABLE' });

// AM: Solo se decodifica el MISMO token cuya autenticidad acaba de validar Auth.
export async function verifySupabaseAccessToken(app, token) {
  let result;
  try { result = await app.supabaseAdmin.auth.getUser(token); }
  catch { throw unavailable(); }
  if (result?.error) {
    if (!Number(result.error.status) || Number(result.error.status) >= 500) throw unavailable();
    throw invalid();
  }
  const user = result?.data?.user;
  let claims;
  try { claims = jwt.decode(token); }
  catch { throw invalid(); }
  if (!UUID.test(String(user?.id || '')) || claims?.sub !== user.id ||
      !UUID.test(String(claims?.session_id || '')) || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw invalid();
  return { user, sessionId: claims.session_id };
}

// AM: El llamador conserva el lock hasta terminar la emisión; reset usa la misma clave.
export async function acquireSupabaseSessionGuard(app, user, sessionId) {
  if (!UUID.test(String(user?.id || '')) || !UUID.test(String(sessionId || '')) || !user.email) throw invalid();
  const lock = await acquirePasswordOperationLock(app, user.email);
  try {
    const permission = await lock.client.query(`SELECT
      current_user NOT IN ('anon', 'authenticated')
      AND has_schema_privilege(current_user, 'auth', 'USAGE')
      AND has_column_privilege(current_user, 'auth.sessions', 'id', 'SELECT')
      AND has_column_privilege(current_user, 'auth.sessions', 'user_id', 'SELECT')
      AND has_column_privilege(current_user, 'auth.sessions', 'not_after', 'SELECT') AS allowed`);
    if (permission.rows[0]?.allowed !== true) throw unavailable();
    const active = await lock.client.query(`SELECT id FROM auth.sessions
      WHERE id = $1::uuid AND user_id = $2::uuid
        AND (not_after IS NULL OR not_after > clock_timestamp())`, [sessionId, user.id]);
    if (active.rows.length !== 1) throw invalid();
    return lock;
  } catch (error) {
    await lock.release();
    throw error instanceof AppError ? error : unavailable();
  }
}
