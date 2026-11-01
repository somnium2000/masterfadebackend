BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('app_private.pixelpay_sale_attempts') IS NULL THEN
    RAISE EXCEPTION 'MF_FINANCIAL_EVIDENCE_TABLE_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.payments'::regclass
      AND t.tgname = 'tr_pay_validar'
      AND t.tgfoid = to_regprocedure('public.fn_trg_validar_pago_monto_tiempo()')
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN v_missing := array_append(v_missing, 'tr_pay_validar'); END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.payment_intents'::regclass
      AND t.tgname = 'tr_payment_intents_capture_paid_at'
      AND t.tgfoid = to_regprocedure('public.fn_payment_intents_capture_paid_at()')
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN v_missing := array_append(v_missing, 'tr_payment_intents_capture_paid_at'); END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.payments'::regclass
      AND t.tgname = 'tr_pay_aplicar'
      AND t.tgfoid = to_regprocedure('public.fn_trg_aplicar_pago_a_cita()')
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN v_missing := array_append(v_missing, 'tr_pay_aplicar'); END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'MF_FINANCIAL_TRIGGER_PREFLIGHT_FAILED: %', array_to_string(v_missing, ',');
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_trg_validar_pago_monto_tiempo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_monto_intent numeric(12,2);
  v_moneda_intent text;
  v_exp_intent timestamptz;
  v_id_hold uuid;
  v_hold_exp timestamptz;
  v_historical_manual boolean := false;
  v_historical_terminal boolean := false;
  v_provider_code text;
  v_evidence_time timestamptz;
  v_evidence_count integer := 0;
BEGIN
  SELECT pi.monto_hnl, pi.moneda_codigo, pi.expires_at, pi.id_hold, pp.codigo
  INTO v_monto_intent, v_moneda_intent, v_exp_intent, v_id_hold, v_provider_code
  FROM public.payment_intents pi
  LEFT JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
  WHERE pi.id_intent = NEW.id_intent;

  IF v_monto_intent IS NULL THEN RAISE EXCEPTION 'INTENT_INEXISTENTE'; END IF;
  IF NEW.monto_hnl IS DISTINCT FROM v_monto_intent THEN
    RAISE EXCEPTION 'MONTO_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;
  IF NEW.moneda_codigo IS DISTINCT FROM v_moneda_intent THEN
    RAISE EXCEPTION 'MONEDA_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_historical_manual := (OLD.estado_pago_codigo = 'manual_pagado' OR OLD.registrado_manualmente IS TRUE)
      AND NEW.estado_pago_codigo IS NOT DISTINCT FROM OLD.estado_pago_codigo
      AND NEW.registrado_manualmente IS NOT DISTINCT FROM OLD.registrado_manualmente
      AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at;
    v_historical_terminal := OLD.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
      AND NEW.estado_pago_codigo IS NOT DISTINCT FROM OLD.estado_pago_codigo
      AND NEW.registrado_manualmente IS NOT DISTINCT FROM OLD.registrado_manualmente
      AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at;
  END IF;
  IF (NEW.estado_pago_codigo = 'manual_pagado' OR NEW.registrado_manualmente IS TRUE)
     AND NOT v_historical_manual THEN
    RAISE EXCEPTION 'MF_MANUAL_PAYMENT_DISABLED';
  END IF;
  IF v_historical_manual THEN RETURN NEW; END IF;

  NEW.pago_tardio := false;
  IF NEW.estado_pago_codigo NOT IN ('capturado', 'conciliado', 'manual_pagado') THEN
    RETURN NEW;
  END IF;
  IF NEW.paid_at IS NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
       AND OLD.paid_at IS NULL
       AND NEW.estado_pago_codigo IS NOT DISTINCT FROM OLD.estado_pago_codigo THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_REQUIRED';
  END IF;

  IF lower(COALESCE(v_provider_code, '')) = 'pixelpay' AND NOT v_historical_terminal THEN
    SELECT count(*)::integer, min(a.finalized_at)
    INTO v_evidence_count, v_evidence_time
    FROM app_private.pixelpay_sale_attempts a
    WHERE a.id_intent = NEW.id_intent
      AND a.outcome = 'approved'
      AND a.sdk_response_class = 'SuccessResponse'
      AND a.upstream_http_status = 200
      AND a.finalized_at IS NOT NULL
      AND a.response_success IS TRUE
      AND a.response_approved IS TRUE
      AND a.response_incomplete IS FALSE
      AND a.uncertain IS FALSE
      AND a.transaction_result_valid IS TRUE
      AND a.transaction_result_parsed IS TRUE
      AND a.payment_uuid_present IS TRUE
      AND a.transaction_id_present IS TRUE
      AND a.payment_hash_present IS TRUE
      AND a.payment_hash_valid IS TRUE
      AND a.transaction_amount_matches IS TRUE
      AND a.approved_amount_matches IS TRUE
      AND a.amount_matches IS TRUE;
    IF v_evidence_count <> 1 THEN
      RAISE EXCEPTION 'MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED';
    END IF;
    IF NEW.paid_at IS DISTINCT FROM v_evidence_time THEN
      RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_EVIDENCE_MISMATCH';
    END IF;
  END IF;

  IF NEW.paid_at > v_exp_intent THEN NEW.pago_tardio := true; END IF;
  IF v_id_hold IS NOT NULL THEN
    SELECT ch.expires_at INTO v_hold_exp
    FROM public.citas_holds ch WHERE ch.id_hold = v_id_hold;
    IF v_hold_exp IS NOT NULL AND NEW.paid_at > v_hold_exp THEN
      NEW.pago_tardio := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_payment_intents_capture_paid_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_expires_at timestamptz;
  v_payment_time timestamptz;
  v_evidence_time timestamptz;
  v_evidence_count integer := 0;
  v_provider_code text;
BEGIN
  IF NEW.origen_pago_codigo <> 'cita' THEN RETURN NEW; END IF;

  SELECT min(h.expires_at) INTO v_expires_at
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE h.id_hold = NEW.id_hold
     OR c.id_cita = NEW.id_cita
     OR (NEW.id_grupo_cita IS NOT NULL AND c.id_grupo_cita = NEW.id_grupo_cita);

  SELECT pp.codigo INTO v_provider_code
  FROM public.payment_providers pp
  WHERE pp.id_provider = NEW.id_provider;

  IF lower(COALESCE(v_provider_code, '')) = 'pixelpay'
     AND NEW.estado_intent_codigo IN ('pendiente_confirmacion', 'confirmado')
     AND NEW.paid_at IS NOT NULL
     AND NOT (TG_OP = 'UPDATE'
       AND OLD.estado_intent_codigo IN ('pendiente_confirmacion', 'confirmado')
       AND NEW.estado_intent_codigo IS NOT DISTINCT FROM OLD.estado_intent_codigo
       AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at) THEN
    SELECT count(*)::integer, min(a.finalized_at)
    INTO v_evidence_count, v_evidence_time
    FROM app_private.pixelpay_sale_attempts a
    WHERE a.id_intent = NEW.id_intent
      AND a.outcome = 'approved'
      AND a.sdk_response_class = 'SuccessResponse'
      AND a.upstream_http_status = 200
      AND a.finalized_at IS NOT NULL
      AND a.response_success IS TRUE AND a.response_approved IS TRUE
      AND a.response_incomplete IS FALSE AND a.uncertain IS FALSE
      AND a.transaction_result_valid IS TRUE AND a.transaction_result_parsed IS TRUE
      AND a.payment_uuid_present IS TRUE AND a.transaction_id_present IS TRUE
      AND a.payment_hash_present IS TRUE AND a.payment_hash_valid IS TRUE
      AND a.transaction_amount_matches IS TRUE AND a.approved_amount_matches IS TRUE
      AND a.amount_matches IS TRUE;
    IF v_evidence_count <> 1 THEN RAISE EXCEPTION 'MF_PAYMENT_DURABLE_EVIDENCE_REQUIRED'; END IF;
    IF NEW.paid_at IS DISTINCT FROM v_evidence_time THEN
      RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_EVIDENCE_MISMATCH';
    END IF;
  END IF;

  IF NEW.estado_intent_codigo = 'pendiente_confirmacion' AND NEW.paid_at IS NOT NULL THEN
    IF v_expires_at IS NULL THEN RAISE EXCEPTION 'MF_PAYMENT_HOLD_NOT_FOUND'; END IF;
    IF NEW.paid_at > v_expires_at THEN RAISE EXCEPTION 'MF_PAYMENT_AFTER_HOLD_EXPIRY'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.estado_intent_codigo <> 'confirmado' THEN RETURN NEW; END IF;
  IF v_expires_at IS NULL THEN RAISE EXCEPTION 'MF_PAYMENT_HOLD_NOT_FOUND'; END IF;

  SELECT min(p.paid_at) INTO v_payment_time
  FROM public.payments p
  WHERE p.id_intent = NEW.id_intent
    AND p.estado_pago_codigo IN ('capturado', 'conciliado')
    AND p.registrado_manualmente IS FALSE
    AND p.paid_at IS NOT NULL;
  IF TG_OP = 'UPDATE' THEN
    v_payment_time := COALESCE(NEW.paid_at, v_payment_time, OLD.paid_at);
  ELSE
    v_payment_time := COALESCE(NEW.paid_at, v_payment_time);
  END IF;

  IF v_payment_time IS NULL THEN RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_REQUIRED'; END IF;
  IF v_payment_time > v_expires_at THEN RAISE EXCEPTION 'MF_PAYMENT_AFTER_HOLD_EXPIRY'; END IF;
  NEW.paid_at := v_payment_time;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_trg_aplicar_pago_a_cita() SET search_path = pg_catalog, public;

COMMIT;
