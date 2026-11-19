# Prototipo de transporte Node / React con SDK nativo

## Estado y bases

Prototipo de escritorio, opt-in y sin rutas de checkout: **continuar un 202 songbird recibido funciona con proveedor/Cardinal simulados**. No demuestra que la Sale inicial exija 3DS, no confirma reservas y no está listo para Sandbox remoto ni producción.

Bases actualizadas de `origin/dev`: backend `239358642ae19fcd29378292d713e8e92c9f5fd7`; frontend `7d9e5c7c5a22eac9691c93b2c07311970ae3f788`. Worktrees separados, cambios ajenos conservados. SDK efectivo 2.5.8. PR #144 es el reporte documental anterior, separado de este prototipo. PR #143 mantiene su catálogo Sandbox aparte; no se duplica.

El ZIP del solicitante (SHA256 `774dde30426871fdb01bb5606f3e0f554afa7c5ad1a3279e59319bf067eee290`) se extrajo fuera de ambos repositorios y se ejecutó una sola vez con `npm install --ignore-scripts --no-audit --no-fund` y `npm test` (Node 22.22.2). Pasaron `transport-probe.cjs` y `concurrency-probe.cjs`: esta última reproduce el problema A/A, no su solución. Sus evidencias se conservan en la carpeta extraída. Las pruebas de este PR agregan la Sale inicial, transporte HTTP real de loopback, React y aislamiento A/B.

## Recorrido ejecutado

| Paso | Instancia / llamada real | Datos que cruzan la frontera |
| --- | --- | --- |
| React | `new SaleTransaction(); withAuthenticationRequest()` | El objeto del cliente no se envía a Node. No tiene tarjeta, credenciales ni claves de cifrado. |
| Inicio HTTP | `POST /attempts/A/start` en el servidor de escritorio | Body vacío y capability del intento preautorizado por la fixture. No permite elegir importe, orden, comercio ni URL. |
| Worker Node | `PixelPaySdkProvider.buildSaleRequest(input)` y `NodeSaleTransaction.doSale(request)` → `super.doSale(request)` | Input canónico de la fixture servidor; petición inicial independiente con `authentication_request=false`, igual que la rama actual de MasterFade. No se elimina ninguna bandera de una petición existente. |
| Frontera 202 | `pixelPaySaleRuntime.parseResponse()` → callback opt-in `onContinuation(response)` | Se conserva la respuesta nativa y se mantiene la excepción de contención para impedir DOM en Node. El controlador experimental reconoce esa captura; no fabrica otro response para engañar a `doSale()`. |
| Gestor navegador | `new CardinalManager(settings, clientRequest)`; asignación de `manager.service`; `init(payload, collection_url)` | Orden pública, configuración sin credenciales y payload opaco. SDK administra carga de Songbird, eventos y challenge. |
| Lookup delegado | `LookupTransaction.fromPaymentTransaction(original)` → `CardinalAuthentication.authenticationLookup(lookup)` en Node | Sólo `reference` y lista cerrada de campos EMV del navegador. Node conserva su orden y contexto de cifrado. CVV sólo se añade en la rama `collection_url`, como hace el gestor nativo; esa rama aún no está validada. |
| Continue delegado | `new LookupContinueTransaction()` → `authenticationContinue()` en Node | Payload opaco del gestor. Identificador fijado por el lookup recibido en Node; navegador no puede elegirlo. |
| Retry delegado | `CardinalAuthentication.retryTransaction(original)` en Node | Body vacío desde React. Se reutiliza exactamente la instancia original cifrada, no una reconstrucción JSON. |
| Resultado | `PixelPaySdkProvider.completeSaleResponse()` en Node + comprobación de orden, moneda y UUID observado | React consulta evidencia local de Node. `bookingConfirmed` siempre es false; no existen escrituras financieras en el prototipo. |

`Transaction`, `SaleTransaction`, `Settings` y `withAuthenticationRequest()` son interfaces documentadas. Las importaciones `lib/libraries/CardinalManager`, `lib/services/CardinalAuthentication`, `lib/requests/LookupTransaction` y `lib/requests/LookupContinueTransaction` son **extensiones internas experimentales**, no una API pública soportada por PixelPay. La aplicación asigna una propiedad de su instancia del gestor. No edita archivos ni prototipos del paquete, ni programa llamadas propias a Cardinal en el adaptador. Los eventos Cardinal programados en tests son exclusivamente simulación del proveedor.

## Autenticación explícita: discrepancia que continúa abierta

La instancia React sí tiene la bandera. La instancia independiente de Node sigue la rama actual sin bandera y recibe un 202 sintético. El prototipo no afirma que eso obligue al proveedor a autenticar. No usa getters, serialización trucada ni cambios después del chequeo.

Con la opción servidor `explicitAuthentication=true`, la petición Node llama también a `withAuthenticationRequest()`. El SDK 2.5.8 rechaza `Transaction.doSale()` con `InvalidTransactionTypeException: This platform not support 3DS transactions` antes del envío. El intento queda bloqueado, sin fallback que borre la bandera. Un HTTP 200 sin challenge devuelve `completed_without_3ds` y `threeDsGuaranteed=false`.

## Aislamiento, contexto y duplicados

- Un `Worker` por intento carga su propio módulo del SDK. Todas las llamadas de ese intento se serializan en su worker; ninguna comparte el estático `CardinalAuthentication.runningTransaction` con A/B. No se modifica ni resetea ese campo desde aplicación. El servidor de escritorio sólo crea dos workers de fixture y los elimina al cerrar.
- El worker conserva `request`, `settings`, servicios y `sdk_key_pair` en memoria. No usa `toJson()` como mecanismo de persistencia del contexto. La fixture descifra el ciphertext usando la clave de comercio sintética y la clave pública asociada a cada solicitud; verifica igualdad de contexto entre Sale, lookup y retry y sólo publica booleanos.
- Memoización por operación y digest del body permitido: un duplicado idéntico recibe el resultado previo; uno distinto se rechaza. Hay una Sale inicial y una continuación nativa del SDK en el caso exitoso. No se impone un límite global de un POST Sale.
- Timeout, salida del worker o expiración dejan un objeto cerrado; no se vuelve a crear automáticamente. Los resultados fallidos quedan memoizados. El estado es de escritorio, no durable: un futuro despliegue necesita las reclamaciones persistidas existentes y afinidad de contexto antes de aceptar tráfico real.
- No hay regla universal `continueAccepted`: el SDK puede continuar sin challenge o después de `continue.success=false`. La aprobación depende exclusivamente de evidencia financiera posterior del canal Node-proveedor.
- Cardinal mantiene eventos globales por página: el adaptador permite un gestor activo por página. Tras una interrupción incierta requiere recarga para una nueva sesión local; el SDK no ofrece cancelación de todos sus callbacks async. Los requests tardíos se bloquean en el adaptador. No se presenta ese manejo como recuperación remota completa.

## Evidencia financiera y Status

Se reutiliza el clasificador actual de `completeSaleResponse`: estado HTTP, aprobación/completitud, importe transaccional y aprobado, hash, UUID y transaction ID. Se exige además orden y moneda iguales al input canónico y, si el 202 entregó UUID, igualdad con el final. Datos de aprobación enviados por el navegador se rechazan. El resultado sirve para evaluar la fixture; no activa reservas, `payment_events`, conciliación ni `paid_at`.

La operación experimental `status` devuelve sólo estado en memoria, **no llama a PixelPay `getStatus()`**. Se revisó su limitación actual: `queryPaymentStatus()` entrega el envelope externo a `TransactionResult.fromResponse()`, que no extrae `response.data.last_response.data`. No se parchea silenciosamente ese contrato ni se utiliza como atajo de aprobación. Antes de QA se necesita validar esa extracción sobre respuesta auténtica, correlacionar UUID/orden/importe/moneda y conectar la evidencia durable y los controles existentes de reserva.

## Ejecución reproducible

En backend con dependencias instaladas:

```powershell
node --test test/pixelpay-delegated.test.mjs
node --test test/pixelpay-sdk-node-runtime.test.mjs
npm run lint
```

En el frontend del PR compañero, indicando ruta absoluta al checkout backend de este PR:

```powershell
$env:PIXELPAY_PROTOTYPE_BACKEND = 'C:\ruta\al\backend-del-prototipo'
npm run test:vitest -- src/features/payments/__tests__/delegatedPixelPay.test.jsx
npm run lint
npm run build
```

El test React levanta `scripts/pixelpay-delegated-desktop.mjs`, escucha exclusivamente en `127.0.0.1` con puerto efímero y capabilities independientes A/B. Realiza HTTP real a loopback y bloquea cualquier socket hacia otro destino en el cliente; los workers bloquean sockets/fetch externos y usan Axios sintético. No carga `.env`, no se conecta al VPS y no usa credenciales reales. El servidor rechaza Origin (no se publica como aplicación web) y una capability B no autoriza A. Al terminar, cierra servidor y workers. Sin la variable del checkout compañero, CI frontend omite únicamente ese caso combinado y ejecuta las pruebas locales del adaptador.

Resultados locales: **12/12** pruebas backend del prototipo y **3/3** pruebas frontend (incluido HTTP entre repositorios), sin skips en la ejecución conjunta.

| Criterio | Evidencia |
| --- | --- |
| Sale inicial Node y entrega al gestor | Test React de HTTP loopback y `real Node Sale...` backend |
| Métodos nativos delegados | Secuencia exacta start → lookup → continue → retry → status observada en React |
| Secretos y cifrado sólo Node | DTO sin claves/credenciales/tarjetas; backend sin DOM; decrypt/context booleans true |
| A/B concurrentes | Dos workers reciben exclusivamente orden/UUID propios |
| Duplicados y fallos | Memoización, rechazo de bodies distintos, 520, contexto perdido y doble clic sin otra Sale inicial |
| Veredicto financiero servidor | Rechazo de campos cliente; casos declined, bad-currency, bad-uuid y bad-amount; bookingConfirmed false |
| Rama sin autenticación explícita | 202 continuado; caso 200 nunca se marca como 3DS probado; bandera true conserva rechazo |

La primera ejecución de HTTP local falló con `connect EACCES 127.0.0.1`; se repitió con autorización de loopback y pasó. La regresión runtime también necesitó loopback para sus fixtures TCP/DNS/TLS: **39/39 PASS**. Lint backend: cero errores, 25 advertencias existentes. Lint frontend y build: PASS (build advierte tamaño de chunks). Los tests del prototipo no prueban un iframe bancario real, resultado financiero real ni versión servida de QA.

## Antes de QA

Revisar ambos PR de código separadamente del reporte #144; no desplegar el servidor de fixtures. Aún faltan: decisión acreditada sobre exigencia 3DS inicial, soporte/riesgo de imports internos, integración con autorización/CSRF y reclamación durable del intento existente, afinidad/recuperación de contexto tras reinicio, persistencia financiera y reconciliación con Status anidado, limpieza de callbacks e interrupciones, y pruebas de las variantes `collection_url`, payload/router. La whitelist de operaciones no sustituye esos controles de producción.

El checkout, `useBookingPayment.js`, sus rutas y las capacidades retiradas permanecen inactivos para este prototipo. No hay nuevos endpoints registrados en la aplicación ni DDL. Tras implementar y revisar los pendientes, un despliegue exclusivamente QA debe comprobar los SHA servidos y recién entonces realizar un intento Sandbox autorizado con Network/SSH. La recuperación conserva intentos inciertos y no dispara otra Sale. Revertir estos PR sólo retira código experimental y el callback opcional, sin migraciones.
