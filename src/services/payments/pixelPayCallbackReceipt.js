export const PIXELPAY_CALLBACK_CLOSED_RESULT = "sale_durable_ya_conciliada";

export async function closeCompletedPixelPayCallback(db, { idIntent }) {
  // AM: Solo cerrar el registro operativo con contabilidad ya confirmada; nunca validar el callback.
  const closed = await db.query(
    `WITH verified_sale AS (
      SELECT pe.recibido_at, a.finalized_at, pi.id_intent, pi.id_provider, pi.id_grupo_cita,
             pi.provider_session_id, pi.monto_hnl, pi.moneda_codigo, pi.paid_at
        FROM public.payment_intents pi
        JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider AND pp.codigo = 'pixelpay'
        JOIN public.payment_events pe ON pe.id_intent = pi.id_intent AND pe.id_provider = pi.id_provider
        JOIN app_private.pixelpay_sale_attempts a ON a.id_intent = pe.id_intent
          AND a.payment_attempt_id::text = pe.payload_esencial->>'payment_attempt_id'
       WHERE pi.id_intent = $1::uuid AND pi.estado_intent_codigo = 'confirmado' AND pi.origen_pago_codigo = 'cita'
         AND pi.monto_hnl > 0 AND upper(pi.moneda_codigo) = 'HNL'
         AND btrim(pi.provider_session_id) <> '' AND btrim(pi.referencia_externa) <> ''
         AND pi.orden_compra = 'MF-PIXELPAY-' || upper(replace(pi.id_intent::text, '-', ''))
         AND EXISTS (SELECT 1 FROM public.citas c WHERE c.id_cita = pi.id_cita
           AND c.id_grupo_cita = pi.id_grupo_cita AND c.deleted_at IS NULL)
         AND pe.evento_tipo = 'pixelpay.sale.approved_verified' AND pe.firma_valida IS TRUE
         AND pe.provider_event_id = 'pixelpay_sale_' || a.payment_attempt_id::text
         AND pe.payload_esencial->>'payment_uuid' = pi.provider_session_id
         AND pe.payload_esencial->>'transaction_id' = pi.referencia_externa
         AND CASE WHEN jsonb_typeof(pe.payload_esencial->'amount') = 'number'
           THEN (pe.payload_esencial->>'amount')::numeric END = pi.monto_hnl
         AND upper(pe.payload_esencial->>'currency') = upper(pi.moneda_codigo)
         AND pe.payload_esencial->>'payment_hash_valid' = 'true'
         AND pe.payload_esencial->>'amount_matches' = 'true'
         AND a.outcome = 'approved' AND a.sdk_response_class = 'SuccessResponse'
         AND a.upstream_http_status = 200 AND a.finalized_at IS NOT NULL
         AND a.finalized_at <= pi.expires_at AND pe.recibido_at <= pi.expires_at
         AND a.response_success IS TRUE AND a.response_approved IS TRUE
         AND a.response_incomplete IS FALSE AND a.uncertain IS FALSE
         AND a.transaction_result_valid IS TRUE AND a.transaction_result_parsed IS TRUE
         AND a.payment_uuid_present IS TRUE AND a.transaction_id_present IS TRUE
         AND a.payment_hash_present IS TRUE AND a.payment_hash_valid IS TRUE
         AND a.transaction_amount_matches IS TRUE AND a.approved_amount_matches IS TRUE AND a.amount_matches IS TRUE
    ), captured AS (
      SELECT e.id_intent, e.id_provider, p.id_payment
        FROM public.payments p JOIN verified_sale e USING (id_intent)
       WHERE p.estado_pago_codigo = 'capturado' AND p.registrado_manualmente IS FALSE
         AND p.provider_tx_id = e.provider_session_id AND p.monto_hnl = e.monto_hnl AND p.moneda_codigo = e.moneda_codigo
         AND p.paid_at = e.recibido_at AND e.paid_at = e.recibido_at
         AND (SELECT count(*) FROM verified_sale) = 1
         AND (SELECT count(*) FROM public.payments WHERE id_intent = $1::uuid AND estado_pago_codigo = 'capturado') = 1
         AND (SELECT count(*) FROM app_private.pixelpay_sale_attempts WHERE id_intent = $1::uuid AND outcome = 'approved') = 1
         AND EXISTS (SELECT 1 FROM public.citas c WHERE c.id_grupo_cita = e.id_grupo_cita AND c.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.citas c WHERE c.id_grupo_cita = e.id_grupo_cita
           AND c.deleted_at IS NULL AND c.estado_cita_codigo IS DISTINCT FROM 'confirmada')
         AND NOT EXISTS (SELECT 1 FROM public.citas c LEFT JOIN public.citas_holds h ON h.id_cita = c.id_cita
           WHERE c.id_grupo_cita = e.id_grupo_cita AND c.deleted_at IS NULL
             AND (h.id_hold IS NULL OR h.expires_at IS NULL OR h.estado_hold_codigo IS DISTINCT FROM 'consumido'
               OR h.expires_at < e.recibido_at OR h.expires_at < e.finalized_at))
    )
    UPDATE public.payment_events callback SET procesado_at = CASE
      WHEN callback.resultado_procesamiento = $2::text THEN callback.procesado_at ELSE now() END,
      resultado_procesamiento = $2::text, id_payment = c.id_payment
    FROM captured c WHERE callback.id_intent = c.id_intent AND callback.id_provider = c.id_provider
      AND callback.evento_tipo = 'pixelpay.order_callback.received'
    RETURNING callback.id_event`,
    [idIntent, PIXELPAY_CALLBACK_CLOSED_RESULT]
  );
  return closed.rows.length > 0;
}
