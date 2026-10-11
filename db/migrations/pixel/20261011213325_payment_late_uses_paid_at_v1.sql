BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: Fallar cerrado si falta el trigger real que se audito; no crear otro trigger.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.payments'::regclass AND t.tgname = 'tr_pay_validar'
      AND t.tgfoid = to_regprocedure('public.fn_trg_validar_pago_monto_tiempo()')
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_LATE_TRIGGER_REQUIRED';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_trg_validar_pago_monto_tiempo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_monto_intent numeric(12,2);
  v_moneda_intent text;
  v_exp_intent timestamptz;
  v_id_hold uuid;
  v_hold_exp timestamptz;
  v_hold_estado text;
  v_payment_time timestamptz;
BEGIN
  SELECT monto_hnl, moneda_codigo, expires_at, id_hold
  INTO v_monto_intent, v_moneda_intent, v_exp_intent, v_id_hold
  FROM payment_intents
  WHERE id_intent = NEW.id_intent;

  IF v_monto_intent IS NULL THEN
    RAISE EXCEPTION 'INTENT_INEXISTENTE';
  END IF;

  IF NEW.monto_hnl IS DISTINCT FROM v_monto_intent THEN
    RAISE EXCEPTION 'MONTO_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;

  IF NEW.moneda_codigo IS DISTINCT FROM v_moneda_intent THEN
    RAISE EXCEPTION 'MONEDA_PAGO_NO_COINCIDE_CON_INTENT';
  END IF;

  -- AM: paid_at explicito representa el instante del pago, no el de reconciliacion.
  v_payment_time := COALESCE(NEW.paid_at, now());
  NEW.pago_tardio := false;

  IF v_payment_time > v_exp_intent THEN
    NEW.pago_tardio := true;
  END IF;

  IF v_id_hold IS NOT NULL THEN
    SELECT expires_at, estado_hold_codigo INTO v_hold_exp, v_hold_estado
    FROM citas_holds
    WHERE id_hold = v_id_hold;

    IF v_hold_exp IS NOT NULL AND v_payment_time > v_hold_exp THEN
      NEW.pago_tardio := true;
    END IF;

    IF NEW.paid_at IS NULL AND v_hold_estado IS NOT NULL AND v_hold_estado <> 'activo' THEN
      NEW.pago_tardio := true;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
