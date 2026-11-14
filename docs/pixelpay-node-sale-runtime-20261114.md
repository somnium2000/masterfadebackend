# PixelPay: compatibilidad del runtime de Sale en Node — 2026-11-14

## Alcance y conclusión

Hotfix limitado a la compatibilidad del SDK Core 2.5.8 con Node y al diagnóstico seguro de sus excepciones. No cambia Status, callbacks, triggers financieros, permisos comerciales, configuración de producción ni datos históricos. No acredita disponibilidad para una venta Live.

Una prueba local puede demostrar un defecto del runtime y su corrección. No permite atribuir automáticamente a ese defecto una excepción registrada en Live sin recuperar el símbolo y la ubicación originales.

## Evidencia de producción disponible

La inspección de solo lectura recuperó dos secuencias del mismo contenedor `993b579be9b5`, iniciado a las `05:02:16.047957834Z`, con cero reinicios. Los timestamps siguientes conservan la zona UTC del registro original:

| Secuencia | Inicio del intento | HTTP_STARTED | FAILED / UNCERTAIN | Diagnóstico disponible |
| --- | --- | --- | --- | --- |
| A, `req-3t` | 05:11:19.058Z | 05:11:19.061Z | 05:11:22.678Z; 3621 ms | ReferenceError; SDK_NETWORK_ERROR |
| B, `req-c3` | 05:40:56.827Z | 05:40:56.829Z | 05:40:58.605Z; 1779 ms | ReferenceError; SDK_NETWORK_ERROR |

No se recuperaron el símbolo original de cada ReferenceError ni su stack original. No está demostrado que ambas excepciones Live procedieran de `crypto`, de una API DOM o del mismo punto del SDK. Tampoco `HTTP_STARTED` prueba que PixelPay recibiera una solicitud o devolviera una respuesta: el evento precede a la ejecución del SDK.

## Defecto demostrado y corrección

El SDK 2.5.8 convierte HTTP 202 en `PayloadResponse` en `lib/base/ServiceBehaviour.js:73`. Después de recibir esa respuesta, `lib/services/Transaction.js:39-49` despacha `payload` a `PayloadManager`, `songbird` a `CardinalManager` y `router` a `RouterManager`. En Node, el caso sintético `payload` produce realmente `ReferenceError: document is not defined` en `lib/libraries/PayloadManager.js:43:35`, incluso con `authentication_request=false`. El SDK usa `document` para crear/presentar un iframe y recoger la respuesta del flujo interactivo. Es una dependencia de navegador en esa rama, no una ventana horaria ni una falla DNS demostrada.

La subclase `NodeSaleTransaction` conserva `super.doSale`, sus controles, el cifrado y los métodos de transporte/firma del SDK. Intercepta el 202 de Sale antes de entrar en DOM o en el router que podría invocar otra Sale. Produce `SDK_BROWSER_ACTION_REQUIRED` solo para los tipos conocidos `payload` y `songbird`. Un `router`, cuerpo vacío o tipo desconocido produce `SDK_CONTINUATION_REQUIRED`: significa 202 sin resolver, no confirma un challenge ni una continuación válida. Conserva HTTP 202 y el resultado incierto. No incorpora DOM ficticio, HTTP directo, nuevas dependencias ni parches de node_modules. SDK sigue fijado en 2.5.8.

Los interceptores de la instancia Axios creada por el SDK registran fase, status y metadatos de transporte sujetos a listas permitidas. Un GET exitoso de `merchant/public_key` no se confunde con respuesta de Sale. La excepción original deja de transformarse internamente en un `FailureResponse` 520 que perdía nombre y stack. El provider conserva incertidumbre ante una Sale posiblemente enviada y mantiene el código público existente por compatibilidad; el diagnóstico interno distingue `SDK_REFERENCE_ERROR`, `SDK_RUNTIME_ERROR`, `SDK_NETWORK_ERROR`, `SDK_DNS_ERROR`, `SDK_TLS_ERROR`, `SDK_WAF_CHALLENGE`, `SDK_HTTP_TIMEOUT`, `SDK_UPSTREAM_ERROR`, `SDK_RESPONSE_PARSE_ERROR`, `SDK_BROWSER_ACTION_REQUIRED` y `SDK_CONTINUATION_REQUIRED`.

El procesamiento financiero posterior también queda dentro del manejo de errores inciertos. Una respuesta HTTP 200 aislada no basta: se conservan las verificaciones de resultado completo, hash, UUID, transacción e importes. No se modifica el contrato canónico de `paid_at`, la evidencia durable ni los endpoints de recuperación.

Los logs nuevos usan exclusivamente fases permitidas, booleanos, nombres de excepción conocidos y archivos relativos del SDK con línea/columna. `sdkTransactionType` solo admite `payload`, `songbird`, `router` o null; no se decodifica el payload. No incluyen mensajes arbitrarios, stacks completos, PAN/CVV, payloads, credenciales o firmas. Se corrige además la etiqueta de ambiente en telemetría: procede del provider configurado y no queda fijada en sandbox. Los códigos nuevos se observan en logs; la allowlist existente de persistencia puede descartarlos a null. No se cambia esquema ni historial financiero.

## Límite de 3D Secure

La [instalación oficial JavaScript/TypeScript](https://docs.pixelpay.com/page/sdk/installation/javascript) y el [contrato de solicitudes del SDK](https://docs.pixelpay.com/page/sdk/requests) distinguen las operaciones backend de `withAuthenticationRequest`, que requiere un entorno de cliente compatible para la interacción de autenticación. Un backend Node no puede resolver por sí mismo un challenge del banco.

Una respuesta 202 o que requiera autenticación DOM permanece incompleta/incierta y requiere conciliación; no activa reserva, suscripción ni beneficios. No debe fabricarse `window` o `document` para aparentar que se completó el challenge, omitir la autenticación ni reintentar Sale automáticamente. Resolver la interacción 3DS requiere un flujo oficial de frontend/plataforma y una autorización separada.

Las horas de las capturas solo correlacionan eventos. No demuestran una ventana horaria, mantenimiento o regla temporal del SDK; no se introduce una restricción por hora ni un cambio de zona horaria.

La revisión del historial de soporte aportado el 14/11 no aporta una respuesta 202 de Sale ni un contrato Node/3DS/router. Sus ejemplos 202 pertenecen a la API de recuperación MasterFade y sus aprobaciones Sandbox documentadas son HTTP 200. La hora 22:00 citada por soporte corresponde al cierre de lote para anular, no a una prohibición de vender. El historial tampoco permite atribuir el ReferenceError actual al antiguo WAF 403 o al simulador Sandbox L8/412.

`RouterManager` no usa DOM: crea otra Transaction y ejecuta otro POST con configuración de su payload. Eso no demuestra por sí mismo un segundo cargo; podría ser una continuación legítima. Este parche no la ejecuta y puede impedir completar un flujo que la requiera. Su habilitación requiere contrato confirmado de endpoints, identidad e idempotencia con PixelPay. No se presenta esta contención como una solución completa de ventas Live que dependan de 202.

## Validación anterior conservada como referencia

Base verificada: `1e2a15a7c6dcd64e26f6bc7da034efcb6bde2dbe`. Dependencias exactas instaladas mediante `npm ci --ignore-scripts --no-audit --no-fund`. Pruebas en Node 20.20.2 Windows; no equivalen a ejecutar el contenedor Alpine desplegado.

| Validación | Resultado |
| --- | --- |
| SDK real 2.5.8 + Axios 1.20.0, matriz A–M y extras | 23 PASS, 0 FAIL, 0 SKIP |
| Provider SDK existente + privacidad del diagnóstico | 126 PASS, 0 FAIL, 0 SKIP |
| PostgreSQL 17.9 aislado, Node 20 y contrato financiero v2 | 60 PASS, 0 FAIL, 0 SKIP |
| PostgreSQL 17 aislado: identidad de membresías y response_code | 2 PASS, 0 FAIL, 0 SKIP |
| Lint | 0 errores, 25 advertencias existentes; archivos nuevos sin advertencias |
| Diff-check | PASS |
| Regresión general, Node 20, concurrencia 4 | 3117 PASS, 1 FAIL preexistente, 14 SKIP; 3132 pruebas |

La matriz incluye aprobación 200 verificable; rechazo 402; 202 vacío, JSON, error, payload, songbird y router; 400/408/412/500; timeout Axios; ReferenceError antes del transporte; SyntaxError después de recibir 200; respuesta incompleta; UUID ausente; construcción inválida; y clave pública 200 seguida de fallo antes de Sale. Cada caso posterior al envío comprueba exactamente una Sale. Ocho probes verifican las guardas de red externa. El caso G produce un ECONNRESET auténtico mediante un único servidor efímero 127.0.0.1; el resto usa transporte sintético. No se contactó PixelPay.

Las 60 pruebas PostgreSQL verifican seis decimales y rechazo de diferencias de un microsegundo, identidad, evidencia única, rollback, recuperación tardía, duplicados e idempotencia. Reservas comprueba dos conexiones realmente esperando el advisory lock; VIP comprueba contención de identidad y una sola activación. Incluyen recuperación HTTP con compras suspendidas. Los clusters se crean y detienen localmente, sin Supabase. Esta ejecución usa `--no-experimental-global-webcrypto`; no sustituye la matriz SDK ejecutada con el runtime Node soportado.

La primera ejecución general sin permiso de loopback quedó incompleta y no cuenta como PASS. La ejecución final con ese permiso local terminó en 172 segundos con los resultados de la tabla. El único fallo está en `test/accountDeletionRemaining.test.js:197`: espera rechazo de cuenta eliminada, pero su fixture recibe antes el rechazo de vigencia durable. Se reprodujo en main intacto: 48 PASS, 1 FAIL en ese archivo, sin el hotfix. No se modifica esa prueba ajena al alcance y no se declara la regresión completa en verde.

Las 14 pruebas omitidas en la ejecución general tienen activación opcional. Las suites financieras de timestamps, triggers v2, conciliación VIP, identidad de pagos y response_code se ejecutaron por separado con sus controles habilitados: 62 PASS sin skips. Los otros skips corresponden a benchmark/códigos de reserva, reserva administrativa, reportes administrativos, perfil QA y promociones; no se declaran cubiertos. Las dos pruebas adicionales de identidad y response_code comprueban que no se reutiliza un payment_uuid y que solo se acepta un código financiero seguro.

Tras precisar la clasificación 202, la ejecución focalizada anterior pasó 149/149. Una repetición tuvo un falso positivo en el test existente `pixelpay-sdk-provider.test.mjs:805`: su regex de CVV `999` coincidió con esos dígitos dentro del UUID aleatorio de paymentAttemptId. No había un campo CVV en la salida. El registro se conserva; la revisión ampliada descrita abajo fija ese UUID sintético sin relajar la aserción. Las 62 pruebas financieras PostgreSQL corresponden al commit inicial `7bc7d29`; desde esa ejecución solo cambia clasificación/telemetría 202 y sus pruebas, no autorización ni persistencia financiera.

Node portable oficial: [v20.20.2](https://nodejs.org/dist/latest-v20.x/node-v20.20.2-win-x64.zip), SHA256 verificado contra SHASUMS256.txt: `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`.

## Pendientes antes de cualquier validación Live

- Obtener confirmación del proveedor de que los intentos históricos no generaron cargos; no reintentarlos.
- Mantener separados el merge, el despliegue manual y una validación Live expresamente autorizada. Este trabajo no realiza ninguno de ellos.
- Si el incidente Live reaparece, usar los nuevos códigos y la ubicación SDK saneada para identificar su origen. La causa exacta de los dos registros históricos continúa sin demostrarse.

No se ha validado un challenge real ni una nueva operación Live. Antes de abrir compras, confirmar con PixelPay el contrato del flujo interactivo requerido para el comercio. No hay una corrección oficial posterior verificada que complete ese flujo en Node.

## Comparación concreta Sandbox y Live

| Capa | Comprobado en código o documentación | Lo que no demuestra |
| --- | --- | --- |
| Settings | Sandbox ejecuta setupSandbox y sobrescribe credenciales; Live configura endpoint, credenciales y environment live. Ambas ramas configuran la firma saliente y usan el mismo SDK 2.5.8. | No verifica por sí mismo los valores efectivos del contenedor. |
| Clave pública y cifrado | ServiceBehaviour valida la public key, construye la clave SDK y cifra la solicitud antes del POST de Sale. La preparación es compartida por ambos ambientes. | Un GET de public_key exitoso no prueba envío ni respuesta de Sale. |
| Respuesta 200 | Las aprobaciones Sandbox documentadas tomaron una respuesta terminal compatible; doSale devuelve SuccessResponse sin despachar gestores de continuación. | No garantiza que una operación Live vaya a responder 200 ni que todo 200 sea financieramente aprobado. |
| Respuesta 202 | ServiceBehaviour convierte 202 en PayloadResponse; el despacho posterior depende de transaction_type, no exclusivamente del ambiente ni de haber solicitado authentication_request. | No se recuperó el HTTP original de los incidentes A/B. El 202 de MasterFade no prueba 202 de PixelPay. |
| Cardinal | El SDK selecciona Songbird de pruebas para Sandbox/STAGING y producción para Live. | No demuestra que la cuenta, banco o tarjeta de estos incidentes exigieran 3DS. |
| Firma y callback | La construcción de firma y la identidad financiera deben mantener correspondencia de ambiente. El callback es un canal asíncrono separado. | Recepción de callback o retorno de navegador no equivalen a pago conciliado. |

Por tanto, la explicación comprobada de los éxitos anteriores es que una respuesta 200 válida puede procesarse sin entrar en la rama de navegador. La explicación de los ReferenceError históricos sigue condicionada a recuperar su ubicación original o las trazas del proveedor. No atribuirlos automáticamente a credenciales, WAF, TLS, hora nocturna o 3DS.

## Contrato de continuaciones observado en SDK 2.5.8

La evidencia siguiente procede del paquete fijado en el lock, no de un contrato adicional proporcionado por soporte:

| transaction_type | Rama real del paquete | Decisión segura en backend |
| --- | --- | --- |
| payload | Transaction.js:43-44 llama PayloadManager.loadPayload. PayloadManager.js:40-66 presenta un iframe con source o HTML Base64 y espera postMessage. Usa DOM y window. | Contener la respuesta; no ejecutar HTML ni simular navegador. No afirmar que todo payload sea un challenge 3DS. |
| songbird | Transaction.js:41-42 llama CardinalManager.init con payload y collection_url. CardinalManager.js:33-62 y 249-278 implementa recolección, lookup/continue y challenge cuando corresponde. | Requiere un entorno cliente compatible; no completar autenticación bancaria en Node. |
| router | RouterManager.js:14-32 decodifica configuración, fija source router y llama de nuevo a doSale/doAuth con otro endpoint/configuración del payload. | No ejecutarlo automáticamente sin contrato de destinos, identidad e idempotencia. Puede ser una continuación legítima; bloquearla no equivale a completar el pago. |
| Ausente o desconocido | No hay contrato de continuación reconocido. | Mantener incertidumbre, sin aprobación ni nueva Sale. |

PayloadResponse no impone un payment_uuid en su definición. No puede prometerse una consulta por UUID si el proveedor no lo devolvió. Para esas operaciones se necesita búsqueda oficial por orden, comercio, importe y hora o un identificador de continuación documentado. No se inventa un endpoint de consulta por order_id ni se suplanta un UUID.

El payload router contiene nombres de campos de autenticación, firma y endpoint. No debe registrarse, reenviarse indiscriminadamente al navegador ni interpretarse como instrucciones confiables para nuestro backend. El código del SDK demuestra que esa rama vuelve a invocar Sale, pero no demuestra por sí solo un segundo cargo: únicamente PixelPay puede confirmar su semántica financiera.

## 3DS: arquitectura condicionada a confirmación del proveedor

Las fuentes oficiales [instalación JavaScript/Node](https://docs.pixelpay.com/page/sdk/installation/javascript) y [Peticiones SDK](https://docs.pixelpay.com/page/sdk/requests) establecen la limitación de 3DS sin navegador y ubican withAuthenticationRequest en cliente. El SDK además rechaza authentication_request en Node antes de enviar Sale. El diagrama general de documentación no sustituye un contrato de handoff completo para esta cuenta.

No se ha demostrado si 3DS es opcional, obligatorio o exigido dinámicamente por el adquirente/emisor de MasterFade. Tampoco se ha demostrado que ambos incidentes llegaran a un challenge.

Si PixelPay confirma interacción necesaria, la propuesta es:

1. Backend conserva orden, intent, titularidad, importe, moneda, sesión, idempotencia y evidencia durable.
2. El cliente recibe solo una URL/token de continuación limitado y oficialmente soportado; nunca Secret Key, auth hash ni el payload router original.
3. El usuario completa el mecanismo bancario en el SDK cliente/checkout oficial. No se automatiza ni evita el desafío.
4. Backend valida el resultado mediante canal autenticado y correlación de la misma operación. Ni redirect ni postMessage aislado autorizan beneficios.
5. Si se requiere [Hosted Payment oficial](https://docs.pixelpay.com/page/integrations/hosted-payment), tratarlo como integración separada: backend crea orden firmada, recibe URL y el checkout gestiona tarjeta/3DS. No reutilizar su callback como si fuera el del Sale directo sin revisar el contrato.

Antes de implementarlo faltan: esquema de continuación, token/TTL, orígenes permitidos, correlación orden/UUID/transacción, procedimiento de continuación idempotente, verificación backend, cancelación/timeout y recuperación sin UUID. No hay autorización para implementar frontend o cambiar el control de autenticación bancaria mediante este PR.

## Horarios, UTC y vencimientos

Los incidentes del 14/11/2026 a las 05:11 y 05:40 UTC corresponden al 13/11/2026 a las 23:11 y 23:40 en Honduras (UTC-6). Esa conversión no cambia el mes.

La firma Sale en PixelPayDirectProvider.js:80-90 usa app_key, order_id y app_url; no contiene fecha, hora ni timestamp. La validación de expiración de tarjeta compara año/mes UTC (PixelPaySdkProvider.js:165-177). Los holds comparan expires_at absoluto contra Date.now (public/pagos.js:304-325), no una hora de cierre diario. Las fechas observadas en el SDK corresponden a locale, offset de zona de 3DS, fingerprint/session y timeouts; no se encontró una prohibición nocturna de Sale.

La referencia histórica de soporte a las 22:00 trataba de doVoid antes del cierre de lote. No prueba una restricción de ventas nocturnas. Una eventual ventana de mantenimiento o regla del adquirente para esta cuenta sigue requiriendo confirmación oficial. La expiración posterior de una reserva no explica por sí misma una excepción ReferenceError del SDK.

## Diagnóstico directo de producción, 14/11/2026 UTC

Acceso de lectura mediante la sesión existente de Chrome: terminal Sh de EasyPanel para el contenedor real y consola noVNC de InterServer para el host. No se cambió ninguna configuración del panel o servidor. Se desconectó únicamente la sesión Sh de diagnóstico; el servicio permaneció ejecutándose.

| Verificación | Host VPS | Contenedor `993b579be9b5` |
| --- | --- | --- |
| Sistema | Ubuntu 24.04.4 LTS; OpenSSL 3.0.13 | Alpine 3.23.4; Node 20.20.2; OpenSSL Node 3.0.19; Linux x64 |
| DNS de pixelpay.app | A y AAAA resueltos por getent | lookup repetido OK (16/4 ms); A 2 ms; AAAA 3 ms |
| IPv4 resuelta | 104.18.10.214 y 104.18.11.214 | Las mismas direcciones |
| IPv6 resuelta | 2606:4700::6812:ad6 y 2606:4700::6812:bd6 | Las mismas direcciones |
| TCP/TLS IPv4 con SNI | TLS 1.3, certificado CN pixelpay.app, Verification OK | TLS 1.3, authorized=true, 156 ms |
| TCP/TLS IPv6 con SNI | TLS 1.3, certificado CN pixelpay.app, Verification OK | ENETUNREACH, 6 ms |
| HEAD raíz pública por IPv4 | curl: 302, 194.520 ms, validación TLS=0, sin seguir redirección a /login | Node https: 302, 286 ms; Axios instalado: 302, 429 ms; sin challenge observado |
| HEAD raíz pública por IPv6 | 403; una comprobación adicional confirmó cf-mitigated: challenge | No se envió HTTP por IPv6 tras fallar conectividad |

Las solicitudes HTTPS fueron exclusivamente HEAD a la raíz pública, sin autenticación, cookies, payload, orden ni parámetros. La verificación TLS mantuvo validación de certificados. No se consultaron endpoints financieros. El 403 IPv6 es una observación WAF real de la raíz desde el host; no demuestra un bloqueo de Sale ni explica el ReferenceError. El contenedor usa IPv4 exitosamente en las pruebas Node/Axios. No se propone cambiar DNS, IPv6, firewall o Cloudflare sin evidencia adicional. Dos resoluciones correctas actuales tampoco descartan una falla intermitente histórica.

El certificado público observado desde el contenedor tiene subject pixelpay.app, issuer YE1 y vigencia 26/10/2026 17:41:38 GMT–24/01/2027 17:41:37 GMT. Se verificó únicamente que PAYMENT_PROVIDER es pixelpay, PIXELPAY_ENV es live y ambos endpoint/app_url apuntan a la raíz https://pixelpay.app, sin query ni credenciales en URL. HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY y variantes minúsculas estaban ausentes en ese proceso; no se deshabilitó TLS y no había NODE_EXTRA_CA_CERTS. No se imprimió el entorno completo ni valores secretos.

SDK 2.5.8 y Axios 1.20.0 se verificaron en node_modules del contenedor. En el paquete local exacto, RequestBehaviour toma `sdk_version` de lib/version.js, cuyo literal es `2.5.8-beta.0`; esa diferencia de etiqueta respecto a package.json no demuestra la causa del fallo. Los SHA256 del provider desplegado, lock y dos archivos del SDK coinciden con main/paquetes locales revisados:

| Archivo | SHA256 |
| --- | --- |
| PixelPaySdkProvider.js de main | 53832067ab601f6d9e3140990734a0ee161664fbc98ef66e45439076a9fa485c |
| package-lock.json (LF) | 4ae1dd8068e471e56c88688200b619e6547ed1504e2f84ac305f03a9a23b7ea8 |
| SDK PayloadManager.js | f77ca1eb2e310e049e171e07638d83ef9fb8080a2a6dccff03b72cb3d3a75652 |
| SDK ServiceBehaviour.js | 23aaec943b2fe796d3a1f5e298b8b7d19848cb45c6a468c8e4d5df8b5c66a2ed |

Esto identifica esos archivos, no certifica el árbol completo de una imagen ni sustituye un SHA de despliegue. Docker confirmó running, StartedAt 05:02:16.047957834Z, RestartCount=0, OOMKilled=false y driver json-file. Una muestra de recursos indicó CPU 0%, 72.41 MiB / 7.756 GiB y 12 procesos; no demuestra el uso durante los incidentes.

Se releyó el intervalo 05:10:00–05:43:00 UTC mediante docker logs con filtro de conteo: cero coincidencias para `is not defined`, PayloadManager.js, CardinalManager.js, RouterManager.js o marcos ` at `. Los eventos históricos ReferenceError sí existen, pero no se recuperó su símbolo/stack original. La consola noVNC inicialmente alteró caracteres al pegar; esos comandos incompletos no aportan evidencia de red y se descartaron. Un intento truncado al hostname `pixel` produjo un error de resolución local de esa entrada incorrecta: no se cuenta como fallo DNS de pixelpay.app. Los comandos válidos fueron comprobados visualmente antes de tomar sus resultados.

## Correcciones demostradas durante la revisión independiente

La matriz ampliada detectó cuatro fallos iniciales: DNS y TLS quedaban bajo categorías genéricas, y se perdían cabeceras necesarias para distinguir el 403 WAF. Se añadieron listas cerradas de códigos DNS/TLS/transporte, MIME permitido y formato estricto del Ray. WAF solo se afirma cuando HTTP=403 y cf-mitigated=challenge; HTML por sí solo no basta.

Una prueba negativa adicional demostró que el catch podía reintroducir un cf-ray/content-type arbitrario después de que el interceptor lo descartara. `readSafeSaleHttpMetadata` aplica la misma lista permitida a las respuestas y errores Sale, incluyendo el fallback legacy. Un null saneado de una respuesta observada es definitivo. El error reenviado también conserva solo metadatos permitidos. La prueba falla antes y pasa después del arreglo; no se registran headers completos, mensajes originales, cuerpo, firmas ni payloads.

En una prueba existente se sustituye el fixture `safe-ray` por un Ray sintético con formato válido; otra prueba exige rechazar expresamente `safe-ray`. También se fija el UUID del fixture de privacidad para evitar coincidencias aleatorias con el centinela de CVV, manteniendo su aserción. La revisión mantuvo sin cambios Status, Void, callbacks, controles financieros, SQL, locks, permisos comerciales, dependencias y frontend. El nuevo diagnóstico no transforma un resultado incierto en fallo definitivo ni autoriza un segundo envío.

## Validación ampliada actual de PR 109

La revisión de GitHub confirmó main/base `1e2a15a7c6dcd64e26f6bc7da034efcb6bde2dbe` y el HEAD anterior `57cab1d32a1fd28021d5faca2383cef4327002c2`, abierto y fusionable. La actualización mantiene la misma rama y siete archivos: tres de producción, tres de pruebas y este informe. No cambia package.json, lock, Dockerfile, workflows, SQL, frontend, QA ni variables. El workflow versionado no despliega y sus triggers push/PR apuntan a dev y a una rama de hardening específica, no a esta rama/main.

Windows, Node 20.20.2 y dependencias exactas: matriz SDK real **32 PASS**, provider **122 PASS**, diagnósticos **5 PASS**; total focalizado **159 PASS / 0 FAIL / 0 SKIP**. Los casos añadidos incluyen hash inválido, importe incorrecto, DNS NXDOMAIN real por UDP local, TLS EPROTO real contra servidor local, 403 WAF/JSON/HTML sin challenge, cifrado de seis campos descifrados con clave efímera ficticia y headers maliciosos descartados. Todos los resultados incompletos siguen sin aprobación; no hay segunda Sale automática. La matriz bloquea red externa antes de importar SDK/Axios.

Regresión Windows final con `node --test --test-concurrency=4`: **3142 pruebas = 3127 PASS / 1 FAIL / 14 SKIP**, 193.805 s. El único fallo sigue siendo accountDeletionRemaining.test.js:197, ya reproducido en main intacto, descrito arriba. La ejecución previa dio 3125 PASS / 3 FAIL / 14 SKIP: además del fallo basal, Node contó el subtest y padre del falso positivo de `999` dentro de un UUID. Después de fijar el fixture, esos dos fallos desaparecieron. No se declara la suite global completamente verde. Se conservan ambos logs locales fuera del PR.

Lint completo: **0 errores / 25 advertencias preexistentes**. Lint de archivos tocados y diff-check: PASS. La suite completa inicia sus PostgreSQL efímeros cuando corresponde; no se usaron credenciales ni datos de Supabase. Los 62 casos financieros controlados anteriores se conservan como evidencia separada, no se vuelven a sumar a esta ejecución.

### Alpine local aislado

Sin Docker/WSL instalado disponible, se ejecutó una VM local efímera QEMU 11.1 TCG, kernel Alpine 6.18.22. Dentro se usó el userspace de la imagen oficial `library/node:20.20.2-alpine3.23`, linux/amd64, digest `sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb`, con capas verificadas. Se extrajo tooling portable en el workspace, sin instalar servicios Windows ni crear contenedores en el VPS. Esto prueba Linux/musl/ESM y el runtime de la imagen; no afirma equivalencia del kernel, namespaces o red Docker productivos.

Runtime local comprobado: Alpine 3.23.4, musl 1.2.5, Node 20.20.2, OpenSSL 3.0.19, SDK 2.5.8, Axios 1.20.0, Fastify 5.12.5, npm 10.8.2 y soporte SHA3-512. Las versiones coinciden con las observadas en el backend. `npm ci --ignore-scripts --no-audit --no-fund` instaló 209 paquetes y terminó exit 0 en Alpine. Una segunda instalación offline desde cache pública verificada también terminó exit 0. El lock Windows CRLF, normalizado a LF, tiene SHA256 idéntico al contenedor (4ae1dd8...). No se copiaron .env, credenciales ni datos de producción. Se retiró la ruta pública del guest antes de las pruebas; solo quedó loopback y el enlace local con el equipo para resultados.

Regresión de endpoints e idempotencia Alpine: **311 PASS / 0 FAIL / 0 SKIP**, 292 s. Archivos: microfase2a2-public-pagos-routes, membership-financial-security, membership-purchase-order-idempotency, pixelpay-sale-guard, pixelpay-webhook-signature y pixelpay-direct-provider. Son pruebas HTTP/fixtures locales e incluyen firma HMAC ficticia y protección de reenvío; no se presentan como carreras PostgreSQL reales ni como una validación bancaria.

La primera matriz Alpine dio 158 PASS / 1 FAIL (y 31 PASS / 1 FAIL sin crypto global): el único fallo era el fixture DNS con timeout de 500 ms. El servidor recibió exactamente una consulta, pero bajo TCG el resolver agotó ese límite. Se amplió solo ese límite local a 10000 ms, manteniendo `tries=1`, la exigencia de una consulta y ENOTFOUND auténtico. El caso aislado pasó con esas mismas aserciones (5.217 s); no se cambió ningún timeout del SDK ni de producción. Windows repitió la matriz ajustada con 32 PASS. Los fallos iniciales se conservan como evidencia, no se cuentan como aprobados.

Resultados finales Alpine: **159 PASS / 0 FAIL / 0 SKIP** en SDK/provider/diagnósticos (71.656 s), más **32 PASS / 0 FAIL / 0 SKIP** con `--no-experimental-global-webcrypto` (36.601 s). Sumados a los 311 casos de endpoints son 470 casos focalizados aprobados, con una repetición adicional de 32 casos sin crypto global; no son 502 escenarios distintos. Se reproduce el mismo `document is not defined` del SDK sin adaptador en ambos sistemas, y se contiene correctamente con el adaptador. No se encontró una incompatibilidad funcional adicional de Alpine en esta cobertura; no se certifica Live ni se atribuye el incidente original a una diferencia de sistema operativo.

Comandos de pruebas dentro del userspace Node de la VM local, tras npm ci y retirando egress público:

```sh
node --test --test-concurrency=1 test/pixelpay-sdk-node-runtime.test.mjs test/pixelpay-sdk-provider.test.mjs test/pixelpay-sale-runtime-diagnostics.test.mjs
node --no-experimental-global-webcrypto --test --test-concurrency=1 test/pixelpay-sdk-node-runtime.test.mjs
node --test --test-concurrency=1 test/microfase2a2-public-pagos-routes.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs test/pixelpay-sale-guard.test.mjs test/pixelpay-webhook-signature.test.mjs test/pixelpay-direct-provider.test.mjs
```

Logs conservados fuera del PR en tooling-alpine-qemu-20261114/results: alpine-runtime.log, alpine-sdk-final.tap, alpine-sdk-no-global-final.tap, alpine-endpoints.tap, alpine-final-exits.txt y los resultados iniciales. La suite general Windows corresponde a la misma implementación; después solo se estabilizaron fixtures (UUID/CVV y timeout DNS), verificados de nuevo en Windows y Alpine. Cero operaciones financieras externas durante toda la investigación.

## Borrador de consulta técnica PixelPay — NO ENVIADO

Asunto: MasterFade — dos Sales Live inciertas y contrato oficial Node.js 20 / SDK 2.5.8 / continuaciones

Hola, equipo PixelPay:

Investigamos dos intentos Live desde Node.js 20/Docker Alpine con SDK Core 2.5.8. El backend conservó ambos resultados como inciertos después de registrar ReferenceError. No repetimos cargos ni ejecutamos nuevas consultas financieras para este diagnóstico.

| Caso | Hora UTC | Hora Honduras | Importe | Referencias conocidas |
| --- | --- | --- | --- | --- |
| A | 14/11/2026 05:11 UTC | 13/11/2026 23:11 | HNL 1.00 | order_id confirmado: MF-PIXELPAY-24A2759ABC774E799A134AB82AE0D27F; intent interno 24a2759a-bc77-4e79-9a13-4ab82ae0d27f; request interno req-3t |
| B | 14/11/2026 05:40 UTC | 13/11/2026 23:40 | HNL 351.00 | intent interno c9765e3c-da31-47d7-b2e2-7d519efa6c19; attempt interno b7064c15-b000-4588-bdf7-6d523604a4e2; request interno req-c3; order_id exacto pendiente de recuperación, no inferido |

Los identificadores internos no se presentan como payment_uuid. No recuperamos una respuesta HTTP verificable del proveedor para esos incidentes. El HTTP 202 que MasterFade devolvió al cliente no demuestra un HTTP 202 original de PixelPay.

Trazas y estado financiero:

1. ¿Llegó cada orden/solicitud a sus sistemas? Solicitamos correlación por comercio, hora e importe y el identificador seguro disponible.
2. ¿Cuál es el estado financiero real de cada una: autorizada, capturada, rechazada, pendiente, revertida o sin registro?
3. ¿Cuál fue el HTTP original de respuesta de cada Sale y qué identificador de traza permite correlacionarlo?
4. Si hubo continuación, ¿cuál fue el transaction_type original (payload, songbird, router u otro)? Favor compartir esquema sanitizado y tipos de campos, sin datos sensibles.

Continuaciones y autenticación:

5. ¿Se inició un challenge 3DS en alguna? ¿Puede el proveedor exigir continuación aunque nuestra solicitud no use withAuthenticationRequest?
6. ¿Hubo router? ¿Representa la misma transacción y cómo garantiza su reanudación que no se cree un segundo cargo? ¿Qué destinos y condiciones de idempotencia están autorizados?
7. ¿Está oficialmente soportado SDK Core 2.5.8 con Node.js 20/Alpine para Sale? Su lib/version.js declara sdk_version=2.5.8-beta.0: ¿es la etiqueta esperada? ¿Existe una versión corregida o recomendada para estas respuestas sin DOM?
8. ¿Cuál es el procedimiento oficial backend para respuestas 202 y para recuperar resultado cuando no se devuelve payment_uuid? Necesitamos identidad estable, límites de reanudación y condiciones para mantener la operación pendiente.
9. Si debe intervenir frontend, ¿pueden compartir el flujo oficial completo y seguro —SDK cliente o Hosted Payment— con token/URL, expiración, orígenes, correlación y verificación backend, sin exponer secretos ni credenciales del comercio?

Cuenta y horario:

10. ¿Existió una ventana de mantenimiento o restricción nocturna aplicable a nuestra cuenta/adquirente en esos horarios? Favor distinguirla del cierre de lote y plazo de anulación.
11. ¿El adquirente exige autenticación adicional/3DS en Live para este comercio y bajo qué condiciones? ¿Es obligatoria, dinámica o configurable, y cuál es el flujo homologado?

Podemos aportar trazas sanitizadas y SHA desplegado. Solicitamos investigación de los intentos existentes; no autorizamos ejecutar o repetir operaciones por nuestra cuenta para responder estas consultas.

Gracias.
