export function parseStrictBooleanEnv(value, {
  name = "BOOLEAN_ENV",
  defaultValue = false,
} = {}) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} invalido. Usa true o false.`);
}

export function resolveBookingIsvEnabled(config = null) {
  if (typeof config?.bookingIsvEnabled === "boolean") {
    return config.bookingIsvEnabled;
  }
  return parseStrictBooleanEnv(process.env.BOOKING_ISV_ENABLED, {
    name: "BOOKING_ISV_ENABLED",
    defaultValue: false,
  });
}
