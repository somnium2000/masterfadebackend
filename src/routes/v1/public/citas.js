import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  ensureActiveBranch,
  getHoldDurationMinutes,
  getSystemParameters,
  parseDateTime,
  resolveBookingSelection,
} from "../../../services/agendaService.js";

const requestIdSchema = { type: "string" };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const PUBLIC_TECHNICAL_CLIENT = {
  nombre: "Cliente Publico",
  telefono: "00000000",
  email: "publico.booking@masterfade.local",
};

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

const holdBlockSchema = {
  type: "object",
  properties: {
    id_cita: { type: "string", format: "uuid" },
    orden_integrante: { type: "integer" },
    alias: { type: "string" },
    id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    nombre_barbero: { type: "string" },
    fecha: { type: "string", format: "date" },
    hora: { type: "string" },
    fecha_inicio: { type: "string", format: "date-time" },
    estado_cita_codigo: { type: "string" },
    monto_total_hnl: { type: "number" },
    duracion_total_min: { type: "integer" },
    buffer_total_min: { type: "integer" },
  },
  required: [
    "id_cita",
    "orden_integrante",
    "alias",
    "id_barbero",
    "nombre_barbero",
    "fecha",
    "hora",
    "fecha_inicio",
    "estado_cita_codigo",
    "monto_total_hnl",
    "duracion_total_min",
    "buffer_total_min",
  ],
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
    details: error instanceof Error ? error.message : "Unknown public citas error",
    requestId: request.id,
  });
}

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function splitFullName(rawName) {
  const normalized = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { nombres: "Cliente", apellidos: "Publico" };
  }

  const parts = normalized.split(" ");
  if (parts.length === 1) {
    return { nombres: parts[0], apellidos: "Publico" };
  }

  return {
    nombres: parts.slice(0, -1).join(" "),
    apellidos: parts[parts.length - 1],
  };
}

function normalizePhone(rawValue) {
  return String(rawValue || "").replace(/[^\d+]/g, "").slice(0, 20);
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function parseIsoDateAndTime(rawDateTime) {
  const match = String(rawDateTime || "").trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) {
    return { fecha: null, hora: null };
  }
  return { fecha: match[1], hora: match[2] };
}

function getDateTimePartsInTimeZone(dateValue, timeZone = HONDURAS_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(dateValue);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  if (!year || !month || !day || !hour || !minute || !second) {
    return null;
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

function compareDateTimeParts(left, right) {
  if (!left || !right) return 0;
  const leftKey = [
    left.year,
    left.month,
    left.day,
    left.hour,
    left.minute,
    left.second,
  ];
  const rightKey = [
    right.year,
    right.month,
    right.day,
    right.hour,
    right.minute,
    right.second,
  ];

  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] > rightKey[index]) return 1;
    if (leftKey[index] < rightKey[index]) return -1;
  }
  return 0;
}

function assertDateTimeNotPastInHonduras(rawDateTime, field = "fecha_inicio") {
  const parsed = parseDateTime(rawDateTime, field);
  const requestParts = getDateTimePartsInTimeZone(parsed, HONDURAS_TIME_ZONE);
  const nowParts = getDateTimePartsInTimeZone(new Date(), HONDURAS_TIME_ZONE);

  if (!requestParts || !nowParts) return parsed;

  if (compareDateTimeParts(requestParts, nowParts) < 0) {
    throw new AppError(400, `${field} no puede estar en el pasado`, {
      code: "PUBLIC_CITAS_PAST_DATETIME",
      details: { field, value: rawDateTime, time_zone: HONDURAS_TIME_ZONE },
    });
  }

  return parsed;
}

function validateClientPayload(cliente) {
  if (cliente == null) {
    return { ...PUBLIC_TECHNICAL_CLIENT };
  }

  const nombre = String(cliente?.nombre || "").trim();
  const telefono = normalizePhone(cliente?.telefono);
  const email = normalizeEmail(cliente?.email);

  if (!nombre) {
    throw new AppError(400, "cliente.nombre es obligatorio", {
      code: "PUBLIC_CITAS_CLIENT_NAME_REQUIRED",
    });
  }
  if (telefono.length < 8) {
    throw new AppError(400, "cliente.telefono es obligatorio y debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_REQUIRED",
    });
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "cliente.email es obligatorio y debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_EMAIL_REQUIRED",
    });
  }

  return {
    nombre,
    telefono,
    email,
  };
}

function normalizeBlocksPayload(body) {
  const hasGroupedPayload = Array.isArray(body?.integrantes) && body.integrantes.length > 0;
  const legacyPayload = body?.fecha_inicio && Array.isArray(body?.servicios)
    ? [{
      orden_integrante: 1,
      alias: "Titular",
      id_barbero: body?.id_barbero ?? null,
      fecha_inicio: body.fecha_inicio,
      servicios: body.servicios,
    }]
    : [];

  const rawBlocks = hasGroupedPayload ? body.integrantes : legacyPayload;
  if (!rawBlocks.length) {
    throw new AppError(400, "Debes enviar al menos un integrante para crear la reserva", {
      code: "PUBLIC_CITAS_BLOCKS_REQUIRED",
    });
  }

  return rawBlocks.map((item, index) => {
    const aliasFallback = index === 0 ? "Titular" : `Acompanante ${index}`;
    const alias = String(item?.alias || aliasFallback).trim().slice(0, 80) || aliasFallback;
    const ordenIntegrante = Number(item?.orden_integrante);
    const servicios = Array.isArray(item?.servicios) ? item.servicios : [];

    if (!servicios.length) {
      throw new AppError(400, `El integrante ${alias} no tiene servicios seleccionados`, {
        code: "PUBLIC_CITAS_BLOCK_SERVICES_REQUIRED",
        details: { alias, index },
      });
    }

    const serviceIds = servicios.map((service) => assertUuid(service?.id_servicio, "id_servicio"));

    const fechaInicio = String(item?.fecha_inicio || "").trim();
    assertDateTimeNotPastInHonduras(fechaInicio, "fecha_inicio");

    return {
      orden_integrante: Number.isFinite(ordenIntegrante) && ordenIntegrante > 0 ? Math.trunc(ordenIntegrante) : index + 1,
      alias,
      id_barbero: item?.id_barbero ? assertUuid(item.id_barbero, "id_barbero") : null,
      fecha_inicio: fechaInicio,
      serviceIds,
    };
  });
}

async function resolveOrCreatePublicClient(client, payload) {
  const { nombre, telefono, email, idSucursal } = payload;

  const existingResult = await client.query(
    `
      SELECT c.id_cliente, c.id_persona
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
       AND p.deleted_at IS NULL
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE c.deleted_at IS NULL
        AND c.estado IS TRUE
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  if (existingResult.rows[0]) {
    await client.query(
      `
        UPDATE public.personas
        SET telefono_principal = COALESCE(NULLIF($2, ''), telefono_principal),
            updated_at = now()
        WHERE id_persona = $1::uuid
      `,
      [existingResult.rows[0].id_persona, telefono]
    );

    return {
      id_cliente: existingResult.rows[0].id_cliente,
      id_persona: existingResult.rows[0].id_persona,
    };
  }

  const { nombres, apellidos } = splitFullName(nombre);

  const personaInsert = await client.query(
    `
      INSERT INTO public.personas (nombres, apellidos, telefono_principal)
      VALUES ($1, $2, $3)
      RETURNING id_persona
    `,
    [nombres, apellidos, telefono]
  );

  const idPersona = personaInsert.rows[0].id_persona;

  const clienteInsert = await client.query(
    `
      INSERT INTO public.clientes (id_persona, id_usuario, acepta_terminos, id_sucursal_origen)
      VALUES ($1::uuid, NULL, TRUE, $2::uuid)
      RETURNING id_cliente
    `,
    [idPersona, idSucursal]
  );

  await client.query(
    `
      INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
      VALUES ($1::uuid, $2, TRUE, FALSE)
      ON CONFLICT DO NOTHING
    `,
    [idPersona, email]
  );

  return {
    id_cliente: clienteInsert.rows[0].id_cliente,
    id_persona: idPersona,
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

  app.post(
    "/hold",
    {
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            integrantes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["fecha_inicio", "servicios"],
                properties: {
                  orden_integrante: { type: "integer" },
                  alias: { type: "string", maxLength: 80 },
                  id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  fecha_inicio: { type: "string", format: "date-time" },
                  servicios: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      required: ["id_servicio"],
                      properties: {
                        id_servicio: { type: "string", format: "uuid" },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            },
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            fecha_inicio: { type: "string", format: "date-time" },
            servicios: {
              type: "array",
              items: {
                type: "object",
                required: ["id_servicio"],
                properties: {
                  id_servicio: { type: "string", format: "uuid" },
                },
                additionalProperties: false,
              },
            },
            cliente: {
              type: "object",
              required: ["nombre", "telefono", "email"],
              properties: {
                nombre: { type: "string", minLength: 1, maxLength: 120 },
                telefono: { type: "string", minLength: 8, maxLength: 20 },
                email: { type: "string", format: "email", maxLength: 160 },
              },
              additionalProperties: false,
            },
            notas: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
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
                properties: {
                  id_grupo_cita: { type: "string", format: "uuid" },
                  estado_grupo_codigo: { type: "string" },
                  expires_at: { type: "string", format: "date-time" },
                  monto_total_hnl: { type: "number" },
                  bloques: { type: "array", items: holdBlockSchema },
                },
                required: ["id_grupo_cita", "estado_grupo_codigo", "expires_at", "monto_total_hnl", "bloques"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
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

      const dbClient = await app.db.connect();
      try {
        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const clientePayload = validateClientPayload(request.body?.cliente);
        const integrantes = normalizeBlocksPayload(request.body);

        const branch = await ensureActiveBranch(dbClient, idSucursal);

        await dbClient.query("BEGIN");

        const clientProfile = await resolveOrCreatePublicClient(dbClient, {
          ...clientePayload,
          idSucursal: branch.id_sucursal,
        });

        const holdDurationMin = await getHoldDurationMinutes(dbClient);
        const expiresAt = new Date(Date.now() + holdDurationMin * 60 * 1000);

        const groupInsert = await dbClient.query(
          `
            INSERT INTO public.citas_grupos (
              id_sucursal,
              id_persona_titular,
              id_cliente_titular,
              estado_grupo_codigo,
              notas
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, 'activo', $4)
            RETURNING id_grupo_cita, estado_grupo_codigo
          `,
          [
            branch.id_sucursal,
            clientProfile.id_persona,
            clientProfile.id_cliente,
            request.body?.notas ?? null,
          ]
        );

        const groupRecord = groupInsert.rows[0];
        const bloquesResponse = [];
        let totalGrupo = 0;

        for (let index = 0; index < integrantes.length; index += 1) {
          const integrante = integrantes[index];
          const selection = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            servicios: integrante.serviceIds,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
          });

          const totalDuration = selection.serviceSelection.duracion_total_min + selection.serviceSelection.buffer_total_min;
          const finAt = new Date(selection.startDateTime.getTime() + totalDuration * 60 * 1000);

          const citaInsert = await dbClient.query(
            `
              INSERT INTO public.citas (
                id_grupo_cita,
                orden_integrante,
                alias_integrante,
                id_sucursal,
                id_empleado_barbero,
                id_persona_cliente,
                id_cliente,
                creada_por_usuario_id,
                asignada_automaticamente,
                estado_cita_codigo,
                inicio_at,
                fin_at,
                duracion_total_min,
                buffer_total_min,
                subtotal_servicios_hnl,
                descuento_hnl,
                total_pagar_hnl,
                notas
              )
              VALUES (
                $1::uuid,
                $2::int,
                $3,
                $4::uuid,
                $5::uuid,
                $6::uuid,
                $7::uuid,
                NULL,
                $8::boolean,
                'en_espera',
                $9::timestamptz,
                $10::timestamptz,
                $11::int,
                $12::int,
                $13::numeric,
                0,
                $14::numeric,
                $15
              )
              RETURNING id_cita
            `,
            [
              groupRecord.id_grupo_cita,
              integrante.orden_integrante,
              integrante.alias,
              branch.id_sucursal,
              selection.barber.id_empleado,
              clientProfile.id_persona,
              clientProfile.id_cliente,
              !integrante.id_barbero,
              selection.startDateTime.toISOString(),
              finAt.toISOString(),
              selection.serviceSelection.duracion_total_min,
              selection.serviceSelection.buffer_total_min,
              selection.serviceSelection.monto_total_hnl,
              selection.serviceSelection.monto_total_hnl,
              request.body?.notas ?? null,
            ]
          );

          const citaId = citaInsert.rows[0].id_cita;

          for (const serviceItem of selection.serviceSelection.items) {
            await dbClient.query(
              `
                INSERT INTO public.citas_detalles (
                  id_cita,
                  id_servicio,
                  cantidad,
                  duracion_min,
                  buffer_min,
                  precio_unitario_hnl,
                  subtotal_hnl
                )
                VALUES ($1::uuid, $2::uuid, 1, $3::int, $4::int, $5::numeric, $6::numeric)
              `,
              [
                citaId,
                serviceItem.id_servicio,
                serviceItem.duracion_min,
                serviceItem.buffer_min,
                serviceItem.precio_hnl,
                serviceItem.precio_hnl,
              ]
            );
          }

          await dbClient.query(
            `
              INSERT INTO public.citas_holds (
                id_cita,
                id_usuario,
                estado_hold_codigo,
                expires_at
              )
              VALUES ($1::uuid, NULL, 'activo', $2::timestamptz)
            `,
            [citaId, expiresAt.toISOString()]
          );

          totalGrupo += Number(selection.serviceSelection.monto_total_hnl || 0);
          const { fecha, hora } = parseIsoDateAndTime(integrante.fecha_inicio);

          bloquesResponse.push({
            id_cita: citaId,
            orden_integrante: integrante.orden_integrante,
            alias: integrante.alias,
            id_barbero: selection.barber.id_empleado,
            nombre_barbero: selection.barber.nombre_completo,
            fecha: fecha || "",
            hora: hora || "",
            fecha_inicio: selection.startDateTime.toISOString(),
            estado_cita_codigo: "en_espera",
            monto_total_hnl: Number(selection.serviceSelection.monto_total_hnl || 0),
            duracion_total_min: Number(selection.serviceSelection.duracion_total_min || 0),
            buffer_total_min: Number(selection.serviceSelection.buffer_total_min || 0),
          });
        }

        await dbClient.query("COMMIT");

        return sendOk(
          reply,
          {
            id_grupo_cita: groupRecord.id_grupo_cita,
            estado_grupo_codigo: groupRecord.estado_grupo_codigo || "activo",
            expires_at: expiresAt.toISOString(),
            monto_total_hnl: totalGrupo,
            bloques: bloquesResponse,
          },
          { statusCode: 201 }
        );
      } catch (error) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // no-op
        }

        if (isConflictError(error)) {
          return sendError(reply, 409, "Ya existe un conflicto de disponibilidad para uno de los bloques", {
            code: "PUBLIC_CITAS_HOLD_CONFLICT",
            details: error instanceof Error ? error.message : "Public hold conflict",
            requestId: request.id,
          });
        }

        return sendHandled(reply, request, error, "No se pudo crear el hold publico", "PUBLIC_CITAS_HOLD_CREATE_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );
}
