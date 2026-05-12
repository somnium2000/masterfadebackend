import { PaymentProvider } from "./PaymentProvider.js";
import { getPaymentRuntimeSnapshot, parsePaymentBoolean } from "./paymentRuntimeGuard.js";

/**
 * Provider de simulacion controlada para QA/staging no productivo.
 * No procesa tarjetas ni reemplaza al proveedor real.
 */
export class PaymentSimulatorProvider extends PaymentProvider {
  constructor({ enabled = false } = {}) {
    super();
    this.enabled = Boolean(enabled);
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new Error("PAYMENT_SIMULATOR_DISABLED");
    }
    const snapshot = getPaymentRuntimeSnapshot(process.env);
    const runtimeName = snapshot.entorno || snapshot.nodeEnv;
    if (["qa", "staging"].includes(runtimeName) && !snapshot.qaSimulationEnabled) {
      throw new Error("PAYMENT_QA_SIMULATION_DISABLED");
    }
    if (["qa", "staging"].includes(runtimeName) && !String(process.env.PAYMENT_SIMULATOR_WEBHOOK_SECRET || "").trim()) {
      throw new Error("PAYMENT_SIMULATOR_SECRET_REQUIRED");
    }
  }

  async createIntent({ idempotencyKey, montoHnl, descripcion, callbackUrl, metadata }) {
    this.assertEnabled();
    const providerIntentId = `simulator_intent_${idempotencyKey}`;
    void montoHnl;
    void descripcion;
    void metadata;

    const separator = callbackUrl.includes("?") ? "&" : "?";
    const paymentUrl = `${callbackUrl}${separator}simulator=1&provider_intent_id=${encodeURIComponent(providerIntentId)}&idempotency_key=${encodeURIComponent(idempotencyKey)}`;

    return {
      providerIntentId,
      paymentUrl,
    };
  }

  async queryStatus(providerIntentId) {
    this.assertEnabled();
    return {
      status: "PENDING",
      raw: { simulator: true, providerIntentId },
    };
  }

  async cancelIntent(providerIntentId) {
    this.assertEnabled();
    void providerIntentId;
  }

  verifyWebhookSignature(_rawBody, signature) {
    this.assertEnabled();
    const expectedSecret = String(process.env.PAYMENT_SIMULATOR_WEBHOOK_SECRET || "").trim();
    if (!expectedSecret) return true;
    return String(signature || "").trim() === expectedSecret;
  }
}

export function isPaymentSimulatorEnabled() {
  return parsePaymentBoolean(process.env.ENABLE_PAYMENT_SIMULATOR, false);
}
