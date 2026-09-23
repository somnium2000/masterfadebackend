BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mf$
BEGIN
  IF to_regprocedure('public.fn_auditar_bitacora()') IS NULL THEN
    RAISE EXCEPTION 'MF_AUDIT_FUNCTION_MISSING';
  END IF;
END
$mf$;

ALTER FUNCTION public.fn_auditar_bitacora()
  SET search_path = pg_catalog, public;

COMMIT;
