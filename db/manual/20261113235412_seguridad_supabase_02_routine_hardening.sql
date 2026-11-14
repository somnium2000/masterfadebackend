-- AM | QA-SEGURIDAD-SUPABASE-02. MANUAL ONLY: never applied by this task.
-- No business rows, routine bodies, owners, RLS policies or trigger bindings change.
-- Run the read-only preflight/report first; a mismatch aborts the whole transaction.
-- Rollback: 20261113235412_seguridad_supabase_02_routine_hardening.rollback.sql
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(20761113, 235412);

CREATE TEMP TABLE security02_manifest (
  signature text PRIMARY KEY,
  kind text NOT NULL,
  allowed_hashes text[] NOT NULL,
  return_type text NOT NULL,
  security_definer boolean NOT NULL,
  harden_path boolean NOT NULL,
  harden_existing_path boolean NOT NULL,
  path_target text NOT NULL,
  execution_scope text NOT NULL
) ON COMMIT DROP;
INSERT INTO security02_manifest VALUES
  ('public.fn_agenda_excepciones_sucursal_bloques_validar_modo()', 'function', ARRAY['b7f1fd429da5b143d2e6f634a6687b77'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_agenda_excepciones_sucursal_validar_compatibilidad()', 'function', ARRAY['fce621274910e0365e87f6ee4b9c7669'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_bloquear_delete_fisico()', 'function', ARRAY['4dc9aadcf54d803079c7a6d07f44c8e2'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_bloquear_persona_cliente_empleado()', 'function', ARRAY['56b7d42510a2fae394a7f810566f7428'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_citas_grupos_set_defaults()', 'function', ARRAY['30442740a082a123e54e69c3784d24db'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_citas_integrantes_set_updated_at()', 'function', ARRAY['5bdc21b8fa8fb1231bdb021e09a5bc8e'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_citas_integrantes_validate_limits()', 'function', ARRAY['72a2a7e18406fe35f707809efc9d6445'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_citas_set_integrante_from_legacy()', 'function', ARRAY['41fefd2ea50288d4874e8947cf75f1c5'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_comprobantes_agendamiento_set_defaults()', 'function', ARRAY['5823059c60bd5159e094bbda1fa2cafa'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_comprobantes_destinatarios_set_updated_at()', 'function', ARRAY['5bdc21b8fa8fb1231bdb021e09a5bc8e'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_desactivar_tarifas_base_de_servicio()', 'function', ARRAY['fc102cad03011adda030e0631f482264'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_facturas_set_updated_at()', 'function', ARRAY['5bdc21b8fa8fb1231bdb021e09a5bc8e'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_guardar_desactivacion_servicio()', 'function', ARRAY['31abab3e1bdace55a2eaf282ec503d04'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_marcar_no_show(integer, integer)', 'procedure', ARRAY['078aba2a9a1da944b163b1ab1c1b605b'], 'void', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_estado_final_cita()', 'function', ARRAY['38b27cac561d41e078a3f53775e4a429'], 'text', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_get_effective_rule(uuid)', 'function', ARRAY['27b895e6f146655df078882c50a9911b'], 'record', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_get_or_create_active_cycle(uuid, integer, timestamp with time zone)', 'function', ARRAY['a38d0b9a382ab61dc7468198b6d45229', '00ae108a843def22ce1b8e732e9a75ba'], 'record', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_get_or_create_active_cycle(uuid, timestamp with time zone)', 'function', ARRAY['6be79dd3b72e1d7a05016a613bf4a53d', 'cb533a2e649d94d0c9d3ac78bd310e95'], 'record', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_materialize_expired_cycles(uuid)', 'function', ARRAY['8da336f77b4f237b0387d8d0cdb66c44'], 'integer', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_tx_apply_tipo_sign()', 'function', ARRAY['d9e9c315c1cfb417de0945ccc1b91e07'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_points_tx_guard_acumular_final()', 'function', ARRAY['25e47807f162b12b9de8c87e15a8248c', '4e28d76d27a4ece71cfbac08000354fc'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_prevent_block_protected_correo()', 'function', ARRAY['08f9e5c93d55cf921e7d32eb3bc5ed15'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_prevent_block_protected_persona()', 'function', ARRAY['cae50000e7933616b7d51470839c056a'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_prevent_block_protected_role()', 'function', ARRAY['e2f0a78d7a2c712bb6afeb339c9d7c6c'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_prevent_block_protected_usuario()', 'function', ARRAY['85b8212c6b1966571f2cb756b1b98ec6'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_set_updated_at()', 'function', ARRAY['5bdc21b8fa8fb1231bdb021e09a5bc8e'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_trg_otorgar_puntos_plan_confirmada()', 'function', ARRAY['d28d6871c43022fd0950f4ec9f973972', '8270cf772d8160350926c8762482ca4b'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_trg_otorgar_puntos_por_cita()', 'function', ARRAY['b271a74a0fd9440113f62c331e8a7ea8', 'a5471f67639a089297e2384c4d6dd1dc'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_trg_roles_usuarios_unicidad_scope()', 'function', ARRAY['b35bcc38f4d9a303d946a57f45dc0306'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_trg_validar_cliente_persona_en_cita()', 'function', ARRAY['804968e5011334975898f0f92c3d2a22'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_validar_paquete_activo_minimo_servicios()', 'function', ARRAY['66bd226e1771837b8532cad439e5ddb3'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_validar_paquete_activo_sin_servicios_inactivos()', 'function', ARRAY['9f36d7892d1ce610990354708cc635f1'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_validar_persona_empleado_campos_obligatorios()', 'function', ARRAY['2b2b513e8938f017bc635d58c2e6ed5c'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_validar_servicio_activo_con_tarifa_base()', 'function', ARRAY['016ee021bb845a57158a5ffefe1c1630'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.set_current_timestamp_updated_at()', 'function', ARRAY['9b1889f56258bf9d6554213c05019c76'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.validate_membership_plan_beneficios()', 'function', ARRAY['30211caf31b6be34f745c27ade950b42'], 'trigger', false, true, false, 'pg_catalog, public, pg_temp', 'unchanged'),
  ('public.fn_citas_detalles_line_identity_v2()', 'function', ARRAY['e0529d5052325541fa66519eae480ec9'], 'trigger', true, false, true, 'pg_catalog, public, app_private, pg_temp', 'trigger'),
  ('public.fn_hold_defaults_y_unico()', 'function', ARRAY['cdb2df6f06d291d52b40ae7ebd2a92a7'], 'trigger', true, false, true, 'pg_catalog, public, app_private, pg_temp', 'trigger'),
  ('public.fn_es_admin_de_sucursal(uuid, uuid)', 'function', ARRAY['9bad3022eac86ec52bd7902a0fe515f6'], 'boolean', true, false, true, 'pg_catalog, public, auth, pg_temp', 'rls'),
  ('public.fn_is_super_admin(uuid)', 'function', ARRAY['478c6d1cd1c85e02fcc87a4a14c93be5'], 'boolean', true, false, true, 'pg_catalog, public, auth, pg_temp', 'rls'),
  ('public.fn_has_role(uuid, text)', 'function', ARRAY['1d9b2c65d020c49ec142a62ed70ee868'], 'boolean', true, false, true, 'pg_catalog, public, auth, pg_temp', 'unchanged')
;

-- AM | Fail closed against unknown owners, bodies, extensions and unsafe schemas.
DO $preflight$
DECLARE
  r record;
  p record;
  v_oid oid;
  v_path text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SECURITY02 preflight: run as postgres; no changes applied';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'SECURITY02 preflight: unexpected client-role capabilities';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'SECURITY02 preflight: expected API roles missing';
  END IF;
  IF has_schema_privilege('anon', 'public', 'CREATE')
     OR has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'SECURITY02 preflight: public allows client CREATE; review separately';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app_private'
             AND pg_get_userbyid(nspowner) <> 'postgres') THEN
    RAISE EXCEPTION 'SECURITY02 preflight: unexpected app_private owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('app_private.security02_routine_backup')
             AND (pg_get_userbyid(relowner) <> 'postgres' OR relkind <> 'r')) THEN
    RAISE EXCEPTION 'SECURITY02 preflight: unexpected backup relation owner/kind';
  END IF;
  IF has_schema_privilege('anon', 'auth', 'CREATE')
     OR has_schema_privilege('authenticated', 'auth', 'CREATE')
     OR (to_regnamespace('app_private') IS NOT NULL AND (
       has_schema_privilege('anon', 'app_private', 'CREATE')
       OR has_schema_privilege('authenticated', 'app_private', 'CREATE'))) THEN
    RAISE EXCEPTION 'SECURITY02 preflight: dependency schema allows client CREATE';
  END IF;
  FOR r IN SELECT * FROM pg_temp.security02_manifest ORDER BY signature LOOP
    v_oid := to_regprocedure(r.signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'SECURITY02 preflight: missing routine %', r.signature;
    END IF;
    SELECT * INTO STRICT p FROM pg_proc WHERE oid = v_oid;
    IF p.prokind::text <> (CASE r.kind WHEN 'procedure' THEN 'p' ELSE 'f' END)
       OR pg_get_userbyid(p.proowner) <> 'postgres'
       OR p.prosecdef <> r.security_definer
       OR p.prorettype <> r.return_type::regtype
       OR NOT (md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) = ANY(r.allowed_hashes)) THEN
      RAISE EXCEPTION 'SECURITY02 preflight: signature/owner/body/security drift: %', r.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_depend WHERE classid = 'pg_proc'::regclass
               AND objid = v_oid AND deptype = 'e') THEN
      RAISE EXCEPTION 'SECURITY02 preflight: extension-owned routine %', r.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantor <> p.proowner) THEN
      RAISE EXCEPTION 'SECURITY02 preflight: non-owner ACL grantor requires review: %', r.signature;
    END IF;
    SELECT substring(c FROM length('search_path=') + 1) INTO v_path
    FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%';
    IF r.harden_path AND v_path IS NOT NULL
       AND NOT (v_path = ANY(ARRAY['pg_catalog, public', r.path_target])) THEN
      RAISE EXCEPTION 'SECURITY02 preflight: unknown existing search_path: %', r.signature;
    END IF;
    IF r.harden_existing_path THEN
      IF v_path IS NULL OR NOT (v_path = ANY(ARRAY[r.path_target,
        CASE WHEN r.execution_scope = 'trigger' THEN 'pg_catalog, public, app_private'
             ELSE 'public, auth' END])) THEN
        RAISE EXCEPTION 'SECURITY02 preflight: dependency search_path drift: %', r.signature;
      END IF;
    END IF;
    IF r.execution_scope <> 'unchanged' THEN
      IF r.execution_scope = 'rls' AND NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'SECURITY02 preflight: authenticated grant drift: %', r.signature;
      END IF;
      IF r.execution_scope = 'rls' AND (p.prorettype <> 'boolean'::regtype
         OR has_function_privilege('anon', v_oid, 'EXECUTE')) THEN
        RAISE EXCEPTION 'SECURITY02 preflight: RLS helper contract drift: %', r.signature;
      END IF;
      IF r.execution_scope = 'trigger' AND p.prorettype <> 'trigger'::regtype THEN
        RAISE EXCEPTION 'SECURITY02 preflight: trigger contract drift: %', r.signature;
      END IF;
      IF r.execution_scope = 'trigger' AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgfoid = v_oid AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
          AND n.nspname = 'public'
          AND ((r.signature = 'public.fn_hold_defaults_y_unico()'
                AND c.relname = 'citas_holds' AND t.tgname = 'tr_hold_unico')
            OR (r.signature = 'public.fn_citas_detalles_line_identity_v2()'
                AND c.relname = 'citas_detalles' AND t.tgname = 'tr_zz_citas_detalles_line_identity'))
      ) THEN
        RAISE EXCEPTION 'SECURITY02 preflight: expected trigger binding missing: %', r.signature;
      END IF;
    END IF;
  END LOOP;
END;
$preflight$;

-- AM | Private metadata backup only. First original snapshot survives reruns.
CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION postgres;
CREATE TABLE IF NOT EXISTS app_private.security02_routine_backup (
  signature text PRIMARY KEY,
  routine_oid oid NOT NULL,
  kind text NOT NULL,
  original_definition text NOT NULL,
  original_owner text NOT NULL,
  original_body_hash text NOT NULL,
  original_config text[],
  original_acl aclitem[],
  original_execute_acl jsonb NOT NULL,
  dependencies jsonb NOT NULL,
  original_security_definer boolean NOT NULL,
  path_changed boolean NOT NULL DEFAULT false,
  applied_config text[],
  applied_execute_acl jsonb,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  rolled_back_at timestamptz
);
ALTER TABLE app_private.security02_routine_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.security02_routine_backup FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE app_private.security02_routine_backup TO postgres;

DO $apply$
DECLARE
  r record;
  p record;
  b record;
  a record;
  v_acl jsonb;
  v_changed boolean;
  v_old_path text;
  v_session_path text := current_setting('search_path');
BEGIN
  FOR r IN SELECT * FROM pg_temp.security02_manifest ORDER BY signature LOOP
    SELECT * INTO STRICT p FROM pg_proc WHERE oid = to_regprocedure(r.signature);
    IF p.prokind::text <> (CASE r.kind WHEN 'procedure' THEN 'p' ELSE 'f' END)
       OR pg_get_userbyid(p.proowner) <> 'postgres'
       OR p.prosecdef <> r.security_definer OR p.prorettype <> r.return_type::regtype
       OR NOT (md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) = ANY(r.allowed_hashes)) THEN
      RAISE EXCEPTION 'SECURITY02: concurrent pre-apply definition drift: %', r.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
               WHERE x.grantor <> p.proowner) THEN
      RAISE EXCEPTION 'SECURITY02: concurrent pre-apply ACL grantor drift: %', r.signature;
    END IF;
    SELECT substring(c FROM length('search_path=') + 1) INTO v_old_path
    FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%';
    IF r.harden_path AND v_old_path IS NOT NULL
       AND NOT (v_old_path = ANY(ARRAY['pg_catalog, public', r.path_target])) THEN
      RAISE EXCEPTION 'SECURITY02: concurrent pre-apply path drift: %', r.signature;
    END IF;
    IF r.harden_existing_path THEN
      IF v_old_path IS NULL OR NOT (v_old_path = ANY(ARRAY[r.path_target,
        CASE WHEN r.execution_scope = 'trigger' THEN 'pg_catalog, public, app_private'
             ELSE 'public, auth' END])) THEN
        RAISE EXCEPTION 'SECURITY02: concurrent pre-apply path drift: %', r.signature;
      END IF;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor), 'grantable', x.is_grantable)
      ORDER BY x.grantee, x.grantor, x.is_grantable), '[]'::jsonb)
    INTO v_acl FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x;

    INSERT INTO app_private.security02_routine_backup (
      signature, routine_oid, kind, original_definition, original_owner,
      original_body_hash, original_config, original_acl, original_execute_acl,
      original_security_definer, dependencies
    ) VALUES (
      r.signature, p.oid, r.kind, pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner),
      md5(p.prosrc), p.proconfig, p.proacl, v_acl, p.prosecdef,
      jsonb_build_object(
        'references', (SELECT coalesce(jsonb_agg(pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid)), '[]'::jsonb)
                       FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid),
        'dependents', (SELECT coalesce(jsonb_agg(pg_describe_object(d.classid, d.objid, d.objsubid)), '[]'::jsonb)
                       FROM pg_depend d WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid),
        'triggers', (SELECT coalesce(jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.oid), '[]'::jsonb)
                     FROM pg_trigger t WHERE t.tgfoid = p.oid)))
    ON CONFLICT (signature) DO NOTHING;
    SELECT * INTO STRICT b FROM app_private.security02_routine_backup WHERE signature = r.signature;
    IF b.routine_oid <> p.oid OR b.original_body_hash <> md5(p.prosrc)
       OR b.original_owner <> pg_get_userbyid(p.proowner)
       OR b.original_security_definer <> p.prosecdef THEN
      RAISE EXCEPTION 'SECURITY02: backup identity/body drift: %', r.signature;
    END IF;
    IF b.applied_at IS NOT NULL AND b.rolled_back_at IS NULL THEN
      IF b.applied_config IS DISTINCT FROM p.proconfig OR b.applied_execute_acl <> v_acl THEN
        RAISE EXCEPTION 'SECURITY02: post-apply drift; manual review required: %', r.signature;
      END IF;
      CONTINUE;
    END IF;
    IF b.rolled_back_at IS NOT NULL AND (b.original_config IS DISTINCT FROM p.proconfig
       OR b.original_execute_acl <> v_acl) THEN
      RAISE EXCEPTION 'SECURITY02: post-rollback drift; preserve later changes: %', r.signature;
    END IF;
    -- AM | A fixed path from an earlier migration is deliberately preserved.
    SELECT substring(c FROM length('search_path=') + 1) INTO v_old_path
    FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%';
    v_changed := (r.harden_path AND v_old_path IS NULL)
      OR (r.harden_existing_path AND v_old_path IS DISTINCT FROM r.path_target);
    IF v_changed THEN
      PERFORM set_config('search_path', r.path_target, true);
      EXECUTE format('ALTER %s %s SET search_path FROM CURRENT', r.kind, r.signature);
      PERFORM set_config('search_path', v_session_path, true);
    END IF;
    IF r.execution_scope <> 'unchanged' THEN
      -- AM | Preserve prior effective access of administrative/server roles
      -- even when their previous access came only through PUBLIC.
      IF EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                 WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN
        FOR a IN SELECT rolname FROM pg_roles
        WHERE rolname NOT IN ('anon', 'authenticated')
          AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb
               OR rolname IN ('service_role', 'authenticator'))
          AND has_function_privilege(oid, p.oid, 'EXECUTE') LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.signature, a.rolname);
        END LOOP;
      END IF;
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.signature);
      IF r.execution_scope = 'trigger' THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.signature);
        IF has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'SECURITY02: inherited client trigger privilege needs review: %', r.signature;
        END IF;
      ELSE
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.signature);
        IF has_function_privilege('anon', p.oid, 'EXECUTE')
           OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'SECURITY02: RLS execution contract failed: %', r.signature;
        END IF;
      END IF;
    END IF;
    SELECT * INTO STRICT p FROM pg_proc WHERE oid = b.routine_oid;
    IF md5(p.prosrc) <> b.original_body_hash OR pg_get_userbyid(p.proowner) <> b.original_owner
       OR p.prosecdef <> b.original_security_definer THEN
      RAISE EXCEPTION 'SECURITY02: concurrent routine definition change: %', r.signature;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor), 'grantable', x.is_grantable)
      ORDER BY x.grantee, x.grantor, x.is_grantable), '[]'::jsonb)
    INTO v_acl FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x;
    UPDATE app_private.security02_routine_backup
    SET path_changed = v_changed, applied_config = p.proconfig, applied_execute_acl = v_acl,
        applied_at = clock_timestamp(), rolled_back_at = NULL
    WHERE signature = r.signature;
  END LOOP;
END;
$apply$;

-- AM | Return reviewable metadata. No data modifications in application tables.
SELECT signature, kind, path_changed, original_owner, original_body_hash,
       original_config, applied_config, original_execute_acl, applied_execute_acl
FROM app_private.security02_routine_backup ORDER BY signature;
COMMIT;
