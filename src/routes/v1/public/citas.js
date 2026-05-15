import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  ensureActiveBranch,
  expireStaleAppointmentReservations,
  getHoldDurationMinutes,
  getSystemParameters,
  parseSinglePackageId,
  parseDateTime,
  resolveBookingSelection,
} from "../../../services/agendaService.js";
import {
  previewPromotionsForAppointment,
  recordPromotionApplications,
} from "../../../services/promociones/promocionesService.js";

const requestIdSchema = { type: "string" };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
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
        agenda_buffer_global_min: { type: "number" },
        permitir_acompanantes: { type: "boolean" },
        pago_total_obligatorio: { type: "boolean" },
        simulacion_sin_pago: { type: "boolean" },
      },
      required: [
        "hold_duracion_min",
        "no_show_min",
        "agenda_buffer_global_min",
        "permitir_acompanantes",
        "pago_total_obligatorio",
        "simulacion_sin_pago",
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
    descuento_hnl: { type: "number" },
    total_pagar_hnl: { type: "number" },
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
    "descuento_hnl",
    "total_pagar_hnl",
    "duracion_total_min",
    "buffer_total_min",
  ],
  additionalProperties: false,
};

function normalizePublicParams(paramsMap) {
  const hold = paramsMap?.hold_duracion_min?.valor_numero;
  const noShow = paramsMap?.no_show_min?.valor_numero;
  const globalBuffer = paramsMap?.agenda_buffer_global_min?.valor_numero;
  const companions = paramsMap?.permitir_acompanantes?.valor_booleano;
  const fullPayment = paramsMap?.pago_total_obligatorio?.valor_booleano;
  const simulationNoPayment = paramsMap?.simulacion_sin_pago?.valor_booleano;

  return {
    hold_duracion_min: Number.isFinite(Number(hold)) ? Number(hold) : 5,
    no_show_min: Number.isFinite(Number(noShow)) ? Number(noShow) : 10,
    agenda_buffer_global_min: Number.isFinite(Number(globalBuffer)) ? Number(globalBuffer) : 0,
    permitir_acompanantes: typeof companions === "boolean" ? companions : false,
    pago_total_obligatorio: typeof fullPayment === "boolean" ? fullPayment : true,
    simulacion_sin_pago: typeof simulationNoPayment === "boolean" ? simulationNoPayment : false,
  };
}

const PUBLIC_CITAS_SAFE_DETAIL_KEYS = new Set([
  "field",
  "blockIndex",
  "maxCompanions",
  "selection_type",
  "alias",
]);

function sanitizePublicCitasErrorDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails)) return undefined;
  const safeDetails = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!PUBLIC_CITAS_SAFE_DETAIL_KEYS.has(key)) continue;
    if (key === "blockIndex" || key === "maxCompanions") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 20) safeDetails[key] = parsed;
      continue;
    }
    if (value == null) continue;
    safeDetails[key] = String(value).trim().slice(0, 160);
  }
  return Object.keys(safeDetails).length ? safeDetails : undefined;
}

function sendHandled(reply, request, error, message, code) {
  if (error instanceof AppError) {
    request.log.warn(
      {
        requestId: request.id,
        statusCode: error.statusCode,
        code: error.code,
        details: error.details,
      },
      "Public citas handled AppError"
    );
    const safeDetails = sanitizePublicCitasErrorDetails(error.details);
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      ...(safeDetails ? { details: safeDetails } : {}),
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    requestId: request.id,
  });
}

function isConflictError(error) {
  return error?.code === "23P01" || /YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO/i.test(String(error?.message || ""));
}

function isAvailabilityConflictError(error) {
  if (isConflictError(error)) return true;
  if (!(error instanceof AppError)) return false;
  if (error.statusCode !== 409) return false;
  const safeCode = String(error.code || "").trim().toUpperCase();
  return safeCode.startsWith("AGENDA_")
    || safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER";
}

function resolveSafeConflictReason(error) {
  if (isConflictError(error)) return "DB_CONFLICT";
  if (!(error instanceof AppError)) return "UNKNOWN_CONFLICT";
  const safeCode = String(error.code || "").trim().toUpperCase();
  if (safeCode.startsWith("AGENDA_")) return safeCode;
  if (safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER") return safeCode;
  return "UNKNOWN_CONFLICT";
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

function normalizePersonName(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token
      .split(/([-'])/)
      .map((part, index) => {
        if (index % 2 === 1) return part;
        const lower = String(part || "").toLocaleLowerCase("es-HN");
        if (!lower) return "";
        return `${lower.charAt(0).toLocaleUpperCase("es-HN")}${lower.slice(1)}`;
      })
      .join(""))
    .join(" ");
}

function buildFullName(nombres, apellidos) {
  return [normalizePersonName(nombres), normalizePersonName(apellidos)]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function normalizePhone(rawValue) {
  return String(rawValue || "").replace(/[^\d+]/g, "").slice(0, 20);
}

function hasPhoneLetters(rawValue) {
  return /[A-Za-z]/.test(String(rawValue || ""));
}

function hasUnsafeText(rawValue) {
  return /[<>]/.test(String(rawValue || ""));
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

function validateClientPayload(titular) {
  const nombres = normalizePersonName(titular?.nombres || "");
  const apellidos = normalizePersonName(titular?.apellidos || "");
  const nombre = buildFullName(nombres, apellidos) || normalizePersonName(titular?.nombre || "");
  const rawTelefono = String(titular?.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);
  const email = normalizeEmail(titular?.email);

  if (!nombre || hasUnsafeText(nombre) || nombre.length < 2 || nombre.length > 120) {
    throw new AppError(400, "titular.nombre es obligatorio", {
      code: "PUBLIC_CITAS_CLIENT_NAME_REQUIRED",
      details: { field: "titular.nombre" },
    });
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "titular.email es obligatorio y debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_EMAIL_REQUIRED",
      details: { field: "titular.email" },
    });
  }
  if (!rawTelefono) {
    throw new AppError(400, "titular.telefono es obligatorio", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_REQUIRED",
      details: { field: "titular.telefono" },
    });
  }
  if (hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "titular.telefono no admite letras", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }
  if (!telefono || telefono.length < 8) {
    throw new AppError(400, "titular.telefono debe ser valido", {
      code: "PUBLIC_CITAS_CLIENT_PHONE_INVALID",
      details: { field: "titular.telefono" },
    });
  }

  return {
    nombre,
    nombres,
    apellidos,
    telefono,
    email,
  };
}

function validateCompanionContactPayload(contacto, { alias, index }) {
  const nombres = normalizePersonName(contacto?.nombres || "");
  const apellidos = normalizePersonName(contacto?.apellidos || "");
  const nombreLegacy = normalizePersonName(contacto?.nombre || "");
  const legacyTokens = nombreLegacy.split(" ").filter(Boolean);
  const effectiveNombres = nombres || (
    legacyTokens.length > 1
      ? normalizePersonName(legacyTokens.slice(0, -1).join(" "))
      : normalizePersonName(legacyTokens[0] || "")
  );
  const effectiveApellidos = apellidos || (
    legacyTokens.length > 1
      ? normalizePersonName(legacyTokens[legacyTokens.length - 1])
      : ""
  );
  const nombre = buildFullName(effectiveNombres, effectiveApellidos);
  const email = normalizeEmail(contacto?.email);
  const rawTelefono = String(contacto?.telefono || "").trim();
  const telefono = normalizePhone(rawTelefono);
  const blockIndex = index;

  if (!effectiveNombres || hasUnsafeText(effectiveNombres) || effectiveNombres.length < 2 || effectiveNombres.length > 120) {
    throw new AppError(400, "El nombre del acompanante es obligatorio", {
      code: "PUBLIC_CITAS_COMPANION_NAME_REQUIRED",
      details: { field: "contacto.nombres", alias, blockIndex },
    });
  }
  if (!effectiveApellidos || hasUnsafeText(effectiveApellidos) || effectiveApellidos.length < 2 || effectiveApellidos.length > 120) {
    throw new AppError(400, "El apellido del acompanante es obligatorio", {
      code: "PUBLIC_CITAS_COMPANION_LAST_NAME_REQUIRED",
      details: { field: "contacto.apellidos", alias, blockIndex },
    });
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "El correo del acompanante debe ser valido", {
      code: "PUBLIC_CITAS_COMPANION_EMAIL_INVALID",
      details: { field: "contacto.email", alias, blockIndex },
    });
  }
  if (rawTelefono && hasPhoneLetters(rawTelefono)) {
    throw new AppError(400, "El telefono del acompanante no admite letras", {
      code: "PUBLIC_CITAS_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }
  if (telefono && telefono.length < 8) {
    throw new AppError(400, "El telefono del acompanante debe ser valido", {
      code: "PUBLIC_CITAS_COMPANION_PHONE_INVALID",
      details: { field: "contacto.telefono", alias, blockIndex },
    });
  }

  return {
    nombre,
    nombres: effectiveNombres,
    apellidos: effectiveApellidos,
    email: email || null,
    telefono: telefono || null,
  };
}

function normalizeBlocksPayload(body, titularPayload) {
  const hasGroupedPayload = Array.isArray(body?.integrantes) && body.integrantes.length > 0;
  const hasLegacySelection = body?.selection_type === "package" || body?.selection_type === "mixed"
    ? Boolean(body?.fecha_inicio && body?.id_paquete)
    : Boolean(body?.fecha_inicio && Array.isArray(body?.servicios));
  const legacyPayload = hasLegacySelection
    ? [{
      orden_integrante: 1,
      alias: "Titular",
      id_barbero: body?.id_barbero ?? null,
      selection_type: body?.selection_type ?? "services",
      id_paquete: body?.id_paquete ?? null,
      id_promocion: body?.id_promocion ?? null,
      id_promocion_regla: body?.id_promocion_regla ?? null,
      fecha_inicio: body.fecha_inicio,
      servicios: body.servicios,
    }]
    : [];

  const rawBlocks = hasGroupedPayload ? body.integrantes : legacyPayload;
  if (!rawBlocks.length) {
    throw new AppError(400, "Debes enviar al menos un integrante para crear la reserva", {
      code: "PUBLIC_CITAS_BLOCKS_REQUIRED",
      details: { field: "integrantes" },
    });
  }

  return rawBlocks.map((item, index) => {
    const aliasFallback = index === 0 ? "Titular" : `Acompanante ${index}`;
    const alias = String(item?.alias || aliasFallback).trim().slice(0, 80) || aliasFallback;
    const ordenIntegrante = Number(item?.orden_integrante);
    const selectionType = String(item?.selection_type || "services").trim().toLowerCase();
    const servicios = Array.isArray(item?.servicios) ? item.servicios : [];
    const packageId = parseSinglePackageId(item?.id_paquete, { required: false, field: "id_paquete" });

    if (!["services", "package", "mixed"].includes(selectionType)) {
      throw new AppError(400, `El integrante ${alias} tiene un selection_type invalido`, {
        code: "PUBLIC_CITAS_BLOCK_SELECTION_TYPE_INVALID",
        details: { field: "selection_type", alias, blockIndex: index, selection_type: item?.selection_type ?? null },
      });
    }

    if ((selectionType === "services" || selectionType === "mixed") && !servicios.length && !packageId) {
      throw new AppError(400, `El integrante ${alias} no tiene servicios seleccionados`, {
        code: "PUBLIC_CITAS_BLOCK_SERVICES_REQUIRED",
        details: { field: "servicios", alias, blockIndex: index },
      });
    }

    if ((selectionType === "package" || selectionType === "mixed") && !packageId && !servicios.length) {
      throw new AppError(400, `El integrante ${alias} no tiene paquete seleccionado`, {
        code: "PUBLIC_CITAS_BLOCK_PACKAGE_REQUIRED",
        details: { field: "id_paquete", alias, blockIndex: index },
      });
    }

    const serviceIds = (selectionType === "services" || selectionType === "mixed")
      ? servicios.map((service) => assertUuid(service?.id_servicio, "id_servicio"))
      : [];

    const fechaInicio = String(item?.fecha_inicio || "").trim();
    assertDateTimeNotPastInHonduras(fechaInicio, "fecha_inicio");

    return {
      orden_integrante: Number.isFinite(ordenIntegrante) && ordenIntegrante > 0 ? Math.trunc(ordenIntegrante) : index + 1,
      alias,
      id_barbero: item?.id_barbero ? assertUuid(item.id_barbero, "id_barbero") : null,
      selection_type: selectionType,
      id_paquete: packageId,
      id_promocion: item?.id_promocion ? assertUuid(item.id_promocion, "id_promocion") : null,
      id_promocion_regla: item?.id_promocion_regla ? assertUuid(item.id_promocion_regla, "id_promocion_regla") : null,
      fecha_inicio: fechaInicio,
      serviceIds,
      contacto: index === 0
        ? {
            nombre: titularPayload.nombre,
            nombres: titularPayload.nombres || splitFullName(titularPayload.nombre).nombres,
            apellidos: titularPayload.apellidos || splitFullName(titularPayload.nombre).apellidos,
            email: titularPayload.email,
            telefono: titularPayload.telefono || null,
          }
        : validateCompanionContactPayload(item?.contacto, { alias, index }),
    };
  });
}

async function resolveOrCreatePublicClient(client, payload) {
  const { nombre, nombres, apellidos, telefono, email, idSucursal } = payload;

  const existingActiveUserByEmailResult = await client.query(
    `
      SELECT u.id_usuario
      FROM public.usuarios u
      JOIN public.personas p
        ON p.id_persona = u.id_persona
       AND p.deleted_at IS NULL
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.estado, TRUE) IS TRUE
        AND COALESCE(u.estado_acceso, 'activo') = 'activo'
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  if (existingActiveUserByEmailResult.rows[0]) {
    throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesión para continuar.", {
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      details: { field: "titular.email" },
    });
  }

  const existingUserClientResult = await client.query(
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

  if (existingUserClientResult.rows[0]) {
    throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesión para continuar.", {
      code: "EMAIL_BELONGS_TO_ACTIVE_USER",
      details: { field: "titular.email" },
    });
  }

  const existingPersonaResult = await client.query(
    `
      SELECT p.id_persona
      FROM public.personas p
      JOIN public.correos co
        ON co.id_persona = p.id_persona
       AND co.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND lower(co.direccion_correo::text) = lower($1)
      ORDER BY co.verificado DESC, co.es_principal DESC, co.created_at ASC
      LIMIT 1
    `,
    [email]
  );

  let idPersona = existingPersonaResult.rows[0]?.id_persona || null;

  if (!idPersona) {
    const resolvedName = buildFullName(nombres, apellidos) || nombre;
    const splitName = splitFullName(resolvedName);

    const personaInsert = await client.query(
      `
        INSERT INTO public.personas (nombres, apellidos, telefono_principal)
        VALUES ($1, $2, $3)
        RETURNING id_persona
      `,
      [splitName.nombres, splitName.apellidos, telefono || null]
    );
    idPersona = personaInsert.rows[0].id_persona;
  } else if (telefono) {
    await client.query(
      `
        UPDATE public.personas
        SET telefono_principal = COALESCE(NULLIF(telefono_principal, ''), $2),
            updated_at = NOW()
        WHERE id_persona = $1::uuid
      `,
      [idPersona, telefono]
    );
  }

  void idSucursal;

  await client.query(
    `
      INSERT INTO public.correos (id_persona, direccion_correo, es_principal, verificado)
      VALUES ($1::uuid, $2, TRUE, FALSE)
      ON CONFLICT DO NOTHING
    `,
    [idPersona, email]
  );

  return {
    id_cliente: null,
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
          requestId: request.id,
        });
      }
    }
  );

  app.post(
    "/hold",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["id_sucursal", "titular"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            titular: {
              type: "object",
              required: ["nombre", "email", "telefono"],
              properties: {
                nombre: { type: "string", minLength: 1, maxLength: 120 },
                nombres: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                apellidos: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                email: { type: "string", format: "email", maxLength: 160 },
                telefono: { anyOf: [{ type: "string", minLength: 8, maxLength: 20 }, { type: "null" }] },
              },
              additionalProperties: false,
            },
            integrantes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["fecha_inicio"],
                properties: {
                  orden_integrante: { type: "integer" },
                  alias: { type: "string", maxLength: 80 },
                  id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  selection_type: { type: "string", enum: ["services", "package", "mixed"] },
                  id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  contacto: {
                    type: "object",
                    properties: {
                      nombre: { type: "string", minLength: 1, maxLength: 120 },
                      nombres: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                      apellidos: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
                      email: { anyOf: [{ type: "string", format: "email", maxLength: 160 }, { type: "null" }] },
                      telefono: { anyOf: [{ type: "string", minLength: 8, maxLength: 20 }, { type: "null" }] },
                    },
                    additionalProperties: false,
                  },
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
                  id_promocion: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  id_promocion_regla: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                },
                additionalProperties: false,
              },
            },
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            fecha_inicio: { type: "string", format: "date-time" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
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
            id_promocion: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            id_promocion_regla: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
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
                  expires_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
                  monto_total_hnl: { type: "number" },
                  subtotal_hnl: { type: "number" },
                  descuento_total_hnl: { type: "number" },
                  total_hnl: { type: "number" },
                  promociones_aplicadas: { type: "array", items: { type: "object", additionalProperties: true } },
                  promociones_descartadas: { type: "array", items: { type: "object", additionalProperties: true } },
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
        await expireStaleAppointmentReservations(dbClient, { logger: request.log });
        const idSucursal = assertUuid(request.body?.id_sucursal, "id_sucursal");
        const titularPayload = validateClientPayload(request.body?.titular);
        const integrantes = normalizeBlocksPayload(request.body, titularPayload);
        if (integrantes.length > 5) {
          throw new AppError(400, "Solo se permiten hasta 4 acompañantes por reserva", {
            code: "PUBLIC_CITAS_MAX_COMPANIONS",
            details: { field: "integrantes", maxCompanions: 4 },
          });
        }
        const titularDateTime = parseIsoDateAndTime(integrantes[0]?.fecha_inicio || "");
        const branch = await ensureActiveBranch(dbClient, idSucursal);

        await dbClient.query("BEGIN");

        const clientProfile = await resolveOrCreatePublicClient(dbClient, {
          ...titularPayload,
          idSucursal: branch.id_sucursal,
        });

        const holdDurationMin = await getHoldDurationMinutes(dbClient);
        const expiresAt = new Date(Date.now() + holdDurationMin * 60 * 1000);
        const targetAppointmentState = "en_espera";
        const holdState = "activo";

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
        let subtotalGrupo = 0;
        let descuentoGrupo = 0;
        const promocionesAplicadasGrupo = [];
        const promocionesDescartadasGrupo = [];
        let titularResolved = null;

        for (let index = 0; index < integrantes.length; index += 1) {
          const integrante = integrantes[index];
          const splitDateTime = parseIsoDateAndTime(integrante.fecha_inicio);
          if (index > 0 && splitDateTime.fecha !== titularDateTime.fecha) {
            throw new AppError(409, "Los acompañantes deben agendarse en la misma fecha del titular", {
              code: "PUBLIC_CITAS_COMPANION_DATE_MISMATCH",
              details: { field: "fecha_inicio", alias: integrante.alias, blockIndex: index },
            });
          }
          const selection = await resolveBookingSelection(dbClient, {
            id_sucursal: branch.id_sucursal,
            selection_type: integrante.selection_type,
            servicios: integrante.serviceIds,
            id_paquete: integrante.id_paquete,
            fecha_inicio: integrante.fecha_inicio,
            id_barbero: integrante.id_barbero,
          });
          if (
            index > 0
            && titularResolved
            && splitDateTime.hora
            && splitDateTime.hora === titularResolved.hora
            && selection.barber.id_empleado === titularResolved.id_barbero
          ) {
            throw new AppError(409, "Un acompañante no puede tomar la misma hora del titular con el mismo barbero", {
              code: "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER",
              details: { field: "fecha_inicio", alias: integrante.alias, blockIndex: index },
            });
          }
          if (index === 0) {
            titularResolved = {
              hora: splitDateTime.hora,
              id_barbero: selection.barber.id_empleado,
            };
          }

          const finAt = new Date(selection.startDateTime.getTime() + selection.serviceSelection.duracion_total_min * 60 * 1000);
          const subtotalServicios = Number(selection.serviceSelection.monto_total_hnl || 0);
          let descuentoPromociones = 0;
          let totalPagar = subtotalServicios;
          let promocionesPreview = null;

          try {
            const promoContext = {
              id_sucursal: branch.id_sucursal,
              id_empleado_barbero: selection.barber.id_empleado,
              id_cliente: clientProfile.id_cliente || null,
              id_persona: clientProfile.id_persona || null,
              id_grupo_cita: groupRecord.id_grupo_cita,
              fecha_hora: selection.startDateTime.toISOString(),
              fecha: selection.startDateTime.toISOString().slice(0, 10),
              fecha_operativa: selection.startDateTime.toISOString().slice(0, 10),
              hora: selection.startDateTime.toISOString().slice(11, 16),
              subtotal_hnl: subtotalServicios,
              servicios: selection.serviceSelection.items || [],
              paquetes: selection.serviceSelection.id_paquete
                ? [{ id_paquete: selection.serviceSelection.id_paquete }]
                : [],
              id_promocion: integrante.id_promocion || null,
              id_promocion_regla: integrante.id_promocion_regla || null,
              canal: "public",
              es_cliente_autenticado: Boolean(clientProfile.id_cliente),
              es_titular: index === 0,
            };
            promocionesPreview = await previewPromotionsForAppointment(dbClient, promoContext);
            if (!promocionesPreview.usedFallbackLegacy) {
              if (integrante.id_promocion_regla) {
                const reglaSeleccionada = String(integrante.id_promocion_regla || "");
                const candidatasAplicadas = Array.isArray(promocionesPreview.promociones_aplicadas)
                  ? promocionesPreview.promociones_aplicadas
                  : [];
                const keepApplied = candidatasAplicadas.filter(
                  (row) => String(row.id_promocion_regla || "") === reglaSeleccionada
                );
                const movedToDiscarded = candidatasAplicadas
                  .filter((row) => String(row.id_promocion_regla || "") !== reglaSeleccionada)
                  .map((row) => ({
                    ...row,
                    motivo_codigo: "PROMOCION_NO_SELECCIONADA",
                    motivo: "Se aplico solo la promocion seleccionada por el cliente.",
                  }));
                promocionesPreview.promociones_aplicadas = keepApplied;
                promocionesPreview.promociones_descartadas = [
                  ...(promocionesPreview.promociones_descartadas || []),
                  ...movedToDiscarded,
                ];
                descuentoPromociones = Number(
                  keepApplied.reduce((sum, row) => sum + Number(row.descuento_calculado_hnl || 0), 0).toFixed(2)
                );
              } else {
                descuentoPromociones = Number(promocionesPreview.descuento_total_hnl || 0);
              }
              totalPagar = Math.max(0, Number((subtotalServicios - descuentoPromociones).toFixed(2)));
            }
          } catch (promoError) {
            request.log.warn(
              {
                requestId: request.id,
                id_sucursal: branch.id_sucursal,
                id_grupo_cita: groupRecord.id_grupo_cita,
                code: promoError?.code || null,
                message: promoError?.message || null,
              },
              "No se pudo evaluar promociones normalizadas en hold publico; se continua sin descuento"
            );
          }

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
              selection_type,
              id_paquete,
              contacto_nombre,
              contacto_email,
              contacto_telefono,
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
                $9::text,
                $10::timestamptz,
                $11::timestamptz,
                $12::int,
                $13::int,
                $14::numeric,
                $15::numeric,
                $16::numeric,
                $17::text,
                $18::uuid,
                $19,
                $20,
                $21,
                $22
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
              targetAppointmentState,
              selection.startDateTime.toISOString(),
              finAt.toISOString(),
              selection.serviceSelection.duracion_total_min,
              selection.serviceSelection.buffer_total_min,
              subtotalServicios,
              descuentoPromociones,
              totalPagar,
              selection.serviceSelection.selection_type || integrante.selection_type || "services",
              selection.serviceSelection.id_paquete || integrante.id_paquete || null,
              integrante.contacto?.nombre || integrante.alias,
              integrante.contacto?.email || null,
              integrante.contacto?.telefono || null,
              request.body?.notas ?? null,
            ]
          );

          const citaId = citaInsert.rows[0].id_cita;
          if (promocionesPreview && !promocionesPreview.usedFallbackLegacy) {
            try {
              await recordPromotionApplications(
                dbClient,
                {
                  id_grupo_cita: groupRecord.id_grupo_cita,
                  id_cita: citaId,
                  id_cliente: clientProfile.id_cliente || null,
                  id_persona: clientProfile.id_persona || null,
                  id_sucursal: branch.id_sucursal,
                  fecha_operativa: selection.startDateTime.toISOString().slice(0, 10),
                  subtotal_hnl: subtotalServicios,
                },
                promocionesPreview,
                { formal: false }
              );
            } catch (promoPersistError) {
              request.log.warn(
                {
                  requestId: request.id,
                  id_cita: citaId,
                  id_grupo_cita: groupRecord.id_grupo_cita,
                  code: promoPersistError?.code || null,
                  message: promoPersistError?.message || null,
                },
                "No se pudo registrar trazabilidad de promociones en hold publico; se continua"
              );
            }
          }
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
              VALUES ($1::uuid, NULL, $2::text, $3::timestamptz)
            `,
            [citaId, holdState, expiresAt.toISOString()]
          );

          subtotalGrupo += subtotalServicios;
          descuentoGrupo += descuentoPromociones;
          totalGrupo += totalPagar;
          promocionesAplicadasGrupo.push(...(promocionesPreview?.promociones_aplicadas || []));
          promocionesDescartadasGrupo.push(...(promocionesPreview?.promociones_descartadas || []));
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
            estado_cita_codigo: targetAppointmentState,
            monto_total_hnl: subtotalServicios,
            descuento_hnl: descuentoPromociones,
            total_pagar_hnl: totalPagar,
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
            subtotal_hnl: Number(subtotalGrupo.toFixed(2)),
            descuento_total_hnl: Number(descuentoGrupo.toFixed(2)),
            total_hnl: Number(totalGrupo.toFixed(2)),
            promociones_aplicadas: promocionesAplicadasGrupo,
            promociones_descartadas: promocionesDescartadasGrupo,
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

        if (isAvailabilityConflictError(error)) {
          const reason = resolveSafeConflictReason(error);
          request.log.warn(
            {
              requestId: request.id,
              reason,
              sourceCode: error instanceof AppError ? String(error.code || "") : null,
            },
            "Public hold rejected by agenda conflict"
          );
          return sendError(reply, 409, "La hora seleccionada ya no está disponible.", {
            code: "PUBLIC_CITAS_HOLD_CONFLICT",
            reason,
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

