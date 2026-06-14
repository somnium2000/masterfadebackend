/* eslint-disable no-console -- CLI de prueba manual controlada. */
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const SENSITIVE_ENV = [
  "TODOPAGO_USERNAME",
  "TODOPAGO_PASSWORD",
  "TODOPAGO_COMMERCE_ID",
  "TODOPAGO_TENANT",
  "TODOPAGO_TERMINAL",
];

function readEnv(name) {
  return String(process.env[name] || "").trim();
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) throw new Error(`Variable requerida faltante: ${name}`);
  return value;
}

function redactString(value, extraSecrets = []) {
  let sanitized = String(value ?? "");
  for (const name of SENSITIVE_ENV) {
    const secret = readEnv(name);
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  for (const secret of extraSecrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized;
}

function sanitizeValue(value, extraSecrets = [], key = "") {
  if (/authorization|password|passwd|secret|token|api[-_]?key/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, extraSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, extraSecrets, childKey),
      ])
    );
  }
  return typeof value === "string" ? redactString(value, extraSecrets) : value;
}

function parseJsonResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolveJsonPath(value, path) {
  const normalizedPath = String(path || "")
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1");
  if (!normalizedPath) return undefined;
  return normalizedPath.split(".").filter(Boolean).reduce((current, segment) => current?.[segment], value);
}

function buildUrl(baseUrl, configuredPath, variableName) {
  const path = String(configuredPath || "").trim();
  if (!path) throw new Error(`Variable requerida faltante: ${variableName}`);
  if (!path.startsWith("/")) {
    throw new Error(`${variableName} debe ser una ruta absoluta que inicie con /, no una URL inventada por el script.`);
  }
  return new URL(path, baseUrl);
}

function buildBasicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function requestBearerToken({ baseUrl, username, password }) {
  const tokenPath = requireEnv("TODOPAGO_TOKEN_PATH");
  const tokenJsonPath = requireEnv("TODOPAGO_TOKEN_JSON_PATH");
  const tokenUrl = buildUrl(baseUrl, tokenPath, "TODOPAGO_TOKEN_PATH");
  const basicAuthorization = buildBasicAuthorization(username, password);
  const response = await fetch(tokenUrl, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      Authorization: basicAuthorization,
      "User-Agent": "MasterFade-TodoPago-Preprod-Test/1.0",
    },
  });
  const rawBody = await response.text();
  const parsedBody = parseJsonResponse(rawBody);
  if (!response.ok) {
    console.error("Respuesta de token sanitizada:");
    console.error(JSON.stringify(sanitizeValue({ status: response.status, body: parsedBody }, [basicAuthorization]), null, 2));
    throw new Error(`La solicitud de token fallo con HTTP ${response.status}.`);
  }
  const token = resolveJsonPath(parsedBody, tokenJsonPath);
  if (!token || typeof token !== "string") {
    throw new Error(`No se encontro un token string en TODOPAGO_TOKEN_JSON_PATH=${tokenJsonPath}.`);
  }
  return token;
}

function buildPayload() {
  const amount = Number(readEnv("TODOPAGO_TEST_AMOUNT_HNL") || "1.00");
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("TODOPAGO_TEST_AMOUNT_HNL debe ser un numero positivo.");
  }

  return {
    commerceId: requireEnv("TODOPAGO_COMMERCE_ID"),
    tenant: requireEnv("TODOPAGO_TENANT"),
    terminal: requireEnv("TODOPAGO_TERMINAL"),
    amount: amount.toFixed(2),
    currency: "HNL",
    reference: readEnv("TODOPAGO_TEST_REFERENCE") || `masterfade-preprod-${crypto.randomUUID()}`,
    callbackUrl: readEnv("TODOPAGO_TEST_CALLBACK_URL") || undefined,
  };
}

async function main() {
  if (readEnv("TODOPAGO_ALLOW_REAL_TEST_INTENT").toLowerCase() !== "true") {
    throw new Error("Prueba real desactivada. Define TODOPAGO_ALLOW_REAL_TEST_INTENT=true para habilitarla explicitamente.");
  }

  const baseUrl = new URL(requireEnv("TODOPAGO_BASE_URL"));
  const createIntentUrl = buildUrl(
    baseUrl,
    requireEnv("TODOPAGO_CREATE_INTENT_PATH"),
    "TODOPAGO_CREATE_INTENT_PATH"
  );
  const checkoutUrlJsonPath = requireEnv("TODOPAGO_CHECKOUT_URL_JSON_PATH");
  const providerIntentIdJsonPath = requireEnv("TODOPAGO_PROVIDER_INTENT_ID_JSON_PATH");
  const authMode = requireEnv("TODOPAGO_AUTH_MODE").toLowerCase();
  if (!["basic", "bearer", "none"].includes(authMode)) {
    throw new Error("TODOPAGO_AUTH_MODE debe ser basic, bearer o none.");
  }

  const username = readEnv("TODOPAGO_USERNAME");
  const password = readEnv("TODOPAGO_PASSWORD");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "MasterFade-TodoPago-Preprod-Test/1.0",
  };
  const secrets = [];

  if (authMode === "basic") {
    if (!username || !password) throw new Error("Basic Auth requiere TODOPAGO_USERNAME y TODOPAGO_PASSWORD.");
    headers.Authorization = buildBasicAuthorization(username, password);
    secrets.push(headers.Authorization);
  } else if (authMode === "bearer") {
    if (!readEnv("TODOPAGO_TOKEN_PATH") || !readEnv("TODOPAGO_TOKEN_JSON_PATH")) {
      throw new Error("Bearer Auth requiere TODOPAGO_TOKEN_PATH y TODOPAGO_TOKEN_JSON_PATH; falta confirmar el endpoint de token.");
    }
    if (!username || !password) throw new Error("La plantilla de token requiere TODOPAGO_USERNAME y TODOPAGO_PASSWORD.");
    const token = await requestBearerToken({ baseUrl, username, password });
    headers.Authorization = `Bearer ${token}`;
    secrets.push(token, headers.Authorization);
  }

  const payload = buildPayload();
  console.log("Solicitud sanitizada:");
  console.log(JSON.stringify(sanitizeValue({
    method: "POST",
    url: createIntentUrl.href,
    authMode,
    payload,
  }, secrets), null, 2));

  const response = await fetch(createIntentUrl, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    headers,
    body: JSON.stringify(payload),
  });
  const rawBody = await response.text();
  const parsedBody = parseJsonResponse(rawBody);
  const responseHeaders = Object.fromEntries(response.headers.entries());

  console.log("Respuesta HTTP completa sanitizada:");
  console.log(JSON.stringify(sanitizeValue({
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: parsedBody,
  }, secrets), null, 2));

  if (!response.ok) process.exitCode = 1;
  if (parsedBody && typeof parsedBody === "object") {
    const checkoutUrl = resolveJsonPath(parsedBody, checkoutUrlJsonPath);
    const providerIntentId = resolveJsonPath(parsedBody, providerIntentIdJsonPath);
    console.log(`checkout URL encontrada: ${checkoutUrl ? "si" : "no"}`);
    console.log(`provider intent ID encontrado: ${providerIntentId ? "si" : "no"}`);
  }
}

main().catch((error) => {
  console.error(`Prueba real abortada: ${redactString(error?.message || error)}`);
  process.exitCode = 1;
});
