import crypto from "node:crypto";

const PIXELPAY_SIGNATURE_HEADERS = new Set(["x-client-signature", "x-signature"]);
const SHA3_512_HEX_PATTERN = /^[a-f0-9]{128}$/i;

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  return null;
}

function headerEntries(headers = {}, rawHeaders = []) {
  const entries = [];
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = String(rawHeaders[index] ?? "").trim().toLowerCase();
      if (!PIXELPAY_SIGNATURE_HEADERS.has(name)) continue;
      entries.push({ name, value: rawHeaders[index + 1] });
    }
    return entries;
  }

  for (const name of PIXELPAY_SIGNATURE_HEADERS) {
    const value = headers?.[name];
    if (Array.isArray(value)) {
      for (const item of value) entries.push({ name, value: item });
    } else if (value !== undefined) {
      entries.push({ name, value });
    }
  }
  return entries;
}

export function createPixelPayWebhookSignature(rawBody, secretKey) {
  const body = rawBodyBuffer(rawBody);
  const secret = typeof secretKey === "string" ? secretKey : "";
  if (!body || !secret) return null;
  return crypto.createHmac("sha3-512", secret).update(body).digest("hex");
}

export function inspectPixelPayWebhookSignature({
  headers = {},
  rawHeaders = [],
  rawBody,
  secretKey,
} = {}) {
  try {
    const entries = headerEntries(headers, rawHeaders);
    const present = entries.length > 0;
    const ambiguous = entries.length > 1;
    const signature = entries.length === 1 && typeof entries[0].value === "string"
      ? entries[0].value.trim()
      : "";
    const formatValid = !ambiguous && SHA3_512_HEX_PATTERN.test(signature);
    const expected = formatValid ? createPixelPayWebhookSignature(rawBody, secretKey) : null;
    const actualBuffer = formatValid ? Buffer.from(signature, "hex") : null;
    const expectedBuffer = expected ? Buffer.from(expected, "hex") : null;
    const valid = Boolean(
      actualBuffer
      && expectedBuffer
      && actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    );

    return {
      present,
      ambiguous,
      headerCount: entries.length,
      headerName: entries.length === 1 ? entries[0].name : null,
      formatValid,
      rawBodyAvailable: rawBodyBuffer(rawBody) !== null,
      valid,
      enforced: false,
    };
  } catch {
    return {
      present: false,
      ambiguous: false,
      headerCount: 0,
      headerName: null,
      formatValid: false,
      rawBodyAvailable: false,
      valid: false,
      enforced: false,
    };
  }
}
