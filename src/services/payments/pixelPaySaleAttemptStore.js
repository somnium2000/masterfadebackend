import {
  buildSafePixelPaySdkDiagnostics,
  buildSafeProviderErrorDiagnostic,
  safePixelPayRequestId,
} from "./pixelPaySaleDiagnostics.js";
import { safePixelPayUuid } from "./pixelPaySaleTelemetry.js";
import { PIXELPAY_SALE_OUTCOME } from "./PixelPayDirectProvider.js";

export const PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS = 1000;

function requireUuid(value) {
  const uuid = safePixelPayUuid(value);
  if (!uuid) throw new TypeError("Identificador de diagnostico PixelPay invalido.");
  return uuid;
}

function safeObservedPaymentUuid(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  return normalized && normalized.length <= 80 && !hasControlCharacter
    ? normalized
    : null;
}

function safeObservedProviderIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  return normalized && normalized.length <= 160 && !hasControlCharacter
    ? normalized
    : null;
}

export async function createPixelPaySaleAttemptRecord(transactionClient, dto) {
  const safe = buildSafePixelPaySdkDiagnostics(dto);
  const result = await transactionClient.query(
    `INSERT INTO app_private.pixelpay_sale_attempts (
       id_intent, payment_attempt_id, request_id,
       card_expire_format_valid, card_expire_future, billing_address_length
     ) VALUES ($1::uuid, $2::uuid, $3::varchar(120), $4::boolean, $5::boolean, $6::integer)
     RETURNING id_sale_attempt`,
    [
      requireUuid(dto.idIntent), requireUuid(dto.paymentAttemptId), safePixelPayRequestId(dto.requestId),
      safe?.cardExpireFormatValid ?? null, safe?.cardExpireFuture ?? null, safe?.billingAddressLength ?? null,
    ]
  );
  if (!result.rows[0]) throw new Error("No se pudo registrar el diagnostico inicial PixelPay.");
  return result.rows[0].id_sale_attempt;
}

export async function finalizePixelPaySaleAttempt(pool, dto) {
  const safe = buildSafePixelPaySdkDiagnostics(dto);
  // AM: Revalidar el DTO sin pasar errores, respuestas SDK ni requests al store.
  const error = buildSafeProviderErrorDiagnostic({
    code: dto.errorCode, name: dto.errorName, sdkErrorName: dto.sdkErrorName,
    errorConstructorName: dto.errorConstructorName,
  });
  const query = {
    // AM: El timeout nativo de pg-pool retira la conexion fallida; no afecta START ni finanzas.
    query_timeout: PIXELPAY_SALE_FINAL_QUERY_TIMEOUT_MS,
    text: `UPDATE app_private.pixelpay_sale_attempts
     SET finalized_at = clock_timestamp(),
         duration_ms = $2::integer,
         sdk_response_class = $3::varchar(80), upstream_http_status = $4::smallint,
         safe_message_code = $5::varchar(120), outcome = $6::varchar(80), uncertain = $7::boolean,
         input_error_fields = $8::text[], input_error_count = $9::integer, input_error_unknown_count = $10::integer,
         card_expire_format_valid = COALESCE($11::boolean, card_expire_format_valid),
         card_expire_future = COALESCE($12::boolean, card_expire_future),
         billing_address_length = COALESCE($13::integer, billing_address_length),
         response_success = $14::boolean, transaction_result_valid = $15::boolean,
         transaction_result_parsed = $16::boolean, response_approved = $17::boolean,
         response_incomplete = $18::boolean, response_code_present = $19::boolean,
         payment_uuid_present = $20::boolean, transaction_id_present = $21::boolean,
         payment_hash_present = $22::boolean, payment_hash_valid = $23::boolean,
         transaction_amount_matches = $24::boolean, approved_amount_matches = $25::boolean,
         amount_matches = $26::boolean, cf_ray = $27::varchar(120),
         error_code = $28::varchar(120), error_name = $29::varchar(80),
         sdk_error_name = $30::varchar(80), error_constructor_name = $31::varchar(80),
         observed_payment_uuid_untrusted = $32::varchar(80),
         observed_transaction_id_untrusted = $33::varchar(160),
         observed_transaction_reference_untrusted = $34::varchar(160),
         provider_response_code = $35::varchar(16)
     WHERE payment_attempt_id = $1::uuid AND finalized_at IS NULL
     RETURNING id_sale_attempt`,
    values: [
      requireUuid(dto.paymentAttemptId), safe?.durationMs ?? null,
      safe?.sdkResponseClass ?? null, safe?.statusCode ?? null, safe?.safeMessageCode ?? null,
      safe?.outcome ?? null, safe?.outcome == null ? null : safe.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN,
      safe?.inputErrorFields ?? [], safe?.inputErrorCount ?? 0, safe?.inputErrorUnknownCount ?? 0,
      safe?.cardExpireFormatValid ?? null, safe?.cardExpireFuture ?? null, safe?.billingAddressLength ?? null,
      safe?.responseSuccess ?? null, safe?.transactionResultValid ?? null, safe?.transactionResultParsed ?? null,
      safe?.responseApproved ?? null, safe?.responseIncomplete ?? null, safe?.responseCodePresent ?? null,
      safe?.hasPaymentUuid ?? null, safe?.hasTransactionId ?? null, safe?.hasPaymentHash ?? null,
      safe?.paymentHashValid ?? null, safe?.transactionAmountMatches ?? null,
      safe?.approvedAmountMatches ?? null, safe?.amountMatches ?? null, safe?.cfRay ?? null,
      error.errorCode, error.errorName, error.sdkErrorName, error.errorConstructorName,
      safe?.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN
        ? safeObservedPaymentUuid(dto.observedPaymentUuidUntrusted) : null,
      safe?.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN
        ? safeObservedProviderIdentifier(dto.observedTransactionIdUntrusted) : null,
      safe?.outcome === PIXELPAY_SALE_OUTCOME.UNCERTAIN
        ? safeObservedProviderIdentifier(dto.observedTransactionReferenceUntrusted) : null,
      safe?.providerResponseCode ?? null,
    ]
  };
  let result;
  try {
    result = await pool.query(query);
  } catch (error) {
    const missingNewColumn = error?.code === "42703"
      && String(error?.message || "").includes("provider_response_code");
    if (!missingNewColumn) throw error;
    // AM: Compatibilidad temporal durante el orden migracion -> runtime; nunca repite Sale ni finanzas.
    result = await pool.query({
      ...query,
      text: query.text.replace(",\n         provider_response_code = $35::varchar(16)", ""),
      values: query.values.slice(0, -1),
    });
  }
  return result.rows.length > 0;
}

export async function finalizePixelPaySaleAttemptBestEffort(pool, dto, logger) {
  try {
    return await finalizePixelPaySaleAttempt(pool, dto);
  } catch {
    // AM: La evidencia operacional nunca modifica el resultado financiero ni dispara retries.
    try {
      logger?.fatal?.({
        event: "PIXELPAY_SALE_FINAL_PERSISTENCE_FAILED",
        idIntent: safePixelPayUuid(dto.idIntent),
        paymentAttemptId: safePixelPayUuid(dto.paymentAttemptId),
        requestId: safePixelPayRequestId(dto.requestId),
      }, "No se pudo persistir el diagnostico final PixelPay");
    } catch { /* AM: Incluso un fallo del logger debe permitir continuar la reconciliacion. */ }
    return false;
  }
}
