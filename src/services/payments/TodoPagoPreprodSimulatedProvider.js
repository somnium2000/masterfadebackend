import { PaymentProvider } from "./PaymentProvider.js";
import { resolveTodoPagoSimulatedResponse } from "./todopagoSimulatedResponses.js";

function safeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildPaymentUrl(callbackUrl, providerIntentId, simulation) {
  const baseUrl = safeText(callbackUrl) || "http://localhost:5173/agendar/exito";
  const separator = baseUrl.includes("?") ? "&" : "?";
  const query = new URLSearchParams({
    todopago_simulated: "1",
    provider_intent_id: providerIntentId,
    response_code: simulation.responseCode,
  });
  return `${baseUrl}${separator}${query.toString()}`;
}

function extractAmountFromProviderIntentId(providerIntentId) {
  const raw = safeText(providerIntentId);
  const match = raw.match(/_amt_([0-9]+_[0-9]{2})(?:_|$)/i);
  if (!match) return null;
  return Number(match[1].replace("_", "."));
}

export class TodoPagoPreprodSimulatedProvider extends PaymentProvider {
  async createIntent({ idempotencyKey, montoHnl, moneda, descripcion, callbackUrl, metadata }) {
    const amountKey = Number(montoHnl || 0).toFixed(2).replace(".", "_");
    const providerIntentId = `todopago_sim_${idempotencyKey}_amt_${amountKey}`;
    const simulation = resolveTodoPagoSimulatedResponse(montoHnl);
    return {
      providerIntentId,
      paymentUrl: buildPaymentUrl(callbackUrl, providerIntentId, simulation),
      raw: {
        simulated: true,
        provider: "todopago",
        mode: "preprod_simulated",
        moneda: safeText(moneda) || "HNL",
        descripcion: safeText(descripcion) || null,
        metadata: metadata && typeof metadata === "object" ? metadata : {},
        simulation,
      },
    };
  }

  async queryStatus(providerIntentId) {
    const amount = extractAmountFromProviderIntentId(providerIntentId);
    const simulation = resolveTodoPagoSimulatedResponse(amount);
    return {
      status: simulation.normalizedStatus,
      raw: {
        simulated: true,
        provider: "todopago",
        mode: "preprod_simulated",
        providerIntentId,
        simulation,
      },
    };
  }

  async cancelIntent(providerIntentId) {
    void providerIntentId;
  }

  verifyWebhookSignature(_rawBody, _signature) {
    return true;
  }
}
