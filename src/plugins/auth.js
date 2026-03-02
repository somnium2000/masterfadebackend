import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import { sendError } from "../utils/errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getBearerToken(headerValue) {
  const rawValue = String(headerValue || "").trim();
  if (!rawValue) return null;

  const match = rawValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export default fp(async function authPlugin(app) {
  app.decorateRequest("auth", null);

  app.decorate("authenticate", async function authenticate(request, reply) {
    const token = getBearerToken(request.headers.authorization);

    if (!token) {
      return sendError(reply, 401, "Token de acceso requerido", {
        code: "AUTH_TOKEN_REQUIRED",
      });
    }

    const jwtSecret = process.env.JWT_SECRET?.trim();
    if (!jwtSecret) {
      return sendError(reply, 500, "Falta JWT_SECRET en la configuracion del servidor", {
        code: "JWT_SECRET_MISSING",
      });
    }

    try {
      const payload = jwt.verify(token, jwtSecret, {
        issuer: process.env.APP_JWT_ISSUER || "masterfade-api",
        audience: process.env.APP_JWT_AUDIENCE || "masterfade-app",
      });

      if (!payload || typeof payload !== "object") {
        return sendError(reply, 401, "Token de acceso invalido", {
          code: "AUTH_TOKEN_INVALID",
        });
      }

      if (payload.token_type !== "app" || !UUID_PATTERN.test(String(payload.sub || ""))) {
        return sendError(reply, 401, "Token de acceso invalido", {
          code: "AUTH_TOKEN_INVALID",
        });
      }

      request.auth = payload;
    } catch (error) {
      request.log.warn({ err: error }, "JWT verification failed");
      return sendError(reply, 401, "Token de acceso invalido", {
        code: "AUTH_TOKEN_INVALID",
      });
    }
  });
});
