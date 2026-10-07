const DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX = 5;
const DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW = "15 minutes";
const MAX_PUBLIC_CITAS_HOLD_RATE_LIMIT = 10_000;
const TIME_WINDOW_PATTERN = /^\d+\s*(?:ms|milliseconds?|seconds?|minutes?|hours?|days?)$/i;

function parsePositiveInteger(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PUBLIC_CITAS_HOLD_RATE_LIMIT) {
    return fallback;
  }
  return parsed;
}

function parseTimeWindow(value, fallback) {
  const raw = String(value ?? "").trim();
  return TIME_WINDOW_PATTERN.test(raw) ? raw : fallback;
}

export function resolvePublicCitasHoldRateLimit(env = process.env) {
  return {
    max: parsePositiveInteger(
      env.PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX,
      DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX
    ),
    timeWindow: parseTimeWindow(
      env.PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW,
      DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW
    ),
  };
}

export {
  DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_CITAS_HOLD_RATE_LIMIT_WINDOW,
};
