import net from "node:net";
import fp from "fastify-plugin";
import { sendError } from "../utils/errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// AM: Maintenance does not create holds/intents or initiate provider charges; original guards remain.
const MAINTENANCE_ROUTES = new Set([
  "POST /v1/cliente/planes/cancelar", "PATCH /v1/cliente/planes/:id_suscripcion/cancelar",
  "POST /v1/admin/membresias/clientes/:id_cliente/cancelar",
  "POST /v1/citas/pendiente/:id_grupo_cita/descartar", "DELETE /v1/public/citas/hold/:id_grupo_cita",
  "DELETE /v1/admin/citas/hold/:idGrupoCita", "PATCH /v1/admin/citas/:id_cita/estado",
  "POST /v1/admin/citas/:id_cita/registrar-llegada", "POST /v1/admin/citas/:id_cita/iniciar-atencion",
  "POST /v1/admin/citas/:id_cita/finalizar-atencion", "POST /v1/admin/citas/:id_cita/reagendar-emergencia",
  "POST /v1/admin/citas/reagendar-emergencia/lote", "PUT /v1/admin/citas/sucursales/:id_sucursal/horarios",
  "PUT /v1/admin/citas/horarios/:id_empleado", "POST /v1/admin/citas/bloqueos",
  "DELETE /v1/admin/citas/bloqueos", "DELETE /v1/admin/citas/bloqueos/:id",
  "POST /v1/admin/citas/dias-inhabilitados", "DELETE /v1/admin/citas/dias-inhabilitados",
  "DELETE /v1/admin/citas/dias-inhabilitados/:id", "PATCH /v1/admin/citas/parametros",
]);
const normalizeIp = value => {
  const text = String(value || "").trim();
  const ip = text.startsWith("::ffff:") ? text.slice(7) : text;
  if (!net.isIP(ip) || ip.includes("%")) return null;
  return net.isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
};

export function resolvePrivateCommerceConfig(env) {
  const flag = String(env.PRIVATE_COMMERCE_PILOT_ENABLED || "false").trim();
  if (!["true", "false"].includes(flag)) throw new Error("PRIVATE_COMMERCE_PILOT_ENABLED invalido. Usa true o false.");
  const list = name => String(env[name] || "").split(",").map(x => x.trim()).filter(Boolean);
  const userIds = list("PRIVATE_COMMERCE_USER_IDS");
  const ips = list("PRIVATE_COMMERCE_IPS");
  const proxies = list("PRIVATE_COMMERCE_PROXY_IPS");
  if (userIds.some(id => !UUID.test(id)) || [...ips, ...proxies].some(ip => !normalizeIp(ip))) {
    throw new Error("Allowlist del piloto privado invalida; usa UUID e IP exactas, sin rangos.");
  }
  if (flag === "true" && (userIds.length !== 1 || !ips.length)) throw new Error("El piloto privado requiere exactamente un usuario e IP autorizadas.");
  if (flag === "true" && proxies.length && !["true", "1", "yes", "on"].includes(String(env.TRUST_PROXY).trim().toLowerCase())) {
    throw new Error("El piloto privado con proxy requiere TRUST_PROXY activo y un unico proxy que sobrescriba X-Forwarded-For.");
  }
  return Object.freeze({ enabled: flag === "true", userIds: userIds.map(id => id.toLowerCase()), ips: ips.map(normalizeIp), proxies: proxies.map(normalizeIp) });
}

export function isPrivateCommerceRoute(method, route) {
  if (["OPTIONS", "HEAD"].includes(method)) return false;
  const path = String(route || "").replace(/\/$/, "");
  if (MAINTENANCE_ROUTES.has(`${method} ${path}`)) return false;
  // AM: Callbacks settle existing financial evidence independently of the owner's session/IP.
  if (path === "/v1/pagos/webhook/:proveedor") return false;
  if (/^\/v1\/(?:public\/)?pagos(?:\/|$)/.test(path)) return true;
  if (/^\/v1\/(?:public\/)?citas(?:\/|$)/.test(path)) return !["GET"].includes(method);
  if (/^\/v1\/cliente\/planes(?:\/|$)/.test(path)) return method !== "GET";
  if (/^\/v1\/admin\/(?:citas|membresias)(?:\/|$)/.test(path)) return method !== "GET";
  return false;
}

export function privateCommerceIpAllowed(request, config) {
  const peer = normalizeIp(request.raw.socket.remoteAddress);
  if (!config.proxies.length) return config.ips.includes(peer);
  // AM: Trust only an explicitly configured immediate proxy and Fastify's single-hop resolution.
  if (!config.proxies.includes(peer) || request.ips?.length !== 2) return false;
  return config.ips.includes(normalizeIp(request.ip));
}

export default fp(async function privateCommerce(app) {
  const config = app.config.privateCommercePilot || resolvePrivateCommerceConfig(process.env);
  const verify = app.requireRoles([]);
  async function eligible(request, reply) {
    if (!config.enabled || app.config.adminDataEntryMode || app.config.paymentProvider !== "pixelpay"
      || !privateCommerceIpAllowed(request, config)) return false;
    await verify(request, reply);
    if (reply.sent) return false;
    return config.userIds.includes(String(request.auth?.sub || "").toLowerCase())
      && request.claims?.user?.id_usuario === request.auth?.sub;
  }
  app.addHook("onRequest", async (request, reply) => {
    if (!isPrivateCommerceRoute(request.method, request.routeOptions.url)) return;
    if (await eligible(request, reply)) {
      // AM: Public booking now uses a session too; keep it protected against cross-site mutations.
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        && (!request.cookies?.mf_csrf || request.cookies.mf_csrf !== request.headers["x-csrf-token"])) {
        return sendError(reply, 403, "Solicitud invalida.", { code: "CSRF_TOKEN_INVALID" });
      }
      return;
    }
    if (!reply.sent) return sendError(reply, 403, "Operacion comercial no disponible.", { code: "PRIVATE_COMMERCE_RESTRICTED" });
  });
  app.get("/v1/commerce/eligibility", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const allowed = await eligible(request, reply);
    if (reply.sent) return;
    return { ok: true, data: { booking: allowed, vipPurchase: allowed } };
  });
}, { name: "private-commerce-plugin", dependencies: ["env-plugin"], decorators: { fastify: ["requireRoles"] } });
