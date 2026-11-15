# Matriz MasterPuntos QA / Produccion

Actualizada 15/11/2026 15:55 America/Tegucigalpa. Corte backend `origin/main=32e05f8`; candidato `release/prod-masterpuntos-functional`. Catalogo/ACL/respaldo consultados nuevamente despues de SEGURIDAD-02. No confundir codigo integrado, SQL efectivo y certificacion funcional.

| Capacidad | Codigo en main | Codigo candidato | SQL QA efectivo | SQL PROD efectivo | Certificacion |
|---|---|---|---|---|---|
| Lecturas sin materializar expiracion | Integrado | Conservado | Vista/rutina presentes | Vista/rutina presentes | Regresiones locales; no escrituras remotas |
| Ajustes admin, permisos y limites de #121 | Integrado | Conserva alcance de resta de main; vincula movimientos nuevos al ciclo | Idempotencia presente | Idempotencia presente | HTTP + PG17 sintetico |
| Ciclos anuales en ambos overloads | Pendiente funcional | Preparado en SQL manual | Cuerpos anuales presentes | Overload de dos argumentos deja NULL | Transicion local a hashes QA; pendiente PROD |
| Acreditacion por pago confirmado valido | Escritor anticipado presente | Retirado de tres llamadas; SQL diferido | Cuatro triggers diferidos presentes | Cuatro triggers ausentes; hook por completada | PG17 con pagos sinteticos; pendiente PROD |
| Canje titular sin acreditacion propia | Codigo parcial | Sin DELETE historicos; debito con ciclo | Guard de pago/beneficiario presente | Guard antiguo por completada | Canje e idempotencia locales |
| Canje con 1–4 acompanantes | Restriccion antigua en hold | Permite grupo ordenado; conserva restricciones restantes | Credita al titular en grupo autenticado | Semantica antigua | SQL/HTTP sinteticos; pendiente extremo a extremo remoto |
| Confirmacion total cero concurrente | Lectura previa al lock | Lock de grupo antes de leer efectos | Sin cambio SQL de reservas | Sin cambio SQL de reservas | HTTP local, sin proveedor externo |
| Protecciones VIP/pago real vs mock/simulacion | Motor main conservado | Sin importar cambios generales de membresias | Helpers de evidencia financiera presentes | Helpers ausentes | PG17 sintetico; no validacion de cuentas reales |
| SEGURIDAD-02 para dependencias de puntos | Integrado y aplicado | Preserva path/ACL de las nueve publicas y respaldo intacto | Hardening presente | Hardening aplicado | CATALOG_DRIFT=0 y SECURITY02_BACKUP_DRIFT=0 en PROD; transicion/reversion PG17 |
| Historial legitimo sin ciclo | Registros administrativos existentes | Bloquea imputacion no aprobada; cero DML historico | Referencia funcional, sin limpiar datos | 14 movimientos, 69 puntos netos, 12 clientes, cero ciclos | **NO-GO financiero de aplicacion** |

SEGURIDAD-02 esta aplicada en PROD; ciclos/pago confirmado siguen pendientes. El paquete no modifica historial de migraciones ni rebaselina el respaldo de seguridad. Los cuerpos comerciales objetivo son los efectivos de QA, conservando el path endurecido de PROD. Una coincidencia de nombres no es certificacion.

Estado de entrega: candidato revisable, SQL manual preparado, **SQL remoto NO aplicado**, merge/despliegue NO realizados, certificacion de PROD NO concedida. El frontend no cambia en este trabajo; su paridad visual y certificacion remota no se afirman. PixelPay Hosted y cambios generales de agendamiento quedan fuera.

Procedimiento vigente: [release10/CIERRE-CODEXA.md](release10/CIERRE-CODEXA.md). Lecturas actuales: [PROD](release10/prod-preflight-current.json), [QA](release10/qa-preflight-current.json). Las lecturas previas quedan como evidencia historica, fuera del generador operativo. Tras una futura ventana autorizada registrar SHA desplegado, acta SQL y certificacion remota por separado.
