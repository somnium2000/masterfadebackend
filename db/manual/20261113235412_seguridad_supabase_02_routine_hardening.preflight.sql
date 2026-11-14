-- AM | Read-only catalog report. Proposed manual SQL; not executed remotely.
-- Captures current signatures, owners, bodies (hash), grants and dependencies.
-- Actual Data API exposure also requires the runtime PostgREST schema configuration.
-- The migration performs stricter fail-closed checks before changing metadata.
WITH manifest(signature, kind, allowed_hashes, return_type, security_definer,
              harden_path, harden_existing_path, path_target, execution_scope) AS (
  VALUES
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
), routines AS (
  SELECT m.*, p.* FROM manifest m
  LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(m.signature)
)
SELECT signature, kind AS expected_kind, prokind AS actual_kind,
  pg_catalog.pg_get_userbyid(proowner) AS current_owner,
  CASE WHEN oid IS NULL THEN 'MISSING'
    WHEN pg_catalog.pg_get_userbyid(proowner) <> 'postgres' THEN 'OWNER_REVIEW'
    WHEN prokind::text <> CASE kind WHEN 'procedure' THEN 'p' ELSE 'f' END THEN 'KIND_REVIEW'
    WHEN prosecdef <> security_definer OR prorettype <> return_type::regtype THEN 'CONTRACT_REVIEW'
    WHEN NOT (pg_catalog.md5(pg_catalog.replace(prosrc, chr(13) || chr(10), chr(10))) = ANY(allowed_hashes)) THEN 'BODY_REVIEW'
    ELSE 'KNOWN_DEFINITION' END AS definition_status,
  prosecdef AS security_definer, proconfig AS current_config,
  path_target AS proposed_path_if_changed,
  pg_catalog.md5(prosrc) AS literal_body_hash,
  pg_catalog.md5(pg_catalog.replace(prosrc, chr(13) || chr(10), chr(10))) AS canonical_body_hash,
  execution_scope,
  prokind = 'f' AND prorettype <> 'pg_catalog.trigger'::regtype AS rpc_return_kind_candidate,
  pg_catalog.current_setting('pgrst.db_schemas', true) AS reported_pgrst_schemas,
  (SELECT jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      'grantor', pg_catalog.pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
      'grantable', a.is_grantable) ORDER BY a.grantee, a.grantor)
   FROM pg_catalog.aclexplode(coalesce(proacl, pg_catalog.acldefault('f', proowner))) a) AS current_acl,
  (SELECT jsonb_agg(jsonb_build_object('role', rolname,
      'execute', pg_catalog.has_function_privilege(r.oid, routines.oid, 'EXECUTE')) ORDER BY rolname)
   FROM pg_catalog.pg_roles r WHERE rolname IN ('anon','authenticated','service_role','authenticator')
       OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS effective_access,
  (SELECT jsonb_agg(pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid))
   FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = routines.oid) AS references,
  (SELECT jsonb_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid))
   FROM pg_catalog.pg_depend d WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = routines.oid) AS dependents,
  (SELECT jsonb_agg(pg_catalog.pg_get_triggerdef(t.oid) ORDER BY t.oid)
   FROM pg_catalog.pg_trigger t WHERE t.tgfoid = routines.oid) AS triggers
FROM routines ORDER BY signature;
