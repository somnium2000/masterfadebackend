# QA: recuperacion PixelPay con fecha financiera canonica

## Bases y traslado selectivo

Backend dev revisado: `15aefb834aef056b1fa114f34e3163a80d887e54`.
Backend main consultado en lectura: `f5cc338c3923f0ab75c11455182773c2a68a2f9d`.
No se fusionaron ramas completas ni se modifico main.

El cambio financiero aprobado de #99 es `d7bb2bf3073755a3fc0e6eb1adbff91802e8343c`:
restaura los cuatro archivos de #97 tras el revert administrativo #98.
Se traslado su parche selectivo, conservando los cambios legitimos de dev.
La proteccion de identidad y eliminacion procede del contrato revisado de #101,
`54f1e76ba8453c005ad450cdbf9ac9752cdc769c`; se adapto solo al helper interno y
al llamador autenticado de status existente. No se copio su endpoint nuevo.

| Punto | dev anterior | Contrato trasladado |
| --- | --- | --- |
| Evidencia | FINAL aprobado del intento | FINAL aprobado y evento firmado/verificado del mismo intento |
| Fecha de pago | `pixelpay_sale_attempts.finalized_at` | `payment_events.recibido_at::text` |
| Segunda ruta tardia | Comparaba milisegundos con FINAL | Igualdad SQL `timestamptz` contra el evento canonico |
| Identidad de recuperacion autenticada | Comprobacion previa del llamador | Propietario exacto revalidado bajo lock de eliminacion |
| Cardinalidad | Un intento FINAL | Exactamente un intento aprobado y un evento elegible correlacionado |

No se trasladaron Status, callbacks, puntos de engagement, proveedores, SDK,
endpoints financieros nuevos, configuracion comercial ni otros cambios de main.

## Evidencia exigida

`loadDurablePixelPayApproval` exige intento FINAL aprobado, SuccessResponse/200,
exito/aprobacion, respuesta completa y no incierta, resultado parseado/valido,
UUID/transaccion/hash presentes, hash valido y ambos montos verificados.
Un 200 por si solo nunca satisface este conjunto. Un 202 o error de transporte
no lo satisface y no se convierte en aprobacion por consultar Status.

El evento debe ser `pixelpay.sale.approved_verified`, `firma_valida=true`, del
mismo intent/proveedor PixelPay y `payment_attempt_id`, con identificador estable
`pixelpay_sale_<attempt>`. UUID de pago, transaccion, monto numerico y moneda
deben coincidir exactamente con el intent, y los flags de hash/monto ser verdaderos.
La relacion de la cita principal y su grupo tambien debe coincidir con el intent.

No se inventa un campo `order_id` en eventos historicos que no lo contienen.
La orden real del flujo se construye mediante `buildProviderOrderReference` como
`MF-PIXELPAY-<UUID del intent, sin guiones y en mayusculas>`. La recuperacion ahora
exige ese mismo valor en `orden_compra`. Una orden ausente o no canonica requiere
conciliacion manual; no se reconstruye ni se modifica la evidencia almacenada.
El backend verifico el hash de la respuesta contra esa orden antes de persistir la Sale.

FINAL y evento deben preceder o igualar los vencimientos del intent y de todos los
holds. El valor canonico se devuelve como texto PostgreSQL, preserva seis decimales
y se propaga al pago, intent y confirmacion sin usar el reloj de la aplicacion.
`expectedPaidAt` se compara dentro de PostgreSQL; una diferencia de un microsegundo
se rechaza aunque JavaScript redondeara ambos valores al mismo milisegundo.

La recuperacion autenticada recibe la identidad exclusivamente del contexto de
sesion del servidor. Exige cliente/usuario/persona correspondientes, activos y no
eliminados/anonimizados/bloqueados, sin eliminacion procesandose o completada.
Adquiere el mismo lock de eliminacion antes de los locks financieros y usa locks
de filas. Una colision de identidad devuelve un 409 seguro. No autoriza por correo
solamente ni por valores de identidad enviados por el navegador.

## Dependencias y SQL

El contrato `20261101025900_financial_paid_at_contract_v2.sql` ya esta versionado
en dev y coincide con main. Tambien existen las migraciones de intentos Sale y
alineacion de eliminacion de cuenta. No se necesita una migracion nueva para este
parche; no se modificaron triggers ni se ejecutaron migraciones en QA/Supabase.
No se afirma que el esquema remoto haya sido inspeccionado en esta tarea.

El unico DDL agregado es soporte de fixtures de pruebas: `orden_compra` en el
esquema temporal y tablas/columnas sinteticas de identidad. Las funciones financieras
se cargan desde SQL versionado en clusters PostgreSQL 17 nuevos y privados.
El helper valida directorio temporal/PID, usa solamente loopback y no lee
DATABASE_URL ni credenciales de Supabase. La limpieza elimina solo su directorio.

## Pruebas y limites

- 302 pruebas de rutas publicas de pago, provider con dobles, guard y store: PASS.
- 144 pruebas independientes de autorizacion, sesion, CSRF, Node/202 y contrato SDK: PASS.
- PostgreSQL 17 aislado: 65 PASS, cero fallos/omitidas, con contrato v2 y triggers reales.
- Lint: cero errores, 25 advertencias preexistentes. `git diff --check`: PASS.
- El workflow CI existente activa ahora tambien `RUN_FINANCIAL_CONTRACT_PG=true`,
  evitando que esta matriz se omita silenciosamente en GitHub Actions.

La matriz PostgreSQL comprueba aprobacion, duplicado, ausencia de evento, evento
de otro intento/proveedor, orden/grupo incorrectos, montos/moneda, eventos ambiguos,
identificadores ausentes, intento duplicado, vencimiento y diferencias de un
microsegundo, rollback posterior al INSERT, cuenta inactiva/eliminada y locks reales.

La carrera financiera utiliza dos conexiones PostgreSQL independientes y observa
ambas esperando el lock antes de liberarlo. La carrera autenticada observa la
primera peticion bloqueada en finanzas mientras posee identidad: la segunda
rechaza la colision, y su posterior recuperacion local devuelve duplicado.
Se verifica una sola captura, cita confirmada y hold consumido. Contadores del
proveedor permanecen en cero; no se realiza Sale, Status o Void externo.

Los casos no canjean puntos ni aplican promociones pobladas: no acreditan una
auditoria integral de exactamente-una-vez para todos esos efectos secundarios.
Los datos del fixture financiero son sinteticos, sin registros personales reales.
Las pruebas locales no demuestran una aprobacion del proveedor ni un E2E Sandbox.

## Operacion y rollback

Se conservan los PR #112 a #115 y la autorizacion QA por identidad. Sale/VIP siguen
bloqueados, los simuladores siguen desactivados y no se cambia ninguna variable.
No hay recobro automatico ante incertidumbre; la recuperacion reutiliza evidencia
durable existente y nunca llama al adaptador de pagos.

Rollback despues de una autorizacion separada: volver al artefacto anterior del
backend sin borrar datos, columnas, eventos, intentos o pagos. Mantener Sale
deshabilitada; un rollback no autoriza recuperar usando la fecha FINAL antigua.
Los pagos sin evidencia canonica suficiente permanecen para conciliacion manual.

Antes de una primera Sale Sandbox autorizada deben cerrarse por separado el
contrato 3DS, datos de tarjeta vigentes y habilitacion de Sale revisada; validar
compatibilidad del esquema de QA y desplegar ambos PR bajo autorizacion separada.
No basta activar un flag: el modo QA de reservas rechaza expresamente Sale activa.
Consultar `qa-sandbox-3ds-contract-review.md` para las preguntas precisas al proveedor.
