# AM: Evidencia SQL descartable del hotfix administrativo

Motor: PostgreSQL 17.5 / PGlite 0.3.14 (WASM); esquema origen: PostgreSQL 17.6 de Producción, capturado por SELECT de metadatos, sin registros reales. Se reconstruyeron 102 tablas, 6 vistas, 102 funciones SQL/PLpgSQL de aplicación, 569 constraints y 137 triggers, además de índices/defaults/columnas generadas. Extensiones locales citext, btree_gist y pg_trgm.

Auth.users/Auth.sessions/auth.uid-role-jwt y cron.job son fixtures locales estructurales; no se simulan servicios cloud como un E2E aprobado ni se ejecuta un scheduler. Funciones C de extensiones que no son del contrato bajo prueba no se reconstruyeron. No hay conexión PostgreSQL externa ni credenciales reales. La comparación de catálogo no sustituye respaldo recuperable antes de DDL real.

Los seis SQL originales se mantuvieron idénticos byte a byte al ZIP aprobado. Cada uno se ejecutó dos veces en el motor descartable, todas PASS. El preflight backend productivo se ejecutó realmente contra ese motor y pasó sin omitir requisitos de pagos.

Aserciones funcionales PASS:
- actual runDatabaseSchemaPreflight PASS
- Guest without DNI rejected; provided DNI -> barber created; same Persona preserved
- Global Cliente role accepts NULL; inactive branch role rejected
- Future cita and tariff on inactive branch rejected by actual guard, before other operations
- Existing active employee unchanged allowed; deactivate allowed; reactivate in inactive branch blocked
- Actual password_reset constraint contract accepts productive revocation shape
- fk_usuario_auth preserved exactly
- Unrelated synthetic third Persona unchanged

Impacto de 25_sucursal_guards.sql: rechaza nuevos Empleados/roles/tarifas activas y citas futuras operativas en sucursal inactiva. Roles globales sin sucursal no se bloquean. Permite inactivar y conservar filas existentes con sucursal sin cambiar; reactivar en sucursal inactiva falla. No migra ni cancela citas, no concede permisos de reserva y el modo administrativo sigue denegando la API de agenda. La coordinación FOR SHARE con escritores está en el SQL original de QA; no se certificó concurrencia multi-conexión del servicio cloud con WASM.

Hashes del SQL reutilizado:
- sql/00_readonly_before.sql: 396e23d51bc9e380835499ee377fd04fd67a08d016c24c857d6a1d91187d7fbd
- sql/10_startup.sql: 15a4e2536c17468fdd26af983464f06b0a520e29246aac9c895dd3f04effa343
- sql/20_personas.sql: a1062b74df116dea2433b6c5c4bd38f07e5bc3d2c50f9f8df93128b404790a1a
- sql/25_sucursal_guards.sql: 75694af44c62c695524b63a2fe88066c728954fb4880cf81a6bb0f6229bd457d
- sql/30_verify_startup.sql: 38b17276bdbfbbd77c3cbfd84320d58f00f8880b9e0d4317f6eb62de32eefa78
- sql/31_verify_admin.sql: f33a29e979ebd978337b67b2a3a65592efb50c2868d2139797a4c878f279e317

Resultado: SQL listo para revisión y ejecución manual futura, pendiente de respaldo recuperable, confirmación de destino/rol runtime y autorización separada. No se ejecutó DDL ni se modificó la FK de Producción.
