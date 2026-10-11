export async function loadDurablePixelPayApproval(client, { idIntent, groupRows, holdRows = groupRows }) {
  const expiries = (holdRows || []).map((row) => row.expires_at ? new Date(row.expires_at).getTime() : NaN);
  if (!expiries.length || expiries.some((value) => !Number.isFinite(value))) return null;
  const holdExpiresAt = holdRows[expiries.indexOf(Math.min(...expiries))].expires_at;
  // AM: Solo FINAL aprobado y verificado prueba pago previo al vencimiento de todos los holds.
  const result = await client.query(
    `SELECT finalized_at::text AS finalized_at FROM app_private.pixelpay_sale_attempts
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
     ORDER BY finalized_at ASC LIMIT 2`,
    [idIntent, holdExpiresAt]
  );
  if (result.rows.length !== 1) return null;
  const finalizedAt = result.rows[0]?.finalized_at;
  const timestamp = finalizedAt ? new Date(finalizedAt).getTime() : NaN;
  if (!Number.isFinite(timestamp) || timestamp > Math.min(...expiries)) return null;
  // AM: Preservar microsegundos de PostgreSQL; Date pierde precision del paid_at durable.
  return { finalized_at: finalizedAt instanceof Date ? finalizedAt.toISOString() : finalizedAt };
}
