import { AppError } from "../utils/errors.js";
import { createClient } from "@supabase/supabase-js";
const passwordLockCounts = new WeakMap();

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function buildDefaultRedirectTo() {
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").trim().replace(/\/+$/, "");
  return `${frontendUrl}/login`;
}

function extractActionLink(data) {
  return (
    data?.properties?.action_link ||
    data?.action_link ||
    data?.properties?.email_action_link ||
    null
  );
}

export async function generateRecoveryActionLink(app, email, { redirectTo, passwordReset = false } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new AppError(400, "Correo invalido para recovery link", {
      code: "AUTH_RECOVERY_EMAIL_INVALID",
    });
  }

  if (!app.supabaseAdmin) {
    throw new AppError(500, "Supabase Admin no esta configurado", {
      code: "SUPABASE_ADMIN_NOT_CONFIGURED",
    });
  }

  const targetRedirectTo = String(redirectTo || (passwordReset ? buildDefaultRedirectTo().replace(/\/login$/, '/reset-password') : buildDefaultRedirectTo())).trim();
  const { data, error } = await app.supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email: normalizedEmail,
    options: {
      redirectTo: targetRedirectTo,
    },
  });

  if (error) {
    const errorCode = String(error.code || "").toLowerCase();
    const errorMessage = String(error.message || "No se pudo generar recovery link");
    // AM: Se mantiene respuesta neutra cuando el correo no existe para evitar user enumeration.
    if (errorCode === "user_not_found") {
      return {
        found: false,
        action_link: null,
        redirect_to: targetRedirectTo,
        error_code: errorCode,
      };
    }
    throw new AppError(500, "No se pudo generar el enlace de recuperacion", {
      code: "AUTH_RECOVERY_LINK_ERROR",
      details: { code: errorCode || "unknown", message: errorMessage },
    });
  }

  let actionLink = extractActionLink(data);
  if (passwordReset) {
    const proof = String(data?.properties?.hashed_token || '');
    if (!/^[A-Za-z0-9_-]{20,2048}$/.test(proof)) throw new AppError(503, 'No se pudo generar el enlace.', { code: 'AUTH_RECOVERY_LINK_MISSING' });
    const target = new URL(targetRedirectTo);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1'].includes(target.hostname))) {
      throw new AppError(503, 'No se pudo generar el enlace.', { code: 'AUTH_RECOVERY_LINK_ERROR' });
    }
    target.hash = new URLSearchParams({ token_hash: proof, type: 'recovery' }).toString();
    actionLink = target.href;
  }
  if (!actionLink) {
    throw new AppError(500, "Supabase no retorno action_link de recuperacion", {
      code: "AUTH_RECOVERY_LINK_MISSING",
    });
  }

  return {
    found: true,
    action_link: actionLink,
    redirect_to: targetRedirectTo,
  };
}

// The same local server-side lock serializes password login and password reset.
// Transaction lock works with transaction poolers. Revocation uses a separate
// autocommit connection so it survives any ambiguous failure of external Auth.
export async function acquirePasswordOperationLock(app, email) {
  const pool = app.db;
  const max = Number(pool?.options?.max || 10);
  const count = passwordLockCounts.get(pool) || 0;
  // Reserve pool capacity for the existing session/audit queries nested in login.
  if (max < 2 || count >= Math.floor(max / 2)) throw new AppError(503, 'Intenta nuevamente más tarde.', { code: 'AUTH_PASSWORD_UNAVAILABLE' });
  passwordLockCounts.set(pool, count + 1);
  const uncount = () => passwordLockCounts.set(pool, Math.max(0, (passwordLockCounts.get(pool) || 1) - 1));
  let client;
  const key = 'password-operation:' + normalizeEmail(email);
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [key]);
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    client?.release(error); uncount(); throw new AppError(503, 'No se pudo verificar el acceso.', { code: 'AUTH_PASSWORD_UNAVAILABLE' });
  }
  return { client, async release() {
    let failure;
    try { await client.query('ROLLBACK'); }
    catch (error) { failure = error; }
    finally { client.release(failure); uncount(); }
  } };
}

export async function resetPasswordWithRecovery(app, body, currentUserId = null) {
  const url = process.env.SUPABASE_URL?.trim(), key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key || !app.supabaseAdmin || !app.db) throw new AppError(503, 'No se pudo validar el enlace.', { code: 'AUTH_RESET_UNAVAILABLE' });
  // Never install the recovery session into a shared anon/admin client.
  const recovery = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  let lock, verified = false, completed = false;
  try {
    const { data, error } = await recovery.auth.verifyOtp({ token_hash: body.token_hash, type: 'recovery' });
    if (error || !data?.session || !/^[0-9a-f-]{36}$/i.test(String(data.user?.id || '')) || !data.user?.email) {
      throw new AppError(401, 'El enlace no es válido o expiró. Solicita uno nuevo.', { code: error?.code === 'otp_expired' ? 'OTP_EXPIRED' : 'AUTH_RECOVERY_LINK_INVALID' });
    }
    verified = true;
    const userId = data.user.id;
    if (currentUserId && currentUserId !== userId) throw new AppError(409, 'Cierra la sesión actual antes de utilizar este enlace.', { code: 'AUTH_RECOVERY_IDENTITY_MISMATCH' });
    lock = await acquirePasswordOperationLock(app, data.user.email);
    const internal = await lock.client.query('SELECT id_usuario FROM public.usuarios WHERE id_usuario=$1::uuid AND deleted_at IS NULL', [userId]);
    if (internal.rows.length !== 1) throw new AppError(401, 'No se pudo validar el enlace.', { code: 'AUTH_RECOVERY_LINK_INVALID' });
    // Autocommit: must remain revoked even if Auth fails or its response is lost.
    await app.db.query(`UPDATE public.seguridad_sesiones SET estado = 'revocada', revocada_at=NOW(), cierre_at=NOW(),
      cerrada_por=$1::uuid, motivo_cierre = 'password_reset'
      WHERE id_usuario=$1::uuid AND estado='activa' RETURNING id_sesion`, [userId]);
    const updated = await app.supabaseAdmin.auth.admin.updateUserById(userId, { password: body.contrasena });
    if (updated.error || updated.data?.user?.id !== userId) throw new AppError(503, 'No se pudo completar el cambio. Solicita un enlace nuevo.', { code: 'AUTH_RESET_UNCONFIRMED' });
    const signedOut = await recovery.auth.signOut({ scope: 'global' });
    if (signedOut.error) throw new AppError(503, 'No se pudo confirmar el cierre de sesiones. Solicita un enlace nuevo.', { code: 'AUTH_RESET_UNCONFIRMED' });
    completed = true;
    return { password_updated: true, login_required: true };
  } finally {
    if (verified && !completed) await recovery.auth.signOut({ scope: 'local' }).catch(() => {});
    await lock?.release();
  }
}
