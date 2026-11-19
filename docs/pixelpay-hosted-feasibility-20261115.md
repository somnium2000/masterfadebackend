# Hosted Payment: factibilidad y arquitectura dual propuesta

Fecha: 2026-11-15. Dictamen: **NO-GO operativo**. Este cambio contiene solo
documentacion. No incorpora adaptadores, endpoints, flags, migraciones ni cambios
al SDK Direct. No acredita un checkout, pago Hosted o desafio 3DS ejecutado.

## Bases verificadas y alcance

| Repositorio | dev consultado | Draft revisado |
| --- | --- | --- |
| Backend | `865a256c0b2f94f3b53a655f199166af5f81e2b3`, incluye PR 124 | PR 111, `be19c8c8beb78a650074fe8f7303c5549eb6f514` |
| Frontend | `a6333139ffc586fd145e4dc53229a24ef51eea6e`, incluye PR 104 | PR 93, `2eb7ac55300215d72308884d61638cb2c14bf8ac` |

Se consultaron el MCP oficial PixelPay, referencias oficiales web, los dos drafts
y sus metadatos historicos saneados. No se hicieron solicitudes de creacion Hosted,
Sale, Status, Void ni consultas a bases de datos remotas. No se reutilizo una operacion
historica ni se inspeccionaron credenciales. Las pruebas usan transporte sintetico
y PostgreSQL 17 temporal en loopback; sus migraciones solo afectan fixtures locales.

Los drafts permanecen candidatos experimentales. No copiar sus arboles completos
sobre dev: preceden al claim SDK unico, capacidades QA, recuperacion durable con
fecha canonica y cierre operacional del callback. El merge simulado de backend
presenta conflicto en `src/routes/v1/public/pagos.js`.

## Evidencia y contrato documentado

| Punto | Comprobado | Lo que no demuestra |
| --- | --- | --- |
| 403 historico, seis solicitudes Node | HTML y `cf-mitigated: challenge`: respuesta Challenge de Cloudflare | Regla concreta, rechazo de firma, habilitacion del comercio o estado actual del endpoint |
| 500 historico, navegador | JSON `success=false`, mensaje `El modulo de pago sandbox no existe` | Retirada del modulo, dominio correcto de la cuenta o firma aceptada |
| Creacion Hosted | POST form-urlencoded, `json=true`, firma backend sobre Key ID, orden y plataforma; exito devuelve `success=true,url` | Firma integral del resto de parametros, pago aprobado, UUID financiero inicial, idempotencia remota o cuenta habilitada |
| Rutas publicadas | `/api/v2/transaction/hosted/other` y `/api/v2/transaction/hosted/sandbox` bajo el dominio correspondiente | Que `.app` y `.dev` sean intercambiables para este comercio |
| Checkout hospedado | La guia declara que PixelPay captura tarjeta/billing y gestiona 3DS | Que el Sandbox de cuatro simulaciones ejecute un challenge bancario completo |
| Retorno y callback | `_complete` GET, `_cancel` GET y `_callback` POST JSON; reenvio a cinco minutos, maximo tres intentos | Que el retorno confirme un pago o la cancelacion del navegador anule una operacion bancaria |
| `paymentHash` | MD5 de orden, Key ID y secreto; valida correlacion de orden en backend | Integridad de monto, moneda, estado, UUID, transaccion o fecha del cuerpo |
| Firma de solicitud | HMAC SHA3-512 de Key ID, orden y plataforma | Firma integral del webhook entrante |
| Status | Consulta autenticada por `payment_uuid` | Equivalencia `uuid` Hosted / `payment_uuid`, consulta por orden sin UUID o contrato financiero Hosted completo |
| `expired_at` | Formato `yyyy/mm/dd hh:mm` | Zona horaria, precision, instante de captura y comportamiento de un 3DS que termina despues de expirar |

Los metadatos HTTP historicos estan en la rama de PR 111, bajo
`docs/evidence/pixelpay-hosted-sandbox-diagnostic-20261114.json` y
`docs/evidence/pixelpay-hosted-sandbox-browser-20261114.json`. No se repitieron las
solicitudes. El comportamiento actual de la cuenta sigue sin verificarse: el MCP
es documental y no consulta permisos del comercio.

La referencia ampliada incluye ejemplos de `transaction_id` y `paid_at` en callback.
Su presencia en un ejemplo no acredita autenticidad ni cobertura criptografica.
La confirmacion anterior de HMAC para callbacks del proveedor debe aclararse
explicitamente para Hosted y su cuerpo/formato antes de usarla en esta integracion.
No se afirma que el proveedor carezca de un mecanismo: falta acreditarlo para este caso.

## Hallazgos que impiden integrar los drafts completos

1. El backend crea un claim durable antes de HTTP y tiene guards por grupo reutilizables,
   pero su canal es `sdk`/`hosted`, no `sdk_direct`/`hosted`. El default `sdk` tambien
   etiqueta proveedores historicos distintos: no identifica por si mismo una Sale SDK.
2. No envia `expired_at` al proveedor. Ocultar una URL al vencer localmente no revoca
   el checkout ya abierto o copiado. Un callback tardio solo queda para revision.
3. El evaluador financiero Hosted siempre bloquea y esta desconectado. No hay parser
   acreditado ni captura/confirmacion de cita compatible con el contrato financiero v2.
4. La consulta local autenticada Hosted queda tras el guard comercial. Suspender nuevas
   compras debe conservar consulta y recuperacion de operaciones existentes.
5. El frontend trata determinadas clases HTTP 4xx como rechazo antes del claim sin
   prueba suficiente del estado externo, y puede volver a ofrecer SDK. Un HTTP aislado
   no acredita que nunca se haya creado un checkout.
6. El marcador previo a creacion Hosted tolera fallo de almacenamiento. Tambien faltan
   guardas compartidas contra SDK en curso/incierto antes de invocar Hosted directamente.
   Deshabilitar botones y reutilizar una Promise no protege tras recarga u otro proceso.
7. Los validadores URL son una defensa reutilizable, pero `payload` es opaco. No prueban
   por si solos identidad de comercio/orden, ambiente o destinos internos del proveedor.
8. La UI del draft deriva permiso Hosted del permiso de ejecutar SDK Sale. Al adaptar
   al dev actual eso podria exigir habilitar SDK para ofrecer Hosted. Separar las
   validaciones comunes de reserva de las capacidades explicitas de cada canal;
   ninguno de los dos permisos implica el otro.

## Arquitectura dual propuesta, aun no implementada

### Seleccion e identidad

- Para un nuevo intent PixelPay, seleccionar explicitamente `sdk_direct` o `hosted`
  en backend y persistirlo antes de cualquier operacion externa. Hosted podra ser
  preferido solo para nuevos intents cuando su capacidad este acreditada y autorizada.
- La identidad canonica es el conjunto proveedor, intent, grupo, orden, importe en
  centavos, HNL y canal. Los identificadores externos conservan su rol documentado;
  no quitar prefijos, intercambiar UUID/transaccion ni completar evidencia faltante
  con valores enviados en la peticion.
- Un canal es inmutable durante la vida del intent. Una reserva/grupo no puede tener
  simultaneamente otra orden cobrable. No convertir intents historicos ni realizar un
  backfill que deduzca canal solamente del proveedor global o del default antiguo.
- No hay fallback automatico entre canales. Todo claim, incluso tras timeout o respuesta
  ambigua, mantiene reservado el canal. Un nuevo intento externo necesita un proceso
  acreditado de resolucion, nunca un segundo POST a modo de recuperacion.

### Exclusiones y transporte

- Ambos adaptadores deben consumir la misma exclusividad durable por grupo/intent antes
  de HTTP. Un doble clic, dos pestañas y dos procesos no pueden adquirir dos permisos
  de envio. Recuperacion devuelve el resultado persistido o pendiente, sin reenviar.
- Integrar el lock de canal con el orden de locks existente de identidad, pago,
  holds e intent. Probarlo con barreras y observacion real de espera en PostgreSQL;
  no declarar una carrera PASS solo por lanzar dos Promises.
- Persistir claim antes del envio, URL/identidad recibida tras exito validado y estado
  incierto ante perdida de respuesta. Una exclusividad local no demuestra deduplicacion
  bancaria: la semantica remota sigue siendo requisito del proveedor.
- Hosted exige capacidad propia estrictamente `true`, apagada por defecto. No reutilizar
  `booking=true` ni permiso SDK Sale. Mantener sesion, rol cliente activo, identidad,
  CSRF, propiedad, limites y validaciones de negocio de dev.
- El backend firma y valida la URL devuelta contra esquema, HTTPS, origen, puerto,
  ruta y ambiente acreditados, sin redirects arbitrarios. El navegador recibe solo
  una URL limitada al checkout; no Secret Key, firma de creacion del backend ni
  credenciales reutilizables. La URL oficial puede contener artefactos firmados opacos.
- Estado backend es la fuente de verdad tras recarga. Un fallo al guardar proteccion
  local no permite enviar otra operacion antes de recuperar el estado backend.

### Confirmacion, 3DS y vencimiento

- `/agendar/exito`, `_cancel`, `paid`, HTTP 200, OTP y `paymentHash` no confirman citas.
  Callback solo ingresa un recibo no confiable hasta verificar evidencia suficiente.
- Usar el mecanismo server-to-server oficial que acredite comercio, orden, UUID y
  transaccion, monto capturado, HNL, resultado final y fecha. Persistir un evento
  durable Hosted propio; nunca fabricar START/FINAL ni `sale.approved_verified` SDK.
- El contrato v2 actual contiene requisitos de evidencia SDK. Su compatibilidad con
  Hosted requiere un cambio financiero separado, revisado y probado; no suprimir
  triggers ni completar campos artificialmente para pasar sus validaciones.
- Confirmacion automatica requiere correlacion durable y ventana valida para el
  intent y todos los holds. Conservar precision y fuente canonica de la fecha
  financiera; el recibo del navegador no fija esa fecha.
- Hasta que el proveedor precise zona y semantica de `expired_at`, no hay promesa
  segura de expiracion remota. No extender holds durante 3DS automaticamente ni
  reactivar reservas vencidas/canceladas basandose solo en el callback. Distinguir
  pago realmente tardio de callback tardio de un pago anterior al vencimiento:
  cualquier recuperacion requiere evidencia temporal autentica y disponibilidad
  verificadas. Un pago realmente tardio exige conservar evidencia y revision
  financiera, sin ocupar de nuevo un horario ni devolver dinero automaticamente.
  No cambia la recuperacion durable SDK vigente. Ocultar la URL no cancela el cobro.
- Al suspender creacion se mantienen callbacks, consulta y recuperacion autenticadas.
  El rollback no borra eventos, cambia canal ni repite una Sale.

## Pruebas ejecutadas y limites

| Evidencia | Resultado y alcance |
| --- | --- |
| Backend PR 111, seis archivos sinteticos Hosted | 72 PASS, 0 FAIL, 0 SKIP; aprobacion reportada, rechazo, retorno/cancelacion, timeout, URLs, duplicados y verificador bloqueado |
| PostgreSQL 17 temporal, guards financieros del draft | 17 PASS, 0 FAIL, 0 SKIP; aislamiento de evidencia SDK, bloqueo de captura Hosted, identidad, duplicados y exclusiones SQL del candidato |
| Frontend PR 93, booking completo | 32 archivos, 353 PASS con `--maxWorkers=2`; incluye 65 pruebas Hosted en cuatro archivos |
| Frontend lint y build QA | PASS; `VITE_ENTORNO=qa`, `VITE_PAYMENT_PROVIDER=pixelpay`, `VITE_PIXELPAY_ENV=sandbox` solo en el proceso local de build; advertencia de chunks grandes |
| Transporte proveedor | Cero llamadas en esta revision; ningun checkout ni pago generado |
| Confirmacion financiera Hosted o 3DS completo | BLOQUEADO; no existe evidencia suficiente |
| Una orden no puede producir dos envios entre canales en el sistema completo | NO DEMOSTRADO; gaps frontend y falta de integracion actual por resolver |

Las pruebas PostgreSQL del draft usan fixtures antiguas, una basada en `finalized_at`,
no integracion completa con el contrato v2 actual. Su carrera no verifica la espera
antes de liberar la otra conexion. Esos 17 PASS no acreditan la arquitectura dual
en dev ni una captura Hosted. No se publica un prototipo operacional nuevo mientras
falten habilitacion y contrato financiero del proveedor.

La primera ejecucion frontend sin limitar workers obtuvo 352 PASS y un timeout de
cinco segundos en el caso de doble clic de `bookingHardening`, con error tardio de
contexto durante teardown. La repeticion acotada paso sin cambios de codigo ni
timeouts. La causa de esa diferencia no esta demostrada; no ocultar el primer fallo
ni interpretar el rerun como acreditacion de ausencia de problemas de concurrencia.

Aceptacion futura obligatoria: aprobacion/captura autentica, rechazo, challenge 3DS
aprobado/inconcluso, cancelacion, retorno falsificado, timeout antes/despues de creacion,
respuesta perdida sin UUID, doble clic, recarga con storage fallido, dos pestañas,
callbacks duplicados/tardios/contradictorios, vencimiento de cada hold, recuperacion y
rollback. Probar SDK->Hosted y Hosted->SDK concurrentes sobre ambas rutas reales:
contador de envios externos total como maximo uno y ninguna confirmacion sin evidencia.

## Decision y siguiente paso

Conservar PR 111/93 en draft. No habilitar sus flags ni integrar sus endpoints.
La [solicitud tecnica](pixelpay-hosted-support-request-20261115.md) esta lista para
enviarse por el canal privado del comercio; no se envio automaticamente. La respuesta
debe cerrar habilitacion, S2S, contrato financiero, idempotencia y vencimiento antes
de preparar implementacion operacional selectiva sobre dev.

Retirada de este PR documental: revertir solamente sus archivos bajo autorizacion
separada. No hay configuracion, migracion ni comportamiento operativo que revertir.

## Fuentes oficiales revalidadas

- MCP `es/integrations/hosted-payment`: [Hosted Payment](https://docs.pixelpay.com/page/integrations/hosted-payment).
- MCP `es/sandbox/hosted-payment`: [Hosted Sandbox](https://docs.pixelpay.com/page/sandbox/hosted-payment).
- MCP `es/secure-signature`: [Firma de seguridad](https://docs.pixelpay.com/page/secure-signature).
- [Hosted Payment Gateway, referencia ampliada](https://pixelpay.zendesk.com/hc/es-419/articles/360039834392-Hosted-Payment-Gateway).
- [Sandbox Hosted, referencia ampliada](https://pixelpay.zendesk.com/hc/es-419/articles/360043039752-SandBox-PixelPay-Hosted-Payment).
- [Cloudflare: deteccion de Challenge](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
