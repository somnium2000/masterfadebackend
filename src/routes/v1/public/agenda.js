import {
  AppError,
  sendError,
} from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import {
  assertBookingSelectionRuntimeSupported,
  assertUuid,
  buildCuratedSlotExposure,
  buildCuratedSlotExposureDebug,
  countDateKeyRangeDays,
  expireStaleAppointmentReservations,
  getMinSellableServiceMinutes,
  listAvailabilityByDateRangeForRequest,
  listBarbersForBranch,
  mapBarbersForResponse,
  mapDayAvailabilityForResponse,
  mapSlotsForResponse,
  parseDateOnly,
  resolveEffectiveDayAvailability,
  SLOT_INTERVAL_MINUTES,
} from "../../../services/agendaService.js";

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

const barberSchema = {
  type: "object",
  properties: {
    id_empleado: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
    nombre_sucursal: { type: ["string", "null"] },
    nombre_completo: { type: "string" },
    nombres: { type: "string" },
    apellidos: { type: "string" },
    alias_publico: { type: ["string", "null"] },
    resumen_publico: { type: ["string", "null"] },
    certificaciones_titulos: { type: "array", items: { type: "string" } },
    visible_en_landing: { type: "boolean" },
    foto_perfil_url: { type: ["string", "null"] },
    foto_perfil_updated_at: { type: ["string", "null"], format: "date-time" },
  },
  required: [
    "id_empleado",
    "id_sucursal",
    "nombre_sucursal",
    "nombre_completo",
    "nombres",
    "apellidos",
    "alias_publico",
    "resumen_publico",
    "certificaciones_titulos",
    "visible_en_landing",
    "foto_perfil_url",
    "foto_perfil_updated_at",
  ],
  additionalProperties: false,
};

const availabilityDaySchema = {
  type: "object",
  properties: {
    fecha: { type: "string", format: "date" },
    disponible: { type: "boolean" },
    barberos_disponibles: { type: "integer" },
    primer_horario_disponible: { type: ["string", "null"] },
    barbero_autoasignado: {
      anyOf: [
        barberSchema,
        { type: "null" },
      ],
    },
    tiempos_efectivos: {
      anyOf: [
        {
          type: "object",
          properties: {
            duracion_total_min: { type: "integer" },
            buffer_total_min: { type: "integer" },
            fecha_operativa: { type: "string", format: "date" },
            monto_subtotal_hnl: { type: "number" },
            monto_isv_hnl: { type: "number" },
            monto_total_hnl: { type: "number" },
          },
          required: ["duracion_total_min", "buffer_total_min", "fecha_operativa"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["fecha", "disponible", "barberos_disponibles", "primer_horario_disponible", "barbero_autoasignado", "tiempos_efectivos"],
  additionalProperties: false,
};

const slotSchema = {
  type: "object",
  properties: {
    hora: { type: "string" },
    inicio_at: { type: "string", format: "date-time" },
    fin_at: { type: "string", format: "date-time" },
    disponible: { type: "boolean" },
    duracion_visible_min: { type: "integer" },
    hora_fin_visible: { type: "string" },
    period_key: { type: "string", enum: ["manana", "tarde", "noche"] },
    range_label: { type: "string" },
  },
  required: ["hora", "inicio_at", "fin_at", "disponible", "duracion_visible_min", "hora_fin_visible", "period_key", "range_label"],
  additionalProperties: false,
};

const bookingPromotionSchema = {
  type: "object",
  properties: {
    id_promocion: { type: "string", format: "uuid" },
    id_promocion_regla: { type: "string", format: "uuid" },
    id_sucursal: { type: "string", format: "uuid" },
    titulo: { type: "string" },
    subtitulo: { type: ["string", "null"] },
    descripcion: { type: ["string", "null"] },
    tipo_promocion: { type: "string" },
    aplica_a: { type: "string", enum: ["servicio", "paquete"] },
    mecanica: { type: "string", enum: ["porcentaje", "monto_fijo", "dos_por_uno"] },
    id_servicio_objetivo: { type: ["string", "null"], format: "uuid" },
    id_paquete_objetivo: { type: ["string", "null"], format: "uuid" },
    valor_descuento: { type: ["number", "null"] },
    cantidad_requerida: { type: ["integer", "null"] },
    cantidad_bonificada: { type: ["integer", "null"] },
    resumen_promocion: { type: "string" },
    vigencia_desde: { type: ["string", "null"], format: "date" },
    vigencia_hasta: { type: ["string", "null"], format: "date" },
    vigencia_hora_desde: { type: ["string", "null"] },
    vigencia_hora_hasta: { type: ["string", "null"] },
    servicio_objetivo_nombre: { type: ["string", "null"] },
    paquete_objetivo_nombre: { type: ["string", "null"] },
  },
  required: [
    "id_promocion",
    "id_promocion_regla",
    "id_sucursal",
    "titulo",
    "subtitulo",
    "descripcion",
    "tipo_promocion",
    "aplica_a",
    "mecanica",
    "id_servicio_objetivo",
    "id_paquete_objetivo",
    "valor_descuento",
    "cantidad_requerida",
    "cantidad_bonificada",
    "resumen_promocion",
    "vigencia_desde",
    "vigencia_hasta",
    "vigencia_hora_desde",
    "vigencia_hora_hasta",
    "servicio_objetivo_nombre",
    "paquete_objetivo_nombre",
  ],
  additionalProperties: false,
};

const PUBLIC_BOOKING_PROMOTIONS_SQL = `
  -- JK: Expone promociones publicas para agendamiento desde reglas normalizadas.
  SELECT
    p.id_promocion,
    pra.id_promocion_regla,
    ps.id_sucursal,
    p.titulo,
    p.subtitulo,
    p.parrafos,
    p.tipo_promocion,
    p.aplica_a,
    p.mecanica,
    COALESCE(pia.id_servicio, p.id_servicio_objetivo) AS id_servicio_objetivo,
    COALESCE(pia.id_paquete, p.id_paquete_objetivo) AS id_paquete_objetivo,
    COALESCE(pra.valor_descuento, p.valor_descuento) AS valor_descuento,
    COALESCE(pia.cantidad_minima, p.cantidad_requerida) AS cantidad_requerida,
    p.cantidad_bonificada,
    ps.vigencia_desde,
    ps.vigencia_hasta,
    ps.vigencia_hora_desde,
    ps.vigencia_hora_hasta,
    s.nombre_servicio AS servicio_objetivo_nombre,
    pk.nombre_paquete AS paquete_objetivo_nombre
  FROM public.promociones p
  JOIN public.promociones_sucursal ps
    ON ps.id_promocion = p.id_promocion
  JOIN public.promociones_reglas_agendamiento pra
    ON pra.id_promocion = p.id_promocion
   AND pra.activo IS TRUE
  LEFT JOIN public.promociones_items_agendamiento pia
    ON pia.id_promocion_regla = pra.id_promocion_regla
   AND (
      (pia.tipo_item_codigo = 'servicio' AND pia.id_servicio IS NOT NULL)
      OR (pia.tipo_item_codigo = 'paquete' AND pia.id_paquete IS NOT NULL)
   )
  JOIN public.sucursales su
    ON su.id_sucursal = ps.id_sucursal
  LEFT JOIN public.servicios s
    ON s.id_servicio = COALESCE(pia.id_servicio, p.id_servicio_objetivo)
   AND s.deleted_at IS NULL
  LEFT JOIN public.paquetes pk
    ON pk.id_paquete = COALESCE(pia.id_paquete, p.id_paquete_objetivo)
   AND pk.deleted_at IS NULL
  CROSS JOIN (
    SELECT (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS business_date
  ) business_clock
  WHERE ps.id_sucursal = $1::uuid
    AND su.deleted_at IS NULL
    AND su.estado IS TRUE
    AND p.estado = 'publicada'
    AND ps.visible_publico IS TRUE
    AND (ps.vigencia_desde IS NULL OR ps.vigencia_desde <= business_clock.business_date)
    AND (ps.vigencia_hasta IS NULL OR ps.vigencia_hasta >= business_clock.business_date)
    AND p.tipo_promocion IN ('descuento_servicio', 'descuento_paquete', 'dos_por_uno_servicio')
    AND p.aplica_a IN ('servicio', 'paquete')
    AND p.mecanica IN ('porcentaje', 'monto_fijo', 'dos_por_uno')
    AND (
      (p.mecanica = 'porcentaje' AND p.valor_descuento IS NOT NULL AND p.valor_descuento > 0 AND p.valor_descuento <= 100)
      OR (p.mecanica = 'monto_fijo' AND p.valor_descuento IS NOT NULL AND p.valor_descuento > 0)
      OR (p.mecanica = 'dos_por_uno' AND COALESCE(p.cantidad_requerida, 0) > 0 AND COALESCE(p.cantidad_bonificada, 0) > 0)
    )
    AND (
      (
        p.aplica_a = 'servicio'
        AND COALESCE(pia.id_servicio, p.id_servicio_objetivo) IS NOT NULL
        AND s.id_servicio IS NOT NULL
        AND s.activo IS TRUE
        AND s.agendable IS TRUE
        AND s.visible_publico IS TRUE
        AND EXISTS (
          SELECT 1
          FROM public.servicios_tarifas st
          WHERE st.id_servicio = COALESCE(pia.id_servicio, p.id_servicio_objetivo)
            AND st.id_sucursal = ps.id_sucursal
            AND st.deleted_at IS NULL
            AND st.activo IS TRUE
            AND st.vigente_desde <= business_clock.business_date
            AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= business_clock.business_date)
            AND st.precio_hnl > 0
        )
      )
      OR (
        p.aplica_a = 'paquete'
        AND COALESCE(pia.id_paquete, p.id_paquete_objetivo) IS NOT NULL
        AND pk.id_paquete IS NOT NULL
        AND pk.activo IS TRUE
        AND EXISTS (
          SELECT 1
          FROM public.paquetes_sucursal psq
          WHERE psq.id_paquete = COALESCE(pia.id_paquete, p.id_paquete_objetivo)
            AND psq.id_sucursal = ps.id_sucursal
            AND psq.activo IS TRUE
            AND psq.visible_publico IS TRUE
            AND psq.precio_hnl > 0
        )
      )
    )
  ORDER BY ps.orden_visual ASC, p.titulo ASC
`;

const curatedPeriodSchema = {
  type: "object",
  properties: {
    recommended: {
      anyOf: [slotSchema, { type: "null" }],
    },
    alternatives: { type: "array", items: slotSchema },
    overflow: { type: "array", items: slotSchema },
    has_more: { type: "boolean" },
    total: { type: "integer" },
  },
  required: ["recommended", "alternatives", "overflow", "has_more", "total"],
  additionalProperties: false,
};

function sendHandled(reply, request, error, message, code) {
  const errorCode = String(error?.code || "").trim().toUpperCase();
  const errorMessage = String(error?.message || "");
  const isPoolSaturated = errorCode === "53300"
    || errorMessage.includes("MAXCONNSESSION")
    || /too many clients/i.test(errorMessage)
    || /max clients reached/i.test(errorMessage);
  if (isPoolSaturated) {
    return sendError(reply, 503, "Servicio de agenda temporalmente saturado. Intenta nuevamente en unos minutos.", {
      code: "PUBLIC_AGENDA_DB_POOL_SATURATED",
      requestId: request.id,
    });
  }
  if (error instanceof AppError) {
    request.log.warn(
      {
        requestId: request.id,
        statusCode: error.statusCode,
        code: error.code,
        details: error.details,
      },
      "Public agenda handled AppError"
    );
    return sendError(reply, error.statusCode, error.message, {
      code: error.code,
      requestId: request.id,
    });
  }

  request.log.error({ err: error }, message);
  return sendError(reply, 500, message, {
    code,
    requestId: request.id,
  });
}

function formatPromotionNumber(value, fractionDigits = 2) {
  // JK: Formatea descuentos sin decimales innecesarios para el resumen visible en agendamiento.
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const fixed = parsed.toFixed(fractionDigits);
  return fixed.includes(".")
    ? fixed.replace(/\.?0+$/, "")
    : fixed;
}

function normalizePromotionParagraphs(value) {
  // JK: Permite leer descripcion de promociones tanto en arreglo JSON como en texto plano legado.
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

function buildPromotionSummary(row) {
  // JK: Replica resumen operativo para evitar mostrar etiquetas engañosas en promociones incompletas.
  const aplicaA = String(row?.aplica_a || "").toLowerCase();
  const mecanica = String(row?.mecanica || "").toLowerCase();
  const scopeLabel = aplicaA === "paquete" ? "Paquete" : "Servicio";
  const hasServiceTarget = Boolean(String(row?.id_servicio_objetivo || "").trim());
  const hasPackageTarget = Boolean(String(row?.id_paquete_objetivo || "").trim());
  const value = Number(row?.valor_descuento);
  const hasDiscountValue = Number.isFinite(value) && value > 0;

  const missingOperationalData = (
    (aplicaA === "servicio" && !hasServiceTarget)
    || (aplicaA === "paquete" && !hasPackageTarget)
    || (mecanica === "porcentaje" && !hasDiscountValue)
    || (mecanica === "monto_fijo" && !hasDiscountValue)
    || (
      mecanica === "dos_por_uno"
      && ((aplicaA === "paquete" && !hasPackageTarget) || (aplicaA !== "paquete" && !hasServiceTarget))
    )
  );
  if (missingOperationalData) return "Sin aplicación configurada";

  if (mecanica === "porcentaje") {
    const normalized = formatPromotionNumber(row?.valor_descuento);
    return normalized ? `${scopeLabel} · ${normalized}%` : "Sin aplicación configurada";
  }
  if (mecanica === "monto_fijo") {
    const normalized = formatPromotionNumber(row?.valor_descuento);
    return normalized ? `${scopeLabel} · L ${normalized}` : "Sin aplicación configurada";
  }
  if (mecanica === "dos_por_uno") {
    const requerida = Number(row?.cantidad_requerida ?? 1);
    const bonificada = Number(row?.cantidad_bonificada ?? 1);
    const safeRequerida = Number.isInteger(requerida) && requerida > 0 ? requerida : 1;
    const safeBonificada = Number.isInteger(bonificada) && bonificada > 0 ? bonificada : 1;
    const paidUnits = Math.max(0, safeRequerida - safeBonificada);
    return `${scopeLabel} · Compra ${safeRequerida}, paga ${paidUnits}`;
  }

  return "Sin aplicación configurada";
}

function mapBookingPromotionRow(row) {
  const paragraphs = normalizePromotionParagraphs(row?.parrafos);
  return {
    id_promocion: row.id_promocion,
    id_promocion_regla: row.id_promocion_regla,
    id_sucursal: String(row.id_sucursal || "").trim(),
    titulo: row.titulo,
    subtitulo: row.subtitulo ?? null,
    descripcion: paragraphs[0] ?? (row.subtitulo ?? null),
    tipo_promocion: row.tipo_promocion,
    aplica_a: row.aplica_a,
    mecanica: row.mecanica,
    id_servicio_objetivo: row.id_servicio_objetivo ?? null,
    id_paquete_objetivo: row.id_paquete_objetivo ?? null,
    valor_descuento: row.valor_descuento == null ? null : Number(row.valor_descuento),
    cantidad_requerida: row.cantidad_requerida == null ? null : Number(row.cantidad_requerida),
    cantidad_bonificada: row.cantidad_bonificada == null ? null : Number(row.cantidad_bonificada),
    resumen_promocion: buildPromotionSummary(row),
    vigencia_desde: row.vigencia_desde ?? null,
    vigencia_hasta: row.vigencia_hasta ?? null,
    vigencia_hora_desde: row.vigencia_hora_desde ?? null,
    vigencia_hora_hasta: row.vigencia_hora_hasta ?? null,
    servicio_objetivo_nombre: row.servicio_objetivo_nombre ?? null,
    paquete_objetivo_nombre: row.paquete_objetivo_nombre ?? null,
  };
}

function canExposeSlotDebug(request) {
  const askDebug = String(request.query?.debug || "").trim().toLowerCase();
  if (!["1", "true", "yes"].includes(askDebug)) return false;
  const roles = Array.isArray(request.claims?.roles) ? request.claims.roles : [];
  return roles.includes("admin") || roles.includes("super_admin") || roles.includes("barbero");
}

function mapDiscardedReasonSummary(discarded) {
  const counts = new Map();
  (Array.isArray(discarded) ? discarded : []).forEach((entry) => {
    const code = String(entry?.reason || "").trim();
    if (!code) return;
    counts.set(code, (counts.get(code) || 0) + 1);
  });
  return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
}

function mapTariffsForResponse(selection) {
  return (Array.isArray(selection?.items) ? selection.items : []).map((item) => ({
    id_servicio: item.id_servicio,
    id_tarifa: item.id_tarifa ?? null,
    precio_hnl: Number(item.precio_hnl || 0),
    precio_total_hnl: Number(item.precio_total_hnl ?? item.total_linea_hnl ?? item.precio_hnl ?? 0),
    incluye_isv_snapshot: item.incluye_isv_snapshot === true || item.incluye_isv === true,
    isv_porcentaje: Number(item.isv_porcentaje || 0),
    isv_hnl: Number(item.isv_hnl || 0),
  }));
}

async function expireReservationsBestEffort(app, request, dbClient = null) {
  try {
    await expireStaleAppointmentReservations(dbClient || app.db, { logger: request.log });
  } catch (error) {
    request.log.warn(
      {
        requestId: request.id,
        code: error?.code || null,
        message: error?.message || null,
      },
      "No se pudieron expirar reservas vencidas en agenda publica; se continua con la consulta"
    );
  }
}

export default async function publicAgendaRoutes(app) {
  app.get(
    "/barberos",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal"],
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
                  barberos: { type: "array", items: barberSchema },
                },
                required: ["barberos"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const barberos = await listBarbersForBranch(dbClient, idSucursal);
        return sendOk(reply, {
          barberos: mapBarbersForResponse(barberos),
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo consultar el catalogo de barberos", "PUBLIC_AGENDA_BARBERS_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/promociones",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal"],
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
                  promociones: { type: "array", items: bookingPromotionSchema },
                },
                required: ["promociones"],
                additionalProperties: false,
              },
              requestId: requestIdSchema,
            },
            required: ["ok", "data"],
            additionalProperties: true,
          },
          400: errorResponseSchema,
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        // JK: Reusa limpieza de holds vencidos para mantener consistencia con disponibilidad pública.
        await expireStaleAppointmentReservations(app.db, { logger: request.log });
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const { rows } = await app.db.query(PUBLIC_BOOKING_PROMOTIONS_SQL, [idSucursal]);
        return sendOk(reply, {
          promociones: rows.map(mapBookingPromotionRow),
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudieron consultar promociones disponibles para agendamiento", "PUBLIC_AGENDA_PROMOTIONS_ERROR");
      }
    }
  );

  app.get(
    "/disponibilidad",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "fecha_desde", "fecha_hasta"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            servicios: { type: "string" },
            id_paquete: { type: "string", format: "uuid" },
            fecha_desde: { type: "string", format: "date" },
            fecha_hasta: { type: "string", format: "date" },
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
                  disponibilidad: { type: "array", items: availabilityDaySchema },
                  duracion_total_min: { anyOf: [{ type: "integer" }, { type: "null" }] },
                  buffer_total_min: { anyOf: [{ type: "integer" }, { type: "null" }] },
                },
                required: ["disponibilidad", "duracion_total_min", "buffer_total_min"],
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const fechaDesde = parseDateOnly(request.query?.fecha_desde, "fecha_desde");
        const fechaHasta = parseDateOnly(request.query?.fecha_hasta, "fecha_hasta");
        const selectionType = assertBookingSelectionRuntimeSupported(request.query?.selection_type || "services");
        const rangeDays = countDateKeyRangeDays(fechaDesde, fechaHasta);
        if (rangeDays > 60) {
          throw new AppError(400, "El rango de fechas no puede superar los 60 dias", { code: "PUBLIC_AGENDA_DATE_RANGE_TOO_LARGE" });
        }
        const rangeResult = await listAvailabilityByDateRangeForRequest(dbClient, {
          id_sucursal: idSucursal,
          selection_type: selectionType,
          servicios: request.query?.servicios,
          id_paquete: request.query?.id_paquete ?? null,
          fecha_desde: fechaDesde,
          fecha_hasta: fechaHasta,
          id_barbero: idBarbero,
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });

        return sendOk(reply, {
          disponibilidad: mapDayAvailabilityForResponse(rangeResult.disponibilidad),
          duracion_total_min: rangeResult.duracion_total_min,
          buffer_total_min: rangeResult.buffer_total_min,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudo calcular disponibilidad", "PUBLIC_AGENDA_AVAILABILITY_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );

  app.get(
    "/horarios",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["id_sucursal", "fecha"],
          properties: {
            id_sucursal: { type: "string", format: "uuid" },
            selection_type: { type: "string", enum: ["services", "package", "mixed"] },
            servicios: { type: "string" },
            id_paquete: { type: "string", format: "uuid" },
            fecha: { type: "string", format: "date" },
            id_barbero: { type: "string", format: "uuid" },
            debug: { type: "boolean" },
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
                  fecha: { type: "string", format: "date" },
                  id_barbero: { type: ["string", "null"], format: "uuid" },
                  barbero: {
                    anyOf: [
                      barberSchema,
                      { type: "null" },
                    ],
                  },
                  horarios: { type: "array", items: slotSchema },
                  horarios_curados: {
                    type: "object",
                    properties: {
                      manana: curatedPeriodSchema,
                      tarde: curatedPeriodSchema,
                      noche: curatedPeriodSchema,
                    },
                    required: ["manana", "tarde", "noche"],
                    additionalProperties: false,
                  },
                  hora_inicio: { type: ["string", "null"] },
                  hora_fin: { type: ["string", "null"] },
                  duracion_total_min: { type: "integer" },
                  buffer_total_min: { type: "integer" },
                  monto_subtotal_hnl: { type: "number" },
                  monto_isv_hnl: { type: "number" },
                  monto_total_hnl: { type: "number" },
                  tarifas: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id_servicio: { type: "string", format: "uuid" },
                        id_tarifa: { type: ["string", "null"], format: "uuid" },
                        precio_hnl: { type: "number" },
                        precio_total_hnl: { type: "number" },
                        incluye_isv_snapshot: { type: "boolean" },
                        isv_porcentaje: { type: "number" },
                        isv_hnl: { type: "number" },
                      },
                      required: [
                        "id_servicio",
                        "id_tarifa",
                        "precio_hnl",
                        "precio_total_hnl",
                        "incluye_isv_snapshot",
                        "isv_porcentaje",
                        "isv_hnl",
                      ],
                      additionalProperties: false,
                    },
                  },
                  slot_step_min: { type: "integer" },
                  debug: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
                },
                required: [
                  "fecha",
                  "id_barbero",
                  "barbero",
                  "horarios",
                  "horarios_curados",
                  "hora_inicio",
                  "hora_fin",
                  "duracion_total_min",
                  "buffer_total_min",
                  "monto_subtotal_hnl",
                  "monto_isv_hnl",
                  "monto_total_hnl",
                  "tarifas",
                  "slot_step_min",
                  "debug",
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
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dbClient = await app.db.connect();
      try {
        await expireReservationsBestEffort(app, request, dbClient);
        const idSucursal = assertUuid(request.query?.id_sucursal, "id_sucursal");
        const fecha = parseDateOnly(request.query?.fecha, "fecha");
        const idBarbero = request.query?.id_barbero ? assertUuid(request.query.id_barbero, "id_barbero") : null;
        const minSellableDurationMin = await getMinSellableServiceMinutes(dbClient);
        const includeDebug = canExposeSlotDebug(request);
        const selectionType = assertBookingSelectionRuntimeSupported(request.query?.selection_type || "services");
        const availability = await resolveEffectiveDayAvailability(dbClient, {
          id_sucursal: idSucursal,
          selection_type: selectionType,
          servicios: request.query?.servicios,
          id_paquete: request.query?.id_paquete ?? null,
          id_barbero: idBarbero,
          fecha,
          minSellableDurationMin,
          includeDiscardReasons: Boolean(idBarbero && includeDebug),
          bookingIsvEnabled: app.config?.bookingIsvEnabled,
        });
        const serviceSelection = availability.service_selection || null;
        const effectiveSelection = availability.effective_selection || null;
        const horarios = mapSlotsForResponse(availability.slots ?? [], {
          duracion_visible_min: Number(effectiveSelection?.duracion_total_min || 0),
        });
        const horariosCurados = buildCuratedSlotExposure(horarios, {
          minSellableDurationMin,
        });
        const debugPayload = includeDebug
          ? {
              discarded_reason_codes: idBarbero ? mapDiscardedReasonSummary(availability?.discarded_slots) : [],
              discarded_slots: idBarbero && Array.isArray(availability?.discarded_slots)
                ? availability.discarded_slots.slice(0, 120)
                : [],
              curated_ranking: buildCuratedSlotExposureDebug(horarios, {
                minSellableDurationMin,
              }),
            }
          : null;
        return sendOk(reply, {
          fecha,
          id_barbero: availability.barbero_autoasignado?.id_empleado ?? null,
          barbero: availability.barbero_autoasignado ? mapBarbersForResponse([availability.barbero_autoasignado])[0] : null,
          horarios,
          horarios_curados: horariosCurados,
          hora_inicio: availability.hora_inicio ?? null,
          hora_fin: availability.hora_fin ?? null,
          duracion_total_min: Number(effectiveSelection?.duracion_total_min || 0),
          buffer_total_min: Number(effectiveSelection?.buffer_total_min || 0),
          monto_subtotal_hnl: Number(effectiveSelection?.monto_subtotal_hnl || 0),
          monto_isv_hnl: Number(effectiveSelection?.monto_isv_hnl || 0),
          monto_total_hnl: Number(effectiveSelection?.monto_total_hnl || 0),
          tarifas: mapTariffsForResponse(serviceSelection),
          slot_step_min: SLOT_INTERVAL_MINUTES,
          debug: debugPayload,
        });
      } catch (error) {
        return sendHandled(reply, request, error, "No se pudieron consultar los horarios del dia", "PUBLIC_AGENDA_SLOTS_ERROR");
      } finally {
        dbClient.release();
      }
    }
  );
}
