import crypto from "node:crypto";

const MIME_EXTENSION_MAP = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
});

function normalizeSlug(value) {
  const slug = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "archivo";
}

function extractNameWithoutExtension(fileName) {
  const value = String(fileName || "").trim();
  if (!value) return "archivo";
  const cleanName = value.replace(/^.*[\\/]/, "");
  const dotIndex = cleanName.lastIndexOf(".");
  return dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
}

export function resolveExtensionForMime(contentType) {
  const key = String(contentType || "").trim().toLowerCase();
  return MIME_EXTENSION_MAP[key] || null;
}

export function buildStorageObjectPath(scope, {
  branchId = null,
  entityId = null,
  originalFileName = "",
  contentType = "",
  label = "",
} = {}) {
  const extension = resolveExtensionForMime(contentType);
  if (!extension) {
    throw new Error("UNSUPPORTED_MIME_EXTENSION");
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const timestamp = String(Date.now());
  const random = crypto.randomBytes(3).toString("hex");
  const sourceLabel = label || extractNameWithoutExtension(originalFileName);
  const safeSlug = normalizeSlug(sourceLabel);
  const filename = `${timestamp}-${safeSlug}-${random}.${extension}`;
  const variant = normalizeSlug(scope.variant || scope.entityType || "archivo");
  const prefix = normalizeSlug(scope.prefix || "uploads");

  if (scope.key === "private_client_profile") {
    return `${prefix}/${entityId}/perfil/${yyyy}/${mm}/${variant}/${filename}`;
  }

  if (scope.requiresBranchId) {
    return `${prefix}/sucursal/${branchId}/${yyyy}/${mm}/${variant}/${filename}`;
  }

  if (scope.requiresEntityId) {
    return `${prefix}/${entityId}/${yyyy}/${mm}/${variant}/${filename}`;
  }

  return `${prefix}/global/${yyyy}/${mm}/${variant}/${filename}`;
}
