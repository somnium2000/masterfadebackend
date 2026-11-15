# Matriz MasterPuntos QA / Produccion

Actualizada 15/11/2026. Corte backend `origin/main=3a77863`; candidato `release/prod-masterpuntos-functional`. Inspeccion remota limitada a catalogos y SELECT agregados. No confundir codigo integrado, SQL efectivo y certificacion funcional.

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
| SEGURIDAD-02 para dependencias de puntos | No trasladada como migracion global | Solo search_path de cuatro rutinas requeridas | Hardening presente | Estas funciones sin hardening | Hashes completos comparados localmente |
| Historial compatible con vencimiento anual | No resuelto por codigo | Preflight bloquea y no modifica datos | 1 cliente abierto sin ciclo y 1 ciclo negativo | 10 clientes, 56 puntos netos sin ciclo | **NO-GO de datos en ambos entornos** |

QA registra 50 migraciones; PROD 38. Las tres entradas de ciclos, pago confirmado y SEGURIDAD-02 faltan en PROD. El paquete manual no marca las tres como aplicadas ni ejecuta el hardening general. La prueba local compara cuerpos efectivos, ACL, propietario, triggers e indices; una coincidencia de nombres no es certificacion.

Estado de entrega: candidato revisable, SQL manual preparado, **SQL remoto NO aplicado**, merge/despliegue NO realizados, certificacion de PROD NO concedida. El frontend no cambia en este trabajo; su paridad visual y certificacion remota no se afirman. PixelPay Hosted y cambios generales de agendamiento quedan fuera.

Procedimiento exacto y bloqueos: [release10/PROCEDIMIENTO.md](release10/PROCEDIMIENTO.md). Evidencia de lectura actual: [PROD](release10/prod-preflight.json), [QA](release10/qa-preflight.json). Tras una futura ejecucion autorizada se debe actualizar esta matriz con SHA desplegado, hash del paquete, acta SQL y certificacion remota por separado.
