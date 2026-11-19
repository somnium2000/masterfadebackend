import { AppError } from "../../utils/errors.js";

function safeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function missingCandidateError() {
  return new AppError(409, "PixelPay aun no proporciono un identificador consultable", {
    code: "PIXELPAY_PAYMENT_UUID_MISSING",
  });
}

export async function resolvePixelPayStatusCandidate(db, intent = {}, { delegated = false } = {}) {
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
        AND ((outcome = 'uncertain' AND finalized_at IS NOT NULL)
          ${delegated ? "OR (qa_test_origin = '3ds_diagnostic' AND finalized_at IS NULL)" : ""})
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


// PixelPay #9834 (19 nov 2026): Status no es consultable mientras el 3DS
// de una respuesta HTTP 202 no ha terminado. Solo se usa evidencia durable local.
// El registro de un 202 nunca prueba aprobacion ni autoriza reintentar Sale.
export async function hasUnfinishedPixelPay3dsResponse(db, intent = {}) {
  if (safeText(intent.estado_intent_codigo)?.toLowerCase() !== "pendiente_confirmacion") {
    return false;
  }
  const idIntent = safeText(intent.id_intent);
  if (!idIntent) {
    throw new AppError(503, "No se pudo verificar el estado local de la operacion.", {
      code: "PIXELPAY_3DS_STATUS_GATE_UNAVAILABLE",
    });
  }
  // Safe read-only query. Query failures must propagate: never fall through
  // to the provider when the 3DS state cannot be checked.
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM app_private.pixelpay_sale_attempts
       WHERE id_intent = $1::uuid
         AND (upstream_http_status = 202 OR sdk_response_class = 'PayloadResponse')
     ) AS awaiting_authentication`,
    [idIntent],
  );
  return result.rows[0]?.awaiting_authentication === true;
}
