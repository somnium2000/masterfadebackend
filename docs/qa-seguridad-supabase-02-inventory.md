# QA-SEGURIDAD-SUPABASE-02 — Inventario y procedencia

## Alcance y fuentes

Inventario de solo lectura; no se ejecutó SQL remoto ni se modificaron entornos. Los archivos `test/fixtures/security-supabase-02/advisors-qa.json` y `advisors-production.json` fueron obtenidos por el agente principal mediante `get_advisors`, sin `execute_sql`. Sus observaciones del 13 de noviembre de 2026 confirman **31 avisos QA y 36 Producción** de `function_search_path_mutable`.

El Advisor identifica esquema/nombre, pero no publica en estas respuestas los argumentos, propietarios, cuerpo ni el grafo `pg_depend`. Por ello las firmas, cuerpos y dependencias siguientes se contrastan con fuentes locales y se identifican como snapshots; el preflight de ejecución manual debe volver a verificarlos dentro de la base de destino.

Fuentes locales:

- `_PRODUCTION-PREP-20261028/evidence/qa-catalog.json`: 359 funciones, 143 triggers; esquema, argumentos, proconfig y SECURITY DEFINER; sin propietarios ni cuerpos.
- `_PRODUCTION-PREP-20261028/evidence/production-catalog.json`: 352 funciones, 137 triggers; mismo alcance de metadatos.
- `_ADMIN-DATA-ENTRY-20261028/sql-validation/prod-functions.json`: 102 definiciones de función, incluidas las 35 funciones objetivo; sin columna de propietario.
- `database/BD-PG.sql`, extracción de esquema local con pg_restore: definición y propietario de `fn_marcar_no_show(integer,integer)`, que es **PROCEDURE**, no FUNCTION. También confirma propietario `postgres` para treinta de las treinta y seis rutinas. Seis rutinas no aparecen en ese dump antiguo; su propietario actual queda pendiente.
- `_QA_Certificacion_Local/QA-SEG-01-20261025/supabase-readonly.json`: captura QA del 25 de octubre con propietarios, ACL y políticas para funciones privilegiadas. Es contexto histórico, no prueba de ACL/propietarios actuales.
- `db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql`: definición literal de los cinco objetos que QA ya tiene con search_path fijo, según la instrucción de aplicación anterior y el Advisor actual. Se incluye como variante del fixture QA; no se reaplica ni se modifica su lógica.

`test/fixtures/security-supabase-02/routines.json` contiene 41 rutinas: 36 advertidas en Producción, las cuatro privilegiadas y una dependencia necesaria de las funciones de autorización. Cada entrada registra firma, prokind, definición literal, prosrc/hash MD5/SHA-256 y procedencia. Los campos `prosrc_md5`/`prosrc_sha256` conservan el cuerpo literal; los campos con sufijo `_lf` normalizan únicamente CRLF a LF para validar exportaciones con finales de línea distintos (ocho cuerpos fuente contienen CRLF). `prorettype_regtype_snapshot` y `prokind_snapshot` se obtienen de las declaraciones locales; no son OID remotos. Las cinco variantes QA se identifican con `qa_definition_override`; no se afirma que esos cuerpos sean una extracción actual de QA. `docs/qa-seguridad-supabase-02-inventory.json` conserva el manifiesto compacto de inventario y dependencias observadas.

## Comparación de avisos

Los 31 objetos advertidos en QA son subconjunto de los 36 advertidos en Producción. Las cinco diferencias son dos overloads y tres funciones:

- `public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)`
- `public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)`
- `public.fn_points_tx_guard_acumular_final()`
- `public.fn_trg_otorgar_puntos_plan_confirmada()`
- `public.fn_trg_otorgar_puntos_por_cita()`

No corresponde restaurar cuerpos antiguos de Producción sobre QA: la propuesta debe limitarse a metadatos y preservar la configuración ya fijada en QA. Estas funciones se incluyen solo por el aviso de search_path; no se autoriza cambiar reglas comerciales de MasterPuntos.

En los snapshots del 28 de octubre, todas las firmas de Producción estaban también en QA. QA tenía siete funciones adicionales de app_private; las únicas diferencias de proconfig observadas eran `fn_auditar_bitacora` (fija en QA, mutable en Producción) y `mf1b1_expirar_reservas_cliente_v1` (path distinto). Ninguna pertenece a los 36 avisos actuales y no se debe ampliar el cambio a ellas automáticamente.

## Inventario de las 36 rutinas

La columna Propietario es del dump local, nunca una afirmación de propietario actual en QA/Producción. Todos los cuerpos de los 36 objetivos en las fuentes locales son SECURITY INVOKER. Triggers Q/P son dependencias observadas en los snapshots de octubre; cero no prueba ausencia de llamadas desde SQL, procedimientos, cron o aplicación.

| Firma local en public | Tipo | Aviso QA | Aviso Prod | Propietario local | Triggers Q/P |
|---|---|---:|---:|---|---:|
| `fn_agenda_excepciones_sucursal_bloques_validar_modo()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_agenda_excepciones_sucursal_validar_compatibilidad()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_bloquear_delete_fisico()` | FUNCTION | sí | sí | postgres | 5/5 |
| `fn_bloquear_persona_cliente_empleado()` | FUNCTION | sí | sí | postgres | 2/2 |
| `fn_citas_grupos_set_defaults()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_citas_integrantes_set_updated_at()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_citas_integrantes_validate_limits()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_citas_set_integrante_from_legacy()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_comprobantes_agendamiento_set_defaults()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_comprobantes_destinatarios_set_updated_at()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_desactivar_tarifas_base_de_servicio()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_facturas_set_updated_at()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_guardar_desactivacion_servicio()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_marcar_no_show(integer, integer)` | PROCEDURE | sí | sí | postgres | 0/0 |
| `fn_points_estado_final_cita()` | FUNCTION | sí | sí | postgres | 0/0 |
| `fn_points_get_effective_rule(uuid)` | FUNCTION | sí | sí | postgres | 0/0 |
| `fn_points_get_or_create_active_cycle(uuid, integer, timestamp with time zone)` | FUNCTION | no | sí | postgres | 0/0 |
| `fn_points_get_or_create_active_cycle(uuid, timestamp with time zone)` | FUNCTION | no | sí | postgres | 0/0 |
| `fn_points_materialize_expired_cycles(uuid)` | FUNCTION | sí | sí | postgres | 0/0 |
| `fn_points_tx_apply_tipo_sign()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_points_tx_guard_acumular_final()` | FUNCTION | no | sí | postgres | 1/1 |
| `fn_prevent_block_protected_correo()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_prevent_block_protected_persona()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_prevent_block_protected_role()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_prevent_block_protected_usuario()` | FUNCTION | sí | sí | no observado | 1/1 |
| `fn_set_updated_at()` | FUNCTION | sí | sí | postgres | 46/46 |
| `fn_trg_otorgar_puntos_plan_confirmada()` | FUNCTION | no | sí | postgres | 0/0 |
| `fn_trg_otorgar_puntos_por_cita()` | FUNCTION | no | sí | postgres | 1/1 |
| `fn_trg_roles_usuarios_unicidad_scope()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_trg_validar_cliente_persona_en_cita()` | FUNCTION | sí | sí | postgres | 1/1 |
| `fn_validar_paquete_activo_minimo_servicios()` | FUNCTION | sí | sí | postgres | 2/2 |
| `fn_validar_paquete_activo_sin_servicios_inactivos()` | FUNCTION | sí | sí | postgres | 2/2 |
| `fn_validar_persona_empleado_campos_obligatorios()` | FUNCTION | sí | sí | postgres | 2/2 |
| `fn_validar_servicio_activo_con_tarifa_base()` | FUNCTION | sí | sí | postgres | 2/2 |
| `set_current_timestamp_updated_at()` | FUNCTION | sí | sí | postgres | 1/1 |
| `validate_membership_plan_beneficios()` | FUNCTION | sí | sí | postgres | 1/1 |

## Propietarios y dependencias: límites de la comparación

Las seis funciones sin propietario en el dump local son `fn_agenda_excepciones_sucursal_bloques_validar_modo`, `fn_agenda_excepciones_sucursal_validar_compatibilidad`, `fn_prevent_block_protected_correo`, `fn_prevent_block_protected_persona`, `fn_prevent_block_protected_role` y `fn_prevent_block_protected_usuario`. Sus definiciones sí están en el snapshot de Producción de octubre. No se debe inferir propietario a partir del rol que ejecutó aquella consulta.

Los cuerpos examinados de estas 36 rutinas no requieren resolución de objetos de esquemas externos desconocidos: las referencias de esquema explícitas que aparecen son `public.*`; los nombres incorporados de PostgreSQL corresponden a `pg_catalog`. No se encontró SQL dinámico, `current_setting` ni modificación de `search_path` en los cuerpos. Las únicas llamadas sin calificar que merecen contraste por versión son `gen_random_uuid()` en `fn_citas_grupos_set_defaults` y `fn_comprobantes_agendamiento_set_defaults`: en PostgreSQL 13+ está incorporada en `pg_catalog`. El resto de las llamadas sin calificar examinadas son funciones incorporadas (`now`, `make_interval`, `format`, `regexp_replace`, `jsonb_array_length`, etc.). El path propuesto `pg_catalog, public, pg_temp` cubre este corpus sin depender del path del invocador. Esto no sustituye verificar la resolución de tipos, `%ROWTYPE` y llamadas indirectas en la base aislada.

Las dependencias de triggers están listadas por tabla/nombre en el manifiesto. Las cuatro funciones privilegiadas requieren revisión separada: dos devuelven trigger y no son RPC ordinarios, mientras que `fn_es_admin_de_sucursal(uuid,uuid)` y `fn_is_super_admin(uuid)` devuelven boolean y aparecen en políticas RLS. El snapshot de octubre confirma que authenticated tiene EXECUTE de ambas; retirarlo por el mero hecho de ser SECURITY DEFINER rompería esas políticas. El informe de permisos del ticket debe resolver la exposición real de PostgREST (esquemas expuestos, USAGE, EXECUTE, tipo de retorno y ACL efectivas), sin sustituirla por una presunción basada únicamente en el esquema public.

La rutina `fn_marcar_no_show(integer,integer)` tiene defaults locales 10 y 500. El ajuste de metadatos debe conservar estos defaults; no se modifica ningún margen comercial ni se ejecuta el procedimiento sobre datos históricos.

## Dependencia necesaria de autorización

`public.fn_has_role(uuid,text)` se incluye como objetivo de metadatos por dependencia directa de `fn_is_super_admin(uuid)` y transitiva de `fn_es_admin_de_sucursal(uuid,uuid)`. No genera un aviso `function_search_path_mutable`: su definición ya fija `public, auth`, pero su SQL SECURITY DEFINER resuelve `roles_usuarios` y `roles` sin calificar. Un esquema temporal del invocador se busca antes que los esquemas ordinarios cuando `pg_temp` no figura explícitamente en el path. Fijar solo los dos helpers dejaría esa resolución transitiva expuesta.

El ajuste propuesto para los tres helpers es `pg_catalog, public, auth, pg_temp`, que mantiene los objetos públicos y de autenticación esperados y coloca el esquema temporal al final. La función conserva firma, propietario, cuerpo, condición SECURITY DEFINER y ACL; no se amplía el alcance de GRANT/REVOKE a esta dependencia. Los dos triggers privilegiados usan `pg_catalog, public, app_private, pg_temp`.

Su definición literal proviene de `_ADMIN-DATA-ENTRY-20261028/sql-validation/prod-functions.json`. El propietario `postgres` y el path histórico `public, auth` constan en `_QA_Certificacion_Local/QA-SEG-01-20261025/supabase-readonly.json`; no acreditan el propietario ni la ACL actuales. El fixture marca `dependency_target: true`, `qa_warning: false` y `production_warning: false`, y conserva hashes y tipo de retorno para el preflight.

## Corrección QA-SEGURIDAD-SUPABASE-02B

Los hashes comunicados por el preflight de lectura del usuario coinciden con definiciones activas versionadas: `fn_points_materialize_expired_cycles(uuid)` con `20261030010000_masterpuntos_readonly_expiration_v1.sql`, y `fn_points_tx_guard_acumular_final()` / `fn_trg_otorgar_puntos_por_cita()` con `20261113161929_masterpuntos_paid_confirmation_v1.sql`. Los inventarios registran estas tres variantes en `verified_variants_02b`, con hash LF, fuente, commit y entornos reportados. Las definiciones históricas y variantes anteriores se conservan.

La lista permitida de cada firma se amplía en el SQL manual y su reporte de preflight, con revisión semántica y controles de rechazo por firma/cuerpo. Las guardas de propietario, contrato, ACL, respaldo y rollback permanecen iguales. [Informe 02B, comparación y pruebas](qa-seguridad-supabase-02b.md).
