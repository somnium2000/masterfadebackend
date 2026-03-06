const BARBERIA_SEED_NAMES = new Set([
  "CORTE DE CABELLO",
  "CORTE DE BARBA",
  "CORTE DE CEJAS",
  "FACIAL EXPRESS",
  "FACIAL COMPLETO",
  "CORTE",
  "BARBA",
  "FACIAL",
]);

const OTROS_SEED_NAMES = new Set([
  "NANO",
  "PERMANENTE",
  "TRATAMIENTOS DE COLORIMETRIA",
  "MANICURE Y PEDICURE",
]);

export function normalizeCatalogName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function deriveServiceCatalogGroup(name) {
  const normalized = normalizeCatalogName(name);

  if (OTROS_SEED_NAMES.has(normalized)) {
    return "otros";
  }

  if (BARBERIA_SEED_NAMES.has(normalized)) {
    return "barberia";
  }

  return "barberia";
}

export function isBarberBookable(name) {
  return deriveServiceCatalogGroup(name) === "barberia";
}
