const MIN_HTTP_TIMEOUT_MS = 1_000;
const MAX_HTTP_TIMEOUT_MS = 30_000;

export class TodoPagoHttpClientError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "TodoPagoHttpClientError";
    this.code = code;
    this.status = status;
  }
}

function normalizeHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new TodoPagoHttpClientError(
      "TODOPAGO_HTTP_URL_INVALID",
      "TodoPago HTTP requiere una URL HTTPS absoluta."
    );
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TodoPagoHttpClientError(
      "TODOPAGO_HTTP_URL_INVALID",
      "TodoPago HTTP requiere una URL HTTPS absoluta."
    );
  }
  return parsed.toString();
}

function normalizeTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_HTTP_TIMEOUT_MS || timeoutMs > MAX_HTTP_TIMEOUT_MS) {
    throw new TodoPagoHttpClientError(
      "TODOPAGO_HTTP_TIMEOUT_INVALID",
      "Timeout HTTP TodoPago fuera del rango permitido."
    );
  }
  return timeoutMs;
}

function isJsonContentType(contentType) {
  const mediaType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export class TodoPagoHttpClient {
  constructor({ timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TodoPagoHttpClientError(
        "TODOPAGO_HTTP_FETCH_UNAVAILABLE",
        "Cliente HTTP TodoPago no disponible."
      );
    }
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.fetchImpl = fetchImpl;
  }

  async postJson(url, payload, { headers = {} } = {}) {
    const targetUrl = normalizeHttpsUrl(url);
    let body;
    try {
      body = JSON.stringify(payload ?? {});
    } catch {
      throw new TodoPagoHttpClientError(
        "TODOPAGO_HTTP_PAYLOAD_INVALID",
        "Payload TodoPago no serializable."
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      if (!response?.ok) {
        throw new TodoPagoHttpClientError(
          "TODOPAGO_HTTP_STATUS_ERROR",
          "TodoPago respondio con un estado HTTP no exitoso.",
          { status: Number.isInteger(response?.status) ? response.status : null }
        );
      }

      if (!isJsonContentType(response.headers?.get?.("content-type"))) {
        throw new TodoPagoHttpClientError(
          "TODOPAGO_HTTP_CONTENT_TYPE_INVALID",
          "TodoPago respondio con un Content-Type no permitido."
        );
      }

      const responseText = await response.text();
      try {
        return JSON.parse(responseText);
      } catch {
        throw new TodoPagoHttpClientError(
          "TODOPAGO_HTTP_JSON_INVALID",
          "TodoPago respondio con JSON invalido."
        );
      }
    } catch (error) {
      if (error instanceof TodoPagoHttpClientError) throw error;
      if (controller.signal.aborted) {
        throw new TodoPagoHttpClientError(
          "TODOPAGO_HTTP_TIMEOUT",
          "La solicitud a TodoPago excedio el tiempo permitido."
        );
      }
      throw new TodoPagoHttpClientError(
        "TODOPAGO_HTTP_NETWORK_ERROR",
        "No fue posible completar la solicitud a TodoPago."
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
