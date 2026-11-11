const SENSITIVE_HEADER_NAME = /authorization|cookie|secret|token|key|signature|credential/i;
const SAFE_HEADER_VALUES = new Set(["content-type", "content-length"]);

function valueShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function buildPixelPayCallbackProbeTelemetry(request = {}) {
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body
    : {};
  const headers = request.headers && typeof request.headers === "object"
    ? request.headers
    : {};
  const headerNames = Object.keys(headers)
    .map((name) => String(name).trim().toLowerCase())
    .filter((name) => name && !SENSITIVE_HEADER_NAME.test(name))
    .sort()
    .slice(0, 40);
  const safeHeaders = {};
  for (const name of headerNames) {
    if (SAFE_HEADER_VALUES.has(name)) {
      safeHeaders[name] = String(headers[name] ?? "").slice(0, 120);
    }
  }
  const bodyShape = {};
  for (const key of Object.keys(body).sort().slice(0, 40)) {
    bodyShape[key] = valueShape(body[key]);
  }
  return {
    event: "pixelpay_order_callback_probe",
    method: String(request.method || "POST").toUpperCase(),
    header_names: headerNames,
    safe_headers: safeHeaders,
    body_shape: bodyShape,
    body_field_count: Object.keys(body).length,
  };
}
