const FIELDS = Object.freeze([
  "payment_uuid", "transaction_id", "payment_hash", "transaction_amount",
  "transaction_approved_amount", "response_approved", "response_incomplete",
  "status", "order_id", "transaction_currency", "order_currency",
]);

// Own undefined properties count as present, with type 'missing'. This preserves
// the distinction between absent wire fields and SDK-initialized undefined fields.
function shape(source) {
  return Object.fromEntries(FIELDS.map(field => {
    const descriptor = source == null ? null : Object.getOwnPropertyDescriptor(source, field);
    const present = Boolean(descriptor);
    const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
    const type = value === undefined ? "missing"
      : value === null ? "null"
        : Array.isArray(value) ? "array"
          : ["string", "number", "boolean"].includes(typeof value) ? typeof value : "object";
    return [field, { present, type }];
  }));
}

export function capturePixelPayStatusShape(provider, options, source) {
  try {
    if (options?.enabled !== true || process.env.ENTORNO !== "qa"
      || !["development", "test"].includes(process.env.NODE_ENV)
      || provider.env !== "sandbox" || new URL(provider.endpoint).origin !== "https://pixelpay.dev") return null;
    return shape(source);
  } catch {
    return null;
  }
}

export function emitPixelPayStatusShape(options, before, after) {
  try {
    if (!before) return;
    const requestId = options?.requestId;
    options?.logger?.info?.({
      request_id: typeof requestId === "string" && /^req-[A-Za-z0-9-]{1,64}$/.test(requestId)
        ? requestId : null,
      pixelPayStatusShapeProbe: { response_data: before, transaction_result: after },
    }, "PixelPay Status fixed field shapes (no values)");
  } catch {
    // Diagnostics must never affect payment interpretation or error handling.
  }
}
