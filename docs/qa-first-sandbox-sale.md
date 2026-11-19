# QA: preparacion de una primera Sale Sandbox, sin ejecutarla

## Alcance y bases

Backend dev: `577a6f5e6668b31514a28f2cc64b7857ed122e5b` (incluye #120).
Frontend dev: `b5428276d4113dacfc8eef3c3bed6b056d5b52b3` (incluye #101).
No se modifica main ni se habilitan operaciones en un entorno servido.

SSH desde la terminal de Codex ejecuto exclusivamente el wrapper autorizado
`sudo -n /usr/local/sbin/masterfade-qa-audit status`: backend y frontend tienen
una tarea deseada en ejecucion cada uno. Las tareas anteriores estan detenidas.
No acredita SHA servido, variables, esquema financiero, aprobacion ni trafico del
proveedor. No se solicitaron otros permisos ni se usaron Docker, sudo general o
logs sin una pregunta operacional concreta. Ausencia en logs filtrados no prueba
ausencia de una operacion.

## Permiso propuesto, apagado y no configurado

`QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED=false` por defecto. Es independiente del
permiso de reservas `QA_PRIVATE_COMMERCE_BOOKING_ENABLED` y nunca reemplaza la
autenticacion del handler. True solo es valido con reservas QA por identidad
habilitadas, un unico `QA_PRIVATE_COMMERCE_USER_ID` interno y estas precondiciones:

```dotenv
NODE_ENV=development
ENTORNO=qa
PAYMENT_PROVIDER=pixelpay
PIXELPAY_IMPLEMENTATION=sdk
PIXELPAY_ENV=sandbox
PIXELPAY_ENDPOINT=https://pixelpay.dev
PIXELPAY_APP_URL=https://pixelpay.dev
PRIVATE_COMMERCE_PILOT_ENABLED=false
QA_PRIVATE_COMMERCE_SALE_ENABLED=false
ENABLE_QA_PAYMENT_SIMULATION=false
ENABLE_QA_VIP_PURCHASE_SIMULATION=false
```

No introducir UUID operacionales en Git/CI/informes. La identidad se obtiene de
sesion activa, JWT verificado y claims de BD con cliente activo/rol cliente; no de
IP o headers. Solo se concede POST /v1/pagos/reservas/pixelpay/sale. El alias publico
Sale permanece bloqueado: su contrato por correo no sustituye la propiedad interna.
El handler autenticado conserva cliente/persona/usuario titular y creador del intent,
CSRF, limites de frecuencia y validaciones originales. VIP/admin/simuladores siguen
bloqueados. Elegibilidad devuelve pixelpaySale=true solo para la cuenta elegible
cuando el nuevo flag este habilitado. Frontend ya consume esta capacidad; no se
requiere una nueva variable Vite ni credenciales de comercio en React.

## Recorrido financiero y alcance de idempotencia

1. Reserva propia con hold vigente y contexto grupo/intent enlazado; servidor
   calcula servicios/items/monto HNL y orden estable a partir del UUID del intent.
2. El handler toma advisory lock por intent y locks de filas; exige link_generado.
   proteger_reserva_pago_v1 reclama el intent como pendiente_confirmacion y protege
   los holds. START del intento se guarda en la MISMA transaccion y se confirma
   antes de salir a la red. No se conserva tarjeta ni CVV en ese registro.
3. La unica Sale saliente usa orden, monto, moneda e items canonicos. HTTP 202,
   timeout, respuesta incompleta o error de transporte no autorizan confirmar ni
   continuar Cardinal. Nunca se reenvia automaticamente la Sale incierta.
4. Solo Sale aprobada/completa con identidad, hash y montos verificados persiste
   pixelpay.sale.approved_verified con intento correlacionado. El backend reutiliza
   payment_events.recibido_at textual para paid_at; captura/confirmacion son atomicas.
5. Los duplicados se resuelven localmente bajo locks. La recuperacion conserva el
   contrato #120 (propiedad/cuenta, proveedor, evento/attempt unicos, montos/moneda,
   orden, UUID/transaccion y tiempos exactos). Status incompleto o callback no
   autenticado nunca aportan por si solos la evidencia requerida.

El claim impide otro envio para el MISMO intent aun tras recarga, caida de proceso
o perdida de respuesta. Esto no acredita idempotencia remota de PixelPay ni limita
globalmente nuevos intents. La autorizacion operativa futura debe limitarse a una
operacion nueva: no generar otro intent para eludir incertidumbre o rechazo y
continuar cobrando. No modificar manualmente estados ni borrar START/evidencia.

## Basica y 3DS son puertas distintas

Existe ejemplo oficial Sandbox SDK sale-card (MCP page_id indicado en el informe
3DS) con setupSandbox, importe 1 HNL, tarjeta basica admitida, 12/28 y sin solicitud
3DS. Es evidencia documental para preparar un caso basico, no prueba remota.
No combinar sus datos con la tabla general contradictoria ni inventar CVV/fecha.
Una respuesta real podria exigir 3DS aunque el cliente no lo solicite: detenerse
en 202, conservar contexto y resolver por mecanismo de conciliacion admitido.

3DS React/Node sigue NO-GO: no hay handoff sin credenciales ni garantia del segundo
POST acreditados. SDK 2.5.10 ofrece hooks, no demuestra ese contrato. No se actualiza
SDK, no se amplia allowlist y no se implementan Hosted #111/#93. Hosted es una
alternativa oficial distinta para evaluar por separado, no reintento de la Sale.

## Puerta operativa para una unica prueba futura

1. Revisar PR, CI y contratos; autorizaciones separadas de merge/despliegue QA y
   configuracion. Verificar SHA servido y compatibilidad del esquema sin cambios
   manuales de datos. Mantener todas las protecciones comerciales restantes.
2. Corroborar el conjunto oficial de prueba y autorizacion explicita de UNA Sale
   Sandbox por importe 1 HNL para la cuenta interna; usar nuevo hold/intent vigente.
   Confirmar que la prueba no apunta a Live y que la orden/monto son del servidor.
3. Solo un operador autorizado habilitaria el nuevo flag. Verificar elegibilidad
   de la cuenta y rechazo de otra cuenta; una consulta de elegibilidad no cobra.
4. Ejecutar una sola vez tras autorizacion especifica de la transaccion, registrando
   unicamente IDs y codigos saneados en canal operativo privado. No capturar PAN,
   CVV, cookies, tokens, secretos ni el payload financiero completo.
5. Ante 202/timeout/red/perdida de contexto: no segundo clic, recarga con reenvio,
   nuevo intent ni retryTransaction. Conservar intent/START para consulta y
   recuperacion solo con evidencia durable admitida; si falta, revision manual.
6. Acreditar evento verificado, un pago capturado, una cita confirmada/hold consumido,
   paid_at exacto e idempotencia sin una nueva Sale. Solo entonces declarar E2E.
7. Rollback de permiso: nuevo flag false, conservar reservas por identidad,
   consultas/conciliacion, datos y evidencia. No borrar ni modificar pagos.

Ninguna de estas autorizaciones operativas fue concedida por este PR ni ejecutada.

## Verificacion y limites de evidencia

Pruebas sinteticas de permisos y rutas, provider/202/transporte/callbacks y frontend;
PostgreSQL 17 aislado para claim concurrente y contrato financiero v2. El test nuevo
ejecuta RPC/store reales con conexiones independientes; el adaptador financiero se
sustituye por contadores, no es un E2E del proveedor. Consultar resultados de CI y
el informe de entrega para conteos finales. No Supabase, datos personales reales,
pagos externos, cambios de variables operativas, merges ni despliegues.
