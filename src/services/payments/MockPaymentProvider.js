import { PaymentProvider } from "./PaymentProvider.js";
import {
    normalizeCreateIntentResult,
    PAYMENT_LAUNCH_METHODS,
    PAYMENT_LAUNCH_TYPES,
} from "./paymentProviderContract.js";

/**
 * MockPaymentProvider â€” Proveedor de pagos simulado para desarrollo y pruebas.
 *
 * Comportamiento:
 *  - createIntent: retorna URL de callback con resultado hardcodeado (PAID o FAILED)
 *  - queryStatus: siempre retorna PAID (para pruebas de reconciliación)
 *  - cancelIntent: no-op
 *  - verifyWebhookSignature: siempre válida (sin firma real)
 *
 * Activar con: PAYMENT_PROVIDER=mock en .env
 */
export class MockPaymentProvider extends PaymentProvider {
    /**
     * @param {Object} [opts]
     * @param {'PAID'|'FAILED'|'EXPIRED'} [opts.mockResult='PAID'] â€” resultado simulado
     */
    constructor({ mockResult = "PAID" } = {}) {
        super();
        this.mockResult = mockResult;
    }

    async createIntent({ idempotencyKey, montoHnl, descripcion, callbackUrl, metadata }) {
        const providerIntentId = `mock_intent_${idempotencyKey}`;
        void montoHnl;
        void descripcion;
        void metadata;

        // Construir URL de callback del proveedor mock (simula redirect tras pago)
        const separator = callbackUrl.includes("?") ? "&" : "?";
        const paymentUrl = `${callbackUrl}${separator}mock_result=${this.mockResult}&provider_intent_id=${providerIntentId}&idempotency_key=${idempotencyKey}`;

        return normalizeCreateIntentResult({
            providerIntentId,
            paymentUrl,
            launch: {
                type: PAYMENT_LAUNCH_TYPES.REDIRECT,
                action: paymentUrl,
                method: PAYMENT_LAUNCH_METHODS.GET,
                fields: {},
                allowedMessageOrigin: null,
                expiresAt: null,
            },
            raw: { mock: true },
        });
    }

    async queryStatus(providerIntentId) {
        return {
            status: this.mockResult,
            raw: { mock: true, providerIntentId },
        };
    }

    async cancelIntent(providerIntentId) {
        // No-op en mock
        void providerIntentId;
    }

    verifyWebhookSignature(_rawBody, _signature) {
        // En mock siempre válida â€” en producción verificar HMAC o firma del proveedor
        return true;
    }
}
