# Matriz MasterPuntos QA / Produccion

Corte 15/11/2026 18:27 Honduras. main=55a86ef; candidato #123 sobre la misma rama.
La aclaracion final del propietario define vigencia por ciclo: primer punto +12 meses,
no doce meses independientes por cada credito. Las fechas de las cargas manuales
productivas quedan expresamente autorizadas como inicio del ciclo.

| Capacidad | Codigo candidato | SQL preparado | Produccion efectiva | Evidencia |
|---|---|---|---|---|
| Ajustes, permisos, limites y auditoria | Preservados; error de ciclo controlado | Guarda valida saldo/pertenencia | Version previa conservada | HTTP y PostgreSQL17 |
| Primer punto y siguientes | Mismo contrato | Aniversario comun; sexto punto no reinicia | SQL nuevo no aplicado | Casos con fechas diferentes |
| Reinicio tras agotamiento | Sin cambios de API | Cierra ciclo a cero; siguiente credito abre 12 meses | Pendiente aplicacion | Canje/resta y nuevos creditos reales aislados |
| Historico legitimo 14/69/12 | No reescribe movimientos | Crea solo ciclos desde primera carga autorizada | Ledger/hash intactos, cero ciclos | Preflight remoto solo lectura: 19 controles=0 |
| Saldo mixto y canje de diez | Conserva unica fila de canje | Resuelve cargas originales por cliente/periodo | Sin operaciones reales nuevas | 9+5-10=4; concurrencia/replay |
| Vencimiento del remanente | Lecturas sin escribir | Vista y materializacion usan el mismo ciclo | Motor anterior, sin activar este release | Ocho puntos, aniversario y una sola expiracion |
| Conservacion de ledger | Sin compensaciones/borrados | Hash antes/despues identico | 7d9c4759b1d2e7f35c98a4c983f68cb6 | Comparacion byte a byte en PG17 |
| Acreditacion y acompanantes | Candidato previo preservado | Reglas de elegibilidad/pago intactas | Pendiente release coordinado | Suites pagada/grupal sinteticas |
| SEGURIDAD-02 | Sin cambios a su fuente/respaldo | Paths/ACL preservados; tres cuerpos nuevos con hashes certificados | Aplicada; drift=0 | Tests originales y guardas actuales |
| Rollback | Sin restaurar escritores que borran puntos | Antes de trafico: restaura ciclos/vista/rutinas; despues: contencion | No ejecutado remotamente | Backups privados, baseline y bloqueo tras trafico |

No se consideran permanentes los movimientos antiguos con id_cycle/vence_at NULL:
el ciclo efectivo validado determina su vigencia. No hay categorias comerciales,
puntos sustitutivos, cambios de PixelPay/checkout ni cambios de PR #132/#111/#93/#125.

Procedimiento y criterios: [CIERRE-CODEXA.md](release10/CIERRE-CODEXA.md).
Los documentos/lecturas anteriores quedan como evidencia historica, no como politica
vigente. Codigo/SQL revisables tras CI verde; no hay autorizacion de merge, SQL remoto
o despliegue. La certificacion de la integracion productiva desplegada sigue pendiente.
