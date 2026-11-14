import { AppError, sendError } from "../../utils/errors.js";
import { sendOk } from "../../utils/response.js";
import { recoverMembershipPixelPayApproval } from "../../services/membershipService.js";
import { reconcilePixelPayFromDurableApproval } from "./public/pagos.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const manualResult = (idIntent) => ({ id_intent: idIntent, processed: false,
  manual_reconciliation_required: true, pending_confirmation: true });

async function loadOwner(client, request, { lock = false } = {}) {
  const owner = { clienteId: request.claims?.cliente_id, personaId: request.claims?.user?.id_persona,
    usuarioId: request.claims?.user?.id_usuario };
  if (!request.cookies?.mf_session || !Object.values(owner).every(value => typeof value === "string" && UUID.test(value))
    || request.auth?.sub !== owner.usuarioId) {
    throw new AppError(403, "No tienes permiso para consultar este pago", { code: "PAYMENT_RECOVERY_OWNER_REQUIRED" });
  }
  const { rows } = await client.query(`SELECT c.id_cliente
    FROM public.clientes c JOIN public.usuarios u ON u.id_usuario=c.id_usuario
    JOIN public.personas p ON p.id_persona=c.id_persona
    WHERE c.id_cliente=$1::uuid AND c.id_persona=$2::uuid AND c.id_usuario=$3::uuid
      AND u.id_persona=c.id_persona AND c.estado IS TRUE AND c.deleted_at IS NULL
      AND c.anonimizado IS FALSE AND u.estado IS TRUE AND u.deleted_at IS NULL
      AND u.estado_acceso NOT IN ('inactivo','bloqueado') AND p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM app_private.solicitudes_eliminacion_cuenta deletion
        WHERE deletion.estado_codigo IN ('procesando','storage_pendiente','auth_pendiente','completada')
          AND (deletion.id_cliente=c.id_cliente OR deletion.id_usuario=u.id_usuario OR deletion.id_persona=p.id_persona))
      ${lock ? "FOR SHARE OF c,u,p" : ""}`,
  [owner.clienteId, owner.personaId, owner.usuarioId]);
  if (rows.length !== 1) throw new AppError(403, "La cuenta no esta disponible para consultar pagos", {
    code: "PAYMENT_RECOVERY_ACCOUNT_UNAVAILABLE",
  });
  return owner;
}

async function loadOwnedIntent(client, idIntent, owner) {
  const { rows } = await client.query(`SELECT pi.id_intent,pi.origen_pago_codigo,pi.estado_intent_codigo,
    pi.monto_hnl,pi.moneda_codigo,pi.paid_at::text AS paid_at,pi.id_grupo_cita,pi.id_membership_order,pi.created_by_usuario_id,
    pp.codigo AS provider_code,cg.id_cliente_titular,cg.id_persona_titular,cg.id_usuario_titular,cg.origen_codigo,
    mpo.id_cliente AS membership_cliente_id,mpo.id_usuario AS membership_usuario_id,
    COALESCE(NULLIF(btrim(c.contacto_email),''),NULLIF(btrim(ci.contacto_email_snapshot),''),
      CASE WHEN co.principal_count=1 THEN co.email END) AS titular_email
    FROM public.payment_intents pi JOIN public.payment_providers pp USING(id_provider)
    LEFT JOIN public.citas_grupos cg ON cg.id_grupo_cita=pi.id_grupo_cita
    LEFT JOIN public.citas c ON c.id_grupo_cita=cg.id_grupo_cita AND c.orden_integrante=1 AND c.deleted_at IS NULL
    LEFT JOIN public.citas_integrantes ci ON ci.id_cita_integrante=c.id_cita_integrante AND ci.id_grupo_cita=cg.id_grupo_cita
    LEFT JOIN LATERAL (SELECT count(*) AS principal_count,min(cr.direccion_correo::text) AS email
      FROM public.correos cr WHERE cr.id_persona=cg.id_persona_titular AND cr.deleted_at IS NULL AND cr.es_principal IS TRUE) co ON TRUE
    LEFT JOIN public.membership_purchase_orders mpo ON mpo.id_order=pi.id_membership_order
    WHERE pi.id_intent=$1::uuid`, [idIntent]);
  const intent = rows.length === 1 ? rows[0] : null;
  const bookingOwner = intent?.origen_pago_codigo === "cita" && intent.id_grupo_cita && !intent.id_membership_order
    && intent.id_cliente_titular === owner.clienteId && intent.id_persona_titular === owner.personaId
    && intent.id_usuario_titular === owner.usuarioId;
  const membershipOwner = intent?.origen_pago_codigo === "membership" && intent.id_membership_order && !intent.id_grupo_cita
    && intent.membership_cliente_id === owner.clienteId && intent.membership_usuario_id === owner.usuarioId;
  const creatorMatches = bookingOwner
    ? intent.origen_codigo !== "cliente_autenticado" || intent.created_by_usuario_id === owner.usuarioId
    : intent?.created_by_usuario_id == null || intent.created_by_usuario_id === owner.usuarioId;
  if (!intent || intent.provider_code !== "pixelpay" || !creatorMatches || (!bookingOwner && !membershipOwner)) {
    // AM: No revelar identificadores ni estados de pagos ajenos o de otros proveedores.
    throw new AppError(404, "El pago indicado no esta disponible", { code: "PAYMENT_RECOVERY_NOT_FOUND" });
  }
  return intent;
}

function sendHandled(reply, request, error) {
  if (error instanceof AppError) return sendError(reply, error.statusCode, error.message, {
    code: error.code, requestId: request.id,
  });
  request.log.error({ event: "existing_payment_recovery_failed", requestId: request.id }, "Fallo de conciliacion existente");
  return sendError(reply, 500, "No se pudo consultar el pago", { code: "PAYMENT_RECOVERY_ERROR", requestId: request.id });
}

export default async function paymentRecoveryRoutes(app) {
  const params = { type: "object", required: ["id_intent"], additionalProperties: false,
    properties: { id_intent: { type: "string", format: "uuid" } } };
  const requireClient = app.requireRoles(["cliente"]);
  const guard = async (request, reply) => {
    await requireClient(request, reply);
    if (reply.sent) return;
    if (request.method === "POST" && (!request.cookies?.mf_csrf
      || typeof request.headers["x-csrf-token"] !== "string"
      || request.cookies.mf_csrf !== request.headers["x-csrf-token"])) {
      return sendError(reply, 403, "Solicitud invalida.", { code: "CSRF_TOKEN_INVALID" });
    }
  };
  app.get("/:id_intent", {
    preHandler: guard, config: { rateLimit: { max: 10, timeWindow: "1 minute", groupId: "existing-pixelpay-payment-read",
      keyGenerator: request => request.ip } },
    schema: { params, querystring: { type: "object", additionalProperties: false, properties: {} } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    let client;
    try {
      client = await app.db.connect();
      const owner = await loadOwner(client, request);
      const intent = await loadOwnedIntent(client, request.params.id_intent, owner);
      return sendOk(reply, { id_intent: intent.id_intent, origen_pago_codigo: intent.origen_pago_codigo,
        estado_intent_codigo: intent.estado_intent_codigo, monto_hnl: intent.monto_hnl,
        moneda_codigo: intent.moneda_codigo, paid_at: intent.paid_at });
    } catch (error) { return sendHandled(reply, request, error); }
    finally { client?.release(); }
  });
  app.post("/:id_intent/conciliar", {
    preHandler: guard, config: { rateLimit: { max: 3, timeWindow: "1 minute", groupId: "existing-pixelpay-payment-recover",
      keyGenerator: request => request.ip } },
    schema: { params, body: { type: "object", maxProperties: 0, additionalProperties: false, properties: {} } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    let client;
    let transaction = false;
    let discard = false;
    try {
      client = await app.db.connect();
      const owner = await loadOwner(client, request);
      const intent = await loadOwnedIntent(client, request.params.id_intent, owner);
      let result;
      if (intent.origen_pago_codigo === "membership") {
        await client.query("BEGIN");
        transaction = true;
        // AM: Fijar la identidad autenticada antes de los locks financieros y revalidar la orden actual.
        const identityLock = await client.query(`SELECT pg_try_advisory_xact_lock(
          hashtext('masterfade.account_deletion'),hashtext($1::text)) AS deletion_identity_lock`, [owner.usuarioId]);
        if (identityLock.rows?.[0]?.deletion_identity_lock !== true) throw new AppError(409,
          "La cuenta no esta disponible para recuperar pagos", { code: "PAYMENT_RECOVERY_ACCOUNT_UNAVAILABLE" });
        await loadOwner(client, request, { lock: true });
        const currentIntent = await loadOwnedIntent(client, intent.id_intent, owner);
        if (currentIntent.origen_pago_codigo !== "membership" || currentIntent.id_membership_order !== intent.id_membership_order) {
          throw new AppError(409, "La operacion requiere conciliacion manual", { code: "PAYMENT_RECOVERY_CONTEXT_CHANGED" });
        }
        result = await recoverMembershipPixelPayApproval(client, { idPaymentIntent: intent.id_intent, clienteId: owner.clienteId });
        await client.query("COMMIT");
        transaction = false;
      } else {
        if (typeof intent.titular_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(intent.titular_email)) {
          return sendOk(reply, manualResult(intent.id_intent), { statusCode: 202 });
        }
        result = await reconcilePixelPayFromDurableApproval(client, { idGrupoCita: intent.id_grupo_cita,
          idIntent: intent.id_intent, titularEmail: intent.titular_email, owner, logger: request.log });
      }
      const data = result || manualResult(intent.id_intent);
      return sendOk(reply, { id_intent: intent.id_intent, ...data }, { statusCode: data.manual_reconciliation_required ? 202 : 200 });
    } catch (error) {
      if (transaction) {
        try { await client.query("ROLLBACK"); }
        catch {
          discard = true;
          request.log.error({ event: "existing_payment_recovery_rollback_failed", requestId: request.id }, "Fallo de rollback de conciliacion");
        }
      }
      if (error?.code === "MEMBERSHIP_PIXELPAY_RECOVERY_EVIDENCE_INVALID"
        || error?.code === "MEMBERSHIP_PIXELPAY_RECOVERY_VERIFIED_AFTER_EXPIRY") {
        return sendOk(reply, manualResult(request.params.id_intent), { statusCode: 202 });
      }
      return sendHandled(reply, request, error);
    } finally { client?.release(discard); }
  });
}
