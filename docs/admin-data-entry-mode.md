# AM: Modo de carga administrativa

Configurar simultáneamente ADMIN_DATA_ENTRY_MODE=true y PAYMENT_PROVIDER=disabled. La configuración contradictoria o un booleano inválido impide arranque. No configurar claves de pasarelas para este modo. El apagado no cambia algoritmos comerciales ni contratos financieros: la fábrica rechaza antes de inicializar o retornar instancias cacheadas.

La política global onRequest aplica deny-by-default antes de parsers/handlers de negocio y sin excepción para Super Admin/Root. Únicamente permite las combinaciones exactas exportadas en ADMIN_DATA_ENTRY_ROUTES; HEAD acompaña GET y OPTIONS * es solo preflight CORS. No hay autorización por prefijo ni por valores enviados por el cliente. Los controles de sesión, roles, identidad y sucursales originales siguen aplicándose.

Clientes de referencia: adminPersonasApi.js, adminCatalogApi.js, adminPackagesApi.js, adminPlansApi.js, adminCortesiasApi.js, adminEmpleadosApi.js y adminSucursalesApi.js del frontend main 636297ad531bbfcecc5313b02722e323eff40107. Sucursales solo consulta; perfil Barbero solo GET. Pagos/webhooks/ventas, citas/agenda, membresías, registro/provisión pública, eliminación, finanzas, configuración sensible y rutas nuevas permanecen bloqueados. Los menús/widgets no autorizados pueden mostrar 403; no se modificó frontend.

Storage permite prepare/read-url únicamente para public_barber_profile, public_service_image y private_client_profile. Verifica entidad/scope y metadatos de lectura (bucket/visibilidad); los guardas anteriores todavía resuelven pertenencia, permisos y sucursal. El endpoint genérico DELETE de assets no está habilitado; limpiar la foto usa el flujo de edición existente, no borrado arbitrario.

Exchange permite solo identidad interna ya existente, verificada primero con Supabase. La validación posterior original de sesión Auth sigue vigente. No se permite social/confirm para crear una cuenta. Recuperación sigue neutra y no se usa refresh como prueba de identidad.

En modo administrativo se omite el scheduler de alertas de membresías y se fuerza agenda SSE apagado. No altera cron jobs de PostgreSQL ni el acceso directo al proyecto Supabase; mantener claves privadas, permisos RLS existentes y configuración de registro/OAuth productiva revisados. No exponer otro proceso/versión del backend que carezca de esta política. NODE_ENV sigue production; no usar mock ni simuladores.

SQL: se reutilizan sin cambios los seis archivos del paquete MASTERFADE-PRODUCTION-PREP-20261028. Validación real descartable PostgreSQL 17.5 frente a estructura productiva 17.6, sin registros reales ni conexión cloud; Auth/cron son fixtures locales. No habilita eliminación: fk_usuario_auth CASCADE permanece intacta. Respaldo recuperable, verificación del destino y autorización separada siguen siendo obligatorios antes de DDL productivo.

Rollback de aplicación: retirar este hotfix solo con acceso externo restringido, antes de volver a configuración normal autorizada. No poner ADMIN_DATA_ENTRY_MODE=false con PAYMENT_PROVIDER=disabled: fallará deliberadamente. El rollback SQL se mantiene aditivo según paquete; no borrar históricos ni retirar la FK.
