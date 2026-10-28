DO $mf$
DECLARE
  v_default text;
  v_constraint text;
  v_indexdef text;
BEGIN
  IF to_regclass('public.payment_intents') IS NULL THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_TABLE_MISSING';
  END IF;

  -- orden_compra
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'orden_compra'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_ORDEN_COMPRA_INVALID';
  END IF;

  -- provider_session_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'provider_session_id'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_PROVIDER_SESSION_INVALID';
  END IF;

  -- launch_expires_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'launch_expires_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_LAUNCH_EXPIRES_INVALID';
  END IF;

  -- last_verified_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'last_verified_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_LAST_VERIFIED_INVALID';
  END IF;

  -- verification_attempts: tipo, NOT NULL y DEFAULT 0.
  SELECT column_default
  INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'payment_intents'
    AND column_name = 'verification_attempts'
    AND data_type = 'integer'
    AND is_nullable = 'NO';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_VERIFICATION_ATTEMPTS_TYPE_NULLABILITY_INVALID';
  END IF;

  IF regexp_replace(COALESCE(v_default, ''), '[[:space:]]|::integer|[()]', '', 'g') <> '0' THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_VERIFICATION_ATTEMPTS_DEFAULT_INVALID: %', v_default;
  END IF;

  SELECT pg_get_constraintdef(c.oid)
  INTO v_constraint
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.payment_intents'::regclass
    AND c.conname = 'ck_payment_intents_verification_attempts_nonnegative';

  IF v_constraint IS NULL OR v_constraint !~* 'verification_attempts[[:space:]]*>=[[:space:]]*0' THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_VERIFICATION_ATTEMPTS_CHECK_INVALID: %', v_constraint;
  END IF;

  SELECT indexdef
  INTO v_indexdef
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_payment_intents_provider_order';

  IF v_indexdef IS NULL
     OR position('(id_provider, orden_compra)' in v_indexdef) = 0 THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_PROVIDER_ORDER_INDEX_INVALID: %', v_indexdef;
  END IF;

  SELECT indexdef
  INTO v_indexdef
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_payment_intents_provider_session';

  IF v_indexdef IS NULL
     OR position('(id_provider, provider_session_id)' in v_indexdef) = 0 THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_PROVIDER_SESSION_INDEX_INVALID: %', v_indexdef;
  END IF;
END
$mf$;
