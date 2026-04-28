import { isIP } from "node:net";

const USER_AGENT_MAX_LENGTH = 512;
const REQUEST_ID_MAX_LENGTH = 128;

function normalizeText(value, maxLength) {
  const normalized = String(value || "").normalize("NFC").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function getFirstForwardedIp(rawHeader) {
  const raw = String(rawHeader || "").trim();
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim() || "";
  return first || null;
}

function sanitizeIp(candidate) {
  const value = String(candidate || "").trim();
  if (!value) return null;

  if (isIP(value)) return value;

  if (value.startsWith("::ffff:")) {
    const v4 = value.replace("::ffff:", "");
    if (isIP(v4) === 4) return v4;
  }

  return null;
}

export function getRequestMeta(request) {
  const forwarded = getFirstForwardedIp(request?.headers?.["x-forwarded-for"]);
  const realIpHeader = String(request?.headers?.["x-real-ip"] || "").trim();
  const ip =
    sanitizeIp(forwarded) ||
    sanitizeIp(realIpHeader) ||
    sanitizeIp(request?.ip) ||
    null;

  const userAgent = normalizeText(request?.headers?.["user-agent"], USER_AGENT_MAX_LENGTH);
  const requestId = normalizeText(request?.id, REQUEST_ID_MAX_LENGTH);

  return {
    ip,
    userAgent,
    requestId,
  };
}

export function maskIpAddress(ipValue) {
  const ip = sanitizeIp(ipValue);
  if (!ip) return null;

  if (isIP(ip) === 4) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.*.*`;
  }

  const chunks = ip.split(":").filter(Boolean);
  if (!chunks.length) return null;
  const keep = chunks.slice(0, 3).join(":");
  return `${keep}:*:*:*`;
}

export function shortenUserAgent(userAgent, maxLength = 64) {
  const normalized = normalizeText(userAgent, Math.max(16, Number(maxLength || 64)));
  return normalized || null;
}
