# QA: desbloquear el desafío Songbird con SDK 2.5.8

## Cambio y límite

Base backend `289b69e`, frontend `2332202`, ambas desde `dev`. El puente HTTP 202,
handoff cifrado de uso único y gestor Cardinal nativo ya están en esas bases.
Este parche elimina la comparación obligatoria entre
`Payload.OrderDetails.OrderNumber` y la orden del comercio. El SDK 2.5.8 entrega
el JWT inicial directamente a `Cardinal.setup('init', {jwt})`; no establece esa
igualdad. En `Cardinal.continue`, usa el `order_id` de la transacción original.

La orden enviada al lookup sigue siendo `context.order.id`. Se conserva la
comprobación del `order_id` superior si el JWT lo declara, estructura/algoritmo/
tiempo del JWT, orden/monto/moneda del contexto, propietario y reserva vigentes,
AES-GCM ligado a intent/intento/usuario/orden, lease única y fase durable.
El JWT inicial solo procede del callback interno de la Sale. Estas comprobaciones
no afirman verificar criptográficamente su firma: Cardinal y la continuación
server-side procesan la autenticación; ningún resultado permite confirmar pagos.

React conserva `CardinalManager.startCardinalTransaction` para setup, eventos,
modal e iframe; solo lookup/continue pasan por el backend. Su lista ACS ahora
coincide con los dos orígenes Sandbox permitidos por backend. `retryTransaction`
sigue siendo una respuesta local bloqueada: no ejecuta una segunda Sale.
HTTP 200 inicial, pagos históricos, SQL y producción no cambian.

Fuentes: paquete instalado `@pixelpay/sdk-core@2.5.8`,
`lib/libraries/CardinalManager.js` (`startCardinalTransaction`,
`validationLookupResponse`) y
[documentación JavaScript](https://docs.pixelpay.com/page/sdk/installation/javascript).
La documentación exige navegador para 3DS; no certifica por sí sola el adaptador
React/Node ni la futura segunda Sale. No se afirma validación bancaria real local.

## Despliegue en EasyPanel, solo QA

1. Revisar y fusionar los dos PR hacia `dev` después de CI. No fusionar a `main`.
   En EasyPanel seleccionar exclusivamente los servicios backend y frontend QA,
   repositorio correspondiente y rama `dev`. Anotar los SHA de ambos despliegues.
2. Mantener las credenciales Sandbox existentes exclusivamente en backend.
   No añadir credenciales, hash privado ni clave AES a variables `VITE_*`.
   Confirmar la configuración backend:

   ```dotenv
   NODE_ENV=development
   ENTORNO=qa
   PAYMENT_PROVIDER=pixelpay
   PIXELPAY_IMPLEMENTATION=sdk
   PIXELPAY_ENV=sandbox
   PIXELPAY_ENDPOINT=https://pixelpay.dev
   PIXELPAY_APP_URL=https://pixelpay.dev
   QA_PRIVATE_COMMERCE_BOOKING_ENABLED=true
   QA_PIXELPAY_SANDBOX_SESSION_ENABLED=true
   QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED=false
   QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED=true
   QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED=false
   QA_PRIVATE_COMMERCE_SALE_ENABLED=false
   PRIVATE_COMMERCE_PILOT_ENABLED=false
   ENABLE_QA_PAYMENT_SIMULATION=false
   ENABLE_QA_VIP_PURCHASE_SIMULATION=false
   ```

   Conservar `QA_PRIVATE_COMMERCE_USER_ID` de la cuenta interna autorizada y
   `QA_PIXELPAY_SONGBIRD_BRIDGE_KEY` existente (32 bytes base64). Configurar
   `QA_PIXELPAY_SANDBOX_SESSION_UNTIL` como UTC ISO con cierre futuro, máximo
   cuatro horas desde el arranque. El modo por sesión permite operaciones
   independientes; el procedimiento autoriza **solo una** Sale nueva.
3. Este parche no contiene ni aplica migraciones. El esquema del puente ya
   existente debe incluir `app_private.pixelpay_songbird_handoffs` y columnas
   `context_box`, `block_code`, `provider_http_status`. Si falta, detener antes
   de la Sale y reportar `SONGBIRD_SCHEMA_REQUIRED`; resolverlo por separado.
4. Desplegar backend QA primero. Después reconstruir y desplegar frontend QA
   con los build args `VITE_ENTORNO=qa`, `VITE_PAYMENT_PROVIDER=pixelpay`,
   `VITE_PIXELPAY_ENV=sandbox`, `VITE_APP_URL=https://qa.masterfadeapp.com`
   y la `VITE_API_URL` QA existente. Mantener simuladores/demo apagados.
   Las variables Vite requieren reconstrucción, no solo reinicio del contenedor.
5. Entrar con la cuenta interna en `https://qa.masterfadeapp.com`. La elegibilidad
   debe devolver booking, diagnóstico y puente habilitados. Crear reserva e
   intent **nuevos después del arranque**, L 1.00 HNL, usando el caso oficial
   Sandbox de desafío 3DS. No reutilizar intentos anteriores.

## Una Sale y observación SSH

Antes de pulsar pagar, abrir los logs del servicio backend QA por SSH. Si el
usuario SSH dispone de acceso Docker, seleccionar el nombre exacto del servicio
QA mostrado por EasyPanel y filtrar la salida antes de mostrarla:

```sh
QA_BACKEND_SERVICE='<nombre exacto del servicio backend QA>'
docker service logs --raw --since 10m --follow "$QA_BACKEND_SERVICE" 2>&1 |
  jq -Rc 'fromjson? | select(.event == "PIXELPAY_SONGBIRD_CAPTURE_DIAGNOSTIC" or .event == "pixelpay_songbird_phase" or .event == "PIXELPAY_SALE_HTTP_STARTED" or .event == "PIXELPAY_SALE_FAILED" or .event == "PIXELPAY_SALE_RESPONSE_RECEIVED") | {time,reqId,event,id_intent,paymentAttemptId,statusCode,safeMessageCode,action,state,provider_http_status,financial_finalization_enabled,bridge_capture_completed,validation_available,capture:(.capture | {accepted,stage,rule}),validation:(.validation | {accepted,stage,rule,flags:{order_matches:.flags.order_matches,jwt_order_number_matches:.flags.jwt_order_number_matches}})}'
```

Si el acceso SSH está limitado a un wrapper de auditoría, usar su salida filtrada
autorizada; no sustituirlo por permisos generales. No imprimir variables de
entorno, cuerpos HTTP ni objetos de error completos. No exportar HAR.

Secuencia esperada de esta única operación:

- Una sola `PIXELPAY_SALE_HTTP_STARTED`; respuesta real 202/songbird contenida
  antes de DOM en Node. El error comercial puede seguir siendo incierto: no es
  un rechazo definitivo ni permiso para volver a cobrar.
- `PIXELPAY_SONGBIRD_CAPTURE_DIAGNOSTIC`: `bridge_capture_completed=true`,
  `validation.accepted=true`, `validation.rule=VALID`, `order_matches=true`.
  `jwt_order_number_matches=false` es compatible con aceptación.
- Pulsar una vez **Iniciar autenticación 3DS**: fase `claim`, estado
  `browser_leased`. React carga Songbird Sandbox y llama setup con el JWT efímero.
- Fase `setup`: lookup HTTP 200 válido, estado `challenge_ready`. En React debe
  verse el desafío bancario en el iframe del modal nativo; SSH solo acredita
  el avance backend, no que el navegador lo haya mostrado.
- Si se completa, fase `validated` y respuesta HTTP real de continue. Incluso
  con HTTP 200/success el cierre sigue bloqueado con
  `PIXELPAY_SONGBIRD_AUTH_RESULT_UNACCREDITED`. No debe existir segunda Sale,
  pago aprobado ni cita confirmada por el resultado de Cardinal.

Si llega `collection_url`, otro origen ACS, error de transporte o rechazo, detener
ese intento y conservar únicamente indicadores seguros. La variante direct API
con collection_url sigue bloqueada; no se amplían destinos ni se reintenta Sale.
Al terminar la única observación, apagar `QA_PIXELPAY_SANDBOX_SESSION_ENABLED` y
`QA_PIXELPAY_SONGBIRD_BRIDGE_ENABLED` en QA. No cambiar producción.

## Validación focalizada

Backend: contratos de contexto/captura, telemetría, bridge, cadena nativa y
runtime HTTP 200/202. Frontend: sesión/panel, iframe nativo en DOM y destinos
Sandbox. Los dobles y loopback locales no prueban un desafío remoto.
El resultado bancario real queda pendiente del despliegue y la única Sale QA.
