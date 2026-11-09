import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/routes/v1/admin/catalog.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("function normalizeServiceBranchTariffs(body = {}) {");
const end = source.indexOf("\nasync function ensureServiceBranchesAccessible", start);
const AppError = class extends Error {
  constructor(status, message, options = {}) { super(message); this.status = status; this.code = options.code; }
};
const normalize = new Function("normalizeBoolean", "AppError", "LEGACY_SERVICE_BUFFER_FALLBACK", `${source.slice(start, end)}; return normalizeServiceBranchTariffs;`)(
  (value, fallback) => value === undefined || value === null ? fallback : Boolean(value), AppError, 5
);

const tariff = (overrides = {}) => ({
  id_sucursal: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  duracion_min: 30,
  servicio_informativo: true,
  ...overrides,
});

test("creación informativa sin precio normaliza el valor técnico a cero", () => {
  assert.equal(normalize({ sucursales: [tariff()] })[0].precio_hnl, 0);
});

test("creación informativa conserva un precio definido", () => {
  assert.equal(normalize({ sucursales: [tariff({ precio_hnl: 175 })] })[0].precio_hnl, 175);
});

test("creación agendable conserva la validación de precio requerido", () => {
  assert.throws(
    () => normalize({ sucursales: [tariff({ servicio_informativo: false })] }),
    (error) => error.code === "CATALOG_SERVICE_TARIFF_PRICE_INVALID"
  );
});

test("contratos de alta por sucursal admiten ausencia de precio sin admitir valores negativos", () => {
  assert.doesNotMatch(source, /required: \["id_sucursal", "precio_hnl", "duracion_min"\]/);
  assert.match(source, /precio_hnl: \{ type: "number", minimum: 0 \}/);
  assert.match(source, /servicioInformativo \? 0 : null/);
});
