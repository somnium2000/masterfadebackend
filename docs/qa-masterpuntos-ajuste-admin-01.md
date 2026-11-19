# QA-MASTERPUNTOS-AJUSTE-ADMIN-01

Fecha: 2026-11-13. Rama de revisión en ambos repositorios: `qa/masterpuntos-ajuste-admin-01`.

## A. Diagnóstico y causa raíz

Base backend vigente: `origin/dev` `1cee1e4af827130281fcd1e875e47047f065a41b`.
Base frontend vigente: `origin/dev` `6a04fbbcde14e198da73a50d1a15862d40b219ce`.

No se reprodujo una prohibición general de restar en este código. Antes del cambio ya existían dos campos separados (sumar/restar), el enum de ambas acciones en la ruta y el movimiento `ajuste_resta` en el servicio. La resta se deshabilitaba en frontend y se rechazaba en backend para un admin cuyo cliente no perteneciera a sus sucursales. Un cliente sin sucursal tampoco admite resta de admin. Super admin conserva alcance global. La suma global existente se mantiene: no se modifican permisos ni reglas comerciales para resolver esta diferencia deliberada de alcance.

Se reemplazan los campos mutuamente excluyentes por una selección explícita SUMAR/RESTAR y una sola cantidad. Si el problema observado era un cliente fuera de alcance, continuará rechazado conforme al contrato. No se certificó qué versión está actualmente desplegada en la interfaz QA.

Se verificó el esquema **en QA, solo lectura**, proyecto `jgipiyhjtpgyaujfhghf`: `ajustar` con signo +1, `ajuste_resta` con signo -1, `points_transactions.puntos` de tipo integer, columnas de motivo/autor/ciclo, tabla privada de idempotencia y triggers de signo y auditoría. No se consultaron registros de clientes ni se escribió en la base remota.

## B. Archivos modificados

Backend:

- `src/routes/v1/admin/puntos.js`: validación del valor JSON y máximo integer para el ajuste.
- `src/services/pointsService.js`: validación numérica segura del ajuste manual.
- `test/admin-points-idempotency.qa-mp-02.test.mjs`: cantidades inválidas en ambas acciones directamente en el servicio.
- `test/masterpuntos-integral.postgres.test.mjs`: ruta administrativa con auth real y PostgreSQL aislado, identidades/sesiones sintéticas.
- Este informe.

Frontend:

- `src/features/admin/pages/AdminMasterPuntosPage.jsx`: selección de operación, cantidad única, validaciones y confirmación detallada.
- `src/features/admin/pages/__tests__/AdminMasterPuntosPage.qa18.test.jsx`: selección, payload, historial/saldo, límites, motivos y reintentos.
- `scripts/masterpuntosAdminAdjustment.browser.mjs`: navegador con APIs sintéticas, móvil/escritorio y ambos roles.
- `docs/qa-masterpuntos-ajuste-admin-01.md`: instrucciones de entrega frontend.

## C. Implementación exacta

Endpoint reutilizado: `POST /v1/admin/puntos/clientes/:id_cliente/ajuste`.

```json
{ "accion": "restar", "puntos": 3, "motivo": "Correccion administrativa" }
```

Header obligatorio vigente: `x-idempotency-key` UUID. La cantidad siempre es positiva en el payload. El tipo `ajuste_resta` hace que el trigger existente persista -3; se conserva `ajustar` para sumar. No se actualizan ni eliminan movimientos anteriores.

- La ruta conserva `requireRoles(['admin','super_admin'])` y las verificaciones existentes de cliente/usuario activo y sucursal. Ningún permiso global cambia.
- Solo se aceptan números JSON enteros de 1 a 2147483647. Se rechazan booleanos, strings, null, arrays, objetos, fracciones, negativos, cero y valores fuera de rango antes de que la coerción de Fastify o el cast SQL los acepten/fallen. El servicio también valida las llamadas directas.
- Motivo obligatorio con 5 a 300 caracteres después de trim, conservado en el movimiento. El máximo visible pasa de 280 al máximo 300 del contrato backend.
- Se conservan BEGIN/COMMIT/ROLLBACK, bloqueo asesor por cliente, idempotencia durable con hash de acción/cantidad/motivo/cliente/autor, guardas de saldo y meta de recompensa y atribución de autor/ciclo.
- La resta exige saldo suficiente bajo el bloqueo transaccional. El frontend la bloquea también según el último resumen; el backend decide sobre el saldo actual.
- Se muestra operación, cantidad, saldo actual y previsto antes de aplicar. La resta conserva el modal existente e incluye cliente y motivo. La suma conserva su confirmación mediante el botón Aplicar ajuste.
- Después del éxito se limpian cantidad/motivo y se recarga saldo/historial desde el backend. Se conservan las guardas de respuestas tardías y la clave idempotente al reintentar el mismo payload tras un error.

## D. Pruebas ejecutadas

| Verificación | Resultado |
|---|---|
| Backend: lecturas, alcance, idempotencia, permisos de regalías, contratos cliente, vencimientos y saldo al eliminar cuenta | PASS, 118/118 |
| PostgreSQL 17 real local: integral, pago confirmado, canje de total cero y acompañantes | PASS, 221/221, sin skips |
| Frontend: página administrativa, lecturas API y MasterPuntos cliente | PASS, 160/160 |
| Chrome: admin/super admin, 390/1440 px, temas claro/oscuro, suma/resta, cancelar, confirmación y saldo/historial | PASS, 4/4 |
| Build Vite | PASS; advertencia de tamaño de chunks |
| ESLint de todos los archivos JS/JSX modificados y git diff --check | PASS |

Se probó la ruta con autenticación y guardia de roles reales; solo la resolución de identidades/sesiones se sustituye con fixtures. Se verificaron el motivo y autor persistidos, el movimiento negativo real, el historial anterior inmutable, saldo insuficiente con rollback, rechazo a cliente inactivo/usuario bloqueado, ausencia de sesión, roles cliente/barbero, y resta fuera de sucursal. Solicitudes repetidas/concurrentes de suma y resta producen un solo movimiento por clave; dos restas distintas que excederían el saldo permiten una sola; suma/resta concurrentes conservan saldo.

La compensación de una resta mediante una suma nueva conserva los movimientos anteriores. No se encontró un endpoint o función independiente de reversos de puntos en el código/contrato revisado; no se agregó uno. Las exclusiones por cancelación y la inmutabilidad de acreditaciones existentes permanecen cubiertas por las suites anteriores.

Reproducción desde el worktree backend (PowerShell; ajustar la ruta al PostgreSQL 17 local):

```powershell
$env:MASTERFADE_PHASE02_PG_BIN = 'C:/ruta/postgresql17/bin'
node --test test/masterpuntos-integral.postgres.test.mjs test/masterpuntos-paid-confirmation.postgres.test.mjs test/masterpuntos-group-redeem.postgres.test.mjs test/mf118-companions-points.postgres.test.mjs
node --test test/admin-masterpoints-reads.qa15.test.mjs test/admin-points-branch-scope.qa15a.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs test/admin-points-rewards-permissions.qa15b.test.mjs test/client-points-rewards.qa-mp-client-02.test.mjs test/masterpoints-readonly-expiration.qa-mp-01c.test.mjs test/accountDeletionExecution.test.js
npx eslint src/routes/v1/admin/puntos.js src/services/pointsService.js test/masterpuntos-integral.postgres.test.mjs test/admin-points-idempotency.qa-mp-02.test.mjs
git diff --check
```

Los tests PostgreSQL crean clústeres temporales locales en 127.0.0.1 y los eliminan al terminar; no usan DATABASE_URL remota. No se instalaron dependencias nuevas ni se modificaron lockfiles.

## E. Operaciones preservadas y riesgos

Acumulación automática, reglas, canjes, vencimientos, pagos, PixelPay, membresías y SQL de Supabase no se editaron. Sus suites relevantes de MasterPuntos se ejecutaron sin regresiones. Esto no sustituye la aceptación del propietario en el despliegue QA.

La elegibilidad por sucursal es intencional; no debe confundirse con una falla del selector. El saldo previsto puede cambiar por concurrencia: el backend valida el definitivo. Se conservan las advertencias de chunks del build. No se ejecutaron todas las suites de otros módulos ni se certificó una nueva ejecución de CI remoto.

## F. GitHub y publicación

Entrega en las ramas de revisión `qa/masterpuntos-ajuste-admin-01`, derivadas de los SHAs de dev indicados arriba. Los SHAs finales se entregan en el chat y se verifican con `git ls-remote origin refs/heads/qa/masterpuntos-ajuste-admin-01` en cada repositorio. No se fusiona a dev/main ni se despliega. Los worktrees originales ServiciosB/ServiciosF y sus cambios pendientes se preservaron.

## G. Supabase QA

**No requiere migración.** No hay SQL nuevo que autorizar o aplicar. La inspección remota fue de solo lectura; no se cambiaron datos, funciones, triggers, RLS, grants ni producción. Las migraciones históricas usadas por los tests se aplican únicamente a los clústeres sintéticos temporales.

## H. Despliegue y aceptación por el propietario

1. Revisar los diffs de las dos ramas contra `dev` e integrar mediante el proceso normal del proyecto, preservando cualquier avance posterior de dev. No usar main ni forzar referencias.
2. Desplegar **solo el backend QA**, con su configuración QA actual. No cambiar variables de pagos, membresías ni credenciales. Luego desplegar el frontend QA que apunta a ese backend. No ejecutar migraciones.
3. Abrir `/home/admin/superpuntos` con un admin de la sucursal del cliente sintético registrado/activo. Partir de saldo 5 y meta 10; SUMAR 2 con motivo debe dejar 7 y un movimiento +2.
4. Elegir RESTAR 3; comprobar cliente, motivo, saldo 7 y previsto 4. Cancelar no debe registrar nada. Confirmar debe dejar 4 y un movimiento -3, preservando +2 y la historia previa. Recargar y verificar persistencia.
5. Probar RESTAR 5 con saldo 4: botón bloqueado y solicitud directa rechazada con 422. Probar 0, -1, fracciones, texto, booleano y 2147483648 mediante API: 400. Motivo vacío/corto: 400.
6. Reenviar una solicitud válida con el **mismo UUID y payload**: mismo `id_points_tx`, `idempotent_replay=true`, sin otro movimiento. La misma clave con datos distintos debe devolver 409. El doble clic no debe duplicar.
7. Cliente/barbero y ausencia de sesión: 403/401. Admin de otra sucursal o cliente sin sucursal: resta 403; super admin conserva alcance global. La suma global previamente autorizada permanece disponible.
8. Ejecutar el smoke habitual de acumulación, canje y compensación con clientes sintéticos QA. Verificar en el ledger motivo, `creado_por_usuario_id`, signo y saldo. No editar movimientos anteriores para revertir la prueba.

Rollback del código: restaurar la versión frontend/backend QA anterior mediante el proceso de despliegue del propietario. No requiere rollback SQL ni borrado de movimientos.
