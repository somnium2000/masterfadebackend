# QA-SEGURIDAD-SUPABASE-02 — checks locales del Advisor

Fecha de consulta: 13 de noviembre de 2026. Ningún SQL de este trabajo se ejecutó remotamente.

## Fuente fijada y alcance

`test/sql/security-supabase-02-advisor.sql` conserva los predicados y columnas de cuatro checks oficiales de [Supabase Splinter, commit cd238c833d279c22863d46d7692d6d1d4ec39f6b](https://github.com/supabase/splinter/tree/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints). El único cambio estructural es sustituir `CREATE VIEW lint... AS` por CTEs y unir los resultados con `UNION ALL`. Es un archivo de solo SELECT, sin crear vistas ni funciones. Incluye la licencia PostgreSQL original de Supabase.

- [0008_rls_enabled_no_policy.sql](https://github.com/supabase/splinter/blob/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints/0008_rls_enabled_no_policy.sql): informa tablas regulares con RLS habilitado y ninguna política, excluyendo schemas internos y objetos de extensiones. Su nivel es INFO; no distingue una omisión de una denegación predeterminada intencional.
- [0011_function_search_path_mutable.sql](https://github.com/supabase/splinter/blob/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints/0011_function_search_path_mutable.sql): detecta ausencia de una entrada `search_path=` en `pg_proc.proconfig`, excluye schemas internos y funciones pertenecientes a extensiones (`pg_depend.deptype='e'`). **No comprueba que el contenido del path sea seguro**; borrar un aviso no sustituye las pruebas de resolución de objetos.
- [0028_anon_security_definer_function_executable.sql](https://github.com/supabase/splinter/blob/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints/0028_anon_security_definer_function_executable.sql): combina `prosecdef`, privilegio EXECUTE efectivo de anon y pertenencia a los schemas de `pgrst.db_schemas`, usando public como valor predeterminado cuando no existe el ajuste.
- [0029_authenticated_security_definer_function_executable.sql](https://github.com/supabase/splinter/blob/cd238c833d279c22863d46d7692d6d1d4ec39f6b/lints/0029_authenticated_security_definer_function_executable.sql): equivalente para authenticated.

Los checks de EXECUTE consideran la herencia de PUBLIC y roles mediante `has_function_privilege`. No excluyen funciones que devuelven trigger ni aplican la exclusión de pertenencia a extensión de 0011. Para reproducirlos deben existir los roles anon y authenticated y debe configurarse localmente `pgrst.db_schemas` conforme a la evidencia del entorno reproducido. Un valor predeterminado public no demuestra la configuración real del proyecto.

Este conjunto es una reproducción local de checks oficiales fijados a un commit, **no una ejecución del Security Advisor alojado de QA o Producción ni de todos sus checks**. Los recuentos de avisos de los snapshots de cada entorno deben conservarse separados de los recuentos obtenidos de una reconstrucción local.

La tabla de respaldo `app_private.security02_routine_backup` tiene RLS habilitado sin políticas y privilegios restringidos. La migración introduce por ello un INFO 0008 intencional: los roles sin BYPASSRLS ni propiedad no obtienen acceso por una política permisiva. Se conserva como excepción justificada para proteger definiciones y ACL del respaldo; no se agrega una política solo para silenciar el Advisor. El INFO histórico de `app_private.guest_registration_requests`, presente en los snapshots, es independiente y no se corrige con este cambio. Una prueba aislada PostgreSQL 17.11 del check sobre esa tabla verificó 0 → 1 y nivel INFO; el inventario completo debe distinguir los avisos previos del nuevo.

## Aviso de EXECUTE frente a RPC real

PostgREST publica funciones que pertenecen a un schema expuesto y son accesibles al rol activo, según su [documentación de RPC](https://docs.postgrest.org/en/stable/references/api/functions.html). Además, su consulta de catálogo filtra explícitamente el retorno trigger, el tipo de objeto función y la invocabilidad de argumentos: [PostgREST, commit e5b4fac1c7a192af50a82dd3639ac47316ba60d3, Catalog/Query.hs líneas 155–157](https://github.com/PostgREST/postgrest/blob/e5b4fac1c7a192af50a82dd3639ac47316ba60d3/src/library/PostgREST/Catalog/Query.hs#L155).

Por tanto, un trigger SECURITY DEFINER puede aparecer en 0028/0029 aunque esté excluido de la caché de RPC. Su permiso de ejecución y el permiso para crear/activar triggers deben auditarse por separado. El aviso no demuestra por sí solo una llamada RPC explotable. Tampoco una llamada SQL directa a un trigger devuelve un resultado normal: PostgreSQL exige contexto de trigger.

Las funciones booleanas usadas por RLS son otra categoría: pueden ser llamadas por las políticas y, si su schema está expuesto y el rol tiene EXECUTE, también ser candidatas a RPC. Suprimir EXECUTE de authenticated para eliminar un aviso puede romper RLS, autenticación y acceso por sucursal. Debe conservarse una excepción justificada cuando ese permiso es necesario y la función valida identidad y alcance.

## Validación local del archivo de checks

Se ejecutó el SQL de checks en un cluster temporal PostgreSQL 17.11 con anon y authenticated, dos funciones SECURITY DEFINER sintéticas sin path (una booleana y otra trigger) y una función con path fijo. Los resultados esperados se verificaron mediante aserciones:

| Check | Antes | Después de fijar paths y revocar únicamente la booleana sintética |
|---|---:|---:|
| function_search_path_mutable | 2 | 0 |
| anon_security_definer_function_executable | 2 | 1 |
| authenticated_security_definer_function_executable | 2 | 1 |

Los dos avisos remanentes corresponden al mismo trigger sintético. La prueba verifica deliberadamente que el check oficial no lo oculta por su tipo de retorno. Estos valores validan el archivo reproducido; **no representan el inventario de MASTERFADE**.

Para el cambio de MASTERFADE se debe guardar el resultado completo antes y después de la migración y comparar por `name` y `cache_key`; para funciones sobrecargadas, complementar con firma/OID, propietario, proconfig y ACL. Conservar en el informe cada excepción de EXECUTE necesaria para RLS y cada hallazgo fuera del alcance autorizado.

## Fixture local de funciones reales

`test/sql/security-supabase-02-fixture.sql` crea únicamente el soporte de una base temporal: roles anon/authenticated/service_role, contratos locales `auth.uid()`/`auth.role()` mediante claims, schemas y 55 tablas con 653 columnas. Los tipos, defaults y las cuatro columnas generadas de minutos proceden del catálogo QA guardado el 28 de octubre de 2026; el SHA256 del catálogo fuente figura en el SQL. No contiene filas históricas.

Las tablas son stubs y omiten NOT NULL, PK, FK, CHECK, índices, RLS y triggers; estos últimos se adjuntan por separado con sus definiciones originales cuando se prueban. Esta simplificación permite aislar resolución de objetos y permisos y no acredita la totalidad de las restricciones del schema real. `service_role` tiene BYPASSRLS local y no se instancia el servicio Supabase Auth ni PostgREST.

Los auxiliares `fn_has_role`, `build_booking_line_key_v1` y `obtener_hold_ttl_min_v1` conservan cuerpos reales del snapshot. El único stub de comportamiento es `expirar_reservas_vencidas_v1`: no cambia reservas ni pagos y aborta explícitamente si encuentra un hold activo vencido del alcance solicitado. Las pruebas del trigger de holds cubren defaults, TTL y rechazo de duplicados sin reservas vencidas; la limpieza real queda fuera de esta reconstrucción.

Prueba de carga PASS en PostgreSQL 17.11: fixture completo, 41 rutinas del JSON —40 auditadas y `fn_has_role` como dependencia— cargadas con validación normal de cuerpos; igualdad exacta de `pg_proc.prosrc` frente al snapshot en las 41 firmas; claims nulos y claims de usuario/rol validados. La creación satisfactoria de una rutina PL/pgSQL no ejecuta todas sus ramas: los casos RLS y de triggers complementan la carga y su alcance se informa por separado.
