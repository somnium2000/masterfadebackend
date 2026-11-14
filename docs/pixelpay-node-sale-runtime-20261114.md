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

Los interceptores de la instancia Axios creada por el SDK registran únicamente la fase y status. Un GET exitoso de `merchant/public_key` no se confunde con respuesta de Sale. La excepción original deja de transformarse internamente en un `FailureResponse` 520 que perdía nombre y stack. El provider conserva incertidumbre ante una Sale posiblemente enviada y mantiene el código público existente por compatibilidad; el diagnóstico interno distingue `SDK_REFERENCE_ERROR`, `SDK_RUNTIME_ERROR`, `SDK_NETWORK_ERROR`, `SDK_HTTP_TIMEOUT`, `SDK_UPSTREAM_ERROR`, `SDK_RESPONSE_PARSE_ERROR`, `SDK_BROWSER_ACTION_REQUIRED` y `SDK_CONTINUATION_REQUIRED`.

El procesamiento financiero posterior también queda dentro del manejo de errores inciertos. Una respuesta HTTP 200 aislada no basta: se conservan las verificaciones de resultado completo, hash, UUID, transacción e importes. No se modifica el contrato canónico de `paid_at`, la evidencia durable ni los endpoints de recuperación.

Los logs nuevos usan exclusivamente fases permitidas, booleanos, nombres de excepción conocidos y archivos relativos del SDK con línea/columna. `sdkTransactionType` solo admite `payload`, `songbird`, `router` o null; no se decodifica el payload. No incluyen mensajes arbitrarios, stacks completos, PAN/CVV, payloads, credenciales o firmas. Se corrige además la etiqueta de ambiente en telemetría: procede del provider configurado y no queda fijada en sandbox. Los códigos nuevos se observan en logs; la allowlist existente de persistencia puede descartarlos a null. No se cambia esquema ni historial financiero.

## Límite de 3D Secure

La [instalación oficial JavaScript/TypeScript](https://docs.pixelpay.com/page/sdk/installation/javascript) y el [contrato de solicitudes del SDK](https://docs.pixelpay.com/page/sdk/requests) distinguen las operaciones backend de `withAuthenticationRequest`, que requiere un entorno de cliente compatible para la interacción de autenticación. Un backend Node no puede resolver por sí mismo un challenge del banco.

Una respuesta 202 o que requiera autenticación DOM permanece incompleta/incierta y requiere conciliación; no activa reserva, suscripción ni beneficios. No debe fabricarse `window` o `document` para aparentar que se completó el challenge, omitir la autenticación ni reintentar Sale automáticamente. Resolver la interacción 3DS requiere un flujo oficial de frontend/plataforma y una autorización separada.

Las horas de las capturas solo correlacionan eventos. No demuestran una ventana horaria, mantenimiento o regla temporal del SDK; no se introduce una restricción por hora ni un cambio de zona horaria.

La revisión del historial de soporte aportado el 14/11 no aporta una respuesta 202 de Sale ni un contrato Node/3DS/router. Sus ejemplos 202 pertenecen a la API de recuperación MasterFade y sus aprobaciones Sandbox documentadas son HTTP 200. La hora 22:00 citada por soporte corresponde al cierre de lote para anular, no a una prohibición de vender. El historial tampoco permite atribuir el ReferenceError actual al antiguo WAF 403 o al simulador Sandbox L8/412.

`RouterManager` no usa DOM: crea otra Transaction y ejecuta otro POST con configuración de su payload. Eso no demuestra por sí mismo un segundo cargo; podría ser una continuación legítima. Este parche no la ejecuta y puede impedir completar un flujo que la requiera. Su habilitación requiere contrato confirmado de endpoints, identidad e idempotencia con PixelPay. No se presenta esta contención como una solución completa de ventas Live que dependan de 202.

## Validación local final

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

Tras precisar la clasificación 202, la ejecución focalizada final pasó 149/149. La primera repetición tuvo un falso positivo en el test existente `pixelpay-sdk-provider.test.mjs:805`: su regex de CVV `999` coincidió con esos dígitos dentro del UUID aleatorio de paymentAttemptId. No había un campo CVV en la salida. Se conserva el registro del fallo y no se modifica esa prueba ajena al ajuste. Las 62 pruebas financieras PostgreSQL corresponden al commit inicial `7bc7d29`; desde esa ejecución solo cambia clasificación/telemetría 202 y sus pruebas, no autorización ni persistencia financiera.

Node portable oficial: [v20.20.2](https://nodejs.org/dist/latest-v20.x/node-v20.20.2-win-x64.zip), SHA256 verificado contra SHASUMS256.txt: `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`.

## Pendientes antes de cualquier validación Live

- Obtener confirmación del proveedor de que los intentos históricos no generaron cargos; no reintentarlos.
- Mantener separados el merge, el despliegue manual y una validación Live expresamente autorizada. Este trabajo no realiza ninguno de ellos.
- Si el incidente Live reaparece, usar los nuevos códigos y la ubicación SDK saneada para identificar su origen. La causa exacta de los dos registros históricos continúa sin demostrarse.

No se ha validado un challenge real ni una nueva operación Live. Antes de abrir compras, confirmar con PixelPay el contrato del flujo interactivo requerido para el comercio. No hay una corrección oficial posterior verificada que complete ese flujo en Node.
