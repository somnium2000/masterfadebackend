# Piloto privado de reservas y VIP

Base auditada: backend main `866706d3f9c3c3e1b841c4e2a3b7e60193c7f6aa`.
Frontend main `15cd0521de455e4c93be297d7fd1bc28fa5947e9`.
Implementacion local; no cambia tablas, credenciales, evidencia financiera ni despliegues.

## Control minimo

`env-plugin` valida configuracion antes de registrar pools y jobs. `private-commerce-plugin`
se registra despues de autenticacion y antes de las rutas. En `onRequest`, antes de validar
payload o ejecutar negocio, exige piloto activo, proveedor PixelPay, modo administrativo
apagado, IP autorizada y cookie de sesion verificada por `authenticate`/`requireRoles([])`.
Se valida firma JWT, issuer/audience/tipo, sesion vigente/no revocada en PostgreSQL y usuario
interno activo. El UUID de claims debe coincidir con el sub firmado y con el unico UUID
configurado. Roles, email, payload, query, localStorage y headers personalizados no autorizan.
Los guards originales de roles, propiedad de reserva/orden, CSRF y finanzas siguen ejecutandose.
Las mutaciones publicas, ahora autenticadas, tambien exigen el par cookie/header CSRF
que ya envia el cliente HTTP existente; los callbacks conservan su propia verificacion.

IP directa: socket remoto, ignorando headers. Con proxy: peer inmediato en allowlist exacta,
`TRUST_PROXY=true` y resolucion Fastify de un solo salto (`request.ips.length === 2`). El proxy
debe ser el Traefik interno existente, sobrescribir/agregar la IP real al extremo derecho de
X-Forwarded-For y ser la unica entrada al backend. No usar CIDR, wildcard ni confiar en toda
una red en PRIVATE_COMMERCE_PROXY_IPS. Si cambia la topologia, se cierra el acceso hasta
reauditarla. IPv4 mapeada e IPv6 se normalizan. IP + cuenta no certifican hardware: otra PC
con la misma salida NAT y esa misma sesion cumpliria las condiciones; no es attestation de dispositivo.

## Superficie auditada

| Ruta / capa | Operaciones |
| --- | --- |
| `/v1/public/citas` | contactos, hold, liberacion; contexto GET permanece accesible |
| `/v1/citas` | reserva, hold, confirmar, retomar, descartar; historial GET permanece |
| `/v1/public/pagos` y `/v1/pagos/reservas` | crear-intent, pixelpay/sale, pixelpay/status, estado (incluye recuperacion), mock-completar, simulator/event |
| `/v1/pagos/crear-intent` | intent autenticado legacy |
| `/v1/cliente/planes` | orden, pago-intent, confirmar-pago (Sale), pago-intent/:id/estado (recovery), adquirir, simulator/event; cancelaciones existentes preservadas |
| `/v1/admin/citas` | hold nuevo, confirmar hold y payment-link requieren piloto; horarios, bloqueos, llegada/atencion, cambios de estado y liberacion conservan sus guards originales |
| `/v1/admin/membresias` | cancelacion existente conserva su guard de rol y alcance; endpoints comerciales futuros quedan cerrados |
| `/v1/pagos/webhook/:proveedor` | excluido del guard de piloto; solo PixelPay tiene excepcion al bloqueo administrativo; verificaciones financieras existentes intactas |

`public/pagos.js` confirma mediante `confirmGroupAfterPaid` y RPC
`app_private.confirmar_reserva_pagada_v1`. `pixelPayDurableApproval.js` verifica FINAL durable,
hash, indicadores y montos. `membershipService.js` crea orden/intent, ejecuta Sale y confirma
con `confirmMembershipPaymentAndActivateSubscription` o recuperacion durable. El webhook
en `pagos.js` conserva identidad financiera, deduplicacion y verificaciones SDK actuales.
Ninguna de estas reglas se modifica; COMPLETED aislado sigue siendo insuficiente.
Registrar cualquier nueva ruta comercial dentro de un namespace protegido o ampliar y probar
la clasificacion antes de publicarla. Los servicios internos no obtienen una nueva API publica.

## Frontend y preventa

`GET /v1/commerce/eligibility` devuelve solamente `{booking, vipPurchase}` y `private, no-store`.
No devuelve UUID, IP ni allowlists. La UI consulta con la sesion actual, sin cache/dedupe,
se cierra ante error/logout/cambio de identidad y revalida al recuperar foco. Cada operacion
API vuelve a validar las tres condiciones. Una respuesta UI obsoleta no autoriza una operacion.
App, landing y planes usan exclusivamente esa elegibilidad para mostrar el flujo privado.
Los flags globales VITE_PUBLIC_BOOKING_ENABLED y VITE_VIP_MEMBERSHIPS_PURCHASE_ENABLED permanecen
apagados y no se cambian. El propietario inicia sesion antes de navegar al flujo privado.
Registro, login, catalogos, perfil y consultas existentes de preventa conservan sus rutas.

## Promocion, activacion y reversion independientes

1. Revisar diffs backend/frontend basados en main. Abrir PR a dev sin mezclar trabajo ajeno.
   Resolver diferencias de dev preservando sus cambios y ejecutar tests/lint/build/CI.
2. En dev aislado probar elegibilidad y llamadas directas con identidades sinteticas y proveedor
   simulado. Validar topologia real del proxy, cookie y revocacion. No probar Live en CI.
3. Preparar PR dev -> main mostrando solo los cambios revisados. Verificar que el mecanismo
   de despliegue no se dispara sin autorizacion; no fusionar ni desplegar automaticamente.
4. Publicar codigo inicialmente con `PRIVATE_COMMERCE_PILOT_ENABLED=false` (default).
   La entrega frontend no abre comercio y la entrega backend cierra las rutas cubiertas.
5. Activacion operativa autorizada: configurar un UUID interno verificado, IP publica de salida
   de la PC (y IPv6 si corresponde), IP exacta del proxy interno y TRUST_PROXY=true.
   Reutilizar configuracion PixelPay Live existente, sin sustituir credenciales ni flags financieros.
   Requiere PAYMENT_PROVIDER=pixelpay y ADMIN_DATA_ENTRY_MODE=false. Preservar la configuracion
   del webhook ya validada. Corregir AGENDA_SSE_ENABLED a un booleano valido antes del reinicio.
6. Solo despues de aprobacion operacional: PRIVATE_COMMERCE_PILOT_ENABLED=true y reinicio
   controlado del backend. Mantener ambos flags Vite false. Comprobar elegibilidad del propietario
   y rechazo de invitado/otra cuenta/IP antes de autorizar manualmente cualquier prueba de cobro.
7. Reversion inmediata: PRIVATE_COMMERCE_PILOT_ENABLED=false y reinicio controlado. Cierra
   nuevas operaciones y recuperacion interactiva; el webhook sigue conciliando transacciones
   ya iniciadas con sus controles originales. No borrar intents/ordenes/evidencia pendiente.
   No necesita recompilar frontend ni cambiar PAYMENT_PROVIDER/credenciales. Reversion de codigo
   mediante PR separado; auditar que no se reabran las APIs al quitar el guard.

Variables nuevas (vacias por defecto): PRIVATE_COMMERCE_USER_IDS (exactamente un UUID),
PRIVATE_COMMERCE_IPS (IPs exactas separadas por coma), PRIVATE_COMMERCE_PROXY_IPS (peers exactos;
vacio solo para acceso directo real). Configuracion habilitada incompleta o malformada aborta
el arranque, no habilita un fallback. No poner secretos ni credenciales en estas variables.

## Validacion local reproducible

Backend: `node --test test/private-commerce.test.mjs` usa las rutas reales de public/citas,
public/pagos, citas, pagos, pagos/reservas, cliente, admin/citas y admin/membresias, el plugin
real de autenticacion, JWT sintetico y SQL en memoria para sesion/claims. Toda conexion SQL
comercial inesperada falla el test. Cubre invitado, otro usuario (incluso super_admin), IP
distinta, headers falsificados, cookie alterada, sesion revocada, ausencia de configuracion,
piloto apagado, modo administrativo, proveedor deshabilitado, CSRF y proxy de un salto.
El callback real llega a sus propios controles financieros desde una IP ajena sin sesion.

Regresion financiera: `node --test test/private-commerce.test.mjs test/payment-disabled-mode.test.mjs
test/admin-data-entry-mode.test.mjs test/pixelpay-webhook-safety.test.mjs
test/membership-financial-security.test.mjs test/microfase2a2-public-pagos-routes.test.mjs`.
Ejecutar tambien `npm test`, `npm run lint` y `git diff --check` en backend.

Frontend: `npx vitest run src/hooks/usePrivateCommerce.test.jsx
src/features/landing/pages/__tests__/LandingPage.semantics.test.jsx
src/features/public/pages/__tests__/MembershipPlansPage.catalog.test.jsx
src/features/public/pages/__tests__/MembershipPlansPage.identity.test.jsx
src/__tests__/App.dashboardSuperOnly.test.jsx src/__tests__/App.promotionsRoutes.test.js --maxWorkers=2`.
Comprueba cierre por defecto/error/logout, respuestas atrasadas, cambio de identidad, revalidacion
por foco y visibilidad positiva. Ejecutar `npm run test:node`, `npm run lint`, `npm run build`
y `git diff --check`.

Bloqueo de promocion encontrado en main frontend sin modificar: 19 fallos reproducibles en
AdminReportesAuthorization (1), ClienteAppShell.qa15 (8), PublicBookingFlow.rewardSession.qa18d (7)
y TodoPagoHostedModal (3). No se corrigen en este parche. La suite completa no se declara verde;
   resolver estos contratos en otro cambio antes de aprobar promocion. La topologia del proxy y
las allowlists reales tampoco se activan ni se verifican operativamente en esta tarea local.

Resultados de primera iteracion (2026-11-12): backend completo 2968 total, 2956 PASS, 12 SKIP, 0 FAIL;
harness de acceso 15/15. Frontend focalizado 99/99; Node 65/65; Vitest completo con dos workers
1719 PASS y los mismos 19 FAIL de main descritos arriba. Build frontend PASS. Lint backend:
0 errores y 25 advertencias existentes; lint frontend: 0 errores/advertencias. diff-check limpio
en ambos repositorios. Ninguna ejecucion usa credenciales Live ni red financiera.

## Archivos del diff

Backend: `.env.example`, `src/app.js`, `src/plugins/env.js`, `src/plugins/adminDataEntry.js`,
`src/plugins/privateCommerce.js`, `test/private-commerce.test.mjs`, este documento.
Frontend: `src/App.jsx`, `src/hooks/usePrivateCommerce.js`, `src/hooks/usePrivateCommerce.test.jsx`,
`src/features/landing/pages/LandingPage.jsx` y su test `__tests__/LandingPage.semantics.test.jsx`,
`src/features/public/pages/MembershipPlansPage.jsx` y sus tests
`__tests__/MembershipPlansPage.catalog.test.jsx`, `__tests__/MembershipPlansPage.identity.test.jsx`.
Los servicios, adaptadores, rutas financieras y migraciones no tienen diff.
Rama inicial en ambos repositorios: `feat/private-commerce-pilot-20261112`.

## Cierre de integracion solicitado

El guard se acota a operaciones capaces de crear reservas, intents, ejecutar Sale o recuperar
pagos. La lista explicita MAINTENANCE_ROUTES preserva cancelaciones de membresias cliente/admin,
descartar/liberar holds y operacion administrativa existente (horarios, bloqueos, estados,
llegada/atencion, reagendacion). Mantiene los roles, propiedad y alcance originales: no concede
permisos nuevos ni omite validaciones financieras. Hold administrativo nuevo, confirmar hold y
payment-link siguen cerrados sin piloto. Registro/login/catalogos permanecen accesibles.

Se compone el guard real de cookie firmada y sesion con los fixtures financieros existentes:
crear intent y Sale de reserva culminan con un pago, cita confirmada y hold consumido; orden
VIP e intent HTTP se crean idempotentemente; confirmar-pago HTTP activa una suscripcion y
contabiliza exactamente una vez. Son pruebas por fases sobre SQL en memoria y proveedor
simulado, no un cobro Live ni una certificacion del esquema de produccion. Los contratos
de creacion de holds se cubren adicionalmente por sus pruebas de orquestacion/canonicas.
El callback real recibe dos solicitudes sin sesion desde IPs ajenas con piloto apagado:
responde HTTP 200 y duplicate, conserva evidencia y sigue aplicando sus reglas existentes;
no se interpreta COMPLETED como aprobacion financiera.

Se corrigen las entradas Cliente que aun dependian de CLIENT_BOOKING_ENABLED y
CLIENT_PLAN_PURCHASE_ENABLED usando la misma elegibilidad backend, sin activar flags Vite.
El analisis frontend conserva los 19 mensajes originales: 8 de entrada Cliente eran bloqueo
real y se corrigen; 7 exigen una seleccion automatica inexistente (prueba nueva de seleccion
manual pasa), 3 buscan copy retirado del checkout (prueba nueva del formulario Live simulado
pasa), 1 pertenece a Reportes. No se cambian esas once aserciones ni la logica financiera.

PRs se preparan contra dev preservando sus cambios posteriores. CI mantiene visibles los
contratos heredados que fallan; no se repite localmente la suite completa. La configuracion
operativa del proxy/allowlists requiere verificacion manual antes de activar, sin modificar
produccion en esta tarea. No hay fusion a main ni despliegue autorizados.

## Validacion contra dev actual

Base backend dev: `68051c7`. Se traslada solo el parche del piloto; no la historia divergente
de main. Sobre esta base pasan 366 pruebas backend afectadas (acceso, modo administrativo,
proveedor disabled, callback, reservas, orden/intent/activacion VIP). Lint: 0 errores y 25
advertencias previas. Las pruebas completas de la iteracion inicial no se repiten localmente.

Diferencia previa relevante: dev no contiene la ampliacion de preventa de main para
ADMIN_DATA_ENTRY_MODE=true. El piloto apagado conserva registro/login/catalogos con
ADMIN_DATA_ENTRY_MODE=false; el piloto no cambia la allowlist administrativa de registro
ni la verificacion de exchange. No usar el modo administrativo como interruptor del piloto.
La reversion independiente probada consiste solo en PRIVATE_COMMERCE_PILOT_ENABLED=false,
con PAYMENT_PROVIDER=pixelpay y ADMIN_DATA_ENTRY_MODE=false, conservando la configuracion
existente del callback. Cambiar proveedor a disabled o modo administrativo puede impedir
la conciliacion por controles preexistentes de PaymentProviderFactory; no se relajan aqui.

Mantener bloqueada la activacion hasta verificar proxy real/allowlists y cerrar los contratos
heredados visibles en CI frontend. La comprobacion local positiva es por fases con rutas,
autenticacion y negocio reales sobre fixtures SQL en memoria; no es una prueba Live de PC
ni un recorrido de navegador completo contra el esquema desplegado.
