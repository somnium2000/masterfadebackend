import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import { buildAssetReadUrl } from "../../services/storage/storageService.js";

const BARBER_ALLOWED_ROLES = ["barbero", "admin", "super_admin"];
const OPERATIONAL_TIMEZONE = "America/Tegucigalpa";
const PENDING_APPOINTMENT_STATES = ["confirmada", "en_salon", "en_atencion", "en_espera", "pendiente_pago"];

const BARBER_PROFILE_SQL = `
  SELECT
    e.id_empleado,
    e.id_persona,
    u.id_usuario,
    p.nombres,
    p.apellidos,
    p.fecha_nacimiento,
    p.genero_codigo,
    p.dni,
    p.rtn,
    p.telefono_principal,
    p.direccion_texto,
    p.observaciones,
    p.foto_perfil_asset_id,
    p.foto_perfil_path,
    COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS correo_principal,
    e.id_sucursal,
    s.nombre_sucursal,
    e.fecha_ingreso,
    e.salario_base,
    COALESCE(e.estado, TRUE) AS estado_laboral,
    COALESCE(e.es_barbero, FALSE) AS es_barbero,
    COALESCE(u.estado, TRUE) AS estado_usuario,
    COALESCE(u.estado_acceso, 'pendiente_password') AS estado_acceso,
    u.credenciales_completadas_at,
    u.ultimo_login_at,
    COALESCE((
      SELECT array_agg(r.nombre ORDER BY r.nombre)
      FROM public.roles_usuarios ru
      JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = u.id_usuario
        AND ru.activo IS TRUE
    ), ARRAY[]::text[]) AS roles
  FROM public.empleados e
  JOIN public.personas p
    ON p.id_persona = e.id_persona
  JOIN public.usuarios u
    ON u.id_persona = e.id_persona
    AND u.deleted_at IS NULL
  LEFT JOIN auth.users au
    ON au.id = u.id_usuario
  LEFT JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  LEFT JOIN LATERAL (
    SELECT c.direccion_correo::text AS email
    FROM public.correos c
    WHERE c.id_persona = e.id_persona
      AND c.deleted_at IS NULL
    ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
    LIMIT 1
  ) cp ON TRUE
  WHERE e.deleted_at IS NULL
    AND e.estado IS TRUE
    AND e.es_barbero IS TRUE
    AND u.id_usuario = $1::uuid
  LIMIT 1
`;

const BARBER_SUMMARY_SQL = `
  SELECT
    COUNT(*) FILTER (
      WHERE c.estado_cita_codigo = 'completada'
        AND (c.inicio_at AT TIME ZONE '${OPERATIONAL_TIMEZONE}')::date = $2::date
    )::int AS citas_completadas_hoy,
    COUNT(*) FILTER (
      WHERE c.estado_cita_codigo = ANY($3::text[])
        AND (c.inicio_at AT TIME ZONE '${OPERATIONAL_TIMEZONE}')::date = $2::date
    )::int AS citas_activas_hoy
  FROM public.citas c
  WHERE c.id_empleado_barbero = $1::uuid
    AND c.deleted_at IS NULL
`;

const BARBER_OFFERED_SERVICES_SQL = `
  WITH active_tariffs AS (
    SELECT
      st.id_servicio,
      st.id_tarifa,
      st.precio_hnl,
      st.duracion_min,
      st.buffer_min,
      COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio
        ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    WHERE st.id_empleado = $1::uuid
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
  )
  SELECT
    s.id_servicio,
    COALESCE(NULLIF(TRIM(s.nombre_servicio), ''), 'Servicio') AS nombre_servicio,
    at.precio_hnl,
    COALESCE(at.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(at.buffer_min, s.buffer_min, 0) AS buffer_min,
    COALESCE(at.servicio_informativo, FALSE) AS servicio_informativo
  FROM active_tariffs at
  JOIN public.servicios s
    ON s.id_servicio = at.id_servicio
  WHERE at.rn = 1
    AND s.deleted_at IS NULL
    AND s.activo IS TRUE
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC
`;

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
    details: error instanceof Error ? error.message : "Unknown barber profile error",
    requestId: request.id,
  });
}

function extractPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return "";
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  const normalized = extractPlainText(value);
  return normalized || null;
}

function normalizeOptionalDigits(value, field) {
  if (value === undefined) return undefined;
  const normalized = String(value ?? "").replace(/\D/g, "");
  if (!normalized) return null;
  if (normalized.length > 32) {
    throw new AppError(422, `${field} excede la longitud permitida`, {
      code: "BARBER_PROFILE_DIGITS_TOO_LONG",
      details: { field },
    });
  }
  return normalized;
}

function normalizeDateOnly(value) {
  if (value === undefined) return undefined;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "fecha_nacimiento invalida", {
      code: "BARBER_PROFILE_DATE_INVALID",
    });
  }
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (parsed.getTime() > todayUtc) {
    throw new AppError(400, "fecha_nacimiento no puede estar en el futuro", {
      code: "BARBER_PROFILE_DATE_FUTURE",
    });
  }
  return raw;
}

async function resolveGeneroCodigoForUpdate(client, rawGeneroInput) {
  if (rawGeneroInput === undefined) return undefined;
  if (rawGeneroInput === null) return null;

  const normalizedGenero = normalizeOptionalText(rawGeneroInput);
  if (!normalizedGenero) return null;

  const aliases = new Map([
    ["masculino", "M"],
    ["femenino", "F"],
    ["prefiero_no_decir", "N"],
    ["prefiere no decir", "N"],
    ["no_binario", "NB"],
    ["no binario", "NB"],
    ["otro", "O"],
  ]);

  const aliasResolved = aliases.get(normalizedGenero.toLowerCase());
  const generoCandidate = aliasResolved || normalizedGenero;

  const { rows } = await client.query(
    `
      SELECT genero_codigo
      FROM public.generos
      WHERE UPPER(genero_codigo) = UPPER($1)
         OR LOWER(descripcion) = LOWER($1)
      LIMIT 1
    `,
    [generoCandidate]
  );

  const matchedCode = rows?.[0]?.genero_codigo ? String(rows[0].genero_codigo).trim() : "";
  if (!matchedCode) {
    throw new AppError(422, "Genero invalido. Usa un valor permitido.", {
      code: "BARBER_PROFILE_GENERO_INVALID",
      details: { input: normalizedGenero },
    });
  }

  return matchedCode;
}

function getCurrentDateInTimeZone(timeZone = OPERATIONAL_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function mapBarberProfile(row, fotoPerfilSignedUrl) {
  return {
    id_empleado: row.id_empleado,
    id_persona: row.id_persona,
    id_usuario: row.id_usuario,
    nombres: row.nombres ?? "",
    apellidos: row.apellidos ?? "",
    nombre_completo: `${String(row.nombres ?? "").trim()} ${String(row.apellidos ?? "").trim()}`.trim(),
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    genero_codigo: row.genero_codigo ?? null,
    dni: row.dni ?? null,
    rtn: row.rtn ?? null,
    telefono_principal: row.telefono_principal ?? null,
    direccion_texto: row.direccion_texto ?? null,
    observaciones: row.observaciones ?? null,
    foto_perfil_asset_id: row.foto_perfil_asset_id ?? null,
    foto_perfil_path: row.foto_perfil_path ?? null,
    foto_perfil_signed_url: fotoPerfilSignedUrl ?? null,
    correo_principal: row.correo_principal ?? null,
    id_sucursal: row.id_sucursal ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
    fecha_ingreso: row.fecha_ingreso ?? null,
    salario_base: row.salario_base == null ? null : Number(row.salario_base),
    estado_laboral: Boolean(row.estado_laboral),
    es_barbero: Boolean(row.es_barbero),
    estado_usuario: Boolean(row.estado_usuario),
    estado_acceso: row.estado_acceso ?? "pendiente_password",
    credenciales_completadas_at: row.credenciales_completadas_at ?? null,
    ultimo_login_at: row.ultimo_login_at ?? null,
    roles: Array.isArray(row.roles) ? row.roles : [],
  };
}

function mapOfferedServiceRow(row) {
  return {
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    duracion_min: Number(row.duracion_min ?? 0),
    buffer_min: Number(row.buffer_min ?? 0),
    servicio_informativo: Boolean(row.servicio_informativo),
  };
}

async function buildBarberProfilePayload(app, request, userId) {
  const operationalDate = getCurrentDateInTimeZone();
  if (!userId || !operationalDate) {
    throw new AppError(500, "No se pudo resolver el contexto del perfil del barbero", {
      code: "BARBER_PROFILE_CONTEXT_ERROR",
    });
  }

  const { rows } = await app.db.query(BARBER_PROFILE_SQL, [userId]);
  if (!rows.length) {
    throw new AppError(404, "No se encontro un perfil activo de barbero para este usuario", {
      code: "BARBER_PROFILE_NOT_FOUND",
    });
  }

  const baseProfile = rows[0];
  const [summaryResult, offeredServicesResult] = await Promise.all([
    app.db.query(BARBER_SUMMARY_SQL, [
      baseProfile.id_empleado,
      operationalDate,
      PENDING_APPOINTMENT_STATES,
    ]),
    app.db.query(BARBER_OFFERED_SERVICES_SQL, [baseProfile.id_empleado]),
  ]);

  let fotoPerfilSignedUrl = null;
  if (baseProfile.foto_perfil_asset_id) {
    try {
      const readUrl = await buildAssetReadUrl(app, {
        claims: request.claims,
        assetId: baseProfile.foto_perfil_asset_id,
      });
      fotoPerfilSignedUrl = readUrl?.url ?? null;
    } catch (error) {
      request.log.warn(
        {
          err: error,
          id_empleado: baseProfile.id_empleado,
          id_asset: baseProfile.foto_perfil_asset_id,
        },
        "No se pudo generar la signed URL de la foto del barbero"
      );
    }
  }

  const offeredServices = offeredServicesResult.rows.map(mapOfferedServiceRow);

  return {
    perfil: mapBarberProfile(baseProfile, fotoPerfilSignedUrl),
    resumen: {
      citas_completadas_hoy: Number(summaryResult.rows[0]?.citas_completadas_hoy ?? 0),
      citas_activas_hoy: Number(summaryResult.rows[0]?.citas_activas_hoy ?? 0),
      servicios_ofrecidos_total: offeredServices.length,
      fecha_operativa: operationalDate,
    },
    servicios_ofrecidos: offeredServices,
  };
}

export default async function barberoRoutes(app) {
  app.get("/perfil", { preHandler: app.requireRoles(BARBER_ALLOWED_ROLES) }, async (request, reply) => {
    try {
      const userId = request.claims?.user?.id_usuario;
      const payload = await buildBarberProfilePayload(app, request, userId);
      return sendOk(reply, payload, { requestId: request.id });
    } catch (error) {
      return sendHandled(reply, request, error, "No se pudo consultar el perfil del barbero", "BARBER_PROFILE_GET_ERROR");
    }
  });

  app.patch(
    "/perfil",
    {
      preHandler: app.requireRoles(BARBER_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            telefono_principal: { type: ["string", "null"], maxLength: 40 },
            fecha_nacimiento: { type: ["string", "null"], format: "date" },
            genero_codigo: { type: ["string", "null"], maxLength: 40 },
            dni: { type: ["string", "null"], maxLength: 32 },
            rtn: { type: ["string", "null"], maxLength: 32 },
            direccion_texto: { type: ["string", "null"], maxLength: 300 },
            observaciones: { type: ["string", "null"], maxLength: 1000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body || {};
      const userId = request.claims?.user?.id_usuario;
      const hasAnyPatch = [
        "telefono_principal",
        "fecha_nacimiento",
        "genero_codigo",
        "dni",
        "rtn",
        "direccion_texto",
        "observaciones",
      ].some((key) => Object.prototype.hasOwnProperty.call(body, key));

      if (!hasAnyPatch) {
        return sendError(reply, 400, "No hay cambios para actualizar en el perfil", {
          code: "BARBER_PROFILE_PATCH_EMPTY",
          requestId: request.id,
        });
      }

      const client = await app.db.connect();
      let transactionStarted = false;
      try {
        const { rows } = await client.query(BARBER_PROFILE_SQL, [userId]);
        if (!rows.length) {
          throw new AppError(404, "No se encontro un perfil activo de barbero para este usuario", {
            code: "BARBER_PROFILE_NOT_FOUND",
          });
        }

        const current = rows[0];
        const nextTelefono = Object.prototype.hasOwnProperty.call(body, "telefono_principal")
          ? normalizeOptionalText(body.telefono_principal)
          : current.telefono_principal;
        const nextFechaNacimiento = Object.prototype.hasOwnProperty.call(body, "fecha_nacimiento")
          ? normalizeDateOnly(body.fecha_nacimiento)
          : current.fecha_nacimiento;
        const nextGenero = Object.prototype.hasOwnProperty.call(body, "genero_codigo")
          ? await resolveGeneroCodigoForUpdate(client, body.genero_codigo)
          : current.genero_codigo;
        const nextDni = Object.prototype.hasOwnProperty.call(body, "dni")
          ? normalizeOptionalDigits(body.dni, "dni")
          : current.dni;
        const nextRtn = Object.prototype.hasOwnProperty.call(body, "rtn")
          ? normalizeOptionalDigits(body.rtn, "rtn")
          : current.rtn;
        const nextDireccion = Object.prototype.hasOwnProperty.call(body, "direccion_texto")
          ? normalizeOptionalText(body.direccion_texto)
          : current.direccion_texto;
        const nextObservaciones = Object.prototype.hasOwnProperty.call(body, "observaciones")
          ? normalizeOptionalText(body.observaciones)
          : current.observaciones;

        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(
          `
            UPDATE public.personas
            SET telefono_principal = $2,
                fecha_nacimiento = $3::date,
                genero_codigo = $4,
                dni = $5,
                rtn = $6,
                direccion_texto = $7,
                observaciones = $8,
                updated_at = NOW()
            WHERE id_persona = $1::uuid
          `,
          [
            current.id_persona,
            nextTelefono,
            nextFechaNacimiento,
            nextGenero,
            nextDni,
            nextRtn,
            nextDireccion,
            nextObservaciones,
          ]
        );
        await client.query("COMMIT");
        transactionStarted = false;

        const payload = await buildBarberProfilePayload(app, request, userId);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        if (transactionStarted) {
          await client.query("ROLLBACK").catch(() => {});
        }
        return sendHandled(reply, request, error, "No se pudo actualizar el perfil del barbero", "BARBER_PROFILE_PATCH_ERROR");
      } finally {
        client.release();
      }
    }
  );
}
