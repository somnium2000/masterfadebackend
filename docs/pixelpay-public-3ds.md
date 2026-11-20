# Continuación 3DS para reservas autenticadas y membresías VIP

El flujo está disponible como candidato **Sandbox por identidad**. La ruta con desafío puede
llegar al iframe. El envío financiero posterior al desafío se mantiene bloqueado hasta
verificar el contrato de PixelPay para esa transición. Las rutas públicas Live responden
antes de reclamar la Sale mientras esa integración esté incompleta. El modo privado de
prueba Live conserva su configuración y sus límites históricos.

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

## Evidencia de PixelPay pendiente

El SDK 2.5.8 espera pixelpay_continue del iframe antes del retryTransaction() de
la ruta con desafío. El identificador del lookup ya es visible en el navegador.
Falta un artefacto de finalización verificable en backend y vinculado al intento,
o confirmación explícita de que PixelPay verifica el desafío, rechaza un envío
prematuro y deduplica la continuación en la misma orden y contexto cifrado.
Tampoco se verificó que todas las respuestas finales para la cuenta incluyan la
evidencia requerida. Un test sintético no acredita el comportamiento remoto Live.

Referencias oficiales

- [Peticiones del SDK](https://docs.pixelpay.dev/page/sdk/requests)
- [Firma de seguridad](https://docs.pixelpay.dev/page/secure-signature)
