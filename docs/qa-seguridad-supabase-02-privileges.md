# QA-SEGURIDAD-SUPABASE-02: revisión de EXECUTE y dependencias

Revisión local: 2026-11-13. Este documento no aplica SQL ni cambia la lógica de las funciones.

## Evidencia y límites

- Los catálogos locales `../_PRODUCTION-PREP-20261028/evidence/qa-catalog.json` y `production-catalog.json` coinciden en las cuatro firmas, `SECURITY DEFINER`, `search_path` y los dos triggers de esta revisión. Son fotografías del 2026-10-28, no una certificación del catálogo actual.
- `../_ADMIN-DATA-ENTRY-20261028/sql-validation/prod-functions.json` contiene los cuerpos completos de esa fecha. Los catálogos no contienen propietarios ni ACL.
- `../database/BD-PG.sql` es un respaldo custom de junio de 2026. La extracción local con `pg_restore --schema-only` permite verificar propietarios históricos de tres funciones (`postgres`), pero no sus permisos actuales. `fn_citas_detalles_line_identity_v2` todavía no existía allí y el cuerpo de `fn_hold_defaults_y_unico` era diferente. No se deben restaurar cuerpos ni inferir ACL actuales desde ese respaldo.
- La búsqueda en `src` backend y `src` frontend locales no encontró llamadas `.rpc()` a estas cuatro funciones. Tampoco encontró configuración local de esquemas expuestos de PostgREST. La ausencia de llamadas de aplicación no impide llamadas externas a la API.
- Los JSON del Security Advisor preservados por la auditoría principal aportan evidencia de avisos actuales; un aviso de `EXECUTE` por sí solo no prueba que exista una ruta HTTP utilizable. No se realizaron llamadas RPC remotas ni consultas SQL remotas para esta revisión.

## Funciones y dependencias verificadas

| Firma en `public` | Tipo y contexto | Dependencias y uso | Decisión mínima |
| --- | --- | --- | --- |
| `fn_citas_detalles_line_identity_v2()` | `trigger`, PL/pgSQL, `SECURITY DEFINER`; path `pg_catalog, public, app_private` | Trigger `tr_zz_citas_detalles_line_identity`, `BEFORE INSERT OR UPDATE` sobre `citas_detalles`; consulta `public.citas`, `public.citas_detalles` y `app_private.build_booking_line_key_v1(integer, uuid, uuid, text, integer)`. Mantiene identidad de línea. | Quitar EXECUTE público/anónimo/autenticado directo, preservando al propietario y los permisos administrativos existentes. Conservar cuerpo y trigger. |
| `fn_hold_defaults_y_unico()` | `trigger`, PL/pgSQL, `SECURITY DEFINER`; path `pg_catalog, public, app_private` | Trigger `tr_hold_unico`, `BEFORE INSERT` sobre `citas_holds`; usa `app_private.obtener_hold_ttl_min_v1()` y `app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid)`, bloqueo asesor y `public.citas_holds`. | Igual que el trigger de identidad. No sustituir el cuerpo por el dump antiguo ni alterar el TTL. |
| `fn_is_super_admin(uuid)` | `boolean`, SQL, `STABLE SECURITY DEFINER`; path `public, auth` | Llama `public.fn_has_role(uuid, text)`. Las políticas de RLS lo usan con `auth.uid()` en usuarios, roles, clientes, empleados, citas y tablas relacionadas. | Mantener EXECUTE para `authenticated` porque RLS lo necesita. Denegar acceso anónimo innecesario, sin alterar las políticas. |
| `fn_es_admin_de_sucursal(uuid, uuid)` | `boolean`, SQL, `STABLE SECURITY DEFINER`; path `public, auth` | Llama `fn_is_super_admin(uuid)`; consulta `roles_usuarios` y `roles` no cualificadas, resueltas en `public`. Usada por RLS de citas, detalles, holds, empleados, clientes, horarios, bloqueos y pagos. | Mantener EXECUTE para `authenticated`, preservar resolución de `public` y el acceso administrativo existente. |

En el dump local, todas las políticas identificadas que llaman estos helpers son `TO authenticated`. Ejemplos concretos: `p_citas_select_scope`, `p_citas_update_staff`, `p_clientes_select_scope`, `p_holds_select_scope`, `p_roles_usuarios_select_scope` y `p_usuarios_select_self`. Revocar EXECUTE a `authenticated` sobre los helpers provoca fallos de permisos durante la evaluación de RLS, aunque el frontend no haga una llamada RPC explícita.

La revisión de resolución de objetos encontró una dependencia adicional indispensable: `public.fn_has_role(uuid, text)`. Su cuerpo SQL real consulta `roles_usuarios` y `roles` sin cualificar y tiene configuración propia `public, auth`. Si `pg_temp` no se especifica, una tabla temporal puede preceder a esas relaciones. Endurecer solo `fn_is_super_admin` no protege la consulta dentro de `fn_has_role`, porque cada función aplica su propia configuración. El alcance propuesto incorpora esta dependencia como rutina 41, conserva su cuerpo/ACL y fija su path junto con los dos helpers a `pg_catalog, public, auth, pg_temp`. Los dos triggers usan `pg_catalog, public, app_private, pg_temp`.

## Exposición RPC

PostgREST requiere que la función esté en un esquema expuesto y que el rol activo pueda ejecutarla. Su [documentación de RPC](https://docs.postgrest.org/en/v14/references/api/functions.html) describe ambas condiciones. Además, el [código oficial v14.3 de la caché de esquema](https://github.com/PostgREST/postgrest/blob/v14.3/src/PostgREST/SchemaCache.hs#L444) excluye explícitamente funciones que retornan `trigger`.

Por ello, los dos triggers no deben clasificarse como RPC utilizables únicamente por aparecer en el Advisor. Los helpers booleanos sí son candidatos de RPC si `public` está expuesto y `authenticated` tiene EXECUTE. La configuración real, la versión de PostgREST y la caché HTTP no se han verificado remotamente; la exposición HTTP se reporta como condicional.

Los helpers aceptan `p_uid` sin exigir que coincida con `auth.uid()`. Una llamada directa autorizada puede consultar si un UUID posee un rol, y el segundo helper permite consultar su alcance de sucursal. Mantenerlos para RLS deja esta superficie de consulta de booleanos. No se cambia su contrato en este endurecimiento: moverlos a esquema privado o crear wrappers exige otra revisión de dependencias y API.

## Criterios de la migración manual

1. Resolver cada función por firma completa; verificar retorno, propietario, cuerpo/configuración esperados y trigger/dependencias antes de cambiar permisos. Ante deriva no reconocida, abortar la transacción.
2. Capturar `pg_get_functiondef`, `proowner`, `proconfig` y `proacl` antes del cambio. Distinguir ACL nula de ACL explícita y conservar grantor y grant options para un rollback fiel.
3. Revocar EXECUTE sobre los dos triggers de `PUBLIC`, `anon` y `authenticated`. Si `service_role` tenía acceso efectivo vía PUBLIC, conservarlo con GRANT explícito antes del REVOKE. No borrar grantees administrativos explícitos ni conceder privilegios nuevos por suposición.
4. Mantener EXECUTE efectivo de `authenticated` sobre ambos helpers y de `fn_is_super_admin` para el propietario del helper que lo invoca. Un REVOKE idempotente a `anon` solo es correcto si no cambia una dependencia legítima; conservar esta comprobación en preflight.
5. No recrear funciones/triggers ni modificar cuerpos, propietarios, estados, datos, autenticación o lógica de negocio para resolver avisos de permisos.
6. Fijar `pg_temp` al final de las rutas explícitas de las cuatro funciones privilegiadas y de `fn_has_role`; conservar el orden relativo de los esquemas de aplicación para mantener la resolución existente.

La [documentación de PostgreSQL 17](https://www.postgresql.org/docs/17/sql-createtrigger.html) exige EXECUTE para crear un trigger. La prueba local también confirma que quitar EXECUTE al usuario que inserta no impide que un trigger ya creado se ejecute. El rol de futuras operaciones DDL debe conservar su permiso.

## Pruebas y riesgos que debe cubrir la certificación

- PASS local: PostgreSQL 17 aislado, función sintética `SECURITY DEFINER RETURNS trigger`; `authenticated` sin EXECUTE explícito ni heredado de PUBLIC inserta y el trigger existente ejecuta su transformación. Se conservaron privilegios del propietario y `service_role`. Esta prueba verifica la semántica de ACL; no reemplaza las regresiones de las funciones reales.
- PASS local: `test/sql/security-supabase-02-rls-cases.sql` ejecutado antes y después de revocar EXECUTE directo de los dos triggers; utiliza los cuatro cuerpos reales, dependencias reales `fn_has_role`, construcción de clave y TTL, políticas de ramas administrativas/propietario y roles sintéticos. Cubre cliente propio/ajeno, administradores A/B/inactivo, superadministrador, UPDATE cruzado y WITH CHECK, generación/inmutabilidad de identidad y defaults/rechazos de holds. Las tablas son mínimas y el helper de expiración es un stub explícito; no se certifica su limpieza de reservas/pagos. Cada ejecución usa ROLLBACK y no conserva filas.
- PASS de integración: el mismo archivo pasa sobre el fixture compartido de 55 tablas y 41 cuerpos originales, antes y después de los cambios de permisos/ruta propuestos. Con `qa_security02.expect_hardened=true`, `authenticated` crea tablas temporales `roles`/`roles_usuarios` con membresías falsas de superadministrador y administrador; ambos helpers devuelven false y las políticas conservan el alcance del cliente. El escenario adversarial se exige después del endurecimiento, porque el baseline contiene la configuración vulnerable identificada.
- Verificar las cuatro funciones reales antes/después con `has_function_privilege` para `anon`, `authenticated`, `service_role` y propietario. Verificar también privilegios por pertenencia a otros roles y grants con opción de concesión.
- Con usuarios sintéticos: cliente propio/ajeno, administrador de sucursal A/B y superadministrador; comprobar acceso cruzado, políticas SELECT/UPDATE y retorno de helpers. Las expectativas deben comparar estado previo y posterior.
- Insertar/actualizar líneas de cita con los triggers reales y dependencias presentes; probar identidad inmutable y clave inválida. Insertar holds válidos, expirados, duplicados y concurrentes sin cambiar el margen/TTL existente.
- Ejecutar dos veces la migración y rollback; verificar que definiciones, ACL, configuración y resultados de RLS se restauran fielmente, sin cambios en filas históricas.
- Comparar los avisos equivalentes en PostgreSQL aislado. Los dos avisos autenticados de helpers RLS quedan como excepciones justificadas; no se debe perseguir un contador cero rompiendo RLS.

Riesgos restantes: propietario/ACL/configuración remota pueden haber cambiado desde las fotografías; dependencias PL/pgSQL no siempre aparecen íntegramente en `pg_depend`; un `search_path` explícito todavía necesita que los esquemas confiables no sean escribibles por roles no confiables. La propuesta elimina el sombreado temporal identificado en los helpers y su dependencia; todavía requiere ejecución manual autorizada para cambiar el entorno remoto. No hubo ensayo HTTP real del Data API. El preflight manual y los controles locales reducen estos riesgos sin escribir en QA o Producción.
