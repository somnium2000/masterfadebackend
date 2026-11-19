# PixelPay 2.5.8: reproducción de incompatibilidad Node/3DS

Fecha de revisión: 2026-11-18. Resultado: **coordinación 3DS bloqueada por las interfaces verificadas; no implementada**. Este reporte documenta un problema reproducible del SDK y el contrato que falta para resolverlo. No solicita una arquitectura personalizada ni demuestra que todas las integraciones de PixelPay sean imposibles.

## Revisiones y alcance

Las referencias `origin/dev` se actualizaron correctamente por Git antes de crear worktrees aislados:

| Repositorio | SHA revisado |
| --- | --- |
| masterfadebackend | `239358642ae19fcd29378292d713e8e92c9f5fd7` |
| masterfadefrontend | `7d9e5c7c5a22eac9691c93b2c07311970ae3f788` |

Los checkouts originales contienen cambios ajenos y no se modificaron. Sus ramas locales `dev` antiguas no se usaron como base. Ambos `package.json` y `package-lock.json` de las revisiones anteriores fijan `@pixelpay/sdk-core` en **2.5.8**. El paquete instalado del backend usado en la reproducción es 2.5.8. También se inspeccionó una instalación frontend 2.5.8 del worktree anterior `qa-official-3ds-frontend-20261116`; esto no verifica la versión servida por QA ni constituye una instalación nueva del worktree frontend actual.

Se revisó [PR #143](https://github.com/somnium2000/masterfadebackend/pull/143), abierto y sin fusionar en la consulta, HEAD `dbca59726bf79f8713a1603327aa3e36c1a5adbb`: amplía las tarjetas oficiales Sandbox y añade cobertura para el caso 2.9. Su catálogo no está en el SHA backend revisado y no se duplica aquí. Ese cambio no agrega una interfaz de continuación 3DS.

Se toma como contexto la respuesta de soporte del ticket #9834, 18 de noviembre a las 15:57 de Honduras, proporcionada por el solicitante: módulo 3DS activo, solicitud explícita mediante `withAuthenticationRequest()` y coordinación React/Node a cargo del comercio. No se vuelve a condicionar el trabajo a un ejemplo personalizado.

## Recorrido actual de MasterFade

1. `useBookingPayment.js`, `salePixelPayOnce()` (línea 441), guarda el contexto pendiente antes del envío y llama a `salePublicPixelPay()` con grupo, intento, identidad, tarjeta y facturación. No recibe un objeto de continuación consumible por el SDK navegador. Mantiene la consulta de recuperación y evita iniciar otra venta del mismo intento pendiente.
2. `PixelPaySdkProvider.js`, `buildSaleRequest()` (línea 425), construye `Order`, `Card`, `Billing` y `SaleTransaction` en Node. En líneas 494–498 asigna los modelos sin activar `withAuthenticationRequest()`.
3. `sale()` ejecuta `transaction.doSale(saleRequest)` en Node (línea 573), con configuración y firma gestionadas en backend.
4. `pixelPaySaleRuntime.js`, `parseResponse()` (línea 235), convierte Sale HTTP 202 en `PixelPayContinuationRequiredError` antes de ejecutar los administradores de navegador. El sink diagnóstico antiguo no es una conexión activa del checkout y no se rehabilita.
5. El hook sólo trata como definitivo el resultado de reserva confirmada o intento fallido que devuelve backend; el resto sigue pendiente. El checkout no dispone de un receptor oficial de la continuación nacida en Node.

## Métodos reales y límites

Las firmas siguientes se verificaron en el paquete instalado y se contrastaron con las páginas de documentación del MCP PixelPay. “Interna” significa disponible por importación de archivo, pero ausente del contrato público de servicios consultado y de los servicios exportados por `lib/index.js`.

| Método | Entorno / carácter | Entrada | Salida y límite observado |
| --- | --- | --- | --- |
| `new SaleTransaction(); setOrder(Order); setCard(Card); setBilling(Billing)` | Node actual; API documentada | Modelos construidos a partir del intento validado | Petición para `doSale`; no crea canal React/Node. |
| `withAuthenticationRequest(): void` | Cliente según documentación; método heredado de `PaymentTransaction` | Ningún argumento | Sólo asigna `authentication_request = true`; no entrega token, callback ni handle de sesión. |
| `new Transaction(settings: Settings)` | Node actual; API documentada | Endpoint, credenciales y firma en `Settings` | Servicio transaccional. |
| `doSale(transaction: SaleTransaction): Promise<Response>` | Node obligatorio para MasterFade; API documentada | La petición anterior | Rechaza explícitamente bandera 3DS en Node. Sin bandera, consume el `PayloadResponse` internamente antes de resolver. No tiene argumento de receptor/browser ni método público de suspensión/reanudación. |
| `new CardinalManager(settings: Settings, request: PaymentTransaction)`; `init(jwt: string, url?: string \| null): Promise<Response>` | Navegador; importación interna `lib/libraries/CardinalManager` | Configuración, petición original, payload opaco y URL opcional | SDK administra DOM, challenge y continuación. No es una interfaz documentada para recibir una Sale originada en Node. Requiere su propio servicio de autenticación y transacción. |
| `Settings.setupCredentials(key: string, hash: string): void` | Backend en este diseño; API pública | Identificador y hash reutilizable | `ServiceBehaviour.buildRequest()` exige ambos para crear solicitudes. La firma `x-client-signature` y la clave pública de cifrado no sustituyen estos campos. |
| `getStatus(transaction: StatusTransaction): Promise<Response>` | Backend; API documentada | `payment_uuid` guardado, credenciales y firma de Status | Consulta al proveedor; no ejecuta el desafío ni permite confiar en un resultado declarado por React. |
| `TransactionResult.fromResponse(response)` | Transformación local; API documentada | Una respuesta del SDK | Copia propiedades de `response.data`; no recorre `last_response.data` ni acredita aprobación por sí sola. |

## Dos incompatibilidades reproducidas

### 1. Solicitud explícita en Node

En `lib/requests/PaymentTransaction.js:82`, `withAuthenticationRequest()` sólo activa la bandera. Aunque se invoque inicialmente en React, conservar esa propiedad al reconstruir la petición en Node conduce al mismo chequeo.

En `lib/services/Transaction.js:23–26`, `doSale()` ejecuta `doBeforeExecute()` y después rechaza `authentication_request && !Helpers.checkIsBrowser()` con:

```text
InvalidTransactionTypeException: This platform not support 3DS transactions
```

La excepción ocurre antes de `this.post(...)`. La reproducción no depende de rechazo del banco, configuración remota, tarjeta, firma o disponibilidad de Cardinal. La documentación describe bandera en cliente y `doSale` en backend, pero no identifica una transformación oficial de esa petición que permita superar este chequeo conservando la solicitud 3DS. Omitir la bandera no demuestra cumplimiento de la indicación de soporte.

### 2. HTTP 202 sin bandera explícita

`lib/base/ServiceBehaviour.js` clasifica HTTP 202 como `PayloadResponse`. `lib/services/Transaction.js:38–42` lo consume dentro de `doSale()`: para `transaction_type = 'songbird'` ejecuta y espera `new CardinalManager(this.settings, transaction).init(payload, collection_url)`.

La prueba existente devuelve un 202 sintético `songbird` sin `collection_url`. En Node el SDK intenta cargar Songbird mediante utilidades DOM y termina con:

```text
ReferenceError: document is not defined
```

No es un fallo de verificación de JWT: la prueba utiliza un payload inerte y llega al acceso DOM antes de una sesión real. No se probó remotamente el camino `collection_url`; su código también usa formulario/DOM y continúa mediante `authenticationLookup()` y `retryTransaction()`.

Por ello, eliminar solamente la contención de `pixelPaySaleRuntime.js` devuelve la ejecución a dependencias de navegador dentro de Node. El `await doSale()` no retorna primero el payload para que el hook decida cómo representarlo.

### Por qué la clase interna no cierra el contrato

`CardinalManager` crea `new CardinalAuthentication(settings)` en su constructor. Tanto el camino Songbird como el de `collection_url` usan ese servicio. `CardinalAuthentication` hereda `ServiceBehaviour`, que exige `auth_key` y `auth_hash`; su `retryTransaction()` vuelve a enviar la petición original como parte del flujo interno del SDK.

Esto distingue las solicitudes internas legítimas del SDK de una segunda Sale iniciada por nuestra aplicación. No se propone bloquear aquellas solicitudes. Tampoco se propone exportar credenciales a React, sustituir métodos internos por un protocolo propio, falsear respuestas ni recrear el puente retirado. La posibilidad de importar una clase interna no acredita una interfaz soportada de transporte dividido.

## Reproducción y validación local

Se reutilizó, sin editar, `test/official-pixelpay-example.test.mjs` y `test/fixtures/officialPixelPaySale.mjs` del SHA backend indicado. En un checkout con dependencias instaladas:

```sh
node --test test/official-pixelpay-example.test.mjs
npm run lint
```

Resultado observado en Node **v22.22.2**:

- Prueba focalizada: **1 PASS, 0 FAIL**.
- Sale básica: una solicitud transaccional al adaptador sintético.
- Sale con autenticación explícita: rechazo antes de otra solicitud transaccional.
- Sale sin bandera con 202 sintético: segundo envío al adaptador, seguido del error DOM esperado.
- Conexiones de socket externas: **0**; llamadas reales Sale/Status: **0**.
- No se reemplazan `doSale()` ni `withAuthenticationRequest()`. Se sustituye únicamente el transporte Axios por respuestas sintéticas y se bloquean sockets. Esto no acredita un challenge real ni aprobación financiera.
- Lint backend: **0 errores, 25 advertencias preexistentes**. No se ejecutó una batería adicional de pagos ni build frontend porque el cambio es exclusivamente documental.

El primer intento en el worktree falló por `MODULE_NOT_FOUND` al no tener dependencias. Se resolvió usando las dependencias locales ya instaladas. El intento de crear una junction sin elevación devolvió `Acceso denegado`; la creación con el mecanismo de autorización del entorno fue permitida. Ninguno de esos errores fue un fallo de Git o evidencia del SDK. La prueba pasó una vez resuelta la dependencia.

## Cierre financiero: limitación adicional revisada

`queryPaymentStatus()` pasa la respuesta completa a `readTransactionResult()` (`PixelPaySdkProvider.js:836`). `TransactionResult.fromResponse()` copia sólo el primer nivel de `response.data`. Por tanto, si el resultado transaccional llega exclusivamente dentro de `response.data.last_response.data`, como indica el contrato referido por soporte, sus campos no se extraen automáticamente. Este reporte no modifica ese comportamiento ni afirma haber capturado ese envelope en QA durante esta revisión.

Una futura coordinación debe obtener la respuesta por el canal backend-proveedor y validar su envelope, resultado anidado, orden, UUID, importe, moneda y estado aprobado/completo contra el intento persistido. Debe conservar evidencia durable, unicidad e idempotencia antes de confirmar pago y reserva. Ni `validateResponse()` ni un hash válido ni la finalización del challenge equivalen por sí solos a pago aprobado; la prueba existente incluye respuestas declinadas/timeout aceptadas por `validateResponse()`.

## Dato técnico exacto necesario para desbloquear

No falta acceso Git. Falta identificar en una versión oficial compatible:

1. Cómo admite `Transaction.doSale(SaleTransaction)` en Node la petición explícita 3DS sin rechazarla, manteniendo intacto el SDK.
2. El método público y su firma para que el SDK navegador reciba la continuación de esa misma operación, con configuración de alcance limitado y sin `auth_hash` reutilizable del comercio.
3. Cómo ese método entrega al backend un identificador correlacionable para obtener y verificar el resultado del proveedor, manteniendo la continuación interna bajo control del SDK.

Se solicita a PixelPay clasificar la contradicción reproducida como defecto del paquete, diferencia de documentación/versión o existencia de una API soportada no identificada. Una corrección oficial o la identificación exacta de esa API permite continuar la implementación de transporte/correlación de MasterFade. No se ha acreditado que otra versión la resuelva; no se cambia de versión por suposición.

## Publicación, QA y recuperación

Este PR sólo incorpora este reporte. No modifica endpoints, autenticación, roles, validación, infraestructura, esquema, secretos, SDK, controles financieros ni UI. No completa el recorrido remoto. No requiere despliegue de aplicación; se conserva el runtime actual. Para retirar el documento basta revertir su commit, sin migraciones ni cambios de entorno.

Cuando exista un parche ejecutable, revisar los PR hacia `dev` (incluido #143 si se usa su caso Sandbox), comprobar CI, desplegar exclusivamente QA con autorización y verificar SHA backend y assets frontend servidos. Sólo entonces realizar la prueba Sandbox controlada autorizada con un intento nuevo: observar Network/SSH saneados, challenge administrado por SDK, evidencia financiera backend y confirmación de reserva. Un intento incierto se consulta y reconcilia; no se repite Sale para recuperarlo. La recuperación de un futuro despliegue debe restaurar los SHA previos verificados de QA y conservar los intentos/evidencias pendientes.

## Fuentes

- [Peticiones y 3DS](https://docs.pixelpay.com/page/sdk/requests?locale=es), consultado mediante MCP PixelPay `es/sdk/requests`.
- [Servicios SDK](https://docs.pixelpay.com/page/sdk/services?locale=es), MCP `es/sdk/services`.
- [Casos de uso JavaScript](https://docs.pixelpay.com/page/sdk/use-cases/index?lang=javascript&locale=es), MCP `es/sdk/use-cases/payments/without-tokenization/javascript`.
- [Firma de seguridad](https://docs.pixelpay.com/page/secure-signature?locale=es), MCP `es/secure-signature`.
- Archivos locales de `@pixelpay/sdk-core@2.5.8`: `lib/services/Transaction.{js,d.ts}`, `lib/requests/PaymentTransaction.js`, `lib/libraries/CardinalManager.{js,d.ts}`, `lib/services/CardinalAuthentication.js`, `lib/base/ServiceBehaviour.js`, `lib/entities/TransactionResult.js`, `lib/models/Settings.d.ts`, `lib/index.js`.
