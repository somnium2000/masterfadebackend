# QA-MASTERPUNTOS-INTEGRAL-01

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
