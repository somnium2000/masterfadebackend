import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const SUPER_ADMIN_ALLOWED_ROLES = ["super_admin"];
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

const optionalQuerySchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

const NOTIFICATION_PARAM_DEFS = {
  email_habilitado: {
    clave: "notificaciones_email_habilitadas",
    type: "boolean",
    defaultValue: true,
    descripcion: "Habilita o deshabilita el envio general de notificaciones por email",
  },
  reintentos_max: {
    clave: "notificaciones_email_reintentos_max",
    type: "number",
    defaultValue: 3,
    descripcion: "Cantidad maxima de reintentos para notificaciones fallidas por email",
  },
  reintento_delay_min: {
    clave: "notificaciones_email_reintento_delay_min",
    type: "number",
    defaultValue: 10,
    descripcion: "Minutos de espera antes de reintentar una notificacion por email",
  },
};

const COMMUNICATION_PARAM_DEFS = {
  marketing_habilitado: {
    clave: "comunicaciones_marketing_habilitadas",
    type: "boolean",
    defaultValue: true,
    descripcion: "Permite comunicaciones promocionales para clientes con consentimiento",
  },
  requiere_consentimiento: {
    clave: "comunicaciones_requiere_consentimiento",
    type: "boolean",
    defaultValue: true,
    descripcion: "Requiere consentimiento explicito para enviar comunicaciones promocionales",
  },
  max_promos_semana: {
    clave: "comunicaciones_max_promos_semana",
    type: "number",
    defaultValue: 3,
    descripcion: "Cantidad maxima de comunicaciones promocionales por semana",
  },
};

const BASE_PARAMETER_DEFS = {
  moneda_default: {
    clave: "moneda_default",
    type: "text",
    defaultValue: "HNL",
    descripcion: "Codigo de moneda predeterminada del sistema",
  },
  hold_minutos: {
    clave: "hold_minutos",
    type: "number",
    defaultValue: 5,
    descripcion: "Minutos de vigencia de hold temporal",
  },
  buffer_servicio_minutos: {
    clave: "buffer_servicio_minutos",
    type: "number",
    defaultValue: 5,
    descripcion: "Buffer base en minutos entre servicios",
  },
  no_show_min: {
    clave: "no_show_min",
    type: "number",
    defaultValue: 10,
    descripcion: "Minutos de tolerancia para marcar no show",
  },
};

const PROMOTION_STATES = ["borrador", "publicada", "archivada"];
const PROMOTION_CTA_TYPES = ["interno", "externo", "none"];

const promotionParagraphSchema = {
  type: "array",
  maxItems: 8,
  items: { type: "string", minLength: 1, maxLength: 420 },
};

const promotionBodySchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    slug: { type: "string", minLength: 3, maxLength: 140 },
    titulo: { type: "string", minLength: 3, maxLength: 120 },
    subtitulo: { type: ["string", "null"], maxLength: 180 },
    parrafos: promotionParagraphSchema,
    imagen_principal_url: { type: ["string", "null"], maxLength: 500 },
    imagen_mobile_url: { type: ["string", "null"], maxLength: 500 },
    imagen_alt: { type: ["string", "null"], maxLength: 180 },
    cta_texto: { type: ["string", "null"], maxLength: 80 },
    cta_url: { type: ["string", "null"], maxLength: 500 },
    cta_tipo: { type: "string", enum: PROMOTION_CTA_TYPES },
    estado: { type: "string", enum: PROMOTION_STATES },
    visible_publico: { type: "boolean" },
    vigencia_desde: { type: ["string", "null"], format: "date" },
    vigencia_hasta: { type: ["string", "null"], format: "date" },
    orden_visual: { type: "integer", minimum: 0 },
    destacada: { type: "boolean" },
  },
  required: ["id_sucursal", "titulo"],
  additionalProperties: false,
};

const promotionPatchSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    slug: { type: "string", minLength: 3, maxLength: 140 },
    titulo: { type: "string", minLength: 3, maxLength: 120 },
    subtitulo: { type: ["string", "null"], maxLength: 180 },
    parrafos: promotionParagraphSchema,
    imagen_principal_url: { type: ["string", "null"], maxLength: 500 },
    imagen_mobile_url: { type: ["string", "null"], maxLength: 500 },
    imagen_alt: { type: ["string", "null"], maxLength: 180 },
    cta_texto: { type: ["string", "null"], maxLength: 80 },
    cta_url: { type: ["string", "null"], maxLength: 500 },
    cta_tipo: { type: "string", enum: PROMOTION_CTA_TYPES },
    estado: { type: "string", enum: PROMOTION_STATES },
    visible_publico: { type: "boolean" },
    vigencia_desde: { type: ["string", "null"], format: "date" },
    vigencia_hasta: { type: ["string", "null"], format: "date" },
    orden_visual: { type: "integer", minimum: 0 },
    destacada: { type: "boolean" },
  },
  required: ["id_sucursal"],
  minProperties: 2,
  additionalProperties: false,
};

function normalizeRequiredText(value, fieldName) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new AppError(400, `El campo ${fieldName} es requerido`, {
      code: "CONFIG_VALIDATION_REQUIRED",
      details: { field: fieldName },
    });
  }
  return trimmed;
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function mapRowsByKey(rows = []) {
  return new Map(rows.map((row) => [row.clave, row]));
}

function resolveParamValue(row, descriptor) {
  if (!row) return descriptor.defaultValue;
  if (descriptor.type === "boolean") {
    if (row.valor_booleano === null || row.valor_booleano === undefined) return descriptor.defaultValue;
    return Boolean(row.valor_booleano);
  }
  if (descriptor.type === "number") {
    if (row.valor_numero === null || row.valor_numero === undefined) return descriptor.defaultValue;
    const parsed = Number(row.valor_numero);
    return Number.isFinite(parsed) ? parsed : descriptor.defaultValue;
  }
  if (descriptor.type === "text") {
    const text = String(row.valor_texto || "").trim();
    return text || descriptor.defaultValue;
  }
  return descriptor.defaultValue;
}

function buildParamPayload(descriptor, value) {
  if (descriptor.type === "boolean") {
    return { valor_texto: null, valor_numero: null, valor_booleano: Boolean(value) };
  }
  if (descriptor.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new AppError(400, "El valor numerico del parametro no es valido", {
        code: "CONFIG_PARAMETER_NUMBER_INVALID",
      });
    }
    return { valor_texto: null, valor_numero: parsed, valor_booleano: null };
  }
  const text = String(value || "").trim();
  if (!text) {
    throw new AppError(400, "El valor de texto del parametro es requerido", {
      code: "CONFIG_PARAMETER_TEXT_REQUIRED",
    });
  }
  return { valor_texto: text, valor_numero: null, valor_booleano: null };
}

function descriptorKeys(defs) {
  return Object.values(defs).map((entry) => entry.clave);
}

async function readSystemParameters(client, definitions) {
  const keys = descriptorKeys(definitions);
  const { rows } = await client.query(
    `
      SELECT clave, valor_texto, valor_numero, valor_booleano
      FROM public.parametros_sistema
      WHERE clave = ANY($1::text[])
    `,
    [keys]
  );

  const rowsByKey = mapRowsByKey(rows);
  const payload = {};
  for (const [field, descriptor] of Object.entries(definitions)) {
    payload[field] = resolveParamValue(rowsByKey.get(descriptor.clave), descriptor);
  }
  return payload;
}

async function readBranchParameters(client, idSucursal, definitions) {
  if (!idSucursal) return null;
  const keys = descriptorKeys(definitions);
  const { rows } = await client.query(
    `
      SELECT clave, valor_texto, valor_numero, valor_booleano
      FROM public.parametros_sucursal
      WHERE id_sucursal = $1::uuid
        AND clave = ANY($2::text[])
    `,
    [idSucursal, keys]
  );

  const rowsByKey = mapRowsByKey(rows);
  const payload = {};
  for (const [field, descriptor] of Object.entries(definitions)) {
    payload[field] = resolveParamValue(rowsByKey.get(descriptor.clave), descriptor);
  }
  return payload;
}

async function upsertSystemParameter(client, descriptor, value) {
  const mapped = buildParamPayload(descriptor, value);
  await client.query(
    `
      INSERT INTO public.parametros_sistema (
        clave,
        valor_texto,
        valor_numero,
        valor_booleano,
        descripcion,
        updated_at
      )
      VALUES ($1, $2, $3::numeric, $4::boolean, $5, NOW())
      ON CONFLICT (clave)
      DO UPDATE SET
        valor_texto = EXCLUDED.valor_texto,
        valor_numero = EXCLUDED.valor_numero,
        valor_booleano = EXCLUDED.valor_booleano,
        descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
        updated_at = NOW()
    `,
    [descriptor.clave, mapped.valor_texto, mapped.valor_numero, mapped.valor_booleano, descriptor.descripcion || null]
  );
}

async function upsertBranchParameter(client, idSucursal, descriptor, value) {
  const mapped = buildParamPayload(descriptor, value);
  await client.query(
    `
      INSERT INTO public.parametros_sucursal (
        id_sucursal,
        clave,
        valor_texto,
        valor_numero,
        valor_booleano,
        descripcion,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4::numeric, $5::boolean, $6, NOW())
      ON CONFLICT (id_sucursal, clave)
      DO UPDATE SET
        valor_texto = EXCLUDED.valor_texto,
        valor_numero = EXCLUDED.valor_numero,
        valor_booleano = EXCLUDED.valor_booleano,
        descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sucursal.descripcion),
        updated_at = NOW()
    `,
    [idSucursal, descriptor.clave, mapped.valor_texto, mapped.valor_numero, mapped.valor_booleano, descriptor.descripcion || null]
  );
}

async function ensureBranchExists(client, idSucursal) {
  if (!idSucursal) return null;
  const { rowCount } = await client.query(
    `
      SELECT 1
      FROM public.sucursales
      WHERE id_sucursal = $1::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [idSucursal]
  );
  if (!rowCount) {
    throw new AppError(404, "La sucursal indicada no existe o no esta disponible", {
      code: "CONFIG_BRANCH_NOT_FOUND",
    });
  }
  return idSucursal;
}

async function getProfileRow(client, userId) {
  const { rows } = await client.query(
    `
      SELECT
        u.id_usuario,
        u.id_persona,
        u.estado_acceso,
        u.ultimo_login_at,
        p.nombres,
        p.apellidos,
        p.telefono_principal,
        p.direccion_texto,
        p.observaciones,
        COALESCE(correo_principal.direccion_correo::text, auth_user.email::text, '') AS email
      FROM public.usuarios u
      LEFT JOIN public.personas p ON p.id_persona = u.id_persona
      LEFT JOIN auth.users auth_user ON auth_user.id = u.id_usuario
      LEFT JOIN LATERAL (
        SELECT c.direccion_correo
        FROM public.correos c
        WHERE c.id_persona = u.id_persona
          AND c.deleted_at IS NULL
        ORDER BY c.es_principal DESC NULLS LAST, c.verificado DESC NULLS LAST, c.id_correo ASC
        LIMIT 1
      ) correo_principal ON TRUE
      WHERE u.id_usuario = $1::uuid
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [userId]
  );
  return rows[0] ?? null;
}

function mapProfileRow(row) {
  return {
    id_usuario: row.id_usuario,
    id_persona: row.id_persona ?? null,
    email: String(row.email || "").trim() || null,
    nombres: row.nombres ?? "",
    apellidos: row.apellidos ?? "",
    telefono_principal: row.telefono_principal ?? null,
    direccion_texto: row.direccion_texto ?? null,
    observaciones: row.observaciones ?? null,
    estado_acceso: row.estado_acceso ?? null,
    ultimo_login_at: row.ultimo_login_at ?? null,
  };
}

async function buildNotificationsPayload(client, limit = 20) {
  const configuracion = await readSystemParameters(client, NOTIFICATION_PARAM_DEFS);

  const statsResult = await client.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE enviado_en IS NOT NULL)::int AS enviadas,
        COUNT(*) FILTER (
          WHERE enviado_en IS NULL
            AND (COALESCE(estado_notificacion_codigo, '') NOT IN ('error', 'fallido', 'failed'))
        )::int AS pendientes,
        COUNT(*) FILTER (
          WHERE COALESCE(estado_notificacion_codigo, '') IN ('error', 'fallido', 'failed')
            OR ultimo_error IS NOT NULL
        )::int AS fallidas
      FROM public.notificaciones_email
    `
  );

  const estadosResult = await client.query(
    `
      SELECT
        COALESCE(estado_notificacion_codigo, 'sin_estado') AS estado,
        COUNT(*)::int AS total
      FROM public.notificaciones_email
      GROUP BY 1
      ORDER BY total DESC, estado ASC
    `
  );

  const recentResult = await client.query(
    `
      SELECT
        id_notificacion,
        evento,
        correo_destino::text AS correo_destino,
        asunto,
        estado_notificacion_codigo,
        enviar_en,
        enviado_en,
        ultimo_error,
        created_at
      FROM public.notificaciones_email
      ORDER BY created_at DESC
      LIMIT $1::int
    `,
    [limit]
  );

  return {
    configuracion,
    resumen: statsResult.rows[0] || { total: 0, enviadas: 0, pendientes: 0, fallidas: 0 },
    estados: estadosResult.rows.map((row) => ({ estado: row.estado, total: Number(row.total || 0) })),
    recientes: recentResult.rows.map((row) => ({
      id_notificacion: row.id_notificacion,
      evento: row.evento ?? "sin_evento",
      correo_destino: row.correo_destino ?? null,
      asunto: row.asunto ?? null,
      estado_notificacion_codigo: row.estado_notificacion_codigo ?? null,
      enviar_en: row.enviar_en ?? null,
      enviado_en: row.enviado_en ?? null,
      ultimo_error: row.ultimo_error ?? null,
      created_at: row.created_at ?? null,
    })),
  };
}

async function buildCommunicationPayload(client, idSucursal) {
  const branchId = idSucursal ? await ensureBranchExists(client, idSucursal) : null;
  const reglasSistema = await readSystemParameters(client, COMMUNICATION_PARAM_DEFS);
  const reglasSucursal = await readBranchParameters(client, branchId, COMMUNICATION_PARAM_DEFS);

  const statsResult = await client.query(
    `
      SELECT
        COUNT(*)::int AS total_clientes,
        COUNT(*) FILTER (WHERE COALESCE(estado, TRUE) IS TRUE)::int AS clientes_activos,
        COUNT(*) FILTER (WHERE COALESCE(consentimiento_marketing, FALSE) IS TRUE)::int AS consentimiento_marketing_si,
        COUNT(*) FILTER (WHERE COALESCE(consentimiento_marketing, FALSE) IS FALSE)::int AS consentimiento_marketing_no,
        COUNT(*) FILTER (WHERE COALESCE(acepta_terminos, FALSE) IS TRUE)::int AS acepta_terminos_si,
        COUNT(*) FILTER (WHERE COALESCE(acepta_terminos, FALSE) IS FALSE)::int AS acepta_terminos_no
      FROM public.clientes
      WHERE deleted_at IS NULL
    `
  );

  return {
    id_sucursal: branchId,
    reglas_sistema: reglasSistema,
    reglas_sucursal: reglasSucursal,
    consentimientos: statsResult.rows[0] || {
      total_clientes: 0,
      clientes_activos: 0,
      consentimiento_marketing_si: 0,
      consentimiento_marketing_no: 0,
      acepta_terminos_si: 0,
      acepta_terminos_no: 0,
    },
  };
}

async function buildBaseParametersPayload(client, idSucursal) {
  const branchId = idSucursal ? await ensureBranchExists(client, idSucursal) : null;
  return {
    id_sucursal: branchId,
    sistema: await readSystemParameters(client, BASE_PARAMETER_DEFS),
    sucursal: await readBranchParameters(client, branchId, BASE_PARAMETER_DEFS),
  };
}

function normalizeSlug(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized;
}

function normalizeParagraphs(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError(400, "parrafos debe ser un arreglo de texto", {
      code: "CONFIG_PROMOTION_PARAGRAPHS_INVALID",
    });
  }
  const normalized = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  if (normalized.length > 8) {
    throw new AppError(400, "parrafos no puede tener mas de 8 elementos", {
      code: "CONFIG_PROMOTION_PARAGRAPHS_INVALID",
    });
  }
  return normalized;
}

function normalizePromotionState(value, fallback = "borrador") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!PROMOTION_STATES.includes(normalized)) {
    throw new AppError(400, "estado de promocion invalido", {
      code: "CONFIG_PROMOTION_STATE_INVALID",
    });
  }
  return normalized;
}

function normalizePromotionCtaType(value, fallback = "none") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!PROMOTION_CTA_TYPES.includes(normalized)) {
    throw new AppError(400, "cta_tipo invalido", {
      code: "CONFIG_PROMOTION_CTA_TYPE_INVALID",
    });
  }
  return normalized;
}

function normalizeDateOnly(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(400, "Formato de fecha invalido; usa YYYY-MM-DD", {
      code: "CONFIG_PROMOTION_DATE_INVALID",
    });
  }
  return raw;
}

function mapPromotionRow(row) {
  return {
    id_promocion: row.id_promocion,
    id_sucursal: row.id_sucursal,
    slug: row.slug,
    titulo: row.titulo,
    subtitulo: row.subtitulo ?? null,
    parrafos: Array.isArray(row.parrafos) ? row.parrafos : [],
    imagen_principal_url: row.imagen_principal_url ?? null,
    imagen_mobile_url: row.imagen_mobile_url ?? null,
    imagen_alt: row.imagen_alt ?? null,
    cta_texto: row.cta_texto ?? null,
    cta_url: row.cta_url ?? null,
    cta_tipo: row.cta_tipo ?? "none",
    estado: row.estado,
    visible_publico: Boolean(row.visible_publico),
    vigencia_desde: row.vigencia_desde ?? null,
    vigencia_hasta: row.vigencia_hasta ?? null,
    orden_visual: Number(row.orden_visual ?? 100),
    destacada: Boolean(row.destacada),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function getPromotionScoped(client, idPromocion, idSucursal) {
  const { rows } = await client.query(
    `
      SELECT
        p.id_promocion,
        ps.id_sucursal,
        p.slug,
        p.titulo,
        p.subtitulo,
        p.parrafos,
        p.imagen_principal_url,
        p.imagen_mobile_url,
        p.imagen_alt,
        p.cta_texto,
        p.cta_url,
        p.cta_tipo,
        p.estado,
        ps.visible_publico,
        ps.vigencia_desde,
        ps.vigencia_hasta,
        ps.orden_visual,
        ps.destacada,
        p.created_at,
        GREATEST(p.updated_at, ps.updated_at) AS updated_at
      FROM public.promociones p
      JOIN public.promociones_sucursal ps
        ON ps.id_promocion = p.id_promocion
      WHERE p.id_promocion = $1::uuid
        AND ps.id_sucursal = $2::uuid
      LIMIT 1
    `,
    [idPromocion, idSucursal]
  );
  return rows[0] ?? null;
}

async function listPromotions(client, idSucursal = null) {
  const { rows } = await client.query(
    `
      SELECT
        p.id_promocion,
        ps.id_sucursal,
        p.slug,
        p.titulo,
        p.subtitulo,
        p.parrafos,
        p.imagen_principal_url,
        p.imagen_mobile_url,
        p.imagen_alt,
        p.cta_texto,
        p.cta_url,
        p.cta_tipo,
        p.estado,
        ps.visible_publico,
        ps.vigencia_desde,
        ps.vigencia_hasta,
        ps.orden_visual,
        ps.destacada,
        p.created_at,
        GREATEST(p.updated_at, ps.updated_at) AS updated_at
      FROM public.promociones p
      JOIN public.promociones_sucursal ps
        ON ps.id_promocion = p.id_promocion
      JOIN public.sucursales s
        ON s.id_sucursal = ps.id_sucursal
      WHERE s.deleted_at IS NULL
        AND s.estado IS TRUE
        AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
      ORDER BY ps.orden_visual ASC, p.titulo ASC, ps.id_sucursal ASC
    `,
    [idSucursal]
  );
  return rows.map(mapPromotionRow);
}

function validatePromotionPublication(values) {
  if (!Number.isInteger(Number(values.orden_visual)) || Number(values.orden_visual) < 0) {
    throw new AppError(400, "orden_visual debe ser un entero mayor o igual a 0", {
      code: "CONFIG_PROMOTION_ORDER_INVALID",
    });
  }

  if (values.vigencia_desde && values.vigencia_hasta && values.vigencia_hasta < values.vigencia_desde) {
    throw new AppError(400, "vigencia_hasta no puede ser menor que vigencia_desde", {
      code: "CONFIG_PROMOTION_VIGENCY_INVALID",
    });
  }

  if (values.cta_tipo === "none") {
    if (String(values.cta_texto || "").trim() || String(values.cta_url || "").trim()) {
      throw new AppError(400, "Si cta_tipo es none, cta_texto y cta_url deben ir vacios", {
        code: "CONFIG_PROMOTION_CTA_NONE_INVALID",
      });
    }
  } else {
    if (!String(values.cta_texto || "").trim()) {
      throw new AppError(400, "cta_texto es requerido cuando cta_tipo es interno o externo", {
        code: "CONFIG_PROMOTION_CTA_TEXT_REQUIRED",
      });
    }
    if (!String(values.cta_url || "").trim()) {
      throw new AppError(400, "cta_url es requerido cuando cta_tipo es interno o externo", {
        code: "CONFIG_PROMOTION_CTA_URL_REQUIRED",
      });
    }
  }

  if (values.estado === "archivada" && values.visible_publico) {
    throw new AppError(400, "Una promocion archivada no puede estar visible_publico=true", {
      code: "CONFIG_PROMOTION_ARCHIVED_VISIBILITY_INVALID",
    });
  }

  if (values.estado === "publicada") {
    if (!values.visible_publico) {
      throw new AppError(400, "Una promocion publicada debe ser visible_publico=true", {
        code: "CONFIG_PROMOTION_PUBLIC_VISIBILITY_REQUIRED",
      });
    }
    if (!values.vigencia_desde) {
      throw new AppError(400, "Una promocion publicada requiere vigencia_desde", {
        code: "CONFIG_PROMOTION_VIGENCY_REQUIRED",
      });
    }
    if (!String(values.titulo || "").trim()) {
      throw new AppError(400, "Una promocion publicada requiere titulo", {
        code: "CONFIG_PROMOTION_TITLE_REQUIRED",
      });
    }
    if (!Array.isArray(values.parrafos) || values.parrafos.length === 0) {
      throw new AppError(400, "Una promocion publicada requiere al menos un parrafo", {
        code: "CONFIG_PROMOTION_PARAGRAPHS_REQUIRED",
      });
    }
    if (!String(values.imagen_principal_url || "").trim()) {
      throw new AppError(400, "Una promocion publicada requiere imagen_principal_url", {
        code: "CONFIG_PROMOTION_IMAGE_REQUIRED",
      });
    }
  }
}

async function ensurePromotionSlugUnique(client, slug, excludePromotionId = null) {
  const { rows } = await client.query(
    `
      SELECT id_promocion
      FROM public.promociones
      WHERE LOWER(TRIM(slug)) = LOWER(TRIM($1))
        AND ($2::uuid IS NULL OR id_promocion <> $2::uuid)
      LIMIT 1
    `,
    [slug, excludePromotionId]
  );
  if (rows[0]) {
    throw new AppError(409, "Ya existe una promocion con ese slug", {
      code: "CONFIG_PROMOTION_DUPLICATE_SLUG",
    });
  }
}

async function ensureFeaturedPromotionConflict(client, { idSucursal, idPromocion = null, estado, visiblePublico, destacada, vigenciaDesde, vigenciaHasta }) {
  if (!(destacada && estado === "publicada" && visiblePublico)) {
    return;
  }

  const { rows } = await client.query(
    `
      SELECT 1
      FROM public.promociones_sucursal ps
      JOIN public.promociones p
        ON p.id_promocion = ps.id_promocion
      WHERE ps.id_sucursal = $1::uuid
        AND ps.destacada IS TRUE
        AND p.estado = 'publicada'
        AND ps.visible_publico IS TRUE
        AND ($2::uuid IS NULL OR ps.id_promocion <> $2::uuid)
        AND COALESCE(ps.vigencia_hasta, 'infinity'::date) >= COALESCE($3::date, '-infinity'::date)
        AND COALESCE($4::date, 'infinity'::date) >= COALESCE(ps.vigencia_desde, '-infinity'::date)
      LIMIT 1
    `,
    [idSucursal, idPromocion, vigenciaDesde, vigenciaHasta]
  );

  if (rows[0]) {
    throw new AppError(409, "Ya existe una promocion destacada publicada en el rango de vigencia para esta sucursal", {
      code: "CONFIG_PROMOTION_FEATURED_CONFLICT",
    });
  }
}

function sendHandledError(reply, request, error, fallbackMessage, fallbackCode) {
  if (error instanceof AppError) {
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      details: error.details,
      requestId: request.id,
    });
  }

  if (
    error?.code === "42P01" &&
    (String(error?.message || "").includes("promociones_sucursal") || String(error?.message || "").includes("promociones"))
  ) {
    return sendError(reply, 500, "Falta aplicar migracion de PROMOCIONES multi-sucursal en la base de datos", {
      code: "CONFIG_PROMOTIONS_MIGRATION_REQUIRED",
      details: error.message,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, fallbackMessage);
  return sendError(reply, 500, fallbackMessage, {
    code: fallbackCode,
    details: error instanceof Error ? error.message : fallbackMessage,
    requestId: request.id,
  });
}

export default async function adminConfiguracionRoutes(app) {
  app.get(
    "/perfil",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const idUsuario = request.claims?.user?.id_usuario || request.auth?.sub;
        const row = await getProfileRow(client, idUsuario);
        if (!row) {
          throw new AppError(404, "No se encontro perfil interno para el usuario autenticado", {
            code: "CONFIG_PROFILE_NOT_FOUND",
          });
        }
        return sendOk(reply, { perfil: mapProfileRow(row) }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar el perfil de configuracion", "CONFIG_PROFILE_GET_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/perfil",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            nombres: { type: "string", minLength: 1, maxLength: 120 },
            apellidos: { type: "string", minLength: 1, maxLength: 120 },
            telefono_principal: { type: ["string", "null"], maxLength: 30 },
            direccion_texto: { type: ["string", "null"], maxLength: 300 },
            observaciones: { type: ["string", "null"], maxLength: 500 },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const idUsuario = request.claims?.user?.id_usuario || request.auth?.sub;
        const current = await getProfileRow(client, idUsuario);
        if (!current) {
          throw new AppError(404, "No se encontro perfil interno para el usuario autenticado", {
            code: "CONFIG_PROFILE_NOT_FOUND",
          });
        }
        if (!current.id_persona) {
          throw new AppError(409, "El usuario no tiene una persona asociada para editar perfil", {
            code: "CONFIG_PROFILE_PERSON_MISSING",
          });
        }

        // AM: Edicion de perfil acotada: correo/login se mantiene en solo lectura para no romper auth.
        const nombres = request.body.nombres !== undefined ? normalizeRequiredText(request.body.nombres, "nombres") : current.nombres;
        const apellidos = request.body.apellidos !== undefined ? normalizeRequiredText(request.body.apellidos, "apellidos") : current.apellidos;
        const telefonoPrincipal = request.body.telefono_principal !== undefined ? normalizeOptionalText(request.body.telefono_principal) : current.telefono_principal;
        const direccionTexto = request.body.direccion_texto !== undefined ? normalizeOptionalText(request.body.direccion_texto) : current.direccion_texto;
        const observaciones = request.body.observaciones !== undefined ? normalizeOptionalText(request.body.observaciones) : current.observaciones;

        await client.query(
          `
            UPDATE public.personas
            SET
              nombres = $2,
              apellidos = $3,
              telefono_principal = $4,
              direccion_texto = $5,
              observaciones = $6,
              updated_at = NOW()
            WHERE id_persona = $1::uuid
          `,
          [current.id_persona, nombres, apellidos, telefonoPrincipal, direccionTexto, observaciones]
        );

        const updated = await getProfileRow(client, idUsuario);
        return sendOk(reply, { perfil: mapProfileRow(updated) }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo actualizar el perfil de configuracion", "CONFIG_PROFILE_PATCH_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/notificaciones",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: optionalQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
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
      const client = await app.db.connect();
      try {
        const limit = Number(request.query?.limit || 20);
        const payload = await buildNotificationsPayload(client, limit);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar configuracion de notificaciones", "CONFIG_NOTIFICATIONS_GET_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/notificaciones",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            email_habilitado: { type: "boolean" },
            reintentos_max: { type: "integer", minimum: 0, maximum: 10 },
            reintento_delay_min: { type: "integer", minimum: 0, maximum: 120 },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        await client.query("BEGIN");
        for (const [field, value] of Object.entries(request.body || {})) {
          const descriptor = NOTIFICATION_PARAM_DEFS[field];
          if (!descriptor) continue;
          await upsertSystemParameter(client, descriptor, value);
        }
        await client.query("COMMIT");

        const payload = await buildNotificationsPayload(client, 20);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo actualizar configuracion de notificaciones", "CONFIG_NOTIFICATIONS_PATCH_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/comunicacion",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: optionalQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const payload = await buildCommunicationPayload(client, request.query?.id_sucursal ?? null);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar configuracion de comunicacion", "CONFIG_COMMUNICATION_GET_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/comunicacion",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          properties: {
            id_sucursal: { type: ["string", "null"], format: "uuid" },
            reglas_sistema: {
              type: "object",
              properties: {
                marketing_habilitado: { type: "boolean" },
                requiere_consentimiento: { type: "boolean" },
                max_promos_semana: { type: "integer", minimum: 0, maximum: 30 },
              },
              additionalProperties: false,
            },
            reglas_sucursal: {
              type: "object",
              properties: {
                marketing_habilitado: { type: "boolean" },
                requiere_consentimiento: { type: "boolean" },
                max_promos_semana: { type: "integer", minimum: 0, maximum: 30 },
              },
              additionalProperties: false,
            },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const hasSystemRules = request.body?.reglas_sistema && Object.keys(request.body.reglas_sistema).length > 0;
        const hasBranchRules = request.body?.reglas_sucursal && Object.keys(request.body.reglas_sucursal).length > 0;

        if (!hasSystemRules && !hasBranchRules) {
          throw new AppError(400, "No se enviaron reglas para actualizar", {
            code: "CONFIG_COMMUNICATION_EMPTY",
          });
        }

        const branchId = request.body?.id_sucursal ? await ensureBranchExists(client, request.body.id_sucursal) : null;
        if (hasBranchRules && !branchId) {
          throw new AppError(400, "Debes indicar id_sucursal para actualizar reglas por sucursal", {
            code: "CONFIG_COMMUNICATION_BRANCH_REQUIRED",
          });
        }

        await client.query("BEGIN");

        if (hasSystemRules) {
          for (const [field, value] of Object.entries(request.body.reglas_sistema)) {
            const descriptor = COMMUNICATION_PARAM_DEFS[field];
            if (!descriptor) continue;
            await upsertSystemParameter(client, descriptor, value);
          }
        }

        if (hasBranchRules && branchId) {
          for (const [field, value] of Object.entries(request.body.reglas_sucursal)) {
            const descriptor = COMMUNICATION_PARAM_DEFS[field];
            if (!descriptor) continue;
            await upsertBranchParameter(client, branchId, descriptor, value);
          }
        }

        await client.query("COMMIT");
        const payload = await buildCommunicationPayload(client, branchId);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo actualizar configuracion de comunicacion", "CONFIG_COMMUNICATION_PATCH_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/parametros",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: optionalQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const payload = await buildBaseParametersPayload(client, request.query?.id_sucursal ?? null);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar parametros base de configuracion", "CONFIG_PARAMETERS_GET_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/parametros",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        body: {
          type: "object",
          required: ["scope", "valores"],
          properties: {
            scope: { type: "string", enum: ["sistema", "sucursal"] },
            id_sucursal: { type: ["string", "null"], format: "uuid" },
            valores: {
              type: "object",
              properties: {
                moneda_default: { type: "string", minLength: 3, maxLength: 3 },
                hold_minutos: { type: "integer", minimum: 0, maximum: 240 },
                buffer_servicio_minutos: { type: "integer", minimum: 0, maximum: 240 },
                no_show_min: { type: "integer", minimum: 0, maximum: 240 },
              },
              minProperties: 1,
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const scope = String(request.body.scope || "").trim().toLowerCase();
        const branchId = request.body?.id_sucursal ? await ensureBranchExists(client, request.body.id_sucursal) : null;

        if (scope === "sucursal" && !branchId) {
          throw new AppError(400, "Debes indicar id_sucursal para actualizar parametros por sucursal", {
            code: "CONFIG_PARAMETERS_BRANCH_REQUIRED",
          });
        }

        const values = { ...(request.body.valores || {}) };
        if (values.moneda_default !== undefined) {
          // AM: Curaduria para evitar codigos de moneda invalidos en parametros base.
          const currency = String(values.moneda_default || "").trim().toUpperCase();
          if (!/^[A-Z]{3}$/.test(currency)) {
            throw new AppError(400, "moneda_default debe tener formato ISO de 3 letras, por ejemplo HNL", {
              code: "CONFIG_PARAMETERS_CURRENCY_INVALID",
            });
          }
          values.moneda_default = currency;
        }

        await client.query("BEGIN");
        for (const [field, value] of Object.entries(values)) {
          const descriptor = BASE_PARAMETER_DEFS[field];
          if (!descriptor) continue;
          if (scope === "sucursal") {
            await upsertBranchParameter(client, branchId, descriptor, value);
          } else {
            await upsertSystemParameter(client, descriptor, value);
          }
        }
        await client.query("COMMIT");

        const payload = await buildBaseParametersPayload(client, branchId);
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudieron actualizar parametros base de configuracion", "CONFIG_PARAMETERS_PATCH_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/promociones",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        querystring: optionalQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const branchId = request.query?.id_sucursal
          ? await ensureBranchExists(client, request.query.id_sucursal)
          : null;
        const promociones = await listPromotions(client, branchId);
        return sendOk(reply, { id_sucursal: branchId, promociones }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar promociones de configuracion", "CONFIG_PROMOTIONS_GET_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/promociones/:id",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
          },
          required: ["id_sucursal"],
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const branchId = await ensureBranchExists(client, request.query?.id_sucursal);
        const promocion = await getPromotionScoped(client, request.params.id, branchId);
        if (!promocion) {
          throw new AppError(404, "La promocion indicada no existe para la sucursal", {
            code: "CONFIG_PROMOTION_NOT_FOUND",
          });
        }
        return sendOk(reply, { promocion: mapPromotionRow(promocion) }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar el detalle de promocion", "CONFIG_PROMOTION_DETAIL_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/promociones",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        body: promotionBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const branchId = await ensureBranchExists(client, request.body.id_sucursal);
        const titulo = normalizeRequiredText(request.body.titulo, "titulo");
        const slug = normalizeSlug(request.body.slug || titulo);
        if (!slug) {
          throw new AppError(400, "No se pudo generar un slug valido para la promocion", {
            code: "CONFIG_PROMOTION_SLUG_INVALID",
          });
        }

        const subtitulo = normalizeOptionalText(request.body.subtitulo) ?? null;
        const parrafos = normalizeParagraphs(request.body.parrafos) ?? [];
        const imagenPrincipalUrl = normalizeOptionalText(request.body.imagen_principal_url) ?? null;
        const imagenMobileUrl = normalizeOptionalText(request.body.imagen_mobile_url) ?? null;
        const imagenAlt = normalizeOptionalText(request.body.imagen_alt) ?? null;
        const ctaTexto = normalizeOptionalText(request.body.cta_texto) ?? null;
        const ctaUrl = normalizeOptionalText(request.body.cta_url) ?? null;
        const ctaTipo = normalizePromotionCtaType(request.body.cta_tipo, "none");
        const normalizedCtaTexto = ctaTipo === "none" ? null : ctaTexto;
        const normalizedCtaUrl = ctaTipo === "none" ? null : ctaUrl;
        const estado = normalizePromotionState(request.body.estado, "borrador");
        const visiblePublico = Boolean(request.body.visible_publico ?? false);
        const vigenciaDesde = normalizeDateOnly(request.body.vigencia_desde) ?? null;
        const vigenciaHasta = normalizeDateOnly(request.body.vigencia_hasta) ?? null;
        const ordenVisual = Number.isFinite(Number(request.body.orden_visual)) ? Number(request.body.orden_visual) : 100;
        const destacada = Boolean(request.body.destacada ?? false);

        const publicationSnapshot = {
          titulo,
          parrafos,
          imagen_principal_url: imagenPrincipalUrl,
          cta_texto: normalizedCtaTexto,
          cta_url: normalizedCtaUrl,
          cta_tipo: ctaTipo,
          estado,
          visible_publico: visiblePublico,
          vigencia_desde: vigenciaDesde,
          vigencia_hasta: vigenciaHasta,
          orden_visual: ordenVisual,
        };
        validatePromotionPublication(publicationSnapshot);

        await ensurePromotionSlugUnique(client, slug);
        await ensureFeaturedPromotionConflict(client, {
          idSucursal: branchId,
          estado,
          visiblePublico,
          destacada,
          vigenciaDesde,
          vigenciaHasta,
        });

        await client.query("BEGIN");
        const inserted = await client.query(
          `
            INSERT INTO public.promociones (
              slug,
              titulo,
              subtitulo,
              parrafos,
              imagen_principal_url,
              imagen_mobile_url,
              imagen_alt,
              cta_texto,
              cta_url,
              cta_tipo,
              estado,
              updated_at
            )
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, NOW())
            RETURNING id_promocion
          `,
          [slug, titulo, subtitulo, JSON.stringify(parrafos), imagenPrincipalUrl, imagenMobileUrl, imagenAlt, normalizedCtaTexto, normalizedCtaUrl, ctaTipo, estado]
        );

        const idPromocion = inserted.rows[0].id_promocion;

        await client.query(
          `
            INSERT INTO public.promociones_sucursal (
              id_promocion,
              id_sucursal,
              visible_publico,
              vigencia_desde,
              vigencia_hasta,
              orden_visual,
              destacada,
              updated_at
            )
            VALUES ($1::uuid, $2::uuid, $3::boolean, $4::date, $5::date, $6::int, $7::boolean, NOW())
          `,
          [idPromocion, branchId, visiblePublico, vigenciaDesde, vigenciaHasta, ordenVisual, destacada]
        );

        const finalPromotion = await getPromotionScoped(client, idPromocion, branchId);
        if (!finalPromotion) {
          throw new AppError(404, "No se pudo recuperar la promocion creada para la sucursal", {
            code: "CONFIG_PROMOTION_NOT_FOUND",
          });
        }
        await client.query("COMMIT");

        return sendOk(reply, { promocion: mapPromotionRow(finalPromotion) }, { statusCode: 201, requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo crear la promocion", "CONFIG_PROMOTION_CREATE_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/promociones/:id",
    {
      preHandler: app.requireRoles(SUPER_ADMIN_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        body: promotionPatchSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", additionalProperties: true },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const branchId = await ensureBranchExists(client, request.body.id_sucursal);
        const currentPromotion = await getPromotionScoped(client, request.params.id, branchId);
        if (!currentPromotion) {
          throw new AppError(404, "La promocion indicada no existe para la sucursal", {
            code: "CONFIG_PROMOTION_NOT_FOUND",
          });
        }

        const titulo =
          request.body.titulo !== undefined
            ? normalizeRequiredText(request.body.titulo, "titulo")
            : currentPromotion.titulo;
        const slug =
          request.body.slug !== undefined
            ? normalizeSlug(request.body.slug)
            : currentPromotion.slug;
        if (!slug) {
          throw new AppError(400, "slug invalido", {
            code: "CONFIG_PROMOTION_SLUG_INVALID",
          });
        }

        const subtitulo =
          request.body.subtitulo !== undefined
            ? normalizeOptionalText(request.body.subtitulo) ?? null
            : currentPromotion.subtitulo;
        const parrafos =
          request.body.parrafos !== undefined
            ? normalizeParagraphs(request.body.parrafos) ?? []
            : (Array.isArray(currentPromotion.parrafos) ? currentPromotion.parrafos : []);
        const imagenPrincipalUrl =
          request.body.imagen_principal_url !== undefined
            ? normalizeOptionalText(request.body.imagen_principal_url) ?? null
            : currentPromotion.imagen_principal_url;
        const imagenMobileUrl =
          request.body.imagen_mobile_url !== undefined
            ? normalizeOptionalText(request.body.imagen_mobile_url) ?? null
            : currentPromotion.imagen_mobile_url;
        const imagenAlt =
          request.body.imagen_alt !== undefined
            ? normalizeOptionalText(request.body.imagen_alt) ?? null
            : currentPromotion.imagen_alt;
        const ctaTexto =
          request.body.cta_texto !== undefined
            ? normalizeOptionalText(request.body.cta_texto) ?? null
            : currentPromotion.cta_texto;
        const ctaUrl =
          request.body.cta_url !== undefined
            ? normalizeOptionalText(request.body.cta_url) ?? null
            : currentPromotion.cta_url;
        const ctaTipo =
          request.body.cta_tipo !== undefined
            ? normalizePromotionCtaType(request.body.cta_tipo)
            : normalizePromotionCtaType(currentPromotion.cta_tipo, "none");
        const normalizedCtaTexto = ctaTipo === "none" ? null : ctaTexto;
        const normalizedCtaUrl = ctaTipo === "none" ? null : ctaUrl;
        const estado =
          request.body.estado !== undefined
            ? normalizePromotionState(request.body.estado)
            : normalizePromotionState(currentPromotion.estado, "borrador");
        const visiblePublico =
          request.body.visible_publico !== undefined
            ? Boolean(request.body.visible_publico)
            : Boolean(currentPromotion.visible_publico);
        const vigenciaDesde =
          request.body.vigencia_desde !== undefined
            ? normalizeDateOnly(request.body.vigencia_desde)
            : currentPromotion.vigencia_desde;
        const vigenciaHasta =
          request.body.vigencia_hasta !== undefined
            ? normalizeDateOnly(request.body.vigencia_hasta)
            : currentPromotion.vigencia_hasta;
        const ordenVisual =
          request.body.orden_visual !== undefined
            ? Number(request.body.orden_visual)
            : Number(currentPromotion.orden_visual ?? 100);
        const destacada =
          request.body.destacada !== undefined
            ? Boolean(request.body.destacada)
            : Boolean(currentPromotion.destacada);

        const publicationSnapshot = {
          titulo,
          parrafos,
          imagen_principal_url: imagenPrincipalUrl,
          cta_texto: normalizedCtaTexto,
          cta_url: normalizedCtaUrl,
          cta_tipo: ctaTipo,
          estado,
          visible_publico: visiblePublico,
          vigencia_desde: vigenciaDesde,
          vigencia_hasta: vigenciaHasta,
          orden_visual: ordenVisual,
        };
        validatePromotionPublication(publicationSnapshot);

        await ensurePromotionSlugUnique(client, slug, request.params.id);
        await ensureFeaturedPromotionConflict(client, {
          idSucursal: branchId,
          idPromocion: request.params.id,
          estado,
          visiblePublico,
          destacada,
          vigenciaDesde,
          vigenciaHasta,
        });

        await client.query("BEGIN");
        await client.query(
          `
            UPDATE public.promociones
            SET
              slug = $2,
              titulo = $3,
              subtitulo = $4,
              parrafos = $5::jsonb,
              imagen_principal_url = $6,
              imagen_mobile_url = $7,
              imagen_alt = $8,
              cta_texto = $9,
              cta_url = $10,
              cta_tipo = $11,
              estado = $12,
              updated_at = NOW()
            WHERE id_promocion = $1::uuid
          `,
          [request.params.id, slug, titulo, subtitulo, JSON.stringify(parrafos), imagenPrincipalUrl, imagenMobileUrl, imagenAlt, normalizedCtaTexto, normalizedCtaUrl, ctaTipo, estado]
        );

        await client.query(
          `
            UPDATE public.promociones_sucursal
            SET
              visible_publico = $3::boolean,
              vigencia_desde = $4::date,
              vigencia_hasta = $5::date,
              orden_visual = $6::int,
              destacada = $7::boolean,
              updated_at = NOW()
            WHERE id_promocion = $1::uuid
              AND id_sucursal = $2::uuid
          `,
          [request.params.id, branchId, visiblePublico, vigenciaDesde, vigenciaHasta, ordenVisual, destacada]
        );

        const finalPromotion = await getPromotionScoped(client, request.params.id, branchId);
        if (!finalPromotion) {
          throw new AppError(404, "No se pudo recuperar la promocion actualizada para la sucursal", {
            code: "CONFIG_PROMOTION_NOT_FOUND",
          });
        }
        await client.query("COMMIT");

        return sendOk(reply, { promocion: mapPromotionRow(finalPromotion) }, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo actualizar la promocion", "CONFIG_PROMOTION_UPDATE_ERROR");
      } finally {
        client.release();
      }
    }
  );
}
