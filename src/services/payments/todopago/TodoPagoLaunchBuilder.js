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

function normalizeHttpsUrl(value, fieldName, { originOnly = false } = {}) {
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
  return originOnly ? parsed.origin : parsed.toString();
}

function normalizeAmount(value) {
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
    amount: normalizeAmount(amount),
    customerName: requireNonEmptyText(customerName, "customerName"),
    ordenDeCompra: requireNonEmptyText(ordenDeCompra, "ordenDeCompra"),
    currencyCode: requireNonEmptyText(currencyCode, "currencyCode"),
  };

  if (normalizedComment) fields.comentario = normalizedComment;
  fields.encrypted = requireNonEmptyText(encrypted, "encrypted");

  const launch = {
    type: "iframe_post",
    action: normalizeHttpsUrl(modalUrl, "modalUrl"),
    method: "POST",
    fields,
    allowedMessageOrigin: normalizeHttpsUrl(
      allowedMessageOrigin,
      "allowedMessageOrigin",
      { originOnly: true }
    ),
    expiresAt: requireNonEmptyText(expiresAt, "expiresAt"),
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
