# QA-MASTERPUNTOS-PAGO-CONFIRMADO-01

Fecha: 13 de noviembre de 2026. Base backend `origin/dev`: `aa6b763`. Trabajo en worktree separado; se conservaron las modificaciones locales de ServiciosB y ServiciosF.

## A. Resumen backend

La migración manual nueva cambia la acreditación desde la finalización hasta el cierre de la transacción que ya contiene pago válido y cita confirmada. El push de código no aplica SQL: **su aplicación manual en Supabase QA queda pendiente**. Se conserva sin editar `20261113024454_masterpuntos_completion_cycles_v1.sql`, que el solicitante informa ya aplicada.

No hubo acceso SQL remoto, modificaciones de datos reales, backfill, despliegue, fusión a main ni operación sobre Producción. Los pagos y las identidades usados en pruebas son sintéticos. La verificación de estructura utilizó migraciones, fixtures existentes y la extracción de esquema del backup local `database/BD-PG.sql` con pg_restore; no equivale a una certificación actual del esquema remoto.

## B. Archivos modificados

- `db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql`: migración nueva, generada inicialmente con `supabase migration new` y trasladada a entrega manual.
- `db/manual/masterpuntos_paid_confirmation_checks.sql`: inspección y validación de solo lectura para pgAdmin.
- `test/masterpuntos-paid-confirmation.postgres.test.mjs`: pagos, funciones reales, atribución, guardas, canjes, transacciones y concurrencia.
- `test/masterpuntos-group-redeem.postgres.test.mjs`: ejecuta también la migración nueva; las simulaciones y los servicios gratuitos dejan de contarse como pago real.
- Este informe.

## C. Rutas y funciones auditadas

| Entrada | Comportamiento observado y cobertura del cambio |
|---|---|
| `POST /v1/pagos/reservas/pixelpay/sale` | La aprobación verificada pasa por `reconcilePixelPayPaid`, captura y confirmación canónica. Los triggers observan el estado final dentro de su transacción. |
| `POST /v1/pagos/reservas/pixelpay/status` y `POST /v1/pagos/reservas/estado` | La recuperación desde evidencia durable usa `reconcilePixelPayFromDurableApproval` y la misma confirmación. Un pendiente o resultado incierto no basta. |
| Las mismas entradas bajo `/v1/public/pagos` | El registro público reutiliza el mismo módulo y recibe las mismas guardas SQL. Se conservan sus controles de acceso/contacto existentes. |
| `POST /v1/pagos/webhook/:proveedor` | Mock puede registrar captura; se excluye como evidencia de puntos. Los proveedores no mock conservan el comportamiento actual de extensión pendiente, sin inventar confirmación financiera nueva. |
| `POST .../mock-completar` | Puede confirmar una reserva de prueba; ni el proveedor mock ni `tx_mock_...` generan puntos. |
| `POST .../simulator/event` | Los eventos `payment.simulated.result` y las referencias `todopago_sim_...` se excluyen. |
| Compra/confirmación de plan en `src/routes/v1/cliente.js` y `membershipService.js` | Se revisaron `/planes/confirmar-pago`, simulador y las rutas de Sale/status/recuperación. Comprar un plan no otorga puntos por sí solo. Una cita VIP necesita consumo válido y cadena `subscription_payments → payments → payment_intents → membership_purchase_orders`. Los eventos `membership.simulated.result` se excluyen. |
| `POST /v1/citas/hold/:id_grupo_cita/confirmar` | Un total cero por recompensa, tarifa gratuita o mera existencia de membresía no prueba pago. Un consumo VIP de una membresía efectivamente pagada puede acreditar al confirmar. |
| Confirmación administrativa, efectivo pendiente y registro manual | Confirmar sin cobro no acredita. Un pago persistido debe satisfacer las mismas comprobaciones; no se cambia el contrato administrativo. |
| SQL `fn_trg_aplicar_pago_a_cita`, `app_private.confirmar_reserva_pagada_v1` y reconciliación/expiración | Quedan cubiertos por eventos de cita, pago e intent. También se probó el trigger histórico de aplicación de pago sin llamada Node adicional. |

No se modifican pasarelas, rutas HTTP, autenticación, roles, contratos API ni montos. Las pruebas HTTP mantienen los controladores y guards reales; las pruebas positivas de pago financiero utilizan registros sintéticos válidos y el RPC canónico real sobre PostgreSQL local. No se ejecutaron cobros contra proveedores.

## D. Cambios aplicados

- `points_payment_valid_v1`: exige pago capturado/conciliado/manual pagado, no tardío, intent confirmado, importe positivo coincidente, moneda coincidente, fecha de pago y referencia, y proveedor real soportado. Rechaza mock y evidencia de simulación. No se usa el estado activo del proveedor actual para invalidar pagos reales previos.
- `points_appointment_paid_v1`: exige cita confirmada y pago de la cita o de su grupo por el total correcto, con vínculo consistente al grupo. Una cita gratuita no gana puntos por el pago de otra cita. Como alternativa admite cobertura VIP registrada y respaldada por membresía pagada, con titular, sucursal, servicio, fechas e importes coherentes.
- La cobertura VIP respeta el instante del consumo registrado, igual que el motor actual. No añade una nueva regla de caducidad según la fecha futura de la cita. El último beneficio que deja la suscripción `vencida/agotamiento` sigue siendo elegible.
- Para grupos `cliente_autenticado`, se acredita exclusivamente a `citas_grupos.id_cliente_titular`: +2/+3/+4/+5 cuando todas las citas califican. Se conservan identidades y contactos de cada cita. Para otros orígenes se conserva la atribución individual existente.
- Se neutralizan los hooks antiguos de finalización/cobertura sin prueba financiera. Los nuevos eventos de citas, payments, payment_intents y subscription_consumptions se ejecutan como triggers diferibles al COMMIT. Así observan la confirmación, la cobertura y el débito de canje antes de acreditar. Los nuevos puntos no financian ese mismo canje.
- Se conserva el advisory lock por beneficiario y el índice único existente por cita/acumulación. No se crean índices redundantes. Los ciclos siguen anclados a la primera acreditación y duran doce meses.
- La guarda protege el beneficiario, exige ciclo válido, fuerza +1 y el origen correcto y bloquea reescrituras de una acreditación existente. No hay débitos por no_show ni nuevas sumas al completar.
- Se conserva -10 al confirmar un canje, una sola vez. No acredita la cita canjeada del titular, incluso con extras; sí las citas pagadas elegibles de acompañantes.
- Helpers nuevos en `app_private`, sin SECURITY DEFINER ni EXECUTE para PUBLIC. Permisos explícitos solo para `postgres`, rol usado por el contrato existente. Los controles HTTP de autenticación, alcance y comercio pausado se conservan y se probaron.

La semántica de locks de transacción se contrastó con la [documentación oficial de PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html). Los triggers diferidos forman parte de la misma transacción, no de un proceso posterior ni una cola externa.

## E. Validaciones

| Validación final | Resultado |
|---|---|
| Nueva suite, PostgreSQL 17.11 aislado, incluida frontera 4:59.999 / 5:00 y conservación ante no_show/completada | **76 PASS**, 0 FAIL, 0 omitidos |
| Rutas reales Fastify: grupos 1–4, invitados/registrados, VIP/no VIP, canje, saldo 9/10/20, mock, fallido, expirado, duplicados y comercio pausado | **56 PASS**, 0 FAIL, 0 omitidos |
| Regresión PostgreSQL de ciclos, agenda y consumos VIP, con sus baselines anteriores explícitos | **95 PASS**, 0 FAIL, 0 omitidos |
| Regresión Node: puntos, permisos, alcances, idempotencia, comercio, pagos y seguridad financiera VIP | **428 PASS**, 0 FAIL, 0 omitidos |
| Frontend relacionado: Vitest | **139 PASS**, 7 archivos, 0 FAIL |
| Chrome real, app compilada, 390/1440 px, claro/oscuro, comercio activo/pausado, regreso al perfil y saldo/historial sin botón Actualizar, grupos y canjes | **26 PASS**, 0 FAIL |
| Build frontend, ESLint de archivos JS afectados y `git diff --check` | **PASS**; aviso existente de chunks >500 kB |

La nueva suite también prueba conservación exacta del ledger y ciclos al aplicar/reaplicar la migración, pago antes/después de confirmación y de estado de intent, saldo 9 insuficiente con rollback de toda la transacción, dos canjes concurrentes con saldo 10, dos reservas concurrentes del mismo titular, un ciclo único y guardas contra beneficiario ajeno y modificación del crédito.

Incidencias de preparación corregidas: la primera prueba concurrente insertaba la FK de pago antes de bloquear el intent; se alineó con el orden del controlador real. Se completaron columnas ausentes en fixtures antiguos. La prueba de frontera temporal normaliza microsegundos PostgreSQL a milisegundos JavaScript, sin cambiar el margen operativo. Los ejecutables Playwright empaquetados no arrancaron; la validación final usó Chrome instalado. No se cambió código de pasarelas para hacer pasar pruebas.

Comandos reproducibles, configurando `MASTERFADE_PHASE02_PG_BIN` hacia binarios locales:

```powershell
node --test test/masterpuntos-paid-confirmation.postgres.test.mjs test/masterpuntos-group-redeem.postgres.test.mjs
node --test test/masterpuntos-integral.postgres.test.mjs test/agenda-phase02.postgres.test.mjs test/cliente-plan-consumptions.postgres.test.mjs
npx eslint test/masterpuntos-paid-confirmation.postgres.test.mjs test/masterpuntos-group-redeem.postgres.test.mjs
git diff --check
```

## SQL manual pendiente: pgAdmin QA

1. Confirmar destino QA y usar una sesión con privilegios DDL apropiados. El backend continúa requiriendo sus permisos actuales; un rol distinto de `postgres` requiere revisión explícita de grants.
2. Ejecutar y guardar los resultados de `db/manual/masterpuntos_paid_confirmation_checks.sql`, incluidas las definiciones anteriores. Revisar estructura, triggers, índice único y ausencia de duplicados. El borrador nuevo exige el helper de ciclos de la migración anterior; si falta, falla antes de cambiar funciones.
3. Ejecutar **completo** `db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql`. Contiene BEGIN/COMMIT, preflight, lock_timeout de 5 s y statement_timeout de 30 s. Un error requiere ROLLBACK y revisar la causa; no continuar pegando fragmentos.
4. Repetir el SQL de inspección: cuatro triggers nuevos habilitados, diferibles e inicialmente diferidos; helpers privados sin SECURITY DEFINER; guarda reemplazada; índice único preservado. Contrastar movimientos y ciclos capturados antes/después en una ventana sin actividad concurrente.
5. Ejecutar la certificación QA con cuentas y pagos de prueba autorizados según el proveedor real de QA. No usar un pago mock o simulador como expectativa de acreditación real. El perfil debe leer el saldo después del COMMIT.

No reaplicar la migración anterior: volvería a instalar la política de finalización. La migración nueva no se incorpora a una ruta de ejecución automática.

## F. Riesgos y reversión

- La aplicación remota y certificación QA están pendientes. Hasta aplicar el SQL manual, la base seguirá con la política anterior aunque frontend esté actualizado.
- Debe verificarse en QA el contrato exacto del preflight; los snapshots locales pueden diferir del entorno. Ante discrepancia se aborta, sin corregir datos automáticamente.
- El frontend publica el texto operativo nuevo; coordinar su activación con la aplicación manual para evitar mensajes adelantados al cambio de BD.
- Reembolsos totales/parciales, contracargos, fraude y cancelaciones posteriores necesitan aprobación comercial: definir atribución/prorrateo por grupo, puntos ya gastados, saldo insuficiente, ciclos vencidos y aviso al cliente. **No se añade reversión automática ni se decide una nueva política.**
- No se alteran ni redistribuyen movimientos históricos, incluso si fueron atribuidos antes con otras reglas. Cualquier revisión histórica es otro trabajo autorizado.
- Antes de COMMIT, usar ROLLBACK. Después, la reversión DDL debe restaurar las definiciones y trigger de guarda capturados y deshabilitar los cuatro triggers nuevos en una transacción revisada. No ejecutar de forma automática el SQL anterior ni borrar puntos acreditados. La reversión de datos requiere una decisión separada.
- El resultado `saldo_actual` interno del canje puede reflejar el débito antes de los créditos diferidos; la respuesta HTTP se envía después del COMMIT y las lecturas de perfil/resumen obtienen el saldo final. Se mantiene el contrato API.

## G. Impacto frontend y condiciones

El frontend refresca perfil y resumen al regresar por navegación, foco, visibilidad o restauración de página, con los controles de identidad y respuestas obsoletas existentes. Sus mensajes describen pago y reserva confirmados. El borrador revisado está en el repositorio frontend, `docs/masterpuntos-borrador-pago-confirmado-01.md`; no se importa en la aplicación, no sobrescribe el JSON 0.3-RC1 y no entra en vigor legalmente.
