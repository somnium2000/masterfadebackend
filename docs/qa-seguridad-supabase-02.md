# QA-SEGURIDAD-SUPABASE-02

## A. Resumen

Propuesta manual de endurecimiento de metadatos PostgreSQL, preparada desde `origin/dev` (`a932af725d6ae2595838ecbea26b94a7d5b822ca`). No se ejecutó SQL remoto, no se aplicó la propuesta en QA/Producción y no hubo despliegue ni merge. El SHA publicado se entrega en la respuesta de cierre; este informe forma parte del mismo commit.

Se consultó únicamente `get_advisors` en modo lectura: QA, `2026-11-13T23:49:50.675Z`, y Producción, `2026-11-13T23:49:50.847Z`. Los resultados confirman 31 y 36 avisos `function_search_path_mutable`. Esta consulta de diagnósticos no ejecuta SQL proporcionado por esta tarea ni modifica el proyecto. Las respuestas están preservadas como fixtures de evidencia.

**Límite de certificación:** el Advisor no entrega firmas completas, propietarios, ACL ni cuerpos actuales. La comparación detallada usa snapshots locales con procedencia identificada. La verificación de esos atributos actuales queda pendiente del preflight manual, conforme a la prohibición de ejecutar SQL remoto. No se presenta un snapshot de octubre como auditoría actual del catálogo remoto.

## B. Archivos

- [SQL manual propuesto](../db/manual/20261113235412_seguridad_supabase_02_routine_hardening.sql).
- [Reporte de preflight de solo lectura](../db/manual/20261113235412_seguridad_supabase_02_routine_hardening.preflight.sql).
- [Rollback manual](../db/manual/20261113235412_seguridad_supabase_02_routine_hardening.rollback.sql).
- [Inventario y procedencia](qa-seguridad-supabase-02-inventory.md), [manifiesto compacto](qa-seguridad-supabase-02-inventory.json).
- [Permisos, RLS y RPC](qa-seguridad-supabase-02-privileges.md), [fuentes del Advisor](qa-seguridad-supabase-02-advisor.md).
- [Prueba integrada](../test/security-supabase-02.pg.test.js), [fixture SQL](../test/sql/security-supabase-02-fixture.sql), [casos RLS/triggers](../test/sql/security-supabase-02-rls-cases.sql), [checks oficiales](../test/sql/security-supabase-02-advisor.sql).
- `test/fixtures/security-supabase-02/`: diagnósticos actuales QA/Producción y 41 cuerpos con hashes/procedencia.

La CLI `supabase@2.75.0 migration new` generó el nombre original. Se trasladó a `db/manual`; no se añadió a la cola de migraciones automáticas. No se cambió ningún archivo preexistente de aplicación o migración.

## C. Cambios realizados

Las 36 firmas de Producción incluyen 35 funciones y **un procedimiento**: `fn_marcar_no_show(integer,integer)`. Las 31 de QA son un subconjunto; se conservan las cinco configuraciones ya corregidas en QA. Los cuerpos comerciales, defaults, márgenes, propietarios, identidades OID, SECURITY DEFINER/INVOKER y bindings de triggers permanecen intactos. No se invocan rutinas comerciales durante la migración.

Para las rutinas sin configuración se propone `pg_catalog, public, pg_temp`. Un path preexistente solo se acepta si coincide con el conocido `pg_catalog, public` o con el objetivo seguro; cualquier otro requiere revisión y aborta. Para las cuatro funciones privilegiadas se conserva el orden de los esquemas de aplicación y se añade `pg_temp` al final. La dependencia indispensable `fn_has_role(uuid,text)` recibe el mismo endurecimiento que los dos helpers RLS; sus permisos no se modifican. El ataque con tablas temporales falsas demuestra por qué endurecer solo el wrapper sería insuficiente.

Solo los dos triggers pierden EXECUTE directo de PUBLIC/anon/authenticated. Los triggers existentes siguen funcionando. Los dos helpers conservan EXECUTE autenticado para evaluación de RLS; el acceso anónimo ya denegado se mantiene. Los grants administrativos explícitos y sus grant options se conservan. Cuando un REVOKE de PUBLIC elimina una vía previa, se conserva su acceso efectivo mediante GRANT explícito para service_role, authenticator y roles con capacidades administrativas, únicamente si ya lo tenían. No se añaden esos grants si PUBLIC no daba acceso.

El preflight exige ejecutor/propietarios `postgres`, firmas/tipos/security/hash conocidos, esquemas no escribibles por anon/authenticated, grantors ACL compatibles y bindings activos de los dos triggers. Se vuelven a verificar cuerpo, ruta y grantor inmediatamente antes del respaldo. Una discrepancia revierte toda la transacción. Los hashes de aceptación normalizan solo CRLF/LF; se respalda el cuerpo literal real.

`app_private.security02_routine_backup` guarda la primera definición completa, propietario, configuración, ACL literal y semántica, dependencias/triggers y metadatos de aplicación. Tiene RLS sin políticas públicas y REVOKE explícito a los roles API; no contiene filas comerciales. El rollback restaura la configuración y los permisos efectivos con grant options, sin recrear funciones ni escribir en `pg_catalog`. Una ACL originalmente NULL puede quedar representada explícitamente con idénticos privilegios. Ambos scripts son idempotentes y rechazan cambios posteriores de cuerpo/propietario/configuración/ACL; reaplicar después de rollback también rechaza deriva intermedia.

No se modificaron endpoints ni payloads. No cambiaron frontend, PixelPay, TodoPago, pagos, saldos, reglas de MasterPuntos, datos históricos, main o Producción.

## D. Validaciones

Entorno: PostgreSQL 17.11 en `127.0.0.1`, clúster temporal por escenario; nunca utiliza DATABASE_URL ni credenciales remotas. Se cargan 41 cuerpos reales y sus variantes QA desde las fuentes locales. El fixture tiene 55 tablas/653 columnas con tipos/defaults observados, pero omite restricciones completas. Los auxiliares de identidad, TTL y roles son reales; expiración es un stub explícito que falla ante holds vencidos. No certifica limpieza de reservas/pagos.

La suite nueva se activa al definir `MASTERFADE_TEST_PG_BIN`, como en esta certificación. Sin esa configuración se omite, para conservar la ejecución ordinaria del repositorio en equipos sin PostgreSQL.

| Comprobación | Resultado |
| --- | --- |
| Inventario: 31 QA / 36 Producción, firmas/overloads y procedimiento | PASS, con límite de snapshots explicado |
| Carga de 41 cuerpos originales y hashes | PASS |
| Preflight de solo lectura, rechazo por CREATE público, cuerpo cambiado, path desconocido y permisos heredados | PASS |
| Aplicación doble y dos aplicaciones concurrentes serializadas | PASS |
| Conservación de cuerpos, propietarios, tipos, argumentos/defaults, atributos y triggers | PASS |
| anon/authenticated/service_role/administrador con grant option; respaldo no accesible a authenticated | PASS |
| RLS: cliente propio/ajeno, admin A/B/inactivo, superadministrador, UPDATE cruzado y WITH CHECK | PASS |
| Triggers reales: identidad/inmutabilidad/clave inválida; hold válido/defaults/duplicado/fechas inválidas | PASS |
| Suplantación temporal de roles/superadministrador bloqueada después del cambio | PASS |
| Rollback doble, reapply y rechazo de deriva posterior/intermedia | PASS |
| Suite completa backend | PASS: 3001 pruebas, 2981 aprobadas, 0 fallos, 20 omitidas |
| ESLint | PASS: 0 errores, 25 warnings preexistentes; archivo nuevo sin warnings |
| diff --check y revisión de alcance | PASS |
| Aplicación remota / Advisor alojado después / HTTP Data API | NO EJECUTADOS, por alcance y restricciones |

Las 20 omisiones corresponden a suites PostgreSQL/benchmark existentes que requieren activación propia; no se contabilizan como aprobadas. Las dos pruebas integradas PostgreSQL de este ticket se ejecutaron sin omisiones y pasaron. Después de la revisión final se repitieron ambas con las últimas guardas de preflight/rollback: 2 PASS, 0 FAIL. El archivo JavaScript nuevo también pasó ESLint con `--max-warnings=0`.

Checks locales: predicados oficiales 0008/0011/0028/0029 de Supabase Splinter, commit fijado `cd238c833d279c22863d46d7692d6d1d4ec39f6b`. No se denomina a esta comparación una ejecución del Advisor alojado completo.

| Aviso en el conjunto auditado | QA antes → después local | Fixture Producción antes → después local |
| --- | --- | --- |
| function_search_path_mutable | 31 → 0 | 36 → 0 |
| anon_security_definer_function_executable | 2 → 0 | 2 → 0 |
| authenticated_security_definer_function_executable | 4 → 2 | 4 → 2 |
| rls_enabled_no_policy del nuevo respaldo privado (INFO) | 0 → 1 | 0 → 1 |

Los dos avisos autenticados restantes son excepciones justificadas para `fn_is_super_admin` y `fn_es_admin_de_sucursal`, necesarios por RLS. PostgREST excluye retorno trigger de su catálogo RPC; las dos funciones booleanas son candidatas condicionadas al esquema/configuración runtime y permisos. No se probó HTTP remoto. No se revocó acceso autenticado necesario para perseguir un contador cero.

El respaldo privado añade un INFO esperado de RLS sin políticas: se conserva el rechazo por defecto a todos los roles API, además de sus REVOKE explícitos. No se crea una política permisiva para ocultar el diagnóstico. La prueba verifica ese INFO concreto. El respaldo y su protección se retienen también después del rollback; este restaura las funciones y sus permisos.

Comandos locales reproducibles, con PostgreSQL 17 instalado y el directorio de binarios configurado:

```powershell
$env:MASTERFADE_TEST_PG_BIN = 'C:/ruta/local/postgresql17/bin'
node --test test/security-supabase-02.pg.test.js
npm test
npm run lint
git diff --check
```

## E. Riesgos y SQL manual pendiente

Pendientes, sin ejecución remota por esta tarea: revisar el reporte `.preflight.sql`, sus propietarios/ACL/dependencias actuales y los esquemas expuestos de PostgREST; ejecutar el SQL principal únicamente bajo autorización operativa separada; guardar la salida/backup y repetir el Advisor alojado después. El rollback queda preparado para ese mismo cambio. Producción permanece fuera de autorización.

Los scripts usan una transacción y un advisory lock común para serializar aplicaciones/rollback de este ticket. No bloquean todo DDL externo: la ventana manual debe excluir otros cambios de funciones/grants/dependencias. Los guards detectan deriva conocida antes/después; no se afirma que sustituyan coordinación operativa con DDL ajeno. PL/pgSQL puede tener dependencias que `pg_depend` no registra de forma completa.

La prueba aislada no replica Auth/PostgREST ni todas las restricciones y datos reales de Supabase. No certifica cada flujo de negocio; sí verifica los contratos y accesos afectados sin alterar cuerpos. Los helpers conservan su contrato actual de consulta booleana para UUID suministrado por el llamador autenticado; cambiar ese contrato o moverlos de esquema exige otra revisión.

Otros diagnósticos actuales quedan fuera de este ticket: tres extensiones en public, nueve tablas con RLS sin políticas (INFO) y protección de contraseñas filtradas deshabilitada. No se cambian extensiones, Auth, tablas comerciales ni políticas para resolverlos. La corrección remota de los avisos sigue **pendiente** hasta aplicar y validar manualmente la propuesta.
