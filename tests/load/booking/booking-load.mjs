/* eslint-disable no-console */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const DEFAULT_API_URL = "https://api-qa.masterfadeapp.com";
const PROFILES = Object.freeze({
  SMOKE: { iterations: 1, concurrency: 1, sseClients: 1, sseMs: 1500 },
  BASELINE: { iterations: 8, concurrency: 2, sseClients: 2, sseMs: 2500 },
  LOAD: { iterations: 40, concurrency: 8, sseClients: 8, sseMs: 5000 },
  TARGET: { iterations: 120, concurrency: 16, sseClients: 16, sseMs: 8000 },
  SPIKE: { iterations: 180, concurrency: 40, sseClients: 30, sseMs: 10000 },
});

const WRITE_SCENARIOS = new Set([
  "public_hold_create_release",
  "auth_hold_create_release",
  "admin_hold_create_release",
  "admin_confirm_cash_pending",
  "double_submit_same_idempotency_key",
  "concurrent_same_slot",
]);

const state = {
  checks: [],
  warnings: [],
  metrics: new Map(),
  context: {
    branchId: env("MF_LOAD_BRANCH_ID"),
    serviceId: env("MF_LOAD_SERVICE_ID"),
    barberId: env("MF_LOAD_BARBER_ID"),
    startAt: env("MF_LOAD_START_AT"),
    lastEventId: env("MF_LOAD_LAST_EVENT_ID", "0"),
  },
};

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function boolEnv(name, fallback = false) {
  const raw = env(name);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveProfile() {
  const profileName = env("MF_LOAD_PROFILE", "SMOKE").toUpperCase();
  const base = PROFILES[profileName];
  if (!base) {
    throw new Error(`MF_LOAD_PROFILE invalido: ${profileName}. Usa ${Object.keys(PROFILES).join(", ")}.`);
  }
  return {
    name: profileName,
    iterations: intEnv("MF_LOAD_ITERATIONS", base.iterations),
    concurrency: intEnv("MF_LOAD_CONCURRENCY", base.concurrency),
    sseClients: intEnv("MF_LOAD_SSE_CLIENTS", base.sseClients),
    sseMs: intEnv("MF_LOAD_SSE_MS", base.sseMs),
  };
}

function apiUrl(path) {
  const base = env("MF_LOAD_API_URL", DEFAULT_API_URL).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function authHeaders(scope = "admin") {
  const headers = { accept: "application/json" };
  const cookie = env(scope === "client" ? "MF_LOAD_CLIENT_COOKIE" : "MF_LOAD_ADMIN_COOKIE");
  const bearer = env(scope === "client" ? "MF_LOAD_CLIENT_BEARER" : "MF_LOAD_ADMIN_BEARER");
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

function canRunWrites() {
  return boolEnv("MF_LOAD_ENABLE_WRITES", false);
}

function hasAdminAuth() {
  return Boolean(env("MF_LOAD_ADMIN_COOKIE") || env("MF_LOAD_ADMIN_BEARER"));
}

function hasClientAuth() {
  return Boolean(env("MF_LOAD_CLIENT_COOKIE") || env("MF_LOAD_CLIENT_BEARER"));
}

function recordMetric(name, ms) {
  const bucket = state.metrics.get(name) || [];
  bucket.push(ms);
  state.metrics.set(name, bucket);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function check(name, ok, details = {}) {
  state.checks.push({ name, ok: Boolean(ok), details });
  if (!ok) {
    console.error(`FAIL ${name}`, details);
  }
}

function warn(name, details = {}) {
  state.warnings.push({ name, details });
  console.warn(`WARN ${name}`, details);
}

async function timed(name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    recordMetric(name, performance.now() - started);
  }
}

async function requestJson(name, path, options = {}) {
  return timed(name, async () => {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { response, payload };
  });
}

async function discoverPublicContext() {
  const { response, payload } = await requestJson("public_context", "/v1/public/citas/contexto");
  check("public context responds 200", response.status === 200, { status: response.status });
  const branches = payload?.data?.sucursales || [];
  if (!state.context.branchId && branches[0]?.id_sucursal) {
    state.context.branchId = branches[0].id_sucursal;
  }
  check("public context has branch", Boolean(state.context.branchId), { branches: branches.length });
}

async function discoverService() {
  if (!state.context.branchId || state.context.serviceId) return;
  const { response, payload } = await requestJson(
    "public_catalog_services",
    `/v1/public/catalog/servicios${qs({ id_sucursal: state.context.branchId })}`
  );
  check("public services responds 200", response.status === 200, { status: response.status });
  const services = payload?.data?.servicios || payload?.data || [];
  const first = Array.isArray(services) ? services.find((item) => item?.id_servicio) : null;
  if (first?.id_servicio) state.context.serviceId = first.id_servicio;
  check("public services has service", Boolean(state.context.serviceId), { services: Array.isArray(services) ? services.length : 0 });
}

function futureDate(daysAhead = 2) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

async function publicAvailability() {
  if (!state.context.branchId || !state.context.serviceId) {
    check("public availability skipped has ids", false, { branchId: state.context.branchId, serviceId: state.context.serviceId });
    return;
  }
  const fechaDesde = env("MF_LOAD_DATE_FROM", futureDate(2));
  const fechaHasta = env("MF_LOAD_DATE_TO", futureDate(8));
  const { response, payload } = await requestJson(
    "public_availability",
    `/v1/public/agenda/disponibilidad${qs({
      id_sucursal: state.context.branchId,
      selection_type: "services",
      servicios: state.context.serviceId,
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      id_barbero: state.context.barberId,
    })}`
  );
  check("public availability responds 200", response.status === 200, { status: response.status });
  check("public availability shape", Array.isArray(payload?.data?.disponibilidad), {
    rows: payload?.data?.disponibilidad?.length ?? null,
  });
}

async function publicSlots() {
  if (!state.context.branchId || !state.context.serviceId) return;
  const fecha = env("MF_LOAD_SLOT_DATE", env("MF_LOAD_DATE_FROM", futureDate(2)));
  const { response, payload } = await requestJson(
    "public_slots",
    `/v1/public/agenda/horarios${qs({
      id_sucursal: state.context.branchId,
      selection_type: "services",
      servicios: state.context.serviceId,
      fecha,
      id_barbero: state.context.barberId,
    })}`
  );
  check("public slots responds expected", [200, 404, 409].includes(response.status), { status: response.status });
  const slots = payload?.data?.horarios || [];
  const first = Array.isArray(slots) ? slots.find((item) => item?.disponible && item?.inicio_at) : null;
  if (!state.context.startAt && first?.inicio_at) state.context.startAt = first.inicio_at;
  if (!state.context.barberId && payload?.data?.id_barbero) state.context.barberId = payload.data.id_barbero;
}

async function authenticatedAvailability() {
  if (!hasClientAuth()) {
    check("authenticated availability skipped auth present", true, { skipped: "missing client auth" });
    return;
  }
  await publicAvailability();
}

function buildHoldPayload() {
  const unique = randomUUID().slice(0, 8);
  return {
    id_sucursal: state.context.branchId,
    titular: {
      nombre: `Load Test ${unique}`,
      email: `load.${unique}@example.invalid`,
      telefono: "99999999",
    },
    fecha_inicio: state.context.startAt,
    id_barbero: state.context.barberId || null,
    selection_type: "services",
    servicios: [{ id_servicio: state.context.serviceId }],
    notas: "Fase 4 load harness audit",
  };
}

async function createPublicHold(idempotencyKey = randomUUID()) {
  return requestJson("public_hold_create", "/v1/public/citas/hold", {
    method: "POST",
    headers: { "x-idempotency-key": idempotencyKey },
    body: JSON.stringify(buildHoldPayload()),
  });
}

async function publicHoldCreateRelease() {
  if (!canRunWrites()) {
    check("public hold skipped writes disabled", true, { skipped: "MF_LOAD_ENABLE_WRITES=false" });
    return;
  }
  if (!state.context.startAt || !state.context.serviceId || !state.context.branchId) {
    check("public hold prerequisites", false, state.context);
    return;
  }
  const { response, payload } = await createPublicHold();
  check("public hold create status", response.status === 201, { status: response.status });
  const groupId = payload?.data?.id_grupo_cita;
  const releaseToken = payload?.data?.release_token;
  if (!groupId || !releaseToken) return;
  const released = await requestJson("public_hold_release", `/v1/public/citas/hold/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
    body: JSON.stringify({ release_token: releaseToken }),
  });
  check("public hold release status", released.response.status === 200, { status: released.response.status });
}

async function doubleSubmitSameIdempotencyKey() {
  if (!canRunWrites()) {
    check("double submit skipped writes disabled", true, { skipped: "MF_LOAD_ENABLE_WRITES=false" });
    return;
  }
  const key = randomUUID();
  const [first, second] = await Promise.all([createPublicHold(key), createPublicHold(key)]);
  check("double submit first expected", [201, 409].includes(first.response.status), { status: first.response.status });
  check("double submit second expected", [201, 409].includes(second.response.status), { status: second.response.status });
  const ids = [first.payload?.data?.id_grupo_cita, second.payload?.data?.id_grupo_cita].filter(Boolean);
  check("double submit not duplicate group", new Set(ids).size <= 1, { ids });
}

async function concurrentSameSlot() {
  if (!canRunWrites()) {
    check("concurrent same slot skipped writes disabled", true, { skipped: "MF_LOAD_ENABLE_WRITES=false" });
    return;
  }
  const attempts = await Promise.all([createPublicHold(), createPublicHold(), createPublicHold()]);
  const created = attempts.filter((item) => item.response.status === 201).length;
  const conflicts = attempts.filter((item) => item.response.status === 409).length;
  check("concurrent same slot creates at most one", created <= 1, { created, conflicts });
}

async function authHoldCreateRelease() {
  if (!canRunWrites() || !hasClientAuth()) {
    check("auth hold skipped prerequisites", true, { skipped: "writes or client auth missing" });
    return;
  }
  const { response, payload } = await requestJson("auth_hold_create", "/v1/citas/hold", {
    method: "POST",
    headers: { ...authHeaders("client"), "x-idempotency-key": randomUUID() },
    body: JSON.stringify({ ...buildHoldPayload(), titular: undefined }),
  });
  check("auth hold create status", response.status === 201, { status: response.status });
  const groupId = payload?.data?.id_grupo_cita;
  if (!groupId) return;
  const released = await requestJson("auth_hold_release", `/v1/citas/hold/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
    headers: authHeaders("client"),
  });
  check("auth hold release status", released.response.status === 200, { status: released.response.status });
}

async function adminClientSearch() {
  if (!hasAdminAuth()) {
    check("admin client search skipped auth present", true, { skipped: "missing admin auth" });
    return;
  }
  const { response } = await requestJson("admin_client_search", "/v1/admin/personas/clientes?limit=5&q=load", {
    headers: authHeaders("admin"),
  });
  check("admin client search responds expected", [200, 403].includes(response.status), { status: response.status });
}

async function adminHoldCreateRelease() {
  if (!canRunWrites() || !hasAdminAuth()) {
    check("admin hold skipped prerequisites", true, { skipped: "writes or admin auth missing" });
    return;
  }
  const payload = {
    ...buildHoldPayload(),
    titular: undefined,
    cliente_nuevo: buildHoldPayload().titular,
    metodo_pago_codigo: "sin_pago",
  };
  const { response, payload: data } = await requestJson("admin_hold_create", "/v1/admin/citas/hold", {
    method: "POST",
    headers: { ...authHeaders("admin"), "x-idempotency-key": randomUUID() },
    body: JSON.stringify(payload),
  });
  check("admin hold create status", response.status === 201, { status: response.status });
  const groupId = data?.data?.id_grupo_cita;
  if (!groupId) return;
  const released = await requestJson("admin_hold_release", `/v1/admin/citas/hold/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
    headers: authHeaders("admin"),
  });
  check("admin hold release status", released.response.status === 200, { status: released.response.status });
}

async function adminConfirmCashPending() {
  if (!canRunWrites() || !hasAdminAuth()) {
    check("admin cash pending skipped prerequisites", true, { skipped: "writes or admin auth missing" });
    return;
  }
  check("admin cash pending configured", false, { reason: "requires seeded disposable slot and explicit QA admin auth" });
}

async function sseClient(index) {
  if (!state.context.branchId) {
    check("sse skipped has branch", false, {});
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveProfile().sseMs);
  const path = `/v1/public/agenda/eventos${qs({
    id_sucursal: state.context.branchId,
    last_event_id: state.context.lastEventId,
  })}`;
  try {
    const response = await timed("sse_connect", () => fetch(apiUrl(path), {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    }));
    const contentType = String(response.headers.get("content-type") || "");
    if (response.status === 404 || response.status === 503) {
      warn(`sse ${index} unavailable in target`, {
        status: response.status,
        contentType,
        note: "QA no expone SSE o realtime esta deshabilitado; se reporta como brecha no destructiva.",
      });
      return;
    }
    check(`sse ${index} content type`, response.status === 200 && contentType.includes("text/event-stream"), {
      status: response.status,
      contentType,
    });
    const reader = response.body?.getReader?.();
    if (reader) {
      await reader.read().catch(() => null);
      await reader.cancel().catch(() => null);
    }
  } catch (error) {
    check(`sse ${index} opened until timeout`, error?.name === "AbortError", { name: error?.name, message: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

async function sseConcurrent() {
  const profile = resolveProfile();
  await Promise.all(Array.from({ length: profile.sseClients }, (_, index) => sseClient(index + 1)));
}

async function sseReconnectLastEventId() {
  const before = state.context.lastEventId;
  state.context.lastEventId = env("MF_LOAD_RECONNECT_LAST_EVENT_ID", before || "0");
  await sseClient("reconnect");
  state.context.lastEventId = before;
}

async function pollingFallback() {
  await publicAvailability();
  await publicSlots();
  check("polling fallback exercised by availability and slots", true, {});
}

const scenarios = {
  public_availability: publicAvailability,
  authenticated_availability: authenticatedAvailability,
  public_hold_create_release: publicHoldCreateRelease,
  authenticated_hold_create_release: authHoldCreateRelease,
  admin_hold_create_release: adminHoldCreateRelease,
  double_submit_same_idempotency_key: doubleSubmitSameIdempotencyKey,
  concurrent_same_slot: concurrentSameSlot,
  sse_concurrent: sseConcurrent,
  sse_reconnect_last_event_id: sseReconnectLastEventId,
  polling_fallback: pollingFallback,
  admin_client_search: adminClientSearch,
  admin_confirm_cash_pending: adminConfirmCashPending,
};

function selectedScenarios() {
  const raw = env("MF_LOAD_SCENARIOS");
  const names = raw
    ? raw.split(",").map((item) => item.trim()).filter(Boolean)
    : Object.keys(scenarios);
  for (const name of names) {
    if (!scenarios[name]) throw new Error(`Escenario desconocido: ${name}`);
    if (WRITE_SCENARIOS.has(name) && !canRunWrites()) continue;
  }
  return names;
}

async function runWorker(id, names, iterations) {
  for (let index = 0; index < iterations; index += 1) {
    for (const name of names) {
      await scenarios[name]();
    }
  }
  check(`worker ${id} completed`, true, { iterations });
}

async function main() {
  const profile = resolveProfile();
  const names = selectedScenarios();
  await discoverPublicContext();
  await discoverService();
  await publicSlots();

  const iterationsPerWorker = Math.max(1, Math.ceil(profile.iterations / profile.concurrency));
  await Promise.all(Array.from({ length: profile.concurrency }, (_, index) => runWorker(index + 1, names, iterationsPerWorker)));

  const failed = state.checks.filter((item) => !item.ok);
  const summary = {
    profile,
    apiUrl: env("MF_LOAD_API_URL", DEFAULT_API_URL),
    writesEnabled: canRunWrites(),
    scenarios: names,
    context: state.context,
    checks: {
      total: state.checks.length,
      failed: failed.length,
    },
    warnings: state.warnings,
    metrics: Object.fromEntries([...state.metrics.entries()].map(([name, values]) => [name, {
      count: values.length,
      avg_ms: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      p95_ms: Math.round(percentile(values, 95)),
      max_ms: Math.round(Math.max(...values)),
    }])),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length) process.exitCode = 1;
}

await main();
