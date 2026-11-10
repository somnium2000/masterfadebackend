# Matriz de politica productiva

Base: 674c26dd5e909141428fac739d6bd84862672db9. Guard activo y pagos disabled. Cada excepcion del codigo es metodo + plantilla exacta; las agrupaciones de esta tabla no son comodines del guard.

| Pantalla / accion | Metodo y ruta registrada (base /v1) | Permiso original | Efecto / politica | Prueba |
|---|---|---|---|---|
| Personas / catalogos y detalle | GET /admin/personas, /catalogos, /roles, /usuarios, /empleados, /empleados/:id_empleado, /clientes, /clientes/:id_cliente | requireRoles especifico por entidad; restricciones de rango y sucursal originales | Consulta permitida | admin-data-entry-mode; personas-* |
| Personas / guardar y estado | POST /admin/personas/roles, /empleados, /clientes, /usuarios-internos; PATCH /admin/personas/usuarios/:id_usuario y sus /estado-acceso, /bloquear, /activar, /inactivar; PATCH empleados/clientes y sus /activar, /inactivar; POST usuario /enviar-configuracion-password | Guardas originales por entidad, cuenta protegida y rango | CRUD y configuracion existentes permitidos; no cambia asignacion de roles | personas-*; admin-security-users.qa09c |
| Eliminaciones / lista y detalle | GET /admin/account-deletion/requests y /requests/:requestId | ADMIN_ACCOUNT_DELETION_ADMIN_ROLES | Consulta permitida, filtros parametrizados | admin-account-deletion.qa10 |
| Eliminaciones / decidir y reintentar | POST /admin/account-deletion/requests/:requestId/approve, /reject, /retry | decisionRoles; rango, cuenta protegida, identidad propia, dependencias, reautenticacion | Acciones existentes; no bypass de confirmaciones ni ejecucion repetida | admin-account-deletion.qa10; accountDeletion* |
| Sucursales / consultar | GET /admin/sucursales; /empresas; /:id | Listado admin/super_admin; detalle y empresas super_admin | Permitido | admin-sucursales-* |
| Sucursales / guardar y estado | POST /admin/sucursales; PATCH /admin/sucursales/:id, /:id/activar, /:id/inactivar; DELETE /:id | super_admin; lock y dependencias | Permitido; DELETE es alias de inactivacion, sin borrado fisico | admin-sucursales-qa08 |
| Servicios / tarifas y barberos | GET /admin/catalog/servicios y /agrupados; POST servicios; PATCH /:id y /:id/estado, /:id/desactivar-global; POST /:id_servicio/tarifas; PATCH /:id_servicio/tarifas/:id_sucursal y /desactivar; GET/PUT /:id/barberos; DELETE /:id | Roles y aislamiento de catalog.js | Gestion administrativa existente; no modifica clasificacion informativa ni precios | admin-data-entry-mode; public-catalog-informative-services; admin-services-* |
| Paquetes | GET/POST /admin/catalog/paquetes; PATCH/DELETE /:id; PATCH /:id/estado | Roles y sucursal originales | Gestion permitida; no compra publica | admin-data-entry-mode; public-catalog-packages-contract |
| Planes administrativos / cortesias | GET/POST /admin/catalog/planes y /cortesias; PATCH /:id, /:id/estado | Roles originales plans.js/cortesias.js | Configuracion permitida, adquisicion Cliente bloqueada | admin-data-entry-mode; membership-* |
| Promociones / formularios | GET/POST /admin/configuracion/promociones; GET/PATCH /:id | admin/super_admin; asignacion activa a sucursal | CRUD existente permitido, incluidos objetivos servicio/paquete y cambios de estado | admin-promociones-branch-scope |
| Imagenes / preparar, leer y retirar | POST /admin/storage/uploads/prepare; POST /admin/storage/assets/:id/read-url; DELETE /admin/storage/assets/:id | admin/super_admin; scope, tipo, sucursal, asset vinculado y metadatos originales | Scopes public_promotion_main y public_promotion_mobile incorporados; conservados public_barber_profile, private_client_profile, public_service_image | admin-data-entry-mode; personas-storage-context; admin-promociones-branch-scope |
| Perfil Barbero | GET/PATCH /barbero/perfil | barbero/admin/super_admin; identidad por claims | Solo perfil propio y campos existentes | barbero-profile.qa12b; barbero-profile-hardening |
| Panel Ejecutivo | GET /admin/super-dashboard/summary | super_admin | Lectura existente | super-dashboard.qa-super-dash-01 |
| Reportes | GET /admin/reportes/contexto, /dashboard, /export/csv, /export/excel | super_admin | Consultas y exportaciones | admin-reportes-authorization |
| Seguridad | GET login-logs/sesiones/usuarios/alertas y detalles en /admin/seguridad; PATCH usuarios/:id_usuario/estado-acceso, alertas/:id_alerta/estado; POST sesiones/:id_sesion/revocar y sesiones/revocar-todas; GET realtime/events | Roles SECURITY_READ/WRITE originales; exclusion de sesion actual | Operaciones existentes, sin ampliar rol Cliente | admin-security-users.qa09c; admin-data-entry-mode |
| MasterPuntos | GET /admin/masterpuntos/contexto, /clientes, /clientes/:id_cliente/movimientos; GET /admin/puntos/regalias, /clientes/buscar, /clientes/:id_cliente/resumen; PATCH /regalias; POST /clientes/:id_cliente/ajuste | Roles originales y alcance sucursal | Lectura y ajustes administrativos existentes | admin-masterpoints-reads.qa15; admin-points-* |
| Cliente y catalogos publicos | Excepciones exactas existentes de auth, cliente/me, foto, puntos/resumen, planes/estado, cancelaciones, citas GET, eliminacion propia y catalogo publico | Token/sesion, rol, pertenencia, CSRF y reautenticacion originales | Acceso conservado | auth-*; cliente-profile-preferencias; client-points-rewards; accountDeletion*; admin-data-entry-mode |
| Pausa comercial | Matriz commercialRoutes de admin-data-entry-mode.test.mjs, con registro comprobado para cada plantilla | Ningun rol evade el guard | Holds, confirmaciones, retomar, canjear, adquirir, ordenes e intentos siguen 403 antes de auth/SQL | admin-data-entry-mode |

## Restricciones conservadas

- DELETE permanente directo de Personas sigue deshabilitado por politica de negocio (controlador 410); no se incorpora al guard. La eliminacion legitima usa solicitudes, confirmaciones y reautenticacion.
- Cuentas protegidas, autoaprobacion, jerarquia insuficiente, identidad compartida y dependencias operativas siguen bloqueadas por sus validaciones originales.
- Campanias: no se habilitan crear, programar, enviar ni reintentar envios. No se envian mensajes en pruebas.
- Disponibilidad y horarios publicos siguen bloqueados por la pausa. adminCitasApi conserva llamadas heredadas a esos endpoints; no se habilita lectura publica de agendamiento para sortearlo. Las operaciones administrativas previamente autorizadas se conservan.
- No se cambian variables, reservas, pagos, webhooks, esquemas ni datos de QA/Produccion. No hay necesidad de migracion identificada.

## Validacion ejecutada

- node --test de admin-account-deletion.qa10, admin-data-entry-mode, admin-sucursales-qa08, admin-promociones-branch-scope, barbero-profile.qa12b, admin-masterpoints-reads.qa15, admin-reportes-authorization, admin-security-users.qa09c, cliente-profile-preferencias, auth-session-qa12 y super-dashboard.qa-super-dash-01: 407 PASS.
- npm test: 2877 PASS, 4 FAIL, 12 omitidas (2893 total). Fallan las cuatro pruebas de pixelpay-expiration-evidence.postgres.test.mjs; el entorno carece de C:/Program Files/PostgreSQL/17/bin/initdb.exe (ENOENT). No se cambia PixelPay ni se declara PASS global.
- npm run lint: cero errores, 25 advertencias existentes. git diff --check: PASS.
- Frontend: 150 PASS en ocho suites (eliminaciones/listado/decisiones/reautenticacion, sucursales, promociones y regresion Cliente/compras/canje). Los anchos 320, 390, 768 y 1440 se simulan en JSDOM; no constituyen evidencia visual de navegador.
- Navegador real, OAuth/correo reales y dispositivos fisicos no ejecutados. No se ejecutan campañas, compras ni eliminaciones reales.
