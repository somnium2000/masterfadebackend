# Continuación 3DS para reservas autenticadas y membresías VIP

El flujo está disponible como candidato **Sandbox por identidad**. La ruta con desafío puede
llegar al iframe. El envío financiero posterior al desafío se mantiene bloqueado hasta
verificar el contrato de PixelPay para esa transición. El backend devuelve **HTTP 503
`PIXELPAY_PUBLIC_3DS_UNAVAILABLE` antes del claim o de la Sale para reservas y VIP
admitidos públicamente en Live, incluso con `PIXELPAY_PUBLIC_3DS_ENABLED=false`**.
Poner esa bandera en `true` en Live tampoco abre el checkout. El candidato solo
admite su activación en el perfil QA Sandbox. El modo privado de prueba Live
conserva su configuración y sus límites históricos.

## Contrato

1. El navegador comprueba que puede cargar el SDK 2.5.8 y anuncia
   supports_public_3ds en la petición de pago. El servidor conserva el claim durable,
   los datos canónicos de la operación, la firma y el contexto cifrado de la Sale.
2. Una Sale con respuesta final verificable sigue la conciliación correspondiente. Un
   202 con datos compatibles de colección genera public_3ds_handoff tras registrar el
   202 local. El navegador mantiene ese handoff en memoria y usa el SDK nativo.
3. La continuación POST se vincula a sesión, CSRF, titular, intento, orden y token
   vigente. El worker acepta lookup una vez. Solo su SuccessResponse 200 con success
   verdadero, sin action y con identificador válido habilita un único retryTransaction()
   sobre el contexto original. Un lookup que pide desafío permite abrir el iframe y
   mantiene bloqueado el envío financiero. El navegador no aporta la decisión financiera.
4. El resultado final debe acreditar aprobación, importes, hash, orden, moneda e
   identificadores coherentes en la respuesta del proveedor. Los dos flujos usan sus
   conciliadores existentes. Si la respuesta omite evidencia obligatoria, el intento
   permanece pendiente. Este worker no consulta Status para completar evidencia faltante.

La API de reservas usa POST /v1/pagos/reservas/pixelpay/3ds/continuar. VIP usa
POST /v1/cliente/planes/pixelpay/3ds/continuar. El frontend lee pixelpayPublic3ds
y pixelpayPublic3dsRequired en la elegibilidad existente.

## Variables del candidato Sandbox

| Servicio | Variable | Valor / uso |
| --- | --- | --- |
| Backend | PIXELPAY_PUBLIC_3DS_ENABLED | false de forma predeterminada. true solo en el backend QA con el perfil de abajo. |
| Backend | NODE_ENV / ENTORNO | development / qa |
| Backend | PAYMENT_PROVIDER / PIXELPAY_IMPLEMENTATION / PIXELPAY_ENV | pixelpay / sdk / sandbox |
| Backend | PIXELPAY_ENDPOINT / PIXELPAY_APP_URL | https://pixelpay.dev para ambos |
| Backend | PIXELPAY_KEY_ID / PIXELPAY_SECRET_KEY / PIXELPAY_AUTH_HASH | Credenciales Sandbox ya autorizadas de esa cuenta, solo en backend. |
| Backend | QA_PRIVATE_COMMERCE_BOOKING_ENABLED / QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED | true / true |
| Backend | QA_PRIVATE_COMMERCE_USER_ID | UUID interno de la cuenta QA autorizada. |
| Backend | PUBLIC_VIP_PURCHASE_ENABLED | true solo para incluir VIP del usuario QA autorizado. Reservas usa su permiso QA por identidad. |
| Backend | PRIVATE_COMMERCE_PILOT_ENABLED / QA_PRIVATE_COMMERCE_SALE_ENABLED / PIXELPAY_LIVE_3DS_TEST_ENABLED | false para este perfil. |
| Backend | QA_PIXELPAY_DELEGATED_ENABLED / QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED / QA_PIXELPAY_SANDBOX_SESSION_ENABLED | false para este perfil. |
| Backend | ENABLE_QA_PAYMENT_SIMULATION / ENABLE_QA_VIP_PURCHASE_SIMULATION | false / false |
| Frontend | VITE_ENTORNO / VITE_PAYMENT_PROVIDER / VITE_PIXELPAY_ENV | qa / pixelpay / sandbox |
| Frontend | VITE_APP_URL | https://qa.masterfadeapp.com |
| Frontend | VITE_VIP_MEMBERSHIPS_ENABLED / VITE_VIP_MEMBERSHIPS_PURCHASE_ENABLED | Mantener el catálogo VIP y la compra QA habilitados cuando se valide el checkout VIP. |

La continuación no agrega una variable Vite. La única bandera nueva de activación está
en backend. Las funciones y protecciones se apoyan en tablas de intentos y eventos
existentes. No hay DDL nuevo.

## Despliegue y comprobación posterior en QA

1. Con aprobación de despliegue, desplegar el backend con la bandera nueva apagada.
   Publicar el frontend compatible y comprobar ambos SHA servidos. Activar el perfil
   anterior solo en QA y verificar en la sesión autorizada la respuesta de elegibilidad.
   Si el frontend anterior no anuncia compatibilidad, el backend candidato rechaza la
   Sale antes de reclamarla. Verificar también que una cuenta distinta sigue denegada.
2. Para el candidato, operar con **una réplica QA**. El contexto vivo reside en el worker
   del proceso que recibió la Sale. Una réplica distinta, reinicio, worker perdido, cierre
   o vencimiento deja el intento pendiente. La app vuelve a leer el estado local. Ninguna
   de esas condiciones habilita una nueva Sale o reinicia el desafío.
3. Para una futura prueba Sandbox autorizada, usar una reserva u orden VIP nueva del
   titular y un caso oficial que corresponda a la modalidad. En Network verificar la
   carga del SDK, la única Sale inicial, el 202 con handoff y el lookup. Si el emisor
   solicita desafío, verificar el iframe y sus orígenes. El cierre del desafío actual
   no completa el cobro y debe dejar el intento pendiente. Evitar capturar cuerpos,
   tarjetas, cookies, JWT, tokens o URL completas.
4. En un caso directo o sin desafío que devuelva evidencia íntegra, comprobar localmente
   un único pago. Para reserva, corroborar una confirmación del grupo. Para VIP,
   corroborar una orden pagada, una activación y una sola relación con el pago.
   Comprobar que recargar muestra el estado local, sin despachar otra operación.
5. Al revertir, apagar PIXELPAY_PUBLIC_3DS_ENABLED en QA y conservar los claims y
   marcadores. Revisar los intentos pendientes mediante conciliación local. Si se
   retira este backend, mantener cerradas las admisiones públicas Live durante el
   rollback para evitar volver a ofrecer un checkout que se detiene en 202.

## Evidencia de la continuación en SDK 2.5.8

1. En Direct API, `CardinalManager.handleDirectApiLookup()` ejecuta el lookup y
   toma `lookup_response.data.identifier`. `validationLookupResponse()` lo copia
   a `transaction.authentication_identifier`. Con `action=continue`, el SDK
   envía `continue_payload` como campo `JWT` de un formulario POST a
   `continue_url`, con `MD` opcional cuando existe valor. Ese JWT inicia StepUp.
2. El listener nativo acepta el mensaje `pixelpay_continue` del endpoint de PixelPay.
   `handleDirectApiContinue()` lee `event.data.error` e `event.data.identifier`,
   rechaza un error o un identificador ausente, y copia el identificador del mensaje
   a `manager.identifier`. El adaptador de MasterFade además exige el origen esperado
   y la ventana del iframe de StepUp. Eso protege la interfaz del navegador.
3. El handler Direct API llama a `retryTransaction(this.transaction)` y esta
   instancia conserva `authentication_identifier` del **lookup**. El identificador
   del mensaje no se copia al modelo de Sale. El SDK realiza `doBeforeExecute()`
   y repite `POST api/v2/transaction/sale` con el modelo original, la orden,
   el contexto de cifrado y los encabezados del comercio. El mensaje de StepUp
   no se envía en el POST. En el adaptador actual, React solicita la operación
   `retry` con `data: {}` y el worker conserva la instancia original.
4. En el flujo Songbird sin Direct API, `payments.validated` puede entregar un JWT
   a `authenticationContinue()` con `identifier` y `payload`. Esa ruta no
   acredita que Direct API deba llamar al mismo método ni que su respuesta confirme
   un pago.

La firma de la solicitud y el token del handoff vinculan la operación local a la
orden y al titular. El mensaje de StepUp es una señal del navegador y la información
observada hasta ahora no acredita cómo verificarla desde el servidor. El
`runningTransaction` del SDK y el claim de MasterFade contienen duplicados locales.
La idempotencia remota, el cierre de la autenticación y la confirmación financiera
requieren evidencia independiente. MasterFade solo concilia desde una respuesta
financiera del proveedor con resultado aprobado, importe, moneda, orden,
identificadores y hash o firma válidos. El hash del SDK vincula la orden al comercio
y no autentica por sí solo el resultado del desafío.

En el ticket de soporte #9834, PixelPay indicó que el backend ejecuta la
continuación financiera después de completar el desafío y debe conservar
`order_id` durante todo el ciclo. También confirmó que el `payment_uuid` de
un 202 pendiente de 3DS aún no es consultable con `getStatus()`. La confirmación
de que los 202 históricos consultados no generaron cargos corresponde a esos
intentos concretos. El ticket no define un verificador server-to-server de StepUp,
el resultado de un retry prematuro ni la deduplicación de esa continuación.

### Preguntas para PixelPay

1. **Autenticación.** Para un `authenticationLookup()` que devuelve
   `action=continue`, ¿qué evidencia puede verificar un backend antes de invocar
   `retryTransaction()`? Indicar método y endpoint, campos de entrada, respuesta
   de autenticación completada y, si existe un comprobante firmado, emisor,
   audiencia, claves de verificación, vigencia y correlación. ¿Es
   `pixelpay_continue.identifier` el mismo dato que `data.identifier` del
   lookup? Si difieren, ¿cuál debe ir en `authentication_identifier`?
2. **Validación de la continuación.** Si el POST con el identificador del lookup
   es la interfaz soportada, ¿PixelPay verifica en el servidor que StepUp completó
   con éxito para el mismo comercio, entorno, `order_id`, importe, moneda y
   contexto de Sale original antes de cobrar? ¿Qué HTTP, clase de respuesta y campos
   distinguen pendiente, rechazo, cancelación y expiración, sin cargo? ¿Qué papel
   cumplen `data.transaction_id` del lookup y `payment_uuid` de la Sale inicial?
3. **Duplicados y resultado incierto.** ¿Cuál es la clave de idempotencia remota y su
   vigencia para el POST de continuación? Precisar uso de `order_id`,
   `authentication_identifier`, `payment_uuid` o un encabezado dedicado. ¿Qué
   responde si se repite en paralelo o después de un timeout que pudo haber
   capturado? Indicar a partir de qué evidencia ya es válido consultar Status y con
   cuál UUID, o qué evento firmado permite recuperar el desenlace.
4. **Resultado financiero.** Compartir ejemplos sanitizados de aprobación y
   rechazo con la clase HTTP y los campos finales `response_approved`,
   `response_incomplete`, `response_code`, `order_id`, monedas, importes,
   `payment_uuid`, `transaction_id` y `payment_hash`. ¿Qué identificadores
   deben coincidir con la Sale inicial y cuáles pertenecen solo al lookup 3DS?
   Si faltan campos de correlación, ¿qué fuente autenticada los acredita una vez
   cerrada la autenticación?

Estas preguntas se refieren al contrato del comercio y del SDK actual. La
documentación consultada no permitió acreditar esa transición. La posibilidad de
que PixelPay ofrezca una garantía o una interfaz adicional sigue abierta.

Fuentes revisadas

- Código instalado de `@pixelpay/sdk-core@2.5.8`. Incluye `CardinalManager.js`,
  `CardinalAuthentication.js`, `PaymentTransaction.js` y `ServiceBehaviour.js`.
- [Peticiones del SDK](https://docs.pixelpay.com/page/sdk/requests?locale=en)
- [Firma de seguridad](https://docs.pixelpay.dev/page/secure-signature)
- [Guía previa de MasterFade y registro del ticket #9834](qa-pixelpay-public-flow.md)

## Requisitos pendientes para admitir Live

Implementar y probar la admisión Live explícita por flujo para reservas y VIP una
vez acreditada la transición. Debe conservar login, titularidad, CSRF, claim
previo, resultado financiero verificable y confirmación única. Probar al menos
StepUp válido, señal prematura o alterada, callback duplicado y respuesta perdida
tras el despacho. Validar ambos recorridos con los controles del comercio Live.

El candidato usa el menor plazo entre la protección del intento y 120 segundos.
Una vez vencido, el token pierde acceso al contexto y la operación queda pendiente
con el claim durable. Reiniciar el backend, perder el worker o caer en otra réplica
produce la misma respuesta conservadora. El contexto queda en memoria y una
repetición desde otra réplica no reconstruye los datos de tarjeta ni abre otra Sale.
Para desplegar Live se debe acreditar y probar el enrutamiento hacia la réplica
propietaria, incluidos los casos de despliegue y caída, o una reanudación respaldada
por PixelPay que no requiera conservar PAN/CVV. Mientras no exista esa solución,
el flujo de QA se valida con una sola réplica y recuperación local.

## Alcance de las pruebas del navegador

- El workflow de release del frontend para PR hacia `main` ejecuta
  `node scripts/pixelpay-delegated-browser-bundle.mjs`. El script compila su entrada
  parcial con Vite y `configFile: false`. Usa handoffs Sandbox sintéticos y JSDOM.
  Es independiente del build Live de la aplicación, de las credenciales
  y de un backend. Comprueba el SDK empaquetado, montaje del iframe, origen y
  ventana, duplicados, cancelación, expiración e identificador serializado.
- La prueba opt-in `React -> loopback HTTP` de `delegatedPixelPay.test.jsx`
  requiere `PIXELPAY_PROTOTYPE_BACKEND` apuntando al worktree backend. Se ejecutó
  **localmente** con Fastify en `127.0.0.1`, workers y SDK Node reales, transporte
  PixelPay sintético y credenciales ficticias. Comprueba el prototipo Songbird,
  el rechazo del token de otro intento, un inicio pese a doble clic, las fases
  `start → lookup → continue → retry → status` y evidencia de aprobación del
  fixture sin confirmar una reserva. No usa rutas públicas de MasterFade ni
  acredita Direct API, compra VIP o certificación Live. El workflow de release
  no define esa variable y omite ese caso.
