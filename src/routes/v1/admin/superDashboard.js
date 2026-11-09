import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const TIMEZONE = "America/Tegucigalpa";
const SUCCESS_PAYMENT_STATES = ["capturado", "conciliado", "manual_pagado"];

function dateOnlyInHonduras(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseDateOnly(value, field) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(400, `${field} debe usar el formato YYYY-MM-DD`, { code: "SUPER_DASHBOARD_DATE_INVALID" });
  }
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new AppError(400, `${field} debe ser una fecha valida`, { code: "SUPER_DASHBOARD_DATE_INVALID" });
  }
  return raw;
}

function addDay(dateOnly) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

function hondurasDayStartUtc(dateOnly) {
  return `${dateOnly}T06:00:00.000Z`;
}

function resolveGrouping(fechaDesde, fechaHasta) {
  const from = new Date(`${fechaDesde}T00:00:00.000Z`);
  const to = new Date(`${fechaHasta}T00:00:00.000Z`);
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days <= 1) return "hour";
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  if (days <= 730) return "month";
  return "year";
}

const SUMMARY_SQL = `
  WITH eligible_payments AS (
    SELECT DISTINCT p.id_payment, p.monto_hnl, p.paid_at
    FROM public.payments p
    JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
    JOIN public.citas c ON c.id_cita = pi.id_cita
    WHERE p.estado_pago_codigo = ANY($1::text[])
      AND p.paid_at IS NOT NULL
      AND c.deleted_at IS NULL
  ),
  income_by_bucket AS (
    SELECT
      date_trunc($4::text, ep.paid_at AT TIME ZONE '${TIMEZONE}') AS bucket,
      COALESCE(SUM(ep.monto_hnl), 0)::numeric AS total_hnl
    FROM eligible_payments ep
    WHERE ep.paid_at >= $2::timestamptz
      AND ep.paid_at < $3::timestamptz
    GROUP BY 1
  ),
  activity_rows AS (
    SELECT date_trunc($4::text, s.inicio_at AT TIME ZONE '${TIMEZONE}') AS bucket,
           1::bigint AS planes, 0::bigint AS canjes
    FROM public.subscriptions s
    WHERE s.inicio_at >= $2::timestamptz AND s.inicio_at < $3::timestamptz
    UNION ALL
    SELECT date_trunc($4::text, pt.created_at AT TIME ZONE '${TIMEZONE}') AS bucket,
           0::bigint AS planes, 1::bigint AS canjes
    FROM public.points_transactions pt
    WHERE pt.tipo_puntos_codigo = 'canjear'
      AND pt.created_at >= $2::timestamptz AND pt.created_at < $3::timestamptz
  ),
  activity_by_bucket AS (
    SELECT bucket, SUM(planes)::bigint AS planes_activados,
           SUM(canjes)::bigint AS masterpuntos_canjeados
    FROM activity_rows
    GROUP BY bucket
  )
  SELECT
    (SELECT COUNT(c.id_cita)::bigint FROM public.citas c WHERE c.deleted_at IS NULL) AS total_citas,
    (SELECT COALESCE(SUM(ep.monto_hnl), 0)::numeric FROM eligible_payments ep) AS ingresos_citas_hnl_total,
    (SELECT COALESCE(SUM(ep.monto_hnl), 0)::numeric FROM eligible_payments ep
      WHERE ep.paid_at >= $2::timestamptz AND ep.paid_at < $3::timestamptz) AS ingresos_citas_hnl_periodo,
    (SELECT COUNT(s.id_suscripcion)::bigint
       FROM public.subscriptions s
      WHERE s.inicio_at >= $2::timestamptz
        AND s.inicio_at < $3::timestamptz) AS planes_activados,
    (SELECT COUNT(DISTINCT pt.id_points_tx)::bigint
       FROM public.points_transactions pt
      WHERE pt.tipo_puntos_codigo = 'canjear'
        AND pt.created_at >= $2::timestamptz
        AND pt.created_at < $3::timestamptz) AS masterpuntos_canjeados,
    COALESCE((SELECT json_agg(json_build_object(
      'periodo', to_char(ib.bucket, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'ingresos_hnl', ib.total_hnl
    ) ORDER BY ib.bucket) FROM income_by_bucket ib), '[]'::json) AS ingresos_serie,
    COALESCE((SELECT json_agg(json_build_object(
      'periodo', to_char(ab.bucket, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'planes_activados', ab.planes_activados,
      'masterpuntos_canjeados', ab.masterpuntos_canjeados
    ) ORDER BY ab.bucket) FROM activity_by_bucket ab), '[]'::json) AS actividad_serie`;

export default async function superDashboardRoutes(app) {
  app.get("/summary", { preHandler: app.requireRoles(["super_admin"]) }, async (request, reply) => {
    try {
      const today = dateOnlyInHonduras();
      const fechaDesde = parseDateOnly(request.query?.fecha_desde || today, "fecha_desde");
      const fechaHasta = parseDateOnly(request.query?.fecha_hasta || today, "fecha_hasta");
      if (fechaDesde > fechaHasta) {
        throw new AppError(400, "fecha_desde no puede ser mayor que fecha_hasta", { code: "SUPER_DASHBOARD_DATE_RANGE_INVALID" });
      }

      const values = [
        SUCCESS_PAYMENT_STATES,
        hondurasDayStartUtc(fechaDesde),
        hondurasDayStartUtc(addDay(fechaHasta)),
        resolveGrouping(fechaDesde, fechaHasta),
      ];
      const { rows } = await app.db.query(SUMMARY_SQL, values);
      const row = rows[0] || {};
      return sendOk(reply, {
        total_citas: Number(row.total_citas || 0),
        ingresos_citas_hnl_total: Number(row.ingresos_citas_hnl_total || 0),
        ingresos_citas_hnl_periodo: Number(row.ingresos_citas_hnl_periodo || 0),
        planes_activados: Number(row.planes_activados || 0),
        masterpuntos_canjeados: Number(row.masterpuntos_canjeados || 0),
        ingresos_serie: Array.isArray(row.ingresos_serie) ? row.ingresos_serie.map((item) => ({
          periodo: item.periodo,
          ingresos_hnl: Number(item.ingresos_hnl || 0),
        })) : [],
        actividad_serie: Array.isArray(row.actividad_serie) ? row.actividad_serie.map((item) => ({
          periodo: item.periodo,
          planes_activados: Number(item.planes_activados || 0),
          masterpuntos_canjeados: Number(item.masterpuntos_canjeados || 0),
        })) : [],
        agrupacion: values[3],
        periodo: { fecha_desde: fechaDesde, fecha_hasta: fechaHasta },
        timezone: TIMEZONE,
        actualizado_at: new Date().toISOString(),
      }, { requestId: request.id });
    } catch (error) {
      if (error instanceof AppError) {
        return sendError(reply, error.statusCode, error.message, { code: error.code, requestId: request.id });
      }
      request.log.error({ err: error }, "No fue posible cargar el dashboard ejecutivo");
      return sendError(reply, 500, "No fue posible cargar el dashboard ejecutivo", {
        code: "SUPER_DASHBOARD_SUMMARY_ERROR",
        requestId: request.id,
      });
    }
  });
}
