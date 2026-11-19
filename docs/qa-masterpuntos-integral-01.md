# QA-MASTERPUNTOS-INTEGRAL-01

QA-MASTERPUNTOS-CANJE-GRUPAL-01, documentado al final, reemplaza la prohibicion de combinar canje del titular con acompanantes descrita en la auditoria anterior.

La politica de beneficiarios de INTEGRAL-01 que se documenta a continuacion queda reemplazada, exclusivamente para grupos `cliente_autenticado`, por QA-MASTERPUNTOS-ACOMPANANTES-01 al final de este informe. Las ejecuciones anteriores se conservan como historial.

## Alcance y procedencia

Bases verificadas: backend `ce4694ad0785dd32129260a58fb5a384c4f874a0`, frontend `df83bb521753cff6817890fb5d8ce30e8fc300c3`, ambos `dev`, inicialmente limpios. Se preservaron las modificaciones concurrentes de simulación QA. El checkout original `masterfadebackend` en `ServiciosB`, con cambios ajenos en package.json/package-lock.json, no se modificó: se utilizó el worktree existente de `dev`.

No se accedió a Supabase remoto, ni se ejecutaron reservas, pagos, correos o modificaciones de cuentas reales. Las pruebas crean clusters PostgreSQL 18.6 en loopback y los eliminan al terminar. La estructura se contrastó con las migraciones, el pg_dump local `database/BD-PG.sql` y el fixture de funciones observado previamente en QA (`test/sql/mf118-points-fixture.sql`). No se presenta ese snapshot como una inspección actual de QA.

## Causas y correcciones

- La confirmación Cliente y la confirmación posterior al pago seguían llamando `grantEngagementPointsForConfirmedGroup`. Esa función y su variante para acompañantes resolvían ciclos antes de que la guarda SQL descartara la acreditación prematura; asignaban todos los integrantes al titular. Se retiraron ambas funciones y las tres llamadas. En `public/pagos.js` solo cambia el import y se elimina esa llamada: no se modifican proveedores, cobros, conciliación, webhooks ni correos.
- La función de ciclo de dos argumentos insertaba `vence_at=NULL`. La de tres argumentos usaba `GREATEST(NULL,1)`, que en PostgreSQL produce 1: un mes. Ambas implementaciones se reprodujeron con SQL real extraído del pg_dump local, sin registros personales.
- La propuesta SQL unifica ambos overloads en 12 meses. El trigger usa la fecha de la acreditación efectiva (`now()`), en lugar de la fecha programada de la reserva. Reutiliza y ancla un ciclo vacío al primer movimiento válido. La transición repetida y el movimiento ya existente se comprueban antes de resolver el ciclo.
- La acreditación es de exactamente un punto por cita completada válida: no depende del importe ni de consumos de membresía. Usa el Cliente propio de cada cita; un invitado sin `id_cliente` no genera movimientos, y el titular de un canje tampoco. Se conserva el índice único por cita/tipo y se utiliza el mismo advisory lock transaccional por Cliente que el servicio de canjes.
- Los débitos de canje y los ajustes manuales no se asociaban a un ciclo. Al vencer, el remanente del ciclo podía volver a restar puntos ya consumidos y dejar saldo negativo. Los nuevos movimientos incluyen `id_cycle`. Un ajuste positivo válido obtiene un ciclo dentro de su transacción; un débito solo usa un ciclo existente. No cambian tipos, signos, límites, permisos ni claves de idempotencia.
- Se eliminan los DELETE de acumulaciones históricas al confirmar o repetir un canje. La exclusión de nuevas acreditaciones del titular canjeado corresponde al trigger; las anomalías históricas no se corrigen borrando movimientos automáticamente.
- Se rechazan tokens con segmentos adicionales y la confirmación comprueba también que la sucursal del token corresponda al grupo. La preparación sigue sin descontar; la confirmación inserta exactamente -10 una vez, bajo lock y restricciones únicas. Se conservan la validación de Cliente, servicio, membresía y sucursal.

## Archivos modificados

Backend:

- `src/services/pointsService.js`
- `src/routes/v1/citas.js`
- `src/routes/v1/public/pagos.js` (únicamente retirada de acreditación prematura)
- `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`
- `db/manual/masterpuntos_integral_preflight.sql`
- `test/masterpuntos-integral.postgres.test.mjs`
- `test/sql/masterpuntos-integral-fixture.sql`
- `test/sql/masterpuntos-legacy-functions.sql`
- `test/client-points-rewards.qa-mp-client-02.test.mjs`
- `test/mf118-companions-points.postgres.test.mjs`
- Este informe.

Frontend (exclusivamente pruebas; no se justificó cambiar su implementación funcional):

- `src/features/cliente/pages/__tests__/MasterPuntos.qa18c.test.jsx`
- `src/features/public/booking/__tests__/PublicBookingFlow.rewardSession.qa18d.test.jsx`
- `src/features/plans/components/__tests__/ClienteMembershipFeedback.test.jsx`
- `test/masterpuntosIntegral.browser.mjs`

## Migración propuesta: pendiente de aplicación manual

Archivos:

- `db/manual/masterpuntos_integral_preflight.sql`: consultas de solo lectura sobre funciones, triggers, índices, reglas y cantidades de anomalías. Probado en PostgreSQL aislado. No devuelve datos personales.
- `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`: generado con `supabase migration new`, conservado en `db/manual` para evitar aplicación automática. Transacción DDL con preflight y timeout de bloqueo. Solo sustituye funciones; no contiene backfill ni UPDATE masivo de reglas, ciclos o transacciones.

La regla `expiracion_meses=NULL` permanece intacta; las nuevas funciones la interpretan como doce meses. No se cambia silenciosamente una regla explícita distinta: el preflight exige revisar cualquier configuración activa incompatible con 1 punto / 10 puntos / 12 meses.

Antes de aplicar en un entorno autorizado: ejecutar el preflight de lectura, comparar las firmas y triggers efectivos y conservar las definiciones previas (`pg_get_functiondef`) y sus permisos para reversión DDL. El script de aplicación vuelve a comprobar las dependencias. Se detiene ante falta de guardas/índices, ciclos activos múltiples, ciclos con movimientos sin vencimiento o con plazo distinto, y débitos históricos sin ciclo junto a créditos activos que no superen la prueba conservadora de compensación y separación temporal descrita en PREFLIGHT-02. Esas anomalías requieren decisión explícita sobre el historial; este ticket no autoriza recalcular saldos. Un ciclo previo vacío se reancla únicamente durante una acreditación nueva, sin alterar movimientos anteriores.

La migración **no fue aplicada en QA ni en Producción**. Hasta su revisión y aplicación manual no está certificado el comportamiento de los triggers desplegados. Un push del backend no sustituye las funciones de Supabase.

## Matriz de cobertura local

| Caso | Archivo / prueba | Resultado |
|---|---|---|
| Dos overloads defectuosos y doble vencimiento anterior | `masterpuntos-integral.postgres.test.mjs`, dos reproducciones iniciales | PASS, defectos reproducidos |
| Completar con L0/L300, con/sin membresía | Misma suite, acreditación y controladores reales | PASS |
| Titular, dos acompañantes registrados e invitado | Misma suite, identidad propia | PASS |
| Confirmada, estados no elegibles, eliminada y titular canjeado | Misma suite, exclusiones | PASS |
| Reintentos y concurrencia sobre una o varias citas | Misma suite, acreditación única y ciclo compartido | PASS |
| 0/9/10/11/20, membresía, servicio y sucursal | Misma suite, resumen y preparación | PASS |
| Canje duplicado y dos canjes concurrentes | Misma suite, una deducción y rechazo por saldo | PASS |
| Token inválido, sufijo, vencido, Cliente/grupo/sucursal ajenos | Misma suite, sin consumo | PASS |
| Intento pendiente, rollback de canje/finalización | Misma suite, conserva puntos y no deja ciclo vacío | PASS |
| Ciclos vacíos, vencimiento, nuevos ciclos y fecha antigua de reserva | Misma suite, plazo anual desde acreditación | PASS |
| Ajustes manuales +9/-4 y repetición idempotente | Misma suite, remanente al vencer y conservación de historial | PASS |
| Finalizar atención / PATCH Completada | Misma suite, rutas y autenticación reales con sesiones sintéticas | PASS |
| Dos Clientes y rechazo por rol/sucursal | Misma suite, aislamiento y estado sin modificar | PASS |
| Lectura de preflight y bloqueo de historial inconsistente | Misma suite, sin corrección automática | PASS |
| MasterPuntos administrativo, guardas de comercio, membresías y reservas | 15 suites backend listadas abajo | 291 PASS |
| Regresiones PostgreSQL de acompañantes, planes y transiciones | 3 suites existentes | 23 PASS |
| Saldo, progreso, historial, recarga, identidad y canje | Suites frontend de MasterPuntos/recompensas | 163 PASS |
| Acompañantes y membresías frontend | Suites frontend adicionales | 65 PASS |
| App compilada, 390/1440, oscuro/claro, comercio habilitado/pausado | `test/masterpuntosIntegral.browser.mjs` (frontend), Chrome instalado | 8 PASS |

Suite integral PostgreSQL: **19/19 PASS** (incluye el contenedor principal). Total backend ejecutado: **333 PASS**, sin skips. Frontend: **228 Vitest PASS**, más **8 escenarios de navegador PASS**. No se afirma ejecución de la suite global completa.

Se ajustaron dos fixtures frontend obsoletos: el helper de `PublicBookingFlow.rewardSession.qa18d.test.jsx` ahora selecciona explícitamente el servicio; `ClienteMembershipFeedback.test.jsx` declara la elegibilidad comercial habilitada que requiere su escenario sintético. Los primeros intentos mostraron respectivamente 7 y 3 fallos de preparación; tras corregir esos fixtures, las suites pasan. No se modificó código funcional frontend, ni PixelPay/TodoPago, para conseguir ese resultado. Las pausas se prueban con el guard backend real y con la App compilada.

## Comandos ejecutados

Con `MASTERFADE_PHASE02_PG_BIN` apuntando a los binarios PostgreSQL externos ya instalados:

```powershell
node --test test/masterpuntos-integral.postgres.test.mjs
node --test test/mf118-companions-points.postgres.test.mjs test/agenda-phase02.postgres.test.mjs test/cliente-plan-consumptions.postgres.test.mjs
node --test test/client-points-rewards.qa-mp-client-02.test.mjs test/admin-points-rewards-permissions.qa15b.test.mjs test/admin-points-branch-scope.qa15a.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs test/admin-masterpoints-reads.qa15.test.mjs test/private-commerce.test.mjs test/canonical-booking.integration.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs test/membership-purchase-branch-operability.test.mjs test/admin-booking-service.test.mjs test/microfase2a-booking.test.mjs test/booking-hold-orchestration.test.mjs test/booking-hold-route-orchestration.test.mjs
```

Frontend:

```powershell
npx vitest run src/features/cliente/pages/__tests__/MasterPuntos.qa18b.test.jsx src/features/cliente/pages/__tests__/MasterPuntos.qa18c.test.jsx src/features/admin/pages/__tests__/AdminMasterPuntosPage.qa18.test.jsx src/features/admin/pages/__tests__/AdminMasterPuntosPage.reads.qa15.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardSession.qa18d.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardIdentity.qa18d.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardToken.preintegration.test.jsx
npx vitest run src/features/public/booking/__tests__/bookingCompanions.mf118.test.jsx src/features/plans src/features/cliente/pages/__tests__/ClientePlanes.pagination.test.jsx src/features/cliente/lib/__tests__/clienteApi.plan-consumptions.test.js src/features/cliente/lib/__tests__/clienteApi.membership-order.test.js src/features/admin/pages/__tests__/MembershipMounted.qa14b.test.jsx src/features/admin/pages/__tests__/MembershipRequests.qa14b.test.js src/features/admin/pages/__tests__/MembershipExports.qa14b.test.js
npm run build
node --test test/masterpuntosIntegral.browser.mjs
```

Navegador: `MASTERFADE_PLAYWRIGHT_MODULE` al runtime externo existente; `MASTERFADE_CHROMIUM_CHANNEL=chrome`; `MASTERFADE_BROWSER_URL=http://127.0.0.1:4189`. APIs externas exclusivamente sintéticas; se rechaza cualquier escritura distinta de preparación de recompensa y mantenimiento de sesión. Capturas en `%TEMP%/mf-masterpuntos-integral-evidence`. Se comprueban saldo/progreso/recompensas para los cinco saldos, cambio de sucursal, error claro, preparación sin descuento, acceso directo pausado sin modal ni canje, ausencia de efectos comerciales y desbordamiento.

ESLint de todos los JS/JSX/MJS afectados, `node --check` de los tres archivos funcionales backend y `git diff --check`: PASS. Backend no declara script de build. Build frontend PASS, con aviso existente de chunks mayores de 500 kB.

## Pendientes para certificar QA

- Inspección actual de metadatos/configuración y decisión sobre anomalías históricas que señale el preflight. Sin esos resultados no puede certificarse la base remota.
- Aplicación manual autorizada de la propuesta SQL y verificación posterior de ambos controles reales de finalización. No se realizó despliegue manual.
- Verificación controlada de servicios de recompensa configurados por sucursal y condición de membresía. Si no hay servicios autorizados, se conserva el mensaje de ausencia y el bloqueo de canje; no se inventa oferta ni se elimina `REWARD_REDEEM_REQUIRED`.
- Dispositivos físicos y datos reales no probados. El navegador ejecutado es Chrome local automatizado, no un iPhone físico ni WebKit.


## QA-MASTERPUNTOS-PREFLIGHT-02 — 13/11/2026

### Causa y evidencia

La condición anterior de `MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED` solo verificaba la existencia de un débito sin ciclo y de algún crédito en el ciclo activo del mismo Cliente. No consideraba la cronología ni la compensación del histórico. Por ello rechazaba también un bloque anterior de +10/-10 completamente cerrado, aunque el ciclo vigente contuviera únicamente +1 y el saldo efectivo fuera 1.

La evidencia QA suministrada por el usuario identifica un canje del 08/11/2026 y un ciclo del 12/11/2026. **No se consultó ni modificó Supabase remoto en este ticket.** La reproducción aislada conserva esa separación de cuatro días con fechas relativas al reloj del cluster, para que la prueba no caduque al ejecutarse en otro año. Las comprobaciones se realizan en UTC y America/Tegucigalpa.

### Condiciones exactas de la excepción segura

Se revisan únicamente los Clientes afectados por el bloqueo de débitos sin ciclo y créditos activos. Un tipo de débito NULL o un vencimiento sin ciclo también se trata como ambiguo y no se omite del diagnóstico. No existe una excepción por UUID, nombre, sucursal ni fecha específica.

Para cada Cliente y ciclo deben cumplirse **todas** estas condiciones:

1. Exactamente un ciclo activo, anual, con fechas finitas, ya iniciado y sin vencer. Los controles anteriores de funciones, triggers, índices y reglas permanecen activos.
2. Se considera **todo** el historial sin ciclo de ese Cliente: no se selecciona una pareja conveniente omitiendo otros movimientos. Su suma firmada debe ser exactamente cero.
3. Créditos históricos conocidos (`acumular`/`ajustar`, signo +1), débitos conocidos (`ajuste_resta`, signo -1) o canjes de exactamente -10 (`canjear`, signo -1). Tipos desconocidos, nulos o con signo incompatible no califican. Un vencimiento sin ciclo tampoco califica.
4. Fechas de creación y modificación presentes, finitas y coherentes. Ambas deben quedar estrictamente antes del inicio del ciclo actual. Una edición posterior de un movimiento antiguo mantiene el bloqueo. Los históricos sin ciclo no pueden tener vencimientos individuales ambiguos.
5. Orden temporal inequívoco: no se resuelven empates arbitrariamente mediante el UUID. Ningún prefijo cronológico puede quedar negativo; un débito anterior al crédito que supuestamente lo compensa exige revisión.
6. No hay movimientos de otros ciclos del Cliente, aunque su suma resulte cero. Esos casos quedan para revisión; no se infieren asociaciones entre ciclos históricos.
7. Los movimientos asociados al ciclo actual pertenecen al mismo Cliente, tienen fechas y tipos/signos verificables, y no preceden su inicio. No se aceptan mezclas de identidades ni un saldo de ciclo negativo.
8. El total firmado del ledger, el remanente firmado del ciclo actual y la vista de saldo efectivo coinciden exactamente. Para el caso suministrado los tres valores son 1.

Estas condiciones prueban que el bloque sin ciclo aporta cero y está separado del ciclo actual. **No se asignan ciclos a movimientos antiguos, no se cambian puntos, no se corrigen fechas y no se aplican nuevos saldos.** Las sumas son comparaciones de solo lectura, no una regularización del ledger.

El diagnóstico y la migración contienen la misma CTE marcada `HISTORICAL_DEBITS_PROOF`; una prueba exige su igualdad textual. El reporte de lectura añade, por Cliente/ciclo, los importes de comprobación, los límites temporales, `historico_compensado_seguro` y `motivos_revision`. Un solo Cliente con motivos pendientes mantiene el bloqueo global de la migración.

### Concurrencia y reversión

La aplicación manual adquiere locks SHARE sobre transacciones, ciclos, tipos y reglas antes del preflight definitivo. Las lecturas continúan disponibles, pero las escrituras concurrentes esperan mientras se evalúa y aplica el script. Se limita la espera de locks a 5 segundos y cada sentencia a 30 segundos. Un timeout o cualquier error obliga a abortar; no se reintenta omitiendo el control.

Prueba concurrente real: una conexión deja una nueva acreditación sin ciclo sin confirmar; otra intenta aplicar la migración y queda esperando el lock del ledger. Al confirmar la primera conexión, la migración evalúa el nuevo estado, rechaza la inconsistencia y conserva datos y definiciones. No utiliza una comprobación anterior potencialmente obsoleta.

Procedimiento manual, todavía pendiente en QA:

1. Ejecutar el archivo de lectura en la base QA autorizada y revisar las columnas temporales, las tres magnitudes de saldo y los motivos de **todos** los Clientes afectados. El caso reportado solo puede admitirse si también cumple las condiciones de metadatos anteriores, no solo por sumar 0.
2. Conservar las definiciones y permisos previos de las funciones de INTEGRAL-01 mediante `pg_get_functiondef`, y la versión revisada de ambos archivos SQL. No aplicar junto con otros cambios DDL concurrentes.
3. Ejecutar el script completo dentro de su transacción. El script repite la prueba bajo locks; el reporte previo no sustituye ese control. Ante error, ejecutar ROLLBACK y detenerse sin alterar el historial para lograr aprobación.
4. Antes de COMMIT puede abortarse con ROLLBACK. La suite ejecuta la migración completa sustituyendo únicamente su COMMIT final por ROLLBACK y verifica que todas las definiciones previas y todos los datos se conservan.
5. Respecto a `89cab62`, este ticket cambia únicamente el preflight y los locks del script manual; no añade funciones ni modifica sus cuerpos. El script completo sigue incluyendo las definiciones ya propuestas en INTEGRAL-01. Para retirar PREFLIGHT-02 basta restaurar mediante un cambio revisado el fragmento de comprobación anterior de `89cab62`, sin copiar archivos completos sobre trabajo concurrente. El caso compensado volvería a quedar bloqueado, pero no hay datos que revertir. **Reaplicar el script antiguo completo no es un procedimiento de reversión.**
6. Si ya se aplicaron las funciones de INTEGRAL-01 y se requiere revertirlas, esa reversión DDL debe usar exclusivamente las definiciones originales capturadas, dentro de otra transacción revisada. No se borran ni reasignan movimientos ni se compensan saldos como parte de la reversión.

### Archivos y validación de PREFLIGHT-02

- `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`: condición histórica y locks; cuerpos de funciones posteriores al preflight intactos.
- `db/manual/masterpuntos_integral_preflight.sql`: clasificación explicada mediante la misma prueba de solo lectura.
- `test/masterpuntos-integral.postgres.test.mjs`: caso informado, casos negativos, preservación completa, reversión DDL y concurrencia con PostgreSQL real.
- Este informe.

Las pruebas comparan JSONB de todas las columnas de movimientos y ciclos, más la vista de saldos, antes y después del diagnóstico, del rechazo y de la aplicación completa aceptada. Las fechas se comparan con sesiones UTC para evitar confundir dos representaciones horarias del mismo instante. También se verifica la reversión de las definiciones de funciones. La limpieza de datos pertenece únicamente al cluster local efímero y sus UUID aleatorios.

Comandos de esta revisión:

```powershell
$env:MASTERFADE_PHASE02_PG_BIN='C:\ruta\binarios-postgresql-aislados'
node --test test/masterpuntos-integral.postgres.test.mjs
node --test test/client-points-rewards.qa-mp-client-02.test.mjs test/admin-points-rewards-permissions.qa15b.test.mjs test/admin-points-branch-scope.qa15a.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs test/admin-masterpoints-reads.qa15.test.mjs
npx eslint test/masterpuntos-integral.postgres.test.mjs
node --check test/masterpuntos-integral.postgres.test.mjs
git diff --check
```

No hay cambios en frontend, endpoints, autenticación, reservas, pagos ni reglas comerciales. Backend no declara script de build; se validan SQL real, sintaxis JavaScript y ESLint. Los resultados históricos de INTEGRAL-01 de las secciones anteriores se mantienen como registro de esa ejecución, no como una nueva certificación remota.


Resultados finales de PREFLIGHT-02: **46/46 pruebas PostgreSQL PASS** (incluye las regresiones integrales existentes y contenedores de Node), **91/91 regresiones de MasterPuntos PASS**, sin fallos ni omisiones. ESLint, `node --check` y `git diff --check`: PASS. Se confirmó también que el contenido de todas las funciones después del bloque `$preflight$` es idéntico al de `89cab62`, normalizando únicamente finales de línea. La certificación de QA remoto continúa pendiente del preflight real y de la aplicación manual autorizada.

## QA-MASTERPUNTOS-ACOMPANANTES-01 — 13/11/2026

### Causa y cambio de atribucion

La propuesta manual pendiente resolvia al beneficiario desde `citas.id_cliente`. En grupos autenticados esto acreditaba a un acompanante registrado y omitía al invitado sin cuenta. La nueva regla autorizada utiliza exclusivamente `citas_grupos.id_cliente_titular` cuando `origen_codigo='cliente_autenticado'`, tanto en `fn_trg_otorgar_puntos_por_cita` como en `fn_points_tx_guard_acumular_final`.

Cada cita individual elegible que pasa efectivamente a `completada` genera +1 al titular, independientemente de importe o membresia. Se mantiene la exclusion del titular cubierto por recompensa, de citas eliminadas y de estados no completados. Las citas de acompanantes conservan su identidad, contacto, grupo, sucursal, barbero y horario. El origen contable `integrante` sigue diferenciando el punto generado por acompanantes en el saldo del titular.

Un grupo autenticado sin titular no utiliza al acompanante como reemplazo. Para otros origenes y citas sin grupo se conserva la atribucion individual anterior; un invitado publico sin Cliente sigue sin generar puntos automaticamente para otra persona. No se religa una identidad por correo.

Se conservan el advisory lock transaccional por beneficiario, el indice unico cita/tipo, el chequeo de movimiento previo antes de crear un ciclo y los ciclos de 12 meses desde la primera acreditacion valida. No hay backfill, transferencias, recalculo de saldos, cambios de fechas ni reasignacion de movimientos existentes. Una cita historica con punto existente nunca produce otro al reaplicar el script o reintentar su estado.

### Correo y privacidad

`POST /v1/public/citas/validar-contactos` ya normaliza y valida el formato del correo y rechaza contactos repetidos dentro de la reserva. Se conserva ese comportamiento. Si se presenta el correo de un acompanante, la respuesta valida incluye un aviso informativo `COMPANION_POINTS_POLICY`, identico para correos registrados y nuevos, sin bloquear la reserva ni devolver identidades o indicadores de existencia de cuentas.

Se mantiene deliberadamente la ausencia de consultas por correo: consultar la existencia y cambiar el aviso segun el resultado permitiria enumerar cuentas desde esta ruta publica. Se prueban correos realmente registrados en el cluster sintetico y correos nuevos; la respuesta es la misma. Otra prueba rechaza cualquier query de identidad y verifica cero consultas. Los conflictos de email, telefono y DNI conservan sus respuestas 409; un formato invalido conserva 400. No se modifica autenticacion ni se permite eludir los guards de comercio.

El frontend muestra ese aviso, con deduplicacion, al avanzar al resumen desde una cuenta autenticada. El resumen conserva una nota permanente sobre la atribucion al titular, incluyendo acompanantes con y sin cuenta. El texto publico anterior permanece intacto. No se cambian importes, cobertura, seleccion de servicios, canjes ni contactos.

### SQL pendiente y preflight

Se actualiza el mismo archivo manual `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`, todavia no aplicado remotamente. Se exige que existan los tres metadatos de grupo antes de cambiar las funciones. La prueba historica `HISTORICAL_DEBITS_PROOF`, locks y todos los bloqueos de PREFLIGHT-02 permanecen intactos; se repiten las pruebas de casos seguros, ambiguos, inconsistentes, rollback y concurrencia.

El reporte de solo lectura compara el beneficiario con el titular en grupos autenticados y con el Cliente individual en los otros origenes. Un movimiento historico atribuido bajo la politica anterior puede aparecer como diferencia; el reporte no lo corrige ni lo transfiere.

La aplicacion requiere revision y ejecucion manual autorizada del script completo, incluyendo preflight. Este ticket no ejecuta SQL en Supabase remoto. El push del backend no actualiza funciones de PostgreSQL. Para revertir antes de COMMIT se usa ROLLBACK. Despues, cualquier reversion DDL debe usar las definiciones previamente capturadas con `pg_get_functiondef`, dentro de otra transaccion revisada; no reaplicar ciegamente un script anterior ni borrar/transferir puntos generados.

### Auditoria de titular con 10 puntos y acompanantes

Se conserva un bloqueo comercial comprobado:

- `resolveRewardRedeemGateForCliente`, probado con SQL real, exige canje a partir de 10 puntos. `/v1/citas/hold` devuelve `REWARD_REDEEM_REQUIRED` si no se presenta contexto de canje.
- Con contexto de canje, el validador real `assertRewardRedeemExclusiveHold` rechaza 1-4 acompanantes con `POINTS_REDEEM_COMPANIONS_NOT_ALLOWED`. Esta segunda comprobacion se ejecuta sobre la funcion original extraida en una prueba aislada, no sobre un nuevo handler sustituto.
- Por tanto, el titular con 10 puntos no puede combinar la reserva grupal y el canje en una sola operacion bajo las reglas vigentes. No se modifica esa obligacion ni se fuerza un consumo, una reserva o un cobro. Resolver esta incompatibilidad requiere otra decision comercial autorizada.

### Cobertura y comandos locales

| Caso | Suite | Resultado |
|---|---|---|
| 1-4 acompanantes registrados, invitados y mixtos; con/sin membresia | `test/masterpuntos-integral.postgres.test.mjs` | PASS, 24 combinaciones, +2/+3/+4/+5 solo al titular |
| Cliente de acompanante, tercero, grupo sin titular | Misma suite, guarda SQL | PASS, no atribucion ajena |
| Concurrencia/reintentos, ledger previo, ciclo anual e identidades intactas | Misma suite | PASS, sin duplicados ni transferencias |
| Finalizar atencion y cambio administrativo Completada sobre invitados/registrados | Misma suite, controladores y SQL reales | PASS |
| Cancelaciones, no_show, estados pendientes y titular canjeado | Misma suite | PASS, exclusiones conservadas |
| Metadatos de grupo ausentes y todos los casos PREFLIGHT-02 | Misma suite | PASS, bloqueos/rollback conservados |
| Correos registrados/nuevos y duplicados | Misma suite + `test/public-guest-contact-qa02f.test.mjs` | PASS, aviso uniforme, cero lookup de identidad |
| Saldo, canjes, servicios permitidos, sucursales, planes, reservas y comercio pausado | Suites backend existentes | PASS |
| Nota de grupo autenticado con 1-4 acompanantes y membresia; resumen publico | `bookingCompanions.mf118.test.jsx` | PASS |
| Saldos, progreso, historial, canje, identidad y membresias | 11 suites Vitest | PASS, 195 pruebas |
| App compilada, 1-4 acompanantes, correos, aviso y resumen, sin holds/pagos | `test/companionsMf118.browser.mjs` | PASS, 10 escenarios 390/1440 px |
| Comercio habilitado/pausado, saldos 0/9/10/11/20, sucursal y errores | `test/masterpuntosIntegral.browser.mjs` | PASS, 8 escenarios 390/1440 px, ambos temas |

```powershell
$env:MASTERFADE_PHASE02_PG_BIN='C:\ruta\binarios-postgresql-aislados'
node --test test/masterpuntos-integral.postgres.test.mjs test/public-guest-contact-qa02f.test.mjs test/mf118-companions-points.postgres.test.mjs test/agenda-phase02.postgres.test.mjs test/cliente-plan-consumptions.postgres.test.mjs
node --test test/client-points-rewards.qa-mp-client-02.test.mjs test/admin-points-rewards-permissions.qa15b.test.mjs test/admin-points-branch-scope.qa15a.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs test/admin-masterpoints-reads.qa15.test.mjs test/private-commerce.test.mjs test/canonical-booking.integration.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs test/membership-purchase-branch-operability.test.mjs test/admin-booking-service.test.mjs test/microfase2a-booking.test.mjs test/booking-hold-orchestration.test.mjs test/booking-hold-route-orchestration.test.mjs
```

Backend: 129 pruebas SQL/contactos/transiciones/planes + 291 regresiones = 420 PASS, sin omisiones. PostgreSQL 18.6 real en clusters efimeros locales; las sesiones de autenticacion son fixtures aislados. Los contactos se prueban con el controlador real y pago deshabilitado; la excepcion de simulacion QA solo se habilita en la configuracion sintetica del test para permitir su validacion. La pausa comercial normal se prueba por separado con el guard original. No se altera ninguna variable de entorno del proyecto o despliegue.

Frontend:

```powershell
npx vitest run src/features/cliente/pages/__tests__/MasterPuntos.qa18b.test.jsx src/features/cliente/pages/__tests__/MasterPuntos.qa18c.test.jsx src/features/admin/pages/__tests__/AdminMasterPuntosPage.qa18.test.jsx src/features/admin/pages/__tests__/AdminMasterPuntosPage.reads.qa15.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardSession.qa18d.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardIdentity.qa18d.test.jsx src/features/public/booking/__tests__/PublicBookingFlow.rewardToken.preintegration.test.jsx src/features/public/booking/__tests__/bookingCompanions.mf118.test.jsx src/features/plans/components/__tests__/ClienteMembershipFeedback.test.jsx src/features/cliente/pages/__tests__/ClientePlanes.pagination.test.jsx src/features/cliente/lib/__tests__/clienteApi.plan-consumptions.test.js
npm run build
$env:MASTERFADE_PLAYWRIGHT_MODULE='C:\ruta\runtime-externo\node_modules\playwright'
$env:MASTERFADE_CHROMIUM_CHANNEL='chrome'
$env:MASTERFADE_BROWSER_ENGINES='chromium'
$env:MASTERFADE_BROWSER_URL='http://127.0.0.1:4189'
node --test test/companionsMf118.browser.mjs test/masterpuntosIntegral.browser.mjs
```

Las APIs del navegador se interceptan con respuestas sinteticas; App, React Router, hooks y resumen son reales. Se impide cualquier escritura de hold o pago. Los fixtures disponen de horarios suficientes para cinco personas y esperan el panel activo al terminar su animacion; los intentos iniciales seleccionaban botones del panel saliente. Se corrigio la automatizacion y no se altero la agenda para ocultar esos fallos.

Pendientes: revisar preflight en QA y aplicar manualmente la propuesta autorizada; certificar despues los triggers y metadatos efectivos. No se realizaron cobros, reservas reales, pruebas sobre cuentas reales, OAuth/correos reales ni dispositivos fisicos. WebKit no ejecutado; no se presenta la emulacion movil de Chrome como un iPhone real.

Resultado final: **18/18 escenarios Chrome PASS**, sobre el build compilado, sin excepciones JavaScript, desbordamiento horizontal ni operaciones de hold/pago en los recorridos de acompanantes. Se revisaron las capturas reales de 390 px oscuro y 1440 px claro con cuatro acompanantes; evidencia local en `%TEMP%/mf-points-companions-evidence`. **ESLint de todos los archivos JS/JSX/MJS afectados, sintaxis Node y `git diff --check`: PASS. Build frontend: PASS**, con el aviso existente de chunks mayores de 500 kB. Backend no declara script de build. No se afirma la ejecucion de toda la suite global ni certificacion remota.

Archivos de ACOMPANANTES-01 (los listados anteriores corresponden a tickets previos):

- Backend: `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`, `db/manual/masterpuntos_integral_preflight.sql`, `src/routes/v1/public/citas.js`, `test/masterpuntos-integral.postgres.test.mjs`, `test/public-guest-contact-qa02f.test.mjs`, `test/sql/masterpuntos-integral-fixture.sql` y este informe.
- Frontend: `src/features/public/booking/PublicBookingFlow.jsx`, `src/features/public/booking/PublicBookingConfirmStep.jsx`, `src/features/public/booking/__tests__/bookingCompanions.mf118.test.jsx`, `test/companionsMf118.browser.mjs`.

## QA-MASTERPUNTOS-CANJE-GRUPAL-01 — 13/11/2026

### Alcance y causas reproducidas

Bases de dev verificadas limpias y sincronizadas: backend `fa98cecbb51e0c9594774762df1fb70513932d47`, frontend `815f8fea22de3efe206d1d3386e95946d54f78b0`. Se conserva la atribucion al titular de ACOMPANANTES-01.

1. El hold autenticado rechazaba cualquier grupo con contexto de recompensa mediante `POINTS_REDEEM_COMPANIONS_NOT_ALLOWED`. Se retira exclusivamente esa prohibicion. Se valida el orden secuencial de integrantes para impedir que una solicitud manipulada haga tratar a varios integrantes como titulares; devuelve 400 `POINTS_REDEEM_GROUP_ORDER_INVALID` sin crear operaciones. La prueba anterior reproducía un rechazo SQL con 500; ahora se valida antes del calculo y persistencia.
2. Se reprodujo `POINTS_REDEEM_SERVICE_AMBIGUOUS` con dos servicios elegibles del titular de igual precio: el pago sintetico estaba registrado, pero la confirmacion no podia identificar el servicio canjeado. La finalizacion ahora utiliza el descuento persistido por linea para identificar una unica candidata. Conserva la resolucion anterior para registros historicos sin ese dato y el rechazo ante ambiguedad real. No reescribe datos ni asigna servicios arbitrariamente.
3. El resumen podia presentar el importe de recompensa dentro de Descuento y otra vez como Cubierto por recompensa. Se separa visualmente la cobertura de los otros descuentos; el total del hold sigue siendo autoridad. Se explican los 10 puntos al confirmar, el saldo de extras/acompanantes y los puntos futuros de citas completadas elegibles.

### Contratos conservados

- Solo el servicio elegible seleccionado del titular recibe la recompensa. Los extras del titular y todos los servicios de acompanantes mantienen su precio configurado. No se aplica cobertura de membresia simultaneamente a la recompensa; tampoco se habilitan promociones incompatibles ni paquetes del titular.
- La construccion canonica del hold, sus lineas, el total de grupo y los precios del intento/confirmacion no se modifican. Las pruebas comparan el total de respuesta con citas y detalles persistidos y con el importe del intento y del proveedor externo simulado. Un intento con importe divergente se rechaza antes de registrar pago/consumir puntos.
- Se mantiene el canje obligatorio a partir de 10 puntos. Preparar y crear hold/intent no debita. Solo confirmar descuenta exactamente 10 una vez; fallos, pendientes y expiraciones no consumen. Reintentos y concurrencia conservan su idempotencia.
- La cita canjeada del titular no acredita puntos al completarse, incluso con extras. Cada cita elegible completada de acompanante acredita +1 al titular mediante el SQL pendiente de ACOMPANANTES-01; canceladas y no_show no acreditan. No se acreditan puntos a las cuentas de acompanantes.
- Roles, pertenencia, sucursal, elegibilidad por membresia, guards administrativos y comercio privado permanecen intactos. Ninguna ruta o proveedor se habilita en despliegues pausados.

Endpoints cuyos comportamientos se verificaron con sus controladores originales: `POST /v1/citas/hold`, `POST /v1/citas/hold/:id_grupo_cita/confirmar`, `POST /v1/pagos/reservas/crear-intent`, `POST /v1/pagos/reservas/estado`. La confirmacion pagada aislada utiliza exclusivamente el endpoint mock existente en una App de prueba, sin pasarela ni tarjeta. No se modifica `public/pagos.js`, PixelPay ni TodoPago.

### Integracion aislada

La nueva suite `test/masterpuntos-group-redeem.postgres.test.mjs` crea un PostgreSQL 18.6 efimero, limitado a loopback. Carga el esquema sintetico existente, las migraciones originales de reserva canonica/idempotencia/confirmacion, los triggers originales y la propuesta manual pendiente. Todas esas ejecuciones SQL ocurren solamente en el cluster local, que se elimina al terminar.

Fastify utiliza rutas, autenticacion criptografica, guardas de rol y servicios reales. Solo los perfiles/sesiones y el proveedor externo son fixtures; ningun handler comercial es sustituido. El proveedor de prueba registra los argumentos de creacion de intento y no ejecuta cobros. La confirmacion mock escribe y confirma exclusivamente pagos sinteticos con las funciones SQL originales. Las notificaciones tambien quedan en la base aislada; no existe transporte SMTP real.

La App de prueba habilitada excluye los guards de pausa para ejercitar los controladores comerciales con el proveedor mock. Una segunda App incorpora los guards originales, `adminDataEntryMode=true`, `paymentProvider=disabled` y piloto privado deshabilitado: hold, confirmacion, intent, pago y preparacion de canje se rechazan antes de cualquier consulta SQL o efecto secundario. Las suites existentes de privateCommerce y adminDataEntry se ejecutan adicionalmente. Esto no cambia configuracion del workspace ni del despliegue.

### Cobertura local

| Caso | Archivo/test | Resultado |
|---|---|---|
| 10/20 puntos, VIP/sin VIP, 1-4 acompanantes registrados o invitados | Nueva suite PostgreSQL: 32 combinaciones | PASS |
| 9 puntos, VIP/sin VIP, 1-4 acompanantes | Misma suite: 8 combinaciones normales, preparacion rechazada | PASS |
| Extras del titular, servicio canjeado unico, total de hold/intent/confirmacion | Misma suite, consultas y RPC originales | PASS |
| Contexto preparado, pago pendiente, fallido, expirado y hold vencido | Misma suite | PASS, sin descuento prematuro |
| Total cero individual y grupos 1-4 con tarifas sinteticas cero para acompanantes | Misma suite | PASS, confirmacion sin intent y un solo debito |
| Reintentos/concurrencia de confirmacion y finalizacion | Misma suite + suite integral anterior | PASS, sin duplicados |
| Token ajeno/invalido, propietario ajeno, servicio ausente, paquetes del titular, orden duplicado e importe adulterado | Misma suite | PASS, sin consumo ni operacion indebida |
| Cancelaciones, no_show, titular canjeado y finalizacion de acompanantes | Misma suite + integral anterior | PASS |
| Dos servicios elegibles de igual precio | Misma suite | PASS tras reproducir y corregir ambiguedad |
| Ausencia de recompensa elegible y recompensa de tarifa cero | Misma suite | PASS, bloqueos conservados |
| Rechazo del comercio pausado antes de SQL | Misma suite + privateCommerce/adminDataEntry existentes | PASS |
| Resumen de grupo con/sin hold, cobertura unica, importe y puntos futuros | `bookingCompanions.mf118.test.jsx` | PASS |
| 10 puntos sin servicios disponibles | `MasterPuntos.qa18c.test.jsx` | PASS, aviso y boton deshabilitado |
| App compilada, router/hooks/resumen originales, 1-4 acompanantes con/sin recompensa | `companionsMf118.browser.mjs` | PASS, 18 escenarios 390/1440 px |
| Saldos, servicios, errores y comercio habilitado/pausado | `masterpuntosIntegral.browser.mjs` | PASS, 8 escenarios 390/1440 px, ambos temas |

Comandos SQL/contactos y regresiones (el runtime PostgreSQL externo debe indicarse mediante `MASTERFADE_PHASE02_PG_BIN`):

```powershell
node --test test/masterpuntos-group-redeem.postgres.test.mjs test/masterpuntos-integral.postgres.test.mjs test/public-guest-contact-qa02f.test.mjs test/mf118-companions-points.postgres.test.mjs test/agenda-phase02.postgres.test.mjs test/cliente-plan-consumptions.postgres.test.mjs
node --test test/client-points-rewards.qa-mp-client-02.test.mjs test/admin-points-rewards-permissions.qa15b.test.mjs test/admin-points-branch-scope.qa15a.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs test/admin-masterpoints-reads.qa15.test.mjs test/private-commerce.test.mjs test/canonical-booking.integration.test.mjs test/membership-financial-security.test.mjs test/membership-purchase-order-idempotency.test.mjs test/membership-purchase-branch-operability.test.mjs test/admin-booking-service.test.mjs test/microfase2a-booking.test.mjs test/booking-hold-orchestration.test.mjs test/booking-hold-route-orchestration.test.mjs test/admin-data-entry-mode.test.mjs
```

Frontend: las mismas 11 suites Vitest enumeradas en ACOMPANANTES-01; se amplian las pruebas de resumen y ausencia de servicios. Navegador: el mismo comando de ACOMPANANTES-01, con `MASTERFADE_CHROMIUM_CHANNEL=chrome`, `MASTERFADE_BROWSER_ENGINES=chromium`, runtime Playwright externo y preview local compilado en 4189. Se interceptan exclusivamente APIs externas; no hay holds, intents o cobros reales en navegador. Capturas en `%TEMP%/mf-points-companions-evidence/*-reward-true.png`.

Archivos backend: `src/routes/v1/citas.js`, `src/services/pointsService.js`, `test/masterpuntos-group-redeem.postgres.test.mjs`, `test/masterpuntos-integral.postgres.test.mjs`, `test/public-guest-contact-qa02f.test.mjs`, `test/sql/masterpuntos-integral-fixture.sql` y este informe. El fixture anterior incorpora la columna fiscal de descuento que ya existe en el esquema real y se usan inserts de columnas explicitas.

Archivos frontend: `src/features/public/booking/PublicBookingConfirmStep.jsx`, `src/features/public/booking/__tests__/bookingCompanions.mf118.test.jsx`, `src/features/cliente/pages/__tests__/MasterPuntos.qa18c.test.jsx`, `test/companionsMf118.browser.mjs`.

### Bloqueos y pendientes reales

- Con 10 o mas puntos y sin servicios elegibles, sigue siendo obligatorio canjear, pero no existe opcion valida. La preparacion devuelve `POINTS_REDEEM_SERVICE_FORBIDDEN`, la reserva normal conserva `REWARD_REDEEM_REQUIRED` y el frontend informa ausencia de servicios. Resolverlo requiere configuracion autorizada de servicios por condicion/sucursal o una nueva decision comercial, no omitir el gate.
- Una tarifa cero del propio servicio canjeado no aporta cobertura monetaria y conserva `POINTS_REDEEM_NOT_APPLIED`, sin crear citas ni debitar puntos. Esto es distinto de una recompensa positiva que deja el total grupal en cero; ese caso sí confirma sin pago. No se cambia la regla para consumir 10 puntos por un servicio de precio cero.
- Los archivos SQL manuales de completion/ciclos/preflight permanecen sin cambios y sin aplicacion remota. La acreditacion al completar requiere su revision y aplicacion manual autorizada en QA. Las pruebas locales no certifican los triggers remotos.
- No se consultan ni modifican Supabase remoto, reservas/cuentas reales, variables del despliegue, main o Produccion. No hay merge ni despliegue manual. OAuth, correo real, WebKit y dispositivos fisicos no se presentan como ejecutados.

Resultados finales CANJE-GRUPAL-01: **185/185 pruebas SQL/contactos/transiciones/planes PASS**, mas **323/323 regresiones backend PASS** (508 en total, cero omisiones). Frontend: **204/204 Vitest PASS** en 11 suites y **26/26 escenarios Chrome PASS** sobre build compilado, sin excepciones ni desbordamiento horizontal. Se revisaron las capturas de cuatro acompanantes con recompensa a 390 px oscuro y 1440 px claro. **ESLint de archivos afectados, sintaxis Node, build frontend y git diff --check PASS**. Build conserva el aviso existente de chunks mayores de 500 kB. Backend no dispone de script de build. No se afirma una suite global completa ni certificacion del entorno remoto.
