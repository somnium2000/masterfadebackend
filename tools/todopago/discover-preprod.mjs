/* eslint-disable no-console -- CLI de diagnostico controlado. */
import dotenv from "dotenv";

dotenv.config();

const DISCOVERY_PATHS = [
  "/",
  "/swagger",
  "/swagger/index.html",
  "/swagger.json",
  "/openapi.json",
  "/api-docs",
  "/docs",
  "/health",
  "/status",
];

const REQUIRED_ENV = [
  "TODOPAGO_BASE_URL",
  "TODOPAGO_USERNAME",
  "TODOPAGO_PASSWORD",
  "TODOPAGO_COMMERCE_ID",
  "TODOPAGO_TENANT",
  "TODOPAGO_TERMINAL",
];

function readEnv(name) {
  return String(process.env[name] || "").trim();
}

function replaceSecretValues(value) {
  let sanitized = String(value ?? "");
  for (const name of REQUIRED_ENV.slice(1)) {
    const secret = readEnv(name);
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized;
}

function sanitizeText(value) {
  return replaceSecretValues(value)
    .replace(/(authorization|password|passwd|secret|token|api[-_]?key)(\s*[=:]\s*)([^\s,;"']+)/gi, "$1$2[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
}

function printCredentialPresence() {
  const labels = [
    ["TODOPAGO_USERNAME", "username"],
    ["TODOPAGO_PASSWORD", "password"],
    ["TODOPAGO_COMMERCE_ID", "commerceId"],
    ["TODOPAGO_TENANT", "tenant"],
    ["TODOPAGO_TERMINAL", "terminal"],
  ];

  for (const [name, label] of labels) {
    console.log(`${label} presente: ${readEnv(name) ? "si" : "no"}`);
  }
}

function validateConfiguration() {
  printCredentialPresence();
  const missing = REQUIRED_ENV.filter((name) => !readEnv(name));
  if (missing.length) {
    throw new Error(`Variables requeridas faltantes: ${missing.join(", ")}`);
  }

  const baseUrl = new URL(readEnv("TODOPAGO_BASE_URL"));
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error("TODOPAGO_BASE_URL debe usar http o https.");
  }
  return baseUrl;
}

async function inspectPath(baseUrl, path) {
  const url = new URL(path, baseUrl);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/json, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1",
        "User-Agent": "MasterFade-TodoPago-Preprod-Discovery/1.0",
      },
    });
    const body = await response.text();
    const preview = sanitizeText(body).slice(0, 300) || "[respuesta vacia]";
    console.log(`\nGET ${sanitizeText(response.url || url.href)}`);
    console.log(`status: ${response.status}`);
    console.log(`content-type: ${response.headers.get("content-type") || "no informado"}`);
    console.log(`respuesta: ${preview}`);
  } catch (error) {
    console.log(`\nGET ${sanitizeText(url.href)}`);
    console.log("status: sin respuesta");
    console.log("content-type: no disponible");
    console.log(`respuesta: ${sanitizeText(error?.message || error)}`);
  }
}

async function main() {
  const baseUrl = validateConfiguration();
  console.log(`base URL: ${baseUrl.origin}`);
  console.log("Discovery limitado a rutas conocidas de documentacion y estado; no se enviaran credenciales.");

  for (const path of DISCOVERY_PATHS) {
    await inspectPath(baseUrl, path);
  }
}

main().catch((error) => {
  console.error(`Discovery abortado: ${sanitizeText(error?.message || error)}`);
  process.exitCode = 1;
});
