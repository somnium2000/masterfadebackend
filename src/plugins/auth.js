import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import { getAuthClaims } from "../utils/authClaims.js";
import { sendError } from "../utils/errors.js";
import { validateActiveSession } from "../services/securityService.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getSessionTokenFromRequest(request) {
  const cookieToken = String(request.cookies?.mf_session || "").trim();
  if (cookieToken) return cookieToken;
  return null;
}

export default fp(async function authPlugin(app) {
  app.decorateRequest("auth", null);
  app.decorateRequest("claims", null);

  app.decorate("authenticate", async function authenticate(request, reply) {
    const token = getSessionTokenFromRequest(request);

    if (!token) {
      return sendError(reply, 401, "Sesion requerida", {
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

      if (!UUID_PATTERN.test(String(payload.sid || "")) || !UUID_PATTERN.test(String(payload.jti || ""))) {
        return sendError(reply, 401, "Token de acceso invalido", {
          code: "AUTH_TOKEN_INVALID",
        });
      }

      const sessionValidation = await validateActiveSession(app, request, {
        id_usuario: String(payload.sub || ""),
        sid: String(payload.sid || ""),
        jti: String(payload.jti || ""),
      });

      if (!sessionValidation.ok) {
        if (sessionValidation.statusCode === 500) {
          return sendError(reply, 500, "No se pudo validar la sesion", {
            code: "AUTH_SESSION_VALIDATE_ERROR",
          });
        }
        const sessionErrorCode = sessionValidation.code || "AUTH_SESSION_INVALID";
        const sessionErrorMessage = sessionErrorCode === "AUTH_SESSION_IDLE_EXPIRED"
          ? "Sesion expirada por inactividad"
          : "Token de acceso invalido";
        return sendError(reply, 401, sessionErrorMessage, {
          code: sessionErrorCode,
        });
      }

      request.auth = payload;
    } catch (error) {
      request.log.warn({ event: "auth_jwt_verification_failed", code: "AUTH_TOKEN_INVALID" }, "JWT verification failed");
      return sendError(reply, 401, "Token de acceso invalido", {
        code: "AUTH_TOKEN_INVALID",
      });
    }
  });

  app.decorate("requireRoles", function requireRoles(allowedRoles = []) {
    const normalizedAllowedRoles = Array.isArray(allowedRoles) ? allowedRoles.filter(Boolean) : [];

    return async function roleGuard(request, reply) {
      await app.authenticate(request, reply);

      if (reply.sent) {
        return;
      }

      try {
        const claims = await getAuthClaims(app, request.auth?.sub);

        if (!claims) {
          return sendError(reply, 401, "El usuario autenticado no esta vinculado a un usuario interno de Masterfade", {
            code: "AUTH_SESSION_NOT_FOUND",
          });
        }

        request.claims = claims;

        if (normalizedAllowedRoles.length === 0) {
          return;
        }

        const hasRole = normalizedAllowedRoles.some((role) => claims.roles.includes(role));

        if (!hasRole) {
          return sendError(reply, 403, "No tienes permisos para acceder a este recurso", {
            code: "AUTH_FORBIDDEN",
          });
        }
      } catch (error) {
        request.log.error({ err: error }, "Role guard failed");
        return sendError(reply, 500, "No se pudo validar el contexto del usuario autenticado", {
          code: "AUTH_CLAIMS_ERROR",
          details: error instanceof Error ? error.message : "Unknown auth claims error",
        });
      }
    };
  });
});
