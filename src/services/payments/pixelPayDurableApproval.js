export async function loadDurablePixelPayApproval(client, { idIntent, groupRows, holdRows = groupRows, expectedPaidAt = null }) {
  const expiries = (holdRows || []).map((row) => row.expires_at ? new Date(row.expires_at).getTime() : NaN);
  if (!expiries.length || expiries.some((value) => !Number.isFinite(value))) return null;
  const holdExpiresAt = holdRows[expiries.indexOf(Math.min(...expiries))].expires_at;
  // AM: Solo FINAL aprobado y verificado prueba pago previo al vencimiento de todos los holds.
  const result = await client.query(
    `WITH approved_attempts AS (
     SELECT payment_attempt_id, finalized_at FROM app_private.pixelpay_sale_attempts
     WHERE id_intent = $1::uuid AND outcome = 'approved'
       AND sdk_response_class = 'SuccessResponse' AND upstream_http_status = 200
       AND finalized_at IS NOT NULL AND finalized_at <= $2::timestamptz
       AND finalized_at <= (
         SELECT min(h.expires_at) FROM public.citas_holds h
         JOIN public.citas c ON c.id_cita = h.id_cita AND c.deleted_at IS NULL
         WHERE c.id_grupo_cita = (SELECT pi.id_grupo_cita FROM public.payment_intents pi WHERE pi.id_intent = $1::uuid)
       )
       AND response_success IS TRUE AND response_approved IS TRUE
       AND response_incomplete IS FALSE AND uncertain IS FALSE
       AND transaction_result_valid IS TRUE AND transaction_result_parsed IS TRUE
       AND payment_uuid_present IS TRUE AND transaction_id_present IS TRUE
       AND payment_hash_present IS TRUE AND payment_hash_valid IS TRUE
       AND transaction_amount_matches IS TRUE AND approved_amount_matches IS TRUE
       AND amount_matches IS TRUE
     ), sale_events AS (
       SELECT pe.recibido_at, a.payment_attempt_id, pi.expires_at
       FROM public.payment_events pe
       JOIN app_private.pixelpay_sale_attempts a ON a.id_intent = pe.id_intent
         AND a.payment_attempt_id::text = pe.payload_esencial->>'payment_attempt_id'
       JOIN public.payment_intents pi ON pi.id_intent = pe.id_intent AND pi.id_provider = pe.id_provider
       JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
       WHERE pe.id_intent = $1::uuid AND pp.codigo = 'pixelpay'
         AND pe.evento_tipo = 'pixelpay.sale.approved_verified' AND pe.firma_valida IS TRUE
         AND pe.provider_event_id = 'pixelpay_sale_' || (pe.payload_esencial->>'payment_attempt_id')
         AND pe.payload_esencial->>'payment_uuid' = pi.provider_session_id
         AND pe.payload_esencial->>'transaction_id' = pi.referencia_externa
         AND CASE WHEN jsonb_typeof(pe.payload_esencial->'amount') = 'number'
           THEN (pe.payload_esencial->>'amount')::numeric END = pi.monto_hnl
         AND upper(pe.payload_esencial->>'currency') = upper(pi.moneda_codigo)
         AND pe.payload_esencial->>'payment_hash_valid' = 'true'
         AND pe.payload_esencial->>'amount_matches' = 'true'
     )
     SELECT a.finalized_at::text AS finalized_at, e.recibido_at::text AS paid_at
     FROM approved_attempts a JOIN sale_events e USING (payment_attempt_id)
     WHERE (SELECT count(*) FROM approved_attempts) = 1 AND (SELECT count(*) FROM sale_events) = 1
       AND e.recibido_at <= $2::timestamptz AND e.recibido_at <= e.expires_at
       AND e.recibido_at <= (
         SELECT min(h.expires_at) FROM public.citas_holds h
         JOIN public.citas c ON c.id_cita = h.id_cita AND c.deleted_at IS NULL
         WHERE c.id_grupo_cita = (SELECT pi.id_grupo_cita FROM public.payment_intents pi WHERE pi.id_intent = $1::uuid)
       )
       AND ($3::timestamptz IS NULL OR e.recibido_at = $3::timestamptz)`,
    [idIntent, holdExpiresAt, expectedPaidAt]
  );
  if (result.rows.length !== 1) return null;
  const { finalized_at: finalizedAt, paid_at: paidAt } = result.rows[0];
  if (![finalizedAt, paidAt].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))) return null;
  // AM: Preservar microsegundos de PostgreSQL; Date pierde precision del paid_at durable.
  return { finalized_at: finalizedAt, paid_at: paidAt };
}
