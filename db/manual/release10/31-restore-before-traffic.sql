-- AM: Solo antes de trafico; conserva respaldo de SEGURIDAD-02 y metadatos del bootstrap.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL TimeZone='UTC';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.citas,public.citas_detalles,public.citas_grupos,public.clientes,public.membership_purchase_orders,public.payment_events,public.payment_intents,public.payment_providers,public.payments,public.points_cycles,public.points_rule_services,public.points_rules,public.points_transactions,public.subscription_consumptions,public.subscription_payments,public.subscriptions,public.tipos_puntos IN SHARE ROW EXCLUSIVE MODE;
DO $backup$ DECLARE n bigint:=0; BEGIN
 IF to_regclass('app_private.release10_cycle_bootstrap_backup') IS NOT NULL THEN
 EXECUTE 'SELECT CASE WHEN count(*)=1 AND bool_and(seal=md5(ledger_md5||cycles_before_md5||cycles_before::text||cycles_after::text)) THEN 0 ELSE 1 END FROM app_private.release10_cycle_bootstrap_backup' INTO n;
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid='app_private.release10_cycle_bootstrap_backup'::regclass
   AND (pg_get_userbyid(relowner)<>'postgres' OR NOT relrowsecurity))
   OR has_table_privilege('anon','app_private.release10_cycle_bootstrap_backup','SELECT,INSERT,UPDATE,DELETE')
   OR has_table_privilege('authenticated','app_private.release10_cycle_bootstrap_backup','SELECT,INSERT,UPDATE,DELETE')
   OR has_table_privilege('service_role','app_private.release10_cycle_bootstrap_backup','SELECT,INSERT,UPDATE,DELETE') THEN n:=n+1; END IF;
 END IF;
 PERFORM set_config('masterfade.release10_bootstrap_drift',n::text,true);
 END $backup$;
DO $release10$ DECLARE r record; BEGIN
 FOR r IN SELECT 'TARGET_FUNCTIONS_OR_TRIGGERS' code,CASE WHEN md5(pg_get_viewdef('public.vw_points_balance'::regclass,true))='4a9b6f5a236c559aced71862d60aa811'
 AND (SELECT pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres,mf_audit_readonly=r/postgres}'
 FROM pg_class WHERE oid='public.vw_points_balance'::regclass) AND to_regclass('app_private.release10_cycle_bootstrap_backup') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (VALUES
('app_private.points_appointment_paid_v1(uuid)','663537c379708916af32a983c04bd4cd','{postgres=X/postgres}'),
('app_private.points_award_paid_appointment_v1(uuid)','e8912101bcf8da89a498de48b530928e','{postgres=X/postgres}'),
('app_private.points_award_paid_event_v1()','6234460cf41408ba70f151d2613246af','{postgres=X/postgres}'),
('app_private.points_payment_valid_v1(uuid)','fd02d98719e13fef3b90356343f318c4','{postgres=X/postgres}'),
('public.fn_points_estado_final_cita()','7fb6bdfda4c090baa1cc35217fb793b7',''),
('public.fn_points_get_effective_rule(uuid)','66f5ab15eeca8e37248f9dcfcb47ad4f',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','8dc2c1af4e08b0a79fd1f60922219bba',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','8591cd5d75c788dad26d3f01da39916e',''),
('public.fn_points_materialize_expired_cycles(uuid)','baf12a0bd62353ae20131a7ff4a0e59f',''),
('public.fn_points_tx_apply_tipo_sign()','880bc208992a8e325add77fe7edf467f',''),
('public.fn_points_tx_guard_acumular_final()','c5b2927b50497f5047466f3829ffd4c3',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','30d6d740dc19182fa2ffb702257c3f50',''),
('public.fn_trg_otorgar_puntos_por_cita()','5505b1ae05412a8e42de790c5790282c','')
) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=13 AND NOT EXISTS (SELECT 1 FROM (VALUES
('citas','tr_points_cita_confirmada','CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita()'),
('citas','tr_points_paid_citas','CREATE CONSTRAINT TRIGGER tr_points_paid_citas AFTER INSERT OR UPDATE ON public.citas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payment_intents','tr_points_paid_payment_intents','CREATE CONSTRAINT TRIGGER tr_points_paid_payment_intents AFTER INSERT OR UPDATE ON public.payment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payments','tr_points_paid_payments','CREATE CONSTRAINT TRIGGER tr_points_paid_payments AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('points_transactions','tr_points_tx_apply_tipo_sign','CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign()'),
('points_transactions','tr_points_tx_guard_acumular_final','CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final()'),
('subscription_consumptions','tr_points_paid_subscription_consumptions','CREATE CONSTRAINT TRIGGER tr_points_paid_subscription_consumptions AFTER INSERT OR UPDATE ON public.subscription_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()')
) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR NOT (t.tgenabled='O' ) OR pg_get_triggerdef(t.oid)<>e.definition) THEN 0 ELSE 1 END::bigint affected UNION ALL SELECT 'SECURITY02_BACKUP_DRIFT' code,count(*)::bigint affected FROM (VALUES
('public.fn_points_estado_final_cita()','{"kind":"function","signature":"public.fn_points_estado_final_cita()","applied_at":"2026-11-15T14:55:32.153581+00:00","captured_at":"2026-11-15T14:55:32.152126+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"38b27cac561d41e078a3f53775e4a429","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_estado_final_cita()\n RETURNS text\n LANGUAGE plpgsql\n STABLE\nAS $function$\nDECLARE\n  v_estado text;\nBEGIN\n  SELECT ec.estado_cita_codigo\n  INTO v_estado\n  FROM public.estados_cita ec\n  WHERE lower(trim(ec.estado_cita_codigo)) IN (''completada'',''atendida'',''finalizada'')\n  ORDER BY\n    CASE lower(trim(ec.estado_cita_codigo))\n      WHEN ''completada'' THEN 1\n      WHEN ''atendida'' THEN 2\n      WHEN ''finalizada'' THEN 3\n      ELSE 99\n    END\n  LIMIT 1;\n\n  IF v_estado IS NULL THEN\n    v_estado := ''completada'';\n  END IF;\n\n  RETURN v_estado;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_get_effective_rule(uuid)','{"kind":"function","signature":"public.fn_points_get_effective_rule(uuid)","applied_at":"2026-11-15T14:55:32.155295+00:00","captured_at":"2026-11-15T14:55:32.153925+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"27b895e6f146655df078882c50a9911b","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_get_effective_rule(p_id_sucursal uuid)\n RETURNS TABLE(id_rule uuid, id_sucursal uuid, umbral_monto_hnl numeric, puntos_por_cita integer, puntos_para_premio integer, expiracion_meses integer, activo boolean)\n LANGUAGE sql\n STABLE\nAS $function$\n  SELECT\n    pr.id_rule,\n    pr.id_sucursal,\n    pr.umbral_monto_hnl,\n    pr.puntos_por_cita,\n    pr.puntos_para_premio,\n    pr.expiracion_meses,\n    pr.activo\n  FROM public.points_rules pr\n  WHERE pr.activo IS TRUE\n    AND (pr.id_sucursal = p_id_sucursal OR pr.id_sucursal IS NULL)\n  ORDER BY\n    CASE WHEN pr.id_sucursal = p_id_sucursal THEN 0 ELSE 1 END,\n    pr.updated_at DESC,\n    pr.created_at DESC,\n    pr.id_rule DESC\n  LIMIT 1\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_get_or_create_active_cycle(uuid, integer, timestamp with time zone)','{"kind":"function","signature":"public.fn_points_get_or_create_active_cycle(uuid, integer, timestamp with time zone)","applied_at":"2026-11-15T14:55:32.156014+00:00","captured_at":"2026-11-15T14:55:32.155634+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"a38d0b9a382ab61dc7468198b6d45229","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamp with time zone DEFAULT now())\n RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_anchor timestamptz;\n  v_inserted public.points_cycles%ROWTYPE;\nBEGIN\n  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);\n\n  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at\n  INTO id_cycle, primer_acumulado_at, vence_at\n  FROM public.points_cycles pc\n  WHERE pc.id_cliente = p_id_cliente\n    AND pc.estado_ciclo_codigo = ''activo''\n    AND pc.vence_at > now()\n  ORDER BY pc.primer_acumulado_at ASC\n  LIMIT 1;\n\n  IF id_cycle IS NOT NULL THEN\n    RETURN NEXT;\n    RETURN;\n  END IF;\n\n  v_anchor := COALESCE(p_anchor_at, now());\n\n  BEGIN\n    INSERT INTO public.points_cycles (\n      id_cliente,\n      primer_acumulado_at,\n      vence_at,\n      estado_ciclo_codigo\n    )\n    VALUES (\n      p_id_cliente,\n      v_anchor,\n      v_anchor + make_interval(months => GREATEST(p_expiracion_meses, 1)),\n      ''activo''\n    )\n    RETURNING * INTO v_inserted;\n  EXCEPTION WHEN unique_violation THEN\n    SELECT *\n    INTO v_inserted\n    FROM public.points_cycles\n    WHERE id_cliente = p_id_cliente\n      AND estado_ciclo_codigo = ''activo''\n    ORDER BY primer_acumulado_at ASC\n    LIMIT 1;\n  END;\n\n  id_cycle := v_inserted.id_cycle;\n  primer_acumulado_at := v_inserted.primer_acumulado_at;\n  vence_at := v_inserted.vence_at;\n  RETURN NEXT;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_get_or_create_active_cycle(uuid, timestamp with time zone)','{"kind":"function","signature":"public.fn_points_get_or_create_active_cycle(uuid, timestamp with time zone)","applied_at":"2026-11-15T14:55:32.156744+00:00","captured_at":"2026-11-15T14:55:32.15633+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"6be79dd3b72e1d7a05016a613bf4a53d","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_anchor_at timestamp with time zone DEFAULT now())\n RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_inserted public.points_cycles%ROWTYPE;\nBEGIN\n  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at\n  INTO id_cycle, primer_acumulado_at, vence_at\n  FROM public.points_cycles pc\n  WHERE pc.id_cliente = p_id_cliente\n    AND pc.estado_ciclo_codigo = ''activo''\n    AND (pc.vence_at IS NULL OR pc.vence_at > now())\n  ORDER BY pc.primer_acumulado_at DESC NULLS LAST\n  LIMIT 1;\n\n  IF id_cycle IS NOT NULL THEN\n    RETURN NEXT;\n    RETURN;\n  END IF;\n\n  INSERT INTO public.points_cycles (\n    id_cliente,\n    primer_acumulado_at,\n    vence_at,\n    estado_ciclo_codigo\n  )\n  VALUES (\n    p_id_cliente,\n    COALESCE(p_anchor_at, now()),\n    NULL,\n    ''activo''\n  )\n  RETURNING * INTO v_inserted;\n\n  id_cycle := v_inserted.id_cycle;\n  primer_acumulado_at := v_inserted.primer_acumulado_at;\n  vence_at := v_inserted.vence_at;\n\n  RETURN NEXT;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_materialize_expired_cycles(uuid)','{"kind":"function","signature":"public.fn_points_materialize_expired_cycles(uuid)","applied_at":"2026-11-15T14:55:32.157916+00:00","captured_at":"2026-11-15T14:55:32.157051+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"1fc9e808d8d6d56570897b5c84480144","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(p_id_cliente uuid DEFAULT NULL::uuid)\n RETURNS integer\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_cycle record;\n  v_balance integer;\n  v_total integer := 0;\nBEGIN\n  FOR v_cycle IN\n    SELECT\n      pc.id_cycle,\n      pc.id_cliente,\n      pc.vence_at\n    FROM public.points_cycles pc\n    WHERE pc.estado_ciclo_codigo = ''activo''\n      AND pc.vence_at <= now()\n      AND (p_id_cliente IS NULL OR pc.id_cliente = p_id_cliente)\n    ORDER BY pc.id_cycle\n    FOR UPDATE OF pc\n  LOOP\n    SELECT COALESCE(SUM(pt.puntos), 0)::integer\n      INTO v_balance\n    FROM public.points_transactions pt\n    WHERE pt.id_cycle = v_cycle.id_cycle;\n\n    IF v_balance > 0 THEN\n      INSERT INTO public.points_transactions (\n        id_cliente,\n        id_cycle,\n        tipo_puntos_codigo,\n        puntos,\n        vence_at,\n        motivo,\n        created_at,\n        updated_at\n      )\n      VALUES (\n        v_cycle.id_cliente,\n        v_cycle.id_cycle,\n        ''vencimiento'',\n        v_balance,\n        v_cycle.vence_at,\n        ''Vencimiento automatico del ciclo'',\n        now(),\n        now()\n      )\n      ON CONFLICT (id_cycle, tipo_puntos_codigo)\n        WHERE id_cycle IS NOT NULL\n          AND tipo_puntos_codigo = ''vencimiento''\n      DO NOTHING;\n    END IF;\n\n    UPDATE public.points_cycles\n    SET estado_ciclo_codigo = ''expirado'',\n        updated_at = now()\n    WHERE id_cycle = v_cycle.id_cycle\n      AND estado_ciclo_codigo = ''activo'';\n\n    IF FOUND THEN\n      v_total := v_total + 1;\n    END IF;\n  END LOOP;\n\n  RETURN v_total;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_tx_apply_tipo_sign()','{"kind":"function","signature":"public.fn_points_tx_apply_tipo_sign()","applied_at":"2026-11-15T14:55:32.158539+00:00","captured_at":"2026-11-15T14:55:32.158265+00:00","dependencies":{"triggers":["CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_points_tx_apply_tipo_sign()"],"dependents":["trigger tr_points_tx_apply_tipo_sign on table public.points_transactions"],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"d9e9c315c1cfb417de0945ccc1b91e07","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_tx_apply_tipo_sign()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_signo integer;\nBEGIN\n  IF NEW.puntos = 0 THEN\n    RAISE EXCEPTION ''points_transactions.puntos no puede ser 0'';\n  END IF;\n\n  SELECT tp.signo\n  INTO v_signo\n  FROM public.tipos_puntos tp\n  WHERE tp.tipo_puntos_codigo = NEW.tipo_puntos_codigo\n  LIMIT 1;\n\n  IF v_signo = 1 THEN\n    NEW.puntos := abs(NEW.puntos);\n  ELSIF v_signo = -1 THEN\n    NEW.puntos := -abs(NEW.puntos);\n  END IF;\n\n  RETURN NEW;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_points_tx_guard_acumular_final()','{"kind":"function","signature":"public.fn_points_tx_guard_acumular_final()","applied_at":"2026-11-15T14:55:32.159183+00:00","captured_at":"2026-11-15T14:55:32.158943+00:00","dependencies":{"triggers":["CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_points_tx_guard_acumular_final()"],"dependents":["trigger tr_points_tx_guard_acumular_final on table public.points_transactions"],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"25e47807f162b12b9de8c87e15a8248c","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_estado_final text;\n  v_estado_cita text;\n  v_orden integer;\n  v_es_canje boolean;\n  v_origen text;\nBEGIN\n  IF NEW.tipo_puntos_codigo <> ''acumular'' OR NEW.id_cita IS NULL THEN\n    RETURN NEW;\n  END IF;\n\n  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;\n\n  SELECT\n    c.estado_cita_codigo,\n    COALESCE(c.orden_integrante, 1),\n    COALESCE(c.es_canje_recompensa, false)\n  INTO v_estado_cita, v_orden, v_es_canje\n  FROM public.citas c\n  WHERE c.id_cita = NEW.id_cita\n    AND c.deleted_at IS NULL\n  LIMIT 1;\n\n  IF NOT FOUND THEN\n    RETURN NEW;\n  END IF;\n\n  IF v_estado_cita IS DISTINCT FROM v_estado_final THEN\n    RETURN NULL;\n  END IF;\n\n  v_origen := COALESCE(\n    NULLIF(trim(NEW.origen_punto_codigo), ''''),\n    CASE WHEN v_orden > 1 THEN ''integrante'' ELSE ''titular'' END\n  );\n\n  NEW.origen_punto_codigo := v_origen;\n\n  IF v_es_canje IS TRUE AND v_origen = ''titular'' THEN\n    RETURN NULL;\n  END IF;\n\n  RETURN NEW;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_trg_otorgar_puntos_plan_confirmada()','{"kind":"function","signature":"public.fn_trg_otorgar_puntos_plan_confirmada()","applied_at":"2026-11-15T14:55:32.164994+00:00","captured_at":"2026-11-15T14:55:32.164674+00:00","dependencies":{"triggers":[],"dependents":[],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"d28d6871c43022fd0950f4ec9f973972","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RETURN NEW;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}'),
('public.fn_trg_otorgar_puntos_por_cita()','{"kind":"function","signature":"public.fn_trg_otorgar_puntos_por_cita()","applied_at":"2026-11-15T14:55:32.165695+00:00","captured_at":"2026-11-15T14:55:32.165353+00:00","dependencies":{"triggers":["CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION public.fn_trg_otorgar_puntos_por_cita()"],"dependents":["trigger tr_points_cita_confirmada on table public.citas"],"references":["schema public","language plpgsql"]},"original_acl":null,"path_changed":true,"applied_config":["search_path=pg_catalog, public, pg_temp"],"original_owner":"postgres","rolled_back_at":null,"original_config":null,"original_body_hash":"b271a74a0fd9440113f62c331e8a7ea8","applied_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_definition":"CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  v_estado_final text;\n  v_origen text;\n  v_puntos_por_cita integer := 1;\n  v_cycle record;\n  v_cliente_usuario uuid;\nBEGIN\n  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;\n\n  IF TG_OP = ''INSERT'' THEN\n    IF NEW.estado_cita_codigo IS DISTINCT FROM v_estado_final THEN\n      RETURN NEW;\n    END IF;\n  ELSIF TG_OP = ''UPDATE'' THEN\n    IF NOT (\n      OLD.estado_cita_codigo IS DISTINCT FROM NEW.estado_cita_codigo\n      AND NEW.estado_cita_codigo = v_estado_final\n    ) THEN\n      RETURN NEW;\n    END IF;\n  ELSE\n    RETURN NEW;\n  END IF;\n\n  IF NEW.id_cliente IS NULL THEN\n    RETURN NEW;\n  END IF;\n\n  v_origen := CASE\n    WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN ''integrante''\n    ELSE ''titular''\n  END;\n\n  IF COALESCE(NEW.es_canje_recompensa, false) IS TRUE AND v_origen = ''titular'' THEN\n    RETURN NEW;\n  END IF;\n\n  SELECT COALESCE(pr.puntos_por_cita, 1)\n  INTO v_puntos_por_cita\n  FROM public.points_rules pr\n  WHERE pr.activo IS TRUE\n    AND (pr.id_sucursal = NEW.id_sucursal OR pr.id_sucursal IS NULL)\n  ORDER BY\n    CASE WHEN pr.id_sucursal = NEW.id_sucursal THEN 0 ELSE 1 END,\n    pr.updated_at DESC NULLS LAST,\n    pr.created_at DESC NULLS LAST\n  LIMIT 1;\n\n  SELECT *\n  INTO v_cycle\n  FROM public.fn_points_get_or_create_active_cycle(\n    NEW.id_cliente,\n    COALESCE(NEW.inicio_at, now())\n  )\n  LIMIT 1;\n\n  SELECT c.id_usuario\n  INTO v_cliente_usuario\n  FROM public.clientes c\n  WHERE c.id_cliente = NEW.id_cliente\n    AND c.deleted_at IS NULL\n  LIMIT 1;\n\n  INSERT INTO public.points_transactions (\n    id_cliente,\n    id_cita,\n    id_cycle,\n    id_sucursal_origen,\n    tipo_puntos_codigo,\n    origen_punto_codigo,\n    puntos,\n    vence_at,\n    motivo,\n    creado_por_usuario_id,\n    created_at,\n    updated_at\n  )\n  VALUES (\n    NEW.id_cliente,\n    NEW.id_cita,\n    v_cycle.id_cycle,\n    NEW.id_sucursal,\n    ''acumular'',\n    v_origen,\n    GREATEST(1, COALESCE(v_puntos_por_cita, 1)),\n    v_cycle.vence_at,\n    CASE WHEN v_origen = ''integrante''\n      THEN ''Punto por acompañante en visita completada''\n      ELSE ''Punto por visita completada del titular''\n    END,\n    COALESCE(NEW.creada_por_usuario_id, v_cliente_usuario),\n    now(),\n    now()\n  )\n  ON CONFLICT DO NOTHING;\n\n  RETURN NEW;\nEND;\n$function$\n","original_execute_acl":[{"grantee":"PUBLIC","grantor":"postgres","grantable":false},{"grantee":"postgres","grantor":"postgres","grantable":false}],"original_security_definer":false}')
) e(signature,metadata)
 LEFT JOIN app_private.security02_routine_backup b USING(signature)
 WHERE b.signature IS NULL OR b.routine_oid<>to_regprocedure(e.signature)::oid OR to_jsonb(b)-'routine_oid'<>e.metadata::jsonb UNION ALL SELECT 'CYCLE_BOOTSTRAP_BACKUP_DRIFT' code,current_setting('masterfade.release10_bootstrap_drift')::bigint affected LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;

DO $gate$ DECLARE b app_private.release10_cycle_bootstrap_backup%ROWTYPE; current_cycles jsonb; BEGIN
 SELECT * INTO STRICT b FROM app_private.release10_cycle_bootstrap_backup WHERE singleton;
 SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id_cycle),'[]') INTO current_cycles FROM public.points_cycles t;
 IF COALESCE(current_setting('masterfade.release10_expected_ledger',true),'')<>(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)
 OR b.ledger_md5<>(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t) OR b.cycles_after<>current_cycles
 OR COALESCE(current_setting('masterfade.release10_expected_cycles',true),'')<>b.cycles_before_md5
 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_RESTORE_REQUIRES_UNCHANGED_BASELINE'; END IF;
END $gate$;
SELECT set_config('masterfade.release10_ledger',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t),true),set_config('masterfade.release10_cycles',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t),true);
DROP TRIGGER tr_points_paid_citas ON public.citas;
DROP TRIGGER tr_points_paid_payment_intents ON public.payment_intents;
DROP TRIGGER tr_points_paid_payments ON public.payments;
DROP TRIGGER tr_points_paid_subscription_consumptions ON public.subscription_consumptions;
CREATE OR REPLACE FUNCTION public.fn_points_estado_final_cita()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_estado text;
BEGIN
  SELECT ec.estado_cita_codigo
  INTO v_estado
  FROM public.estados_cita ec
  WHERE lower(trim(ec.estado_cita_codigo)) IN ('completada','atendida','finalizada')
  ORDER BY
    CASE lower(trim(ec.estado_cita_codigo))
      WHEN 'completada' THEN 1
      WHEN 'atendida' THEN 2
      WHEN 'finalizada' THEN 3
      ELSE 99
    END
  LIMIT 1;

  IF v_estado IS NULL THEN
    v_estado := 'completada';
  END IF;

  RETURN v_estado;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_get_effective_rule(p_id_sucursal uuid)
 RETURNS TABLE(id_rule uuid, id_sucursal uuid, umbral_monto_hnl numeric, puntos_por_cita integer, puntos_para_premio integer, expiracion_meses integer, activo boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT
    pr.id_rule,
    pr.id_sucursal,
    pr.umbral_monto_hnl,
    pr.puntos_por_cita,
    pr.puntos_para_premio,
    pr.expiracion_meses,
    pr.activo
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = p_id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = p_id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC,
    pr.created_at DESC,
    pr.id_rule DESC
  LIMIT 1
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_anchor timestamptz;
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);

  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND pc.vence_at > now()
  ORDER BY pc.primer_acumulado_at ASC
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_anchor := COALESCE(p_anchor_at, now());

  BEGIN
    INSERT INTO public.points_cycles (
      id_cliente,
      primer_acumulado_at,
      vence_at,
      estado_ciclo_codigo
    )
    VALUES (
      p_id_cliente,
      v_anchor,
      v_anchor + make_interval(months => GREATEST(p_expiracion_meses, 1)),
      'activo'
    )
    RETURNING * INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    SELECT *
    INTO v_inserted
    FROM public.points_cycles
    WHERE id_cliente = p_id_cliente
      AND estado_ciclo_codigo = 'activo'
    ORDER BY primer_acumulado_at ASC
    LIMIT 1;
  END;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;
  RETURN NEXT;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_anchor_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND (pc.vence_at IS NULL OR pc.vence_at > now())
  ORDER BY pc.primer_acumulado_at DESC NULLS LAST
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.points_cycles (
    id_cliente,
    primer_acumulado_at,
    vence_at,
    estado_ciclo_codigo
  )
  VALUES (
    p_id_cliente,
    COALESCE(p_anchor_at, now()),
    NULL,
    'activo'
  )
  RETURNING * INTO v_inserted;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;

  RETURN NEXT;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(p_id_cliente uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_cycle record;
  v_balance integer;
  v_total integer := 0;
BEGIN
  FOR v_cycle IN
    SELECT
      pc.id_cycle,
      pc.id_cliente,
      pc.vence_at
    FROM public.points_cycles pc
    WHERE pc.estado_ciclo_codigo = 'activo'
      AND pc.vence_at <= now()
      AND (p_id_cliente IS NULL OR pc.id_cliente = p_id_cliente)
    ORDER BY pc.id_cycle
    FOR UPDATE OF pc
  LOOP
    SELECT COALESCE(SUM(pt.puntos), 0)::integer
      INTO v_balance
    FROM public.points_transactions pt
    WHERE pt.id_cycle = v_cycle.id_cycle;

    IF v_balance > 0 THEN
      INSERT INTO public.points_transactions (
        id_cliente,
        id_cycle,
        tipo_puntos_codigo,
        puntos,
        vence_at,
        motivo,
        created_at,
        updated_at
      )
      VALUES (
        v_cycle.id_cliente,
        v_cycle.id_cycle,
        'vencimiento',
        v_balance,
        v_cycle.vence_at,
        'Vencimiento automatico del ciclo',
        now(),
        now()
      )
      ON CONFLICT (id_cycle, tipo_puntos_codigo)
        WHERE id_cycle IS NOT NULL
          AND tipo_puntos_codigo = 'vencimiento'
      DO NOTHING;
    END IF;

    UPDATE public.points_cycles
    SET estado_ciclo_codigo = 'expirado',
        updated_at = now()
    WHERE id_cycle = v_cycle.id_cycle
      AND estado_ciclo_codigo = 'activo';

    IF FOUND THEN
      v_total := v_total + 1;
    END IF;
  END LOOP;

  RETURN v_total;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_tx_apply_tipo_sign()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_signo integer;
BEGIN
  IF NEW.puntos = 0 THEN
    RAISE EXCEPTION 'points_transactions.puntos no puede ser 0';
  END IF;

  SELECT tp.signo
  INTO v_signo
  FROM public.tipos_puntos tp
  WHERE tp.tipo_puntos_codigo = NEW.tipo_puntos_codigo
  LIMIT 1;

  IF v_signo = 1 THEN
    NEW.puntos := abs(NEW.puntos);
  ELSIF v_signo = -1 THEN
    NEW.puntos := -abs(NEW.puntos);
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_estado_final text;
  v_estado_cita text;
  v_orden integer;
  v_es_canje boolean;
  v_origen text;
BEGIN
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  SELECT
    c.estado_cita_codigo,
    COALESCE(c.orden_integrante, 1),
    COALESCE(c.es_canje_recompensa, false)
  INTO v_estado_cita, v_orden, v_es_canje
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita
    AND c.deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_estado_cita IS DISTINCT FROM v_estado_final THEN
    RETURN NULL;
  END IF;

  v_origen := COALESCE(
    NULLIF(trim(NEW.origen_punto_codigo), ''),
    CASE WHEN v_orden > 1 THEN 'integrante' ELSE 'titular' END
  );

  NEW.origen_punto_codigo := v_origen;

  IF v_es_canje IS TRUE AND v_origen = 'titular' THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_estado_final text;
  v_origen text;
  v_puntos_por_cita integer := 1;
  v_cycle record;
  v_cliente_usuario uuid;
BEGIN
  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado_cita_codigo IS DISTINCT FROM v_estado_final THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.estado_cita_codigo IS DISTINCT FROM NEW.estado_cita_codigo
      AND NEW.estado_cita_codigo = v_estado_final
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.id_cliente IS NULL THEN
    RETURN NEW;
  END IF;

  v_origen := CASE
    WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante'
    ELSE 'titular'
  END;

  IF COALESCE(NEW.es_canje_recompensa, false) IS TRUE AND v_origen = 'titular' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(pr.puntos_por_cita, 1)
  INTO v_puntos_por_cita
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = NEW.id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = NEW.id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC NULLS LAST,
    pr.created_at DESC NULLS LAST
  LIMIT 1;

  SELECT *
  INTO v_cycle
  FROM public.fn_points_get_or_create_active_cycle(
    NEW.id_cliente,
    COALESCE(NEW.inicio_at, now())
  )
  LIMIT 1;

  SELECT c.id_usuario
  INTO v_cliente_usuario
  FROM public.clientes c
  WHERE c.id_cliente = NEW.id_cliente
    AND c.deleted_at IS NULL
  LIMIT 1;

  INSERT INTO public.points_transactions (
    id_cliente,
    id_cita,
    id_cycle,
    id_sucursal_origen,
    tipo_puntos_codigo,
    origen_punto_codigo,
    puntos,
    vence_at,
    motivo,
    creado_por_usuario_id,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id_cliente,
    NEW.id_cita,
    v_cycle.id_cycle,
    NEW.id_sucursal,
    'acumular',
    v_origen,
    GREATEST(1, COALESCE(v_puntos_por_cita, 1)),
    v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante'
      THEN 'Punto por acompañante en visita completada'
      ELSE 'Punto por visita completada del titular'
    END,
    COALESCE(NEW.creada_por_usuario_id, v_cliente_usuario),
    now(),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE VIEW public.vw_points_balance AS  WITH ledger_balance AS (
         SELECT pt.id_cliente,
            COALESCE(sum(pt.puntos), 0::bigint) AS ledger_points
           FROM points_transactions pt
          GROUP BY pt.id_cliente
        ), pending_expired_cycles AS (
         SELECT pc.id_cliente,
            pc.id_cycle,
            COALESCE(sum(pt.puntos), 0::bigint) AS remaining_points
           FROM points_cycles pc
             JOIN points_transactions pt ON pt.id_cycle = pc.id_cycle
          WHERE pc.estado_ciclo_codigo = 'activo'::text AND pc.vence_at IS NOT NULL AND pc.vence_at <= now()
          GROUP BY pc.id_cliente, pc.id_cycle
        ), pending_expiration_by_client AS (
         SELECT pec.id_cliente,
            COALESCE(sum(
                CASE
                    WHEN pec.remaining_points > 0 THEN pec.remaining_points
                    ELSE 0::bigint
                END), 0::bigint::numeric) AS pending_expired_points
           FROM pending_expired_cycles pec
          GROUP BY pec.id_cliente
        )
 SELECT lb.id_cliente,
    (lb.ledger_points::numeric - COALESCE(pe.pending_expired_points, 0::bigint::numeric))::integer AS balance_puntos
   FROM ledger_balance lb
     LEFT JOIN pending_expiration_by_client pe ON pe.id_cliente = lb.id_cliente;;
CREATE OR REPLACE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();
CREATE OR REPLACE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();
CREATE OR REPLACE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
DROP FUNCTION app_private.points_payment_valid_v1(uuid);
DROP FUNCTION app_private.points_award_paid_event_v1();
DROP FUNCTION app_private.points_award_paid_appointment_v1(uuid);
DROP FUNCTION app_private.points_appointment_paid_v1(uuid);
DELETE FROM public.points_cycles pc USING app_private.release10_cycle_bootstrap_backup b
 WHERE b.singleton AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(b.cycles_before) r(id_cycle uuid) WHERE r.id_cycle=pc.id_cycle);
DO $release10$ DECLARE r record; BEGIN
 FOR r IN SELECT 'RESTORE_CATALOG' code,CASE WHEN md5(pg_get_viewdef('public.vw_points_balance'::regclass,true))='c22458ae2d5fcf4d2314480cd9e60135'
 AND (SELECT pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres,mf_audit_readonly=r/postgres}'
 FROM pg_class WHERE oid='public.vw_points_balance'::regclass) AND NOT EXISTS (SELECT 1 FROM (VALUES
('public.fn_points_estado_final_cita()','7fb6bdfda4c090baa1cc35217fb793b7',''),
('public.fn_points_get_effective_rule(uuid)','66f5ab15eeca8e37248f9dcfcb47ad4f',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','096a07d6008590b34b67c32dbd205ac2',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','633ca848e4ae1d6ddc0d73bf1fd7bc9a',''),
('public.fn_points_materialize_expired_cycles(uuid)','64f4a8091790eeeaf5887fb505edaf61',''),
('public.fn_points_tx_apply_tipo_sign()','880bc208992a8e325add77fe7edf467f',''),
('public.fn_points_tx_guard_acumular_final()','fc98e9387a7803d6b618eb546f62c5b8',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','71d5acc52c281c1784bca80f508b5472',''),
('public.fn_trg_otorgar_puntos_por_cita()','6f6244c6e42631187ad985b9d1b93809','')
) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=9 AND NOT EXISTS (SELECT 1 FROM (VALUES
('citas','tr_points_cita_confirmada','CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita()'),
('points_transactions','tr_points_tx_apply_tipo_sign','CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign()'),
('points_transactions','tr_points_tx_guard_acumular_final','CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final()')
) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR NOT (t.tgenabled='O' ) OR pg_get_triggerdef(t.oid)<>e.definition)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal) THEN 0 ELSE 1 END::bigint affected LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;

DO $preserve$ BEGIN IF (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)<>current_setting('masterfade.release10_ledger')
 OR (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)<>current_setting('masterfade.release10_expected_cycles') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $preserve$;
COMMIT;
