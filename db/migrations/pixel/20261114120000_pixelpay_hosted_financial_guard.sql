BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- AM: Hosted permanece sin confirmacion automatica hasta autenticar el resultado financiero completo.
CREATE OR REPLACE FUNCTION app_private.guard_pixelpay_hosted_financial_intent_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, app_private
AS $function$
BEGIN
  IF NEW.payment_channel = 'hosted'
     AND (NEW.paid_at IS NOT NULL OR NEW.estado_intent_codigo = 'confirmado') THEN
    RAISE EXCEPTION 'MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.guard_pixelpay_hosted_financial_payment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, app_private
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_intents pi
    WHERE pi.id_intent = NEW.id_intent AND pi.payment_channel = 'hosted'
  ) AND (NEW.paid_at IS NOT NULL
         OR NEW.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')) THEN
    RAISE EXCEPTION 'MF_HOSTED_FINANCIAL_VERIFICATION_UNAVAILABLE';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.guard_pixelpay_hosted_financial_intent_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.guard_pixelpay_hosted_financial_payment_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_hosted_financial_intent_guard ON public.payment_intents;
CREATE TRIGGER tr_hosted_financial_intent_guard
BEFORE INSERT OR UPDATE ON public.payment_intents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pixelpay_hosted_financial_intent_v1();

DROP TRIGGER IF EXISTS tr_hosted_financial_payment_guard ON public.payments;
CREATE TRIGGER tr_hosted_financial_payment_guard
BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pixelpay_hosted_financial_payment_v1();

COMMIT;
