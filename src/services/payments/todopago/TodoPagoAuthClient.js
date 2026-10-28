export class TodoPagoAuthClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TodoPagoAuthClientError";
    this.code = code;
  }
}

function requireNonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TodoPagoAuthClient {
  constructor({ httpClient, authUrl } = {}) {
    if (!httpClient || typeof httpClient.postJson !== "function") {
      throw new TodoPagoAuthClientError(
        "TODOPAGO_AUTH_CLIENT_INVALID",
        "Cliente de autenticacion TodoPago no disponible."
      );
    }
    this.httpClient = httpClient;
    this.authUrl = authUrl;
  }

  async authenticate({ username, password } = {}) {
    if (!requireNonEmptyText(username) || !requireNonEmptyText(password)) {
      throw new TodoPagoAuthClientError(
        "TODOPAGO_AUTH_CREDENTIALS_REQUIRED",
        "Credenciales de autenticacion TodoPago incompletas."
      );
    }

    const response = await this.httpClient.postJson(this.authUrl, {
      userName: username,
      password,
    });

    if (!isObject(response)) {
      throw new TodoPagoAuthClientError(
        "TODOPAGO_AUTH_RESPONSE_INVALID",
        "Respuesta de autenticacion TodoPago invalida."
      );
    }

    const token = response.data?.token;
    if (!requireNonEmptyText(token)) {
      throw new TodoPagoAuthClientError(
        "TODOPAGO_AUTH_TOKEN_MISSING",
        "Respuesta de autenticacion TodoPago incompleta."
      );
    }

    const idTransaccion = response.idTransaccion;
    if (!requireNonEmptyText(idTransaccion)) {
      throw new TodoPagoAuthClientError(
        "TODOPAGO_AUTH_TRANSACTION_ID_MISSING",
        "Respuesta de autenticacion TodoPago incompleta."
      );
    }

    return { token, idTransaccion };
  }
}
