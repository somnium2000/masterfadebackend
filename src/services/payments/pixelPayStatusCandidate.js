import { AppError } from "../../utils/errors.js";

function safeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function missingCandidateError() {
  return new AppError(409, "PixelPay aun no proporciono un identificador consultable", {
    code: "PIXELPAY_PAYMENT_UUID_MISSING",
  });
}

export async function resolvePixelPayStatusCandidate(db, intent = {}) {
  const trustedPaymentUuid = safeText(intent.provider_session_id);
  if (trustedPaymentUuid) {
    return { paymentUuid: trustedPaymentUuid, source: "trusted" };
  }

  if (safeText(intent.estado_intent_codigo)?.toLowerCase() !== "pendiente_confirmacion") {
    throw missingCandidateError();
  }

  const result = await db.query(
    `SELECT DISTINCT observed_payment_uuid_untrusted
       FROM app_private.pixelpay_sale_attempts
      WHERE id_intent = $1::uuid
        AND outcome = 'uncertain'
        AND finalized_at IS NOT NULL
        AND observed_payment_uuid_untrusted IS NOT NULL
        AND btrim(observed_payment_uuid_untrusted) <> ''
      LIMIT 2`,
    [intent.id_intent]
  );
  const candidates = result.rows
    .map((row) => safeText(row.observed_payment_uuid_untrusted))
    .filter(Boolean);

  if (candidates.length === 0) throw missingCandidateError();
  if (candidates.length > 1) {
    throw new AppError(409, "Existe mas de un identificador observado para consultar PixelPay", {
      code: "PIXELPAY_STATUS_CANDIDATE_AMBIGUOUS",
    });
  }
  return { paymentUuid: candidates[0], source: "observed_untrusted" };
}
