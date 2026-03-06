/**
 * PaymentProvider — Interface base (contrato agnóstico de proveedor)
 *
 * Todos los adaptadores de pasarela de pagos deben extender esta clase
 * e implementar los 4 métodos. Usar PaymentProviderFactory para instanciar.
 *
 * Campos de idempotencia:
 *   idempotencyKey: `mf_${id_cita}_${id_intent}_${timestamp_unix}`
 *
 * Regla PCI: NUNCA almacenar datos de tarjeta. Solo IDs y referencias del proveedor.
 */
export class PaymentProvider {
    /**
     * Crear intención de pago
     * @param {Object} opts
     * @param {string} opts.idempotencyKey   — clave única del intent
     * @param {number} opts.montoHnl         — monto en lempiras (ej. 250.00)
     * @param {string} opts.moneda           — 'HNL'
     * @param {string} opts.descripcion      — descripción del cobro
     * @param {string} opts.callbackUrl      — URL a la que redirige el proveedor tras el pago
     * @param {Object} opts.metadata         — {id_cita, id_cliente, id_sucursal}
     * @returns {Promise<{providerIntentId: string, paymentUrl: string}>}
     */
    // eslint-disable-next-line no-unused-vars
    async createIntent(opts) {
        throw new Error(`[PaymentProvider] createIntent no implementado en ${this.constructor.name}`);
    }

    /**
     * Consultar estado del intent (polling fallback si no hay webhook confiable)
     * @param {string} providerIntentId
     * @returns {Promise<{status: 'PENDING'|'PAID'|'FAILED'|'EXPIRED', raw: Object}>}
     */
    // eslint-disable-next-line no-unused-vars
    async queryStatus(providerIntentId) {
        throw new Error(`[PaymentProvider] queryStatus no implementado en ${this.constructor.name}`);
    }

    /**
     * Anular/cancelar intención de pago pendiente
     * @param {string} providerIntentId
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async cancelIntent(providerIntentId) {
        throw new Error(`[PaymentProvider] cancelIntent no implementado en ${this.constructor.name}`);
    }

    /**
     * Verificar firma del webhook entrante del proveedor
     * @param {string|Buffer} rawBody   — body crudo (antes de parsear JSON)
     * @param {string}        signature — valor del header de firma
     * @returns {boolean}              — true si la firma es válida
     */
    // eslint-disable-next-line no-unused-vars
    verifyWebhookSignature(rawBody, signature) {
        throw new Error(`[PaymentProvider] verifyWebhookSignature no implementado en ${this.constructor.name}`);
    }
}
