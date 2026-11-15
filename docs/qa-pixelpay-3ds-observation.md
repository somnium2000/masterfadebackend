# Fase C: observar una primera respuesta Sandbox con contención 3DS

## Alcance y decisión

Este cambio prepara una observación inicial restringida. No implementa la
finalización 3DS, no expone un relay de endpoints y no autoriza una transacción,
un despliegue o una modificación de variables. Hosted sigue independiente.

Bases de `dev` verificadas al preparar la fase:

- Backend: `865a256c0b2f94f3b53a655f199166af5f81e2b3`.
- Frontend: `a6333139ffc586fd145e4dc53229a24ef51eea6e`.

El SDK 2.5.8 y 2.5.10 rechaza `authentication_request=true` en Node. Sin esa
bandera, una respuesta 202 puede intentar entrar al DOM/Cardinal; el runtime
actual la contiene antes de esa rama. No se elimina el guard ni se activa
`withAuthenticationRequest()` en Node. Por tanto, esta prueba puede observar
si el proveedor pide autenticación, pero no garantiza provocar un challenge.

## Evidencia oficial del caso de prueba

La [matriz oficial de Sandbox](https://docs.pixelpay.com/page/sandbox/installation#test-cases-3ds)
publica el caso **2.9, Successful Step Up Authentication**, con una tarjeta
específica por marca. Exige el Caso #1 de Sandbox, `order_amount=1`, y sustituir
la tarjeta. Las tarjetas genéricas ya admitidas por MasterFade no son ese caso.
La excepción de esta fase solo admite las huellas del caso 2.9 en el contexto
diagnóstico QA, sin ampliar la allowlist ordinaria ni cambiar el contrato Live.
PAN y CVV no se incluyen en este documento, CI o informes operativos.

La [instalación JavaScript](https://docs.pixelpay.com/page/sdk/installation/javascript)
y el [diagrama de peticiones 3DS](https://docs.pixelpay.com/page/sdk/requests#3ds)
sitúan el navegador y el backend en contextos diferentes. En las fuentes
concretas revisadas no se acreditó un puente ejecutable HTTP202 a React con
autenticación efímera, reanudación y deduplicación de la finalización.

No atribuir la duración de tokens de tarjeta a los JWT de 3DS. No entregar
`auth_hash`, Secret Key o firmas reutilizables al navegador para llenar ese vacío.

El [ejemplo oficial SDK Sandbox de Sale](https://docs.pixelpay.com/page/sandbox/use-cases-sdk/payments/sale-card/javascript)
usa monto 1 y vencimiento **12/2028**. La nota de la matriz 3DS indica sustituir
solamente la tarjeta. La interpretación conjunta permite preparar ese baseline
oficial, conservando sus demás datos y reemplazando la tarjeta por la del caso
2.9. Esto es una inferencia explícita de dos fuentes, no una fecha propia de la
fila 2.9 ni garantía de aceptación del gateway. La tabla genérica separada tiene
una fecha antigua; no se mezcla con el ejemplo SDK ni se inventa otra fecha.
La disponibilidad actual y el resultado con Node sin flag siguen sin observarse.

## Arquitectura y cifrado

1. React conserva el formulario existente y envía la petición autenticada por
   HTTPS, sesión y CSRF al backend. No incorpora el SDK del comercio, Cardinal,
   Songbird, JWT de challenge o nuevas credenciales en el bundle.
2. La ruta autenticada existente vuelve a comprobar la cuenta autorizada,
   propiedad del grupo/intent, cliente activo, rol, vigencia de todos los holds,
   proveedor, orden y precio canónicos. El total del caso debe ser **1.00 HNL**.
3. El backend usa el SDK oficial ya instalado. La obtención de
   `merchant/public_key`, las credenciales del comercio y el cifrado de los
   campos de tarjeta permanecen en servidor. No hay endpoint público nuevo
   que entregue autenticación del comercio o acepte URLs arbitrarias.
4. El claim existente y el START del attempt se confirman en la misma
   transacción antes del despacho. Solo se permite un inicio para el intent
   expresamente seleccionado, incluso ante doble clic, recarga o reinicio.
5. Si llega 202, se conserva `pendiente_confirmacion`. Se registra solo HTTP,
   clase, tipo fijo y booleanos de presencia. No se entrega el payload/JWT a
   React, ni se ejecutan lookup, continue, `retryTransaction` u otra Sale.
6. Si llega una aprobación síncrona auténtica, siguen vigentes verificación
   financiera v2, montos, HNL, hash e identificadores; el retorno del navegador
   no sustituye esa evidencia. Los callbacks conservan las protecciones #124.

No se copia el prototipo B como un protocolo oficial. La implementación
preparatoria reutiliza el cifrado, la ruta y las finanzas actuales; solo añade
el permiso de observación y su contención. No hay fallback hacia Hosted.
El HEAD de `dev` no incorpora los endpoints de los drafts Hosted; eso limita
la superficie actual, no acredita una futura exclusión global de dos canales.

## Permiso independiente, apagado por defecto

Estos valores se documentan para una futura autorización; este PR no los aplica:

```dotenv
QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED=false
QA_PIXELPAY_3DS_DIAGNOSTIC_INTENT_ID=<un intent NUEVO, privado y autorizado>
QA_PIXELPAY_3DS_DIAGNOSTIC_UNTIL=<instante UTC con Z, ventana máxima de 10 minutos>
QA_PRIVATE_COMMERCE_SANDBOX_SALE_ENABLED=false
QA_PRIVATE_COMMERCE_SALE_ENABLED=false
PRIVATE_COMMERCE_PILOT_ENABLED=false
ENABLE_QA_PAYMENT_SIMULATION=false
ENABLE_QA_VIP_PURCHASE_SIMULATION=false
```

Se requieren además las precondiciones existentes de reservas QA por identidad:

```dotenv
NODE_ENV=development
ENTORNO=qa
PAYMENT_PROVIDER=pixelpay
PIXELPAY_IMPLEMENTATION=sdk
PIXELPAY_ENV=sandbox
PIXELPAY_ENDPOINT=https://pixelpay.dev
PIXELPAY_APP_URL=https://pixelpay.dev
QA_PRIVATE_COMMERCE_BOOKING_ENABLED=true
QA_PRIVATE_COMMERCE_USER_ID=<el único UUID interno autorizado, privado>
```

La identidad no procede de una IP o encabezado de origen. El frontend requiere
`pixelpay3dsDiagnostic === true`, junto con QA, PixelPay y Sandbox explícitos;
`booking=true` o `pixelpaySale=true` no conceden el permiso diagnóstico. Una
consulta ausente, fallida o en curso no abre el callback. La capacidad ordinaria
de Sale se mantiene independiente y apagada.

Solo el operador autorizado podrá cambiar el flag a true después de las
aprobaciones separadas. No publicar UUID operativos en Git, CI o este documento.
No habilitar el permiso y después elegir libremente otro intent: el UUID es una
restricción de servidor, no una selección del navegador. La expiración no libera
el claim ya creado y no habilita un nuevo cobro.

## Telemetría y cierre del 202

La telemetría admite códigos, clases, tipos enumerados y booleanos. No registra
cuerpo del SDK, JWT, payload opaco, ciphertext, tarjeta, CVV, cookies, auth_hash,
Secret Key, firmas o datos personales. Presencia de un campo no significa que
su contenido sea auténtico, suficiente o autorizado para el navegador.

Un 403 no demuestra whitelist por sí solo. Solo se puede indicar WAF cuando
existe su evidencia explícita; una firma incorrecta o un fallo de plataforma
no se reclasifican como problemas de IP. La ausencia de un evento en los logs
SSH filtrados tampoco demuestra ausencia del despacho.

Las verificaciones de un contexto diagnóstico consultan `/estado`, que lee
estado local. No llaman automáticamente al proveedor. El marcador de diagnóstico
se conserva en el contexto no sensible y el backend bloquea Status para el
intent seleccionado, incluso al apagar/caducar el permiso mientras se retenga
su configuración de contención. No borrar esa selección durante un resultado
incierto para permitir una consulta externa por otra ruta.

El callback #124 sin evidencia de Sale verificada registra el recibo como
pendiente y no lo promueve por datos del cliente. La preparación no autoriza
Status, Void, Auth, Capture, reembolso o una segunda Sale para cerrar la prueba.

## Evidencia operacional disponible y límites

La consulta SSH autorizada `masterfade-qa-audit status` mostró una tarea deseada
en ejecución de backend y una de frontend. No demuestra el SHA servido, valores
de variables, endpoint efectivo, salida pública del contenedor o compatibilidad
del esquema. No se solicitaron otros permisos ni se consultaron secretos.

Los antecedentes de whitelist/public_key y de la primera Sale básica son
históricos. No acreditan permisos por endpoint 3DS o browser. La preparación
no llama a `public_key`, Sale, Cardinal o Status externos. La obtención real de
public_key sería parte del SDK en la operación futura autorizada, salvo que se
autorice antes una comprobación no financiera separada y acotada.

## Procedimiento de UNA operación futura

Antes de solicitar autorización de la Sale, presentar conjuntamente:

1. PR backend/frontend y SHA exactos revisados, CI completada y pruebas PASS.
2. Autorización separada de integración/despliegue QA; después, comprobar los
   SHA realmente servidos, configuración Sandbox y capacidades sin ejecutar pago.
3. Caso oficial 2.9 sobre el baseline documentado de Sale SDK, manteniendo el
   vencimiento 12/2028 y los demás datos del ejemplo, con límite canónico
   **1.00 HNL**. Precisar que se observa la respuesta inicial y que no se promete
   completar el challenge. Si se exige un challenge completo, el contrato faltante
   mantiene esa prueba en NO-GO.
4. Cuenta interna autorizada y un único intent/grupo nuevos, propios, sin attempt
   ni operación externa anterior. No reutilizar los incidentes históricos ni la
   primera Sale básica aprobada. Comprobar todos los holds justo antes de enviar.
5. Ventana de hasta 10 minutos y UUID seleccionado privadamente por el operador;
   capacidad diagnóstica true y Sale ordinaria/VIP/simuladores deshabilitados.
   Si el despliegue/configuración consume la vigencia del hold, detenerse; no
   generar automáticamente otro intent para conservar una autorización anterior.
6. Autorización específica de **una sola Sale inicial Sandbox**. La preparación,
   el despliegue o una consulta de elegibilidad no son esa autorización.

Solo tras esos puntos, un operador haría un clic en la acción de observación.
Registrar requestId/attempt/intent/orden únicamente en un canal operacional
privado y sanitizar el informe compartido. No grabar el formulario de tarjeta.

| Resultado observado | Detención y resultado esperado |
| --- | --- |
| 202 / payload / songbird / router | Pendiente durable; cero continuación y cero segunda Sale. Guardar códigos y tipos; detener la prueba. |
| Timeout o pérdida de respuesta | Conservar incertidumbre y claim; no nuevo clic, intent, orden ni canal alternativo. |
| Rechazo, 403 o error de configuración | Detener la única prueba; no cambiar credenciales, endpoints o datos para reintentar dentro de la misma autorización. |
| 200 sin evidencia financiera completa | No captura ni cita confirmada; conservar el resultado incierto. |
| Aprobación financiera verificada | Comprobar por lectura un evento, un pago, cita/holds y paid_at canónico; no llamar a otra Sale para comprobar idempotencia. Esto por sí solo no acredita challenge. |

El cierre de un resultado incierto se hará mediante lectura de evidencia durable
y, si todavía falta, un procedimiento de conciliación específicamente autorizado.
No alterar manualmente estados, borrar START, capturar otra vez o emitir un Void
automático. Una captura auténtica tardía debe preservar evidencia sin confirmar
automáticamente un horario cancelado o reasignado.

## Rollback y retiro

Después de una futura prueba, el operador autorizado apaga
`QA_PIXELPAY_3DS_DIAGNOSTIC_ENABLED`; mantiene apagada la Sale ordinaria y conserva
el intent de contención mientras el resultado siga incierto. No borrar variables
de selección, intentos o evidencia para habilitar retries. Apagar la capacidad no
revierte un pago ni libera un claim.

Retirar código/flags diagnósticos requiere otro cambio revisado, conservando el
claim y los registros durables. No retirar la contención de un intento incierto
sin un plan de resolución. No hay migración remota o modificación de datos
incluida en esta preparación.

## GO / NO-GO separados

- **Código preparatorio:** evaluable mediante PR y pruebas locales/CI.
- **Observación externa inicial:** NO-GO hasta SHA/CI/configuración y caso documentado
  revisados y autorizaciones separadas de despliegue y transacción.
- **3DS completo:** NO-GO mientras falten handoff soportado, autenticidad de
  tokens, vínculo de continuación, recuperación y garantía del segundo POST.
- **Producción:** NO-GO; esta excepción QA no cambia ese dictamen.
