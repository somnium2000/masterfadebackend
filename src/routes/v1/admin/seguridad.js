import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  getAdminSecurityAlertDetail,
  getAdminSecurityLoginLogDetail,
  getAdminSecuritySessionDetail,
  listAdminSecurityAlerts,
  listAdminSecurityLoginLogs,
  listAdminSecuritySessions,
  listAdminSecurityUsers,
  revokeAdminSecuritySession,
  revokeAllAdminSecuritySessions,
  updateAdminAlertState,
  updateAdminUserAccessState,
} from "../../../services/securityService.js";

const SECURITY_READ_ROLES = ["super_admin", "security_admin", "security_auditor", "root"];
const SECURITY_WRITE_ROLES = ["super_admin", "security_admin", "root"];
const SSE_HEARTBEAT_MS = 25_000;

const listQuerySchemaBase = {
  page: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  sort_dir: { type: "string", enum: ["asc", "desc"] },
  from_at: { type: "string", format: "date-time" },
  to_at: { type: "string", format: "date-time" },
};

const loginLogsQuerySchema = {
  type: "object",
  properties: {
    ...listQuerySchemaBase,
    resultado: { type: "string", enum: ["success", "failed", "blocked", "session_limit", "error"] },
    provider: { type: "string", minLength: 1, maxLength: 48 },
    id_usuario: { type: "string", format: "uuid" },
    sort_by: { type: "string", enum: ["created_at", "resultado", "provider"] },
  },
  additionalProperties: false,
};

const sesionesQuerySchema = {
  type: "object",
  properties: {
    ...listQuerySchemaBase,
    estado: { type: "string", enum: ["activa", "cerrada", "revocada", "expirada"] },
    id_usuario: { type: "string", format: "uuid" },
    sort_by: { type: "string", enum: ["inicio_at", "ultimo_uso_at", "expira_at", "estado"] },
  },
  additionalProperties: false,
};

const idLoginLogParamSchema = {
  type: "object",
  required: ["id_login_log"],
  properties: {
    id_login_log: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const idSesionParamSchema = {
  type: "object",
  required: ["id_sesion"],
  properties: {
    id_sesion: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const usuariosQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    q: { type: "string", minLength: 1, maxLength: 120 },
    estado_acceso: { type: "string", enum: ["pendiente_password", "activo", "bloqueado", "inactivo"] },
    sort_by: { type: "string", enum: ["updated_at", "failed_login_count", "last_login_at"] },
    sort_dir: { type: "string", enum: ["asc", "desc"] },
  },
  additionalProperties: false,
};

const idUsuarioParamSchema = {
  type: "object",
  required: ["id_usuario"],
  properties: {
    id_usuario: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const estadoAccesoBodySchema = {
  type: "object",
  required: ["estado_acceso"],
  properties: {
    estado_acceso: { type: "string", enum: ["pendiente_password", "activo", "bloqueado", "inactivo"] },
  },
  additionalProperties: false,
};

const alertasQuerySchema = {
  type: "object",
  properties: {
    ...listQuerySchemaBase,
    estado: { type: "string", enum: ["abierta", "en_revision", "resuelta", "descartada"] },
    severidad: { type: "string", enum: ["baja", "media", "alta", "critica"] },
    tipo: { type: "string", minLength: 1, maxLength: 80 },
    id_usuario: { type: "string", format: "uuid" },
    sort_by: { type: "string", enum: ["detectada_at", "severidad", "estado"] },
  },
  additionalProperties: false,
};

const idAlertaParamSchema = {
  type: "object",
  required: ["id_alerta"],
  properties: {
    id_alerta: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
};

const estadoAlertaBodySchema = {
  type: "object",
  required: ["estado"],
  properties: {
    estado: { type: "string", enum: ["resuelta", "descartada"] },
    comentario: { type: "string", minLength: 1, maxLength: 700 },
  },
  additionalProperties: false,
};

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    requestId: request.id,
  });
}

function parseAllowedCorsOrigins(app) {
  const configured = Array.isArray(app?.config?.corsOrigins) ? app.config.corsOrigins : [];
  if (configured.length > 0) return configured;
  const raw =
    process.env.CORS_ORIGENES ||
    process.env.CORS_ORIGINS ||
    process.env.CORS_ORIGIN ||
    "http://localhost:5173";
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default async function adminSeguridadRoutes(app) {
  app.get(
    "/realtime/events",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
    },
    async (request, reply) => {
      const originHeader = String(request.headers?.origin || "").trim();
      const allowedOrigins = parseAllowedCorsOrigins(app);
      if (originHeader && allowedOrigins.includes(originHeader)) {
        reply.raw.setHeader("Access-Control-Allow-Origin", originHeader);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
        reply.raw.setHeader("Vary", "Origin");
      }

      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      if (typeof reply.hijack === "function") {
        reply.hijack();
      }

      const writeEvent = (eventName, payload) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`event: ${eventName}\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const unsubscribe = app.securityRealtime?.subscribe?.((signal) => {
        const minimalSignal = {
          event: signal?.event || null,
          changed_at: signal?.changed_at || null,
          seq: Number(signal?.seq || 0),
        };
        writeEvent(minimalSignal.event, minimalSignal);
      }) || (() => {});

      const heartbeat = setInterval(() => {
        writeEvent("ping", {
          event: "ping",
          changed_at: new Date().toISOString(),
          seq: 0,
        });
      }, SSE_HEARTBEAT_MS);

      let closed = false;
      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          try {
            reply.raw.end();
          } catch {
            // noop
          }
        }
      };

      reply.raw.on("error", closeStream);
      request.raw.on("close", closeStream);
      reply.raw.on("close", closeStream);
    }
  );

  app.get(
    "/login-logs",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { querystring: loginLogsQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminSecurityLoginLogs(app, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar login logs de seguridad",
          "SECURITY_ADMIN_LOGIN_LOGS_ERROR"
        );
      }
    }
  );

  app.get(
    "/login-logs/:id_login_log",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { params: idLoginLogParamSchema },
    },
    async (request, reply) => {
      try {
        const detail = await getAdminSecurityLoginLogDetail(app, request, {
          idLoginLog: request.params.id_login_log,
        });

        if (!detail.ok && detail.code === "SECURITY_LOGIN_LOG_NOT_FOUND") {
          return sendError(reply, 404, "Login log no encontrado.", {
            code: "SECURITY_LOGIN_LOG_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!detail.ok) {
          return sendError(reply, 400, "No se pudo consultar el detalle del login log.", {
            code: detail.code || "SECURITY_LOGIN_LOG_DETAIL_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(reply, detail.item, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar detalle de login log",
          "SECURITY_ADMIN_LOGIN_LOG_DETAIL_ERROR"
        );
      }
    }
  );

  app.get(
    "/sesiones",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { querystring: sesionesQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminSecuritySessions(app, {
          ...(request.query || {}),
          current_session_id: request.user?.sid || request.auth?.sid || null,
        });
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar sesiones de seguridad",
          "SECURITY_ADMIN_SESSIONS_LIST_ERROR"
        );
      }
    }
  );

  app.post(
    "/sesiones/revocar-todas",
    {
      preHandler: app.requireRoles(SECURITY_WRITE_ROLES),
    },
    async (request, reply) => {
      try {
        const actorUserId = request.claims?.user?.id_usuario || null;
        const actorSessionId = request.user?.sid || request.auth?.sid || null;
        const action = await revokeAllAdminSecuritySessions(app, request, {
          actorUserId,
          actorSessionId,
        });

        if (!action.ok && action.code === "SECURITY_SESSIONS_REVOKE_ALL_INVALID") {
          return sendError(reply, 400, "No se pudo identificar la sesion actual para excluirla.", {
            code: "SECURITY_SESSIONS_REVOKE_ALL_INVALID",
            requestId: request.id,
          });
        }
        if (!action.ok) {
          return sendError(reply, 500, "No se pudieron revocar las sesiones activas.", {
            code: action.code || "SECURITY_SESSIONS_REVOKE_ALL_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(
          reply,
          {
            revocadas: action.revocadas,
            excluded_current_session: true,
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudieron revocar las sesiones activas",
          "SECURITY_ADMIN_SESSIONS_REVOKE_ALL_ERROR"
        );
      }
    }
  );

  app.get(
    "/sesiones/:id_sesion",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { params: idSesionParamSchema },
    },
    async (request, reply) => {
      try {
        const detail = await getAdminSecuritySessionDetail(app, request, {
          idSesion: request.params.id_sesion,
        });

        if (!detail.ok && detail.code === "SECURITY_SESSION_NOT_FOUND") {
          return sendError(reply, 404, "Sesion no encontrada.", {
            code: "SECURITY_SESSION_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!detail.ok) {
          return sendError(reply, 400, "No se pudo consultar el detalle de la sesion.", {
            code: detail.code || "SECURITY_SESSION_DETAIL_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(reply, detail.item, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar detalle de sesion",
          "SECURITY_ADMIN_SESSION_DETAIL_ERROR"
        );
      }
    }
  );

  app.post(
    "/sesiones/:id_sesion/revocar",
    {
      preHandler: app.requireRoles(SECURITY_WRITE_ROLES),
      schema: { params: idSesionParamSchema },
    },
    async (request, reply) => {
      try {
        const actorUserId = request.claims?.user?.id_usuario || null;
        const actorSessionId = request.user?.sid || request.auth?.sid || null;
        const action = await revokeAdminSecuritySession(app, request, {
          idSesion: request.params.id_sesion,
          actorUserId,
          actorSessionId,
        });

        if (!action.ok && action.code === "SECURITY_SESSION_REVOKE_SELF_FORBIDDEN") {
          return sendError(reply, 400, "No se permite revocar tu sesion actual desde este endpoint.", {
            code: "SECURITY_SESSION_REVOKE_SELF_FORBIDDEN",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "SECURITY_SESSION_NOT_FOUND") {
          return sendError(reply, 404, "Sesion no encontrada o no activa.", {
            code: "SECURITY_SESSION_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!action.ok) {
          return sendError(reply, 500, "No se pudo revocar la sesion.", {
            code: "SECURITY_SESSION_REVOKE_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(
          reply,
          { id_sesion: action.id_sesion, revocada: true },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo revocar la sesion",
          "SECURITY_ADMIN_SESSION_REVOKE_ERROR"
        );
      }
    }
  );

  app.get(
    "/usuarios",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { querystring: usuariosQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminSecurityUsers(app, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar usuarios de seguridad",
          "SECURITY_ADMIN_USERS_LIST_ERROR"
        );
      }
    }
  );

  app.patch(
    "/usuarios/:id_usuario/estado-acceso",
    {
      preHandler: app.requireRoles(SECURITY_WRITE_ROLES),
      schema: {
        params: idUsuarioParamSchema,
        body: estadoAccesoBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const actorUserId = request.claims?.user?.id_usuario || null;
        const action = await updateAdminUserAccessState(app, request, {
          idUsuario: request.params.id_usuario,
          estadoAcceso: request.body?.estado_acceso,
          actorUserId,
        });

        if (!action.ok && action.code === "SECURITY_USER_NOT_FOUND") {
          return sendError(reply, 404, "Usuario no encontrado.", {
            code: "SECURITY_USER_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "SECURITY_LAST_SUPER_ADMIN_FORBIDDEN") {
          return sendError(reply, 409, "No se puede bloquear al unico super_admin activo.", {
            code: "SECURITY_LAST_SUPER_ADMIN_FORBIDDEN",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "SECURITY_SELF_CRITICAL_ACCESS_FORBIDDEN") {
          return sendError(reply, 409, "No puedes deshabilitar tu acceso critico actual.", {
            code: "SECURITY_SELF_CRITICAL_ACCESS_FORBIDDEN",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "ROOT_USER_PROTECTED") {
          return sendError(reply, 403, "El usuario root protegido no puede ser bloqueado ni inactivado.", {
            code: "ROOT_USER_PROTECTED",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "ROOT_USER_PROTECTION_CHECK_FAILED") {
          return sendError(reply, 500, "No se pudo validar si el usuario esta protegido.", {
            code: "ROOT_USER_PROTECTION_CHECK_FAILED",
            requestId: request.id,
          });
        }
        if (!action.ok) {
          return sendError(reply, 500, "No se pudo actualizar estado de acceso.", {
            code: "SECURITY_USER_ACCESS_UPDATE_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(
          reply,
          {
            id_usuario: action.id_usuario,
            estado_acceso: action.estado_acceso,
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo actualizar estado de acceso",
          "SECURITY_ADMIN_USER_ACCESS_UPDATE_ERROR"
        );
      }
    }
  );

  app.get(
    "/alertas",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { querystring: alertasQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminSecurityAlerts(app, request.query || {});
        return sendOk(reply, data, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar alertas de seguridad",
          "SECURITY_ADMIN_ALERTS_LIST_ERROR"
        );
      }
    }
  );

  app.get(
    "/alertas/:id_alerta",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { params: idAlertaParamSchema },
    },
    async (request, reply) => {
      try {
        const detail = await getAdminSecurityAlertDetail(app, request, {
          idAlerta: request.params.id_alerta,
        });

        if (!detail.ok && detail.code === "SECURITY_ALERT_NOT_FOUND") {
          return sendError(reply, 404, "Alerta no encontrada.", {
            code: "SECURITY_ALERT_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!detail.ok) {
          return sendError(reply, 400, "No se pudo consultar el detalle de la alerta.", {
            code: detail.code || "SECURITY_ALERT_DETAIL_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(reply, detail.item, { requestId: request.id });
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo consultar detalle de alerta",
          "SECURITY_ADMIN_ALERT_DETAIL_ERROR"
        );
      }
    }
  );

  app.patch(
    "/alertas/:id_alerta/estado",
    {
      preHandler: app.requireRoles(SECURITY_WRITE_ROLES),
      schema: {
        params: idAlertaParamSchema,
        body: estadoAlertaBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const actorUserId = request.claims?.user?.id_usuario || null;
        const action = await updateAdminAlertState(app, request, {
          idAlerta: request.params.id_alerta,
          estado: request.body?.estado,
          comentarioResolucion: request.body?.comentario,
          actorUserId,
        });

        if (!action.ok && action.code === "SECURITY_ALERT_NOT_FOUND") {
          return sendError(reply, 404, "Alerta no encontrada.", {
            code: "SECURITY_ALERT_NOT_FOUND",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "SECURITY_ALERT_RESOLUTION_COMMENT_REQUIRED") {
          return sendError(reply, 400, "Comentario obligatorio para resolver o descartar la alerta.", {
            code: "SECURITY_ALERT_RESOLUTION_COMMENT_REQUIRED",
            requestId: request.id,
          });
        }
        if (!action.ok && action.code === "SECURITY_ALERT_STATE_NOT_ALLOWED") {
          return sendError(reply, 400, "Solo se permite resolver o descartar desde este endpoint.", {
            code: "SECURITY_ALERT_STATE_NOT_ALLOWED",
            requestId: request.id,
          });
        }
        if (!action.ok) {
          return sendError(reply, 500, "No se pudo actualizar la alerta.", {
            code: "SECURITY_ALERT_UPDATE_ERROR",
            requestId: request.id,
          });
        }

        return sendOk(
          reply,
          {
            id_alerta: action.id_alerta,
            estado: action.estado,
            comentario_resolucion: action.comentario_resolucion ?? null,
          },
          { requestId: request.id }
        );
      } catch (error) {
        return sendHandled(
          reply,
          request,
          error,
          "No se pudo actualizar estado de alerta",
          "SECURITY_ADMIN_ALERT_UPDATE_ERROR"
        );
      }
    }
  );
}
