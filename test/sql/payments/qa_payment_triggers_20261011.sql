-- AM: Snapshot exacto via pg_get_functiondef de QA (PostgreSQL 17.6), 2026-10-11.
-- Solo fixture en cluster temporal; nunca aplicar este baseline a QA.
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

  NEW.pago_tardio := false;

  IF now() > v_exp_intent THEN
    NEW.pago_tardio := true;
  END IF;

  IF v_id_hold IS NOT NULL THEN
    SELECT expires_at, estado_hold_codigo INTO v_hold_exp, v_hold_estado
    FROM citas_holds
    WHERE id_hold = v_id_hold;

    IF v_hold_exp IS NOT NULL AND now() > v_hold_exp THEN
      NEW.pago_tardio := true;
    END IF;

    IF v_hold_estado IS NOT NULL AND v_hold_estado <> 'activo' THEN
      NEW.pago_tardio := true;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_aplicar_pago_a_cita()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id_cita uuid;
  v_id_hold uuid;
BEGIN
  IF NEW.estado_pago_codigo NOT IN ('capturado','conciliado','manual_pagado') THEN
    RETURN NEW;
  END IF;

  SELECT id_cita, id_hold INTO v_id_cita, v_id_hold
  FROM payment_intents
  WHERE id_intent = NEW.id_intent;

  IF NEW.pago_tardio = true THEN
    UPDATE payment_intents
    SET estado_intent_codigo = 'expirado',
        updated_at = now()
    WHERE id_intent = NEW.id_intent;

    UPDATE citas
    SET estado_cita_codigo = 'expirada',
        updated_at = now()
    WHERE id_cita = v_id_cita
      AND estado_cita_codigo IN ('en_espera','pendiente_pago');

    IF v_id_hold IS NOT NULL THEN
      UPDATE citas_holds
      SET estado_hold_codigo = 'expirado',
          updated_at = now()
      WHERE id_hold = v_id_hold
        AND estado_hold_codigo = 'activo';
    END IF;

    RETURN NEW;
  END IF;

  UPDATE payment_intents
  SET estado_intent_codigo = 'confirmado',
      updated_at = now()
  WHERE id_intent = NEW.id_intent;

  UPDATE citas
  SET estado_cita_codigo = 'confirmada',
      updated_at = now()
  WHERE id_cita = v_id_cita
    AND estado_cita_codigo IN ('en_espera','pendiente_pago');

  IF v_id_hold IS NOT NULL THEN
    UPDATE citas_holds
    SET estado_hold_codigo = 'consumido',
        updated_at = now()
    WHERE id_hold = v_id_hold
      AND estado_hold_codigo = 'activo';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER tr_pay_validar BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_validar_pago_monto_tiempo();
CREATE TRIGGER tr_pay_aplicar AFTER INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_aplicar_pago_a_cita();
