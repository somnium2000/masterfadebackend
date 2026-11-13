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

Antes de aplicar en un entorno autorizado: ejecutar el preflight de lectura, comparar las firmas y triggers efectivos y conservar las definiciones previas (`pg_get_functiondef`) y sus permisos para reversión DDL. El script de aplicación vuelve a comprobar las dependencias. Se detiene ante falta de guardas/índices, ciclos activos múltiples, ciclos con movimientos sin vencimiento o con plazo distinto, y débitos históricos sin ciclo junto a créditos activos. Esas anomalías requieren decisión explícita sobre el historial; este ticket no autoriza recalcular saldos. Un ciclo previo vacío se reancla únicamente durante una acreditación nueva, sin alterar movimientos anteriores.

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
