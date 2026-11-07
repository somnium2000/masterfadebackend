BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: Solo la ultima Sale PixelPay finalizada e incierta protege el intent.
CREATE OR REPLACE FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(
  p_id_intent uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
  SELECT EXISTS (
    SELECT 1
    FROM public.payment_intents pi
    JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
    WHERE pi.id_intent = p_id_intent
      AND pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo = 'pendiente_confirmacion'
      AND lower(pp.codigo) = 'pixelpay'
      AND (
        SELECT a.outcome = 'uncertain' AND a.uncertain IS TRUE
        FROM app_private.pixelpay_sale_attempts a
        WHERE a.id_intent = pi.id_intent
          AND a.finalized_at IS NOT NULL
        ORDER BY a.created_at DESC, a.id_sale_attempt DESC
        LIMIT 1
      ) IS TRUE
  );
$mf$;

REVOKE ALL ON FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(uuid) TO postgres;

-- AM: Todo camino que libera un hold expira pendientes ordinarios, pero conserva
-- exclusivamente la evidencia durable de una Sale incierta de PixelPay.
CREATE OR REPLACE FUNCTION app_private.expire_unprotected_intents_for_hold_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
BEGIN
  IF NEW.estado_hold_codigo <> 'expirado'
     OR OLD.estado_hold_codigo IS NOT DISTINCT FROM NEW.estado_hold_codigo THEN
    RETURN NEW;
  END IF;

  UPDATE public.payment_intents pi
  SET estado_intent_codigo = 'expirado',
      updated_at = clock_timestamp()
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita
    AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
    AND (
      pi.id_hold = NEW.id_hold
      OR pi.id_cita = NEW.id_cita
      OR (c.id_grupo_cita IS NOT NULL AND pi.id_grupo_cita = c.id_grupo_cita)
    )
    AND NOT app_private.pixelpay_intent_has_uncertain_sale_v1(pi.id_intent);

  RETURN NEW;
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.expire_unprotected_intents_for_hold_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.expire_unprotected_intents_for_hold_v1() TO postgres;

DROP TRIGGER IF EXISTS tr_hold_expire_unprotected_intents ON public.citas_holds;
CREATE TRIGGER tr_hold_expire_unprotected_intents
AFTER UPDATE OF estado_hold_codigo ON public.citas_holds
FOR EACH ROW
WHEN (NEW.estado_hold_codigo = 'expirado' AND OLD.estado_hold_codigo IS DISTINCT FROM NEW.estado_hold_codigo)
EXECUTE FUNCTION app_private.expire_unprotected_intents_for_hold_v1();

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.citas_holds'::regclass
      AND t.tgname = 'tr_hold_expire_unprotected_intents'
      AND t.tgfoid = to_regprocedure('app_private.expire_unprotected_intents_for_hold_v1()')
      AND NOT t.tgisinternal
      AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'MF_UNCERTAIN_EXPIRATION_TRIGGER_REQUIRED';
  END IF;
END
$assert$;

COMMIT;
