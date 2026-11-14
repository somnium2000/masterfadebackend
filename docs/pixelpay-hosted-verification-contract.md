# Hosted: investigacion de verificacion por consulta autenticada

Fecha: 14 de noviembre de 2026. Alcance: investigacion oficial y acceptance gate experimental desconectado. No se ejecutaron consultas Status al proveedor, requests financieros, operaciones Live ni cambios de datos remotos.

## Conclusion

Se encontro una consulta autenticada oficial de transacciones, pero **no se demostro que permita verificar el UUID de un callback Hosted con un contrato financiero completo**. No se puede habilitar confirmacion automatica con la documentacion disponible. Un UUID de callback es un candidato no confiable para una eventual consulta; no es una identidad financiera canonica verificada por el mero hecho de recibirlo.

## Fuentes revisadas y limites

Las paginas web actuales son dinamicas; se contrastaron sus referencias con las paginas Markdown oficiales disponibles en MCP PixelPay.

| Fuente oficial | Evidencia y limite |
| --- | --- |
| [Hosted Payment Gateway](https://pixelpay.zendesk.com/hc/es-419/articles/360039834392-Hosted-Payment-Gateway) y MCP `es/integrations/hosted-payment` | Callback incluye `uuid`, orden, importe, moneda y `payment_hash`. No especifica una consulta autenticada de conciliacion Hosted ni firma integral de esos campos. |
| [Peticiones SDK](https://docs.pixelpay.com/page/sdk/requests), MCP `es/sdk/requests` | `StatusTransaction.payment_uuid`; la guia obtiene ese UUID de respuestas Auth, Capture y Sale. No documenta equivalencia con `uuid` Hosted. |
| [Consultar estado JavaScript](https://docs.pixelpay.com/use-case?case=sdk%2Fstatus%2Fstatus&lang=javascript&locale=es), MCP `es/sdk/use-cases/status/status/javascript` | Muestra `getStatus`, credenciales y firma. No fija un esquema financiero de respuesta para Hosted. |
| MCP `es/sandbox/use-cases-api/status/query/api` ([indice Sandbox API](https://docs.pixelpay.com/page/sandbox/use-cases-api/index)) | POST `/api/v2/transaction/status` con `payment_uuid` y `env=sandbox`. El ejemplo contiene `data.status`, `attemps` e historial; no demuestra merchant, orden, importe y moneda autenticados. No inferir que esos campos jamas puedan existir en otras respuestas. |
| [Autenticacion API](https://docs.pixelpay.com/page/api/getting-started), MCP `es/api/getting-started` | Headers `x-auth-key` y `x-auth-hash` con SHA-512 del Secret Key. Autenticar al solicitante no demuestra por si solo el esquema, alcance ni correlacion de la respuesta Hosted. |
| [Firma de seguridad](https://docs.pixelpay.com/page/secure-signature), MCP `es/secure-signature` | Para Status: HMAC SHA3-512 del Key ID, `payment_uuid` y plataforma. Esta firma de solicitud no es una firma del cuerpo recibido. |
| [Respuestas y entidades](https://docs.pixelpay.com/page/sdk/responses-entities), MCP `es/sdk/responses-entities` | `TransactionResult` documenta importes, transaccion, aprobacion y merchant de red para Auth/Capture/Sale/Void. No lista Status como consumidor de esa entidad; no demuestra que merchant de red equivalga al Key ID del comercio. |
| [Generador de cobros API](https://pixelpay.zendesk.com/hc/es-419/articles/360040249031-Generador-de-Cobros-v%C3%ADa-API) | Documenta creacion `/api/v2/generate`; no proporciona en esa pagina el contrato de una consulta Hosted completa. |

Se buscaron tambien referencias oficiales de `request/get`, `api/v2/request`, consulta de cobros y consulta por UUID en el catalogo MCP ES y busquedas web. No se encontro un contrato oficial suficiente para esos endpoints. No se afirma que no existan: no se implementan ni se prueban rutas adivinadas.

## Comparacion con SDK y MasterFade actuales

- `@pixelpay/sdk-core` 2.5.8 implementa `getStatus` como POST `api/v2/transaction/status`.
- `StatusTransaction` solo declara `payment_uuid`. `TransactionResult.validateResponse` reconoce clases de respuesta; no valida presencia o equivalencia financiera. `fromResponse` copia solo propiedades declaradas: puede descartar campos de la respuesta original, por ejemplo `status`, orden o moneda. No reconstruir un contrato a partir de campos inicializados como `undefined`.
- `PixelPaySdkProvider.queryPaymentStatus` firma la consulta y comprueba distintas condiciones. El flujo actual no autoriza recuperar pagos solo por `COMPLETED`: conserva la necesidad de Sale verificada previamente y evidencia durable. Este trabajo no lo modifica.
- `transaction_merchant` es un merchant de la red de transacciones segun la guia. No compararlo automaticamente con Key ID, slug del comercio ni `company_key` del callback.
- El hash de orden no cubre merchant/importe/moneda/resultado/UUID completos. Reutilizarlo tras una consulta no compensa los campos faltantes ni autentica el callback.

## Evidencia necesaria de PixelPay

Antes de escribir un parser o realizar una nueva prueba externa se necesita:

1. Endpoint, metodo y autenticacion oficiales para consultar **Hosted**, dominio/ambiente y restricciones de cuenta.
2. Confirmacion de si `uuid` Hosted es el `payment_uuid` de Status, o procedimiento oficial para obtener el identificador financiero correspondiente. Conservar ambos sin convertir prefijos ni asumir equivalencias.
3. Esquema completo y versionado del JSON HTTP de respuesta, con tipos, rutas exactas y tratamiento de campos omitidos/nulos. Obtener una muestra sanitaria de la cuenta en Sandbox.
4. Identidad de cuenta autenticada y correspondencia documentada con la configuracion local. Probar que el recurso de otro comercio se rechaza o queda inequívocamente identificado como ajeno.
5. Orden canonica y UUID/transaccion devueltos por el servidor, importe efectivamente capturado y moneda. No tomar estos valores del callback/navegador ni completar ausencias con el request.
6. Semantica final de captura frente a autorizacion, 3DS inconcluso, pendiente, rechazo, void o devolucion; fecha financiera autentica y zona horaria. `paid` o HTTP 200 aislados no bastan.
7. Garantias de transporte/autenticidad de la respuesta y de frescura/replay. La firma de la solicitud y el hecho de conocer un hash estatico no firman el resultado financiero.
8. Vectores negativos reproducibles: UUID/orden/merchant ajenos; importe/moneda alterados; estado parcial; campos faltantes; respuesta vieja o reutilizada. Con un UUID Sandbox nuevo y el contrato suficiente se puede realizar la consulta dentro del alcance Sandbox autorizado; los intentos inciertos previos no se reutilizan.

La verificacion futura debera contrastar todos los elementos en una respuesta autentica de la consulta y vincularlos a la orden persistida. Nunca usar la entrada no confiable como sustituto de un campo ausente. Aun con ese contrato, confirmar reserva/paid_at/venta exigira un cambio financiero separado, evidencia Hosted propia, idempotencia y revision de concurrencia/vencimiento.

## Acceptance gate implementado

`src/services/payments/pixelPayHostedVerification.js` es un checklist ejecutable puro, **no un adaptador ni un parser PixelPay**. Sus fichas `canonical` y `candidate` son nombres internos usados en pruebas sinteticas; no representan rutas/campos oficiales del proveedor. Los importes se expresan como centavos enteros internos para evitar redondeos permisivos.

El checklist detecta ausencias y diferencias de merchant/orden/UUID, importe y HNL, y la falta de referencia de transaccion, resultado o fecha. No interpreta el significado bancario de `financialResult`, ni convierte `paid`/`COMPLETED` en captura. Incluso una ficha completa que coincida conserva todos los bloqueos de contrato y devuelve siempre `financial_verified=false`, `can_confirm=false`, `automatic_confirmation=false`.

Flags como `authenticated=true`, `providerContractValid=true` o `payment_hash_valid=true` aportados por el caller no desbloquean nada. El modulo no importa SDK, red, DB ni rutas y no se conecta a creacion/callback/status/confirmacion. No genera eventos ni evidencia financiera. No devuelve valores de las fichas ni datos sensibles.

Pruebas: `node --test test/pixelpay-hosted-verification.test.mjs`. Cubren status-only, hash-only, UUID/merchant/orden ajenos o faltantes, importe ausente/inexacto/inseguro, moneda ajena o faltante, referencias/resultado/fecha ausentes, expectativa canonica incompleta y flags de confianza falsificados. Todas son locales y sinteticas; ningun caso demuestra una aprobacion real ni habilitacion Hosted de la cuenta.
