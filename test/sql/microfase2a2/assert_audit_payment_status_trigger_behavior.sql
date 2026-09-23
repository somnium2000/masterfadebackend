BEGIN;

DO $mf$
DECLARE
  v_intent uuid;
  v_audit_before integer;
  v_audit_after integer;
  v_attempts_before integer;
  v_attempts_after integer;
  v_check uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'payment_intents'
      AND t.tgname = 'tr_audit_payment_intents'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'MF_AUDIT_PAYMENT_INTENTS_TRIGGER_MISSING_OR_DISABLED';
  END IF;

  SELECT id_intent, verification_attempts
  INTO STRICT v_intent, v_attempts_before
  FROM public.payment_intents
  ORDER BY created_at ASC
  LIMIT 1;

  SELECT count(*)::integer INTO v_audit_before
  FROM public.bitacoras
  WHERE tabla = 'payment_intents' AND operacion = 'UPDATE';

  v_check := app_private.registrar_payment_status_check_v1(
    v_intent,
    'qa-audit-trigger-reference',
    'manual',
    'PENDING',
    'ok',
    200::smallint,
    NULL,
    3,
    'qa-audit-trigger-request',
    clock_timestamp()
  );

  SELECT verification_attempts INTO v_attempts_after
  FROM public.payment_intents
  WHERE id_intent = v_intent;

  SELECT count(*)::integer INTO v_audit_after
  FROM public.bitacoras
  WHERE tabla = 'payment_intents' AND operacion = 'UPDATE';

  IF v_check IS NULL OR v_attempts_after <> v_attempts_before + 1 THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECK_FUNCTION_REGRESSION';
  END IF;
  IF v_audit_after <> v_audit_before + 1 THEN
    RAISE EXCEPTION 'MF_AUDIT_FUNCTION_DID_NOT_FIRE: before %, after %', v_audit_before, v_audit_after;
  END IF;
END
$mf$;

ROLLBACK;
