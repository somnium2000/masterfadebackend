import { AppError, sendError } from "../../../utils/errors.js";
import { sendOk } from "../../../utils/response.js";
import { assertHostedAvailable, buildHostedRequest, hostedStatusPayload, loadHostedSession, requestHostedCheckout } from "../../../services/payments/pixelPayHosted.js";

const bodySchema = {
  type: "object", required: ["id_grupo_cita", "id_intent", "titular_email"], additionalProperties: false,
  properties: { id_grupo_cita: { type: "string", format: "uuid" }, id_intent: { type: "string", format: "uuid" },
    titular_email: { type: "string", format: "email", maxLength: 160 } },
};

export function registerHostedBookingRoutes(app, helpers) {
  const { routeGuard, paymentAccess, loadPublicIntentForGroup, assertPublicGroupPayable, resolveGroupExpiresAt, recalculateGroupPromotionsForPayment } = helpers;
  const respondError = (reply, request, error) => sendError(reply, error instanceof AppError ? error.statusCode : 503,
    error instanceof AppError ? error.message : "No se pudo consultar el pago seguro", {
      code: error instanceof AppError ? error.code : "PIXELPAY_HOSTED_UNAVAILABLE", requestId: request.id,
    });

  app.get("/pixelpay/hosted/capabilities", { ...routeGuard }, async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return sendOk(reply, { payment_channel: "hosted", available: app.config?.pixelPayHosted?.enabled === true,
      environment: "sandbox", automatic_confirmation: false });
  });

  app.post("/pixelpay/hosted/status", { ...routeGuard, schema: { body: bodySchema } }, async (request, reply) => {
    try {
      const { intent, groupRows } = await loadPublicIntentForGroup(app.db, {
        groupId: request.body.id_grupo_cita, idIntent: request.body.id_intent,
        titularEmail: request.body.titular_email, access: paymentAccess(request),
      });
      const session = await loadHostedSession(app.db, intent.id_intent);
      if (!session || intent.payment_channel !== "hosted") throw new AppError(404, "Pago seguro no encontrado", { code: "PIXELPAY_HOSTED_SESSION_NOT_FOUND" });
      reply.header("Cache-Control", "private, no-store");
      return sendOk(reply, hostedStatusPayload(session, intent, Date.now(), groupRows));
    } catch (error) { return respondError(reply, request, error); }
  });

  app.post("/pixelpay/hosted/start", {
    ...routeGuard, config: { rateLimit: { max: 5, timeWindow: "15 minutes", groupId: "pixelpay-hosted-start" } }, schema: { body: bodySchema },
  }, async (request, reply) => {
    let client;
    let inTransaction = false;
    let claimed = null;
    try {
      const config = app.config?.pixelPayHosted;
      assertHostedAvailable(config);
      client = await app.db.connect();
      await client.query("BEGIN");
      inTransaction = true;
      const { id_grupo_cita: groupId, id_intent: idIntent, titular_email: titularEmail } = request.body;
      // AM: El mismo lock de Sale serializa la seleccion irreversible del canal.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`pixelpay-sale:${idIntent}`]);
      const { intent, groupRows } = await loadPublicIntentForGroup(client, {
        groupId, idIntent, titularEmail, access: paymentAccess(request),
      });
      const existing = await loadHostedSession(client, idIntent);
      if (existing) {
        await client.query("COMMIT");
        inTransaction = false;
        return sendOk(reply, hostedStatusPayload(existing, intent, Date.now(), groupRows));
      }
      assertPublicGroupPayable(groupRows);
      resolveGroupExpiresAt(groupRows);
      if (intent.provider_code !== "pixelpay" || intent.payment_channel !== "sdk" || intent.estado_intent_codigo !== "link_generado"
        || intent.moneda_codigo !== "HNL" || new Date(intent.expires_at).getTime() <= Date.now()) {
        throw new AppError(409, "El pago no esta disponible para iniciar otro cobro", { code: "PIXELPAY_HOSTED_INTENT_UNAVAILABLE" });
      }
      const previous = await client.query(
        `SELECT 1 FROM app_private.pixelpay_sale_attempts sa JOIN public.payment_intents pi ON pi.id_intent = sa.id_intent
         WHERE pi.id_grupo_cita = $1::uuid
         UNION ALL SELECT 1 FROM app_private.pixelpay_hosted_sessions hs WHERE hs.id_grupo_cita = $1::uuid LIMIT 1`, [groupId]
      );
      if (previous.rows.length) throw new AppError(409, "Ya existe un intento de cobro para esta reserva", { code: "PIXELPAY_HOSTED_PREVIOUS_ATTEMPT_EXISTS" });
      const pricing = await recalculateGroupPromotionsForPayment(client, { idGrupoCita: groupId, logger: request.log });
      if (Math.round(Number(pricing.total_hnl) * 100) !== Math.round(Number(intent.monto_hnl) * 100)) {
        throw new AppError(409, "El monto de la reserva cambio", { code: "PAYMENT_AMOUNT_MISMATCH" });
      }
      const protectedResult = await client.query("SELECT app_private.proteger_reserva_pago_v1($1::uuid, $2::uuid) AS expires_at", [idIntent, groupId]);
      const expiresAt = protectedResult.rows[0]?.expires_at;
      const order = { orderId: intent.orden_compra, idIntent, idGrupoCita: groupId, amount: Number(intent.monto_hnl), currency: intent.moneda_codigo,
        firstName: groupRows[0].titular_nombres, lastName: groupRows[0].titular_apellidos, email: titularEmail, expiresAt,
        items: pricing.items.map(item => ({ code: item.code, title: String(item.title).slice(0, 60), price: Number(item.price),
          qty: Number(item.qty), total: Number((Number(item.price) * Number(item.qty)).toFixed(2)) })) };
      buildHostedRequest(config, order);
      const sessionResult = await client.query(
        `INSERT INTO app_private.pixelpay_hosted_sessions (id_intent, id_grupo_cita, order_id, amount_hnl, currency, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::numeric, $5::text, $6::timestamptz) RETURNING *`,
        [idIntent, groupId, order.orderId, order.amount, order.currency, expiresAt]
      );
      await client.query("UPDATE public.payment_intents SET payment_channel = 'hosted', updated_at = clock_timestamp() WHERE id_intent = $1::uuid", [idIntent]);
      await client.query("COMMIT");
      inTransaction = false;
      claimed = { session: sessionResult.rows[0], intent: { ...intent, payment_channel: "hosted", estado_intent_codigo: "pendiente_confirmacion" }, order };
      client.release();
      client = null;
      let checkoutUrl;
      try {
        checkoutUrl = await requestHostedCheckout(config, order);
      } catch (error) {
        const state = error.code === "PIXELPAY_HOSTED_CREATE_REJECTED" ? "creation_rejected" : "creation_uncertain";
        await app.db.query("UPDATE app_private.pixelpay_hosted_sessions SET creation_state = $2::text, updated_at = clock_timestamp() WHERE id_intent = $1::uuid AND creation_state = 'creating'", [idIntent, state]);
        return sendOk(reply, hostedStatusPayload({ ...claimed.session, creation_state: state }, claimed.intent), { statusCode: 202 });
      }
      const updated = await app.db.query(
        `UPDATE app_private.pixelpay_hosted_sessions SET creation_state = 'checkout_ready', checkout_url = $2::text, updated_at = clock_timestamp()
         WHERE id_intent = $1::uuid AND creation_state = 'creating' RETURNING *`, [idIntent, checkoutUrl]
      );
      const refreshed = await loadPublicIntentForGroup(app.db, { groupId, idIntent, titularEmail, access: paymentAccess(request) });
      reply.header("Cache-Control", "private, no-store");
      return sendOk(reply, hostedStatusPayload(updated.rows[0] || claimed.session, refreshed.intent, Date.now(), refreshed.groupRows), { statusCode: 201 });
    } catch (error) {
      if (inTransaction) { try { await client.query("ROLLBACK"); } catch { /* AM: No repetir peticiones externas. */ } }
      if (claimed) return sendOk(reply, hostedStatusPayload(claimed.session, claimed.intent, Date.now(), []), { statusCode: 202 });
      return respondError(reply, request, error);
    } finally { if (client) client.release(); }
  });
}
