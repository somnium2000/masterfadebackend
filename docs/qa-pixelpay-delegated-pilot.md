# Piloto QA de continuación PixelPay

El checkout autenticado puede continuar un HTTP 202 `songbird` sin `collection_url` con SDK 2.5.8. La Sale inicial sigue en Node y conserva la construcción de petición actual. El objeto separado en el navegador llama a `withAuthenticationRequest()`. La petición Node no recibe ese objeto y conserva su comportamiento actual. Esto acredita la continuación de un 202 recibido. Exigir 3DS en todas las Sales sigue fuera del alcance de este piloto. Si el SDK rechaza una petición explícita, el flujo no la transforma para volver a enviarla.

## Autorización y recuperación

- El backend devuelve el permiso del piloto únicamente en los datos del intento exacto y para la cuenta QA autorizada. La ruta autenticada `/v1/pagos/reservas/pixelpay/3ds/delegated` hereda sesión, autorización, CSRF y allowlist de QA. La capacidad efímera liga worker, grupo, usuario e intento. El backend revalida esos datos y el importe canónico antes de cada operación.
- El claim, el marcador de origen y el ID de intento se guardan antes de que el worker reciba la petición. Tras recarga, caducidad o reinicio, el backend conserva esa reclamación y utiliza el estado existente. Para cualquier otro tipo de 202, se deja pendiente la confirmación y se conserva el UUID observado si está disponible. El worker de aplicación y el servidor de escritorio son entradas separadas.
- La continuación usa imports internos `CardinalManager`, `CardinalAuthentication`, `LookupTransaction` y `LookupContinueTransaction`. Sus métodos nativos conservan el desafío y el contexto criptográfico. Un worker dedicado a un intento aísla el estático `runningTransaction`. Un duplicado no repite la operación. Si el lookup exige desafío, el piloto requiere que se haya llamado a continue para despachar retry. El resultado financiero se evalúa de forma independiente del éxito de continue.
- El UUID obtenido de un 202 permanece como candidato para Status. Si el worker se pierde, Status puede observar ese candidato durante la ventana QA. Sólo la evidencia durable de una Sale verificada permite conciliar. Después de que cierra la ventana, la misma cuenta puede recuperar evidencia ya persistida mientras se mantenga configurado el piloto.

## Evidencia financiera y plazos

El backend reutiliza la clasificación de Sale, los controles de UUID, transacción, hash e importes y la conciliación de reserva existente. Para precisar orden y moneda, compara únicamente valores recibidos del proveedor. Un resultado de Sale positivo con identidad incompleta puede corroborarse con Status obtenido por Node, siempre que coincidan orden, UUID, transacción, moneda e importes. Una contradicción conserva la incertidumbre.

En Status anidado, el estado procede de `response.data.status`. Los campos financieros y el resultado de la transacción proceden de `response.data.last_response.data`. Para orden, moneda y UUID se aceptan los campos explícitos en el resultado anidado o el envelope exterior cuando existen y coinciden entre sí y con el intento. Los valores esperados sirven para comparar. La muestra pública de [Status con SDK JavaScript](https://docs.pixelpay.com/use-case?case=sdk%2Fstatus%2Fstatus&lang=javascript&locale=es) no publica un envelope completo del comercio. Las ubicaciones observadas en Sandbox deben poder comprobarse mediante evidencia de forma saneada. Si un dato necesario falta o discrepa, se conserva el intento para conciliación. Status por sí solo no acredita una Sale.

El timeout HTTP por llamada del SDK permanece en 60 s. El servidor de QA utiliza el vencimiento absoluto más temprano entre la protección persistida de la reserva y el cierre del piloto. React usa el mismo vencimiento durante el desafío. Los 15 s, 120 s y 60 s del prototipo siguen limitando el ensamble de escritorio solamente. Los plazos de la aplicación provienen de la reclamación y de la ventana operativa, no del banco. Un proxy puede cortar el HTTP anterior a esos plazos. Si sucede, se recupera el intento pendiente. El estado uncertain no autoriza a repetir la Sale.

## Variables para el ensayo

Configurar los valores de cuenta y credenciales mediante la configuración existente del backend QA.

```dotenv
ENTORNO=qa
NODE_ENV=development
PAYMENT_PROVIDER=pixelpay
PIXELPAY_IMPLEMENTATION=sdk
PIXELPAY_ENV=sandbox
PIXELPAY_ENDPOINT=https://pixelpay.dev
PIXELPAY_APP_URL=https://pixelpay.dev
QA_PRIVATE_COMMERCE_BOOKING_ENABLED=true
QA_PRIVATE_COMMERCE_USER_ID=<uuid del cliente QA autorizado>
QA_PIXELPAY_DELEGATED_ENABLED=true
QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED=true
QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID=<uuid del intento nuevo de HNL 1.00>
QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL=<instantánea UTC hasta diez minutos desde arranque>
```

Las credenciales `PIXELPAY_KEY_ID`, `PIXELPAY_SECRET_KEY` y `PIXELPAY_AUTH_HASH` pertenecen al backend. Los flags de sesión Sandbox multiintento, Sale legada, piloto legado y simuladores deben estar desactivados según los validadores existentes. Frontend utiliza `VITE_ENTORNO=qa`, `VITE_PAYMENT_PROVIDER=pixelpay` y `VITE_PIXELPAY_ENV=sandbox`. La selección exacta del intento llega del backend. El commit del PR #143 aporta las tarjetas oficiales, incluido el caso 2.9.

## Ensayo único después de revisión y despliegue QA

1. Verificar CI, fusionar los PR revisados hacia `dev` y desplegar los artefactos QA. Confirmar SHA backend, build frontend servido, sus variables QA y API de destino. Confirmar que la política del sitio permite cargar el script del SDK y los iframes del desafío sin ampliar de forma global la política. Preparar un intento de HNL 1.00 nuevo para el cliente permitido y verificar que no tenga intentos anteriores.
2. Configurar el UUID y una ventana UTC vigente antes de abrir el checkout autenticado. Verificar que se muestra capacidad de pagar para ese intento. En Network observar sólo ruta, estado y tiempos. Por SSH utilizar registros saneados del backend y observar `pixelpay_qa_delegated_phase` correlacionando el intento. Evitar exportar cuerpos, tarjetas, tokens o un HAR con datos sensibles.
3. Ejecutar una sola Sale del caso oficial 2.9. Esperar en orden Sale inicial, 202 `songbird`, presentación del desafío por el SDK y, según el flujo, lookup, continue, retry y consulta de estado. El POST al proveedor realizado por retry pertenece a la misma operación. Si llega 200 sin desafío, registrar esa variante por separado. Si llega otro tipo de 202, se vence el contexto o hay cualquier resultado incierto, consultar el intento existente y detener el ensayo sin repetir el envío.
4. Comprobar que el backend registra una única evidencia verificada, que el pago queda capturado con `paid_at` durable y que sólo entonces se confirma la reserva. Si falta un campo necesario en Status, conservar únicamente qué campos estaban presentes y en qué nivel del envelope. Tras el ensayo cerrar la ventana. Mantener el acceso a recuperación DB del intento hasta resolver pendientes y desactivar el flag cuando concluya la revisión.

Las pruebas focalizadas están en `test/pixelpay-delegated.test.mjs`, `test/microfase2a2-public-pagos-routes.test.mjs`, `test/private-commerce.test.mjs` y `test/pixelpay-sdk-provider.test.mjs`. La prueba HTTP conjunta del frontend usa `PIXELPAY_PROTOTYPE_BACKEND` y el servidor de escritorio. El SDK es real y el desafío y transporte al proveedor son simulados. PostgreSQL se verifica en el workflow existente.
