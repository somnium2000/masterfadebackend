export async function loadDurablePixelPayApproval(client, { idIntent, groupRows }) {
  const expiries = (groupRows || []).map((row) => row.expires_at ? new Date(row.expires_at).getTime() : NaN);
  if (!expiries.length || expiries.some((value) => !Number.isFinite(value))) return null;
  const holdExpiresAt = new Date(Math.min(...expiries)).toISOString();
  // AM: Solo FINAL aprobado y verificado prueba pago previo al vencimiento de todos los holds.
  const result = await client.query(
    `SELECT finalized_at FROM app_private.pixelpay_sale_attempts
     WHERE id_intent = $1::uuid AND outcome = 'approved'
       AND finalized_at IS NOT NULL AND finalized_at <= $2::timestamptz
       AND response_success IS TRUE AND response_approved IS TRUE
       AND response_incomplete IS FALSE AND uncertain IS FALSE
       AND transaction_result_valid IS TRUE AND transaction_result_parsed IS TRUE
       AND payment_uuid_present IS TRUE AND transaction_id_present IS TRUE
       AND payment_hash_present IS TRUE AND payment_hash_valid IS TRUE
       AND transaction_amount_matches IS TRUE AND approved_amount_matches IS TRUE
       AND amount_matches IS TRUE
     ORDER BY finalized_at ASC LIMIT 1`,
    [idIntent, holdExpiresAt]
  );
  const finalizedAt = result.rows[0]?.finalized_at;
  const timestamp = finalizedAt ? new Date(finalizedAt).getTime() : NaN;
  if (!Number.isFinite(timestamp) || timestamp > Math.min(...expiries)) return null;
  return { finalized_at: new Date(timestamp).toISOString() };
}
