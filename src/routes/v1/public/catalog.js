import { sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const requestIdSchema = { type: "string" };
const BUSINESS_TIME_ZONE = "America/Tegucigalpa";

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

const servicioSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    descripcion: { type: ["string", "null"] },
    duracion_min: { type: "integer" },
    buffer_min: { type: "integer" },
    precio_hnl: { type: "number" },
    grupo_catalogo: { type: "string", enum: ["barberia", "otros"] },
    activo: { type: "boolean" },
    agendable: { type: "boolean" },
    servicio_informativo: { type: "boolean" },
    orden_visual: { type: "integer" },
    agendable_barbero: { type: "boolean" },
  },
  required: [
    "id_servicio",
    "nombre_servicio",
    "descripcion",
    "duracion_min",
    "buffer_min",
    "precio_hnl",
    "grupo_catalogo",
    "activo",
    "agendable",
    "servicio_informativo",
    "orden_visual",
    "agendable_barbero",
  ],
  additionalProperties: false,
};

const paqueteItemSchema = {
  type: "object",
  properties: {
    id_servicio: { type: "string", format: "uuid" },
    nombre_servicio: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["id_servicio", "nombre_servicio", "cantidad"],
  additionalProperties: false,
};

const paqueteSchema = {
  type: "object",
  properties: {
    id_paquete: { type: "string", format: "uuid" },
    nombre_paquete: { type: "string" },
    descripcion: { type: ["string", "null"] },
    precio_hnl: { type: ["number", "null"] },
    orden_visual: { type: "integer" },
    items: { type: "array", items: paqueteItemSchema },
  },
  required: ["id_paquete", "nombre_paquete", "descripcion", "precio_hnl", "orden_visual", "items"],
  additionalProperties: false,
};

const planBenefitSchema = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: ["servicio", "cortesia"] },
    id_servicio: { type: ["string", "null"], format: "uuid" },
    id_cortesia: { type: ["string", "null"], format: "uuid" },
    codigo: { type: ["string", "null"] },
    nombre: { type: "string" },
    cantidad: { type: "integer" },
  },
  required: ["tipo", "id_servicio", "id_cortesia", "codigo", "nombre", "cantidad"],
  additionalProperties: false,
};

const planSchema = {
  type: "object",
  properties: {
    id_plan_sucursal: { type: "string", format: "uuid" },
    id_plan: { type: "string", format: "uuid" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    nombre_plan: { type: "string" },
    descripcion: { type: ["string", "null"] },
    periodo_membresia_codigo: { type: "string" },
    periodo_membresia_label: { type: "string" },
    categoria_nivel: { type: "integer", minimum: 1, maximum: 5 },
    precio_hnl: { type: ["number", "null"] },
    orden_visual: { type: "integer" },
    beneficios: { type: "array", items: planBenefitSchema },
  },
  required: [
    "id_plan_sucursal",
    "id_plan",
    "id_sucursal",
    "nombre_plan",
    "descripcion",
    "periodo_membresia_codigo",
    "periodo_membresia_label",
    "categoria_nivel",
    "precio_hnl",
    "orden_visual",
    "beneficios",
  ],
  additionalProperties: false,
};

const sucursalSchema = {
  type: "object",
  properties: {
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: "string" },
  },
  required: ["id_sucursal", "nombre_sucursal"],
  additionalProperties: false,
};

const promocionSchema = {
  type: "object",
  properties: {
    id_promocion: { type: "string", format: "uuid" },
    id_sucursal: { type: ["string", "null"], format: "uuid" },
    slug: { type: "string" },
    titulo: { type: "string" },
    subtitulo: { type: ["string", "null"] },
    parrafos: { type: "array", items: { type: "string" } },
    imagen_principal_url: { type: ["string", "null"] },
    imagen_mobile_url: { type: ["string", "null"] },
    imagen_alt: { type: ["string", "null"] },
    estado: { type: "string", enum: ["publicada"] },
    vigencia_desde: { type: ["string", "null"], format: "date" },
    vigencia_hasta: { type: ["string", "null"], format: "date" },
    orden_visual: { type: "integer" },
    destacada: { type: "boolean" },
  },
  required: [
    "id_promocion",
    "id_sucursal",
    "slug",
    "titulo",
    "subtitulo",
    "parrafos",
    "imagen_principal_url",
    "imagen_mobile_url",
    "imagen_alt",
    "estado",
    "vigencia_desde",
    "vigencia_hasta",
    "orden_visual",
    "destacada",
  ],
  additionalProperties: false,
};

const PUBLIC_SERVICES_SQL = `
  -- AM: Mantiene visibilidad de servicios aunque su tarifa actual esté inactiva.
  WITH active_tariffs AS (
    SELECT
      st.id_servicio,
      st.id_sucursal,
      st.precio_hnl,
      st.duracion_min,
      st.buffer_min,
      COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio, st.id_sucursal
        ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    JOIN public.sucursales su
      ON su.id_sucursal = st.id_sucursal
    WHERE st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND (
        ($2::uuid IS NULL AND st.id_empleado IS NULL)
        OR ($2::uuid IS NOT NULL AND (st.id_empleado IS NULL OR st.id_empleado = $2::uuid))
      )
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      AND st.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR st.id_sucursal = $1::uuid)
  ),
  picked_tariffs AS (
    SELECT id_servicio, id_sucursal, precio_hnl, duracion_min, buffer_min, servicio_informativo
    FROM active_tariffs
    WHERE rn = 1
  ),
  service_scope AS (
    SELECT
      ranked.id_servicio,
      ranked.precio_hnl,
      ranked.duracion_min,
      ranked.buffer_min,
      ranked.servicio_informativo
    FROM (
      SELECT
        pt.id_servicio,
        pt.precio_hnl,
        pt.duracion_min,
        pt.buffer_min,
        pt.servicio_informativo,
        ROW_NUMBER() OVER (
          PARTITION BY pt.id_servicio
          ORDER BY
            pt.precio_hnl ASC NULLS LAST,
            pt.duracion_min ASC NULLS LAST,
            pt.buffer_min ASC NULLS LAST,
            pt.id_sucursal::text ASC
        ) AS rn
      FROM picked_tariffs pt
    ) ranked
    WHERE ranked.rn = 1
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    -- AM: Usa tiempos por sucursal cuando existen; fallback al servicio base para compatibilidad legacy.
    COALESCE(ss.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(ss.buffer_min, s.buffer_min) AS buffer_min,
    s.grupo_catalogo,
    s.activo,
    COALESCE(ss.servicio_informativo, FALSE) AS servicio_informativo,
    s.orden_visual,
    s.agendable,
    ss.precio_hnl
  FROM public.servicios s
  JOIN service_scope ss
    ON ss.id_servicio = s.id_servicio
  WHERE s.deleted_at IS NULL
    AND s.activo IS TRUE
    AND s.visible_publico IS TRUE
    AND COALESCE(ss.duracion_min, s.duracion_min) > 0
    AND ss.precio_hnl > 0
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC
`;

const PUBLIC_PACKAGES_SQL = `
  -- AM: Oferta publica de paquetes filtrada por sucursal y validada contra servicios operativos.
  WITH scoped_offers AS (
    SELECT
      ps.id_paquete,
      ps.id_sucursal,
      ps.precio_hnl,
      ps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY ps.id_paquete, ps.id_sucursal
        ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
      ) AS rn
    FROM public.paquetes_sucursal ps
    JOIN public.sucursales su
      ON su.id_sucursal = ps.id_sucursal
    WHERE ps.activo IS TRUE
      AND ps.visible_publico IS TRUE
      AND ps.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_paquete,
      so.id_sucursal,
      so.precio_hnl,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  ),
  effective_offers AS (
    SELECT
      po.id_paquete,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.precio_hnl)
        ELSE MAX(po.precio_hnl)
      END AS precio_hnl,
      CASE
        WHEN $1::uuid IS NULL THEN MIN(po.orden_visual)
        ELSE MAX(po.orden_visual)
      END AS orden_visual,
      CASE
        -- AM: PostgreSQL no soporta min/max directo sobre UUID en algunos entornos; se castea via text para seleccion determinista.
        WHEN $1::uuid IS NULL THEN MIN(po.id_sucursal::text)::uuid
        ELSE MAX(po.id_sucursal::text)::uuid
      END AS id_sucursal
    FROM picked_offers po
    GROUP BY po.id_paquete
  )
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    eo.precio_hnl AS precio_hnl,
    COALESCE(eo.orden_visual, 100) AS orden_visual,
    COALESCE(
      json_agg(
        json_build_object(
          'id_servicio', s.id_servicio,
          'nombre_servicio', s.nombre_servicio,
          'cantidad', pd.cantidad
        )
        ORDER BY s.nombre_servicio
      ) FILTER (WHERE s.id_servicio IS NOT NULL),
      '[]'::json
    ) AS items
  FROM public.paquetes p
  JOIN effective_offers eo
    ON eo.id_paquete = p.id_paquete
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
  WHERE p.deleted_at IS NULL
    AND p.activo IS TRUE
  GROUP BY p.id_paquete, eo.precio_hnl, eo.orden_visual, eo.id_sucursal
  HAVING COUNT(pd.id_servicio) >= 2
     AND eo.precio_hnl > 0
     AND COUNT(s.id_servicio) = COUNT(pd.id_servicio)
      AND BOOL_AND(
      s.id_servicio IS NOT NULL
      AND s.activo IS TRUE
      AND s.agendable IS TRUE
      AND s.visible_publico IS TRUE
      AND EXISTS (
        SELECT 1
        FROM public.servicios_tarifas st
        WHERE st.id_servicio = pd.id_servicio
          AND st.id_sucursal = eo.id_sucursal
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            ($2::uuid IS NULL AND st.id_empleado IS NULL)
            OR ($2::uuid IS NOT NULL AND (st.id_empleado IS NULL OR st.id_empleado = $2::uuid))
          )
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
          AND st.precio_hnl > 0
      )
    )
  ORDER BY COALESCE(eo.orden_visual, 100) ASC, p.nombre_paquete ASC
`;

const PUBLIC_SERVICES_SEARCH_SQL = `
  WITH active_tariffs AS (
    SELECT
      st.id_servicio,
      st.id_sucursal,
      st.precio_hnl,
      st.duracion_min,
      st.buffer_min,
      COALESCE(st.servicio_informativo, FALSE) AS servicio_informativo,
      ROW_NUMBER() OVER (
        PARTITION BY st.id_servicio, st.id_sucursal
        ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
      ) AS rn
    FROM public.servicios_tarifas st
    JOIN public.sucursales su
      ON su.id_sucursal = st.id_sucursal
    WHERE st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND (
        ($2::uuid IS NULL AND st.id_empleado IS NULL)
        OR ($2::uuid IS NOT NULL AND (st.id_empleado IS NULL OR st.id_empleado = $2::uuid))
      )
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
      AND st.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR st.id_sucursal = $1::uuid)
  ),
  picked_tariffs AS (
    SELECT id_servicio, id_sucursal, precio_hnl, duracion_min, buffer_min, servicio_informativo
    FROM active_tariffs
    WHERE rn = 1
  ),
  service_scope AS (
    SELECT
      ranked.id_servicio,
      ranked.precio_hnl,
      ranked.duracion_min,
      ranked.buffer_min,
      ranked.servicio_informativo
    FROM (
      SELECT
        pt.id_servicio,
        pt.precio_hnl,
        pt.duracion_min,
        pt.buffer_min,
        pt.servicio_informativo,
        ROW_NUMBER() OVER (
          PARTITION BY pt.id_servicio
          ORDER BY pt.precio_hnl ASC NULLS LAST, pt.duracion_min ASC NULLS LAST, pt.buffer_min ASC NULLS LAST, pt.id_sucursal::text ASC
        ) AS rn
      FROM picked_tariffs pt
    ) ranked
    WHERE ranked.rn = 1
  )
  SELECT
    s.id_servicio,
    s.nombre_servicio,
    s.descripcion,
    COALESCE(ss.duracion_min, s.duracion_min) AS duracion_min,
    COALESCE(ss.buffer_min, s.buffer_min) AS buffer_min,
    s.grupo_catalogo,
    s.activo,
    COALESCE(ss.servicio_informativo, FALSE) AS servicio_informativo,
    s.orden_visual,
    s.agendable,
    ss.precio_hnl
  FROM public.servicios s
  JOIN service_scope ss
    ON ss.id_servicio = s.id_servicio
  WHERE s.deleted_at IS NULL
    AND s.activo IS TRUE
    AND s.visible_publico IS TRUE
    AND COALESCE(ss.duracion_min, s.duracion_min) > 0
    AND ss.precio_hnl > 0
    AND (
      LOWER(s.nombre_servicio) LIKE $3::text
      OR LOWER(COALESCE(s.descripcion, '')) LIKE $3::text
    )
  ORDER BY s.orden_visual ASC, s.nombre_servicio ASC
  LIMIT 50
`;

const PUBLIC_PACKAGES_SEARCH_SQL = `
  WITH scoped_offers AS (
    SELECT
      ps.id_paquete,
      ps.id_sucursal,
      ps.precio_hnl,
      ps.orden_visual,
      ROW_NUMBER() OVER (
        PARTITION BY ps.id_paquete, ps.id_sucursal
        ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
      ) AS rn
    FROM public.paquetes_sucursal ps
    JOIN public.sucursales su
      ON su.id_sucursal = ps.id_sucursal
    WHERE ps.activo IS TRUE
      AND ps.visible_publico IS TRUE
      AND ps.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_paquete,
      so.id_sucursal,
      so.precio_hnl,
      so.orden_visual
    FROM scoped_offers so
    WHERE so.rn = 1
  ),
  effective_offers AS (
    SELECT
      po.id_paquete,
      CASE WHEN $1::uuid IS NULL THEN MIN(po.precio_hnl) ELSE MAX(po.precio_hnl) END AS precio_hnl,
      CASE WHEN $1::uuid IS NULL THEN MIN(po.orden_visual) ELSE MAX(po.orden_visual) END AS orden_visual,
      CASE WHEN $1::uuid IS NULL THEN MIN(po.id_sucursal::text)::uuid ELSE MAX(po.id_sucursal::text)::uuid END AS id_sucursal
    FROM picked_offers po
    GROUP BY po.id_paquete
  )
  SELECT
    p.id_paquete,
    p.nombre_paquete,
    p.descripcion,
    eo.precio_hnl AS precio_hnl,
    COALESCE(eo.orden_visual, 100) AS orden_visual,
    COALESCE(
      json_agg(
        json_build_object('id_servicio', s.id_servicio, 'nombre_servicio', s.nombre_servicio, 'cantidad', pd.cantidad)
        ORDER BY s.nombre_servicio
      ) FILTER (WHERE s.id_servicio IS NOT NULL),
      '[]'::json
    ) AS items
  FROM public.paquetes p
  JOIN effective_offers eo
    ON eo.id_paquete = p.id_paquete
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = p.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
  WHERE p.deleted_at IS NULL
    AND p.activo IS TRUE
    AND (
      LOWER(p.nombre_paquete) LIKE $2::text
      OR LOWER(COALESCE(p.descripcion, '')) LIKE $2::text
    )
  GROUP BY p.id_paquete, eo.precio_hnl, eo.orden_visual, eo.id_sucursal
  HAVING COUNT(pd.id_servicio) >= 2
     AND eo.precio_hnl > 0
     AND COUNT(s.id_servicio) = COUNT(pd.id_servicio)
     AND BOOL_AND(
      s.id_servicio IS NOT NULL
      AND s.activo IS TRUE
      AND s.agendable IS TRUE
      AND s.visible_publico IS TRUE
      AND EXISTS (
        SELECT 1
        FROM public.servicios_tarifas st
        WHERE st.id_servicio = pd.id_servicio
          AND st.id_sucursal = eo.id_sucursal
          AND st.deleted_at IS NULL
          AND st.activo IS TRUE
          AND (
            ($3::uuid IS NULL AND st.id_empleado IS NULL)
            OR ($3::uuid IS NOT NULL AND (st.id_empleado IS NULL OR st.id_empleado = $3::uuid))
          )
          AND st.vigente_desde <= CURRENT_DATE
          AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
          AND st.precio_hnl > 0
      )
    )
  ORDER BY COALESCE(eo.orden_visual, 100) ASC, p.nombre_paquete ASC
  LIMIT 50
`;

const PUBLIC_PLANS_SEARCH_SQL = `
  WITH scoped_offers AS (
    SELECT
      mps.id_plan_sucursal,
      mps.id_plan,
      mps.id_sucursal,
      mps.precio_hnl,
      mps.orden_visual,
      mps.updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY mps.id_plan, mps.id_sucursal
        ORDER BY mps.updated_at DESC, mps.id_plan_sucursal DESC
      ) AS rn_branch
    FROM public.membership_plans_sucursal mps
    JOIN public.sucursales su
      ON su.id_sucursal = mps.id_sucursal
    WHERE mps.activo IS TRUE
      AND mps.visible_publico IS TRUE
      AND mps.precio_hnl > 0
      AND su.deleted_at IS NULL
      AND su.estado IS TRUE
      AND ($1::uuid IS NULL OR mps.id_sucursal = $1::uuid)
  ),
  picked_offers AS (
    SELECT
      so.id_plan_sucursal,
      so.id_plan,
      so.id_sucursal,
      so.precio_hnl,
      so.orden_visual,
      so.updated_at
    FROM scoped_offers so
    WHERE so.rn_branch = 1
  ),
  effective_offers AS (
    SELECT
      ranked.id_plan_sucursal,
      ranked.id_plan,
      ranked.id_sucursal,
      ranked.precio_hnl,
      ranked.orden_visual
    FROM (
      SELECT
        po.*,
        ROW_NUMBER() OVER (
          PARTITION BY po.id_plan
          ORDER BY
            CASE WHEN $1::uuid IS NULL THEN po.precio_hnl ELSE 0 END ASC,
            CASE WHEN $1::uuid IS NULL THEN po.id_sucursal::text ELSE '' END ASC,
            po.orden_visual ASC,
            po.updated_at DESC,
            po.id_plan_sucursal DESC
        ) AS rn_plan
      FROM picked_offers po
    ) ranked
    WHERE ranked.rn_plan = 1
  )
  SELECT
    eo.id_plan_sucursal,
    mp.id_plan,
    eo.id_sucursal,
    mp.nombre_plan,
    mp.descripcion,
    mp.periodo_membresia_codigo,
    COALESCE(NULLIF(to_jsonb(mp)->>'categoria_nivel', '')::int, 1) AS categoria_nivel,
    pm.descripcion AS periodo_membresia_label,
    eo.precio_hnl AS precio_hnl,
    mp.beneficios,
    eo.orden_visual
  FROM public.membership_plans mp
  JOIN effective_offers eo
    ON eo.id_plan = mp.id_plan
  JOIN public.periodos_membresia pm
    ON pm.periodo_membresia_codigo = mp.periodo_membresia_codigo
  WHERE mp.activo IS TRUE
    AND eo.precio_hnl > 0
    AND ($2::text IS NULL OR (
      LOWER(mp.nombre_plan) LIKE $2::text
      OR LOWER(COALESCE(mp.descripcion, '')) LIKE $2::text
    ))
  ORDER BY eo.orden_visual ASC, mp.nombre_plan ASC
  LIMIT 50
`;

const PUBLIC_BRANCHES_SQL = `
  SELECT
    s.id_sucursal,
    s.nombre_sucursal
  FROM public.sucursales s
  WHERE s.deleted_at IS NULL
    AND s.estado IS TRUE
  ORDER BY s.nombre_sucursal ASC
`;

const PUBLIC_PROMOTIONS_SQL = `
  -- AM: Publica promociones vigentes por sucursal. Si no llega id_sucursal, retorna una version determinista por promocion.
  WITH scoped_promotions AS (
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
      p.estado,
      ps.vigencia_desde,
      ps.vigencia_hasta,
      ps.vigencia_hora_desde,
      ps.vigencia_hora_hasta,
      ps.orden_visual,
      ps.destacada
    FROM public.promociones p
    JOIN public.promociones_sucursal ps
      ON ps.id_promocion = p.id_promocion
    JOIN public.sucursales s
      ON s.id_sucursal = ps.id_sucursal
    CROSS JOIN (
      SELECT (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS business_date
    ) business_clock
    WHERE s.deleted_at IS NULL
      AND s.estado IS TRUE
      AND p.estado = 'publicada'
      AND ps.visible_publico IS TRUE
      AND (ps.vigencia_desde IS NULL OR ps.vigencia_desde <= business_clock.business_date)
      AND (ps.vigencia_hasta IS NULL OR ps.vigencia_hasta >= business_clock.business_date)
      AND ($1::uuid IS NULL OR ps.id_sucursal = $1::uuid)
  ),
  ranked AS (
    SELECT
      sp.*,
      ROW_NUMBER() OVER (
        PARTITION BY sp.id_promocion
        ORDER BY
          CASE WHEN $1::uuid IS NULL THEN 0 ELSE 1 END ASC,
          sp.destacada DESC,
          sp.orden_visual ASC,
          sp.id_sucursal::text ASC
      ) AS rn
    FROM scoped_promotions sp
  )
  SELECT
    id_promocion,
    id_sucursal,
    slug,
    titulo,
    subtitulo,
    parrafos,
    imagen_principal_url,
    imagen_mobile_url,
    imagen_alt,
    estado,
    vigencia_desde,
    vigencia_hasta,
    orden_visual,
    destacada
  FROM ranked
  WHERE ($1::uuid IS NULL AND rn = 1) OR ($1::uuid IS NOT NULL)
  ORDER BY destacada DESC, orden_visual ASC, titulo ASC
`;

function getBusinessNowParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const pick = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
  };
}

function normalizeIsoDateOnly(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function normalizeTimeOnly(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] || "00"}`;
}

function timeToSeconds(value) {
  const normalized = normalizeTimeOnly(value);
  if (!normalized) return null;
  const [hours, minutes, seconds] = normalized.split(":").map((entry) => Number(entry));
  return (hours * 3600) + (minutes * 60) + seconds;
}

function getPromotionVigenciaStatus(promotion, nowParts = getBusinessNowParts()) {
  const nowDate = normalizeIsoDateOnly(nowParts?.date);
  const nowTime = normalizeTimeOnly(nowParts?.time);
  const nowSeconds = timeToSeconds(nowTime);
  const vigenciaDesde = normalizeIsoDateOnly(promotion?.vigencia_desde);
  const vigenciaHasta = normalizeIsoDateOnly(promotion?.vigencia_hasta);
  const horaDesde = normalizeTimeOnly(promotion?.vigencia_hora_desde);
  const horaHasta = normalizeTimeOnly(promotion?.vigencia_hora_hasta);
  const horaDesdeSeconds = timeToSeconds(horaDesde);
  const horaHastaSeconds = timeToSeconds(horaHasta);
  const crossesMidnight = (
    horaDesdeSeconds != null
    && horaHastaSeconds != null
    && horaDesdeSeconds > horaHastaSeconds
  );

  if (!vigenciaDesde && !vigenciaHasta && !horaDesde && !horaHasta) return "sin_vigencia";
  if (vigenciaDesde && nowDate && nowDate < vigenciaDesde) return "programada";
  if (vigenciaHasta && nowDate && nowDate > vigenciaHasta) return "vencida";

  let inWindow = true;
  if (horaDesdeSeconds != null || horaHastaSeconds != null) {
    if (horaDesdeSeconds != null && horaHastaSeconds == null) inWindow = nowSeconds >= horaDesdeSeconds;
    else if (horaDesdeSeconds == null && horaHastaSeconds != null) inWindow = nowSeconds <= horaHastaSeconds;
    else if (!crossesMidnight) inWindow = nowSeconds >= horaDesdeSeconds && nowSeconds <= horaHastaSeconds;
    else inWindow = nowSeconds >= horaDesdeSeconds || nowSeconds <= horaHastaSeconds;
  }

  if (crossesMidnight && vigenciaDesde && nowDate === vigenciaDesde) {
    inWindow = nowSeconds >= horaDesdeSeconds;
  }
  if (crossesMidnight && vigenciaHasta && nowDate === vigenciaHasta) {
    inWindow = nowSeconds <= horaHastaSeconds;
  }

  if (!inWindow) {
    if (vigenciaDesde && nowDate === vigenciaDesde) return "programada";
    if (vigenciaHasta && nowDate === vigenciaHasta) return "vencida";
    if (horaDesdeSeconds != null && nowSeconds < horaDesdeSeconds) return "programada";
    return "vencida";
  }

  return "vigente";
}

function mapServiceRow(row) {
  const grupoCatalogo = String(row.grupo_catalogo || "barberia").trim().toLowerCase() === "otros" ? "otros" : "barberia";
  const servicioInformativo = Boolean(row.servicio_informativo ?? false);
  const activo = Boolean(row.activo ?? true);
  const agendable = activo && Boolean(row.agendable ?? (grupoCatalogo === "barberia")) && !servicioInformativo;

  return {
    id_servicio: row.id_servicio,
    nombre_servicio: row.nombre_servicio,
    descripcion: row.descripcion ?? null,
    duracion_min: Number(row.duracion_min),
    buffer_min: Number(row.buffer_min ?? 0),
    precio_hnl: Number(row.precio_hnl ?? 0),
    grupo_catalogo: grupoCatalogo,
    activo,
    agendable,
    servicio_informativo: servicioInformativo,
    orden_visual: Number(row.orden_visual ?? 100),
    // AM: Campo legado conservado temporalmente para frontend ya integrado.
    agendable_barbero: agendable,
  };
}

function mapPackageRow(row) {
  return {
    id_paquete: row.id_paquete,
    nombre_paquete: row.nombre_paquete,
    descripcion: row.descripcion ?? null,
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    orden_visual: Number(row.orden_visual ?? 100),
    items: Array.isArray(row.items)
      ? row.items.map((item) => ({
          id_servicio: item.id_servicio,
          nombre_servicio: item.nombre_servicio,
          cantidad: Number(item.cantidad ?? 1),
        }))
      : [],
  };
}

function parseStoredBenefits(rawBenefits) {
  if (!rawBenefits) return [];

  const data = rawBenefits && typeof rawBenefits === "object" ? rawBenefits : {};
  const looksLikeSingleBenefit =
    data &&
    !Array.isArray(data) &&
    (data.tipo !== undefined ||
      data.id_servicio !== undefined ||
      data.id_cortesia !== undefined ||
      data.nombre !== undefined ||
      data.codigo !== undefined ||
      data.cantidad !== undefined);
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(rawBenefits)
      ? rawBenefits
      : looksLikeSingleBenefit
        ? [data]
        : [];

  return items
    .map((beneficio) => {
      const normalizedServiceId = String(beneficio?.id_servicio || "").trim();
      const normalizedCourtesyId = String(beneficio?.id_cortesia || "").trim();
      const normalizedNombre = String(beneficio?.nombre || "").trim();
      const normalizedCodigo = beneficio?.codigo ? String(beneficio.codigo).trim() : "";
      const rawType = String(beneficio?.tipo || "").trim().toLowerCase();
      const isService = rawType === "servicio" || (rawType !== "cortesia" && normalizedServiceId);
      const isCourtesy = rawType === "cortesia" || (!rawType && !normalizedServiceId && normalizedCourtesyId);
      const allowsLegacyCourtesyRead = rawType === "cortesia" && !normalizedCourtesyId && Boolean(normalizedNombre || normalizedCodigo);
      if (!isService && !isCourtesy && !allowsLegacyCourtesyRead) return null;
      const tipo = isService ? "servicio" : "cortesia";
      return {
        tipo,
        id_servicio: normalizedServiceId || null,
        id_cortesia: normalizedCourtesyId || null,
        codigo: normalizedCodigo || null,
        nombre: normalizedNombre,
        cantidad: Number(beneficio?.cantidad ?? 0),
      };
    })
    .filter(Boolean)
    .filter((beneficio) => Number.isInteger(beneficio.cantidad) && beneficio.cantidad > 0)
    .filter((beneficio) => (
      beneficio.tipo === "servicio"
        ? Boolean(beneficio.id_servicio)
        : Boolean(beneficio.id_cortesia || beneficio.nombre || beneficio.codigo)
    ))
    .map((beneficio) => ({
      ...beneficio,
      nombre: beneficio.nombre || (beneficio.tipo === "servicio" ? "Servicio incluido" : (beneficio.codigo || "Cortesia incluida")),
    }));
}

function mapPlanRow(row) {
  return {
    id_plan_sucursal: row.id_plan_sucursal,
    id_plan: row.id_plan,
    id_sucursal: row.id_sucursal ?? null,
    nombre_plan: row.nombre_plan,
    descripcion: row.descripcion ?? null,
    periodo_membresia_codigo: row.periodo_membresia_codigo,
    periodo_membresia_label: row.periodo_membresia_label || row.periodo_membresia_codigo,
    categoria_nivel: Number(row.categoria_nivel ?? 1),
    precio_hnl: row.precio_hnl == null ? null : Number(row.precio_hnl),
    orden_visual: Number(row.orden_visual ?? 100),
    beneficios: parseStoredBenefits(row.beneficios),
  };
}

function isValidPublicPlan(plan) {
  const price = Number(plan?.precio_hnl);
  if (!Number.isFinite(price) || price <= 0) return false;
  const benefits = Array.isArray(plan?.beneficios) ? plan.beneficios : [];
  return benefits.some((benefit) => String(benefit?.tipo || "").toLowerCase() === "servicio" && benefit?.id_servicio);
}

function mapBranchRow(row) {
  return {
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal,
  };
}

function normalizePromotionParagraphs(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }
  return [];
}

function mapPromotionRow(row) {
  return {
    id_promocion: row.id_promocion,
    id_sucursal: row.id_sucursal ?? null,
    slug: row.slug,
    titulo: row.titulo,
    subtitulo: row.subtitulo ?? null,
    parrafos: normalizePromotionParagraphs(row.parrafos),
    imagen_principal_url: row.imagen_principal_url ?? null,
    imagen_mobile_url: row.imagen_mobile_url ?? null,
    imagen_alt: row.imagen_alt ?? null,
    estado: "publicada",
    vigencia_desde: row.vigencia_desde ?? null,
    vigencia_hasta: row.vigencia_hasta ?? null,
    orden_visual: Number(row.orden_visual ?? 100),
    destacada: Boolean(row.destacada),
  };
}

function sendPublicCatalogError(reply, requestId, statusCode, message, code) {
  return sendError(reply, statusCode, message, {
    code,
    requestId,
  });
}

export default async function publicCatalogRoutes(app) {
  app.get(
    "/sucursales",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  sucursales: { type: "array", items: sucursalSchema },
                },
                required: ["sucursales"],
                additionalProperties: false,
              },
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
        return sendPublicCatalogError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      try {
        const { rows } = await app.db.query(PUBLIC_BRANCHES_SQL);
        return sendOk(reply, {
          sucursales: rows.map(mapBranchRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog sucursales error");
        return sendPublicCatalogError(reply, request.id, 500, "No se pudo consultar sucursales publicas del catalogo", "PUBLIC_CATALOG_BRANCHES_ERROR");
      }
    }
  );

  app.get(
    "/servicios",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            id_barbero: { type: "string", format: "uuid" },
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
                  servicios: { type: "array", items: servicioSchema },
                },
                required: ["servicios"],
                additionalProperties: false,
              },
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
        return sendPublicCatalogError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      try {
        const { rows } = await app.db.query(PUBLIC_SERVICES_SQL, [
          request.query?.id_sucursal ?? null,
          request.query?.id_barbero ?? null,
        ]);
        return sendOk(reply, {
          servicios: rows.map(mapServiceRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog servicios error");
        return sendPublicCatalogError(reply, request.id, 500, "No se pudo consultar el catalogo de servicios", "PUBLIC_CATALOG_SERVICES_ERROR");
      }
    }
  );

  app.get(
    "/paquetes",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            id_barbero: { type: "string", format: "uuid" },
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
                  paquetes: { type: "array", items: paqueteSchema },
                },
                required: ["paquetes"],
                additionalProperties: false,
              },
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
        return sendPublicCatalogError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      try {
        const { rows } = await app.db.query(PUBLIC_PACKAGES_SQL, [
          request.query?.id_sucursal ?? null,
          request.query?.id_barbero ?? null,
        ]);
        return sendOk(reply, {
          paquetes: rows.map(mapPackageRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog paquetes error");
        return sendPublicCatalogError(reply, request.id, 500, "No se pudo consultar el catalogo de paquetes", "PUBLIC_CATALOG_PACKAGES_ERROR");
      }
    }
  );

  app.get(
    "/busqueda",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            q: { type: "string", minLength: 1, maxLength: 80 },
          },
          required: ["q"],
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
                  servicios: { type: "array", items: servicioSchema },
                  paquetes: { type: "array", items: paqueteSchema },
                  planes: { type: "array", items: planSchema },
                },
                required: ["servicios", "paquetes", "planes"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        return sendPublicCatalogError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      const branchId = request.query?.id_sucursal ?? null;
      const queryText = String(request.query?.q || "").trim().toLowerCase();
      if (!queryText) {
        return sendPublicCatalogError(reply, request.id, 400, "Debes indicar un termino de busqueda", "PUBLIC_CATALOG_SEARCH_QUERY_REQUIRED");
      }
      const likeSearch = `%${queryText}%`;

      try {
        const [serviceResult, packageResult, planResult] = await Promise.all([
          app.db.query(PUBLIC_SERVICES_SEARCH_SQL, [branchId, null, likeSearch]),
          app.db.query(PUBLIC_PACKAGES_SEARCH_SQL, [branchId, likeSearch, null]),
          app.db.query(PUBLIC_PLANS_SEARCH_SQL, [branchId, likeSearch]),
        ]);
        const mappedPlans = planResult.rows.map(mapPlanRow).filter(isValidPublicPlan);

        return sendOk(reply, {
          servicios: serviceResult.rows.map(mapServiceRow),
          paquetes: packageResult.rows.map(mapPackageRow),
          planes: mappedPlans,
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog busqueda error");
        return sendPublicCatalogError(reply, request.id, 500, "No se pudo consultar la busqueda del catalogo", "PUBLIC_CATALOG_SEARCH_ERROR");
      }
    }
  );

  app.get(
    "/promociones",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
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
                  promociones: { type: "array", items: promocionSchema },
                },
                required: ["promociones"],
                additionalProperties: false,
              },
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
        return sendPublicCatalogError(reply, request.id, 500, "Base de datos no configurada", "DB_NOT_CONFIGURED");
      }

      try {
        const { rows } = await app.db.query(PUBLIC_PROMOTIONS_SQL, [request.query?.id_sucursal ?? null]);
        const businessNow = getBusinessNowParts();
        const activeRows = rows.filter((row) => {
          const status = getPromotionVigenciaStatus(row, businessNow);
          return status === "vigente" || status === "sin_vigencia";
        });
        return sendOk(reply, {
          promociones: activeRows.map(mapPromotionRow),
        });
      } catch (error) {
        request.log.error({ err: error }, "Public catalog promociones error");
        if (
          error?.code === "42P01" &&
          (String(error?.message || "").includes("promociones_sucursal") || String(error?.message || "").includes("promociones"))
        ) {
          return sendError(reply, 500, "Falta aplicar migracion de PROMOCIONES multi-sucursal en la base de datos", {
            code: "PUBLIC_PROMOTIONS_MIGRATION_REQUIRED",
            requestId: request.id,
          });
        }
        return sendPublicCatalogError(reply, request.id, 500, "No se pudo consultar el catalogo de promociones", "PUBLIC_CATALOG_PROMOTIONS_ERROR");
      }
    }
  );
}
