import { AppError } from "../../utils/errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function assertUuid(value, fieldName, {
  required = true,
  code = "STORAGE_UUID_INVALID",
} = {}) {
  const raw = normalizeOptionalText(value);
  if (!raw) {
    if (required) {
      throw new AppError(400, `${fieldName} es requerido`, { code });
    }
    return null;
  }
  if (!UUID_PATTERN.test(raw)) {
    throw new AppError(400, `${fieldName} debe ser UUID valido`, { code });
  }
  return raw;
}

export function userHasRole(claims, roleName) {
  return Array.isArray(claims?.roles) && claims.roles.includes(roleName);
}

export function assertScopeRole(scope, claims) {
  const roles = Array.isArray(claims?.roles) ? claims.roles : [];
  const allowed = Array.isArray(scope?.allowedRoles) ? scope.allowedRoles : [];
  if (!allowed.length) return;
  const granted = allowed.some((role) => roles.includes(role));
  if (!granted) {
    throw new AppError(403, "No tienes permisos para usar este scope de Storage", {
      code: "STORAGE_SCOPE_FORBIDDEN",
      details: { scope_key: scope?.key, roles },
    });
  }
}

export function assertScopeEntityType(scope, entityType) {
  const normalized = normalizeOptionalText(entityType);
  if (!normalized) {
    throw new AppError(400, "entity_type es requerido", { code: "STORAGE_ENTITY_TYPE_REQUIRED" });
  }
  if (normalized !== scope.entityType) {
    throw new AppError(400, "entity_type no coincide con el scope", {
      code: "STORAGE_ENTITY_TYPE_MISMATCH",
      details: { expected: scope.entityType, received: normalized, scope_key: scope.key },
    });
  }
  return normalized;
}

export function assertScopeFileRules(scope, { contentType, sizeBytes, fileName }) {
  const normalizedType = normalizeOptionalText(contentType)?.toLowerCase();
  if (!normalizedType) {
    throw new AppError(400, "content_type es requerido", { code: "STORAGE_CONTENT_TYPE_REQUIRED" });
  }
  if (!scope.allowedMimeTypes.includes(normalizedType)) {
    throw new AppError(400, "Tipo de archivo no permitido para este scope", {
      code: "STORAGE_CONTENT_TYPE_NOT_ALLOWED",
      details: { scope_key: scope.key, content_type: normalizedType },
    });
  }

  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new AppError(400, "size_bytes invalido", { code: "STORAGE_SIZE_INVALID" });
  }
  if (bytes > Number(scope.maxBytes)) {
    throw new AppError(400, `El archivo excede el maximo permitido de ${scope.maxBytes} bytes`, {
      code: "STORAGE_SIZE_EXCEEDED",
      details: { max_bytes: scope.maxBytes, size_bytes: bytes },
    });
  }

  const normalizedFileName = normalizeOptionalText(fileName);
  if (!normalizedFileName) {
    throw new AppError(400, "file_name es requerido", { code: "STORAGE_FILENAME_REQUIRED" });
  }
  if (normalizedFileName.length > 180) {
    throw new AppError(400, "file_name excede longitud maxima permitida", {
      code: "STORAGE_FILENAME_TOO_LONG",
    });
  }

  return {
    contentType: normalizedType,
    sizeBytes: Math.trunc(bytes),
    fileName: normalizedFileName,
  };
}

export function assertScopeBranch(scope, idSucursal) {
  if (!scope.requiresBranchId) return null;
  return assertUuid(idSucursal, "id_sucursal", {
    required: true,
    code: "STORAGE_BRANCH_REQUIRED",
  });
}

export function assertBranchAccess(claims, idSucursal) {
  if (!idSucursal) return;
  if (userHasRole(claims, "super_admin")) return;
  if (userHasRole(claims, "cliente")) return;
  const branchIds = Array.isArray(claims?.branch_ids) ? claims.branch_ids.map((item) => String(item)) : [];
  if (!branchIds.includes(String(idSucursal))) {
    throw new AppError(403, "No tienes acceso a la sucursal indicada para esta operacion", {
      code: "STORAGE_BRANCH_FORBIDDEN",
      details: { id_sucursal: idSucursal },
    });
  }
}
