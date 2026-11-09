import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";

const TIMEZONE = "America/Tegucigalpa";

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

const SUMMARY_SQL = `
  SELECT
    (SELECT COUNT(c.id_cita)::bigint FROM public.citas c WHERE c.deleted_at IS NULL) AS total_citas,
    (SELECT COALESCE(SUM(c.total_pagar_hnl), 0)::numeric
       FROM public.citas c
      WHERE c.deleted_at IS NULL
        AND c.estado_cita_codigo = ANY($1::text[])) AS valor_citas_hnl,
    (SELECT COUNT(s.id_suscripcion)::bigint
       FROM public.subscriptions s
      WHERE s.inicio_at >= $2::timestamptz
        AND s.inicio_at < $3::timestamptz) AS planes_activados,
    (SELECT COUNT(DISTINCT pt.id_points_tx)::bigint
       FROM public.points_transactions pt
      WHERE pt.tipo_puntos_codigo = 'canjear'
        AND pt.created_at >= $2::timestamptz
        AND pt.created_at < $3::timestamptz) AS masterpuntos_canjeados`;

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
        ["confirmada", "en_salon", "en_atencion", "completada"],
        hondurasDayStartUtc(fechaDesde),
        hondurasDayStartUtc(addDay(fechaHasta)),
      ];
      const { rows } = await app.db.query(SUMMARY_SQL, values);
      const row = rows[0] || {};
      return sendOk(reply, {
        total_citas: Number(row.total_citas || 0),
        valor_citas_hnl: Number(row.valor_citas_hnl || 0),
        planes_activados: Number(row.planes_activados || 0),
        masterpuntos_canjeados: Number(row.masterpuntos_canjeados || 0),
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
