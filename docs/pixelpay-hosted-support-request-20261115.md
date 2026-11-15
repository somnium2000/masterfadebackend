# Solicitud tecnica a PixelPay: Hosted Sandbox, 3DS y conciliacion

Estado: preparada para envio por el operador; **no enviada**. Sin credenciales,
tarjetas, informacion personal ni identificadores de operaciones de clientes.

**Asunto:** MasterFade - habilitacion Hosted Sandbox y contrato financiero verificable

Equipo PixelPay:

Queremos evaluar Hosted Payment como canal principal para reservas con 3DS,
manteniendo SDK Direct como canal secundario. No necesitamos repetir una Sale
ni reutilizar operaciones anteriores. Antes de crear un checkout nuevo solicitamos
confirmacion tecnica de los siguientes puntos para el comercio identificado
privadamente en este ticket. No incluir Secret Key, hashes de autenticacion ni tokens.

## 1. Endpoint, habilitacion y bloqueo de acceso

La documentacion MCP publica `/api/v2/transaction/hosted/sandbox` bajo el dominio
correspondiente. El 14/11/2026 se conservaron estas evidencias saneadas:

| Cliente | UTC | Resultado | Referencia de soporte |
| --- | --- | --- | --- |
| Node, POST | 12:11:29.656 - 12:11:30.113 | HTTP 403 HTML, `cf-mitigated: challenge` | Ray `a5a5eb489f90ebce-ATL` |
| Chrome, GET | 12:15:47.694 | HTTP 500 JSON, `success=false`, `El modulo de pago sandbox no existe` | Ray `a5a5f1906e764724-ATL` |

El endpoint `.app` procede del ejemplo Hosted publicado; `.dev` aparece en guias
SDK/firma, sin que eso pruebe equivalencia para Hosted. No hemos eludido el challenge,
transferido cookies ni realizado nuevos requests operativos en esta revision.

Por favor:

- Confirmar dominio/ruta/metodo vigentes y si Hosted Sandbox y Hosted Live estan
  habilitados para este comercio o requieren alta separada.
- Identificar la causa del challenge de esos Ray IDs y el procedimiento S2S oficial.
  No solicitamos desactivar protecciones globales ni usar cookies del navegador.
- Explicar el HTTP 500/modulo inexistente; indicar si es disponibilidad del modulo,
  ambiente, cuenta o ruta. Aportar un vector firmado valido con valores ficticios,
  sin enviar secretos reutilizables por este documento.
- Confirmar formatos de URL/hosts/rutas y ambiente en un JSON autentico `success=true,url`.
  No generar una operacion en nombre nuestro sin autorizacion especifica.

## 2. Sandbox y 3DS

La guia Sandbox describe cuatro simulaciones: exito, callback, rechazo y cancelacion.
¿Existe un entorno Hosted completo distinto de esa pantalla para ejecutar challenge
3DS aprobado, fallido, abandonado y vencido? Indicar procedimiento y fixtures oficiales,
sin tarjetas reales. Aclarar que evidencia puede validar cada simulacion y que parte
solo puede acreditarse en el Sandbox 3DS completo.

## 3. Autenticidad y contrato financiero

`paymentHash` documentado se calcula sobre orden, Key ID y secreto. No cubre monto,
moneda, estado, UUID, transaccion ni fecha. La firma saliente de creacion tampoco
autentica por si sola el callback recibido.

Necesitamos:

- Confirmar si el contrato de HMAC de raw body comunicado para callbacks aplica
  especificamente a Hosted: headers, formato/encoding, clave aplicable, bytes exactos,
  campos cubiertos, comparacion, frescura/replay, rotacion y vectores validos/invalidos.
- Endpoint/metodo/autenticacion oficiales para verificar financieramente una operacion
  Hosted desde backend. ¿El `uuid` Hosted es `payment_uuid` de Status? Si difieren,
  entregar el mapeo oficial, sin transformaciones de prefijos deducidas.
- Esquema completo versionado y muestra Sandbox saneada que acredite comercio,
  orden, UUID financiero, transaccion, importe efectivamente capturado, moneda,
  aprobacion/captura final y fecha con zona/precision. Precisar campos ausentes/nulos.
- Distinguir captura de autorizacion, 3DS pendiente, rechazo, cancelacion, Void y
  reembolso; comportamiento al consultar recursos de otro comercio.
- Si se usa Status, confirmar si `last_response.data` contiene estos elementos
  tambien para Hosted y como se acredita integridad/correlacion. Un estado `paid`
  o `COMPLETED` aislado no permite confirmar una reserva.

## 4. Idempotencia y recuperacion sin segundo cobro

- ¿Repetir creacion con el mismo `_order_id` devuelve el mismo checkout o puede
  crear otra operacion cobrable? Precisar clave, vigencia, concurrencia y conflicto
  por monto/moneda distintos. Una orden declarada unica no define esta garantia.
- Si se pierde la respuesta antes de conocer UUID/URL, ¿como se consulta o recupera
  esa misma orden sin crear otro checkout? Indicar procedimiento oficial.
- Tras agotarse los callbacks, ¿hay consulta o reenvio autenticado oficial?
  Necesitamos recuperar la misma operacion, sin repetir Sale ni creacion Hosted.

## 5. Expiracion y desafio prolongado

- ¿Que zona horaria y precision tiene `expired_at`? ¿Cual es su semantica exacta?
- ¿Puede cobrarse un checkout ya abierto despues de expirar? ¿Que ocurre si el
  challenge empieza antes del vencimiento y finaliza despues?
- ¿Existe cierre/cancelacion oficial no financiera de una URL pendiente y como se
  acredita que ya no es cobrable? Volver a `_cancel` u ocultar el enlace no basta.
- ¿Que fecha autenticada determina el pago y como se recibe una aprobacion tardia?
  La reserva solo puede confirmarse dentro de la ventana de todos sus holds.

Con esas respuestas prepararemos primero pruebas locales y despues solicitaremos
autorizacion independiente para una unica prueba Hosted Sandbox nueva. Hasta entonces
Hosted permanece deshabilitado y no consideramos confirmados pagos por redirect,
callback no autenticado ni estado general aislado.

Gracias.
