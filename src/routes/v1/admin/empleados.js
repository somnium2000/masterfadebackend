import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const ADMIN_ALLOWED_ROLES = ["super_admin", "admin"];

const requestIdSchema = { type: "string" };

const errorResponseSchema = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        error: {
            type: "object",
            properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: {},
            },
            required: ["code", "message"],
            additionalProperties: true,
        },
        requestId: requestIdSchema,
    },
    required: ["ok", "error"],
    additionalProperties: true,
};

const empleadoSchema = {
    type: "object",
    properties: {
        id_empleado: { type: "string", format: "uuid" },
        nombre_completo: { type: "string" },
        telefono: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        roles: { type: "array", items: { type: "string" } },
        nombre_sucursal: { type: ["string", "null"] },
        activo: { type: "boolean" },
    },
    required: ["id_empleado", "nombre_completo", "activo"],
    additionalProperties: false,
};

const LIST_EMPLEADOS_SQL = `
  SELECT
    e.id_empleado,
    COALESCE(
      NULLIF(TRIM(CONCAT(p.nombres, ' ', p.apellidos)), ''),
      u.id_usuario::text,
      'Sin nombre'
    ) AS nombre_completo,
    p.telefono_principal AS telefono,
    NULLIF(correo_principal.email, '') AS email,
    COALESCE(
      (SELECT array_agg(r.nombre ORDER BY r.nombre)
       FROM public.roles_usuarios ru
       JOIN public.roles r ON r.id_rol = ru.id_rol
       WHERE ru.id_usuario = u.id_usuario
         AND ru.activo IS TRUE),
      ARRAY[]::text[]
    ) AS roles,
    s.nombre_sucursal,
    COALESCE(e.estado, TRUE) AS activo
  FROM public.empleados e
  LEFT JOIN public.personas p ON p.id_persona = e.id_persona
  LEFT JOIN public.usuarios u ON u.id_persona = e.id_persona
  LEFT JOIN LATERAL (
    SELECT c.direccion_correo::text AS email
    FROM public.correos c
    WHERE c.id_persona = e.id_persona
      AND c.deleted_at IS NULL
    ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
    LIMIT 1
  ) correo_principal ON TRUE
  LEFT JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
  WHERE e.deleted_at IS NULL
  ORDER BY nombre_completo ASC
`;


export default async function adminEmpleadosRoutes(app) {
    // AM: Ruta legacy de listado. Se mantiene por compatibilidad, sin operaciones destructivas.
    app.get(
        "/",
        {
            preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
            schema: {
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: {
                                type: "object",
                                properties: {
                                    empleados: { type: "array", items: empleadoSchema },
                                },
                                required: ["empleados"],
                                additionalProperties: false,
                            },
                            requestId: requestIdSchema,
                        },
                        required: ["ok", "data"],
                        additionalProperties: true,
                    },
                    401: errorResponseSchema,
                    403: errorResponseSchema,
                    500: errorResponseSchema,
                },
            },
        },
        async (request, reply) => {
            try {
                const { rows } = await app.db.query(LIST_EMPLEADOS_SQL);
                return sendOk(reply, {
                    empleados: rows.map((row) => ({
                        id_empleado: row.id_empleado,
                        nombre_completo: row.nombre_completo,
                        telefono: row.telefono ?? null,
                        email: row.email ?? null,
                        roles: Array.isArray(row.roles) ? row.roles : [],
                        nombre_sucursal: row.nombre_sucursal ?? null,
                        activo: Boolean(row.activo),
                    })),
                });
            } catch (error) {
                request.log.error({ err: error }, "Admin empleados list error");
                return sendError(reply, 500, "No se pudo consultar la lista de empleados", {
                    code: "ADMIN_EMPLEADOS_LIST_ERROR",
                    requestId: request.id,
                });
            }
        }
    );
}
