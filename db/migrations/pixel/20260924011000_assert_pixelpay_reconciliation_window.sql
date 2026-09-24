BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mf$
DECLARE
  v_config text[];
  v_trigger_count integer;
  v_enabled_trigger_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.parametros_sistema ps
    WHERE ps.clave = 'agendamiento_confirmacion_pago_gracia_min'
      AND ps.valor_numero = 5
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_CONFIRMATION_GRACE_INVALID';
  END IF;

  SELECT p.proconfig
  INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'proteger_reserva_pago_v1'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_id_intent uuid, p_id_grupo_cita uuid'
    AND p.prosecdef IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF_PAYMENT_PROTECTION_FUNCTION_MISSING';
  END IF;

  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, app_private']::text[] THEN
    RAISE EXCEPTION 'MF_PAYMENT_PROTECTION_SEARCH_PATH_INVALID';
  END IF;

  SELECT p.proconfig
  INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'expirar_reservas_vencidas_v1'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_limite integer, p_ahora timestamp with time zone, p_id_sucursal uuid, p_id_barbero uuid, p_inicio_at timestamp with time zone, p_fin_at timestamp with time zone, p_id_usuario_titular uuid'
    AND p.prosecdef IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF_PAYMENT_EXPIRY_FUNCTION_MISSING';
  END IF;

  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION 'MF_PAYMENT_EXPIRY_SEARCH_PATH_INVALID';
  END IF;

  IF pg_catalog.pg_get_functiondef(
    'app_private.expirar_reservas_vencidas_v1(integer,timestamp with time zone,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid)'::regprocedure
  ) ~ $$estado_intent_codigo\s+IN\s*\([^)]*'pendiente_confirmacion'$$ THEN
    RAISE EXCEPTION 'MF_PAYMENT_EXPIRY_STILL_EXPIRES_PENDING_CONFIRMATION';
  END IF;

  SELECT p.proconfig
  INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'confirmar_reserva_pagada_v1'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_id_intent uuid, p_referencia_externa text, p_pagado_at timestamp with time zone'
    AND p.prosecdef IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF_PAYMENT_CONFIRMATION_FUNCTION_MISSING';
  END IF;

  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION 'MF_PAYMENT_CONFIRMATION_SEARCH_PATH_INVALID';
  END IF;

  SELECT p.proconfig
  INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'fn_payment_intents_capture_paid_at'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
    AND p.prosecdef IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_FUNCTION_MISSING';
  END IF;

  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] THEN
    RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_SEARCH_PATH_INVALID';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE t.tgenabled <> 'D')::integer
  INTO v_trigger_count, v_enabled_trigger_count
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace table_ns ON table_ns.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
  JOIN pg_catalog.pg_namespace function_ns ON function_ns.oid = p.pronamespace
  WHERE t.tgisinternal IS FALSE
    AND table_ns.nspname = 'public'
    AND c.relname = 'payment_intents'
    AND function_ns.nspname = 'public'
    AND p.proname = 'fn_payment_intents_capture_paid_at'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = '';

  IF v_trigger_count = 0 THEN
    RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_TRIGGER_MISSING';
  END IF;

  IF v_enabled_trigger_count = 0 THEN
    RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_TRIGGER_DISABLED';
  END IF;
END
$mf$;

ROLLBACK;
