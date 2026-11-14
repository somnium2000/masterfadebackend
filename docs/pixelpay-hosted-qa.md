# PixelPay Hosted: candidato QA, confirmacion financiera bloqueada

Fecha de investigacion: 14 de noviembre de 2026. Este documento describe un candidato de codigo y migraciones; no acredita un despliegue ni un pago aprobado.

Actualizacion acotada posterior a la primera entrega: [diagnostico Sandbox y bloqueo actual](pixelpay-hosted-sandbox-diagnosis.md), [contrato de consulta financiera](pixelpay-hosted-verification-contract.md) y [revision independiente de migraciones/coexistencia](pixelpay-hosted-qa-coexistence.md). La nueva evidencia distingue challenge Cloudflare de HTTP500 JSON por modulo no disponible. La migracion candidata cambio el orden de un trigger; sus resultados PostgreSQL anteriores no se presentan como validacion de esa modificacion, que no se aplico.

## Alcance y viabilidad

Hosted es una alternativa oficial de redireccionamiento, separada de la Sale SDK. PixelPay aloja captura de tarjeta, billing y 3DS. La arquitectura de MasterFade permite crear una orden canonica y un hold, vincular un canal durable, solicitar un checkout desde backend y recuperar su estado al volver. No se reciben PAN/CVV en este canal.

La viabilidad de transporte y la habilitacion de Hosted **para la cuenta MasterFade aun no estan demostradas**. Tampoco se ha demostrado un mecanismo oficial suficiente para autenticar el resultado financiero completo. Esta version solo admite QA/Sandbox, apagada por defecto, y bloquea confirmacion, paid_at y pagos financieros de Hosted incluso en PostgreSQL.

Bases de trabajo: backend `origin/dev` en `dffcc40`, frontend `origin/dev` en `8383c4c`; ramas nuevas `feat/pixelpay-hosted-qa-20261114` en repositorios separados. Los arboles locales anteriores con cambios ajenos se preservaron.

## Contrato oficial comprobado

Referencias revisadas por MCP, web y directamente en la pestana Chrome del usuario:

- [Hosted Payment](https://docs.pixelpay.com/page/integrations/hosted-payment).
- [Hosted Payment Gateway ES](https://pixelpay.zendesk.com/hc/es-419/articles/360039834392-Hosted-Payment-Gateway).
- [Firma de Seguridad](https://docs.pixelpay.com/page/secure-signature).
- [Sandbox Hosted](https://docs.pixelpay.com/page/sandbox/hosted-payment).
- [Sandbox Zendesk](https://pixelpay.zendesk.com/hc/es-419/articles/360043039752-SandBox-PixelPay-Hosted-Payment).

| Elemento | Contrato y decision |
| --- | --- |
| Creacion | POST HTTPS `/api/v2/transaction/hosted/other`; Sandbox `/api/v2/transaction/hosted/sandbox`. Esta version no llama `other`. |
| Formato | `application/x-www-form-urlencoded`, `json=true`. Exito documental: `success=true` y `url`; no seguir redirects HTTP desde backend. |
| Firma | `_client_signature = HMAC-SHA3-512(secretKey, keyId + "|" + orderId + "|" + appUrl)`. La guia general menciona encabezado `x-client-signature`, la guia Hosted exige el campo. No mezclar con Sale SDK. |
| Orden | `_order_id` es la `orden_compra` canonica generada por backend. Nunca un ID elegido por navegador. |
| Total | `_amount` se obtiene de intent y promociones recalculadas, `_currency=HNL`. No aceptar total/moneda del cliente. |
| Identidad | Nombre, apellido y correo del titular vinculado a la reserva; comprobar propiedad con las reglas publicas/autenticadas existentes. |
| Checkout | Backend valida origen HTTPS allowlist y ruta Sandbox antes de guardar/devolver la URL. El frontend vuelve a validarla antes de navegar. |
| `_complete` | Retorno GET al frontend, puede traer `paymentHash`. Solo provoca consulta del estado canonico; no crea evidencia financiera. |
| `_cancel` | Retorno GET. No acredita rechazo, ausencia de cargo ni anulacion bancaria; no libera/cancela automaticamente una operacion financiera incierta. |
| `_callback` | POST JSON asincrono por exito, receptor responde HTTP 200; reintentos documentados cada 5 minutos hasta 3 veces. Endpoint Hosted separado del callback SDK. |
| `paymentHash` | Documentacion ES y SDK: `MD5(orderId + "|" + keyId + "|" + secretKey)`. Comparar en backend con tiempo constante. Solo correlacion, nunca autenticar cuerpo completo. |
| Vencimiento | `expired_at` tiene formato documental `yyyy/mm/dd hh:mm`, sin zona horaria ni garantia de carrera documentadas. No enviar una zona inventada; el hold canonico local es autoritativo. |
| Idempotencia | No se encontro garantia oficial de creacion idempotente, clave idempotency ni API Hosted de cancelacion/consulta financiera. Guardar claim durable antes de HTTP y no reemitir ante incertidumbre. |

La traduccion [Hosted EN](https://pixelpay.zendesk.com/hc/en-us/articles/26775620656148-Hosted-Payment-Gateway) introduce ambiguedad sobre Secret Key prehasheada. No se implementa fallback entre formulas. Se requiere un vector oficial aplicable a la cuenta.

### Contrato y limite de URL de checkout en QA

Las fuentes no publican una gramatica exhaustiva de URL ni garantizan que cualquier checkout alojado en un dominio PixelPay sea Sandbox. Se distinguen estas formas:

| Forma de ruta | Evidencia y decision QA |
| --- | --- |
| `/sandbox/<token>/checkout/example` | Ejemplo explicito de [Hosted Sandbox EN](https://pixelpay.zendesk.com/hc/en-us/articles/26640565481748-SandBox-PixelPay-Hosted-Payment) y [guia Sandbox](https://docs.pixelpay.com/page/sandbox/hosted-payment). Permitida en los origenes exactos revisados; tambien se conserva la variante sin `/example`. |
| `/<comercio>/P-<uuid>/checkout` | El callback de [Hosted ES](https://pixelpay.zendesk.com/hc/es-419/articles/360039834392-Hosted-Payment-Gateway) muestra esta forma en `pixelpay.dev`. Es evidencia de Hosted general, no prueba de ambiente Sandbox; bloqueada en este candidato QA. |
| `/<comercio>/<identificador-opaco>/checkout` | Ejemplo de [Hosted EN](https://pixelpay.zendesk.com/hc/en-us/articles/26775620656148-Hosted-Payment-Gateway). Tampoco demuestra Sandbox; bloqueada. |
| `/<comercio>/S-<uuid>/checkout` | No se obtuvo contrato Hosted oficial ni respuesta Sandbox autentica que demuestre esta forma. Un prefijo observado en SDK no basta para permitirla en Hosted; bloqueada hasta nueva evidencia. |

Backend y frontend aplican la misma politica: HTTPS, origen exacto `https://pixelpay.app`, `https://www.pixelpay.app` o `https://pixelpay.dev`, sin credenciales, puertos alternativos, fragmentos, controles, rutas codificadas ambiguas ni sufijos arbitrarios. No se amplia a todas las rutas `*/checkout` para acomodar ejemplos comerciales.

La query permite `success=0|1`, `slug=sandbox`, `merchant=sandbox`, `payload` con alfabeto Base64 y la opcion inerte `lang=es|en`. El ejemplo Sandbox EN incluye `url=`: solo se acepta un nivel, con el mismo origen y ruta de checkout que la URL exterior, y los mismos controles. Se rechazan destinos directos externos, otra ruta/token de checkout anidado, cadenas `url=` de mas de un nivel, parametros duplicados y overrides directos `_callback`, `_complete`, `_cancel`, `redirect` o `next` en query.

`payload` permanece opaco; el validador no verifica la orden ni los destinos internos de ese contenido, ni garantiza las redirecciones posteriores del checkout. Su contenido no acredita ambiente, titular ni pago y no sustituye los parametros canonicos que genera el backend. El ejemplo publico contiene retornos/callback de terceros y se usa solo como referencia documental; no se ejecutan esos destinos en las pruebas. Falta una URL devuelta por una creacion Sandbox exitosa para demostrar compatibilidad real. Si la cuenta devuelve otra forma, se necesita evidencia del proveedor y una revision contextual de ambos validadores antes de activar; no se habilita Live por relajar esta frontera.

## Bloqueo de autenticacion

El hash de orden incluye secreto, pero es estatico por orden y aparece en el retorno al navegador. No incluye importe, moneda, estado, UUID financiero, transaccion ni fecha. Quien conozca ese token puede presentar otro cuerpo con el mismo hash. Comparar los campos recibidos con MasterFade reduce inconsistencias, pero no prueba que PixelPay haya cobrado ese importe.

Las fuentes revisadas no describen firma del cuerpo del callback, autenticacion de cabeceras, timestamp/nonce ni endpoint Hosted de verificacion financiera con esquema completo. Eso no demuestra que PixelPay carezca de esos mecanismos: falta un contrato oficial verificable. Un token en `_callback` tampoco se inventa como autenticacion, porque el ejemplo Sandbox incluye esa URL en un payload Base64 visible.

Por tanto, todos los resultados Hosted permanecen pendientes de verificacion/revision. No se emite `pixelpay.sale.approved_verified`, no se crea una Sale artificial y no se convierte `paid`, `paymentHash` o `_complete` en `paid_at`/reserva confirmada/venta.

## Diseno implementado

1. Usar seleccion de cita, hold, promociones y `/crear-intent` canonicos existentes.
2. Consultar capacidad Hosted en backend; SDK conserva su comportamiento predeterminado.
3. `/pixelpay/hosted/start` comprueba propiedad, saldo, vigencia, proveedor y ausencia de intentos anteriores. Protege la reserva y persiste el claim antes del HTTP.
4. `payment_channel=hosted` y `app_private.pixelpay_hosted_sessions` ligan intent, grupo, orden, importe, moneda y vencimiento. No cambiar de canal ni emitir otro cargo para el mismo grupo.
5. Crear checkout una sola vez. Timeout, perdida de conexion, respuesta invalida o fallo al persistir el resultado conservan claim durable e impiden reenvio automatico.
6. Redirigir al checkout oficial usando recuperacion local existente. El retorno lleva IDs de correlacion sin correo/secreto, y recupera propiedad desde la sesion durable.
7. `/pixelpay/hosted/status` y `/estado` consultan la base local sin ejecutar Sale/Status SDK para Hosted.
8. Callback valida orden/hash/importe/moneda/referencia, guarda solo evidencia minima no autenticada y deduplica. No guarda payload completo, tarjeta, hash o datos personales del callback.
9. La expiracion local libera la disponibilidad. La sesion Hosted y cualquier aviso tardio sobreviven para revision, sin reabrir slot ni confirmar citas vencidas.

Endpoints de reserva bajo bases publicas y autenticadas existentes (`/v1/public/pagos`, `/v1/pagos/reservas`):

- GET `/pixelpay/hosted/capabilities`.
- POST `/pixelpay/hosted/start`.
- POST `/pixelpay/hosted/status`.

Callback separado: POST `/v1/pagos/pixelpay/hosted/callback`. Solo esta ruta concreta se exceptua de CSRF/sesion piloto para recibir al proveedor. Las rutas comerciales conservan sus controles de identidad, piloto y comercio publico.

## Controles financieros y esquema

Se revisaron `processPixelPayOrderCallback`, `loadDurablePixelPayApproval`, confirmacion canonica y reportes. Se consultaron **solo metadatos**, triggers y definiciones de funciones en Supabase QA `jgipiyhjtpgyaujfhghf`; no se consultaron ni modificaron los cinco intentos inciertos para esta implementacion.

QA tiene instalados `tr_pay_validar`, `tr_pay_aplicar`, `tr_payment_intents_capture_paid_at` y `tr_hold_expire_unprotected_intents`. Sus funciones exigen evidencia SDK durable ligada a `pixelpay_sale_attempts`, identidad e importe. La recuperacion durable exige `SuccessResponse`, HTTP 200, condiciones financieras verdaderas y tiempo anterior al minimo vencimiento de holds. Los reportes contabilizan payments financieros por `paid_at`.

Se preservan esas funciones y se agrega aislamiento de canal. El loader SDK excluye Hosted. No registrar ingresos de Hosted pendiente es el resultado esperado; una venta Hosted exitosa completa aun no esta habilitada.

Migraciones candidatas, **sin aplicar a QA ni produccion**:

1. `db/migrations/pixel/20261114010000_pixelpay_hosted_qa.sql`: canal con default SDK, tabla privada con RLS/revocacion, unicidad por orden/intent/grupo, invariantes y serializacion SDK/Hosted.
2. `db/migrations/pixel/20261114120000_pixelpay_hosted_financial_guard.sql`: triggers nuevos que bloquean paid_at/confirmado y estados financieros exitosos de Hosted mientras no exista verificacion oficial.

Se sigue el directorio de migraciones PixelPay del repositorio. El CLI Supabase no esta instalado en este entorno; los SQL son candidatos versionados y se verifican contra PostgreSQL 17 local, sin crear historial remoto.

## Evidencia externa Sandbox

El 14/11/2026 a las 05:40 America/Tegucigalpa (11:40 UTC), una solicitud POST a `https://pixelpay.app/api/v2/transaction/hosted/sandbox` con credenciales **publicas Sandbox**, total HNL 1.00, identidad ficticia y sin callback devolvio HTTP 403 y contenido HTML, sin `success`/`url` JSON.

La navegacion a la ruta publicada con parametros de prueba mostro: «El modulo de pago sandbox no existe». El checkout de ejemplo exacto de la guia devolvio 404. No se enviaron tarjetas, no se pulsaron pagos Live, no se registraron callbacks hacia terceros ni se modifico MasterFade remoto.

No se atribuye ese resultado a la cuenta MasterFade ni a una causa de firma: el servicio no devolvio un contrato financiero util. La verificacion externa del checkout, escenarios y callback queda bloqueada hasta recibir de PixelPay una ruta Sandbox vigente. La lectura posterior de la guia en el Chrome del usuario confirmo la misma ruta documental.

## Matriz de validacion

Validacion inicial del backend: **404 pruebas aprobadas, 0 fallos, 0 omitidas**, en dos ejecuciones complementarias previas al ajuste de orden de trigger. En la continuacion acotada pasaron **417 pruebas sin aplicar SQL**, incluyendo diagnostico, vectores sinteticos financieros, matriz de configuracion y regresiones Hosted/SDK/callback/propiedad/piloto. `npm run lint -- --quiet` y `git diff --check` correctos. La regresion PostgreSQL con normalizador real se preparo pero no se ejecuto en esta continuacion. No se ejecuto la suite completa del repositorio.

Comandos de la validacion inicial, anteriores al ajuste del trigger (registro historico, no prueba de la migracion actual):

```powershell
node --test test/pixelpay-hosted.test.mjs test/pixelpay-hosted-routes.test.mjs test/pixelpay-sdk-provider.test.mjs test/pixelpay-sale-guard.test.mjs test/pixelpay-webhook-safety.test.mjs test/microfase2a2-public-pagos-routes.test.mjs test/private-commerce.test.mjs test/payment-disabled-mode.test.mjs
# 380 PASS
node --test test/pixelpay-hosted-financial-guards.postgres.test.mjs test/pixelpay-financial-evidence-contract.test.mjs test/pixelpay-reconciliation-window-contract.test.mjs
# 24 PASS historicos; candidatas anteriores al ajuste de orden, en PostgreSQL 17 temporal local
npm run lint -- --quiet
git diff --check
```

En la validacion inicial el entorno restringido bloqueo localhost (`EACCES`); la prueba se ejecuto con acceso local autorizado y paso. Esos resultados corresponden a la candidata anterior al ajuste de orden del trigger. La continuacion no aplico SQL; la regresion PostgreSQL actualizada queda pendiente. No se usaron bases compartidas para tests.

Evidencia externa sanitizada: [POST Sandbox](evidence/pixelpay-hosted-sandbox-20261114.json). Separar pruebas sinteticas locales de evidencia real del proveedor.

| Caso requerido | Criterio esperado |
| --- | --- |
| SDK intacto | Pruebas existentes Sale/provider/callback/recuperacion siguen pasando con Hosted apagado. |
| Hosted Sandbox | Firma/formato/URL cubiertos con transporte simulado; prueba externa bloqueada como se describe arriba. |
| Aprobado simulado | Aviso `paid` queda pendiente, cero payments/ventas/reservas confirmadas. |
| Rechazado simulado | No confirmar ni crear pagos, no repetir checkout. |
| Cancelacion cliente | Retorno consulta estado; no supone anulacion financiera. |
| Callback duplicado | Un recibo durable y resultado pendiente idempotente. |
| Callback falsificado | Rechazar hash/orden invalidos; incluso con hash conocido nunca aprobar. |
| Hash invalido | Rechazo sin escritura financiera. |
| Importe incorrecto | Rechazo frente al total canonico. |
| Moneda incorrecta | Rechazo; solo HNL. |
| Orden ajena | Propiedad requerida start/status, callback solo orden unica persistida. |
| Hold vencido | No iniciar checkout nuevo ni recuperar slot. |
| Pago tardio | Evidencia de aviso tardio para revision, sin confirmar cita liberada. |
| Timeout/desconexion | Claim persistido, operacion incierta, no reenvio automatico. |
| Concurrencia/doble confirmacion | Un canal y checkout por grupo; guard PostgreSQL impide confirmacion Hosted. |
| Reportes/ventas | Cero contaminacion de ingresos hasta evidencia financiera autentica. |
| Proveedor real | Solo Sandbox; no se ejecuto Live. |

## Procedimiento de despliegue QA (requiere autorizacion posterior)

1. Revisar y aprobar ambos PR contra `dev`; comprobar que siguen basados en QA y actualizar conflictos sin incorporar trabajos ajenos.
2. Obtener endpoint Sandbox vigente y contrato de habilitacion Hosted aplicable a MasterFade. Repetir transporte desde el egress del servidor QA; no reutilizar intentos inciertos anteriores.
3. Guardar configuracion/identidad de imagen anterior y rollback. Mantener comercio publico cerrado y piloto restringido. No alterar claves SDK.
4. Aplicar las dos migraciones en orden a QA bajo el procedimiento de cambios del proyecto. Verificar tabla privada, RLS, permisos y triggers; no hacer backfill de intentos existentes.
5. Desplegar backend y frontend con `PIXELPAY_HOSTED_ENABLED=false`; SDK debe conservar la misma capacidad anterior.
6. Configurar variables dedicadas `PIXELPAY_HOSTED_KEY_ID`, `PIXELPAY_HOSTED_SECRET_KEY`, `PIXELPAY_HOSTED_APP_URL`, `PIXELPAY_HOSTED_CALLBACK_URL` solo del Sandbox. El secreto va exclusivamente en backend. `ENTORNO=qa`, `PIXELPAY_ENV=sandbox`, `PAYMENT_PROVIDER=pixelpay`, `FRONTEND_URL=https://qa.masterfadeapp.com`; no activar modo publico.
7. Solo tras autorizacion QA habilitar la bandera Hosted para la prueba privada. Esta version mantiene `automatic_confirmation=false` y rechaza cualquier configuracion Live. Si PixelPay comunica un endpoint distinto del documentado, ajustar y revisar allowlist/config antes de habilitar.
8. Ejecutar matriz Sandbox con nuevas ordenes: retorno, fallo, cancelacion y callback desde proveedor. Verificar unicidad, recibos, hold expirado y cero pagos/ventas para resultados no autenticados.
9. Ante problema apagar `PIXELPAY_HOSTED_ENABLED` para suspender creaciones y conservar las credenciales dedicadas y callback configurados. El receptor sigue activo en QA/Sandbox para sesiones existentes aun si se pausa el proveedor o vuelve el modo administrativo. Mantener tabla/canal y guardrails para recuperar operaciones; no borrar sesiones ni cambiar de canal. Rollback de aplicacion a una version que conoce el canal, nunca a una version SDK que trate Hosted como Sale. Eliminar credenciales tambien deshabilitaria recepcion, por lo que no forma parte del rollback normal.

## Condiciones exactas antes de autorizar una unica prueba Live

Esta version no puede iniciar Live por configuracion. Primero se requiere otra revision de codigo/contrato y autorizacion explicita. Condiciones acumulativas:

1. PixelPay confirma por escrito habilitacion de Hosted para la cuenta, dominio/endpoint, HNL, credenciales y 3DS bancario.
2. Contrato y vector verificable de autenticacion financiera que ligue orden, cuenta, importe, moneda, UUID/transaccion, estado final y fecha. Debe resistir falsificacion del navegador y replay; puede ser callback firmado completo o consulta S2S autenticada con esquema completo demostrado.
3. Demostrar en Sandbox aprobacion/rechazo/duplicado/falsificado, importe/moneda/orden alterados, tiempos y expiracion; confirmar idempotencia de creacion y forma oficial de consultar/anular un checkout incierto.
4. Disenar un evento Hosted propio de aprobacion durable y adaptar triggers/ventas bajo revision financiera, sin reutilizar eventos SDK. Probar atomicidad, exclusion de slots, paid_at autentico y pagos tardios sin doble reserva.
5. Pruebas QA privadas completadas, cero regresiones SDK, ninguna operacion incierta nueva sin resolver; los cinco intentos previos permanecen aislados y sin modificar.
6. Verificar imagen/runtime, migraciones, egress, webhook HTTPS, observabilidad sanitizada y rollback recuperable. Bandera de comercio publico apagada; cuenta y acceso privados especificados.
7. Autorizacion nueva que identifique una sola orden, titular, servicio/slot, monto maximo HNL y tarjeta autorizada. Un intento total, sin retries automaticos. Definir como reconciliar y, si corresponde, anular/reembolsar por via oficial.
8. Capturar resultado financiero autentico y comprobar exactamente un payment, una reserva y una venta/reportes coherentes antes de ampliar alcance. Si es incierto, detener y conciliar; nunca volver a cobrar por el retorno del navegador.

No se solicito ni ejecuto merge, despliegue, activacion publica, cambio de credenciales remotas ni operacion Live.
