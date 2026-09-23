DO $mf$
BEGIN
  IF to_regprocedure('public.fn_auditar_bitacora()') IS NULL THEN
    RAISE EXCEPTION 'MF_AUDIT_FUNCTION_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_auditar_bitacora'
      AND oidvectortypes(p.proargtypes) = ''
      AND NOT p.prosecdef
      AND p.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
  ) THEN
    RAISE EXCEPTION 'MF_AUDIT_FUNCTION_CONTRACT_INVALID';
  END IF;
END
$mf$;
