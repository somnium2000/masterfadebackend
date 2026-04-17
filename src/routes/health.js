import { sendError } from "../utils/errors.js";
import { sendOk } from "../utils/response.js";

function isInternalHealthAccessAllowed(request) {
  const expected = String(process.env.INTERNAL_HEALTH_TOKEN || "").trim();
  if (!expected) return false;

  const received = String(
    request.headers?.["x-internal-health-token"] ||
    request.headers?.authorization?.replace(/^Bearer\s+/i, "") ||
    ""
  ).trim();

  return Boolean(received) && received === expected;
}

export default async function healthRoutes(app) {
  app.get("/", async (request, reply) => {
    return sendOk(reply, {
      status: "ok",
      service: "masterfade-api",
      timestamp: new Date().toISOString(),
    }, { requestId: request.id });
  });

  app.get("/live", async (request, reply) => {
    return sendOk(reply, {
      status: "alive",
      timestamp: new Date().toISOString(),
    }, { requestId: request.id });
  });

  app.get("/ready", async (request, reply) => {
    if (!isInternalHealthAccessAllowed(request)) {
      return sendError(reply, 403, "No autorizado", { code: "HEALTH_FORBIDDEN" });
    }

    if (!app.db) {
      return sendError(reply, 503, "Servicio no disponible", { code: "DB_NOT_READY" });
    }

    try {
      await app.db.query("select 1");
      return sendOk(reply, {
        status: "ready",
        checks: { db: "ok" },
      }, { requestId: request.id });
    } catch (error) {
      request.log.error({ err: error }, "Health readiness check failed");
      return sendError(reply, 503, "Servicio no disponible", { code: "HEALTH_NOT_READY" });
    }
  });
}