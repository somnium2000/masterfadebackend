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
  const diagnosticsEnabled = process.env.PRIVATE_COMMERCE_DIAGNOSTICS_ENABLED === "true";
  const verify = app.requireRoles([]);

  function eligibilityResult(request, allowed, reason, identityEvaluated = false) {
    if (diagnosticsEnabled) {
      try {
        const peer = request.raw.socket.remoteAddress;
        const ip = request.ip;
        const ipsCount = request.ips?.length || 0;
        const peerMatchesProxy = config.proxies.includes(normalizeIp(peer));
        if (reason === "IP_NOT_ALLOWED") {
          reason = !config.proxies.length ? "DIRECT_IP_NOT_ALLOWED"
            : !peerMatchesProxy ? "PROXY_PEER_NOT_ALLOWED"
            : ipsCount !== 2 ? "PROXY_HOP_COUNT_INVALID" : "CLIENT_IP_NOT_ALLOWED";
        }
        request.log.info({
          privateCommerceEligibility: {
            reason,
            tcp_peer: typeof peer === "string" && normalizeIp(peer) ? peer : null,
            request_ip: typeof ip === "string" && normalizeIp(ip) ? ip : null,
            request_ips_count: ipsCount,
            proxy_peer_allowed: peerMatchesProxy,
            tcp_peer_ip_allowed: config.ips.includes(normalizeIp(peer)),
            request_ip_allowed: config.ips.includes(normalizeIp(ip)),
            session_cookie_present: Boolean(request.cookies?.mf_session),
            // AM: False identity flags are unevaluated until the existing auth guard succeeds.
            identity_evaluated: identityEvaluated,
            user_uuid_allowed: identityEvaluated && config.userIds.includes(String(request.auth?.sub || "").toLowerCase()),
            claims_subject_matches: identityEvaluated && request.claims?.user?.id_usuario === request.auth?.sub,
            active_client_resolved: identityEvaluated && UUID.test(String(request.claims?.cliente_id || "")),
            client_role_present: identityEvaluated && request.claims?.roles?.includes("cliente") === true,
          },
        }, "Private commerce eligibility diagnostic");
      } catch {
        // AM: Temporary diagnostics must never affect authorization or response handling.
      }
    }
    return allowed;
  }

  async function eligible(request, reply) {
    if (!config.enabled) return eligibilityResult(request, false, "PILOT_DISABLED");
    if (app.config.adminDataEntryMode) return eligibilityResult(request, false, "ADMIN_DATA_ENTRY_MODE");
    if (app.config.paymentProvider !== "pixelpay") return eligibilityResult(request, false, "PAYMENT_PROVIDER_NOT_PIXELPAY");
    if (!privateCommerceIpAllowed(request, config)) return eligibilityResult(request, false, "IP_NOT_ALLOWED");
    if (!request.cookies?.mf_session) return eligibilityResult(request, false, "SESSION_COOKIE_MISSING");
    try {
      await verify(request, reply);
    } catch (error) {
      eligibilityResult(request, false, "AUTH_VERIFICATION_ERROR");
      throw error;
    }
    if (reply.sent) return eligibilityResult(request, false, "AUTH_GUARD_REPLIED");
    if (!config.userIds.includes(String(request.auth?.sub || "").toLowerCase())) return eligibilityResult(request, false, "USER_UUID_NOT_ALLOWED", true);
    if (request.claims?.user?.id_usuario !== request.auth?.sub) return eligibilityResult(request, false, "CLAIMS_SUBJECT_MISMATCH", true);
    // AM: Eligibility promises both client flows; the server must resolve an active client and role.
    if (!UUID.test(String(request.claims?.cliente_id || ""))) return eligibilityResult(request, false, "ACTIVE_CLIENT_NOT_RESOLVED", true);
    if (request.claims?.roles?.includes("cliente") !== true) return eligibilityResult(request, false, "CLIENT_ROLE_MISSING", true);
    return eligibilityResult(request, true, "ALLOWED", true);
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
