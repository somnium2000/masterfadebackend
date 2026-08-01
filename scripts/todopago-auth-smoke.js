import dotenv from "dotenv";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TodoPagoAuthClient } from "../src/services/payments/todopago/TodoPagoAuthClient.js";
import { TodoPagoHttpClient } from "../src/services/payments/todopago/TodoPagoHttpClient.js";

export const TODOPAGO_PREPROD_AUTH_URL =
  "https://test-intercom-apitm.azurewebsites.net/api/v1/Auth/Manager/Login";
export const TODOPAGO_SMOKE_CONFIRM_VALUE = "CONFIRM_PREPROD_AUTH_ONLY";

class TodoPagoAuthSmokeError extends Error {
  constructor(code) {
    super("Configuracion de la prueba de autenticacion TodoPago invalida.");
    this.name = "TodoPagoAuthSmokeError";
    this.code = code;
    this.status = null;
  }
}

function readText(source, name) {
  return String(source?.[name] ?? "").trim();
}

function resolveTimeout(value) {
  if (!/^\d+$/.test(value)) {
    throw new TodoPagoAuthSmokeError("TODOPAGO_SMOKE_TIMEOUT_INVALID");
  }
  const timeoutMs = Number(value);
  if (timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new TodoPagoAuthSmokeError("TODOPAGO_SMOKE_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

export function resolveTodoPagoAuthSmokeConfig(source = process.env) {
  const confirmation = readText(source, "TODOPAGO_SMOKE_CONFIRM");
  if (confirmation !== TODOPAGO_SMOKE_CONFIRM_VALUE) {
    throw new TodoPagoAuthSmokeError("TODOPAGO_SMOKE_CONFIRM_REQUIRED");
  }

  const authUrl = readText(source, "TODOPAGO_AUTH_URL");
  if (authUrl !== TODOPAGO_PREPROD_AUTH_URL) {
    throw new TodoPagoAuthSmokeError("TODOPAGO_SMOKE_AUTH_URL_FORBIDDEN");
  }

  const username = readText(source, "TODOPAGO_USERNAME");
  const password = readText(source, "TODOPAGO_PASSWORD");
  if (!username || !password) {
    throw new TodoPagoAuthSmokeError("TODOPAGO_SMOKE_CREDENTIALS_REQUIRED");
  }

  const timeoutMs = resolveTimeout(readText(source, "TODOPAGO_HTTP_TIMEOUT_MS"));
  return Object.freeze({ authUrl, username, password, timeoutMs });
}

function executedAt(now) {
  return now().toISOString();
}

export async function runTodoPagoAuthSmoke({
  source = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  try {
    const config = resolveTodoPagoAuthSmokeConfig(source);
    const httpClient = new TodoPagoHttpClient({
      timeoutMs: config.timeoutMs,
      fetchImpl,
    });
    const authClient = new TodoPagoAuthClient({
      httpClient,
      authUrl: config.authUrl,
    });
    const result = await authClient.authenticate({
      username: config.username,
      password: config.password,
    });

    return {
      test: "todopago_auth_preprod",
      success: true,
      authHost: new URL(config.authUrl).host,
      tokenPresent: true,
      tokenLength: result.token.length,
      transactionIdPresent: true,
      transactionIdLength: result.idTransaccion.length,
      executedAt: executedAt(now),
    };
  } catch (error) {
    return {
      test: "todopago_auth_preprod",
      success: false,
      errorCode: typeof error?.code === "string" ? error.code : "TODOPAGO_AUTH_SMOKE_FAILED",
      httpStatus: Number.isInteger(error?.status) ? error.status : null,
      executedAt: executedAt(now),
    };
  }
}

async function main() {
  dotenv.config({
    path: fileURLToPath(new URL("../.env.todopago.local", import.meta.url)),
  });
  const result = await runTodoPagoAuthSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.success) process.exitCode = 1;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) await main();
