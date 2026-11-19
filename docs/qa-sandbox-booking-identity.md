# QA SDK Sandbox: reservas por identidad, cobro todavia bloqueado

## Decision y alcance

Base backend dev: 5944b3bed7d5fd33100877fbfd74b3a9eaef2722 (incluye PR #114).
Base frontend revisada: 411af62 (incluye contencion/build de 3DS).
El resultado operativo del diagnostico #114 (ipsLength=2, confianza del primer
salto, sesion valida y PILOT_DISABLED) se acepta como evidencia cerrada.
No se repiten sockets, proxy, dominios o infraestructura.

El bloqueo inmediato demostrado es PRIVATE_COMMERCE_PILOT_ENABLED=false:
eligible devolvia false antes de verificar la cuenta. El piloto legado requiere
ademas IP/proxy exactos; no se usa como identidad el endpoint compartido Swarm.

Esta alternativa es un control propio de QA. Autoriza solamente preparar reservas
para una cuenta interna, conservando el modelo de sesion y negocio de produccion.
No es habilitacion de pagos, ni equivalencia financiera completa de dev con main.

## Configuracion futura, no aplicada

Valores que solo un operador autorizado podria configurar despues de revisar,
fusionar y desplegar los PR bajo autorizaciones independientes:

```dotenv
QA_PRIVATE_COMMERCE_BOOKING_ENABLED=true
QA_PRIVATE_COMMERCE_USER_ID=<un unico UUID interno verificado, en privado>
PRIVATE_COMMERCE_PILOT_ENABLED=false
QA_PRIVATE_COMMERCE_SALE_ENABLED=false
ENABLE_QA_PAYMENT_SIMULATION=false
ENABLE_QA_VIP_PURCHASE_SIMULATION=false
```

Precondiciones estrictas: NODE_ENV=development, ENTORNO=qa,
PAYMENT_PROVIDER=pixelpay, PIXELPAY_IMPLEMENTATION=sdk, PIXELPAY_ENV=sandbox,
PIXELPAY_ENDPOINT y PIXELPAY_APP_URL=https://pixelpay.dev. Activaciones incompletas,
produccion/Live, UUID ausente/multiple y combinaciones con Sale/piloto/simuladores
fallan al arrancar. Desactivado por defecto. No modifica TRUST_PROXY ni sus redes.
No necesita PRIVATE_COMMERCE_IPS ni PRIVATE_COMMERCE_PROXY_IPS.

No se usa TCP/IP, X-Forwarded-For, X-Real-IP ni identificadores enviados en headers
para conceder acceso. Se exige mf_session verificada, sesion activa/no revocada,
sub interno exacto, coincidencia de identidad en BD, cliente activo y rol cliente.
AUTH_CLAIMS_SQL ya filtra usuarios/clientes inactivos o eliminados. Todas las
mutaciones siguen exigiendo CSRF y la ruta original conserva titularidad, esquema,
limites de frecuencia, vencimiento, saldo, precio, locks y reglas de negocio.

La allowlist contiene solo validaciones de reserva, holds, confirmacion sin pago
(con sus reglas de total cero), crear intents y consultar/conciliar reservas.
Sale, simuladores, operaciones VIP y nuevas operaciones administrativas siguen
rechazadas, aun para la cuenta autorizada. Los callbacks/operaciones de
mantenimiento conservan exactamente sus protecciones anteriores.

Solo en este modo, elegibilidad incluye pixelpaySale:false junto a booking y
vipPurchase:false. El frontend debe respetar ese false explicito: no enviar Sale
ni presentar el formulario como disponible. Campo omitido conserva el contrato
legado; no se modifica la presentacion Live. No hay credenciales nuevas en React.

Rollback autorizado futuro: QA_PRIVATE_COMMERCE_BOOKING_ENABLED=false y retirar
QA_PRIVATE_COMMERCE_USER_ID. Con piloto legado apagado, nuevas reservas vuelven
a estar bloqueadas. No se borran holds, intents, pagos ni historial.

## Tarjetas y escenarios oficiales: contraste acotado

Fuente: https://docs.pixelpay.com/page/sandbox/installation
(contraste con es/sandbox/installation del MCP oficial).

La documentacion separa dos tarjetas basicas de 24 tarjetas 3DS (Visa/Mastercard
para 12 escenarios, casos 2.1 a 2.12). pixelPayCardEnvironment.js admite solo las
dos basicas. Las 3DS no pasan esa allowlist. No se amplia en este PR: no existe
continuacion 3DS segura implementada y no se cambia ninguna restriccion Live.
Una ampliacion futura debe revisar tambien la prohibicion Live del conjunto de
prueba completo; no basta agregar las tarjetas al permiso Sandbox.

El caso basico de exito usa importe 1; los casos siguientes cubren rechazo y
errores, incluido timeout en 8. Los escenarios 3DS requieren el caso Sandbox 1 y
cambiar la tarjeta: autenticacion exitosa/fallida, attempts, no disponible/rechazo
del emisor, fallo/timeout de lookup y step-up exitoso/fallido/no disponible/error.
La tabla basica publicada incluye expiracion 2512, ya vencida en la fecha de esta
revision. La UI rechaza tarjetas vencidas. No se inventa una fecha aceptada por
el proveedor ni se desactiva esa validacion. Deben verificarse los datos de prueba
vigentes antes de autorizar una operacion. No usar tarjetas reales en QA.

## HTTP 202 y contrato 3DS

pixelPaySaleRuntime.js intercepta los HTTP 202 antes de ejecutar DOM/Cardinal/
router. MasterFade conserva pending_confirmation y nunca lo trata como aprobado.
El HTTP 202 del backend no prueba por si solo que PixelPay respondiera 202.
songbird requiere navegador; withAuthenticationRequest no implementa un handoff
React/Node. El SDK 2.5.8 CardinalAuthentication.retryTransaction vuelve a hacer
POST Sale/Auth. Una Promise concurrente no acredita idempotencia durable.

Por tanto NO se habilita esa secuencia, no se reenvia una Sale incierta y no se
entregan Secret Key, auth hash ni router payload al navegador. Una nueva version
del SDK, un postMessage, redirect u OTP completado no prueban aprobacion financiera.

Contrato requerido para implementar 3DS: handoff soportado sin secretos, token
acotado a comercio/orden/monto/sesion/origen/TTL, continuacion de la misma operacion,
garantia del segundo POST ante duplicados/timeout y resultado verificable en backend.
La documentacion publica revisada no acredita todo ese contrato React/Node.
No es un problema que pueda resolverse abriendo el guard o cargando Cardinal sin mas.

## Camino financiero y bloqueo de recuperacion

El camino directo actual se prueba con dobles: grupo/intent y propietario,
orden estable, monto/moneda/items canonicos y claim durable bajo lock antes de
una Sale; respuesta completa aprobada, hash de orden, UUID y transaccion autenticos;
evento durable aprobado/verificado; pago y reserva transaccionales e idempotentes.
Solo esta evidencia permite confirmar. Timeout/202/incompleto quedan pendientes.

Existe una divergencia acotada que impide afirmar equivalencia de recuperacion:
loadDurablePixelPayApproval en dev aun devuelve finalized_at del attempt, y las
dos rutas de recuperacion lo usan. El hotfix productivo exige correlacion estricta
con la Sale durable y payment_events.recibido_at canonico, conservando microsegundos.
No se modifica ese contrato, Status, callbacks, triggers ni SQL en este PR del guard.
Debe trasladarse selectivamente el hotfix ya revisado, con pruebas PostgreSQL
aisladas, antes de habilitar Sale y declarar E2E financiero listo.

## Matriz y siguiente puerta

| Area | Dictamen |
| --- | --- |
| Reservas por unica identidad QA, sin identidad de proxy | PASS sintetico |
| Cuenta ajena/inactiva, sesion revocada, rol/CSRF invalidos | PASS: rechazados |
| VIP, Sale, simuladores y administracion | PASS: siguen bloqueados |
| Entorno Live/produccion o configuracion incompleta | PASS: no permite modo QA |
| HTTP202, incertidumbre y ausencia de segundo cobro | PASS sintetico |
| Tarjetas 3DS frente a allowlist actual | FAIL de cobertura, sin abrir acceso |
| Continuacion 3DS segura navegador/backend | BLOQUEADO por contrato |
| Recuperacion durable equivalente a main | BLOQUEADO por timestamp/evidencia |
| Reserva completada por cobro Sandbox real | BLOQUEADO; no se ejecuto |

No repetir diagnostico de proxy. Revisar PR de reservas y capacidad UI; despues,
resolver el contrato de continuacion y portar la recuperacion canonica mediante
cambio acotado. Solo tras esas puertas y autorizacion independiente se realizaria
una unica Sale Sandbox nueva con datos oficiales vigentes. Si es incierta, conservar
contexto y conciliar por evidencia admitida o manualmente, sin repetir el cargo.

## Verificacion local

Backend: 445 pruebas focalizadas PASS, cero fallos y cero omitidas; incluye
67 pruebas de private commerce. Lint: cero errores, 25 advertencias existentes.
Frontend acompanante: 60 pruebas PASS en cinco archivos, lint y build QA PASS.
git diff --check PASS en ambos repositorios.

Pruebas de private commerce, sesion/CSRF, runtime Node/202, diagnosticos de Sale,
provider con dobles, guard, claim durable, contrato SDK3DS y rutas publicas de pago.
El harness TCP/UDP/TLS usa solo loopback. No se ejecutan operaciones PixelPay,
consultas Supabase, despliegues, variables de QA, migraciones ni cambios main.
