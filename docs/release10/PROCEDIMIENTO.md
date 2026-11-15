# MASTERFADE — PROD-RELEASE-INTEGRACION-10

Fecha: 15/11/2026, America/Tegucigalpa. Candidato backend `release/prod-masterpuntos-functional`, basado en `origin/main` `3a77863`. No se fusiona `dev`. No autoriza merge, despliegue, activacion ni escrituras remotas.

## Decision actual

**GO para revision del candidato; NO-GO para aplicar en PROD.** El preflight remoto de solo lectura detecta `HISTORICAL_UNCYCLED_REVIEW=10`: 12 movimientos administrativos, 56 puntos netos, diez clientes y cero ciclos. Asociar esos saldos a un ciclo, elegir su fecha de inicio o excluirlos de vencimiento requiere una decision separada sobre datos financieros. Este paquete no elige esa politica, no contiene saneamiento ni ejecuta backfill. No se debe omitir el bloqueo aunque los cuerpos de funciones coincidan.

QA tiene 22 movimientos y siete ciclos; el mismo control detecta un cliente con historico sin ciclo abierto y un ciclo con saldo negativo. Es referencia funcional de cuerpos, no un conjunto de datos certificado. Los resultados actuales estan en `prod-preflight.json` y `qa-preflight.json`; deben refrescarse en la ventana autorizada.

## Candidato y diferencias necesarias

Solo tres archivos funcionales cambian:

- `src/services/pointsService.js`: retira los dos escritores anticipados, conserva el ledger al repetir canjes, asocia nuevos ajustes/debitos al ciclo, valida exactamente tres segmentos del token y su sucursal, identifica el servicio descontado cuando dos precios coinciden y conserva los limites integer y permisos de resta de `main`.
- `src/routes/v1/citas.js`: retira dos llamadas de acreditacion anticipada; permite el canje del titular con acompanantes ordenados; serializa la confirmacion de total cero antes de leer el grupo. Este lock pertenece al canje y sus reintentos, no incorpora cambios generales de agendamiento.
- `src/routes/v1/public/pagos.js`: unicamente retira el import y la llamada del escritor anticipado. No cambia proveedores, Hosted, Sale, webhooks, conciliacion, correo ni la recuperacion de pagos.

Procedencia de hunks: `89cab62` (ciclos/ledger), `aa6b763` (canje grupal/seleccion descontada) y `49e342e` (serializacion de confirmacion). La validacion administrativa ya integrada por #121 se conserva. No se trasladan el cambio posterior de autorizacion global de restas de `dev`, sus cambios de membresias, evidencia de consumos, simulacion QA ni agendamiento general. No se toca #111/#93.

Las dos fuentes SQL versionadas se incluyen sin modificar: `20261113024454_masterpuntos_completion_cycles_v1.sql` y `20261113161929_masterpuntos_paid_confirmation_v1.sql`. Los SHA256 sobre texto LF estan en `db/manual/release10/manifest.json`. **No ejecutarlas por separado en PROD:** `10-apply.sql` combina ambas dentro de una sola transaccion, sin intervalo de acreditacion por completada entre ellas.

El catalogo observado confirma que SEGURIDAD-02 tambien cambia cuatro dependencias MasterPuntos: `fn_points_estado_final_cita`, `fn_points_get_effective_rule`, `fn_points_materialize_expired_cycles` y `fn_points_tx_apply_tipo_sign`. Se traslada exclusivamente su `search_path=pg_catalog,public,pg_temp`. Las otras funciones conservan el `search_path` de las fuentes versionadas. No se ejecuta la migracion global SEGURIDAD-02 ni se la registra como aplicada.

El resultado exigido son las trece funciones efectivas de QA con identico `md5(pg_get_functiondef)`, propietario `postgres`, SECURITY INVOKER y ACL observadas; cuatro triggers de acreditacion DEFERRABLE INITIALLY DEFERRED, y las guardas/indices originales. Las tablas, vistas, RLS, reglas y movimientos permanecen intactos. Los helpers privados solo son ejecutables por `postgres`; verificar que ese sea el rol de conexion backend antes de autorizar. No se conceden permisos nuevos a anon/authenticated/service_role.

## Secuencia para una futura autorizacion

Todos los comandos parten de la raiz del candidato. La variable `MASTERFADE_PROD_DATABASE_URL` debe ser proporcionada por el operador, sin imprimir su valor. Usar PostgreSQL 17/psql y una conexion directa, con el mismo rol validado. Los scripts SQL tambien funcionan en pgAdmin; conservar la misma sesion para la restauracion de aborto.

1. Confirmar SHA candidato y CI verde; revisar este informe, diff, manifest y respaldo/PITR disponible. Resolver por separado los diez historicos bloqueados mediante autorizacion explicita. No ejecutar este paquete para corregirlos.
2. Ejecutar y guardar el preflight de lectura:

   ```powershell
   psql $env:MASTERFADE_PROD_DATABASE_URL -X -v ON_ERROR_STOP=1 -f db/manual/release10/00-preflight.sql
   ```

   **STOP si cualquier `affected` es mayor que cero o hay error.** Exige schema, hashes completos PROD o QA, triggers habilitados, indices unicos validos, grants, tipos/signos, reglas 1/10/12, ciclos anuales, identidades y saldos compatibles. El historico sin ciclo solo puede pasar si todo el bloque es conocido, cronologicamente verificable, compensado a cero sin prefijos negativos y anterior a todo ciclo del cliente. Un credito abierto sin ciclo bloquea tambien cuando todavia no existe ciclo.

3. Con autorizacion de aplicacion/despliegue y una ventana operativa sin escritores, guardar otra vez `00-preflight.sql` y sus `ledger_md5`, `cycles_md5`, cantidades y suma. Detener/dranar writers mediante el procedimiento de operaciones aprobado; este trabajo no cambia flags. Si los hashes cambian durante la preparacion, refrescar y revisar. No aplicar con trafico normal.
4. Aplicar exclusivamente el paquete atomico:

   ```powershell
   psql $env:MASTERFADE_PROD_DATABASE_URL -X -v ON_ERROR_STOP=1 -f db/manual/release10/10-apply.sql
   ```

   Repite los controles bajo locks de escritores en orden estable; `lock_timeout=5s`, `statement_timeout=60s`. Ante timeout, drift o incompatibilidad, la transaccion revierte completa. No reintentar sin resolver la causa. El script compara hashes del ledger y ciclos antes de COMMIT y exige los hashes funcionales de QA. No inserta nombres ajenos en `supabase_migrations.schema_migrations`; el acta de ejecucion debe guardar SHA del paquete y evidencia, diferenciando aplicacion manual de registro en Supabase.
5. En la misma ventana, desplegar el SHA backend aprobado mediante el proceso habitual, solo con autorizacion adicional expresa. El backend previo tiene escritores anticipados y DELETE de acumulaciones historicas: no reabrir trafico con una combinacion parcial de backend/SQL.
6. Antes de reabrir, ejecutar:

   ```powershell
   psql $env:MASTERFADE_PROD_DATABASE_URL -X -v ON_ERROR_STOP=1 -f db/manual/release10/20-postflight.sql
   ```

   Exigir todos los controles en cero y comparar exactamente ambos hashes, cantidades y suma con el preflight de la ventana. Verificar SHA backend servido, rol DB, logs sin errores y lecturas permitidas. Este ticket no autoriza crear reservas/pagos/canjes reales como smoke. Cualquier certificacion de escritura remota requiere un plan y autorizacion separados. Reabrir solo con aceptacion operativa y de negocio; mantener las restricciones comerciales existentes.

## Reversion sin perder ledger

**Fallo dentro de `10-apply.sql`:** PostgreSQL revierte automaticamente todo el DDL; no hubo backfill. Con psql `ON_ERROR_STOP`, la conexion se cierra y revierte. En pgAdmin ejecutar `ROLLBACK` si la sesion queda abortada. Mantener la ventana detenida y verificar `00-preflight.sql`.

**Abortar antes de reabrir, sin ningun movimiento nuevo:** `31-restore-before-traffic.sql` restaura los nueve cuerpos y triggers originales de PROD, elimina los cuatro triggers/helpers nuevos y conserva filas/ciclos. Requiere los hashes frescos de paso 3; los valores vacios o cualquier movimiento nuevo bloquean antes del DDL. En una misma conexion:

```powershell
psql $env:MASTERFADE_PROD_DATABASE_URL -X -v ON_ERROR_STOP=1 `
  -c "SET masterfade.release10_expected_ledger='<LEDGER_MD5_DEL_PREFLIGHT_00>'" `
  -c "SET masterfade.release10_expected_cycles='<CYCLES_MD5_DEL_PREFLIGHT_00>'" `
  -f db/manual/release10/31-restore-before-traffic.sql
```

Mantener trafico detenido mientras operaciones restaura el backend previo autorizado; volver a ejecutar preflight. La restauracion del comportamiento previo no certifica sus defectos conocidos; no usarla despues de reabrir.

**Incidente despues de nuevos movimientos:** suspender escritores por el procedimiento autorizado y ejecutar `30-rollback-containment.sql`. Es repetible, deshabilita exclusivamente los cuatro nuevos triggers, deja inertes los hooks antiguos y preserva el guard de pago, las funciones anuales, cada movimiento y cada ciclo. Verifica los hashes antes/despues dentro de su transaccion. Mantener el backend nuevo y la ventana cerrada; no restaurar el backend que borra acumulaciones ni habilitar el trigger antiguo. Esta es contencion, no una restauracion funcional del servicio. Requiere analisis del incidente y autorizacion nueva para retomar; los eventos ocurridos durante contencion no se rellenan automaticamente.

No borrar movimientos ni ciclos, no recalcular saldos, no restaurar un dump de datos sobre el ledger posterior al release, no hacer backfill ni ejecutar compensaciones automaticas.

## Validacion y limites

Las pruebas usan PostgreSQL 17.11 en loopback y datos sinteticos. El fixture de transicion carga columnas, constraints/indices MasterPuntos y los nueve cuerpos/triggers efectivos exportados de PROD en esta sesion. La transicion exige las trece definiciones QA byte a byte segun hash de catalogo, no nombres de migracion. El fixture no es una clonacion de todo Supabase; no afirma ejecutar los triggers ajenos de auth/auditoria ni reproducir trafico de produccion.

Se prueban saldo historico bloqueado/compensado, drift de funciones, trigger deshabilitado, indice faltante, regla incompatible, aplicacion doble, ausencia de escrituras DDL sobre ledger/ciclos, ambas reversiones, expiracion del remanente +9/-4, lectura sin materializacion, vencimiento concurrente, nuevo ciclo, sucursales, idempotencia y permisos administrativos conservados. La suite PAGO-CONFIRMADO cubre pago individual/grupal, 1–4 acompanantes registrados/invitados/mixtos, VIP pagado y simulado, 9/10/20 puntos, canje unico, pagos tardios/fallidos/mock/divergentes, orden de eventos, concurrencia y conservacion tras no_show/completada. La suite HTTP grupal cubre hold/intento/confirmacion, propiedad, saldo insuficiente, tokens, promociones/pausas y confirmacion cero concurrente usando las rutas actuales.

Los resultados finales de CI se documentan en el PR. `npm test` es real en este main (`node --test`); no hay script de build backend. Los skips que pertenecen a suites externas optativas se deben reportar, sin presentarlos como pruebas ejecutadas. `npm run lint` conserva advertencias preexistentes sin errores.

Dependencias para GO de aplicacion: saneamiento financiero separado aprobado y preflight limpio; rol backend compatible con ACL privadas; CI del SHA final verde; ventana sin writers; respaldo disponible; backend/SQL aprobados juntos. SQL no aplicado en QA ni PROD, ninguna fila real modificada, flags intactos, sin merge/despliegue ni cambios a #111/#93.
