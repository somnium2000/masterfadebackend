# Cierre MasterPuntos sobre SEGURIDAD-02 aplicada

## A. Resumen ejecutivo

PR existente #123 actualizado mediante merge normal de origin/main
55a86efb8b492402f79d7ec2930cdcfbd4fc72fb, sin dev, rebase ni force-push.
Merge normal 2edd4aa6bf4fd3c8a1bbed88a91e51e0c472b8a1; el HEAD anterior
b86f40a06c7312dd5887a946c5a0e621cfec4312 se conserva como ancestro.
Los cuerpos/ACL/paths/triggers/columnas/indices y el respaldo de SEGURIDAD-02 se
consultaron nuevamente en QA/PROD mediante transacciones de solo lectura.
Snapshots actuales: test/fixtures/masterpuntos-release10/current/.

**NO-GO financiero para aplicar:** Produccion conserva 14 movimientos administrativos
legitimos, 69 puntos netos, 12 clientes y ningun ciclo en la lectura del 15/11/2026
a las 17:22 America/Tegucigalpa (23:22 UTC). Las cifras son una observacion, no un sello fijo.
No existe una regla aprobada para vincular el saldo sin ciclo con los nuevos debitos
y vencimientos por ciclo sin decidir como imputarlo. La vista conserva el historico,
pero un debito futuro en un ciclo sin creditos suficientes puede dejarlo negativo;
un debito sin ciclo deja el remanente del ciclo nuevo intacto para expiracion.
No se inventa una imputacion, se asignan fechas ni se regularizan saldos.
El preflight mantiene HISTORICAL_UNCYCLED_REVIEW=12: significa compatibilidad
contable pendiente, no saldo ilegitimo ni dato a borrar. Los otros 16 controles PROD
son cero, incluidos CATALOG_DRIFT y SECURITY02_BACKUP_DRIFT.

## B. Archivos funcionales

Se conservan los tres archivos funcionales ya presentes en #123:
src/services/pointsService.js, src/routes/v1/citas.js y src/routes/v1/public/pagos.js.
Este cierre cambia su paquete manual, generador, fixture, pruebas y documentacion;
no agrega mas cambios a src/. Las fuentes comerciales versionadas de ciclos y pago
confirmado siguen intactas. Nada de 10B, checkout, Hosted o agenda del companero.

## C. Diferencias tecnicas resueltas

- Entrada: nueve definiciones productivas reales ya endurecidas, ACL reales y
  triggers vigentes; no se reutilizan hashes anteriores a SEGURIDAD-02.
- Salida: mismos cuerpos comerciales efectivos de QA, con search_path productivo
  pg_catalog,public,pg_temp conservado en las nueve funciones publicas. La diferencia
  de hashes de definicion frente a QA corresponde a ese metadato explicito, no a
  una ampliacion de versiones para hacer pasar una diferencia desconocida.
- Cuatro helpers privados de pago con ACL postgres y sin SECURITY DEFINER.
- Respaldo de SEGURIDAD-02: comparacion exacta con la lectura actual, preservando
  contenido y OID de cada rutina. Nunca se borra, actualiza ni rebaselina.
- La restauracion ya no hace RESET ALL: reinstala las definiciones productivas
  endurecidas, conserva configuracion/ACL existentes y valida la salida exacta.
  Bloquea deriva de funciones/ACL y modificaciones del respaldo antes de restaurar.
- Contencion solo acepta deshabilitar los cuatro triggers nuevos de pago; no tolera
  deshabilitar guardas, signo ni triggers antiguos.

## D. Certificacion

PostgreSQL17 aislado reconstruye el catalogo actual, las restricciones de puntos y
los nueve respaldos efectivos con OID locales. Se certifican acreditacion por pago,
beneficiario de acompanantes, canje, idempotencia, concurrencia, vencimiento firmado,
permisos y reversion sin perdida de filas. El caso sintetico 14 movimientos/69 puntos
demuestra que la aplicacion bloquea sin modificar el historico. Las pruebas afectadas
y la suite completa/CI del SHA publicado se enlazan en #123; SKIP ajenos se separan.
Las fuentes antiguas bajo fixtures siguen solo para las regresiones historicas de
SEGURIDAD-02 ya integradas; el generador operativo utiliza exclusivamente current/.

### Prueba contable del bloqueo restante

`test/masterpuntos-legacy-ledger-proof.postgres.test.mjs` ejecuta PostgreSQL 17 real,
los cuerpos SQL objetivo, la vista, triggers y los servicios reales de ajuste y canje.
Instala el paquete solamente sobre un fixture vacio que supera el preflight; despues
construye estados mixtos adversarios en loopback. No omite el guard para instalarlo
sobre datos historicos, ni presenta esos estados como una aplicacion autorizable.

| Caso aislado | Resultado reproducido del candidato, no correccion |
|---|---|
| Credito legitimo sin ciclo | `HISTORICAL_UNCYCLED_REVIEW=1`, fila intacta |
| 9 existentes + 5 acreditaciones validas - ajuste de 10 | Saldo global 4, ciclo -5; replay no duplica |
| Dos restas concurrentes de 10 | Solo una aplica, otra `POINTS_INSUFFICIENT_BALANCE`; ciclo -5 |
| Canje real con esos mismos saldos | Una fila de -10 y replay idempotente; ciclo -5 |
| Imputar todo el debito a NULL | Saldo previo 4; vista/materializacion del vencimiento deja -1 |
| Consumir primero puntos del ciclo o existentes | Saldo inmediato 4 en ambos; tras vencimiento queda 4 o 0 |
| Ciclo agotado por canje y siguiente acreditacion | Reutiliza id/fecha antiguos; no renueva 12 meses desde el nuevo punto |
| Rollback local del experimento | Ledger y ciclos intactos |

El propietario confirmo durante este cierre que, tras un canje el 15, el primer
punto del nuevo ciclo acreditado el 16 debe tener 12 meses desde el 16. No autoriza
asignar a los puntos fisicos un vencimiento desde su fecha de captura. La duracion
de 12 meses y ese ejemplo de reinicio estan confirmados; no deben confundirse con
la imputacion de un debito que atraviesa saldo sin ciclo y saldo de un ciclo.

**Decision estrictamente pendiente para esa convivencia:** con 9 puntos existentes
sin vencimiento asignado y 4 puntos de un ciclo con fecha de vencimiento conocida,
un canje de 10 deja 3. Debe determinarse si esos 3 son remanente existente o remanente
del ciclo. Ambas imputaciones conservan el saldo inmediato y las filas originales,
pero producen saldos futuros diferentes. Ni el neto 13-10=3 ni la duracion de 12 meses
identifican por si solos que puntos fueron consumidos. No se elige una prioridad,
se mueven filas, se divide el canje, ni se transfieren saldos para ocultar el problema.

No se modifican funciones/guardas SQL ni codigo funcional en este cierre. El segundo
hallazgo impide tambien afirmar que los cuerpos QA actuales ya cumplen el ejemplo
de reinicio confirmado por el propietario. Las nueve comprobaciones nuevas son
pruebas de diagnostico PASS; **la correccion financiera sigue pendiente**.

### Evidencia productiva de solo lectura

Lectura `2026-11-15T23:22:00.878308+00:00`, transaccion `REPEATABLE READ READ ONLY`,
`transaction_read_only=on`. 14 filas, neto 69, 12 clientes, cero ciclos y cero fechas
de vencimiento asignadas al historico. `ledger_md5=7d9c4759b1d2e7f35c98a4c983f68cb6`;
`cycles_md5=d41d8cd98f00b204e9800998ecf8427e`. Coinciden con la lectura inicial.
Los 16 controles restantes siguen en cero; `CATALOG_DRIFT=0` y
`SECURITY02_BACKUP_DRIFT=0`. No se leyeron ni publicaron identidades personales.

## E. SQL coordinado (preparado, NO autorizado para aplicar)

1. Ventana sin escritores/DDL concurrente. Verificar proyecto PROD y rol postgres.
2. db/manual/release10/00-preflight.sql: solo lectura. Exigir todos affected=0.
   Actualmente HISTORICAL_UNCYCLED_REVIEW=12 obliga a detenerse. No hay bypass.
   Archivar hashes dinamicos de ledger/ciclos y salida; no fijar 14/69 como condicion.
3. Solamente cuando exista compatibilidad contable aprobada y recertificada,
   10-apply.sql completo: transaccion atomica, bloqueo de tablas, checks repetidos,
   fuentes de ciclos/pago y preservacion de paths. Cero backfill y cero DML de ledger.
4. 20-postflight.sql: target exacto, respaldo inmutable, datos compatibles y hashes
   ledger/ciclos iguales al preflight antes de abrir trafico.
5. Aborto antes de trafico: en la misma sesion del operador definir
   masterfade.release10_expected_ledger y masterfade.release10_expected_cycles con
   los hashes archivados; ejecutar 31-restore-before-traffic.sql completo. Exige target
   conocido y datos intactos; restaura el estado PROD ya endurecido y elimina solo
   helpers/triggers nuevos. Comparar catalogo y hashes; no ejecutar rollback SEGURIDAD-02.
6. Tras movimientos nuevos: 31 se bloquea. 30-rollback-containment.sql detiene nuevas
   acreditaciones sin tocar ledger/ciclos. Mantener trafico detenido y revisar el caso;
   no reabrir con codigo antiguo ni acreditar/revertir datos automaticamente.

Mientras los cinco cuerpos de puntos esten actualizados, el apply/rollback anterior
de SEGURIDAD-02 debe negarse por deriva de cuerpos contra su respaldo: es proteccion
esperada. MasterPuntos 31 devuelve exactamente sus cuerpos y paths previos, permitiendo
de nuevo la comprobacion de ese respaldo. No actualizar sellos de SEGURIDAD-02.

## F. Riesgos y dependencias

Unico bloqueo financiero actual: compatibilidad del historico legitimo sin ciclo.
No se resuelve con una nueva clasificacion, compensacion ni fecha inventada. Los pagos
usados en las pruebas son sinteticos. No se modifica #111/#93/#125 ni funcionalidades
de checkout/Hosted/reservas generales. No hubo escritura remota, merge a main o deploy.

## G. Decision

GO para revisar la reconciliacion tecnica y sus pruebas. NO-GO para integrar el codigo
financiero actual, aplicar SQL o desplegar MasterPuntos hasta resolver el bloqueo
financiero y el reinicio del ciclo conservando saldos, beneficiarios y trazabilidad.
PR #132 no se modifica en este cierre.
