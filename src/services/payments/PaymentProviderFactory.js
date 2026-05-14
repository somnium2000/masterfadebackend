import { MockPaymentProvider } from "./MockPaymentProvider.js";
import { PaymentSimulatorProvider, isPaymentSimulatorEnabled } from "./PaymentSimulatorProvider.js";
import {
    assertPaymentProviderConfig,
    normalizePaymentProviderCode,
} from "./paymentRuntimeGuard.js";
// import { BanpaisPaymentProvider } from "./BanpaisPaymentProvider.js"; // Descomentar en Sprint 3

/**
 * PaymentProviderFactory - Selecciona el proveedor correcto según PAYMENT_PROVIDER env.
 *
 * Uso:
 *   const provider = PaymentProviderFactory.create();
 *   const { paymentUrl } = await provider.createIntent({...});
 *
 * Valores de PAYMENT_PROVIDER:
 *   - 'mock'   -> MockPaymentProvider (desarrollo/pruebas)
 *   - 'banpais' -> BanpaisPaymentProvider (producción) [Sprint 3]
 */
export class PaymentProviderFactory {
    static _instance = null;
    static _instances = new Map();

    static _normalizeProvider(providerCode) {
        return normalizePaymentProviderCode(providerCode || process.env.PAYMENT_PROVIDER);
    }

    static _assertProviderAllowed(provider) {
        assertPaymentProviderConfig({
            ...process.env,
            PAYMENT_PROVIDER: provider,
        });
    }

    /**
     * Retorna instancia singleton del proveedor activo.
     * @returns {import('./PaymentProvider.js').PaymentProvider}
     */
    static create({ providerCode } = {}) {
        const provider = PaymentProviderFactory._normalizeProvider(providerCode);
        PaymentProviderFactory._assertProviderAllowed(provider);

        if (PaymentProviderFactory._instances.has(provider)) {
            return PaymentProviderFactory._instances.get(provider);
        }

        let instance;
        switch (provider) {
            case "mock":
                instance = new MockPaymentProvider({
                    mockResult: process.env.MOCK_PAYMENT_RESULT || "PAID",
                });
                break;
            case "simulator":
                instance = new PaymentSimulatorProvider({
                    enabled: isPaymentSimulatorEnabled(),
                });
                break;

            // case "banpais":
            //   PaymentProviderFactory._instance = new BanpaisPaymentProvider({
            //     apiKey: process.env.BANPAIS_API_KEY,
            //     apiUrl: process.env.BANPAIS_API_URL,
            //     webhookSecret: process.env.BANPAIS_WEBHOOK_SECRET,
            //   });
            //   break;

            default:
                throw new Error(`PAYMENT_PROVIDER no reconocido: ${provider}. Proveedores disponibles: mock, simulator.`);
        }

        PaymentProviderFactory._instances.set(provider, instance);
        PaymentProviderFactory._instance = instance;
        return instance;
    }

    /** Reiniciar singleton (útil en tests) */
    static reset() {
        PaymentProviderFactory._instance = null;
        PaymentProviderFactory._instances.clear();
    }
}
