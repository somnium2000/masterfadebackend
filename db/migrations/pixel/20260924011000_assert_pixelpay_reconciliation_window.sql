BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mf$
DECLARE
  v_config text[];
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
END
$mf$;

ROLLBACK;
