import { createHash } from "node:crypto";
import { AppError } from "../../utils/errors.js";
import { OFFICIAL_QA_CARD_HASHES } from "./qaPixelPayOfficialCases.js";

// AM: Preserve the existing Live policy independently of the official Sandbox test catalog.
const PIXELPAY_LIVE_FORBIDDEN_TEST_CARDS = new Set(["4111111111111111", "5555555555554444"]);

export function assertPixelPaySandboxCardAllowed(cardNumber) {
  const normalized = String(cardNumber || "").replace(/\D+/g, "");
  const fingerprint = createHash("sha256").update(normalized).digest("hex");
  if (!OFFICIAL_QA_CARD_HASHES.has(fingerprint)) {
    throw new AppError(422, "La tarjeta no pertenece al set permitido de PixelPay Sandbox", {
      code: "PIXELPAY_SANDBOX_CARD_NOT_ALLOWED",
    });
  }
  return normalized;
}

export function assertPixelPayCardAllowedForEnvironment(cardNumber, environment) {
  const normalized = String(cardNumber || "").replace(/\D+/g, "");
  const normalizedEnvironment = String(environment || "").trim().toLowerCase();
  if (normalizedEnvironment === "sandbox") return assertPixelPaySandboxCardAllowed(normalized);
  if (normalizedEnvironment !== "live") {
    throw new AppError(500, "La configuracion del entorno de pagos no es valida", {
      code: "PIXELPAY_ENV_INVALID",
    });
  }
  if (PIXELPAY_LIVE_FORBIDDEN_TEST_CARDS.has(normalized)) {
    throw new AppError(422, "Las tarjetas de prueba no estan disponibles en este entorno", {
      code: "PIXELPAY_TEST_CARD_FORBIDDEN_IN_LIVE",
    });
  }
  return normalized;
}
