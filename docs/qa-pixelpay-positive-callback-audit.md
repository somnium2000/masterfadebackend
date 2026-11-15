# QA PixelPay: aprobacion basica y cierre operacional del callback

## Evidencia existente, consultada exclusivamente en lectura

Base backend dev: `ed7bd71c03b9569958f4e77aad1f20916d7b0dad`.
Las consultas se limitaron al proyecto QA, a columnas de esquema y al intent
indicado por el propietario. Se usaron transacciones READ ONLY; no se consultaron
tarjetas, secretos ni datos personales. No se ejecutaron nuevas consultas Status
al proveedor, Sales, Void, reembolsos ni llamadas Live.

La operacion auditada conserva un intent confirmado, una Sale aprobada, un pago
capturado de 1.00 HNL, una cita confirmada y un hold consumido. Identidad de pago,
monto, moneda y paid_at concuerdan. Fecha financiera exacta:
`2026-11-15 06:11:41.750134 UTC`.

| Evidencia | Resultado existente |
| --- | --- |
| Evento Sale approved_verified | Uno, firma_valida=true, UUID/transaccion/monto/moneda coinciden |
| Recibo order_callback.received | Uno, firma_valida=false, status_incierto_pendiente |
| Recibido_at del callback | 2026-11-15 06:11:41.939269 UTC |
| Status automatico ya registrado | 2026-11-15 06:11:42.496 UTC, HTTP 200, COMPLETED, respuesta_invalida, 175 ms, sin error_code |
| Procesado_at del recibo | 2026-11-15 06:11:42.520778 UTC |

El payload saneado del recibo guarda referencias financieras internas coincidentes,
pero callback_uuid_matches y callback_transaction_id_matches son false. Esos campos
auxiliares entrantes no se usan como autoridad financiera ni como referencias de
la consulta Status. Su discrepancia no demuestra por si sola la causa del rechazo.
No se publican sus valores originales.

El resultado prueba que Status retorno una respuesta HTTP satisfactoria con estado
COMPLETED, pero al menos una condicion financiera del adaptador/callback no paso.
La BD no conserva todos esos booleanos. Una consulta al wrapper autorizado de logs
QA no encontro pixelPayCallbackStatusValidation; los logs son filtrados. La condicion
exacta fallida permanece NO DEMOSTRADA. No fue un 202, timeout o Status 412 en esta
operacion. Tampoco se infiere que no hubiera actividad por ausencia en esos logs.

## Causa reproducida y diferencia entre evidencias

El callback anterior siempre consultaba Status tras encontrar una Sale correlacionada,
sin comprobar si el pago ya estaba capturado y la cita confirmada. Un Status que no
cumpliera todas las condiciones producia un pendiente operacional, aun con finanzas
completadas. La prueba sintetica roja reprodujo un Status adicional y ese pendiente.
No existe un worker autonomo que resuelva esos codigos: un duplicado solo puede
reintentar Status despues del cooldown, dejando posibles pendientes indefinidos.

La primera consulta del callback real pudo ocurrir antes o despues del COMMIT de
confirmacion: recibido_at es un timestamp transaccional, no una prueba del orden de
commits. No se inventa esa secuencia. El cierre debe cubrir ambos ordenes de llegada.

firma_valida=false en el recibo es intencional. El hash de orden no autentica todos
los campos del cuerpo. Ese recibo no equivale al evento Sale aprobado/verificado y
no debe promoverse a tal. Un HTTP 200, COMPLETED, redirect, OTP o callback sin prueba
financiera suficiente no autoriza una captura ni confirmacion.

## Correccion focalizada

Se cierra solamente el bookkeeping de un recibo existente al probar localmente la
operacion completada y su correlacion durable. Se conserva el cuerpo original y su
firma false; el resultado terminal distingue cierre por evidencia local de cualquier
verificacion del callback. No se inserta otro pago ni se confirma de nuevo la cita.

El receptor comprueba el cierre antes y despues de Status/error. Los escritores
tardios no reabren un recibo terminal. El camino financiero invoca el cierre tambien
despues de COMMIT, tanto para confirmacion nueva como duplicada, cubriendo callbacks
tempranos. Es best-effort: un fallo de bookkeeping o del logger no cambia una respuesta
financiera ya confirmada ni genera un nuevo cobro. No se adquiere un lock financiero
desde el callback ni se llama una RPC de conciliacion con el intent ya bloqueado.

Si falta prueba suficiente, el cierre no se aplica: sigue el comportamiento pendiente
y la conciliacion manual segura. Este PR no cambia el parser Status ni declara
autenticado el callback; evita usar una consulta Status secundaria para mantener
pendiente una operacion que ya esta probada localmente.

El registro QA existente NO se modifico durante esta auditoria. Un artefacto nuevo
no corrige retroactivamente filas historicas por si solo. Cualquier redelivery o
recuperacion que escriba metadatos requiere autorizacion operacional separada.
La parte SELECT de la prueba SQL, ejecutada sin su UPDATE en una transaccion READ
ONLY, encontro exactamente una correlacion completa para la operacion QA existente.
Eso verifica su aplicabilidad; no modifica el recibo pendiente.

## Impacto e idempotencia

El callback no crea pagos ni cambia intents/citas; la contabilizacion depende de
Sale verificada y del contrato financiero v2. Un duplicado, entrega tardia o cuerpo
contradictorio no autoriza otra captura ni revierte una cita confirmada. Se conserva
la evidencia entrante sin tratarla como aprobacion, rechazo, Void o reembolso real.
Operaciones externas contradictorias requieren evidencia y revision autorizadas.

La alerta operacional debe distinguir recibo no autenticado de deuda financiera:
no basta filtrar firma_valida=false o un pendiente antiguo para concluir que un pago
capturado esta incierto. No se observo una alerta real ni se modifico un dashboard.

## 3DS y condiciones minimas de produccion

La aprobacion basica demuestra ese recorrido QA observado, no 3DS, aceptacion Live ni
idempotencia remota tras una interrupcion. 3DS React/Node sigue NO-GO: no esta acreditado
el handoff 202/songbird sin credenciales reutilizables ni el contrato del segundo POST
Sale/Auth. La documentacion declara que el SDK no puede ejecutar 3DS sin el servicio
del navegador en Node.js. SDK 2.5.10 agrega hooks, no esas garantias. El segundo POST
es observable en el codigo del SDK; eso no prueba doble cargo ni idempotencia remota.
Conservar contencion y no reintentar.

Fuentes oficiales: [3DS](https://docs.pixelpay.com/page/sdk/requests#3ds),
[JavaScript/Node](https://docs.pixelpay.com/page/sdk/installation/javascript),
[Hosted Payment](https://docs.pixelpay.com/page/integrations/hosted-payment).
Hosted es otra integracion con checkout/3DS del proveedor; requiere su propio contrato
de correlacion y evidencia. No es continuacion de una Sale historica ni basta un redirect.
Este PR no implementa Hosted ni amplia el alcance a VIP.

Antes de habilitar reservas con pago productivo:

1. Aprobar el cierre del callback y validar el artefacto QA bajo autorizacion separada,
   con controles comerciales apagados mientras corresponda. Mantener pruebas de
   incertidumbre, concurrencia, rollback y recuperacion; nunca confirmar por inferencia.
2. Acreditar con PixelPay el mecanismo 3DS soportado o la politica aplicable sin 3DS,
   incluyendo la proteccion del segundo POST. Resolver Hosted por separado si se elige.
3. Verificar compatibilidad financiera, referencias y paid_at, artefactos/configuracion
   Live aislados de QA/simuladores y observabilidad que separe recibos de pagos.
4. Aprobar por separado despliegue, configuracion comercial y una primera operacion
   Live controlada. Rollback bloquea nuevas compras sin borrar evidencia ni impedir
   conciliacion. Ni este PR ni una Sale QA conceden esas autorizaciones.

## Validacion local y retirada

- Regresiones de rutas, SDK, guardas Sale, persistencia de intentos, 3DS, privacidad,
  contrato financiero, permisos y CSRF: 447 PASS.
- Webhook/callback: 34 PASS, incluyendo firma/hash invalido, campos contradictorios,
  Status 412/timeout/incompleto y ausencia de efectos financieros del recibo.
- PostgreSQL 17 aislado, archivo payment-late-paid-at completo, con ambas flags
  RUN_PAYMENT_LATE_PG_INTEGRATION y RUN_FINANCIAL_CONTRACT_PG: 90 PASS, cero fallos y
  cero omitidas. Incluye contrato v2, concurrencia con conexiones reales,
  precision de microsegundos, expiracion, rechazo de evidencia insuficiente y rollback.
- Lint completo: cero errores; 25 advertencias. Diff-check: PASS.

Todo proveedor en las pruebas es sintetico; no se prueba un nuevo pago externo.
El workflow PostgreSQL existente ejecuta este archivo completo en cada PR hacia dev.
No se cambia CI para omitir pruebas. La retirada del cambio consiste en revertir
solo este PR mediante una aprobacion separada; los recibos volverian al seguimiento
anterior y la evidencia financiera permanece intacta. No hay migracion que revertir.

No se modificaron triggers, migraciones, datos remotos, flags, Docker o EasyPanel.
