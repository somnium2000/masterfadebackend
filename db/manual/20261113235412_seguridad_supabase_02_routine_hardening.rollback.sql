-- AM | QA-SEGURIDAD-SUPABASE-02. MANUAL rollback; never executed remotely by task.
-- Restores search_path and effective EXECUTE ACL, including grant options.
-- A NULL proacl may become an explicit default ACL with identical privileges.
-- Refuses to overwrite later body/owner/config/ACL edits. Backups are retained.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(20761113, 235412);
DO $rollback$
DECLARE
  b record;
  p record;
  a record;
  v_acl jsonb;
  v_old_path text;
  v_session_path text := current_setting('search_path');
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SECURITY02 rollback: run as postgres';
  END IF;
  IF to_regclass('app_private.security02_routine_backup') IS NULL THEN
    RAISE EXCEPTION 'SECURITY02 rollback: backup missing';
  END IF;
  -- AM | Validate every record before restoring any routine.
  FOR b IN SELECT * FROM app_private.security02_routine_backup
    WHERE applied_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY signature LOOP
    SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure(b.signature);
    IF NOT FOUND OR p.oid <> b.routine_oid OR md5(p.prosrc) <> b.original_body_hash
       OR pg_get_userbyid(p.proowner) <> b.original_owner
       OR p.prosecdef <> b.original_security_definer
       OR p.proconfig IS DISTINCT FROM b.applied_config THEN
      RAISE EXCEPTION 'SECURITY02 rollback: definition/config drift: %', b.signature;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor), 'grantable', x.is_grantable)
      ORDER BY x.grantee, x.grantor, x.is_grantable), '[]'::jsonb)
    INTO v_acl FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x;
    IF v_acl <> b.applied_execute_acl THEN
      RAISE EXCEPTION 'SECURITY02 rollback: ACL drift: %', b.signature;
    END IF;
  END LOOP;
  FOR b IN SELECT * FROM app_private.security02_routine_backup
    WHERE applied_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY signature LOOP
    IF b.path_changed THEN
      SELECT substring(c FROM length('search_path=') + 1) INTO v_old_path
      FROM unnest(b.original_config) c WHERE c LIKE 'search_path=%';
      IF v_old_path IS NULL THEN
        EXECUTE format('ALTER %s %s RESET search_path', b.kind, b.signature);
      ELSE
        PERFORM set_config('search_path', v_old_path, true);
        EXECUTE format('ALTER %s %s SET search_path FROM CURRENT', b.kind, b.signature);
        PERFORM set_config('search_path', v_session_path, true);
      END IF;
    END IF;
    FOR a IN SELECT DISTINCT x.grantee
      FROM pg_proc live, LATERAL aclexplode(coalesce(live.proacl, acldefault('f', live.proowner))) x
      WHERE live.oid = b.routine_oid LOOP
      EXECUTE format('REVOKE EXECUTE ON %s %s FROM %s', b.kind, b.signature,
        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
    END LOOP;
    FOR a IN SELECT * FROM jsonb_to_recordset(b.original_execute_acl)
      AS x(grantee text, grantor text, grantable boolean) LOOP
      EXECUTE format('GRANT EXECUTE ON %s %s TO %s%s', b.kind, b.signature,
        CASE WHEN a.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(a.grantee) END,
        CASE WHEN a.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    UPDATE app_private.security02_routine_backup SET rolled_back_at = clock_timestamp()
    WHERE signature = b.signature;
  END LOOP;
END;
$rollback$;
COMMIT;
