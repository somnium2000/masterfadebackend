import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  listAdminSecurityAlerts,
  listAdminSecurityLoginLogs,
  listAdminSecuritySessions,
  listAdminSecurityUsers,
  revokeAdminSecuritySession,
  updateAdminAlertState,
  updateAdminUserAccessState,
} from "../../../services/securityService.js";

const SECURITY_READ_ROLES = ["super_admin", "security_admin", "security_auditor"];
const SECURITY_WRITE_ROLES = ["super_admin", "security_admin"];

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
    estado: { type: "string", enum: ["abierta", "en_revision", "resuelta", "descartada"] },
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

export default async function adminSeguridadRoutes(app) {
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
    "/sesiones",
    {
      preHandler: app.requireRoles(SECURITY_READ_ROLES),
      schema: { querystring: sesionesQuerySchema },
    },
    async (request, reply) => {
      try {
        const data = await listAdminSecuritySessions(app, request.query || {});
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
    "/sesiones/:id_sesion/revocar",
    {
      preHandler: app.requireRoles(SECURITY_WRITE_ROLES),
      schema: { params: idSesionParamSchema },
    },
    async (request, reply) => {
      try {
        const actorUserId = request.claims?.user?.id_usuario || null;
        const actorSessionId = request.auth?.sid || null;
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
          actorUserId,
        });

        if (!action.ok && action.code === "SECURITY_ALERT_NOT_FOUND") {
          return sendError(reply, 404, "Alerta no encontrada.", {
            code: "SECURITY_ALERT_NOT_FOUND",
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
