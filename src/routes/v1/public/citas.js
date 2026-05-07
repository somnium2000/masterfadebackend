import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertUuid,
  expireStaleAppointmentReservations,
  getAgendamientoConfig,
  getSystemParameters,
  parseSinglePackageId,
  parseDateTime,
} from "../../../services/agendaService.js";
import { crearReservaHoldBaseNormalizada } from "../../../services/agendamientoReservaService.js";

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

function normalizePublicParams(paramsMap, agendamientoConfig = null) {
  const hold = paramsMap?.hold_duracion_min?.valor_numero;
  const noShow = paramsMap?.no_show_min?.valor_numero;
  const globalBuffer = paramsMap?.agenda_buffer_global_min?.valor_numero;
  const companions = paramsMap?.permitir_acompanantes?.valor_booleano;
  const fullPayment = paramsMap?.pago_total_obligatorio?.valor_booleano;
  const simulationNoPayment = paramsMap?.simulacion_sin_pago?.valor_booleano;
  const holdTtlMinutos = Number(agendamientoConfig?.holdTtlMinutos);
  const maxAcompanantes = Number(agendamientoConfig?.maxAcompanantes);
  const allowCompanionsFromConfig = Number.isFinite(maxAcompanantes) ? maxAcompanantes > 0 : null;

  return {
    hold_duracion_min: Number.isFinite(holdTtlMinutos)
      ? holdTtlMinutos
      : (Number.isFinite(Number(hold)) ? Number(hold) : 5),
    no_show_min: Number.isFinite(Number(noShow)) ? Number(noShow) : 10,
    agenda_buffer_global_min: Number.isFinite(Number(globalBuffer)) ? Number(globalBuffer) : 0,
    permitir_acompanantes: typeof allowCompanionsFromConfig === "boolean"
      ? allowCompanionsFromConfig
      : (typeof companions === "boolean" ? companions : false),
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
  "id_servicio",
  "maxPromotions",
  "email",
  "rol_integrante_codigo",
  "orden_integrante",
]);

function sanitizePublicCitasErrorDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== "object" || Array.isArray(rawDetails)) return undefined;
  const safeDetails = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!PUBLIC_CITAS_SAFE_DETAIL_KEYS.has(key)) continue;
    if (key === "blockIndex" || key === "maxCompanions" || key === "maxPromotions" || key === "orden_integrante") {
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
    || safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER"
    || safeCode === "SLOT_NOT_AVAILABLE";
}

function resolveSafeConflictReason(error) {
  if (isConflictError(error)) return "DB_CONFLICT";
  if (!(error instanceof AppError)) return "UNKNOWN_CONFLICT";
  const safeCode = String(error.code || "").trim().toUpperCase();
  if (safeCode.startsWith("AGENDA_")) return safeCode;
  if (safeCode === "PUBLIC_CITAS_COMPANION_SAME_HOUR_SAME_BARBER") return safeCode;
  if (safeCode === "SLOT_NOT_AVAILABLE") return safeCode;
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
  const normalizePromotionIds = (rawValue, fieldBase) => {
    const list = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
    const unique = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const safeId = assertUuid(list[i], `${fieldBase}[${i}]`);
      if (safeId) unique.add(safeId);
    }
    return [...unique];
  };

  const rootPromotionIds = normalizePromotionIds(
    [
      ...(body?.promotionId ? [body.promotionId] : []),
      ...(Array.isArray(body?.promotionIds) ? body.promotionIds : []),
    ],
    "promotionIds"
  );

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
    const blockPromotionIds = normalizePromotionIds(
      [
        ...(item?.promotionId ? [item.promotionId] : []),
        ...(Array.isArray(item?.promotionIds) ? item.promotionIds : []),
      ],
      `integrantes[${index}].promotionIds`
    );
    const promotionIds = [...new Set([
      ...(index === 0 ? rootPromotionIds : []),
      ...blockPromotionIds,
    ])];

    const fechaInicio = String(item?.fecha_inicio || "").trim();
    assertDateTimeNotPastInHonduras(fechaInicio, "fecha_inicio");

    return {
      orden_integrante: Number.isFinite(ordenIntegrante) && ordenIntegrante > 0 ? Math.trunc(ordenIntegrante) : index + 1,
      alias,
      id_barbero: item?.id_barbero ? assertUuid(item.id_barbero, "id_barbero") : null,
      selection_type: selectionType,
      id_paquete: packageId,
      promotionIds,
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

  const ensureEmailDoesNotBelongActiveUser = async (correo) => {
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
      [correo]
    );

    if (existingActiveUserByEmailResult.rows[0]) {
      throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar.", {
        code: "EMAIL_BELONGS_TO_ACTIVE_USER",
        details: { field: "titular.email", email: correo },
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
      [correo]
    );

    if (existingUserClientResult.rows[0]) {
      throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar.", {
        code: "EMAIL_BELONGS_TO_ACTIVE_USER",
        details: { field: "titular.email", email: correo },
      });
    }
  };

  await ensureEmailDoesNotBelongActiveUser(email);

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
        const agendamientoConfig = await getAgendamientoConfig(app.db, { logger: request.log });

        const sucursales = branchResult.rows.map((row) => ({
          id_sucursal: row.id_sucursal,
          nombre_sucursal: row.nombre_sucursal || "Sucursal",
        }));

        const parametros = normalizePublicParams(paramsMap, agendamientoConfig);

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
    "/validar-titular",
    {
      schema: {
        body: {
          type: "object",
          required: ["titular"],
          properties: {
            titular: {
              type: "object",
              required: ["nombre", "email", "telefono"],
              properties: {
                nombre: { type: "string", minLength: 1, maxLength: 120 },
                email: { type: "string", format: "email", maxLength: 160 },
                telefono: { type: "string", minLength: 8, maxLength: 20 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const db = app.db;
      if (!db) {
        return sendError(reply, 500, "Base de datos no configurada", {
          code: "DB_NOT_CONFIGURED",
        });
      }
      try {
        const titularPayload = validateClientPayload(request.body?.titular);
        const email = titularPayload.email;

        const activeUserByEmailResult = await db.query(
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
        if (activeUserByEmailResult.rows[0]) {
          throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar.", {
            code: "EMAIL_BELONGS_TO_ACTIVE_USER",
            details: { field: "titular.email", email },
          });
        }

        const activeClientByEmailResult = await db.query(
          `
            SELECT c.id_cliente
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
        if (activeClientByEmailResult.rows[0]) {
          throw new AppError(409, "Este correo ya pertenece a una cuenta activa. Inicia sesion para continuar.", {
            code: "EMAIL_BELONGS_TO_ACTIVE_USER",
            details: { field: "titular.email", email },
          });
        }

        return sendOk(reply, {
          valid: true,
          titular: { email },
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo validar el titular publico", "PUBLIC_CITAS_TITULAR_VALIDATE_ERROR");
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
                  rol_integrante_codigo: { type: "string", enum: ["titular", "acompanante"] },
                  id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  selection_type: { type: "string", enum: ["services", "package", "mixed"] },
                  id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  promotionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
                  promotionIds: {
                    type: "array",
                    items: { type: "string", format: "uuid" },
                  },
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
                },
                additionalProperties: false,
              },
            },
            id_barbero: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            fecha_inicio: { type: "string", format: "date-time" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            id_paquete: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            promotionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
            promotionIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
            },
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
                  subtotal_hnl: { type: "number" },
                  descuento_total_hnl: { type: "number" },
                  total_pagar_hnl: { type: "number" },
                  extras_a_pagar_hnl: { type: "number" },
                  monto_total_hnl: { type: "number" },
                  bloques: { type: "array", items: holdBlockSchema },
                },
                required: [
                  "id_grupo_cita",
                  "estado_grupo_codigo",
                  "expires_at",
                  "subtotal_hnl",
                  "descuento_total_hnl",
                  "total_pagar_hnl",
                  "extras_a_pagar_hnl",
                  "monto_total_hnl",
                  "bloques",
                ],
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
        const agendamientoConfig = await getAgendamientoConfig(dbClient, { logger: request.log });

        const clientProfile = await resolveOrCreatePublicClient(dbClient, {
          ...titularPayload,
          idSucursal,
        });

        const holdResult = await crearReservaHoldBaseNormalizada({
          client: dbClient,
          logger: request.log,
          actor: null,
          titular: {
            id_usuario: null,
            id_persona: clientProfile.id_persona,
            id_cliente: clientProfile.id_cliente,
          },
          integrantes,
          id_sucursal: idSucursal,
          origen_codigo: "publico",
          notas: request.body?.notas ?? null,
          agendamientoConfig,
          hold_state: "activo",
          appointment_state: "en_espera",
        });

        return sendOk(
          reply,
          {
            id_grupo_cita: holdResult.id_grupo_cita,
            estado_grupo_codigo: holdResult.estado_grupo_codigo || "activo",
            expires_at: holdResult.expires_at || null,
            subtotal_hnl: Number(holdResult.subtotal_hnl || 0),
            descuento_total_hnl: Number(holdResult.descuento_total_hnl || 0),
            total_pagar_hnl: Number(holdResult.total_pagar_hnl || 0),
            extras_a_pagar_hnl: Number(holdResult.extras_a_pagar_hnl || 0),
            monto_total_hnl: Number(holdResult.monto_total_hnl || 0),
            bloques: Array.isArray(holdResult.bloques) ? holdResult.bloques : [],
          },
          { statusCode: 201 }
        );
      } catch (error) {
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
          return sendError(reply, 409, "La hora seleccionada ya no esta disponible.", {
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

  app.delete(
    "/hold/:id_grupo_cita",
    {
      schema: {
        params: {
          type: "object",
          required: ["id_grupo_cita"],
          properties: {
            id_grupo_cita: { type: "string", format: "uuid" },
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
                properties: {
                  id_grupo_cita: { type: "string", format: "uuid" },
                  released: { type: "boolean" },
                  estado_grupo_codigo: { anyOf: [{ type: "string" }, { type: "null" }] },
                  citas_liberadas: { type: "integer" },
                },
                required: ["id_grupo_cita", "released", "estado_grupo_codigo", "citas_liberadas"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
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

      const idGrupoCita = assertUuid(request.params?.id_grupo_cita, "id_grupo_cita");
      const dbClient = await app.db.connect();
      try {
        await dbClient.query("BEGIN");
        await expireStaleAppointmentReservations(dbClient, { logger: request.log });

        const groupResult = await dbClient.query(
          `
            SELECT id_grupo_cita, estado_grupo_codigo
            FROM public.citas_grupos
            WHERE id_grupo_cita = $1::uuid
            FOR UPDATE
          `,
          [idGrupoCita]
        );
        const group = groupResult.rows[0] || null;
        if (!group) {
          await dbClient.query("COMMIT");
          return sendOk(reply, {
            id_grupo_cita: idGrupoCita,
            released: true,
            estado_grupo_codigo: null,
            citas_liberadas: 0,
          });
        }

        const blockingStatesResult = await dbClient.query(
          `
            SELECT count(*)::int AS total
            FROM public.citas
            WHERE id_grupo_cita = $1::uuid
              AND estado_cita_codigo IN ('confirmada', 'en_salon', 'en_atencion', 'completada', 'no_show')
          `,
          [idGrupoCita]
        );
        const blockingAppointments = Number(blockingStatesResult.rows?.[0]?.total || 0);
        if (blockingAppointments > 0) {
          await dbClient.query("ROLLBACK");
          return sendError(reply, 409, "No se puede cancelar porque el grupo ya tiene citas confirmadas o en proceso.", {
            code: "PUBLIC_CITAS_HOLD_RELEASE_NOT_ALLOWED",
            requestId: request.id,
          });
        }

        const citasResult = await dbClient.query(
          `
            UPDATE public.citas
            SET estado_cita_codigo = 'cancelada',
                updated_at = now()
            WHERE id_grupo_cita = $1::uuid
              AND estado_cita_codigo IN ('en_espera', 'pendiente_pago')
            RETURNING id_cita
          `,
          [idGrupoCita]
        );
        const citaIds = Array.isArray(citasResult.rows)
          ? citasResult.rows.map((row) => row.id_cita).filter(Boolean)
          : [];

        if (citaIds.length > 0) {
          await dbClient.query(
            `
              UPDATE public.citas_holds
              SET estado_hold_codigo = 'cancelado',
                  updated_at = now()
              WHERE id_cita = ANY($1::uuid[])
                AND estado_hold_codigo = 'activo'
            `,
            [citaIds]
          );
        }

        const nextGroupState = ["cancelada", "confirmada", "completada"].includes(String(group.estado_grupo_codigo || "").trim())
          ? String(group.estado_grupo_codigo || "cancelada").trim()
          : "cancelada";

        await dbClient.query(
          `
            UPDATE public.citas_grupos
            SET estado_grupo_codigo = $2::text,
                updated_at = now()
            WHERE id_grupo_cita = $1::uuid
          `,
          [idGrupoCita, nextGroupState]
        );

        await dbClient.query("COMMIT");
        return sendOk(reply, {
          id_grupo_cita: idGrupoCita,
          released: true,
          estado_grupo_codigo: nextGroupState,
          citas_liberadas: citaIds.length,
        });
      } catch (error) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // no-op
        }
        return sendHandled(reply, request, error, "No se pudo liberar el hold publico", "PUBLIC_CITAS_HOLD_RELEASE_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );
}

