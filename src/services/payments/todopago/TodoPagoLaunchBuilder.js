import {
  normalizeCreateIntentResult,
} from "../paymentProviderContract.js";

export class TodoPagoLaunchBuilderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TodoPagoLaunchBuilderError";
    this.code = code;
  }
}

function requireNonEmptyText(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_FIELD_REQUIRED",
      `Datos de lanzamiento TodoPago incompletos: ${fieldName}.`
    );
  }
  return value;
}

function normalizeHttpsUrl(
  value,
  fieldName,
  { originOnly = false, requireOriginOnly = false } = {}
) {
  const text = requireNonEmptyText(value, fieldName).trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_URL_INVALID",
      `${fieldName} debe ser una URL HTTPS absoluta.`
    );
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_URL_INVALID",
      `${fieldName} debe ser una URL HTTPS absoluta.`
    );
  }
  if (requireOriginOnly && text !== parsed.origin) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_URL_INVALID",
      `${fieldName} debe contener unicamente el origin HTTPS.`
    );
  }
  return originOnly ? parsed.origin : parsed.toString();
}

export function normalizeTodoPagoModalUrl(value) {
  return normalizeHttpsUrl(value, "modalUrl");
}

export function normalizeTodoPagoAllowedMessageOrigin(
  value,
  { requireOriginOnly = false } = {}
) {
  return normalizeHttpsUrl(value, "allowedMessageOrigin", {
    originOnly: true,
    requireOriginOnly,
  });
}

export function normalizeTodoPagoAmount(value) {
  if (value == null || (typeof value === "string" && value.trim().length === 0)) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_AMOUNT_INVALID",
      "El monto de lanzamiento TodoPago es invalido."
    );
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_AMOUNT_INVALID",
      "El monto de lanzamiento TodoPago es invalido."
    );
  }
  const normalized = amount.toFixed(2);
  if (!/^-?\d+\.\d{2}$/.test(normalized) || Number(normalized) <= 0) {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_AMOUNT_INVALID",
      "El monto de lanzamiento TodoPago es invalido."
    );
  }
  return normalized;
}

export function normalizeTodoPagoExpiresAt(value) {
  const expiresAt = requireNonEmptyText(value, "expiresAt");

  try {
    return normalizeCreateIntentResult({
      providerIntentId: "todopago-expiry-validation",
      paymentUrl: null,
      launch: {
        type: "iframe_post",
        action: "https://validation.invalid/",
        method: "POST",
        fields: {},
        allowedMessageOrigin: "https://validation.invalid",
        expiresAt,
      },
      raw: {},
    }).launch.expiresAt;
  } catch {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_EXPIRES_AT_INVALID",
      "expiresAt debe ser una fecha ISO 8601/RFC3339 valida."
    );
  }
}

export function buildTodoPagoLaunch({
  modalUrl,
  allowedMessageOrigin,
  tokenTodomovil,
  idTransaccion,
  amount,
  customerName,
  ordenDeCompra,
  currencyCode,
  comentario,
  encrypted,
  expiresAt,
} = {}) {
  const normalizedComment = typeof comentario === "string" ? comentario.trim() : "";
  const fields = {
    tokenTodomovil: requireNonEmptyText(tokenTodomovil, "tokenTodomovil"),
    idTransaccion: requireNonEmptyText(idTransaccion, "idTransaccion"),
    amount: normalizeTodoPagoAmount(amount),
    customerName: requireNonEmptyText(customerName, "customerName"),
    ordenDeCompra: requireNonEmptyText(ordenDeCompra, "ordenDeCompra"),
    currencyCode: requireNonEmptyText(currencyCode, "currencyCode"),
  };

  if (normalizedComment) fields.comentario = normalizedComment;
  fields.encrypted = requireNonEmptyText(encrypted, "encrypted");

  const launch = {
    type: "iframe_post",
    action: normalizeTodoPagoModalUrl(modalUrl),
    method: "POST",
    fields,
    allowedMessageOrigin: normalizeTodoPagoAllowedMessageOrigin(
      allowedMessageOrigin
    ),
    expiresAt: normalizeTodoPagoExpiresAt(expiresAt),
  };

  try {
    return normalizeCreateIntentResult({
      providerIntentId: "todopago-launch-validation",
      paymentUrl: null,
      launch,
      raw: {},
    }).launch;
  } catch {
    throw new TodoPagoLaunchBuilderError(
      "TODOPAGO_LAUNCH_EXPIRES_AT_INVALID",
      "expiresAt debe ser una fecha ISO 8601/RFC3339 valida."
    );
  }
}
