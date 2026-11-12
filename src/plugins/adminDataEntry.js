import fp from "fastify-plugin";
import { sendError } from "../utils/errors.js";
import { getAssetById } from "../services/storage/storageAssetsRepo.js";
import { getStorageScope } from "../services/storage/storageScopes.js";

// AM: Exact existing route templates; new/alternative endpoints stay closed by default.
export const ADMIN_DATA_ENTRY_ROUTES = Object.freeze([
  "GET /v1/admin/account-deletion/requests",
  "GET /v1/admin/account-deletion/requests/:requestId",
  "POST /v1/admin/account-deletion/requests/:requestId/approve",
  "POST /v1/admin/account-deletion/requests/:requestId/reject",
  "POST /v1/admin/account-deletion/requests/:requestId/retry",
  "POST /v1/admin/sucursales",
  "PATCH /v1/admin/sucursales/:id",
  "PATCH /v1/admin/sucursales/:id/activar",
  "PATCH /v1/admin/sucursales/:id/inactivar",
  "DELETE /v1/admin/sucursales/:id",
  "POST /v1/admin/configuracion/promociones",
  "PATCH /v1/admin/configuracion/promociones/:id",
  "PATCH /v1/barbero/perfil",
  "DELETE /v1/admin/storage/assets/:id",
  "POST /v1/admin/seguridad/sesiones/revocar-todas",
  "PATCH /v1/admin/personas/usuarios/:id_usuario/estado-acceso",
  "PATCH /v1/admin/personas/usuarios/:id_usuario/inactivar",
  "POST /v1/auth/register",
  "POST /v1/auth/register/confirm",
  "POST /v1/auth/register/resend",
  "POST /v1/auth/social/confirm",
  "GET /v1/cliente/me",
  "PATCH /v1/cliente/me",
  "GET /v1/cliente/planes/estado",
  "POST /v1/cliente/planes/cancelar",
  "PATCH /v1/cliente/planes/:id_suscripcion/cancelar",
  "GET /v1/cliente/puntos/resumen",
  "GET /v1/citas",
  "GET /v1/citas/pendiente",
  "GET /v1/citas/:id",
  "POST /v1/citas/pendiente/:id_grupo_cita/descartar",
  "POST /v1/cliente/me/profile-image/prepare",
  "POST /v1/cliente/me/profile-image/read-url",
  "DELETE /v1/cliente/me/profile-image",
  "GET /v1/cliente/me/account-deletion/preview",
  "POST /v1/cliente/me/account-deletion/requests",
  "POST /v1/cliente/me/account-deletion/requests/:requestId/confirm",
  "GET /v1/account-deletion/me/preview",
  "GET /v1/account-deletion/me/requests/current",
  "POST /v1/account-deletion/me/requests",
  "POST /v1/account-deletion/me/requests/:requestId/cancel",
  "POST /v1/public/account-deletion/requests/:reference/execute",
  "GET /v1/admin/personas",
  "GET /v1/admin/personas/catalogos",
  "GET /v1/admin/personas/roles",
  "POST /v1/admin/personas/roles",
  "GET /v1/admin/personas/usuarios",
  "PATCH /v1/admin/personas/usuarios/:id_usuario",
  "PATCH /v1/admin/personas/usuarios/:id_usuario/bloquear",
  "PATCH /v1/admin/personas/usuarios/:id_usuario/activar",
  "POST /v1/admin/personas/usuarios/:id_usuario/enviar-configuracion-password",
  "GET /v1/admin/personas/empleados",
  "GET /v1/admin/personas/empleados/:id_empleado",
  "POST /v1/admin/personas/empleados",
  "PATCH /v1/admin/personas/empleados/:id_empleado",
  "PATCH /v1/admin/personas/empleados/:id_empleado/inactivar",
  "PATCH /v1/admin/personas/empleados/:id_empleado/activar",
  "GET /v1/admin/personas/clientes",
  "GET /v1/admin/personas/clientes/:id_cliente",
  "POST /v1/admin/personas/clientes",
  "PATCH /v1/admin/personas/clientes/:id_cliente",
  "PATCH /v1/admin/personas/clientes/:id_cliente/inactivar",
  "PATCH /v1/admin/personas/clientes/:id_cliente/activar",
  "POST /v1/admin/personas/usuarios-internos",
  "GET /v1/admin/catalog/servicios",
  "GET /v1/admin/catalog/servicios/agrupados",
  "POST /v1/admin/catalog/servicios",
  "PATCH /v1/admin/catalog/servicios/:id",
  "PATCH /v1/admin/catalog/servicios/:id_servicio/tarifas/:id_sucursal",
  "POST /v1/admin/catalog/servicios/:id_servicio/tarifas",
  "PATCH /v1/admin/catalog/servicios/:id_servicio/tarifas/:id_sucursal/desactivar",
  "PATCH /v1/admin/catalog/servicios/:id/desactivar-global",
  "PATCH /v1/admin/catalog/servicios/:id/estado",
  "GET /v1/admin/catalog/servicios/:id/barberos",
  "PUT /v1/admin/catalog/servicios/:id/barberos",
  "PATCH /v1/admin/catalog/paquetes/:id/estado",
  "DELETE /v1/admin/catalog/servicios/:id",
  "GET /v1/admin/catalog/paquetes",
  "POST /v1/admin/catalog/paquetes",
  "PATCH /v1/admin/catalog/paquetes/:id",
  "DELETE /v1/admin/catalog/paquetes/:id",
  "GET /v1/admin/catalog/planes",
  "POST /v1/admin/catalog/planes",
  "PATCH /v1/admin/catalog/planes/:id",
  "PATCH /v1/admin/catalog/planes/:id/estado",
  "GET /v1/admin/catalog/cortesias",
  "POST /v1/admin/catalog/cortesias",
  "PATCH /v1/admin/catalog/cortesias/:id",
  "PATCH /v1/admin/catalog/cortesias/:id/estado",
  "GET /v1/admin/empleados",
  "GET /v1/admin/super-dashboard/summary",
  "GET /v1/admin/reportes/contexto",
  "GET /v1/admin/reportes/dashboard",
  "GET /v1/admin/reportes/export/csv",
  "GET /v1/admin/reportes/export/excel",
  "GET /v1/admin/seguridad/realtime/events",
  "GET /v1/admin/seguridad/login-logs",
  "GET /v1/admin/seguridad/login-logs/:id_login_log",
  "GET /v1/admin/seguridad/sesiones",
  "GET /v1/admin/seguridad/sesiones/:id_sesion",
  "POST /v1/admin/seguridad/sesiones/:id_sesion/revocar",
  "GET /v1/admin/seguridad/usuarios",
  "PATCH /v1/admin/seguridad/usuarios/:id_usuario/estado-acceso",
  "GET /v1/admin/seguridad/alertas",
  "GET /v1/admin/seguridad/alertas/:id_alerta",
  "PATCH /v1/admin/seguridad/alertas/:id_alerta/estado",
  "GET /v1/admin/masterpuntos/contexto",
  "GET /v1/admin/masterpuntos/clientes",
  "GET /v1/admin/masterpuntos/clientes/:id_cliente/movimientos",
  "GET /v1/admin/puntos/regalias",
  "PATCH /v1/admin/puntos/regalias",
  "GET /v1/admin/puntos/clientes/buscar",
  "GET /v1/admin/puntos/clientes/:id_cliente/resumen",
  "POST /v1/admin/puntos/clientes/:id_cliente/ajuste",
  "GET /v1/admin/configuracion/comunicacion/campanias",
  "GET /v1/admin/configuracion/comunicacion/campanias/:id",
  "GET /v1/admin/configuracion/comunicacion/campanias/:id/elegibilidad",
  "GET /v1/admin/configuracion/comunicacion/campanias/:id/elegibilidad/destinatarios",
  "GET /v1/admin/configuracion/comunicacion/campanias/:id/envios",
  "GET /v1/admin/configuracion/promociones",
  "GET /v1/admin/configuracion/promociones/:id",
  "GET /v1/health",
  "GET /v1/health/live",
  "GET /v1/health/ready",
  "GET /v1/auth/login",
  "GET /v1/auth/me",
  "GET /v1/commerce/eligibility",
  "GET /v1/auth/csrf",
  "GET /v1/public/catalog/sucursales",
  "GET /v1/public/catalog/servicios",
  "GET /v1/public/catalog/paquetes",
  "GET /v1/public/catalog/promociones",
  "GET /v1/public/catalog/busqueda",
  "GET /v1/public/agenda/barberos",
  "GET /v1/public/catalog/planes",
  "GET /v1/admin/sucursales",
  "GET /v1/admin/sucursales/empresas",
  "GET /v1/admin/sucursales/:id",
  "GET /v1/barbero/perfil",
  "POST /v1/auth/login",
  "POST /v1/auth/logout",
  "POST /v1/auth/session/touch",
  "POST /v1/auth/exchange",
  "POST /v1/auth/forgot-password",
  "POST /v1/auth/reset-password",
  "POST /v1/storage/uploads/prepare",
  "POST /v1/storage/assets/:id/read-url",
  "POST /v1/admin/storage/uploads/prepare",
  "POST /v1/admin/storage/assets/:id/read-url",
]);
const allowed = new Set(ADMIN_DATA_ENTRY_ROUTES);
const administrativeOperationPrefixes = Object.freeze([
  "/v1/admin/citas",
  "/v1/admin/membresias",
]);
// AM: Only photographs of approved modules; existing scope/identity/branch checks still run.
const photographScopes = new Map([['public_barber_profile', 'barbero'], ['private_client_profile', 'cliente'], ['public_service_image', 'servicio'], ['public_promotion_main', 'promocion'], ['public_promotion_mobile', 'promocion']]);
const normalize = path => String(path || '').replace(/\/$/, '');
const restricted = reply => sendError(reply, 403, 'Esta operación no está disponible durante la carga administrativa.', { code: 'ADMIN_DATA_ENTRY_RESTRICTED' });

export default fp(async function adminDataEntryPlugin(app) {
  if (!app.config?.adminDataEntryMode) return;
  // AM: Before parsing payloads, authentication hooks or business handlers; no privileged bypass.
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url;
    if (request.method === 'OPTIONS' && route === '*') return;
    if (request.headers['x-http-method-override'] || request.headers['x-method-override']) return restricted(reply);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const normalizedRoute = normalize(route);
    // AM: Existing callbacks retain their own financial verification even during pilot rollback.
    if (method === 'POST' && normalizedRoute === '/v1/pagos/webhook/:proveedor'
      && String(request.params?.proveedor || '').toLowerCase() === 'pixelpay') return;
    const isAdministrativeOperation = administrativeOperationPrefixes.some(prefix => (
      normalizedRoute === prefix || normalizedRoute.startsWith(prefix + '/')
    ));
    if (!allowed.has(method + ' ' + normalizedRoute) && !isAdministrativeOperation) return restricted(reply);
  });
  // AM: Append after existing route auth/role guards, never replace authorization.
  app.addHook('onRoute', options => {
    const route = normalize(options.url);
    if (!route.endsWith('/uploads/prepare') && !route.endsWith('/assets/:id/read-url') && route !== '/v1/admin/storage/assets/:id') return;
    const previous = options.preHandler ? [].concat(options.preHandler) : [];
    options.preHandler = [...previous, async (request, reply) => {
      if (route.endsWith('/uploads/prepare')) {
        if (!photographScopes.has(request.body?.scope_key) || photographScopes.get(request.body.scope_key) !== request.body?.entity_type) return restricted(reply);
      } else {
        try {
          const asset = await getAssetById(app.db, request.params.id);
          if (!asset || asset.deleted_at || !photographScopes.has(asset.scope_key)) return restricted(reply);
          const scope = getStorageScope(asset.scope_key);
          if (asset.entity_type !== scope.entityType || asset.bucket_name !== scope.bucket || asset.visibility !== scope.visibility) return restricted(reply);
        } catch { return sendError(reply, 503, 'No se pudo verificar la fotografía.', { code: 'ADMIN_PHOTO_UNAVAILABLE' }); }
      }
    }];
  });
}, { name: 'admin-data-entry-plugin', dependencies: ['env-plugin'] });
