# PixelPay Sandbox: contrato 3DS y tarjetas, revision focalizada

Fecha de revision: 2026-11-14. Revision documental y ejecucion local con dobles.
No se realizaron peticiones financieras, cambios de dependencias, datos, variables,
infraestructura, despliegues ni cambios en la allowlist de tarjetas.

## Dictamen

**BLOQUEADO para habilitar continuacion 3DS en MasterFade React/Node.** Las fuentes
oficiales acreditan 3DS en navegador y un flujo conceptual cliente/backend, pero
las paginas revisadas no definen el contrato concreto para transferir una Sale
iniciada en Node a React sin credenciales, ni una garantia durable contra un cargo
duplicado en el segundo POST. Esto no demuestra que PixelPay carezca de ese contrato;
demuestra que aun no esta acreditado para esta integracion.

SDK 2.5.10 aporta un hook de lookup; no resuelve por si solo esos bloqueos. La
contencion actual de HTTP 202 y la prohibicion de reintentar una Sale incierta
deben conservarse. Un resultado de autenticacion, un HTTP 200/202 o un postMessage
no sustituye la evidencia financiera verificada en backend.

## Fuentes oficiales revisadas

- [JavaScript/TypeScript](https://docs.pixelpay.com/page/sdk/installation/javascript):
  indica que sin navegador (Node.js) el SDK no ejecuta 3DS.
- [Peticiones SDK, 3DS](https://docs.pixelpay.com/page/sdk/requests#3ds):
  withAuthenticationRequest en cliente; backend ejecuta doSale/doAuth firmado.
  El diagrama no especifica payload de handoff, emisor/token, TTL o reanudacion.
- [Venta sin tokenizacion](https://docs.pixelpay.com/page/sdk/use-cases/payments/without-tokenization/javascript):
  ejemplo general y validacion de hash en servidor, sin protocolo React/Node completo.
- [Servicios](https://docs.pixelpay.com/page/sdk/services#transaction-funcs) y
  [respuestas/entidades](https://docs.pixelpay.com/page/sdk/responses-entities):
  getStatus/TransactionResult y verifyPaymentHash exclusivamente del lado servidor.
- [Instalacion Sandbox y escenarios](https://docs.pixelpay.com/page/sandbox/installation#test-cases-3ds).
- [Hosted Payment](https://docs.pixelpay.com/page/integrations/hosted-payment) y
  [Sandbox Hosted Payment](https://docs.pixelpay.com/page/sandbox/hosted-payment).
- Paquete oficial [SDK en NPM](https://www.npmjs.com/package/@pixelpay/sdk-core),
  artefactos publicados [2.5.8](https://registry.npmjs.org/@pixelpay/sdk-core/-/sdk-core-2.5.8.tgz)
  y [2.5.10](https://registry.npmjs.org/@pixelpay/sdk-core/-/sdk-core-2.5.10.tgz).
  Las paginas docs se leyeron mediante el
  MCP oficial de documentacion; el HTML publico devuelve una carcasa JavaScript.

## Demostrado en codigo del paquete publicado

Rutas relativas al paquete @pixelpay/sdk-core; las lineas corresponden a los
archivos lib del artefacto indicado, no a codigo propuesto para MasterFade.

| Evidencia | 2.5.8 | 2.5.10 | Implicacion |
| --- | --- | --- | --- |
| Transaction.doSale rechaza authentication_request en Node | services/Transaction.js:25 | services/Transaction.js:24 | Activar la bandera en Node no implementa 3DS |
| Tras PayloadResponse entra a CardinalManager para songbird | services/Transaction.js:38-46 | services/Transaction.js:36-42 | El SDK intenta continuar en el mismo contexto y necesita DOM |
| retryTransaction vuelve a POST Sale/Auth | services/CardinalAuthentication.js:18-30 | services/CardinalAuthentication.js:19-31 | El segundo envio es real en el flujo SDK; su seguridad remota necesita contrato del proveedor |
| Identificador de autenticacion se asigna a la transaccion original | libraries/CardinalManager.js:256-263 | libraries/CardinalManager.js:256-263 | authentication_identifier no acredita por si solo payment_uuid, aprobacion ni captura |
| buildRequest requiere auth_key y auth_hash y los coloca en headers | base/ServiceBehaviour.js:27-47 | base/ServiceBehaviour.js:27-47 | El hook/token no elimina la dependencia de credenciales del SDK directo |
| validateResponse acepta clases aprobada, rechazada y timeout | entities/TransactionResult.js:35-38 | entities/TransactionResult.js:35-38 | Es clasificacion de respuesta, no autorizacion financiera |

En 2.5.10, requests/PaymentTransaction.js:94 agrega setBeforeAuthenticate(callback).
requests/LookupTransaction.js:77-79 copia el callback; :106-118 lo ejecuta y asigna
su retorno a payment_token. services/CardinalAuthentication.js:12-14 llama el hook
antes del lookup. No hay alli un emisor de tokens, formato, alcance, vencimiento,
binding a orden/monto/sesion ni garantia de un solo uso. Un error del callback se
captura y registra; no debe interpretarse como una validacion fail-closed propia
de MasterFade. No se utilizo ese hook para publicar credenciales ni para fabricar
un token de continuacion.

El changelog 2.5.10 declara eventos para lookup de Cardinal. El de 2.5.9 elimina el
router; 2.5.10 conserva esa eliminacion. Actualizar cambia ademas esa compatibilidad
y no es una correccion acreditada del handoff. No se actualizo el SDK instalado.

La memoria estatica runningTransaction solo comparte una Promise concurrente en
un proceso/contexto JavaScript; se limpia al terminar. Dos invocaciones secuenciales
del mismo objeto vuelven a enviar. No acredita idempotencia del proveedor ni protege
contra recarga, reinicio, otro proceso o timeout. Las pruebas locales demuestran
ese comportamiento; no afirman que el proveedor necesariamente duplicaria un cargo.

## Datos que podria manejar el navegador

Las fuentes y el codigo contienen datos de autenticacion como un JWT de inicializacion,
collection_url, identificador de autenticacion y payload de challenge. Su presencia
en el SDK no acredita que sea seguro devolver indiscriminadamente el HTTP 202 completo
de una Sale de backend. No hay en las paginas revisadas una lista contractual de
campos permitidos para ese handoff ni una autorizacion que sustituya las credenciales
que exige ServiceBehaviour.

MasterFade solo deberia introducir un handoff cuando PixelPay documente el mecanismo
publico/efimero y su binding a la misma orden, monto, sesion y origen. No exponer
Secret Key, auth hash, headers firmados reutilizables o payload de router. No inventar
endpoint, esquema de token o identificador de pago; no adaptar valores de frontend
para fingir evidencia del proveedor. La finalizacion debe verificarse en servidor
con el contrato financiero durable del backend.

Existe una alternativa oficial distinta: Hosted Payment crea una URL firmada desde
backend y el proveedor presenta checkout/3DS. No es una continuacion de la Sale directa
ya enviada. Su evaluacion requeriria correlacion e integridad propias; no se ha
implementado ni fusionado Hosted #111/#93, ni se propone reusar intentos historicos.

## Tarjetas, fechas y CVV

La tabla Sandbox publica dos tarjetas basicas y otra tabla con 24 tarjetas para
12 escenarios 3DS, Visa/Mastercard. Para 3DS indica usar el caso de importe 1 y
reemplazar la tarjeta. No se incluyen PAN ni CVV en este informe.

| Grupo | Escenarios oficiales | Comparacion MasterFade |
| --- | --- | --- |
| Basicos, importe 1-14 | Exito; rechazo; comercio invalido; reporte de robo; cobro no encontrado; intentos excedidos; error general; timeout; monto excedido; limites de transacciones, monto, BIN, tipo y localizacion | Allowlist solo admite las dos tarjetas basicas; no demuestra resultado remoto |
| 3DS 2.1-2.4 | Autenticacion exitosa, fallida, attempts stand-in, emisor no disponible | Tarjetas adicionales rechazadas por allowlist |
| 3DS 2.5-2.8 | Rechazo del emisor, autenticacion no disponible en lookup, error de lookup, timeout de lookup | Tarjetas adicionales rechazadas por allowlist |
| 3DS 2.9-2.12 | Step-up exitoso, fallido, no disponible y error de autenticacion | Tarjetas adicionales rechazadas por allowlist |

La tabla basica publica expiracion 2512 (diciembre 2025), vencida en la fecha de
esta revision. El ejemplo generico SDK utiliza otra fecha futura y un CVV diferente
del asignado a esa marca en la tabla Sandbox. Un ejemplo generico no demuestra que
Sandbox acepte esa fecha/CVV. La tabla 3DS no especifica su propio vencimiento/CVV.
**Datos vigentes aceptados por el proveedor: BLOQUEADO hasta confirmacion oficial.**
No se inventa una fecha, no se relaja el rechazo de tarjetas vencidas y no se prueba
variantes mediante cobros.

Frontend valida CVV de tres o cuatro digitos y vencimiento MM/AA vigente; backend
exige CVV numerico de tres o cuatro digitos y vencimiento YYMM vigente. Son controles
de formato, no una afirmacion de CVV correcto. La comprobacion del dato de Sandbox
corresponde al proveedor. No se escriben esos valores en logs ni persistencia.

pixelPayCardEnvironment.js admite exclusivamente las dos basicas en Sandbox y las
prohibe en Live. Esa denylist Live no contiene las 24 adicionales. Ampliar cobertura
futura exige en el mismo cambio revisar la prohibicion Live del conjunto completo,
probar aislamiento y disponer primero de la continuacion soportada. No se amplio
ninguna allowlist ni restriccion de entorno en estos PR.

## Pruebas locales y procedencia

Resultado: **61 PASS, 0 FAIL, 0 SKIP**, Node v22.22.2; dos versiones caracterizadas,
con DOM sintetico y reemplazos de post, script y formulario. Se bloqueo
net.Socket.prototype.connect y se verifico socketAttempts=0. No se autentico una
tarjeta ni se contacto un proveedor. No es E2E ni prueba de idempotencia remota.

Incluye HTTP 200 completo/incompleto, HTTP 202 songbird/payload, tipos desconocidos,
rechazo 3DS en Node, excepcion de transporte, router por version, challenge
exitoso/fallido, cierre/recarga/desconexion, origen de mensaje no permitido,
identificador ausente y hook 2.5.10. Ademas se comprobo que el flujo sintetico completo
202/lookup/continuacion emite dos POST Sale y que la coalescencia de Promise no
impide otra llamada despues de finalizar. Lookup con payment_token sigue requiriendo
credenciales de comercio en buildRequest.

Artefactos locales de analisis (fuera de dependencias y codigo de la aplicacion):
.codex-worktrees/qa-research-20261114/sdk-contract-reproduction.cjs,
sdk-contract-reproduction.tap y reproduction-results.json. El harness carga las
versiones ya extraidas en .codex-worktrees/sdk-version-investigation-20261114 y
las dependencias ya instaladas; no se ejecuto npm install.
Esta caracterizacion externa no forma parte de GitHub Actions ni de la suite
automatica de la aplicacion, y no acredita un upgrade completo a 2.5.10 con su
arbol de dependencias publicado.

Comando desde la raiz APP WEB, solo para este harness local:

```powershell
$env:NODE_PATH = (Resolve-Path 'masterfadebackend/node_modules').Path
node --test '.codex-worktrees/qa-research-20261114/sdk-contract-reproduction.cjs'
```

SHA1 del tarball publicado 2.5.8: 3648911e3603b92ba4872027c7d703f0279bb28d;
2.5.10: 18d79520c3de04f4ac75f3909e7236cfe929a842. Ambos coinciden con el artefacto
local y su metadata de registro; la metadata publica 2.5.10 se consulto otra vez
en esta revision. No se cambiaron package.json ni lockfiles de MasterFade.

## Preguntas concretas para soporte PixelPay

1. Para React + Node, cual es el ejemplo oficial completo y version soportada para
   continuar en browser una Sale de backend que devuelve 202/songbird, sin entregar
   auth hash, Secret Key o credenciales reutilizables al navegador?
2. Cuales campos exactos del 202 pueden exponerse? Quien emite el token para
   setBeforeAuthenticate/payment_token, por que mecanismo oficial y con que alcance,
   orden/monto/comercio, origen, TTL y uso unico? El token elimina que credenciales?
3. Cual es la relacion verificable entre authentication_identifier, identificador
   de lookup, payment_uuid, transaction_id y orden? Como se conserva ante recarga?
4. Cuando retryTransaction envia otro POST Sale/Auth, que clave y contrato impiden
   una segunda captura? Cual es su ventana de retencion y el resultado ante duplicados,
   dos procesos, timeout, cierre del browser o cambio de importe?
5. Cual es el mecanismo soportado de consulta/conciliacion cuando el primer POST pudo
   haber llegado pero no devolvio payment_uuid? Como distinguir continuar de volver a cobrar?
6. Que respuesta financiera y verificaciones de integridad autorizan contabilizar
   tras 3DS? Cuales campos de monto/moneda/transaccion estan autenticados, y como se
   verifica un resultado Status completo o un callback firmado sin asumir aprobacion?
7. 2.5.10 es compatible con esta arquitectura? El hook nuevo exige un servicio o token
   no documentado en las paginas publicas? Que contrato reemplaza el router eliminado?
8. Cuales son los vencimientos y CVV vigentes para las dos tarjetas basicas y los
   12 escenarios 3DS? La tabla 2512 esta desactualizada y aplica otra regla oficial?
9. Si no existe handoff soportado, recomiendan Hosted Sandbox para esta arquitectura
   y cual es el contrato financiero/callback autenticado que debemos verificar?

## Puerta para la primera Sale Sandbox, sin autorizacion implicita

Los PR actuales no habilitan Sale. El modo de reserva por identidad exige
QA_PRIVATE_COMMERCE_SALE_ENABLED=false y rechaza arrancar si se combina con true.
Una futura prueba necesita tambien un permiso de Sale acotado, revisado y probado
por separado una vez acreditado el contrato; no basta cambiar esa variable.

1. Revisar y validar por separado los PR UX/recuperacion; confirmar que la reserva QA
   por identidad sigue funcionando y Sale/VIP permanecen bloqueados.
2. Resolver las preguntas de datos de prueba y, si se requiere 3DS, el contrato de
   handoff e idempotencia. No habilitar el flujo por un hook o una suposicion.
3. Validar fixtures locales con PostgreSQL 17: identidad, monto/moneda, evidencia
   durable, tiempo canonico/microsegundos, idempotencia, expiracion y rollback.
4. Obtener autorizaciones independientes para merge/despliegue/configuracion QA y
   para una unica Sale Sandbox nueva con cuenta interna, datos oficiales vigentes,
   orden canonica e importe aprobado. Este informe no concede esas autorizaciones.
5. En la futura ejecucion autorizada, corroborar el proveedor/entorno servido y
   capturar solo IDs y evidencia saneada. No utilizar tarjetas reales ni intentos Live.
6. Si es incierta o 202 sin evidencia financiera completa, conservar contexto y
   mantener bloqueo de segundo cobro; usar un mecanismo de conciliacion admitido
   o revision manual. No confirmar la cita para obtener un resultado artificial.
7. Declarar E2E solo con resultado financiero verificable, evento durable, pago unico
   y cita confirmada transaccionalmente, mas repeticion idempotente sin nueva Sale.
