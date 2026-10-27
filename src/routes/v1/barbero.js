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
    sa.updated_at AS foto_perfil_updated_at,
    CASE
      WHEN sa.visibility = 'public' THEN COALESCE(sa.public_url, NULL)
      ELSE NULL
    END AS foto_perfil_url,
    COALESCE(NULLIF(cp.email, ''), NULLIF(au.email::text, '')) AS correo_principal,
    e.id_sucursal,
    s.nombre_sucursal,
    e.fecha_ingreso,
    e.salario_base,
    COALESCE(e.estado, TRUE) AS estado_laboral,
    COALESCE(e.es_barbero, FALSE) AS es_barbero,
    bpp.alias_publico,
    bpp.resumen_publico,
    COALESCE(bpp.certificaciones_titulos, ARRAY[]::text[]) AS certificaciones_titulos,
    COALESCE(bpp.visible_en_landing, FALSE) AS visible_en_landing,
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
  LEFT JOIN public.barberos_perfiles_publicos bpp
    ON bpp.id_empleado = e.id_empleado
    AND bpp.deleted_at IS NULL
  LEFT JOIN public.storage_assets sa
    ON sa.id_asset = p.foto_perfil_asset_id
    AND sa.deleted_at IS NULL
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

function normalizeProfilePhone(value) {
  const raw = String(value ?? "").trim();
  // AM: Conserva el mínimo de ocho dígitos y normalización internacional del contacto existente.
  const normalized = raw.replace(/[()\s.-]/g, "");
  if (!/^[+()\s.\d-]+$/.test(raw) || !/^\+?\d{8,20}$/.test(normalized) || normalized.length > 20) {
    throw new AppError(422, "El telefono principal es obligatorio y debe tener un formato valido", {
      code: "BARBER_PROFILE_PHONE_INVALID",
    });
  }
  return normalized;
}

function normalizeDateOnly(value) {
  if (value === undefined) return undefined;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new AppError(400, "fecha_nacimiento invalida", {
      code: "BARBER_PROFILE_DATE_INVALID",
    });
  }
  if (raw > getCurrentDateInTimeZone()) {
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
    foto_perfil_updated_at: row.foto_perfil_updated_at ?? null,
    foto_perfil_url: row.foto_perfil_url ?? null,
    foto_perfil_signed_url: fotoPerfilSignedUrl ?? null,
    correo_principal: row.correo_principal ?? null,
    id_sucursal: row.id_sucursal ?? null,
    nombre_sucursal: row.nombre_sucursal ?? null,
    fecha_ingreso: row.fecha_ingreso ?? null,
    salario_base: row.salario_base == null ? null : Number(row.salario_base),
    estado_laboral: Boolean(row.estado_laboral),
    es_barbero: Boolean(row.es_barbero),
    alias_publico: row.alias_publico ?? null,
    resumen_publico: row.resumen_publico ?? null,
    certificaciones_titulos: Array.isArray(row.certificaciones_titulos) ? row.certificaciones_titulos : [],
    visible_en_landing: Boolean(row.visible_en_landing),
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

async function buildBarberProfilePayload(app, request, userId, db = app.db) {
  const operationalDate = getCurrentDateInTimeZone();
  if (!userId || !operationalDate) {
    throw new AppError(500, "No se pudo resolver el contexto del perfil del barbero", {
      code: "BARBER_PROFILE_CONTEXT_ERROR",
    });
  }

  const { rows } = await db.query(BARBER_PROFILE_SQL, [userId]);
  if (!rows.length) {
    throw new AppError(404, "No se encontro un perfil activo de barbero para este usuario", {
      code: "BARBER_PROFILE_NOT_FOUND",
    });
  }

  const baseProfile = rows[0];
  const [summaryResult, offeredServicesResult] = await Promise.all([
    db.query(BARBER_SUMMARY_SQL, [
      baseProfile.id_empleado,
      operationalDate,
      PENDING_APPOINTMENT_STATES,
    ]),
    db.query(BARBER_OFFERED_SERVICES_SQL, [baseProfile.id_empleado]),
  ]);

  let fotoPerfilSignedUrl = null;
  if (!baseProfile.foto_perfil_url && baseProfile.foto_perfil_asset_id) {
    try {
      const readUrl = await buildAssetReadUrl(app, {
        claims: request.claims,
        assetId: baseProfile.foto_perfil_asset_id,
      });
      fotoPerfilSignedUrl = readUrl?.url ?? null;
    } catch {
      fotoPerfilSignedUrl = null;
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
      preValidation: async (request) => {
        // AM: Rechaza explícitamente campos ajenos antes de que AJV elimine propiedades adicionales.
        const allowed = new Set(["telefono_principal", "fecha_nacimiento", "genero_codigo", "direccion_texto"]);
        if (Object.keys(request.body || {}).some((key) => !allowed.has(key))) {
          throw new AppError(400, "Solo puedes editar telefono, fecha de nacimiento, genero y direccion", {
            code: "BARBER_PROFILE_FIELDS_FORBIDDEN",
          });
        }
      },
      schema: {
        body: {
          type: "object",
          properties: {
            telefono_principal: { type: ["string", "null"], maxLength: 40 },
            fecha_nacimiento: { type: ["string", "null"], format: "date" },
            genero_codigo: { type: ["string", "null"], maxLength: 40 },
            direccion_texto: { type: ["string", "null"], maxLength: 300 },
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
        "direccion_texto",
      ].some((key) => Object.prototype.hasOwnProperty.call(body, key));

      if (!hasAnyPatch) {
        return sendError(reply, 400, "No hay cambios para actualizar en el perfil", {
          code: "BARBER_PROFILE_PATCH_EMPTY",
          requestId: request.id,
        });
      }

      let client;
      let releaseError;
      let transactionStarted = false;
      try {
        client = await app.db.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const { rows } = await client.query(`${BARBER_PROFILE_SQL}\n FOR UPDATE OF e, p, u`, [userId]);
        if (!rows.length) {
          throw new AppError(404, "No se encontro un perfil activo de barbero para este usuario", {
            code: "BARBER_PROFILE_NOT_FOUND",
          });
        }

        const current = rows[0];
        const assignments = [];
        const params = [current.id_persona];
        for (const field of ["telefono_principal", "fecha_nacimiento", "genero_codigo", "direccion_texto"]) {
          if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
          const value = field === "telefono_principal" ? normalizeProfilePhone(body[field])
            : field === "fecha_nacimiento" ? normalizeDateOnly(body[field])
              : field === "genero_codigo" ? await resolveGeneroCodigoForUpdate(client, body[field])
                : normalizeOptionalText(body[field]);
          params.push(value);
          assignments.push(`${field} = $${params.length}${field === "fecha_nacimiento" ? "::date" : ""}`);
        }
        // AM: Cada PATCH escribe solamente sus campos; las identidades quedan bloqueadas hasta COMMIT.
        const updated = await client.query(
          `
            UPDATE public.personas
            SET ${assignments.join(", ")},
                updated_at = NOW()
            WHERE id_persona = $1::uuid
          `,
          params
        );
        if (updated.rowCount !== 1) throw new AppError(404, "No se encontro el perfil para actualizar", { code: "BARBER_PROFILE_NOT_FOUND" });

        // AM: La respuesta se prepara en la misma transacción; no hay lecturas que fallen tras confirmar.
        const payload = await buildBarberProfilePayload(app, request, userId, client);
        await client.query("COMMIT");
        transactionStarted = false;
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        if (transactionStarted) {
          // AM: Un cliente cuyo ROLLBACK falla no debe regresar disponible al pool.
          await client.query("ROLLBACK").catch((rollbackError) => { releaseError = rollbackError; });
        }
        const code = String(error?.code || "");
        if (code.startsWith("08") || code === "57P01") releaseError = error;
        const controlled = code === "23505" ? new AppError(409, "Existe un dato duplicado. Revisa el perfil.", { code: "BARBER_PROFILE_CONFLICT" })
          : ["23514", "23502", "23503", "22001", "22007", "22008", "22P02"].includes(code) ? new AppError(422, "Los datos no cumplen las reglas del perfil. Revisa los valores.", { code: "BARBER_PROFILE_CONSTRAINT" })
            : ["40001", "40P01"].includes(code) ? new AppError(409, "El perfil cambio durante la operacion. Intenta nuevamente.", { code: "BARBER_PROFILE_CONCURRENT_UPDATE" })
              : code.startsWith("08") || code === "57P01" ? new AppError(503, "No se pudo guardar el perfil. Intenta nuevamente.", { code: "BARBER_PROFILE_UNAVAILABLE" })
                : error;
        return sendHandled(reply, request, controlled, "No se pudo actualizar el perfil del barbero", "BARBER_PROFILE_PATCH_ERROR");
      } finally {
        client?.release(releaseError);
      }
    }
  );
}
