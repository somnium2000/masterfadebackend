import { AppError } from "../utils/errors.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_REGEX.test(String(value || "").trim());
}

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function getDb(app, client = null) {
  return client || app?.db || null;
}

function logProtectedLookupWarning(app, error, context = {}) {
  app?.log?.warn?.(
    {
      event: "protected_user_lookup_failed",
      code: "PROTECTED_USER_LOOKUP_FAILED",
      ...context,
      error: error instanceof Error ? error.message : "unknown_error",
    },
    "No se pudo consultar app_protected_users"
  );
}

export async function isProtectedUserId(app, idUsuario, options = {}) {
  const safeUserId = String(idUsuario || "").trim();
  if (!isUuid(safeUserId)) return false;

  const db = getDb(app, options.client);
  if (!db) return false;

  try {
    const { rowCount } = await db.query(
      `
        SELECT 1
        FROM public.app_protected_users
        WHERE id_usuario = $1::uuid
          AND activo IS TRUE
        LIMIT 1
      `,
      [safeUserId]
    );
    return rowCount > 0;
  } catch (error) {
    logProtectedLookupWarning(app, error, { lookup: "id_usuario" });
    if (options.failClosed === true) {
      throw error;
    }
    return false;
  }
}

export async function isProtectedIdentifier(app, identifier, options = {}) {
  const safeIdentifier = normalizeIdentifier(identifier);
  if (!safeIdentifier) return false;

  const db = getDb(app, options.client);
  if (!db) return false;

  try {
    const { rowCount } = await db.query(
      `
        SELECT 1
        FROM public.app_protected_users
        WHERE lower(email) = lower($1::text)
          AND activo IS TRUE
        LIMIT 1
      `,
      [safeIdentifier]
    );
    return rowCount > 0;
  } catch (error) {
    logProtectedLookupWarning(app, error, { lookup: "identifier" });
    if (options.failClosed === true) {
      throw error;
    }
    return false;
  }
}

export async function assertUserNotProtected(app, idUsuario, actionCode, options = {}) {
  try {
    const protectedUser = await isProtectedUserId(app, idUsuario, {
      ...options,
      failClosed: options.failClosed !== false,
    });
    if (!protectedUser) return;
  } catch {
    throw new AppError(403, "No se pudo validar si el usuario esta protegido.", {
      code: "ROOT_USER_PROTECTION_CHECK_FAILED",
      details: { action: actionCode || "UNKNOWN_ACTION" },
    });
  }

  const code = String(actionCode || "").trim().toUpperCase();
  if (code.includes("ROLE")) {
    throw new AppError(403, "El rol super_admin del root protegido no puede ser modificado.", {
      code: "ROOT_ROLE_PROTECTED",
    });
  }

  throw new AppError(403, "El usuario root protegido no puede ser bloqueado ni inactivado.", {
    code: "ROOT_USER_PROTECTED",
  });
}
