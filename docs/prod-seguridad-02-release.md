# SEGURIDAD-02: candidato de integración a Producción

## A. Resumen

Base comprobada: origin/main 3a77863038f866f2b30787a8e67cf69bd8e8adaa.
Referencia aprobada: qa/seguridad-supabase-02b 73f15373837859c0633d99455aeab419ce6bddf6.
Rama aislada: release/prod-security02-hardening. No se fusionó dev.

Se incorporan los tres SQL manuales aprobados sin cambios. SHA256 LF de aplicación:
200fad91768a66ac1e99b166cbe3683bb88e3ea6100bb7b5c5c29f215e3cd49f.
El archivo controlado 10-apply agrega guardas antes y después del motor aprobado,
dentro de su misma transacción y bloqueo asesor. El generador es offline.
Los SQL de #123 bajo test/fixtures son entradas congeladas exclusivamente para pruebas.
No forman parte del procedimiento operativo de esta entrega.

**Decisión:** candidato SEGURIDAD-02 independiente del backend actual, apto para revisión
y autorización técnica si CI y preflight de ventana están verdes. La integración conjunta
con #123 queda NO-GO por los conflictos reproducidos de hashes, ACL y respaldo.
No se aplicó SQL de escritura remoto, no se modificaron datos, flags, main ni PR #123/#111/#93.

## B. Archivos y evidencia

- db/manual/20261113235412_seguridad_supabase_02_routine_hardening{,.preflight,.rollback}.sql:
  fuentes exactas de 02B, con listas de cuerpos antiguos y nuevos ya revisados.
- db/manual/security02-release/: catálogo de lectura, preflight exacto, inspección opcional
  de respaldo, aplicación controlada, postflight, rollback y comprobación de reversión.
- scripts/release-security02-package.mjs: construcción reproducible sin acceso a red/BD.
- test/fixtures/security02-release/: catálogos actuales sin filas de clientes, ACL,
  propietarios, cuerpos, triggers, dependencias, 23 políticas dependientes y respaldo QA.
- test/security-supabase-02.pg.test.js, test/sql/security-supabase-02*: certificación heredada.
- test/security02-release.postgres.test.mjs y helpers: catálogo actual y órdenes de integración.
- .github/workflows/release-main-validation.yml: comprobar reproducibilidad del paquete en D1.

No hay cambios en src/, package.json, dependencias, contratos HTTP ni frontend.
Los nombres de rutinas de agenda existentes solo reciben el endurecimiento de metadatos
ya aprobado; sus cuerpos, triggers y comportamiento comercial permanecen iguales.

## C. Diferencias exactas y compatibilidad

Lecturas remotas realizadas en transacciones REPEATABLE READ READ ONLY el 15 de noviembre
de 2026: QA jgipiyhjtpgyaujfhghf a las 14:15:43 UTC y PROD pdzsmkjnyazpkoocjbpw
a las 14:15:44 UTC. Los preflight originales reconocieron 41/41 en ambos.
El preflight estricto reconoce PROD_CURRENT con cero diferencias en Producción;
QA coincide con RELEASE10_HARDENED con cero diferencias. trusted=true en ambos.

Se comparan las firmas, cuerpos LF, definición completa salvo search_path, propietario,
configuración, ACL efectiva con grantor/grant option, bindings/estado de triggers y
referencias/dependientes de catálogo. pg_depend no descubre todas las referencias
dinámicas de PL/pgSQL: las pruebas ejecutables cubren además RLS, triggers y vencimiento.
Los catálogos y políticas completos permiten revisar esas dependencias fuera del guard.

PROD no tiene respaldo ni registro SEGURIDAD-02. QA tiene 41 respaldos íntegros, activos,
privados y RLS; registro real 20261114003629, nombre
qa_seguridad_supabase_02_routine_hardening_20261113. El timestamp del archivo fuente
no debe confundirse con la versión registrada en QA.

Aplicar sobre PROD cambia search_path en las 41 rutinas y ACL en dos funciones trigger:
fn_hold_defaults_y_unico y fn_citas_detalles_line_identity_v2. Estas dos pierden EXECUTE
de PUBLIC/anon/authenticated, preservando acceso de roles administrativos y servidor.
Los dos helpers RLS conservan EXECUTE authenticated; fn_has_role conserva su restricción.
Se crea únicamente el respaldo privado de metadatos. No se reemplaza ningún cuerpo,
owner, política, binding de trigger, saldo, clasificación de puntos ni dato comercial.

Las cinco diferencias de cuerpo QA/PROD pertenecen a:

| Rutina pública | MD5 LF PROD | MD5 LF QA |
| --- | --- | --- |
| fn_points_get_or_create_active_cycle(uuid,integer,timestamptz) | a38d0b9a382ab61dc7468198b6d45229 | 00ae108a843def22ce1b8e732e9a75ba |
| fn_points_get_or_create_active_cycle(uuid,timestamptz) | 6be79dd3b72e1d7a05016a613bf4a53d | cb533a2e649d94d0c9d3ac78bd310e95 |
| fn_points_tx_guard_acumular_final() | 25e47807f162b12b9de8c87e15a8248c | 6ff488db9f5a4e7843b32dd978ae529a |
| fn_trg_otorgar_puntos_plan_confirmada() | d28d6871c43022fd0950f4ec9f973972 | 8270cf772d8160350926c8762482ca4b |
| fn_trg_otorgar_puntos_por_cita() | b271a74a0fd9440113f62c331e8a7ea8 | 8270cf772d8160350926c8762482ca4b |

El endurecimiento reconoce ambos cuerpos por firma y conserva el instalado. No traslada
ciclos, pago confirmado, políticas de canje/acreditación/vencimiento, 10B ni saldos históricos.
Las otras 36 rutinas tienen el mismo cuerpo LF. Los propietarios son postgres en las 41;
las ACL difieren entre entornos únicamente en los dos triggers endurecidos. Las 23 políticas
dependientes son iguales. Las diferencias de bindings/dependencia de puntos se registran
sin trasladarlas con SEGURIDAD-02.

### Release 10 / PR #123

Candidato fijado: 57ca040ab6641896558fd939e282406acfcd6ff3. Su rama remota se verificó
sin modificarla. Se prueban su 10-apply y 20-postflight exactos sobre datos sintéticos.

| Orden | Resultado |
| --- | --- |
| PROD → SEGURIDAD-02 | PASS: cuerpos/ledger intactos; metadatos endurecidos |
| SEGURIDAD-02 → #123 sin modificar | BLOQUEADO: #123 exige definiciones productivas previas con hashes exactos |
| SEGURIDAD-02 → rollback aprobado → #123 | BLOQUEADO: el rollback convierte proacl NULL en ACL explícita equivalente; #123 compara también esa representación |
| PROD limpio de respaldo → #123 → SEGURIDAD-02 | PASS hacia delante: conserva los 13 hashes y el postflight #123 |
| #123 → SEGURIDAD-02 → rollback SEGURIDAD-02 | Conserva cuerpos, permisos efectivos y ledger; postflight estricto #123 BLOQUEADO por proacl explícita |
| Reutilizar respaldo SEGURIDAD-02 capturado antes de otro cuerpo | BLOQUEADO por identidad/cuerpo; no se rebaselina |

Por ello no se autoriza una ventana conjunta ni se promete reversión conjunta de #123.
Resolver esa incompatibilidad exige una revisión separada del paquete dependiente y sus
preflight/rollback. Esta entrega conserva los tres SQL QA aprobados. No elimina respaldos
ni escribe pg_catalog para forzar compatibilidad. Los bloqueos financieros propios de #123
no se alteran ni se vuelven a auditar aquí.

## D. Procedimiento exacto de futura ventana

Operar con psql PostgreSQL 17, usuario postgres, ON_ERROR_STOP=1 y una conexión verificada
manualmente contra pdzsmkjnyazpkoocjbpw. La variable SECURITY02_PROD_DSN debe suministrarla
el operador autorizado fuera de logs y del repositorio. No usar db push, apply_migration,
ni ejecutar estos pasos desde QA. No registrar automáticamente una migración remota.

1. Confirmar autorización de ventana, SHA revisado y main/backend vigente. Congelar DDL
   concurrente y mantener la ventana operativa controlada. Si #123 u otro SQL se ha aplicado,
   detenerse y revisar la compatibilidad; la coincidencia RELEASE10_CURRENT por sí sola
   no autoriza combinar releases.
2. Ejecutar 00-preflight.sql: exigir PROD_CURRENT, mismatches=0, trusted=true. Cualquier
   otro resultado en la ventana independiente es NO-GO. Guardar salida y hora.
3. Ejecutar catalog-readonly.sql para archivar metadatos antes de la ventana y comprobar
   backup_exists. Si existe, ejecutar 01-existing-backup-preflight.sql: exigir exactamente
   41 READY y revisión de procedencia del respaldo. No borrar ni rebaselinar.
4. Ejecutar únicamente 10-apply.sql completo como archivo. Tiene BEGIN/COMMIT,
   lock_timeout=5s, statement_timeout=60s, bloqueo asesor y guardas atómicas.
   Un error aborta; cerrar la sesión si queda transacción fallida. No continuar fragmentos.
5. Ejecutar 20-postflight.sql: exigir PROD_HARDENED, mismatches=0, trusted=true,
   BACKUP_INTEGRITY total=valid=41 y BACKUP_PRIVATE valid=true.
   Guardar la salida. Revisar permisos del rol efectivo del backend y smoke de lectura.
   Los smokes que escriban se mantienen fuera de esta autorización.
6. Si falla postflight o la verificación operativa, mantener la ventana y ejecutar rollback
   bajo las condiciones siguientes. No corregir filas ni hacer backfill.

Comandos de la secuencia autorizable (no ejecutados remotamente por esta tarea):

```powershell
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/00-preflight.sql
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/catalog-readonly.sql
# Solo si existe respaldo y tras revisar su procedencia:
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/01-existing-backup-preflight.sql
# Solo tras satisfacer todas las condiciones de preflight y autorizacion:
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/10-apply.sql
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/20-postflight.sql
```

### Reversión

30-rollback.sql es la fuente QA aprobada sin cambios. Restaura search_path y EXECUTE
efectivo, incluidas opciones de grant, conservando cuerpos y respaldo privado.
No restaura filas comerciales ni revierte movimientos de ledger. Se niega a pisar
cambios posteriores de cuerpo, OID, owner, security mode, configuración o ACL.
Si se niega por deriva, detenerse para revisión; no quitar guardas ni borrar respaldo.

```powershell
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/30-rollback.sql
psql $env:SECURITY02_PROD_DSN -X -v ON_ERROR_STOP=1 -f db/manual/security02-release/40-rollback-postflight.sql
```

Exigir PROD_CURRENT, mismatches=0, trusted=true y restored=total=41. Se compara ACL efectiva:
una ACL por defecto NULL puede quedar explícita. Esto no cambia acceso efectivo del backend,
pero sí bloquea el guard de representación de #123. El respaldo se retiene para auditoría.
El rollback no modifica ni elimina saldos importados de libretas, ciclos o clasificaciones.

## E. Pruebas, riesgos y paridad

Los resultados finales y comandos están en prod-seguridad-02-validation.md y la matriz
prod-seguridad-02-parity.md. PostgreSQL local 17.11, loopback; CI instala PostgreSQL 17.
Se reconstruyen funciones/ACL/triggers/políticas actuales. Las tablas estructurales de la
suite de seguridad no replican todo Supabase; dos helpers externos de identidad y expiración
de holds tienen contratos sintéticos limitados. La compatibilidad #123 usa además su fixture
con columnas, claves, índices y restricciones reales de puntos. No se certifica HTTP RPC,
Auth alojado ni DML real en QA/PROD. Esos pasos están SKIP por la prohibición de escrituras.

Persisten dos excepciones autenticadas de SECURITY DEFINER requeridas por RLS y el INFO
esperado del respaldo privado con RLS sin políticas. No se cambia ninguna política.
No hay impacto de contrato HTTP/frontend, PixelPay ni agendamiento comercial.
