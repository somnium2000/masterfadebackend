# Contrato interno de pagos y mapeo futuro de TodoPago

Microfase 1 define un resultado normalizado para `createIntent` sin habilitar
integración real, formularios, iframe, cifrado, webhooks ni llamadas HTTP.

## Mapeo futuro

| Destino | Valor TodoPago o MasterFade |
| --- | --- |
| `payment_intents.orden_compra` | `ordenDeCompra` generada por MasterFade |
| `payment_intents.provider_session_id` | `idTransaccion` devuelto por el login TodoPago |
| `payments.provider_tx_id` | `transaccionID` definitivo del pago |
| `payment_events.payload_esencial` | `processorCode`, estado normalizado y voucher sanitizado |
| `payment_intents.launch_expires_at` | Expiración de la sesión del modal, si TodoPago la informa |
| `payment_intents.last_verified_at` | Última reconciliación server-side |
| `payment_intents.verification_attempts` | Cantidad de intentos de reconciliación server-side |

## Datos prohibidos

Nunca se deben persistir `tokenTodomovil`, credenciales API o TodoPago, llave
AES, payload cifrado, PAN, CVV ni la fecha completa de expiración de tarjeta.
