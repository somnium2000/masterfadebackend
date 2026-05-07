import crypto from "node:crypto";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let warnedWeakSecret = false;

function normalizeText(value) {
  return String(value || "").normalize("NFC").trim();
}

export function normalizeIdentifier(identifier) {
  return normalizeText(identifier).toLowerCase();
}

export function maskEmail(email) {
  const normalized = normalizeIdentifier(email);
  if (!EMAIL_REGEX.test(normalized)) return null;

  const [localPart, domain] = normalized.split("@");
  if (!localPart || !domain) return null;
  if (localPart.length <= 2) return `${localPart[0] || "*"}*@${domain}`;
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function resolveHmacSecret() {
  const directSecret =
    process.env.SECURITY_HMAC_SECRET?.trim() ||
    process.env.APP_SECURITY_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    "";

  if (directSecret) {
    return { secret: directSecret, source: "configured" };
  }

  const temporarySecret = process.env.SECURITY_HASH_TEMP_SECRET?.trim() || "";
  if (temporarySecret) {
    return { secret: temporarySecret, source: "temporary" };
  }

  return { secret: null, source: "missing" };
}

function buildHmacHash(rawValue, logger = null, { valueLabel = "value" } = {}) {
  const normalized = normalizeText(rawValue);
  if (!normalized) return { hash: null, weakSecret: false };
  const { secret, source } = resolveHmacSecret();
  if (!secret) {
    if (logger && !warnedWeakSecret) {
      warnedWeakSecret = true;
      logger.warn(
        { event: "security_hash_secret_missing" },
        `No SECURITY_HMAC_SECRET/JWT_SECRET configured for ${valueLabel} hashing`
      );
    }
    return { hash: null, weakSecret: true };
  }

  if (source === "temporary" && logger && !warnedWeakSecret) {
    warnedWeakSecret = true;
    logger.warn(
      { event: "security_hash_temp_secret_in_use" },
      "SECURITY_HASH_TEMP_SECRET in use; rotate to SECURITY_HMAC_SECRET for production hardening"
    );
  }

  const hash = crypto.createHmac("sha256", secret).update(normalized).digest("hex");
  return { hash, weakSecret: source !== "configured" };
}

export function buildIdentifierHash(identifier, logger = null) {
  const normalized = normalizeIdentifier(identifier);
  return buildHmacHash(normalized, logger, { valueLabel: "identifier" });
}

export function buildTokenJtiHash(jti, logger = null) {
  return buildHmacHash(jti, logger, { valueLabel: "jti" });
}
