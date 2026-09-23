DO $mf$
DECLARE
  v_definition text;
BEGIN
  IF to_regclass('app_private.payment_status_checks') IS NULL THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'payment_status_checks'
      AND column_name = 'id_status_check'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_ID_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'payment_status_checks'
      AND column_name = 'id_intent'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_INTENT_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'payment_status_checks'
      AND column_name = 'origen_consulta_codigo'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_ORIGIN_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'payment_status_checks'
      AND column_name = 'resultado_consulta_codigo'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_RESULT_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'payment_status_checks'
      AND column_name = 'checked_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_CHECKED_AT_INVALID';
  END IF;

  SELECT pg_get_constraintdef(c.oid)
  INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'app_private.payment_status_checks'::regclass
    AND c.conname = 'fk_payment_status_checks_intent';

  IF v_definition IS NULL OR position('FOREIGN KEY (id_intent)' in v_definition) = 0 THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_FK_INVALID: %', v_definition;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'app_private'
      AND indexname = 'idx_payment_status_checks_intent_checked_at'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_INTENT_INDEX_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'app_private'
      AND indexname = 'idx_payment_status_checks_result_checked_at'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_RESULT_INDEX_MISSING';
  END IF;

  IF to_regprocedure(
    'app_private.registrar_payment_status_check_v1(uuid,text,text,text,text,smallint,text,integer,text,timestamp with time zone)'
  ) IS NULL THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_REGISTER_FUNCTION_MISSING';
  END IF;
END
$mf$;

-- Prueba funcional reversible: verifica inserción de historial + actualización del resumen.
BEGIN;

DO $mf$
DECLARE
  v_intent uuid;
  v_check uuid;
  v_attempts_before integer;
  v_attempts_after integer;
  v_rows integer;
BEGIN
  SELECT id_intent, verification_attempts
  INTO v_intent, v_attempts_before
  FROM public.payment_intents
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_intent IS NOT NULL THEN
    v_check := app_private.registrar_payment_status_check_v1(
      v_intent,
      'qa-assert-reference',
      'manual',
      'PENDING',
      'ok',
      200::smallint,
      NULL,
      5,
      'qa-assert-request',
      clock_timestamp()
    );

    IF v_check IS NULL THEN
      RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_FUNCTION_DID_NOT_RETURN_ID';
    END IF;

    SELECT count(*)::integer
    INTO v_rows
    FROM app_private.payment_status_checks
    WHERE id_status_check = v_check
      AND id_intent = v_intent;

    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_ROW_NOT_INSERTED';
    END IF;

    SELECT verification_attempts
    INTO v_attempts_after
    FROM public.payment_intents
    WHERE id_intent = v_intent;

    IF v_attempts_after <> COALESCE(v_attempts_before, 0) + 1 THEN
      RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_SUMMARY_NOT_UPDATED';
    END IF;
  END IF;
END
$mf$;

ROLLBACK;
