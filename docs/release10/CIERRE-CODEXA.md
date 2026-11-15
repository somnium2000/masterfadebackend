# Cierre MasterPuntos sobre SEGURIDAD-02 aplicada

## A. Resumen ejecutivo

PR existente #123 actualizado mediante merge normal de origin/main
32e05f8e0e04e53279099a52d5d9f4eaaa84c9ad, sin dev, rebase ni force-push.
Los cuerpos/ACL/paths/triggers/columnas/indices y el respaldo de SEGURIDAD-02 se
consultaron nuevamente en QA/PROD mediante transacciones de solo lectura.
Snapshots actuales: test/fixtures/masterpuntos-release10/current/.

**NO-GO financiero para aplicar:** Produccion conserva 14 movimientos administrativos
legitimos, 69 puntos netos, 12 clientes y ningun ciclo en la lectura del 15/11/2026
a las 15:55 America/Tegucigalpa. Las cifras son una observacion, no un sello fijo.
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

GO para revisar la reconciliacion tecnica y sus pruebas. NO-GO de aplicacion/despliegue
de MasterPuntos hasta resolver por separado el bloqueo financiero conservando saldos,
beneficiarios y trazabilidad. Se continua con Consumos VIP en otro worktree desde main.
