import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  activateAssetForEntity,
  replaceAssetIfNeeded,
  resolveAssetForBinding,
} from "../../../services/storage/storageService.js";

const CONFIG_COMMUNICATION_ALLOWED_ROLES = ["super_admin", "admin"];
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

const PROMOTION_STATES = ["borrador", "publicada", "archivada"];
const COMMUNICATION_CAMPAIGN_TYPES = ["informativa", "promocional"];
const COMMUNICATION_FIXED_TYPE = "informativa";
const COMMUNICATION_CAMPAIGN_CHANNEL = "email";
const COMMUNICATION_CAMPAIGN_DRAFT_STATE = "borrador";
const COMMUNICATION_CAMPAIGN_SCHEDULED_STATE = "programada";
const COMMUNICATION_CAMPAIGN_CANCELLED_STATE = "cancelada";
const COMMUNICATION_CAMPAIGN_DB_STATES = ["borrador", "programada", "procesando", "finalizada", "cancelada", "error"];
const COMMUNICATION_CAMPAIGN_OPERATIONAL_STATES = ["borrador", "programada", "cancelada", "finalizada"];
const COMMUNICATION_CAMPAIGNS_SORTS = ["updated_desc", "updated_asc", "created_desc", "created_asc", "programada_desc", "programada_asc"];
const COMMUNICATION_INTERNAL_NAME_MAX_LENGTH = 160;
const COMMUNICATION_SUBJECT_MAX_LENGTH = 180;
const COMMUNICATION_CONTENT_TEXT_MAX_LENGTH = 20000;
const COMMUNICATION_OBSERVATIONS_MAX_LENGTH = 2000;
const COMMUNICATION_SEND_STATUS_PENDING = "pendiente";
const COMMUNICATION_SEND_STATUS_SENT = "enviado";
const COMMUNICATION_SEND_STATUS_FAILED = "fallido";
const COMMUNICATION_FALLBACK_SEND_DELAY_MINUTES = 1440;
const COMMUNICATION_SEND_ERROR_MAX_LENGTH = 500;
const COMMUNICATION_MANUAL_EXCLUSION_REASON = "exclusion_manual";
const COMMUNICATION_SEND_LOCK_NAMESPACE = 82051;
const COMMUNICATION_SCHEDULER_INTERVAL_MS_DEFAULT = 60000;
const COMMUNICATION_SCHEDULER_MAX_CAMPAIGNS_PER_TICK = 10;
const COMMUNICATION_ELIGIBILITY_STATES = ["elegible", "excluido"];
const COMMUNICATION_ELIGIBILITY_REASONS = [
  "sin_correo",
  "inactivo",
  "sin_aceptacion_terminos",
  "sin_consentimiento_marketing",
];
const COMMUNICATION_SCHEMA_CAPS_DEFAULT = Object.freeze({
  hasCampaignExclusionsSnapshot: false,
  hasClientAceptaTerminosAt: false,
  hasClientConsentimientoMarketingAt: false,
});
const COMMUNICATION_SCHEMA_CAPS_CACHE_MS = 30000;
let communicationSchemaCapsCache = {
  loadedAt: 0,
  value: COMMUNICATION_SCHEMA_CAPS_DEFAULT,
};
const COMMUNICATION_EMAIL_FROM_ADDRESS =
  String(process.env.SMTP_FROM_PROMOTIONS || process.env.SMTP_FROM_COMMUNICATIONS || "promociones@masterfadeapp.com")
    .trim();
const COMMUNICATION_EMAIL_BANNER_URL = String(process.env.COMMUNICATION_EMAIL_BANNER_URL || "").trim();
const STORAGE_SCOPE_PUBLIC_PROMOTION_MAIN = "public_promotion_main";
const STORAGE_SCOPE_PUBLIC_PROMOTION_MOBILE = "public_promotion_mobile";

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
    imagen_principal_asset_id: { type: ["string", "null"], format: "uuid" },
    imagen_mobile_url: { type: ["string", "null"], maxLength: 500 },
    imagen_mobile_asset_id: { type: ["string", "null"], format: "uuid" },
    imagen_alt: { type: ["string", "null"], maxLength: 180 },
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
    imagen_principal_asset_id: { type: ["string", "null"], format: "uuid" },
    imagen_mobile_url: { type: ["string", "null"], maxLength: 500 },
    imagen_mobile_asset_id: { type: ["string", "null"], format: "uuid" },
    imagen_alt: { type: ["string", "null"], maxLength: 180 },
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

const communicationCampaignCreateSchema = {
  type: "object",
  properties: {
    tipo_campania: { type: "string", enum: [COMMUNICATION_FIXED_TYPE] },
    nombre_interno: { type: "string", minLength: 1, maxLength: COMMUNICATION_INTERNAL_NAME_MAX_LENGTH },
    asunto: { type: "string", minLength: 1, maxLength: COMMUNICATION_SUBJECT_MAX_LENGTH },
    contenido_texto: { type: "string", minLength: 1, maxLength: COMMUNICATION_CONTENT_TEXT_MAX_LENGTH },
    observaciones: { type: ["string", "null"], maxLength: COMMUNICATION_OBSERVATIONS_MAX_LENGTH },
  },
  required: ["tipo_campania", "nombre_interno", "asunto", "contenido_texto"],
  additionalProperties: false,
};

const communicationCampaignPatchSchema = {
  type: "object",
  properties: {
    tipo_campania: { type: "string", enum: [COMMUNICATION_FIXED_TYPE] },
    nombre_interno: { type: "string", minLength: 1, maxLength: COMMUNICATION_INTERNAL_NAME_MAX_LENGTH },
    asunto: { type: "string", minLength: 1, maxLength: COMMUNICATION_SUBJECT_MAX_LENGTH },
    contenido_texto: { type: "string", minLength: 1, maxLength: COMMUNICATION_CONTENT_TEXT_MAX_LENGTH },
    observaciones: { type: ["string", "null"], maxLength: COMMUNICATION_OBSERVATIONS_MAX_LENGTH },
  },
  minProperties: 1,
  additionalProperties: false,
};

const communicationEligibilitySummaryQuerySchema = {
  type: "object",
  properties: {
    limit_elegibles: { type: "integer", minimum: 1, maximum: 100 },
    limit_excluidos: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

const communicationEligibilityRecipientsQuerySchema = {
  type: "object",
  properties: {
    estado: { type: "string", enum: COMMUNICATION_ELIGIBILITY_STATES },
    motivo: { type: "string", enum: COMMUNICATION_ELIGIBILITY_REASONS },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 10000 },
  },
  additionalProperties: false,
};

const communicationCampaignScheduleBodySchema = {
  type: "object",
  properties: {
    programada_para: { type: ["string", "null"], format: "date-time" },
    id_clientes_excluidos: {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 20000,
      uniqueItems: true,
    },
  },
  additionalProperties: false,
};

const communicationCampaignShipmentsQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 10000 },
  },
  additionalProperties: false,
};

const communicationCampaignsQuerySchema = {
  type: "object",
  properties: {
    q: { type: "string", maxLength: 180 },
    tipo_campania: { type: "string", enum: [COMMUNICATION_FIXED_TYPE] },
    estado: { type: "string", enum: COMMUNICATION_CAMPAIGN_DB_STATES },
    estado_operativo: { type: "string", enum: COMMUNICATION_CAMPAIGN_OPERATIONAL_STATES },
    incluir_canceladas: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 10000 },
    sort: { type: "string", enum: COMMUNICATION_CAMPAIGNS_SORTS },
  },
  additionalProperties: false,
};

function normalizeRequiredText(value, fieldName) {
  const trimmed = String(value || "").normalize("NFC").trim();
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
  const trimmed = String(value).normalize("NFC").trim();
  return trimmed || null;
}

function maskEmailAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) return null;
  const [local, domain] = raw.split("@");
  if (!local || !domain) return null;
  const prefix = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

function parseBooleanQueryValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "si"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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

function normalizeCommunicationCampaignType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return COMMUNICATION_FIXED_TYPE;
  if (!COMMUNICATION_CAMPAIGN_TYPES.includes(normalized)) {
    throw new AppError(400, "tipo_campania invalido. Valor permitido: informativa", {
      code: "CONFIG_COMM_CAMPAIGN_TYPE_INVALID",
    });
  }
  if (normalized !== COMMUNICATION_FIXED_TYPE) {
    throw new AppError(400, "Este submodulo solo admite campanias informativas", {
      code: "CONFIG_COMM_CAMPAIGN_TYPE_FORBIDDEN",
    });
  }
  return COMMUNICATION_FIXED_TYPE;
}

function normalizeCommunicationRequiredText(value, fieldName, maxLength) {
  const text = normalizeRequiredText(value, fieldName);
  if (maxLength && text.length > maxLength) {
    throw new AppError(400, `El campo ${fieldName} excede el maximo permitido`, {
      code: "CONFIG_COMM_CAMPAIGN_TEXT_TOO_LONG",
      details: { field: fieldName, maxLength },
    });
  }
  return text;
}

function normalizeCommunicationOptionalText(value, maxLength) {
  const text = normalizeOptionalText(value);
  if (text === undefined || text === null) return text;
  if (maxLength && text.length > maxLength) {
    throw new AppError(400, "El campo observaciones excede el maximo permitido", {
      code: "CONFIG_COMM_CAMPAIGN_OBSERVATIONS_TOO_LONG",
      details: { maxLength },
    });
  }
  return text;
}

function resolveCommunicationOperationalState(row = {}) {
  const rawState = String(row.estado || "").trim().toLowerCase();
  if (rawState === COMMUNICATION_CAMPAIGN_CANCELLED_STATE) return COMMUNICATION_CAMPAIGN_CANCELLED_STATE;
  if (rawState === COMMUNICATION_CAMPAIGN_DRAFT_STATE) return COMMUNICATION_CAMPAIGN_DRAFT_STATE;
  if (rawState === "finalizada") return "finalizada";
  if (rawState === COMMUNICATION_CAMPAIGN_SCHEDULED_STATE) {
    const pendings = Number(row.total_pendientes ?? 0);
    const failed = Number(row.total_fallidos ?? 0);
    const hasFinishedTimestamp = row.finalizada_at !== null && row.finalizada_at !== undefined;
    if (hasFinishedTimestamp && pendings <= 0 && failed <= 0) return "finalizada";
    return COMMUNICATION_CAMPAIGN_SCHEDULED_STATE;
  }
  return rawState || "sin_estado";
}

function normalizeCommunicationExclusionsSnapshot(rawValue) {
  if (!rawValue) return null;
  if (Array.isArray(rawValue)) {
    return {
      excluidos: rawValue,
      resumen_por_motivo: [],
    };
  }
  if (typeof rawValue !== "object") return null;
  const exclusions = Array.isArray(rawValue.excluidos) ? rawValue.excluidos : [];
  const summary = Array.isArray(rawValue.resumen_por_motivo) ? rawValue.resumen_por_motivo : [];
  const sanitizedExclusions = exclusions.map((row) => ({
    nombre_cliente: row?.nombre_cliente ?? null,
    correo_destino: maskEmailAddress(row?.correo_destino ?? null),
    motivo_exclusion: row?.motivo_exclusion ?? null,
    origen_exclusion: row?.origen_exclusion ?? null,
  }));
  return {
    generado_at: rawValue.generado_at ?? null,
    tipo_campania: rawValue.tipo_campania ?? null,
    excluidos: sanitizedExclusions,
    resumen_por_motivo: summary,
  };
}

async function getCommunicationSchemaCapabilities(client) {
  const now = Date.now();
  if (now - communicationSchemaCapsCache.loadedAt < COMMUNICATION_SCHEMA_CAPS_CACHE_MS) {
    return communicationSchemaCapsCache.value;
  }

  const { rows } = await client.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'comunicaciones_campanias' AND column_name IN ('exclusiones_snapshot'))
          OR (table_name = 'clientes' AND column_name IN ('acepta_terminos_at', 'consentimiento_marketing_at'))
        )
    `
  );

  const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  const capabilities = {
    hasCampaignExclusionsSnapshot: found.has("comunicaciones_campanias.exclusiones_snapshot"),
    hasClientAceptaTerminosAt: found.has("clientes.acepta_terminos_at"),
    hasClientConsentimientoMarketingAt: found.has("clientes.consentimiento_marketing_at"),
  };

  communicationSchemaCapsCache = {
    loadedAt: now,
    value: capabilities,
  };
  return capabilities;
}

function buildCommunicationCampaignSelectColumns(schemaCaps = COMMUNICATION_SCHEMA_CAPS_DEFAULT) {
  return [
    "id_campania",
    "tipo_campania",
    "canal",
    "nombre_interno",
    "asunto",
    "contenido_texto",
    "observaciones",
    "estado",
    "programada_para",
    "enviada_at",
    "finalizada_at",
    "total_destinatarios",
    "total_pendientes",
    "total_enviados",
    "total_fallidos",
    "total_omitidos",
    schemaCaps.hasCampaignExclusionsSnapshot ? "exclusiones_snapshot" : "NULL::jsonb AS exclusiones_snapshot",
    "creada_por",
    "actualizada_por",
    "created_at",
    "updated_at",
  ].join(",\n        ");
}

function mapCommunicationCampaignRow(row) {
  return {
    id_campania: row.id_campania,
    tipo_campania: row.tipo_campania,
    canal: row.canal,
    nombre_interno: row.nombre_interno,
    asunto: row.asunto,
    contenido_texto: row.contenido_texto,
    observaciones: row.observaciones ?? null,
    estado: row.estado,
    programada_para: row.programada_para ?? null,
    enviada_at: row.enviada_at ?? null,
    finalizada_at: row.finalizada_at ?? null,
    total_destinatarios: Number(row.total_destinatarios ?? 0),
    total_pendientes: Number(row.total_pendientes ?? 0),
    total_enviados: Number(row.total_enviados ?? 0),
    total_fallidos: Number(row.total_fallidos ?? 0),
    total_omitidos: Number(row.total_omitidos ?? 0),
    exclusiones_snapshot: normalizeCommunicationExclusionsSnapshot(row.exclusiones_snapshot),
    estado_operativo: row.estado_operativo ?? resolveCommunicationOperationalState(row),
    creada_por: row.creada_por ?? null,
    actualizada_por: row.actualizada_por ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function resolveCommunicationCampaignsSort(sort) {
  const normalized = String(sort || "updated_desc").trim().toLowerCase();
  switch (normalized) {
    case "updated_asc":
      return { key: "updated_asc", clause: "updated_at ASC, created_at ASC" };
    case "created_desc":
      return { key: "created_desc", clause: "created_at DESC, updated_at DESC" };
    case "created_asc":
      return { key: "created_asc", clause: "created_at ASC, updated_at ASC" };
    case "programada_desc":
      return { key: "programada_desc", clause: "programada_para DESC NULLS LAST, updated_at DESC" };
    case "programada_asc":
      return { key: "programada_asc", clause: "programada_para ASC NULLS LAST, updated_at DESC" };
    case "updated_desc":
    default:
      return { key: "updated_desc", clause: "updated_at DESC, created_at DESC" };
  }
}

function buildCommunicationCampaignsFilters(rawQuery = {}) {
  const q = String(rawQuery.q || "").trim();
  const estado = rawQuery.estado ? String(rawQuery.estado).trim().toLowerCase() : null;
  const estadoOperativo = rawQuery.estado_operativo ? String(rawQuery.estado_operativo).trim().toLowerCase() : null;
  const incluirCanceladas = parseBooleanQueryValue(rawQuery.incluir_canceladas, false);
  const limit = Number.isFinite(Number(rawQuery.limit)) ? Math.max(1, Math.min(100, Number(rawQuery.limit))) : 25;
  const offset = Number.isFinite(Number(rawQuery.offset)) ? Math.max(0, Math.min(10000, Number(rawQuery.offset))) : 0;
  const sort = resolveCommunicationCampaignsSort(rawQuery.sort);

  return {
    q: q || null,
    tipo_campania: COMMUNICATION_FIXED_TYPE,
    estado: estado && COMMUNICATION_CAMPAIGN_DB_STATES.includes(estado) ? estado : null,
    estado_operativo: estadoOperativo && COMMUNICATION_CAMPAIGN_OPERATIONAL_STATES.includes(estadoOperativo) ? estadoOperativo : null,
    incluir_canceladas: incluirCanceladas,
    limit,
    offset,
    sort,
  };
}

async function listCommunicationCampaigns(client, rawQuery = {}) {
  const filters = buildCommunicationCampaignsFilters(rawQuery);

  const baseSql = `
    WITH base AS (
      SELECT
        id_campania,
        tipo_campania,
        canal,
        nombre_interno,
        asunto,
        contenido_texto,
        observaciones,
        estado,
        programada_para,
        enviada_at,
        finalizada_at,
        total_destinatarios,
        total_pendientes,
        total_enviados,
        total_fallidos,
        total_omitidos,
        creada_por,
        actualizada_por,
        created_at,
        updated_at,
        CASE
          WHEN estado = 'cancelada' THEN 'cancelada'
          WHEN estado = 'borrador' THEN 'borrador'
          WHEN estado = 'finalizada' THEN 'finalizada'
          WHEN estado = 'programada'
            AND finalizada_at IS NOT NULL
            AND COALESCE(total_pendientes, 0) = 0
            AND COALESCE(total_fallidos, 0) = 0
            THEN 'finalizada'
          WHEN estado = 'programada' THEN 'programada'
          ELSE estado
        END AS estado_operativo
      FROM public.comunicaciones_campanias
      WHERE deleted_at IS NULL
    ),
    filtered AS (
      SELECT *
      FROM base
      WHERE ($1::text IS NULL OR nombre_interno ILIKE '%' || $1::text || '%' OR asunto ILIKE '%' || $1::text || '%')
        AND ($2::text IS NULL OR tipo_campania = $2::text)
        AND ($3::text IS NULL OR estado = $3::text)
        AND ($4::text IS NULL OR estado_operativo = $4::text)
        AND ($5::boolean IS TRUE OR estado <> 'cancelada')
    )
  `;

  const rowsResult = await client.query(
    `
      ${baseSql}
      SELECT
        id_campania,
        tipo_campania,
        canal,
        nombre_interno,
        asunto,
        contenido_texto,
        observaciones,
        estado,
        estado_operativo,
        programada_para,
        enviada_at,
        finalizada_at,
        total_destinatarios,
        total_pendientes,
        total_enviados,
        total_fallidos,
        total_omitidos,
        creada_por,
        actualizada_por,
        created_at,
        updated_at
      FROM filtered
      ORDER BY ${filters.sort.clause}
      LIMIT $6::int
      OFFSET $7::int
    `,
    [filters.q, filters.tipo_campania, filters.estado, filters.estado_operativo, filters.incluir_canceladas, filters.limit, filters.offset]
  );

  const totalResult = await client.query(
    `
      ${baseSql}
      SELECT COUNT(*)::int AS total
      FROM filtered
    `,
    [filters.q, filters.tipo_campania, filters.estado, filters.estado_operativo, filters.incluir_canceladas]
  );

  return {
    q: filters.q,
    tipo_campania: filters.tipo_campania,
    estado: filters.estado,
    estado_operativo: filters.estado_operativo,
    incluir_canceladas: filters.incluir_canceladas,
    sort: filters.sort.key,
    limit: filters.limit,
    offset: filters.offset,
    total: Number(totalResult.rows?.[0]?.total || 0),
    campanias: rowsResult.rows.map(mapCommunicationCampaignRow),
  };
}

async function getCommunicationCampaignById(client, idCampania, schemaCaps = null) {
  const capabilities = schemaCaps || await getCommunicationSchemaCapabilities(client);
  const { rows } = await client.query(
    `
      SELECT
        ${buildCommunicationCampaignSelectColumns(capabilities)}
      FROM public.comunicaciones_campanias
      WHERE id_campania = $1::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [idCampania]
  );
  return rows[0] ?? null;
}

async function getCommunicationCampaignByIdForUpdate(client, idCampania) {
  const capabilities = await getCommunicationSchemaCapabilities(client);
  const { rows } = await client.query(
    `
      SELECT
        ${buildCommunicationCampaignSelectColumns(capabilities)}
      FROM public.comunicaciones_campanias
      WHERE id_campania = $1::uuid
        AND deleted_at IS NULL
      FOR UPDATE
      LIMIT 1
    `,
    [idCampania]
  );
  return rows[0] ?? null;
}

function assertCommunicationCampaignAllowed(campaign) {
  const rawType = String(campaign?.tipo_campania || "").trim().toLowerCase();
  if (rawType && rawType !== COMMUNICATION_FIXED_TYPE) {
    throw new AppError(404, "La campania indicada no existe o fue eliminada", {
      code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
    });
  }
}

function buildCommunicationCampaignCreateValues(body) {
  return {
    tipo_campania: normalizeCommunicationCampaignType(body.tipo_campania ?? COMMUNICATION_FIXED_TYPE),
    nombre_interno: normalizeCommunicationRequiredText(body.nombre_interno, "nombre_interno", COMMUNICATION_INTERNAL_NAME_MAX_LENGTH),
    asunto: normalizeCommunicationRequiredText(body.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH),
    contenido_texto: normalizeCommunicationRequiredText(body.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH),
    observaciones: normalizeCommunicationOptionalText(body.observaciones, COMMUNICATION_OBSERVATIONS_MAX_LENGTH) ?? null,
  };
}

function buildCommunicationCampaignPatchValues(body = {}, currentRow) {
  const next = {
    tipo_campania: normalizeCommunicationCampaignType(currentRow.tipo_campania ?? COMMUNICATION_FIXED_TYPE),
    nombre_interno: currentRow.nombre_interno,
    asunto: currentRow.asunto,
    contenido_texto: currentRow.contenido_texto,
    observaciones: currentRow.observaciones ?? null,
  };

  if (body.tipo_campania !== undefined) next.tipo_campania = normalizeCommunicationCampaignType(body.tipo_campania);
  if (body.nombre_interno !== undefined) next.nombre_interno = normalizeCommunicationRequiredText(body.nombre_interno, "nombre_interno", COMMUNICATION_INTERNAL_NAME_MAX_LENGTH);
  if (body.asunto !== undefined) next.asunto = normalizeCommunicationRequiredText(body.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH);
  if (body.contenido_texto !== undefined) next.contenido_texto = normalizeCommunicationRequiredText(body.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH);
  if (body.observaciones !== undefined) next.observaciones = normalizeCommunicationOptionalText(body.observaciones, COMMUNICATION_OBSERVATIONS_MAX_LENGTH) ?? null;

  return next;
}

function resolveCampaignTypeForEligibility(rawType) {
  return normalizeCommunicationCampaignType(rawType ?? COMMUNICATION_FIXED_TYPE);
}

function buildEligibilityEvaluationCte(schemaCaps = COMMUNICATION_SCHEMA_CAPS_DEFAULT) {
  const aceptaTerminosAtSelect = schemaCaps.hasClientAceptaTerminosAt
    ? "c.acepta_terminos_at,"
    : "NULL::timestamptz AS acepta_terminos_at,";
  const consentimientoMarketingAtSelect = schemaCaps.hasClientConsentimientoMarketingAt
    ? "c.consentimiento_marketing_at,"
    : "NULL::timestamptz AS consentimiento_marketing_at,";
  return `
    WITH base_clientes AS (
      SELECT
        c.id_cliente,
        c.id_persona,
        c.id_usuario,
        c.estado AS cliente_activo,
        c.acepta_terminos,
        ${aceptaTerminosAtSelect}
        c.consentimiento_marketing,
        ${consentimientoMarketingAtSelect}
        p.nombres,
        p.apellidos,
        correo_principal.direccion_correo::text AS correo_destino
      FROM public.clientes c
      JOIN public.personas p
        ON p.id_persona = c.id_persona
       AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT cr.direccion_correo
        FROM public.correos cr
        WHERE cr.id_persona = c.id_persona
          AND cr.deleted_at IS NULL
        ORDER BY cr.es_principal DESC NULLS LAST, cr.verificado DESC NULLS LAST, cr.id_correo ASC
        LIMIT 1
      ) correo_principal ON TRUE
      WHERE c.deleted_at IS NULL
    ),
    evaluados AS (
      SELECT
        bc.*,
        COALESCE(bc.cliente_activo, FALSE) IS TRUE AS ok_activo,
        (COALESCE(bc.acepta_terminos, FALSE) IS TRUE OR bc.acepta_terminos_at IS NOT NULL) AS ok_terminos,
        (COALESCE(bc.consentimiento_marketing, FALSE) IS TRUE) AS ok_marketing,
        (
          bc.correo_destino IS NOT NULL
          AND btrim(bc.correo_destino) <> ''
          AND btrim(bc.correo_destino) ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$'
        ) AS ok_correo
      FROM base_clientes bc
    ),
    resultado AS (
      SELECT
        e.*,
        CASE
          WHEN NOT e.ok_activo THEN 'inactivo'
          WHEN NOT e.ok_correo THEN 'sin_correo'
          WHEN NOT e.ok_terminos THEN 'sin_aceptacion_terminos'
          WHEN NOT e.ok_marketing THEN 'sin_consentimiento_marketing'
          ELSE 'elegible'
        END AS estado_elegibilidad
      FROM evaluados e
    )
  `;
}

async function getCommunicationEligibilitySummaryPayload(client, campaignType, options = {}) {
  void campaignType;
  const schemaCaps = await getCommunicationSchemaCapabilities(client);
  const limitElegibles = Number.isFinite(Number(options.limit_elegibles))
    ? Math.max(1, Math.min(100, Number(options.limit_elegibles)))
    : 20;
  const limitExcluidos = Number.isFinite(Number(options.limit_excluidos))
    ? Math.max(1, Math.min(100, Number(options.limit_excluidos)))
    : 20;

  const summaryResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        COUNT(*)::int AS total_clientes_evaluados,
        COUNT(*) FILTER (WHERE estado_elegibilidad = 'elegible')::int AS total_elegibles,
        COUNT(*) FILTER (WHERE estado_elegibilidad <> 'elegible')::int AS total_excluidos,
        COUNT(*) FILTER (WHERE estado_elegibilidad = 'sin_correo')::int AS excluidos_sin_correo,
        COUNT(*) FILTER (WHERE estado_elegibilidad = 'inactivo')::int AS excluidos_inactivos,
        COUNT(*) FILTER (WHERE estado_elegibilidad = 'sin_aceptacion_terminos')::int AS excluidos_sin_aceptacion_terminos,
        COUNT(*) FILTER (WHERE estado_elegibilidad = 'sin_consentimiento_marketing')::int AS excluidos_sin_consentimiento_marketing
      FROM resultado
    `
  );

  const reasonsResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        estado_elegibilidad AS motivo,
        COUNT(*)::int AS total
      FROM resultado
      WHERE estado_elegibilidad <> 'elegible'
      GROUP BY estado_elegibilidad
      ORDER BY total DESC, estado_elegibilidad ASC
    `
  );

  const elegiblesPreviewResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        id_cliente,
        concat_ws(' ', NULLIF(btrim(nombres), ''), NULLIF(btrim(apellidos), '')) AS nombre_cliente,
        btrim(correo_destino) AS correo_destino
      FROM resultado
      WHERE estado_elegibilidad = 'elegible'
      ORDER BY nombre_cliente ASC NULLS LAST, id_cliente ASC
      LIMIT $1::int
    `,
    [limitElegibles]
  );

  const excluidosPreviewResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        id_cliente,
        concat_ws(' ', NULLIF(btrim(nombres), ''), NULLIF(btrim(apellidos), '')) AS nombre_cliente,
        CASE WHEN correo_destino IS NULL THEN NULL ELSE btrim(correo_destino) END AS correo_destino,
        estado_elegibilidad AS motivo_exclusion
      FROM resultado
      WHERE estado_elegibilidad <> 'elegible'
      ORDER BY motivo_exclusion ASC, nombre_cliente ASC NULLS LAST, id_cliente ASC
      LIMIT $1::int
    `,
    [limitExcluidos]
  );

  const summary = summaryResult.rows[0] || {};
  return {
    resumen: {
      total_clientes_evaluados: Number(summary.total_clientes_evaluados || 0),
      total_elegibles: Number(summary.total_elegibles || 0),
      total_excluidos: Number(summary.total_excluidos || 0),
      excluidos_sin_correo: Number(summary.excluidos_sin_correo || 0),
      excluidos_inactivos: Number(summary.excluidos_inactivos || 0),
      excluidos_sin_aceptacion_terminos: Number(summary.excluidos_sin_aceptacion_terminos || 0),
      excluidos_sin_consentimiento_marketing: Number(summary.excluidos_sin_consentimiento_marketing || 0),
    },
    exclusiones_por_motivo: reasonsResult.rows.map((row) => ({
      motivo: row.motivo,
      total: Number(row.total || 0),
    })),
    elegibles_preview: elegiblesPreviewResult.rows.map((row) => ({
      id_cliente: row.id_cliente,
      nombre_cliente: row.nombre_cliente || null,
      correo_destino: maskEmailAddress(row.correo_destino),
    })),
    excluidos_preview: excluidosPreviewResult.rows.map((row) => ({
      id_cliente: row.id_cliente,
      nombre_cliente: row.nombre_cliente || null,
      correo_destino: maskEmailAddress(row.correo_destino),
      motivo_exclusion: row.motivo_exclusion,
    })),
  };
}

async function listCommunicationEligibilityRecipients(client, campaignType, options = {}) {
  void campaignType;
  const schemaCaps = await getCommunicationSchemaCapabilities(client);
  const estado = String(options.estado || "elegible").trim().toLowerCase();
  if (!COMMUNICATION_ELIGIBILITY_STATES.includes(estado)) {
    throw new AppError(400, "estado de elegibilidad invalido", {
      code: "CONFIG_COMM_ELIGIBILITY_STATE_INVALID",
      details: { estado },
    });
  }

  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(100, Number(options.limit))) : 25;
  const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Math.min(10000, Number(options.offset))) : 0;
  const motivo = options.motivo ? String(options.motivo).trim().toLowerCase() : null;

  if (motivo && !COMMUNICATION_ELIGIBILITY_REASONS.includes(motivo)) {
    throw new AppError(400, "motivo de exclusion invalido", {
      code: "CONFIG_COMM_ELIGIBILITY_REASON_INVALID",
      details: { motivo },
    });
  }

  const reasonFilter = estado === "excluido" ? (motivo || null) : null;

  const listResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        id_cliente,
        concat_ws(' ', NULLIF(btrim(nombres), ''), NULLIF(btrim(apellidos), '')) AS nombre_cliente,
        CASE WHEN correo_destino IS NULL THEN NULL ELSE btrim(correo_destino) END AS correo_destino,
        estado_elegibilidad AS motivo_exclusion
      FROM resultado
      WHERE (
        ($1::text = 'elegible' AND estado_elegibilidad = 'elegible')
        OR ($1::text = 'excluido' AND estado_elegibilidad <> 'elegible')
      )
        AND ($2::text IS NULL OR estado_elegibilidad = $2::text)
      ORDER BY nombre_cliente ASC NULLS LAST, id_cliente ASC
      LIMIT $3::int
      OFFSET $4::int
    `,
    [estado, reasonFilter, limit, offset]
  );

  const totalResult = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT COUNT(*)::int AS total
      FROM resultado
      WHERE (
        ($1::text = 'elegible' AND estado_elegibilidad = 'elegible')
        OR ($1::text = 'excluido' AND estado_elegibilidad <> 'elegible')
      )
        AND ($2::text IS NULL OR estado_elegibilidad = $2::text)
    `,
    [estado, reasonFilter]
  );

  return {
    estado,
    motivo: reasonFilter,
    limit,
    offset,
    total: Number(totalResult.rows?.[0]?.total || 0),
    destinatarios: listResult.rows.map((row) => ({
      id_cliente: row.id_cliente,
      nombre_cliente: row.nombre_cliente || null,
      correo_destino: maskEmailAddress(row.correo_destino),
      motivo_exclusion: row.motivo_exclusion === "elegible" ? null : row.motivo_exclusion,
    })),
  };
}

function resolveScheduledAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "programada_para tiene formato invalido, usa fecha ISO", {
      code: "CONFIG_COMM_CAMPAIGN_SCHEDULE_DATE_INVALID",
    });
  }
  if (date.getTime() < Date.now()) {
    throw new AppError(400, "programada_para no puede estar en fecha/hora pasada", {
      code: "CONFIG_COMM_CAMPAIGN_SCHEDULE_DATE_PAST",
    });
  }
  return date.toISOString();
}

function parseExcludedClientIds(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const uniqueIds = new Set();
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id) continue;
    uniqueIds.add(id);
  }
  return Array.from(uniqueIds);
}

async function listEligibleRecipientsForScheduling(client, campaignType) {
  void campaignType;
  const schemaCaps = await getCommunicationSchemaCapabilities(client);
  const { rows } = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        id_cliente,
        id_persona,
        id_usuario,
        concat_ws(' ', NULLIF(btrim(nombres), ''), NULLIF(btrim(apellidos), '')) AS nombre_cliente,
        btrim(correo_destino) AS correo_destino
      FROM resultado
      WHERE estado_elegibilidad = 'elegible'
      ORDER BY id_cliente ASC
    `
  );
  return rows.map((row) => ({
    id_cliente: row.id_cliente,
    id_persona: row.id_persona,
    id_usuario: row.id_usuario ?? null,
    nombre_cliente: row.nombre_cliente || null,
    correo_destino: row.correo_destino,
  }));
}

async function listExcludedRecipientsForSnapshot(client, campaignType) {
  void campaignType;
  const schemaCaps = await getCommunicationSchemaCapabilities(client);
  const { rows } = await client.query(
    `
      ${buildEligibilityEvaluationCte(schemaCaps)}
      SELECT
        id_cliente,
        id_persona,
        concat_ws(' ', NULLIF(btrim(nombres), ''), NULLIF(btrim(apellidos), '')) AS nombre_cliente,
        correo_destino,
        estado_elegibilidad AS motivo_exclusion
      FROM resultado
      WHERE estado_elegibilidad <> 'elegible'
      ORDER BY estado_elegibilidad ASC, nombre_cliente ASC NULLS LAST, id_cliente ASC
    `
  );

  return rows.map((row) => ({
    id_cliente: row.id_cliente,
    id_persona: row.id_persona,
    nombre_cliente: row.nombre_cliente || null,
    correo_destino: row.correo_destino || null,
    motivo_exclusion: row.motivo_exclusion,
    origen_exclusion: "regla",
  }));
}

function buildCommunicationExclusionsSnapshot({ campaignType, excludedByRules = [], excludedByManual = [] }) {
  const allExclusions = [...excludedByRules, ...excludedByManual];
  const summaryMap = new Map();
  for (const row of allExclusions) {
    const key = String(row?.motivo_exclusion || "sin_motivo").trim().toLowerCase() || "sin_motivo";
    summaryMap.set(key, Number(summaryMap.get(key) || 0) + 1);
  }

  return {
    generado_at: new Date().toISOString(),
    tipo_campania: campaignType,
    excluidos: allExclusions.map((row) => ({
      nombre_cliente: row.nombre_cliente ?? null,
      correo_destino: maskEmailAddress(row.correo_destino),
      motivo_exclusion: row.motivo_exclusion ?? null,
      origen_exclusion: row.origen_exclusion ?? null,
    })),
    resumen_por_motivo: Array.from(summaryMap.entries()).map(([motivo, total]) => ({
      motivo,
      total,
    })),
  };
}

async function listCampaignShipments(client, idCampania, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(100, Number(options.limit))) : 50;
  const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Math.min(10000, Number(options.offset))) : 0;

  const rowsResult = await client.query(
    `
      SELECT
        ce.id_envio,
        ce.correo_destino::text AS correo_destino,
        ce.estado_envio,
        ce.enviar_en,
        ce.enviado_at,
        ce.ultimo_error,
        ce.intentos,
        ce.created_at,
        concat_ws(' ', NULLIF(btrim(p.nombres), ''), NULLIF(btrim(p.apellidos), '')) AS nombre_cliente
      FROM public.comunicaciones_envios ce
      LEFT JOIN public.personas p
        ON p.id_persona = ce.id_persona
      WHERE ce.id_campania = $1::uuid
      ORDER BY ce.created_at DESC, ce.id_envio DESC
      LIMIT $2::int
      OFFSET $3::int
    `,
    [idCampania, limit, offset]
  );

  const totalResult = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.comunicaciones_envios
      WHERE id_campania = $1::uuid
    `,
    [idCampania]
  );

  return {
    limit,
    offset,
    total: Number(totalResult.rows?.[0]?.total || 0),
    envios: rowsResult.rows.map((row) => ({
      id_envio: row.id_envio,
      nombre_cliente: row.nombre_cliente || null,
      correo_destino: maskEmailAddress(row.correo_destino),
      estado_envio: row.estado_envio,
      enviar_en: row.enviar_en ?? null,
      enviado_at: row.enviado_at ?? null,
      ultimo_error: row.ultimo_error ?? null,
      intentos: Number(row.intentos ?? 0),
      created_at: row.created_at ?? null,
    })),
  };
}

async function tryAcquireCommunicationSendLock(client, campaignId) {
  const { rows } = await client.query(
    `
      SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS locked
    `,
    [COMMUNICATION_SEND_LOCK_NAMESPACE, String(campaignId)]
  );
  return rows?.[0]?.locked === true;
}

async function releaseCommunicationSendLock(client, campaignId) {
  await client.query(
    `
      SELECT pg_advisory_unlock($1::int, hashtext($2::text))
    `,
    [COMMUNICATION_SEND_LOCK_NAMESPACE, String(campaignId)]
  );
}

function normalizeCommunicationSendError(rawValue) {
  const message = String(rawValue || "").trim();
  if (!message) return "No se pudo enviar el correo";
  return message.slice(0, COMMUNICATION_SEND_ERROR_MAX_LENGTH);
}

function escapeHtmlForEmail(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildCommunicationCampaignEmailPayload(campaign = {}, recipientFullName = null) {
  const normalizedSubject = String(campaign?.asunto || "Comunicado MasterFade").trim() || "Comunicado MasterFade";
  const normalizedRecipientName = String(recipientFullName || "").trim();
  const greetingText = normalizedRecipientName ? `Hola ${normalizedRecipientName},` : "Hola,";
  const bodyLines = String(campaign?.contenido_texto || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const contentParagraphs = bodyLines.length > 0 ? bodyLines : ["Tenemos una actualización importante para ti."];
  const bodyHtml = contentParagraphs
    .map(
      (line) =>
        `<p style="margin:0 0 14px;color:#d9dce4;font-size:15px;line-height:1.7;">${escapeHtmlForEmail(line)}</p>`
    )
    .join("");

  const bannerHtml = COMMUNICATION_EMAIL_BANNER_URL
    ? `
      <div style="margin:0 0 20px;border-radius:14px;overflow:hidden;border:1px solid #2b2f3f;">
        <img src="${escapeHtmlForEmail(COMMUNICATION_EMAIL_BANNER_URL)}" alt="MasterFade Banner" style="display:block;width:100%;height:auto;" />
      </div>
    `
    : "";

  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtmlForEmail(normalizedSubject)}</title>
      </head>
      <body style="margin:0;padding:0;background:#0b0d12;font-family:Inter,Segoe UI,Arial,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;background:#0b0d12;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#141722;border:1px solid #2b2f3f;border-radius:18px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 24px;background:linear-gradient(135deg,#1c2234 0%,#131722 50%,#2f2614 100%);border-bottom:1px solid #2b2f3f;">
                    <p style="margin:0;color:#f1f4fa;font-size:12px;letter-spacing:0.28em;text-transform:uppercase;">MasterFade</p>
                    <h1 style="margin:10px 0 0;color:#f8f9fb;font-size:24px;line-height:1.25;">${escapeHtmlForEmail(normalizedSubject)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:22px 24px 26px;">
                    ${bannerHtml}
                    <p style="margin:0 0 14px;color:#f4f6fb;font-size:16px;font-weight:600;">${escapeHtmlForEmail(greetingText)}</p>
                    ${bodyHtml}
                    <p style="margin:18px 0 0;color:#d9dce4;font-size:14px;line-height:1.6;">
                      Este correo es informativo y fue enviado por el equipo de MasterFade.
                    </p>
                    <p style="margin:8px 0 0;color:#97a0b8;font-size:12px;line-height:1.5;">
                      Si tienes dudas, escríbenos a <a href="mailto:soporte@masterfadeapp.com" style="color:#d4b068;text-decoration:none;">soporte@masterfadeapp.com</a>.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = [`${normalizedSubject}`, "", ...contentParagraphs, "", "Soporte: soporte@masterfadeapp.com", "MasterFade"].join("\n");
  return { subject: normalizedSubject, html, text };
}

async function listCampaignShipmentsByStatus(client, campaignId, status, options = {}) {
  const dueOnly = options?.dueOnly === true;
  const { rows } = await client.query(
    `
      SELECT
        ce.id_envio,
        ce.correo_destino::text AS correo_destino,
        concat_ws(' ', NULLIF(btrim(p.nombres), ''), NULLIF(btrim(p.apellidos), '')) AS nombre_cliente
      FROM public.comunicaciones_envios ce
      LEFT JOIN public.personas p
        ON p.id_persona = ce.id_persona
      WHERE ce.id_campania = $1::uuid
        AND ce.estado_envio = $2::text
        AND ($3::boolean IS FALSE OR ce.enviar_en <= NOW())
      ORDER BY ce.created_at ASC, ce.id_envio ASC
    `,
    [campaignId, status, dueOnly]
  );
  return Array.isArray(rows) ? rows : [];
}

async function processCampaignShipmentsDelivery(client, mailer, campaign, sourceStatus, options = {}) {
  const rows = await listCampaignShipmentsByStatus(client, campaign.id_campania, sourceStatus, options);
  let totalIntentados = 0;
  let totalExitosos = 0;
  let totalFallidos = 0;

  for (const row of rows) {
    totalIntentados += 1;
    const emailPayload = buildCommunicationCampaignEmailPayload(campaign, row.nombre_cliente);
    const mailResult = await mailer.sendMail({
      to: row.correo_destino,
      from: COMMUNICATION_EMAIL_FROM_ADDRESS,
      subject: emailPayload.subject,
      text: emailPayload.text,
      html: emailPayload.html,
    });

    if (mailResult?.sent) {
      totalExitosos += 1;
      await client.query(
        `
          UPDATE public.comunicaciones_envios
          SET
            estado_envio = $2::text,
            enviado_at = NOW(),
            ultimo_error = NULL,
            provider_message_id = $3::text,
            intentos = COALESCE(intentos, 0) + 1,
            updated_at = NOW()
          WHERE id_envio = $1::uuid
        `,
        [row.id_envio, COMMUNICATION_SEND_STATUS_SENT, mailResult?.provider_message_id ?? null]
      );
    } else {
      totalFallidos += 1;
      await client.query(
        `
          UPDATE public.comunicaciones_envios
          SET
            estado_envio = $2::text,
            ultimo_error = $3::text,
            intentos = COALESCE(intentos, 0) + 1,
            updated_at = NOW()
          WHERE id_envio = $1::uuid
        `,
        [row.id_envio, COMMUNICATION_SEND_STATUS_FAILED, normalizeCommunicationSendError(mailResult?.message)]
      );
    }
  }

  return { totalIntentados, totalExitosos, totalFallidos };
}

async function refreshCommunicationCampaignMetrics(client, campaignId, actorUserId) {
  const countersResult = await client.query(
    `
      SELECT
        COUNT(*)::int AS total_destinatarios,
        COUNT(*) FILTER (WHERE estado_envio = $2::text)::int AS total_pendientes,
        COUNT(*) FILTER (WHERE estado_envio = $3::text)::int AS total_enviados,
        COUNT(*) FILTER (WHERE estado_envio = $4::text)::int AS total_fallidos
      FROM public.comunicaciones_envios
      WHERE id_campania = $1::uuid
    `,
    [campaignId, COMMUNICATION_SEND_STATUS_PENDING, COMMUNICATION_SEND_STATUS_SENT, COMMUNICATION_SEND_STATUS_FAILED]
  );
  const counters = countersResult.rows?.[0] || {};

  const updatedResult = await client.query(
    `
      UPDATE public.comunicaciones_campanias
      SET
        total_destinatarios = $2::int,
        total_pendientes = $3::int,
        total_enviados = $4::int,
        total_fallidos = $5::int,
        enviada_at = CASE
          WHEN $4::int > 0 THEN COALESCE(enviada_at, NOW())
          ELSE enviada_at
        END,
        finalizada_at = CASE
          WHEN $3::int = 0 AND $5::int = 0 THEN COALESCE(finalizada_at, NOW())
          ELSE NULL
        END,
        actualizada_por = $6::uuid,
        updated_at = NOW()
      WHERE id_campania = $1::uuid
        AND deleted_at IS NULL
      RETURNING
        id_campania,
        estado,
        total_destinatarios,
        total_pendientes,
        total_enviados,
        total_fallidos,
        programada_para,
        finalizada_at
    `,
    [
      campaignId,
      Number(counters.total_destinatarios || 0),
      Number(counters.total_pendientes || 0),
      Number(counters.total_enviados || 0),
      Number(counters.total_fallidos || 0),
      actorUserId,
    ]
  );

  return updatedResult.rows?.[0] || null;
}

async function listDueCampaignIdsForAutomaticDispatch(client, limit = COMMUNICATION_SCHEDULER_MAX_CAMPAIGNS_PER_TICK) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || COMMUNICATION_SCHEDULER_MAX_CAMPAIGNS_PER_TICK));
  const { rows } = await client.query(
    `
      SELECT ce.id_campania
      FROM public.comunicaciones_envios ce
      JOIN public.comunicaciones_campanias cc
        ON cc.id_campania = ce.id_campania
      WHERE cc.deleted_at IS NULL
        AND cc.estado = $1::text
        AND ce.estado_envio = $2::text
        AND ce.enviar_en <= NOW()
      GROUP BY ce.id_campania
      ORDER BY MIN(ce.enviar_en) ASC
      LIMIT $3::int
    `,
    [COMMUNICATION_CAMPAIGN_SCHEDULED_STATE, COMMUNICATION_SEND_STATUS_PENDING, safeLimit]
  );
  return rows.map((row) => row.id_campania);
}

async function runCommunicationScheduledDispatchTick(app) {
  if (!app.mailer?.configured) return;
  const client = await app.db.connect();
  try {
    const campaignIds = await listDueCampaignIdsForAutomaticDispatch(client);
    for (const campaignId of campaignIds) {
      let lockAcquired = false;
      try {
        lockAcquired = await tryAcquireCommunicationSendLock(client, campaignId);
        if (!lockAcquired) continue;

        const campaign = await getCommunicationCampaignById(client, campaignId);
        if (!campaign) continue;
        const campaignState = String(campaign.estado || "").trim().toLowerCase();
        if (campaignState !== COMMUNICATION_CAMPAIGN_SCHEDULED_STATE) continue;

        const asunto = normalizeCommunicationRequiredText(campaign.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH);
        const contenidoTexto = normalizeCommunicationRequiredText(campaign.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH);
        const delivery = await processCampaignShipmentsDelivery(
          client,
          app.mailer,
          { ...campaign, asunto, contenido_texto: contenidoTexto },
          COMMUNICATION_SEND_STATUS_PENDING,
          { dueOnly: true }
        );
        if (delivery.totalIntentados <= 0) continue;

        const actorUserId = campaign.actualizada_por || campaign.creada_por;
        if (actorUserId) {
          await refreshCommunicationCampaignMetrics(client, campaignId, actorUserId);
        }
      } catch (error) {
        app.log.error({ err: error, campaignId }, "No se pudo procesar envio automatico programado");
      } finally {
        if (lockAcquired) {
          await releaseCommunicationSendLock(client, campaignId).catch(() => {});
        }
      }
    }
  } finally {
    client.release();
  }
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
    imagen_principal_asset_id: row.imagen_principal_asset_id ?? null,
    imagen_principal_path: row.imagen_principal_path ?? null,
    imagen_principal_url: row.imagen_principal_url ?? null,
    imagen_mobile_asset_id: row.imagen_mobile_asset_id ?? null,
    imagen_mobile_path: row.imagen_mobile_path ?? null,
    imagen_mobile_url: row.imagen_mobile_url ?? null,
    imagen_alt: row.imagen_alt ?? null,
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
        p.imagen_principal_asset_id,
        p.imagen_principal_path,
        p.imagen_principal_url,
        p.imagen_mobile_asset_id,
        p.imagen_mobile_path,
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
        p.imagen_principal_asset_id,
        p.imagen_principal_path,
        p.imagen_principal_url,
        p.imagen_mobile_asset_id,
        p.imagen_mobile_path,
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

  if (!Array.isArray(values.parrafos) || values.parrafos.length === 0) {
    throw new AppError(400, "La descripcion es requerida", {
      code: "CONFIG_PROMOTION_DESCRIPTION_REQUIRED",
    });
  }

  if (values.estado === "archivada" && values.visible_publico) {
    throw new AppError(400, "Una promocion archivada no puede estar visible_publico=true", {
      code: "CONFIG_PROMOTION_ARCHIVED_VISIBILITY_INVALID",
    });
  }

  if (values.estado === "publicada") {
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
    request.log.warn({ err: error, code: error.code }, "Operacion de configuracion controlada con error de negocio");
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      requestId: request.id,
    });
  }

  if (
    error?.code === "42P01" &&
    (String(error?.message || "").includes("promociones_sucursal") || String(error?.message || "").includes("promociones"))
  ) {
    request.log.error({ err: error }, "Migracion de promociones faltante en modulo configuracion");
    return sendError(reply, 500, "Falta aplicar migracion de PROMOCIONES multi-sucursal en la base de datos", {
      code: "CONFIG_PROMOTIONS_MIGRATION_REQUIRED",
      requestId: request.id,
    });
  }

  if (
    error?.code === "42P01" &&
    (String(error?.message || "").includes("comunicaciones_campanias") || String(error?.message || "").includes("comunicaciones_envios"))
  ) {
    request.log.error({ err: error }, "Migracion de comunicacion faltante");
    return sendError(reply, 500, "Falta aplicar la estructura de COMUNICACION en la base de datos", {
      code: "CONFIG_COMMUNICATION_MIGRATION_REQUIRED",
      requestId: request.id,
    });
  }

  if (
    (error?.code === "42P01" || error?.code === "42703") &&
    (
      String(error?.message || "").includes("storage_assets")
      || String(error?.message || "").includes("imagen_principal_asset_id")
      || String(error?.message || "").includes("imagen_mobile_asset_id")
      || String(error?.message || "").includes("imagen_principal_path")
      || String(error?.message || "").includes("imagen_mobile_path")
    )
  ) {
    request.log.error({ err: error }, "Migracion de storage faltante para promociones");
    return sendError(reply, 500, "Falta aplicar migracion de STORAGE para promociones", {
      code: "CONFIG_STORAGE_MIGRATION_REQUIRED",
      requestId: request.id,
    });
  }

  if (
    error?.code === "23505" &&
    (String(error?.constraint || "").includes("uq_comunicaciones_envios_campania_cliente_correo") ||
      String(error?.message || "").includes("uq_comunicaciones_envios_campania_cliente_correo"))
  ) {
    request.log.warn({ err: error }, "Campania ya programada detectada por constraint");
    return sendError(reply, 409, "La campania ya tiene destinatarios programados y no puede duplicarse", {
      code: "CONFIG_COMM_CAMPAIGN_ALREADY_SCHEDULED",
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, fallbackMessage);
  return sendError(reply, 500, fallbackMessage, {
    code: fallbackCode,
    requestId: request.id,
  });
}

export default async function adminConfiguracionRoutes(app) {
  const schedulerEnabled = String(process.env.COMMUNICATION_SCHEDULER_ENABLED || "true").trim().toLowerCase() !== "false";
  if (schedulerEnabled) {
    const schedulerIntervalMs = Math.max(15000, Number(process.env.COMMUNICATION_SCHEDULER_INTERVAL_MS || COMMUNICATION_SCHEDULER_INTERVAL_MS_DEFAULT));
    const schedulerTimer = setInterval(() => {
      runCommunicationScheduledDispatchTick(app).catch((error) => {
        app.log.error({ err: error }, "Fallo en scheduler de comunicacion");
      });
    }, schedulerIntervalMs);
    schedulerTimer.unref?.();
    app.addHook("onClose", async () => {
      clearInterval(schedulerTimer);
    });
    app.log.info({ schedulerIntervalMs }, "Scheduler de comunicacion habilitado");
  }

  app.get(
    "/comunicacion/campanias",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        querystring: communicationCampaignsQuerySchema,
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
        const payload = await listCommunicationCampaigns(client, request.query || {});
        return sendOk(reply, payload, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudieron consultar campanias de comunicacion", "CONFIG_COMM_CAMPAIGNS_LIST_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/comunicacion/campanias",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        body: communicationCampaignCreateSchema,
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
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      try {
        const schemaCaps = await getCommunicationSchemaCapabilities(client);
        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para crear la campania", {
            code: "CONFIG_COMM_CAMPAIGN_ACTOR_REQUIRED",
          });
        }

        const values = buildCommunicationCampaignCreateValues(request.body || {});
        const result = await client.query(
          `
            INSERT INTO public.comunicaciones_campanias (
              tipo_campania,
              canal,
              nombre_interno,
              asunto,
              contenido_texto,
              observaciones,
              estado,
              creada_por,
              actualizada_por,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $8::uuid, NOW())
            RETURNING
              ${buildCommunicationCampaignSelectColumns(schemaCaps)}
          `,
          [
            values.tipo_campania,
            COMMUNICATION_CAMPAIGN_CHANNEL,
            values.nombre_interno,
            values.asunto,
            values.contenido_texto,
            values.observaciones,
            COMMUNICATION_CAMPAIGN_DRAFT_STATE,
            actorUserId,
          ]
        );

        return sendOk(reply, { campania: mapCommunicationCampaignRow(result.rows[0]) }, { statusCode: 201, requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo crear la campania de comunicacion", "CONFIG_COMM_CAMPAIGN_CREATE_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/comunicacion/campanias/:id",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
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
        const schemaCaps = await getCommunicationSchemaCapabilities(client);
        const row = await getCommunicationCampaignById(client, request.params.id, schemaCaps);
        if (!row) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(row);
        return sendOk(reply, { campania: mapCommunicationCampaignRow(row) }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar la campania de comunicacion", "CONFIG_COMM_CAMPAIGN_DETAIL_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.patch(
    "/comunicacion/campanias/:id",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        body: communicationCampaignPatchSchema,
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
        const schemaCaps = await getCommunicationSchemaCapabilities(client);
        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para editar la campania", {
            code: "CONFIG_COMM_CAMPAIGN_ACTOR_REQUIRED",
          });
        }

        await client.query("BEGIN");
        const currentRow = await getCommunicationCampaignById(client, request.params.id, schemaCaps);
        if (!currentRow) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(currentRow);

        if (String(currentRow.estado || "").trim().toLowerCase() !== COMMUNICATION_CAMPAIGN_DRAFT_STATE) {
          throw new AppError(409, "Solo se pueden editar campanias en estado borrador en esta etapa", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_DRAFT",
            details: { estado_actual: currentRow.estado },
          });
        }

        const values = buildCommunicationCampaignPatchValues(request.body || {}, currentRow);
        const updatedResult = await client.query(
          `
            UPDATE public.comunicaciones_campanias
            SET
              tipo_campania = $2,
              nombre_interno = $3,
              asunto = $4,
              contenido_texto = $5,
              observaciones = $6,
              actualizada_por = $7::uuid,
              updated_at = NOW()
            WHERE id_campania = $1::uuid
              AND deleted_at IS NULL
            RETURNING
              ${buildCommunicationCampaignSelectColumns(schemaCaps)}
          `,
          [request.params.id, values.tipo_campania, values.nombre_interno, values.asunto, values.contenido_texto, values.observaciones, actorUserId]
        );

        if (!updatedResult.rows[0]) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }

        await client.query("COMMIT");
        return sendOk(reply, { campania: mapCommunicationCampaignRow(updatedResult.rows[0]) }, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo actualizar la campania de comunicacion", "CONFIG_COMM_CAMPAIGN_UPDATE_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/comunicacion/campanias/:id/elegibilidad",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        querystring: communicationEligibilitySummaryQuerySchema,
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
        const campaign = await getCommunicationCampaignById(client, request.params.id);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const campaignType = resolveCampaignTypeForEligibility(campaign.tipo_campania);
        const payload = await getCommunicationEligibilitySummaryPayload(client, campaignType, request.query || {});

        return sendOk(reply, {
          id_campania: campaign.id_campania,
          tipo_campania: campaignType,
          canal: campaign.canal,
          estado: campaign.estado,
          simulacion: true,
          ...payload,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo calcular la elegibilidad de la campania", "CONFIG_COMM_CAMPAIGN_ELIGIBILITY_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/comunicacion/campanias/:id/elegibilidad/destinatarios",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        querystring: communicationEligibilityRecipientsQuerySchema,
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
        const campaign = await getCommunicationCampaignById(client, request.params.id);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const campaignType = resolveCampaignTypeForEligibility(campaign.tipo_campania);
        const payload = await listCommunicationEligibilityRecipients(client, campaignType, request.query || {});

        return sendOk(reply, {
          id_campania: campaign.id_campania,
          tipo_campania: campaignType,
          simulacion: true,
          ...payload,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo consultar destinatarios de elegibilidad", "CONFIG_COMM_CAMPAIGN_ELIGIBILITY_RECIPIENTS_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/comunicacion/campanias/:id/programar",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        body: communicationCampaignScheduleBodySchema,
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
        const schemaCaps = await getCommunicationSchemaCapabilities(client);
        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para programar la campania", {
            code: "CONFIG_COMM_CAMPAIGN_ACTOR_REQUIRED",
          });
        }

        const scheduledAt = resolveScheduledAt(request.body?.programada_para);
        const excludedClientIds = parseExcludedClientIds(request.body?.id_clientes_excluidos);
        const effectiveSendAt = scheduledAt || new Date(Date.now() + COMMUNICATION_FALLBACK_SEND_DELAY_MINUTES * 60 * 1000).toISOString();

        await client.query("BEGIN");
        const campaign = await getCommunicationCampaignByIdForUpdate(client, request.params.id);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const existingShipmentsResult = await client.query(
          `
            SELECT COUNT(*)::int AS total
            FROM public.comunicaciones_envios
            WHERE id_campania = $1::uuid
          `,
          [campaign.id_campania]
        );
        const existingShipments = Number(existingShipmentsResult.rows?.[0]?.total || 0);
        const campaignState = String(campaign.estado || "").trim().toLowerCase();

        if (campaignState !== COMMUNICATION_CAMPAIGN_DRAFT_STATE) {
          if (campaignState === COMMUNICATION_CAMPAIGN_SCHEDULED_STATE && existingShipments > 0) {
            await client.query("COMMIT");
            return sendOk(reply, {
              id_campania: campaign.id_campania,
              estado: campaign.estado,
              programada_para: campaign.programada_para ?? null,
              total_destinatarios_programados: Number(campaign.total_destinatarios || existingShipments || 0),
              total_elegibles_detectados: Number(campaign.total_destinatarios || existingShipments || 0),
              total_excluidos_detectados: Number(campaign.total_omitidos || 0),
              ya_programada: true,
            }, { requestId: request.id });
          }

          throw new AppError(409, "Solo se puede programar una campania en estado borrador", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_DRAFT_FOR_SCHEDULE",
            details: { estado_actual: campaign.estado },
          });
        }

        if (existingShipments > 0) {
          throw new AppError(409, "La campania ya tiene envios programados y no puede duplicarse en esta etapa", {
            code: "CONFIG_COMM_CAMPAIGN_ALREADY_SCHEDULED",
            details: { envios_existentes: existingShipments },
          });
        }

        const campaignType = resolveCampaignTypeForEligibility(campaign.tipo_campania);
        const asunto = normalizeCommunicationRequiredText(campaign.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH);
        const contenidoTexto = normalizeCommunicationRequiredText(campaign.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH);
        if (!asunto || !contenidoTexto) {
          throw new AppError(400, "La campania debe tener asunto y contenido validos para programarse", {
            code: "CONFIG_COMM_CAMPAIGN_CONTENT_REQUIRED",
          });
        }

        const summaryPayload = await getCommunicationEligibilitySummaryPayload(client, campaignType, {
          limit_elegibles: 1,
          limit_excluidos: 1,
        });

        const totalElegibles = Number(summaryPayload?.resumen?.total_elegibles || 0);
        const totalExcluidos = Number(summaryPayload?.resumen?.total_excluidos || 0);
        if (totalElegibles <= 0) {
          throw new AppError(409, "No hay destinatarios elegibles para programar esta campania", {
            code: "CONFIG_COMM_CAMPAIGN_NO_ELIGIBLE_RECIPIENTS",
            details: { total_excluidos: totalExcluidos },
          });
        }

        const eligibleRecipients = await listEligibleRecipientsForScheduling(client, campaignType);
        const excludedByRules = await listExcludedRecipientsForSnapshot(client, campaignType);
        if (!eligibleRecipients.length) {
          throw new AppError(409, "No hay destinatarios elegibles para programar esta campania", {
            code: "CONFIG_COMM_CAMPAIGN_NO_ELIGIBLE_RECIPIENTS",
          });
        }

        const excludedSet = new Set(excludedClientIds.map((id) => String(id)));
        const recipientsToSchedule = eligibleRecipients.filter((recipient) => !excludedSet.has(String(recipient.id_cliente)));
        const manualExcludedCount = eligibleRecipients.length - recipientsToSchedule.length;
        const manuallyExcludedRecipients = eligibleRecipients
          .filter((recipient) => excludedSet.has(String(recipient.id_cliente)))
          .map((recipient) => ({
            id_cliente: recipient.id_cliente,
            id_persona: recipient.id_persona ?? null,
            nombre_cliente: recipient.nombre_cliente ?? null,
            correo_destino: recipient.correo_destino || null,
            motivo_exclusion: COMMUNICATION_MANUAL_EXCLUSION_REASON,
            origen_exclusion: "manual",
          }));
        if (!recipientsToSchedule.length) {
          throw new AppError(409, "No hay destinatarios elegibles luego de aplicar exclusiones manuales", {
            code: "CONFIG_COMM_CAMPAIGN_NO_ELIGIBLE_AFTER_EXCLUSIONS",
            details: { total_excluidos_manuales: manualExcludedCount },
          });
        }

        for (const recipient of recipientsToSchedule) {
          await client.query(
            `
              INSERT INTO public.comunicaciones_envios (
                id_campania,
                id_cliente,
                id_persona,
                id_usuario_destino,
                correo_destino,
                estado_envio,
                intentos,
                enviar_en,
                updated_at
              )
              VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 0, $7::timestamptz, NOW())
            `,
            [
              campaign.id_campania,
              recipient.id_cliente,
              recipient.id_persona,
              recipient.id_usuario,
              recipient.correo_destino,
              COMMUNICATION_SEND_STATUS_PENDING,
              effectiveSendAt,
            ]
          );
        }

        const totalExcluidosConAjustes = totalExcluidos + manualExcludedCount;
        const exclusionsSnapshot = buildCommunicationExclusionsSnapshot({
          campaignType,
          excludedByRules,
          excludedByManual: manuallyExcludedRecipients,
        });
        const updatedCampaignResult = await client.query(
          `
            UPDATE public.comunicaciones_campanias
            SET
              estado = 'programada',
              programada_para = $2::timestamptz,
              total_destinatarios = $3::int,
              total_pendientes = $3::int,
              total_enviados = 0,
              total_fallidos = 0,
              total_omitidos = $4::int,
              ${schemaCaps.hasCampaignExclusionsSnapshot ? "exclusiones_snapshot = $5::jsonb," : ""}
              actualizada_por = $6::uuid,
              updated_at = NOW()
            WHERE id_campania = $1::uuid
              AND deleted_at IS NULL
            RETURNING
              id_campania,
              estado,
              programada_para,
              total_destinatarios,
              total_pendientes,
              total_enviados,
              total_fallidos,
              total_omitidos,
              ${schemaCaps.hasCampaignExclusionsSnapshot ? "exclusiones_snapshot" : "NULL::jsonb AS exclusiones_snapshot"}
          `,
          [
            campaign.id_campania,
            scheduledAt,
            recipientsToSchedule.length,
            totalExcluidosConAjustes,
            JSON.stringify(exclusionsSnapshot),
            actorUserId,
          ]
        );

        await client.query("COMMIT");

        const updatedCampaign = updatedCampaignResult.rows[0] || {};
        return sendOk(reply, {
          id_campania: updatedCampaign.id_campania || campaign.id_campania,
          estado: updatedCampaign.estado || COMMUNICATION_CAMPAIGN_SCHEDULED_STATE,
          programada_para: updatedCampaign.programada_para ?? null,
          total_destinatarios_programados: Number(recipientsToSchedule.length),
          total_elegibles_detectados: Number(totalElegibles),
          total_excluidos_detectados: Number(totalExcluidosConAjustes),
          total_excluidos_manuales: Number(manualExcludedCount),
          ya_programada: false,
        }, { requestId: request.id });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return sendHandledError(reply, request, error, "No se pudo programar la campania", "CONFIG_COMM_CAMPAIGN_SCHEDULE_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.post(
    "/comunicacion/campanias/:id/enviar",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      const campaignId = request.params.id;
      let lockAcquired = false;

      try {
        if (!app.mailer?.configured) {
          throw new AppError(503, "Servicio SMTP no configurado para envio real de campanias", {
            code: "CONFIG_COMM_CAMPAIGN_SEND_SMTP_DISABLED",
          });
        }

        lockAcquired = await tryAcquireCommunicationSendLock(client, campaignId);
        if (!lockAcquired) {
          throw new AppError(409, "Ya hay un envio en ejecucion para esta campania", {
            code: "CONFIG_COMM_CAMPAIGN_SEND_IN_PROGRESS",
          });
        }

        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para enviar la campania", {
            code: "CONFIG_COMM_CAMPAIGN_SEND_ACTOR_REQUIRED",
          });
        }

        const campaign = await getCommunicationCampaignById(client, campaignId);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const campaignState = String(campaign.estado || "").trim().toLowerCase();
        if (campaignState !== COMMUNICATION_CAMPAIGN_SCHEDULED_STATE) {
          throw new AppError(409, "Solo se puede enviar una campania en estado programada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_SCHEDULED_FOR_SEND",
            details: { estado_actual: campaign.estado },
          });
        }

        const asunto = normalizeCommunicationRequiredText(campaign.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH);
        const contenidoTexto = normalizeCommunicationRequiredText(campaign.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH);

        const pendingRows = await listCampaignShipmentsByStatus(client, campaignId, COMMUNICATION_SEND_STATUS_PENDING);
        if (!pendingRows.length) {
          throw new AppError(409, "La campania no tiene envios pendientes para ejecutar", {
            code: "CONFIG_COMM_CAMPAIGN_NO_PENDING_SENDS",
          });
        }

        const delivery = await processCampaignShipmentsDelivery(client, app.mailer, {
          ...campaign,
          asunto,
          contenido_texto: contenidoTexto,
        }, COMMUNICATION_SEND_STATUS_PENDING);
        const updatedCampaign = await refreshCommunicationCampaignMetrics(client, campaignId, actorUserId) || campaign;
        return sendOk(reply, {
          id_campania: updatedCampaign.id_campania,
          estado_campania_resultante: updatedCampaign.estado,
          total_intentados: delivery.totalIntentados,
          total_enviados_exitosos: delivery.totalExitosos,
          total_fallidos: delivery.totalFallidos,
          total_pendientes_restantes: Number(updatedCampaign.total_pendientes || 0),
          total_destinatarios_programados: Number(updatedCampaign.total_destinatarios || 0),
          programada_para: updatedCampaign.programada_para ?? null,
          finalizada_at: updatedCampaign.finalizada_at ?? null,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo ejecutar el envio real de la campania", "CONFIG_COMM_CAMPAIGN_SEND_ERROR");
      } finally {
        if (lockAcquired) {
          await releaseCommunicationSendLock(client, campaignId).catch(() => {});
        }
        client.release();
      }
    }
  );

  app.post(
    "/comunicacion/campanias/:id/reintentar-fallidos",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const client = await app.db.connect();
      const campaignId = request.params.id;
      let lockAcquired = false;

      try {
        if (!app.mailer?.configured) {
          throw new AppError(503, "Servicio SMTP no configurado para reintento de fallidos", {
            code: "CONFIG_COMM_CAMPAIGN_RETRY_SMTP_DISABLED",
          });
        }

        lockAcquired = await tryAcquireCommunicationSendLock(client, campaignId);
        if (!lockAcquired) {
          throw new AppError(409, "Ya hay una ejecucion activa para esta campania", {
            code: "CONFIG_COMM_CAMPAIGN_RETRY_IN_PROGRESS",
          });
        }

        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para reintentar fallidos", {
            code: "CONFIG_COMM_CAMPAIGN_RETRY_ACTOR_REQUIRED",
          });
        }

        const campaign = await getCommunicationCampaignById(client, campaignId);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const campaignState = String(campaign.estado || "").trim().toLowerCase();
        if (campaignState !== COMMUNICATION_CAMPAIGN_SCHEDULED_STATE) {
          throw new AppError(409, "Solo se pueden reintentar fallidos en campanias programadas", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_SCHEDULED_FOR_RETRY",
            details: { estado_actual: campaign.estado },
          });
        }

        const failedRows = await listCampaignShipmentsByStatus(client, campaignId, COMMUNICATION_SEND_STATUS_FAILED);
        if (!failedRows.length) {
          throw new AppError(409, "La campania no tiene envios fallidos para reintentar", {
            code: "CONFIG_COMM_CAMPAIGN_NO_FAILED_SENDS",
          });
        }

        const asunto = normalizeCommunicationRequiredText(campaign.asunto, "asunto", COMMUNICATION_SUBJECT_MAX_LENGTH);
        const contenidoTexto = normalizeCommunicationRequiredText(campaign.contenido_texto, "contenido_texto", COMMUNICATION_CONTENT_TEXT_MAX_LENGTH);

        const retryResult = await processCampaignShipmentsDelivery(client, app.mailer, {
          ...campaign,
          asunto,
          contenido_texto: contenidoTexto,
        }, COMMUNICATION_SEND_STATUS_FAILED);
        const updatedCampaign = await refreshCommunicationCampaignMetrics(client, campaignId, actorUserId) || campaign;

        return sendOk(reply, {
          id_campania: updatedCampaign.id_campania,
          estado_campania_resultante: updatedCampaign.estado,
          total_intentados: retryResult.totalIntentados,
          total_recuperados_exitosos: retryResult.totalExitosos,
          total_siguen_fallando: retryResult.totalFallidos,
          total_pendientes_restantes: Number(updatedCampaign.total_pendientes || 0),
          total_fallidos_restantes: Number(updatedCampaign.total_fallidos || 0),
          total_destinatarios_programados: Number(updatedCampaign.total_destinatarios || 0),
          finalizada_at: updatedCampaign.finalizada_at ?? null,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo reintentar envios fallidos", "CONFIG_COMM_CAMPAIGN_RETRY_ERROR");
      } finally {
        if (lockAcquired) {
          await releaseCommunicationSendLock(client, campaignId).catch(() => {});
        }
        client.release();
      }
    }
  );

  app.post(
    "/comunicacion/campanias/:id/cancelar",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
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
      const campaignId = request.params.id;
      let lockAcquired = false;

      try {
        lockAcquired = await tryAcquireCommunicationSendLock(client, campaignId);
        if (!lockAcquired) {
          throw new AppError(409, "Ya hay una operacion en ejecucion para esta campania", {
            code: "CONFIG_COMM_CAMPAIGN_CANCEL_IN_PROGRESS",
          });
        }

        const actorUserId = request.claims?.user?.id_usuario || request.auth?.sub;
        if (!actorUserId) {
          throw new AppError(401, "No se pudo resolver el usuario autenticado para cancelar la campania", {
            code: "CONFIG_COMM_CAMPAIGN_CANCEL_ACTOR_REQUIRED",
          });
        }

        const campaign = await getCommunicationCampaignByIdForUpdate(client, campaignId);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const campaignState = String(campaign.estado || "").trim().toLowerCase();
        const allowedStates = [COMMUNICATION_CAMPAIGN_DRAFT_STATE, COMMUNICATION_CAMPAIGN_SCHEDULED_STATE, "procesando", "error"];

        if (campaignState === COMMUNICATION_CAMPAIGN_CANCELLED_STATE) {
          return sendOk(reply, {
            id_campania: campaign.id_campania,
            estado_resultante: campaign.estado,
            cancelada_at: campaign.finalizada_at ?? campaign.updated_at ?? null,
            total_enviados: Number(campaign.total_enviados || 0),
            total_fallidos: Number(campaign.total_fallidos || 0),
            total_pendientes: Number(campaign.total_pendientes || 0),
            total_afectados_por_cancelacion: Number(campaign.total_pendientes || 0) + Number(campaign.total_fallidos || 0),
            mensaje: "La campania ya estaba cancelada",
            ya_cancelada: true,
          }, { requestId: request.id });
        }

        if (!allowedStates.includes(campaignState)) {
          throw new AppError(409, "El estado actual de la campania no permite cancelacion segura", {
            code: "CONFIG_COMM_CAMPAIGN_CANCEL_STATE_INVALID",
            details: { estado_actual: campaign.estado },
          });
        }

        const countersResult = await client.query(
          `
            SELECT
              COUNT(*)::int AS total_destinatarios,
              COUNT(*) FILTER (WHERE estado_envio = $2::text)::int AS total_pendientes,
              COUNT(*) FILTER (WHERE estado_envio = $3::text)::int AS total_enviados,
              COUNT(*) FILTER (WHERE estado_envio = $4::text)::int AS total_fallidos
            FROM public.comunicaciones_envios
            WHERE id_campania = $1::uuid
          `,
          [campaignId, COMMUNICATION_SEND_STATUS_PENDING, COMMUNICATION_SEND_STATUS_SENT, COMMUNICATION_SEND_STATUS_FAILED]
        );
        const counters = countersResult.rows?.[0] || {};
        const totalPendientes = Number(counters.total_pendientes || 0);
        const totalFallidos = Number(counters.total_fallidos || 0);
        const totalAfectados = totalPendientes + totalFallidos;

        const updatedResult = await client.query(
          `
            UPDATE public.comunicaciones_campanias
            SET
              estado = $2::text,
              total_destinatarios = $3::int,
              total_pendientes = $4::int,
              total_enviados = $5::int,
              total_fallidos = $6::int,
              finalizada_at = COALESCE(finalizada_at, NOW()),
              actualizada_por = $7::uuid,
              updated_at = NOW()
            WHERE id_campania = $1::uuid
              AND deleted_at IS NULL
            RETURNING
              id_campania,
              estado,
              finalizada_at,
              total_destinatarios,
              total_pendientes,
              total_enviados,
              total_fallidos
          `,
          [
            campaignId,
            COMMUNICATION_CAMPAIGN_CANCELLED_STATE,
            Number(counters.total_destinatarios || 0),
            totalPendientes,
            Number(counters.total_enviados || 0),
            totalFallidos,
            actorUserId,
          ]
        );

        const updated = updatedResult.rows?.[0] || {};
        return sendOk(reply, {
          id_campania: updated.id_campania || campaign.id_campania,
          estado_resultante: updated.estado || COMMUNICATION_CAMPAIGN_CANCELLED_STATE,
          cancelada_at: updated.finalizada_at ?? null,
          total_enviados: Number(updated.total_enviados || 0),
          total_fallidos: Number(updated.total_fallidos || 0),
          total_pendientes: Number(updated.total_pendientes || 0),
          total_afectados_por_cancelacion: totalAfectados,
          mensaje: totalAfectados > 0
            ? "Campania cancelada. Se detuvo la operacion pendiente/fallida y se preservo el historial."
            : "Campania cancelada sin envios pendientes ni fallidos.",
          ya_cancelada: false,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudo cancelar la campania", "CONFIG_COMM_CAMPAIGN_CANCEL_ERROR");
      } finally {
        if (lockAcquired) {
          await releaseCommunicationSendLock(client, campaignId).catch(() => {});
        }
        client.release();
      }
    }
  );

  app.get(
    "/comunicacion/campanias/:id/envios",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        querystring: communicationCampaignShipmentsQuerySchema,
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
        const campaign = await getCommunicationCampaignById(client, request.params.id);
        if (!campaign) {
          throw new AppError(404, "La campania indicada no existe o fue eliminada", {
            code: "CONFIG_COMM_CAMPAIGN_NOT_FOUND",
          });
        }
        assertCommunicationCampaignAllowed(campaign);

        const payload = await listCampaignShipments(client, campaign.id_campania, request.query || {});
        return sendOk(reply, {
          id_campania: campaign.id_campania,
          estado_campania: campaign.estado,
          ...payload,
        }, { requestId: request.id });
      } catch (error) {
        return sendHandledError(reply, request, error, "No se pudieron consultar los envios de la campania", "CONFIG_COMM_CAMPAIGN_SHIPMENTS_LIST_ERROR");
      } finally {
        client.release();
      }
    }
  );

  app.get(
    "/promociones",
    {
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
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
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
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
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
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
        const imagenPrincipalUrlInput = normalizeOptionalText(request.body.imagen_principal_url) ?? null;
        const imagenMobileUrlInput = normalizeOptionalText(request.body.imagen_mobile_url) ?? null;
        const imagenPrincipalAssetId =
          request.body.imagen_principal_asset_id !== undefined
            ? normalizeOptionalText(request.body.imagen_principal_asset_id)
            : null;
        const imagenMobileAssetId =
          request.body.imagen_mobile_asset_id !== undefined
            ? normalizeOptionalText(request.body.imagen_mobile_asset_id)
            : null;
        const imagenPrincipalAsset = imagenPrincipalAssetId
          ? await resolveAssetForBinding(client, {
            assetId: imagenPrincipalAssetId,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MAIN,
            entityType: "promocion",
            entityId: null,
            idSucursal: branchId,
            claims: request.claims,
            allowUnboundEntity: true,
            allowedStatuses: ["temporal", "activo"],
          })
          : null;
        const imagenMobileAsset = imagenMobileAssetId
          ? await resolveAssetForBinding(client, {
            assetId: imagenMobileAssetId,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MOBILE,
            entityType: "promocion",
            entityId: null,
            idSucursal: branchId,
            claims: request.claims,
            allowUnboundEntity: true,
            allowedStatuses: ["temporal", "activo"],
          })
          : null;
        const imagenPrincipalUrl = imagenPrincipalAsset?.public_url ?? imagenPrincipalUrlInput;
        const imagenMobileUrl = imagenMobileAsset?.public_url ?? imagenMobileUrlInput;
        const imagenPrincipalPath = imagenPrincipalAsset?.object_path ?? null;
        const imagenMobilePath = imagenMobileAsset?.object_path ?? null;
        const imagenAlt = normalizeOptionalText(request.body.imagen_alt) ?? null;
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
              imagen_principal_asset_id,
              imagen_principal_path,
              imagen_principal_url,
              imagen_mobile_asset_id,
              imagen_mobile_path,
              imagen_mobile_url,
              imagen_alt,
              cta_texto,
              cta_url,
              cta_tipo,
              estado,
              updated_at
            )
            VALUES ($1, $2, $3, $4::jsonb, $5::uuid, $6, $7, $8::uuid, $9, $10, $11, NULL, NULL, 'none', $12, NOW())
            RETURNING id_promocion
          `,
          [
            slug,
            titulo,
            subtitulo,
            JSON.stringify(parrafos),
            imagenPrincipalAsset?.id_asset ?? null,
            imagenPrincipalPath,
            imagenPrincipalUrl,
            imagenMobileAsset?.id_asset ?? null,
            imagenMobilePath,
            imagenMobileUrl,
            imagenAlt,
            estado,
          ]
        );

        const idPromocion = inserted.rows[0].id_promocion;

        if (imagenPrincipalAsset?.id_asset) {
          await activateAssetForEntity(app, client, {
            assetId: imagenPrincipalAsset.id_asset,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MAIN,
            entityType: "promocion",
            entityId: idPromocion,
            idSucursal: branchId,
            claims: request.claims,
            replaceCurrent: false,
          });
        }
        if (imagenMobileAsset?.id_asset) {
          await activateAssetForEntity(app, client, {
            assetId: imagenMobileAsset.id_asset,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MOBILE,
            entityType: "promocion",
            entityId: idPromocion,
            idSucursal: branchId,
            claims: request.claims,
            replaceCurrent: false,
          });
        }

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
      preHandler: app.requireRoles(CONFIG_COMMUNICATION_ALLOWED_ROLES),
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
        const hasPrincipalAssetPatch = Object.prototype.hasOwnProperty.call(request.body, "imagen_principal_asset_id");
        const hasMobileAssetPatch = Object.prototype.hasOwnProperty.call(request.body, "imagen_mobile_asset_id");
        const hasPrincipalUrlPatch = Object.prototype.hasOwnProperty.call(request.body, "imagen_principal_url");
        const hasMobileUrlPatch = Object.prototype.hasOwnProperty.call(request.body, "imagen_mobile_url");
        let imagenPrincipalAssetId = currentPromotion.imagen_principal_asset_id ?? null;
        let imagenPrincipalPath = currentPromotion.imagen_principal_path ?? null;
        let imagenPrincipalUrl = currentPromotion.imagen_principal_url ?? null;
        let imagenMobileAssetId = currentPromotion.imagen_mobile_asset_id ?? null;
        let imagenMobilePath = currentPromotion.imagen_mobile_path ?? null;
        let imagenMobileUrl = currentPromotion.imagen_mobile_url ?? null;

        if (hasPrincipalAssetPatch) {
          const rawPrincipalAssetId = normalizeOptionalText(request.body.imagen_principal_asset_id);
          if (!rawPrincipalAssetId) {
            imagenPrincipalAssetId = null;
            imagenPrincipalPath = null;
            imagenPrincipalUrl = hasPrincipalUrlPatch
              ? (normalizeOptionalText(request.body.imagen_principal_url) ?? null)
              : null;
          } else {
            const resolvedPrincipal = await resolveAssetForBinding(client, {
              assetId: rawPrincipalAssetId,
              scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MAIN,
              entityType: "promocion",
              entityId: request.params.id,
              idSucursal: branchId,
              claims: request.claims,
              allowUnboundEntity: true,
              allowedStatuses: ["temporal", "activo"],
            });
            imagenPrincipalAssetId = resolvedPrincipal.id_asset;
            imagenPrincipalPath = resolvedPrincipal.object_path;
            imagenPrincipalUrl = resolvedPrincipal.public_url;
          }
        } else if (hasPrincipalUrlPatch) {
          imagenPrincipalUrl = normalizeOptionalText(request.body.imagen_principal_url) ?? null;
        }

        if (hasMobileAssetPatch) {
          const rawMobileAssetId = normalizeOptionalText(request.body.imagen_mobile_asset_id);
          if (!rawMobileAssetId) {
            imagenMobileAssetId = null;
            imagenMobilePath = null;
            imagenMobileUrl = hasMobileUrlPatch
              ? (normalizeOptionalText(request.body.imagen_mobile_url) ?? null)
              : null;
          } else {
            const resolvedMobile = await resolveAssetForBinding(client, {
              assetId: rawMobileAssetId,
              scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MOBILE,
              entityType: "promocion",
              entityId: request.params.id,
              idSucursal: branchId,
              claims: request.claims,
              allowUnboundEntity: true,
              allowedStatuses: ["temporal", "activo"],
            });
            imagenMobileAssetId = resolvedMobile.id_asset;
            imagenMobilePath = resolvedMobile.object_path;
            imagenMobileUrl = resolvedMobile.public_url;
          }
        } else if (hasMobileUrlPatch) {
          imagenMobileUrl = normalizeOptionalText(request.body.imagen_mobile_url) ?? null;
        }

        const imagenAlt =
          request.body.imagen_alt !== undefined
            ? normalizeOptionalText(request.body.imagen_alt) ?? null
            : currentPromotion.imagen_alt;
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

        if (imagenPrincipalAssetId) {
          await activateAssetForEntity(app, client, {
            assetId: imagenPrincipalAssetId,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MAIN,
            entityType: "promocion",
            entityId: request.params.id,
            idSucursal: branchId,
            claims: request.claims,
            replaceCurrent: false,
          });
        }
        if (imagenMobileAssetId) {
          await activateAssetForEntity(app, client, {
            assetId: imagenMobileAssetId,
            scopeKey: STORAGE_SCOPE_PUBLIC_PROMOTION_MOBILE,
            entityType: "promocion",
            entityId: request.params.id,
            idSucursal: branchId,
            claims: request.claims,
            replaceCurrent: false,
          });
        }

        await client.query(
          `
            UPDATE public.promociones
            SET
              slug = $2,
              titulo = $3,
              subtitulo = $4,
              parrafos = $5::jsonb,
              imagen_principal_asset_id = $6::uuid,
              imagen_principal_path = $7,
              imagen_principal_url = $8,
              imagen_mobile_asset_id = $9::uuid,
              imagen_mobile_path = $10,
              imagen_mobile_url = $11,
              imagen_alt = $12,
              cta_texto = NULL,
              cta_url = NULL,
              cta_tipo = 'none',
              estado = $13,
              updated_at = NOW()
            WHERE id_promocion = $1::uuid
          `,
          [
            request.params.id,
            slug,
            titulo,
            subtitulo,
            JSON.stringify(parrafos),
            imagenPrincipalAssetId,
            imagenPrincipalPath,
            imagenPrincipalUrl,
            imagenMobileAssetId,
            imagenMobilePath,
            imagenMobileUrl,
            imagenAlt,
            estado,
          ]
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

        await replaceAssetIfNeeded(app, client, {
          previousAssetId: currentPromotion.imagen_principal_asset_id,
          nextAssetId: imagenPrincipalAssetId,
          claims: request.claims,
        });
        await replaceAssetIfNeeded(app, client, {
          previousAssetId: currentPromotion.imagen_mobile_asset_id,
          nextAssetId: imagenMobileAssetId,
          claims: request.claims,
        });

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
