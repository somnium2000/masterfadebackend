BEGIN;

DO $mf$
DECLARE
  v_intent uuid;
  v_before integer;
  v_after integer;
  v_first uuid;
  v_second uuid;
  v_first_checked timestamptz := clock_timestamp() - interval '2 seconds';
  v_second_checked timestamptz := clock_timestamp() - interval '1 second';
  v_count integer;
BEGIN
  SELECT id_intent, verification_attempts
  INTO STRICT v_intent, v_before
  FROM public.payment_intents
  ORDER BY created_at ASC
  LIMIT 1;

  v_first := app_private.registrar_payment_status_check_v1(
    v_intent, 'qa-history-1', 'manual', 'PENDING', 'ok', 200::smallint, NULL, 8,
    'qa-history-request-1', v_first_checked
  );
  v_second := app_private.registrar_payment_status_check_v1(
    v_intent, 'qa-history-2', 'post_venta', NULL, 'timeout', NULL,
    'PIXELPAY_TIMEOUT', 1000, 'qa-history-request-2', v_second_checked
  );

  SELECT count(*)::integer INTO v_count
  FROM app_private.payment_status_checks
  WHERE id_status_check IN (v_first, v_second);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_HISTORY_OVERWRITTEN';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.payment_status_checks
    WHERE id_status_check = v_first
      AND id_intent = v_intent
      AND provider_reference = 'qa-history-1'
      AND origen_consulta_codigo = 'manual'
      AND provider_status = 'PENDING'
      AND resultado_consulta_codigo = 'ok'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_FIRST_ROW_CHANGED';
  END IF;

  SELECT verification_attempts, last_verified_at
  INTO v_after, v_second_checked
  FROM public.payment_intents
  WHERE id_intent = v_intent;
  IF v_after <> v_before + 2 THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_ATTEMPTS_EXPECTED_2: before %, after %', v_before, v_after;
  END IF;
  IF v_second_checked IS NULL THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_LAST_VERIFIED_MISSING';
  END IF;

  BEGIN
    PERFORM app_private.registrar_payment_status_check_v1(
      v_intent, 'qa-invalid-origin', 'inventado', NULL, 'ok', 200::smallint, NULL, 1, NULL, clock_timestamp()
    );
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_INVALID_ORIGIN_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app_private.registrar_payment_status_check_v1(
      v_intent, 'qa-invalid-result', 'manual', NULL, 'inventado', 200::smallint, NULL, 1, NULL, clock_timestamp()
    );
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_INVALID_RESULT_ACCEPTED';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app_private.registrar_payment_status_check_v1(
      gen_random_uuid(), 'qa-missing-intent', 'manual', NULL, 'ok', 200::smallint, NULL, 1, NULL, clock_timestamp()
    );
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_MISSING_INTENT_ACCEPTED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM app_private.payment_status_checks
    WHERE provider_reference IN ('qa-invalid-origin', 'qa-invalid-result', 'qa-missing-intent')
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_FAILED_CALL_NOT_ATOMIC';
  END IF;
END
$mf$;

ROLLBACK;
