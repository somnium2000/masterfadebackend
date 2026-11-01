BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: El despliegue se detiene si el esquema no es exactamente el auditado.
DO $preflight$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
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

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'MF_FINANCIAL_TRIGGER_PREFLIGHT_FAILED: %', array_to_string(v_missing, ',');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payments
    WHERE estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
      AND paid_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.payment_intents
    WHERE estado_intent_codigo = 'confirmado' AND paid_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.membership_purchase_orders
    WHERE estado_orden_codigo = 'pagada' AND paid_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.subscription_payments
    WHERE estado = 'pagado' AND paid_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MF_FINANCIAL_EVIDENCE_PREFLIGHT_FAILED';
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
BEGIN
  SELECT pi.monto_hnl, pi.moneda_codigo, pi.expires_at, pi.id_hold
  INTO v_monto_intent, v_moneda_intent, v_exp_intent, v_id_hold
  FROM public.payment_intents pi
  WHERE pi.id_intent = NEW.id_intent;

  IF v_monto_intent IS NULL THEN RAISE EXCEPTION 'INTENT_INEXISTENTE'; END IF;
  IF NEW.monto_hnl IS DISTINCT FROM v_monto_intent THEN
    RAISE EXCEPTION 'MONTO_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;
  IF NEW.moneda_codigo IS DISTINCT FROM v_moneda_intent THEN
    RAISE EXCEPTION 'MONEDA_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;

  NEW.pago_tardio := false;
  IF NEW.estado_pago_codigo NOT IN ('capturado', 'conciliado', 'manual_pagado') THEN
    RETURN NEW;
  END IF;
  IF NEW.paid_at IS NULL THEN RAISE EXCEPTION 'MF_PAYMENT_PAID_AT_REQUIRED'; END IF;

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
BEGIN
  IF NEW.origen_pago_codigo <> 'cita' THEN RETURN NEW; END IF;

  SELECT min(h.expires_at) INTO v_expires_at
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE h.id_hold = NEW.id_hold
     OR c.id_cita = NEW.id_cita
     OR (NEW.id_grupo_cita IS NOT NULL AND c.id_grupo_cita = NEW.id_grupo_cita);

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
    AND p.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
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

-- AM: Esta funcion usa nombres public no calificados; fijar su resolucion evita secuestro de objetos.
ALTER FUNCTION public.fn_trg_aplicar_pago_a_intent() SET search_path = pg_catalog, public;

COMMIT;
