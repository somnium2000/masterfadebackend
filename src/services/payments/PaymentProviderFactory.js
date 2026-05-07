import { MockPaymentProvider } from "./MockPaymentProvider.js";
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

    /**
     * Retorna instancia singleton del proveedor activo.
     * @returns {import('./PaymentProvider.js').PaymentProvider}
     */
    static create() {
        if (PaymentProviderFactory._instance) {
            return PaymentProviderFactory._instance;
        }

        const provider = String(process.env.PAYMENT_PROVIDER || "mock").toLowerCase().trim();
        const nodeEnv = String(process.env.NODE_ENV || process.env.ENTORNO || "").toLowerCase();
        if ((nodeEnv === "production" || nodeEnv === "prod") && provider === "mock") {
            throw new Error("PAYMENT_PROVIDER=mock no esta permitido en produccion.");
        }

        switch (provider) {
            case "mock":
                PaymentProviderFactory._instance = new MockPaymentProvider({
                    mockResult: process.env.MOCK_PAYMENT_RESULT || "PAID",
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
                PaymentProviderFactory._instance = new MockPaymentProvider();
        }

        return PaymentProviderFactory._instance;
    }

    /** Reiniciar singleton (útil en tests) */
    static reset() {
        PaymentProviderFactory._instance = null;
    }
}
