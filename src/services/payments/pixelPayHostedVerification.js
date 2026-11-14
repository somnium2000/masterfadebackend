// AM: Acceptance checklist experimental, sin transporte, parser PixelPay ni conexion al flujo de pagos.
export const HOSTED_VERIFICATION_BLOCKERS = Object.freeze([
  "OFFICIAL_HOSTED_QUERY_CONTRACT_UNPROVEN",
  "HOSTED_UUID_STATUS_NAMESPACE_UNPROVEN",
  "AUTHENTICATED_RESPONSE_BINDING_UNPROVEN",
  "MERCHANT_ID_MAPPING_UNPROVEN",
  "FINAL_CAPTURE_SEMANTICS_UNPROVEN",
]);

export const HOSTED_VERIFICATION_EVIDENCE_REQUIRED = Object.freeze([
  "official_endpoint_method_authentication_and_hosted_scope",
  "official_hosted_uuid_to_query_identifier_mapping",
  "authenticated_response_schema_and_missing_field_rules",
  "merchant_account_identity_mapping",
  "canonical_order_and_returned_payment_identity",
  "exact_captured_amount_and_currency",
  "final_capture_result_transaction_identity_and_payment_time",
  "replay_freshness_and_foreign_order_negative_vectors",
]);

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 191
    && value === value.trim() && ![...value].some(character => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127;
    });
}

function minorAmount(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 999999999999;
}

// AM: canonical/candidate son fichas internas de revision, NO nombres/rutas de un esquema oficial PixelPay.
// AM: Aunque todos sus campos coincidan, la falta de contrato probado mantiene siempre el bloqueo.
export function assessHostedVerificationAcceptance({ canonical = {}, candidate = {} } = {}) {
  const reasons = [...HOSTED_VERIFICATION_BLOCKERS];
  const compareIdentity = (expectedField, candidateField, name) => {
    if (!identifier(canonical?.[expectedField])) reasons.push(`CANONICAL_${name}_INVALID`);
    if (!identifier(candidate?.[candidateField])) reasons.push(`${name}_MISSING_OR_INVALID`);
    else if (identifier(canonical?.[expectedField])
      && candidate[candidateField] !== canonical[expectedField]) reasons.push(`${name}_MISMATCH`);
  };

  compareIdentity("merchantId", "merchantId", "MERCHANT");
  compareIdentity("orderId", "orderId", "ORDER");
  // AM: requestedPaymentUuid sigue siendo un candidato no confiable; igualdad no lo autentica.
  compareIdentity("requestedPaymentUuid", "paymentUuid", "PAYMENT_UUID");
  if (!identifier(candidate?.transactionId)) reasons.push("TRANSACTION_ID_MISSING_OR_INVALID");
  if (!minorAmount(canonical?.amountMinor)) reasons.push("CANONICAL_AMOUNT_INVALID");
  if (!minorAmount(candidate?.amountMinor)) reasons.push("AMOUNT_MISSING_OR_INVALID");
  else if (minorAmount(canonical?.amountMinor) && candidate.amountMinor !== canonical.amountMinor) {
    reasons.push("AMOUNT_MISMATCH");
  }
  if (canonical?.currency !== "HNL") reasons.push("CANONICAL_CURRENCY_INVALID");
  if (candidate?.currency !== "HNL") reasons.push("CURRENCY_MISSING_OR_MISMATCH");
  if (!identifier(candidate?.financialResult)) reasons.push("FINANCIAL_RESULT_MISSING_OR_INVALID");
  if (typeof candidate?.paidAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(candidate.paidAt)
    || !Number.isFinite(Date.parse(candidate.paidAt))) reasons.push("PAYMENT_TIME_MISSING_OR_INVALID");

  return {
    status: "blocked",
    financial_verified: false,
    can_confirm: false,
    automatic_confirmation: false,
    reasons,
  };
}
