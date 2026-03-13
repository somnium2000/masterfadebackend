import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { getSystemParameters } from "../../../services/agendaService.js";

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

const branchSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string" },
  },
  required: ["id_sucursal", "nombre_sucursal"],
  additionalProperties: false,
};

const contextSchema = {
  type: "object",
  properties: {
    sucursales: { type: "array", items: branchSchema },
    parametros: {
      type: "object",
      properties: {
        hold_duracion_min: { type: "number" },
        no_show_min: { type: "number" },
        permitir_acompanantes: { type: "boolean" },
        pago_total_obligatorio: { type: "boolean" },
      },
      required: [
        "hold_duracion_min",
        "no_show_min",
        "permitir_acompanantes",
        "pago_total_obligatorio",
      ],
      additionalProperties: false,
    },
  },
  required: ["sucursales", "parametros"],
  additionalProperties: false,
};

function normalizePublicParams(paramsMap) {
  const hold = paramsMap?.hold_duracion_min?.valor_numero;
  const noShow = paramsMap?.no_show_min?.valor_numero;
  const companions = paramsMap?.permitir_acompanantes?.valor_booleano;
  const fullPayment = paramsMap?.pago_total_obligatorio?.valor_booleano;

  return {
    hold_duracion_min: Number.isFinite(Number(hold)) ? Number(hold) : 5,
    no_show_min: Number.isFinite(Number(noShow)) ? Number(noShow) : 10,
    permitir_acompanantes: typeof companions === "boolean" ? companions : false,
    pago_total_obligatorio: typeof fullPayment === "boolean" ? fullPayment : true,
  };
}

export default async function publicCitasRoutes(app) {
  app.get(
    "/contexto",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: contextSchema,
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }

      try {
        const [branchResult, paramsMap] = await Promise.all([
          app.db.query(
            `
              SELECT id_sucursal, nombre_sucursal
              FROM public.sucursales
              WHERE deleted_at IS NULL
                AND estado IS TRUE
              ORDER BY nombre_sucursal ASC
            `
          ),
          getSystemParameters(app.db),
        ]);

        const sucursales = branchResult.rows.map((row) => ({
          id_sucursal: row.id_sucursal,
          nombre_sucursal: row.nombre_sucursal || "Sucursal",
        }));

        const parametros = normalizePublicParams(paramsMap);

        return sendOk(reply, { sucursales, parametros });
      } catch (error) {
        request.log.error({ err: error }, "Public citas contexto error");
        return sendError(reply, 500, "No se pudo consultar el contexto de citas publicas", {
          code: "PUBLIC_CITAS_CONTEXT_ERROR",
          details: error instanceof Error ? error.message : "Unknown public citas context error",
          requestId: request.id,
        });
      }
    }
  );
}
