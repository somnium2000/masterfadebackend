import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const ADMIN_ALLOWED_ROLES = ["admin", "super_admin"];
const requestIdSchema = { type: "string" };

const errorResponseSchema = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        error: {
            type: "object",
            properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            required: ["code", "message"],
            additionalProperties: true,
        },
        requestId: requestIdSchema,
    },
    required: ["ok", "error"],
    additionalProperties: true,
};

const sucursalSchema = {
    type: "object",
    properties: {
        id_sucursal: { type: "string", format: "uuid" },
        id_empresa: { type: "string", format: "uuid" },
        nombre_sucursal: { type: "string" },
        direccion: { type: ["string", "null"] },
        telefono: { type: ["string", "null"] },
        estado: { type: "boolean" },
    },
    required: ["id_sucursal", "id_empresa", "nombre_sucursal", "estado"],
    additionalProperties: false,
};

const empresaSchema = {
    type: "object",
    properties: {
        id_empresa: { type: "string", format: "uuid" },
        nombre_empresa: { type: "string" },
    },
    required: ["id_empresa", "nombre_empresa"]
};

const LIST_SQL = `
  SELECT s.id_sucursal, s.id_empresa, s.nombre_sucursal, s.direccion_texto AS direccion, s.telefono_texto AS telefono, COALESCE(s.estado, TRUE) AS estado
  FROM public.sucursales s
  WHERE s.deleted_at IS NULL
  ORDER BY s.nombre_sucursal ASC
`;

const GET_SQL = `
  SELECT s.id_sucursal, s.id_empresa, s.nombre_sucursal, s.direccion_texto AS direccion, s.telefono_texto AS telefono, COALESCE(s.estado, TRUE) AS estado
  FROM public.sucursales s
  WHERE s.id_sucursal = $1::uuid AND s.deleted_at IS NULL
`;

function mapRow(row) {
    return {
        id_sucursal: row.id_sucursal,
        id_empresa: row.id_empresa,
        nombre_sucursal: row.nombre_sucursal,
        direccion: row.direccion ?? null,
        telefono: row.telefono ?? null,
        estado: Boolean(row.estado),
    };
}

export default async function adminSucursalesRoutes(app) {

    // ── GET / ─────────────────────────────────────────────────────────────────
    app.get("/", {
        preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
        schema: {
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: { sucursales: { type: "array", items: sucursalSchema } },
                            required: ["sucursales"],
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
    }, async (request, reply) => {
        try {
            const { rows } = await app.db.query(LIST_SQL);
            return sendOk(reply, { sucursales: rows.map(mapRow) });
        } catch (error) {
            request.log.error({ err: error }, "Admin sucursales list error");
            return sendError(reply, 500, "No se pudo consultar la lista de sucursales.", {
                code: "ADMIN_SUCURSALES_LIST_ERROR",
                details: error instanceof Error ? error.message : "Unknown error",
                requestId: request.id,
            });
        }
    });

    // ── GET /empresas ─────────────────────────────────────────────────────────
    app.get("/empresas", {
        preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
        schema: {
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: { empresas: { type: "array", items: empresaSchema } },
                            required: ["empresas"],
                            additionalProperties: false,
                        },
                        requestId: requestIdSchema,
                    },
                    required: ["ok", "data"]
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { rows } = await app.db.query("SELECT id_empresa, nombre_empresa FROM public.empresas ORDER BY nombre_empresa ASC");
            return sendOk(reply, { empresas: rows });
        } catch (error) {
            request.log.error({ err: error }, "Admin empresas list error");
            return sendError(reply, 500, "Error consultando empresas");
        }
    });

    // ── POST / ────────────────────────────────────────────────────────────────
    app.post("/", {
        preHandler: app.requireRoles(["super_admin"]),
        schema: {
            body: {
                type: "object",
                required: ["nombre_sucursal", "id_empresa"],
                properties: {
                    id_empresa: { type: "string", format: "uuid" },
                    nombre_sucursal: { type: "string", minLength: 1, maxLength: 140 },
                    direccion: { type: ["string", "null"], maxLength: 300 },
                    telefono: { type: ["string", "null"], maxLength: 30 },
                    estado: { type: "boolean" },
                },
                additionalProperties: false,
            },
            response: {
                201: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: { sucursal: sucursalSchema },
                            required: ["sucursal"],
                            additionalProperties: false,
                        },
                        requestId: requestIdSchema,
                    },
                    required: ["ok", "data"],
                    additionalProperties: true,
                },
                400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema,
                409: errorResponseSchema, 500: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id_empresa, nombre_sucursal, direccion = null, telefono = null, estado = true } = request.body;
        try {
            const dup = await app.db.query(
                `SELECT id_sucursal FROM public.sucursales WHERE LOWER(nombre_sucursal) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
                [nombre_sucursal.trim()]
            );
            if (dup.rows.length > 0) {
                return sendError(reply, 409, "Ya existe una sucursal con ese nombre.", {
                    code: "SUCURSAL_DUPLICATE", requestId: request.id,
                });
            }
            const { rows } = await app.db.query(
                `INSERT INTO public.sucursales (id_empresa, nombre_sucursal, direccion_texto, telefono_texto, estado)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id_sucursal, id_empresa, nombre_sucursal, direccion_texto AS direccion, telefono_texto AS telefono, estado`,
                [id_empresa, nombre_sucursal.trim(), direccion, telefono, estado]
            );
            return sendOk(reply, { sucursal: mapRow(rows[0]) }, { statusCode: 201 });
        } catch (error) {
            request.log.error({ err: error }, "Admin sucursales create error");
            return sendError(reply, 500, "No se pudo crear la sucursal.", {
                code: "ADMIN_SUCURSALES_CREATE_ERROR",
                details: error instanceof Error ? error.message : "Unknown error",
                requestId: request.id,
            });
        }
    });

    // ── PATCH /:id ────────────────────────────────────────────────────────────
    app.patch("/:id", {
        preHandler: app.requireRoles(ADMIN_ALLOWED_ROLES),
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            body: {
                type: "object",
                minProperties: 1,
                properties: {
                    id_empresa: { type: "string", format: "uuid" },
                    nombre_sucursal: { type: "string", minLength: 1, maxLength: 140 },
                    direccion: { type: ["string", "null"], maxLength: 300 },
                    telefono: { type: ["string", "null"], maxLength: 30 },
                    estado: { type: "boolean" },
                },
                additionalProperties: false,
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        data: {
                            type: "object",
                            properties: { sucursal: sucursalSchema },
                            required: ["sucursal"],
                            additionalProperties: false,
                        },
                        requestId: requestIdSchema,
                    },
                    required: ["ok", "data"]
                }
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        try {
            const existing = await app.db.query(GET_SQL, [id]);
            if (existing.rows.length === 0) {
                return sendError(reply, 404, "Sucursal no encontrada.", { requestId: request.id });
            }
            if (body.nombre_sucursal) {
                const dup = await app.db.query(
                    `SELECT id_sucursal FROM public.sucursales WHERE LOWER(nombre_sucursal) = LOWER($1) AND deleted_at IS NULL AND id_sucursal != $2 LIMIT 1`,
                    [body.nombre_sucursal.trim(), id]
                );
                if (dup.rows.length > 0) {
                    return sendError(reply, 409, "Ya existe otra sucursal con ese nombre.");
                }
            }
            const sets = [];
            const params = [];
            let idx = 1;
            if (body.id_empresa !== undefined) { sets.push(`id_empresa = $${idx++}`); params.push(body.id_empresa); }
            if (body.nombre_sucursal !== undefined) { sets.push(`nombre_sucursal = $${idx++}`); params.push(body.nombre_sucursal.trim()); }
            if (body.direccion !== undefined) { sets.push(`direccion_texto = $${idx++}`); params.push(body.direccion); }
            if (body.telefono !== undefined) { sets.push(`telefono_texto = $${idx++}`); params.push(body.telefono); }
            if (body.estado !== undefined) { sets.push(`estado = $${idx++}`); params.push(body.estado); }
            params.push(id);
            const { rows } = await app.db.query(
                `UPDATE public.sucursales SET ${sets.join(", ")} WHERE id_sucursal = $${idx} RETURNING id_sucursal, id_empresa, nombre_sucursal, direccion_texto AS direccion, telefono_texto AS telefono, estado`,
                params
            );
            return sendOk(reply, { sucursal: mapRow(rows[0]) });
        } catch (error) {
            request.log.error({ err: error }, "Admin sucursales patch error");
            return sendError(reply, 500, "No se pudo actualizar la sucursal.");
        }
    });

    // ── DELETE /:id ───────────────────────────────────────────────────────────
    app.delete("/:id", {
        preHandler: app.requireRoles(["super_admin"]),
        schema: {
            params: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string", format: "uuid" } },
            },
            response: {
                200: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        data: { type: "object", properties: { mensaje: { type: "string" } }, additionalProperties: false },
                        requestId: requestIdSchema,
                    },
                    required: ["ok", "data"],
                    additionalProperties: true,
                },
                401: errorResponseSchema, 403: errorResponseSchema,
                404: errorResponseSchema, 500: errorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        try {
            const result = await app.db.query(
                `UPDATE public.sucursales SET deleted_at = NOW() WHERE id_sucursal = $1 AND deleted_at IS NULL RETURNING id_sucursal`,
                [id]
            );
            if (result.rows.length === 0) {
                return sendError(reply, 404, "Sucursal no encontrada o ya fue eliminada.", {
                    code: "SUCURSAL_NOT_FOUND", requestId: request.id,
                });
            }
            return sendOk(reply, { mensaje: "Sucursal eliminada correctamente." });
        } catch (error) {
            request.log.error({ err: error }, "Admin sucursales delete error");
            return sendError(reply, 500, "No se pudo eliminar la sucursal.", {
                code: "ADMIN_SUCURSALES_DELETE_ERROR",
                details: error instanceof Error ? error.message : "Unknown error",
                requestId: request.id,
            });
        }
    });
}
