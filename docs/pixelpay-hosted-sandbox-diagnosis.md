# Hosted: resultado del diagnostico acotado

14 de noviembre de 2026, 06:11-06:15 America/Tegucigalpa. Continuacion de PR backend #111 y frontend #93; ambos permanecen en borrador. Solo solicitudes a rutas Sandbox con identidad ficticia y credenciales de prueba publicas, sin tarjetas, callbacks, consultas financieras, cambios de QA/produccion, despliegues ni aplicacion de SQL.

## Resultado HTTP y limites de la causa

Se hicieron seis solicitudes Node, sin seguir redirects, a `/api/v2/transaction/hosted/sandbox`: POST y GET firmados a `pixelpay.app`, POST con firma incorrecta y con nombre omitido al mismo dominio, y POST/GET a `pixelpay.dev`. `.app` es el ejemplo Hosted publicado; `.dev` es un dominio Sandbox de las guias de firma/SDK, probado como contraste de la ruta parametrizada, no certificado como endpoint Hosted de la cuenta.

**Las seis respuestas fueron HTTP 403 HTML con `cf-mitigated: challenge`, `server: cloudflare` y marcadores de Challenge Page.** Ese encabezado [identifica oficialmente un challenge de Cloudflare](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/). Esto demuestra la capa que produce los 403 reproducidos; no basta el encabezado `server` por si solo. No se deduce una regla WAF concreta, reputacion de IP, restriccion de pais ni causa por firma/parametros, porque no se obtuvo una respuesta de validacion de la aplicacion.

En Chrome, GET a la misma ruta `.app`, con campos completos, firma segun el algoritmo documental y `json=true`, obtuvo **HTTP 500 `application/json`**, `success=false` y `message="El modulo de pago sandbox no existe"`. Se observaron los headers por CDP sin extraer cookies, tokens o la sesion. No hubo challenge en esa respuesta. No se resolvio CAPTCHA ni se trasladaron cookies para evitar el edge.

El resultado de Chrome demuestra un segundo bloqueo en la aplicacion: el modulo solicitado no esta disponible para esa solicitud. No prueba si fue retirado, renombrado, deshabilitado por cuenta o si la ruta esta obsoleta. Tampoco acredita que la firma haya superado su validacion. La primera evidencia historica del PR solo conservaba HTTP403 sin headers; la nueva reproduccion resuelve el diagnostico actual y no inventa headers para el request anterior.

Metadatos sanitizados: [Node, seis casos](evidence/pixelpay-hosted-sandbox-diagnostic-20261114.json), [Chrome, respuesta de aplicacion](evidence/pixelpay-hosted-sandbox-browser-20261114.json). Contienen metodo, origen/ruta, nombres de campos, estado, headers allowlist, tamano/hash del cuerpo y senales; omiten credenciales, firma, query values, cookies y cuerpos de challenge.

Reproduccion explicita, nunca automatica al importar:

```powershell
node scripts/pixelpay-hosted-sandbox-diagnostic.mjs --run-sandbox-only
```

## Compatibilidad de checkout

El [contrato Hosted general](https://pixelpay.zendesk.com/hc/es-419/articles/360039834392-Hosted-Payment-Gateway) incluye `/pruebas-maria-3/P-<uuid>/checkout`; su traduccion EN incluye un identificador opaco bajo un comercio. El [Sandbox publicado](https://docs.pixelpay.com/page/sandbox/hosted-payment) muestra `/sandbox/<token>/checkout/example`. Las primeras formas no acreditan Sandbox y no se habilitan en este candidato por extrapolacion de prefijos SDK.

No se obtuvo una URL autentica de checkout exitosa en esta investigacion. Por ello, la ruta admitida sigue siendo la Sandbox documentada y ambos validadores ahora comparten la misma politica: origen HTTPS exacto, sin credenciales/puerto/fragmento, sufijo opcional literal `/example`, parametros documentados acotados y `url=` anidada solo al mismo origen/ruta, una vez. Se rechazan destinos directos externos, otra ruta/token de checkout en el destino anidado, parametros directos de callback/retorno en query y claves duplicadas. `payload` es opaco: el validador no comprueba su identidad de orden ni sus destinos internos, ni garantiza el comportamiento posterior del checkout. Solo valida la navegacion directa emitida por MasterFade y no autoriza ninguna confirmacion.

No se afirma corregida una compatibilidad de ruta comercial real que aun no esta demostrada. Si el endpoint Sandbox devuelve otra forma, se necesita la URL autentica y el contrato de ambiente antes de ampliar el validador.

## Verificacion y preparacion QA

[Contrato de verificacion y 23 vectores sinteticos](pixelpay-hosted-verification-contract.md): existe Status autenticado para `payment_uuid`, pero no se demostro equivalencia con `uuid` Hosted ni esquema que vincule cuenta, orden, importe, moneda y captura final. El checklist ejecutable permanece desconectado y siempre bloquea confirmacion; no es un nuevo verificador financiero.

[Revision independiente de migraciones y coexistencia](pixelpay-hosted-qa-coexistence.md): Hosted y TodoPago simulado activos no coexisten con el proveedor global actual. Hacen falta eleccion de canal/proveedor **antes** de crear la orden, capacidad frontend independiente del build global y adaptador dedicado; no convertir ordenes TodoPago existentes ni cambiar flags globales. La opcion de stack privado separado tambien preserva las pruebas existentes.

La revision detecto el guard antes del normalizador de grupo. Se corrigio el nombre del trigger candidato para ejecutarlo despues y se preparo una regresion con el normalizador real y otra cita del grupo. Solo se verifico estaticamente; **ninguna migracion se aplico durante esta continuacion**, ni siquiera en PostgreSQL temporal. Verificar tambien el rol SQL efectivo del backend antes de desplegar: los guards invoker requieren los permisos privados previstos para `postgres`.

## Preguntas exactas para soporte PixelPay

1. Para los Ray IDs y horas UTC del adjunto Node, ¿que politica produce el challenge del endpoint Sandbox server-to-server y cual es el procedimiento oficial para permitirlo desde el backend QA? No se solicita desactivar protecciones globales.
2. Para Ray `a5a5f1906e764724-ATL`, 14/11/2026 12:15:47 UTC, ¿por que `/api/v2/transaction/hosted/sandbox` devuelve HTTP500/modulo inexistente? Confirmar dominio/ruta vigentes, credenciales Sandbox aplicables, requisito de habilitacion de cuenta y vector request firmado valido.
3. Proporcionar un JSON `success=true,url` autentico de Hosted Sandbox y sus formatos/hosts/rutas/query admitidos, diferenciandolos de Hosted Live. Aclarar si los ejemplos de checkout publicados siguen vigentes.
4. ¿`uuid` Hosted puede consultarse como `payment_uuid` mediante Status? Si no, dar el mapeo y endpoint oficial. Entregar esquema HTTP completo y ejemplo Sandbox que autentique cuenta/comercio, orden, UUID/transaccion, importe capturado, HNL y resultado final con fecha/zona; indicar reglas para ausencias/nulos y recursos de otro comercio.
5. Definir captura final vs autorizacion/3DS pendiente/void/reembolso, frescura/replay, idempotencia de creacion y consulta/cancelacion de un checkout tras timeout. Un hash estatico por orden no sustituye esos datos.

Validacion de esta continuacion: **417 pruebas backend y 353 frontend aprobadas**, lint de ambos repositorios y build frontend correctos. El backend incluye 23 vectores de checklist financiero, 6 configuraciones de coexistencia, 4 pruebas del diagnostico y 1 comprobacion estatica de orden de triggers. La regresion PostgreSQL actualizada se preparo sin ejecutarla, para respetar la instruccion de no aplicar las migraciones. El build conserva la advertencia de tamano de chunks.

No se envio esta consulta a soporte. El bloqueo exacto para un extremo-a-extremo es: acceso S2S con challenge, modulo Sandbox no disponible al alcanzar la aplicacion, ausencia de URL Sandbox autentica, contrato de conciliacion Hosted insuficiente y seleccion global incompatible con el simulador QA actual.
