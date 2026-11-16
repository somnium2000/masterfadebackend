-- AM: MANUAL, requiere autorizacion y ventana sin escritores. DDL atomico, sin backfill de puntos; metadatos de ciclos autorizados.
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
 FOR r IN SELECT * FROM (SELECT 'CATALOG_DRIFT' code, CASE WHEN (md5(pg_get_viewdef('public.vw_points_balance'::regclass,true))='c22458ae2d5fcf4d2314480cd9e60135'
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
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal)) OR (md5(pg_get_viewdef('public.vw_points_balance'::regclass,true))='4a9b6f5a236c559aced71862d60aa811'
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
 WHERE t.oid IS NULL OR NOT (t.tgenabled='O' ) OR pg_get_triggerdef(t.oid)<>e.definition)) THEN 0 ELSE 1 END::bigint affected
 UNION ALL SELECT 'REQUIRED_COLUMNS',count(*) FROM (VALUES
('citas','id_cita','uuid'),
('citas','id_sucursal','uuid'),
('citas','id_empleado_barbero','uuid'),
('citas','id_persona_cliente','uuid'),
('citas','id_cliente','uuid'),
('citas','creada_por_usuario_id','uuid'),
('citas','asignada_automaticamente','bool'),
('citas','estado_cita_codigo','text'),
('citas','inicio_at','timestamptz'),
('citas','fin_at','timestamptz'),
('citas','duracion_total_min','int4'),
('citas','buffer_total_min','int4'),
('citas','subtotal_servicios_hnl','numeric'),
('citas','descuento_hnl','numeric'),
('citas','total_pagar_hnl','numeric'),
('citas','moneda_codigo','text'),
('citas','notas','text'),
('citas','llegada_real_at','timestamptz'),
('citas','no_show_at','timestamptz'),
('citas','created_at','timestamptz'),
('citas','updated_at','timestamptz'),
('citas','deleted_at','timestamptz'),
('citas','id_grupo_cita','uuid'),
('citas','orden_integrante','int4'),
('citas','alias_integrante','text'),
('citas','contacto_nombre','text'),
('citas','contacto_email','text'),
('citas','contacto_telefono','text'),
('citas','selection_type','text'),
('citas','id_paquete','uuid'),
('citas','atencion_iniciada_at','timestamptz'),
('citas','atencion_finalizada_at','timestamptz'),
('citas','retraso_inicio_min','int4'),
('citas','es_canje_recompensa','bool'),
('citas','id_cita_integrante','uuid'),
('citas_detalles','id_cita_detalle','uuid'),
('citas_detalles','id_cita','uuid'),
('citas_detalles','id_servicio','uuid'),
('citas_detalles','cantidad','int4'),
('citas_detalles','duracion_min','int4'),
('citas_detalles','buffer_min','int4'),
('citas_detalles','precio_unitario_hnl','numeric'),
('citas_detalles','subtotal_hnl','numeric'),
('citas_detalles','created_at','timestamptz'),
('citas_detalles','updated_at','timestamptz'),
('citas_detalles','id_cita_paquete','uuid'),
('citas_detalles','origen_item_codigo','text'),
('citas_detalles','nombre_servicio_snapshot','text'),
('citas_detalles','precio_referencia_hnl','numeric'),
('citas_detalles','descuento_hnl','numeric'),
('citas_detalles','isv_porcentaje','numeric'),
('citas_detalles','isv_hnl','numeric'),
('citas_detalles','total_linea_hnl','numeric'),
('citas_detalles','id_tarifa','uuid'),
('citas_detalles','incluye_isv_snapshot','bool'),
('citas_detalles','line_key','text'),
('citas_detalles','orden_linea','int4'),
('citas_grupos','id_grupo_cita','uuid'),
('citas_grupos','id_sucursal','uuid'),
('citas_grupos','id_persona_titular','uuid'),
('citas_grupos','id_cliente_titular','uuid'),
('citas_grupos','estado_grupo_codigo','text'),
('citas_grupos','notas','text'),
('citas_grupos','created_at','timestamptz'),
('citas_grupos','updated_at','timestamptz'),
('citas_grupos','codigo_reserva','text'),
('citas_grupos','id_usuario_titular','uuid'),
('citas_grupos','origen_codigo','text'),
('citas_grupos','total_hnl','numeric'),
('citas_grupos','release_token','text'),
('citas_grupos','release_token_hash','text'),
('citas_grupos','release_token_created_at','timestamptz'),
('clientes','id_cliente','uuid'),
('clientes','id_persona','uuid'),
('clientes','id_usuario','uuid'),
('clientes','fecha_ingreso','date'),
('clientes','estado','bool'),
('clientes','consentimiento_marketing','bool'),
('clientes','acepta_terminos','bool'),
('clientes','preferencias','jsonb'),
('clientes','anonimizado','bool'),
('clientes','created_at','timestamptz'),
('clientes','updated_at','timestamptz'),
('clientes','deleted_at','timestamptz'),
('clientes','id_sucursal_origen','uuid'),
('clientes','acepta_terminos_at','timestamptz'),
('clientes','consentimiento_marketing_at','timestamptz'),
('membership_purchase_orders','id_order','uuid'),
('membership_purchase_orders','id_cliente','uuid'),
('membership_purchase_orders','id_usuario','uuid'),
('membership_purchase_orders','id_plan','uuid'),
('membership_purchase_orders','id_plan_sucursal','uuid'),
('membership_purchase_orders','id_sucursal','uuid'),
('membership_purchase_orders','id_suscripcion','uuid'),
('membership_purchase_orders','estado_orden_codigo','text'),
('membership_purchase_orders','moneda_codigo','text'),
('membership_purchase_orders','subtotal_hnl','numeric'),
('membership_purchase_orders','descuento_hnl','numeric'),
('membership_purchase_orders','total_hnl','numeric'),
('membership_purchase_orders','plan_snapshot','jsonb'),
('membership_purchase_orders','cliente_snapshot','jsonb'),
('membership_purchase_orders','factura_snapshot','jsonb'),
('membership_purchase_orders','email_factura','text'),
('membership_purchase_orders','notas','text'),
('membership_purchase_orders','expires_at','timestamptz'),
('membership_purchase_orders','paid_at','timestamptz'),
('membership_purchase_orders','cancelled_at','timestamptz'),
('membership_purchase_orders','created_by_usuario_id','uuid'),
('membership_purchase_orders','created_at','timestamptz'),
('membership_purchase_orders','updated_at','timestamptz'),
('membership_purchase_orders','idempotency_key','text'),
('payment_events','id_event','uuid'),
('payment_events','id_provider','uuid'),
('payment_events','provider_event_id','text'),
('payment_events','evento_tipo','text'),
('payment_events','firma_valida','bool'),
('payment_events','id_intent','uuid'),
('payment_events','id_payment','uuid'),
('payment_events','payload_esencial','jsonb'),
('payment_events','recibido_at','timestamptz'),
('payment_events','procesado_at','timestamptz'),
('payment_events','resultado_procesamiento','text'),
('payment_intents','id_intent','uuid'),
('payment_intents','id_provider','uuid'),
('payment_intents','id_cita','uuid'),
('payment_intents','id_hold','uuid'),
('payment_intents','estado_intent_codigo','text'),
('payment_intents','monto_hnl','numeric'),
('payment_intents','moneda_codigo','text'),
('payment_intents','link_pago_url','text'),
('payment_intents','referencia_externa','text'),
('payment_intents','idempotency_key','text'),
('payment_intents','expires_at','timestamptz'),
('payment_intents','created_by_usuario_id','uuid'),
('payment_intents','created_at','timestamptz'),
('payment_intents','updated_at','timestamptz'),
('payment_intents','id_membership_order','uuid'),
('payment_intents','origen_pago_codigo','text'),
('payment_intents','id_grupo_cita','uuid'),
('payment_intents','paid_at','timestamptz'),
('payment_intents','orden_compra','text'),
('payment_intents','provider_session_id','text'),
('payment_intents','launch_expires_at','timestamptz'),
('payment_intents','last_verified_at','timestamptz'),
('payment_intents','verification_attempts','int4'),
('payment_providers','id_provider','uuid'),
('payment_providers','codigo','text'),
('payment_providers','nombre','text'),
('payment_providers','activo','bool'),
('payment_providers','configuracion_publica','jsonb'),
('payment_providers','created_at','timestamptz'),
('payment_providers','updated_at','timestamptz'),
('payments','id_payment','uuid'),
('payments','id_intent','uuid'),
('payments','estado_pago_codigo','text'),
('payments','provider_tx_id','text'),
('payments','monto_hnl','numeric'),
('payments','moneda_codigo','text'),
('payments','paid_at','timestamptz'),
('payments','pago_tardio','bool'),
('payments','registrado_manualmente','bool'),
('payments','registrado_por_usuario_id','uuid'),
('payments','created_at','timestamptz'),
('payments','updated_at','timestamptz'),
('points_cycles','id_cycle','uuid'),
('points_cycles','id_cliente','uuid'),
('points_cycles','primer_acumulado_at','timestamptz'),
('points_cycles','vence_at','timestamptz'),
('points_cycles','estado_ciclo_codigo','text'),
('points_cycles','created_at','timestamptz'),
('points_cycles','updated_at','timestamptz'),
('points_legacy_migrations','id_migracion','uuid'),
('points_legacy_migrations','id_cliente','uuid'),
('points_legacy_migrations','id_points_tx','uuid'),
('points_legacy_migrations','puntos_migrados','int4'),
('points_legacy_migrations','motivo','text'),
('points_legacy_migrations','creado_por_usuario_id','uuid'),
('points_legacy_migrations','created_at','timestamptz'),
('points_legacy_migrations','updated_at','timestamptz'),
('points_rule_services','id_rule_service','uuid'),
('points_rule_services','id_rule','uuid'),
('points_rule_services','id_servicio','uuid'),
('points_rule_services','created_at','timestamptz'),
('points_rule_services','cliente_condicion_codigo','text'),
('points_rule_services','puntos_canje','int4'),
('points_rule_services','habilitado','bool'),
('points_rule_services','visible_cliente','bool'),
('points_rule_services','orden_visual','int4'),
('points_rule_services','updated_at','timestamptz'),
('points_rules','id_rule','uuid'),
('points_rules','id_sucursal','uuid'),
('points_rules','umbral_monto_hnl','numeric'),
('points_rules','puntos_por_cita','int4'),
('points_rules','puntos_para_premio','int4'),
('points_rules','expiracion_meses','int4'),
('points_rules','servicios_redimibles','_text'),
('points_rules','activo','bool'),
('points_rules','created_at','timestamptz'),
('points_rules','updated_at','timestamptz'),
('points_transactions','id_points_tx','uuid'),
('points_transactions','id_cliente','uuid'),
('points_transactions','id_cita','uuid'),
('points_transactions','tipo_puntos_codigo','text'),
('points_transactions','puntos','int4'),
('points_transactions','vence_at','timestamptz'),
('points_transactions','motivo','text'),
('points_transactions','creado_por_usuario_id','uuid'),
('points_transactions','created_at','timestamptz'),
('points_transactions','updated_at','timestamptz'),
('points_transactions','id_cycle','uuid'),
('points_transactions','id_sucursal_origen','uuid'),
('points_transactions','id_servicio_canje','uuid'),
('points_transactions','origen_punto_codigo','text'),
('subscription_consumptions','id_consumo','uuid'),
('subscription_consumptions','id_suscripcion','uuid'),
('subscription_consumptions','id_cliente','uuid'),
('subscription_consumptions','id_cita','uuid'),
('subscription_consumptions','orden_integrante','int4'),
('subscription_consumptions','item_tipo','text'),
('subscription_consumptions','id_servicio','uuid'),
('subscription_consumptions','item_codigo','text'),
('subscription_consumptions','item_nombre','text'),
('subscription_consumptions','cantidad','int4'),
('subscription_consumptions','precio_unitario_hnl','numeric'),
('subscription_consumptions','total_hnl','numeric'),
('subscription_consumptions','coverage_status','text'),
('subscription_consumptions','source_key','text'),
('subscription_consumptions','created_at','timestamptz'),
('subscription_consumptions','updated_at','timestamptz'),
('subscription_consumptions','id_cortesia','uuid'),
('subscription_consumptions','source_kind','text'),
('subscription_consumptions','invalidado','bool'),
('subscription_consumptions','invalidado_motivo','text'),
('subscription_payments','id_sub_payment','uuid'),
('subscription_payments','id_suscripcion','uuid'),
('subscription_payments','monto_hnl','numeric'),
('subscription_payments','moneda_codigo','text'),
('subscription_payments','metodo','text'),
('subscription_payments','estado','text'),
('subscription_payments','paid_at','timestamptz'),
('subscription_payments','id_payment','uuid'),
('subscription_payments','registrado_por_usuario_id','uuid'),
('subscription_payments','created_at','timestamptz'),
('subscription_payments','updated_at','timestamptz'),
('subscriptions','id_suscripcion','uuid'),
('subscriptions','id_cliente','uuid'),
('subscriptions','id_plan','uuid'),
('subscriptions','estado_suscripcion_codigo','text'),
('subscriptions','inicio_at','timestamptz'),
('subscriptions','fin_at','timestamptz'),
('subscriptions','renovacion_auto','bool'),
('subscriptions','cancelada_al_fin','bool'),
('subscriptions','created_by_usuario_id','uuid'),
('subscriptions','created_at','timestamptz'),
('subscriptions','updated_at','timestamptz'),
('subscriptions','beneficios_snapshot','jsonb'),
('subscriptions','id_sucursal_contratada','uuid'),
('subscriptions','motivo_fin_codigo','text'),
('tipos_puntos','tipo_puntos_codigo','text'),
('tipos_puntos','descripcion','text'),
('tipos_puntos','signo','int4'),
('membership_purchase_orders','id_order','uuid'),
('membership_purchase_orders','id_cliente','uuid'),
('membership_purchase_orders','id_usuario','uuid'),
('membership_purchase_orders','id_plan','uuid'),
('membership_purchase_orders','id_plan_sucursal','uuid'),
('membership_purchase_orders','id_sucursal','uuid'),
('membership_purchase_orders','id_suscripcion','uuid'),
('membership_purchase_orders','estado_orden_codigo','text'),
('membership_purchase_orders','moneda_codigo','text'),
('membership_purchase_orders','subtotal_hnl','numeric'),
('membership_purchase_orders','descuento_hnl','numeric'),
('membership_purchase_orders','total_hnl','numeric'),
('membership_purchase_orders','plan_snapshot','jsonb'),
('membership_purchase_orders','cliente_snapshot','jsonb'),
('membership_purchase_orders','factura_snapshot','jsonb'),
('membership_purchase_orders','email_factura','text'),
('membership_purchase_orders','notas','text'),
('membership_purchase_orders','expires_at','timestamptz'),
('membership_purchase_orders','paid_at','timestamptz'),
('membership_purchase_orders','cancelled_at','timestamptz'),
('membership_purchase_orders','created_by_usuario_id','uuid'),
('membership_purchase_orders','created_at','timestamptz'),
('membership_purchase_orders','updated_at','timestamptz'),
('membership_purchase_orders','idempotency_key','text'),
('payment_events','id_event','uuid'),
('payment_events','id_provider','uuid'),
('payment_events','provider_event_id','text'),
('payment_events','evento_tipo','text'),
('payment_events','firma_valida','bool'),
('payment_events','id_intent','uuid'),
('payment_events','id_payment','uuid'),
('payment_events','payload_esencial','jsonb'),
('payment_events','recibido_at','timestamptz'),
('payment_events','procesado_at','timestamptz'),
('payment_events','resultado_procesamiento','text'),
('payment_providers','id_provider','uuid'),
('payment_providers','codigo','text'),
('payment_providers','nombre','text'),
('payment_providers','activo','bool'),
('payment_providers','configuracion_publica','jsonb'),
('payment_providers','created_at','timestamptz'),
('payment_providers','updated_at','timestamptz'),
('points_rule_services','id_rule_service','uuid'),
('points_rule_services','id_rule','uuid'),
('points_rule_services','id_servicio','uuid'),
('points_rule_services','created_at','timestamptz'),
('points_rule_services','cliente_condicion_codigo','text'),
('points_rule_services','puntos_canje','int4'),
('points_rule_services','habilitado','bool'),
('points_rule_services','visible_cliente','bool'),
('points_rule_services','orden_visual','int4'),
('points_rule_services','updated_at','timestamptz'),
('subscription_payments','id_sub_payment','uuid'),
('subscription_payments','id_suscripcion','uuid'),
('subscription_payments','monto_hnl','numeric'),
('subscription_payments','moneda_codigo','text'),
('subscription_payments','metodo','text'),
('subscription_payments','estado','text'),
('subscription_payments','paid_at','timestamptz'),
('subscription_payments','id_payment','uuid'),
('subscription_payments','registrado_por_usuario_id','uuid'),
('subscription_payments','created_at','timestamptz'),
('subscription_payments','updated_at','timestamptz')
) e(tablename,name,type)
 WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=e.tablename AND c.column_name=e.name AND c.udt_name=e.type)
 UNION ALL SELECT 'REQUIRED_UNIQUE_INDEXES',count(*) FROM (VALUES
('uq_points_cycle_active_cliente','CREATE UNIQUE INDEX uq_points_cycle_active_cliente ON public.points_cycles USING btree (id_cliente) WHERE (estado_ciclo_codigo = ''activo''::text)'),
('uq_points_tx_acumular_por_cita','CREATE UNIQUE INDEX uq_points_tx_acumular_por_cita ON public.points_transactions USING btree (id_cita, tipo_puntos_codigo) WHERE ((id_cita IS NOT NULL) AND (tipo_puntos_codigo = ''acumular''::text))'),
('uq_points_tx_canje_por_cita','CREATE UNIQUE INDEX uq_points_tx_canje_por_cita ON public.points_transactions USING btree (id_cliente, id_cita, tipo_puntos_codigo) WHERE ((tipo_puntos_codigo = ''canjear''::text) AND (id_cita IS NOT NULL))'),
('uq_points_tx_vencimiento_por_cycle','CREATE UNIQUE INDEX uq_points_tx_vencimiento_por_cycle ON public.points_transactions USING btree (id_cycle, tipo_puntos_codigo) WHERE ((id_cycle IS NOT NULL) AND (tipo_puntos_codigo = ''vencimiento''::text))')
) e(name,definition)
 WHERE NOT EXISTS(SELECT 1 FROM pg_indexes i JOIN pg_class ic ON ic.relname=i.indexname JOIN pg_index ix ON ix.indexrelid=ic.oid
 WHERE i.schemaname='public' AND i.indexname=e.name AND i.indexdef=e.definition AND ix.indisvalid AND ix.indisunique)
 UNION ALL SELECT 'PRIVATE_HELPER_GRANTS',count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app_private' AND p.proname LIKE 'points_%_v1' AND (p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[] OR p.prosecdef)) catalog UNION ALL SELECT * FROM (-- AM: SELECT compartido por preflight y aplicacion; sin escrituras ni reparacion implicita.
WITH historical AS (
  SELECT pt.*, tp.signo,
    sum(pt.puntos::bigint) OVER (PARTITION BY pt.id_cliente ORDER BY pt.created_at, pt.id_points_tx) running
  FROM public.points_transactions pt LEFT JOIN public.tipos_puntos tp USING(tipo_puntos_codigo)
  WHERE pt.id_cycle IS NULL
), history_review AS (
  SELECT h.id_cliente FROM historical h GROUP BY h.id_cliente
  HAVING NOT (
    min(h.running)>=0 AND count(DISTINCT h.created_at)=count(*)
    AND bool_and(COALESCE(isfinite(h.created_at) AND isfinite(h.updated_at)
      AND h.created_at<=h.updated_at AND h.updated_at<=now() AND h.vence_at IS NULL
      AND ((h.puntos>0 AND h.tipo_puntos_codigo IN ('acumular','ajustar') AND h.signo=1)
        OR (h.puntos<0 AND h.tipo_puntos_codigo='ajuste_resta' AND h.signo=-1)
        OR (h.puntos=-10 AND h.tipo_puntos_codigo='canjear' AND h.signo=-1)),false))
    AND (
      (sum(h.puntos::bigint)=0 AND NOT EXISTS(SELECT 1 FROM public.points_cycles pc
        WHERE pc.id_cliente=h.id_cliente AND (pc.primer_acumulado_at<=max(h.created_at)
          OR pc.primer_acumulado_at<=max(h.updated_at))))
      OR (
        -- AM: Carga manual aprobada por el propietario: el primer registro positivo inicia el ciclo.
        sum(h.puntos::bigint)>0 AND bool_and(h.tipo_puntos_codigo IN ('ajustar','ajuste_resta')
          AND h.creado_por_usuario_id IS NOT NULL)
        AND max(h.created_at)<((min(h.created_at) FILTER(WHERE h.puntos>0) AT TIME ZONE 'America/Tegucigalpa')
          +interval '12 months') AT TIME ZONE 'America/Tegucigalpa'
        AND (
          (NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=h.id_cliente)
            AND ((min(h.created_at) FILTER(WHERE h.puntos>0) AT TIME ZONE 'America/Tegucigalpa')
              +interval '12 months') AT TIME ZONE 'America/Tegucigalpa'>now())
          OR (EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=h.id_cliente
                AND pc.primer_acumulado_at=min(h.created_at) FILTER(WHERE h.puntos>0))
            AND bool_and((SELECT count(*) FROM public.points_cycles pc
              WHERE pc.id_cliente=h.id_cliente AND h.created_at>=pc.primer_acumulado_at
                AND h.created_at<pc.vence_at)=1))
        )
      )
    )
  )
), effective AS (
  SELECT pt.*,COALESCE(pt.id_cycle,(SELECT pc.id_cycle FROM public.points_cycles pc
    WHERE pc.id_cliente=pt.id_cliente AND pt.created_at>=pc.primer_acumulado_at AND pt.created_at<pc.vence_at
    ORDER BY pc.primer_acumulado_at DESC,pc.id_cycle DESC LIMIT 1)) effective_cycle
  FROM public.points_transactions pt
), issues AS (
 SELECT 'HISTORICAL_UNCYCLED_REVIEW' code, count(*)::bigint affected FROM history_review
 UNION ALL SELECT 'RULE_REVIEW', count(*) FROM public.points_rules WHERE activo IS TRUE
   AND (puntos_por_cita IS DISTINCT FROM 1 OR puntos_para_premio IS DISTINCT FROM 10
     OR (expiracion_meses IS NOT NULL AND expiracion_meses<>12))
 UNION ALL SELECT 'ACTIVE_CYCLES_DUPLICATED', count(*) FROM (
   SELECT id_cliente FROM public.points_cycles WHERE estado_ciclo_codigo='activo' GROUP BY id_cliente HAVING count(*)>1) d
 UNION ALL SELECT 'CYCLE_DATES_REVIEW', count(*) FROM public.points_cycles pc
   WHERE EXISTS(SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle=pc.id_cycle)
     AND NOT COALESCE(isfinite(pc.primer_acumulado_at) AND isfinite(pc.vence_at)
       AND pc.primer_acumulado_at<=now() AND pc.vence_at=pc.primer_acumulado_at+interval '12 months',false)
 UNION ALL SELECT 'CYCLE_CLIENT_MISMATCH', count(*) FROM public.points_transactions pt
   LEFT JOIN public.points_cycles pc ON pc.id_cycle=pt.id_cycle
   WHERE pt.id_cycle IS NOT NULL AND pt.id_cliente IS DISTINCT FROM pc.id_cliente
 UNION ALL SELECT 'CYCLE_NEGATIVE_BALANCE', count(*) FROM (
   SELECT effective_cycle FROM effective WHERE effective_cycle IS NOT NULL GROUP BY effective_cycle HAVING sum(puntos::bigint)<0) d
 UNION ALL SELECT 'INACTIVE_CYCLE_BALANCE_REVIEW',count(*) FROM (
   SELECT pc.id_cycle FROM public.points_cycles pc JOIN effective e ON e.effective_cycle=pc.id_cycle
   JOIN public.clientes c ON c.id_cliente=pc.id_cliente AND c.deleted_at IS NULL AND c.estado IS NOT FALSE
   WHERE pc.estado_ciclo_codigo IN ('cerrado','expirado') GROUP BY pc.id_cycle HAVING sum(e.puntos::bigint)<>0) d
 UNION ALL SELECT 'CLIENT_NEGATIVE_OR_OVERFLOW_BALANCE', count(*) FROM (
   SELECT id_cliente FROM public.points_transactions GROUP BY id_cliente
   HAVING sum(puntos::bigint)<0 OR sum(puntos::bigint)>2147483647) d
 UNION ALL SELECT 'TRANSACTION_SIGN_OR_DATE_REVIEW', count(*) FROM public.points_transactions pt
   LEFT JOIN public.tipos_puntos tp USING(tipo_puntos_codigo)
   WHERE NOT COALESCE(pt.puntos<>0 AND sign(pt.puntos)=tp.signo
     AND isfinite(pt.created_at) AND isfinite(pt.updated_at)
     AND pt.created_at<=pt.updated_at AND pt.updated_at<=now(),false)
 UNION ALL SELECT 'DUPLICATE_CREDIT',count(*) FROM (
   SELECT id_cita FROM public.points_transactions WHERE id_cita IS NOT NULL AND tipo_puntos_codigo='acumular'
   GROUP BY id_cita HAVING count(*)>1) d
 UNION ALL SELECT 'CREDIT_BENEFICIARY_REVIEW',count(*) FROM public.points_transactions pt
   JOIN public.citas c USING(id_cita) LEFT JOIN public.citas_grupos cg USING(id_grupo_cita)
   WHERE pt.tipo_puntos_codigo='acumular' AND pt.id_cliente IS DISTINCT FROM
     CASE WHEN cg.origen_codigo='cliente_autenticado' THEN cg.id_cliente_titular ELSE c.id_cliente END
 UNION ALL SELECT 'REDEMPTION_AMOUNT_REVIEW',count(*) FROM public.points_transactions
   WHERE tipo_puntos_codigo='canjear' AND puntos<>-10
 UNION ALL SELECT 'REQUIRED_POINT_TYPES',count(*) FROM (
   VALUES('acumular',1),('ajustar',1),('ajuste_resta',-1),('canjear',-1),('vencimiento',-1)) expected(code,sign)
   WHERE NOT EXISTS(SELECT 1 FROM public.tipos_puntos tp WHERE tp.tipo_puntos_codigo=expected.code AND tp.signo=expected.sign)
)
SELECT code,affected FROM issues ORDER BY code) data_checks UNION ALL SELECT 'SECURITY02_BACKUP_DRIFT' code,count(*)::bigint affected FROM (VALUES
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
SELECT set_config('masterfade.release10_ledger',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t),true),set_config('masterfade.release10_cycles',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t),true);

-- AM: Fuente exacta db/manual/20261113024454_masterpuntos_completion_cycles_v1.sql; SHA256 211a3dfb034f9dd83df0021ad8e89c6ad58ca2d1315cb54814bb03c87f0ba5ad
-- AM: QA-MASTERPUNTOS-INTEGRAL-01. Propuesta manual; NO ejecutar en remoto desde CI.
-- AM: No reescribe reglas, ciclos, movimientos ni saldos existentes; sin backfill.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- AM: Mantiene estable la prueba historica hasta COMMIT; no escribe ni bloquea lecturas.
LOCK TABLE public.points_transactions, public.points_cycles, public.tipos_puntos, public.points_rules IN SHARE MODE;

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid = to_regclass('public.citas_grupos') AND NOT attisdropped
        AND attname IN ('id_grupo_cita', 'id_cliente_titular', 'origen_codigo')) <> 3 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_GROUP_METADATA_REQUIRED';
  END IF;
  IF to_regprocedure('public.fn_points_get_or_create_active_cycle(uuid,timestamptz)') IS NULL
     OR to_regprocedure('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamptz)') IS NULL
     OR to_regprocedure('public.fn_points_materialize_expired_cycles(uuid)') IS NULL
     OR to_regprocedure('public.fn_trg_otorgar_puntos_por_cita()') IS NULL
     OR to_regprocedure('public.fn_points_tx_guard_acumular_final()') IS NULL THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_FUNCTIONS_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.citas'::regclass
        AND tgfoid = 'public.fn_trg_otorgar_puntos_por_cita()'::regprocedure
        AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_COMPLETION_TRIGGER_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
      AND tgfoid = 'public.fn_points_tx_guard_acumular_final()'::regprocedure AND tgenabled = 'O' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
      AND tgfoid = 'public.fn_points_tx_apply_tipo_sign()'::regprocedure AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_TRANSACTION_GUARDS_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index
      WHERE indrelid = 'public.points_transactions'::regclass AND indisunique AND indisvalid
        AND pg_get_indexdef(indexrelid) ~ '\(id_cita, tipo_puntos_codigo\)'
        AND pg_get_expr(indpred, indrelid) LIKE '%acumular%') THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_UNIQUE_APPOINTMENT_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.points_rules
      WHERE activo IS TRUE AND (puntos_por_cita <> 1 OR puntos_para_premio <> 10
        OR (expiracion_meses IS NOT NULL AND expiracion_meses <> 12))) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_RULE_REVIEW_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.points_cycles pc
      WHERE pc.estado_ciclo_codigo = 'activo'
        AND (pc.vence_at IS NULL OR pc.vence_at <> pc.primer_acumulado_at + interval '12 months')
        AND EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle = pc.id_cycle)) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_HISTORICAL_CYCLES_REVIEW_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.points_cycles WHERE estado_ciclo_codigo = 'activo'
      GROUP BY id_cliente HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_MULTIPLE_ACTIVE_CYCLES';
  END IF;
  IF EXISTS (
-- AM: BEGIN HISTORICAL_DEBITS_PROOF
WITH affected_clients AS (
  SELECT DISTINCT pc.id_cliente
  FROM public.points_cycles pc
  JOIN public.points_transactions credit ON credit.id_cycle = pc.id_cycle AND credit.puntos > 0
  WHERE pc.estado_ciclo_codigo = 'activo'
    AND EXISTS (SELECT 1 FROM public.points_transactions debit
      WHERE debit.id_cliente = pc.id_cliente AND debit.puntos < 0
        AND debit.id_cycle IS NULL)
), active_cycles AS (
  SELECT pc.*, count(*) OVER (PARTITION BY pc.id_cliente) AS ciclos_activos
  FROM public.points_cycles pc JOIN affected_clients a ON a.id_cliente = pc.id_cliente
  WHERE pc.estado_ciclo_codigo = 'activo'
), historical_movements AS (
  SELECT pt.*, tp.signo,
    sum(pt.puntos::bigint) OVER (PARTITION BY pt.id_cliente ORDER BY pt.created_at, pt.id_points_tx
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS saldo_historico_acumulado
  FROM public.points_transactions pt JOIN affected_clients a ON a.id_cliente = pt.id_cliente
  LEFT JOIN public.tipos_puntos tp ON tp.tipo_puntos_codigo = pt.tipo_puntos_codigo
  WHERE pt.id_cycle IS NULL
), historical_summary AS (
  SELECT h.id_cliente, count(*) AS movimientos_sin_ciclo, sum(h.puntos::bigint) AS neto_historico,
    min(h.created_at) AS primer_movimiento, max(h.created_at) AS ultimo_movimiento,
    max(h.updated_at) AS ultima_modificacion, min(h.saldo_historico_acumulado) AS minimo_acumulado,
    count(DISTINCT h.created_at) = count(*) AS orden_inequivoco,
    bool_and(h.vence_at IS NULL) AS sin_vencimientos_ambiguos,
    bool_and(COALESCE(
      (h.puntos > 0 AND h.tipo_puntos_codigo IN ('acumular', 'ajustar') AND h.signo = 1)
      OR (h.puntos < 0 AND h.tipo_puntos_codigo = 'ajuste_resta' AND h.signo = -1)
      OR (h.puntos = -10 AND h.tipo_puntos_codigo = 'canjear' AND h.signo = -1), false)) AS tipos_y_signos_validos,
    bool_and(h.created_at IS NOT NULL AND isfinite(h.created_at)
      AND h.updated_at IS NOT NULL AND isfinite(h.updated_at)
      AND h.updated_at >= h.created_at AND h.updated_at <= now()) AS fechas_verificables
  FROM historical_movements h GROUP BY h.id_cliente
), historical_debits_evaluation AS (
  SELECT ac.id_cliente, ac.id_cycle, hs.movimientos_sin_ciclo, hs.neto_historico,
    hs.primer_movimiento, hs.ultimo_movimiento, hs.ultima_modificacion,
    ac.primer_acumulado_at AS inicio_ciclo, ledger.saldo_ledger, ledger.saldo_ciclo,
    vpb.balance_puntos AS saldo_efectivo,
    array_remove(ARRAY[
      CASE WHEN ac.ciclos_activos <> 1 THEN 'ciclos_activos_ambiguos' END,
      CASE WHEN NOT COALESCE(isfinite(ac.primer_acumulado_at) AND isfinite(ac.vence_at)
        AND ac.primer_acumulado_at <= now() AND ac.vence_at > now()
        AND ac.vence_at = ac.primer_acumulado_at + interval '12 months', false)
        THEN 'ciclo_no_vigente_o_inconsistente' END,
      CASE WHEN NOT COALESCE(hs.tipos_y_signos_validos, false) THEN 'tipos_o_signos_ambiguos' END,
      CASE WHEN NOT COALESCE(hs.fechas_verificables, false) THEN 'fechas_no_verificables' END,
      CASE WHEN NOT COALESCE(hs.orden_inequivoco, false) THEN 'orden_historico_ambiguo' END,
      CASE WHEN NOT COALESCE(hs.sin_vencimientos_ambiguos, false) THEN 'vencimientos_historicos_ambiguos' END,
      CASE WHEN NOT COALESCE(hs.ultimo_movimiento < ac.primer_acumulado_at
        AND hs.ultima_modificacion < ac.primer_acumulado_at, false) THEN 'periodos_superpuestos' END,
      CASE WHEN hs.neto_historico IS DISTINCT FROM 0::numeric THEN 'historial_no_compensado' END,
      CASE WHEN NOT COALESCE(hs.minimo_acumulado >= 0, false) THEN 'debito_sin_credito_previo' END,
      CASE WHEN ledger.otros_ciclos <> 0 THEN 'otros_ciclos_requieren_revision' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.points_transactions pt
        LEFT JOIN public.tipos_puntos tp ON tp.tipo_puntos_codigo = pt.tipo_puntos_codigo
        WHERE pt.id_cycle = ac.id_cycle AND NOT COALESCE(
          pt.id_cliente = ac.id_cliente AND pt.created_at IS NOT NULL AND isfinite(pt.created_at)
          AND pt.created_at >= ac.primer_acumulado_at AND pt.created_at <= now()
          AND pt.updated_at IS NOT NULL AND isfinite(pt.updated_at)
          AND pt.updated_at >= pt.created_at AND pt.updated_at <= now()
          AND ((pt.puntos > 0 AND pt.tipo_puntos_codigo IN ('acumular', 'ajustar') AND tp.signo = 1)
            OR (pt.puntos < 0 AND pt.tipo_puntos_codigo = 'ajuste_resta' AND tp.signo = -1)
            OR (pt.puntos = -10 AND pt.tipo_puntos_codigo = 'canjear' AND tp.signo = -1)), false))
        THEN 'movimientos_del_ciclo_inconsistentes' END,
      CASE WHEN ledger.saldo_ciclo < 0 OR ledger.saldo_ledger <> ledger.saldo_ciclo
        OR vpb.balance_puntos IS DISTINCT FROM ledger.saldo_ciclo
        THEN 'saldo_inconsistente' END
    ], NULL) AS motivos_revision
  FROM active_cycles ac JOIN historical_summary hs ON hs.id_cliente = ac.id_cliente
  LEFT JOIN public.vw_points_balance vpb ON vpb.id_cliente = ac.id_cliente
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(pt.puntos::bigint), 0) AS saldo_ledger,
      COALESCE(sum(pt.puntos::bigint) FILTER (WHERE pt.id_cycle = ac.id_cycle), 0) AS saldo_ciclo,
      count(*) FILTER (WHERE pt.id_cycle IS NOT NULL AND pt.id_cycle <> ac.id_cycle) AS otros_ciclos
    FROM public.points_transactions pt WHERE pt.id_cliente = ac.id_cliente
  ) ledger
)
-- AM: END HISTORICAL_DEBITS_PROOF
    SELECT 1 FROM historical_debits_evaluation WHERE cardinality(motivos_revision) <> 0
  ) THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PREFLIGHT_HISTORICAL_DEBITS_REVIEW_REQUIRED';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(
  p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamptz DEFAULT now()
) RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamptz, vence_at timestamptz)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE
  v_cycle public.points_cycles%ROWTYPE;
  v_anchor timestamptz := COALESCE(p_anchor_at, now());
BEGIN
  IF p_id_cliente IS NULL OR COALESCE(p_expiracion_meses, 12) <> 12 OR v_anchor > now() THEN
    RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_id_cliente::text));
  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);
  SELECT pc.* INTO v_cycle FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente AND pc.estado_ciclo_codigo = 'activo'
  ORDER BY pc.primer_acumulado_at ASC, pc.id_cycle ASC LIMIT 1 FOR UPDATE OF pc;
  IF v_cycle.id_cycle IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle = v_cycle.id_cycle) THEN
      -- AM: Un ciclo previo vacio empieza al recibir su primera acreditacion, nunca al reservar.
      UPDATE public.points_cycles pc
      SET primer_acumulado_at = v_anchor, vence_at = v_anchor + interval '12 months', updated_at = now()
      WHERE pc.id_cycle = v_cycle.id_cycle RETURNING pc.* INTO v_cycle;
    ELSIF v_cycle.vence_at IS NULL THEN
      RAISE EXCEPTION 'MASTERPUNTOS_HISTORICAL_CYCLE_REVIEW_REQUIRED';
    END IF;
  ELSE
    INSERT INTO public.points_cycles (id_cliente, primer_acumulado_at, vence_at, estado_ciclo_codigo)
    VALUES (p_id_cliente, v_anchor, v_anchor + interval '12 months', 'activo') RETURNING * INTO v_cycle;
  END IF;
  RETURN QUERY SELECT v_cycle.id_cycle, v_cycle.primer_acumulado_at, v_cycle.vence_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(
  p_id_cliente uuid, p_anchor_at timestamptz DEFAULT now()
) RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamptz, vence_at timestamptz)
LANGUAGE sql SET search_path = pg_catalog, public AS $function$
  SELECT * FROM public.fn_points_get_or_create_active_cycle(p_id_cliente, 12, p_anchor_at)
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid;
BEGIN
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN RETURN NEW; END IF;
  SELECT c.* INTO v_cita FROM public.citas c
  WHERE c.id_cita = NEW.id_cita AND c.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF v_cita.estado_cita_codigo <> 'completada'
     OR v_beneficiario IS NULL OR v_beneficiario IS DISTINCT FROM NEW.id_cliente
     OR (COALESCE(v_cita.es_canje_recompensa, false) AND COALESCE(v_cita.orden_integrante, 1) <= 1) THEN
    RETURN NULL;
  END IF;
  NEW.origen_punto_codigo := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  NEW.puntos := 1;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cycle record; v_usuario uuid; v_origen text; v_beneficiario uuid;
BEGIN
  IF NEW.estado_cita_codigo <> 'completada' OR NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado_cita_codigo IS NOT DISTINCT FROM NEW.estado_cita_codigo THEN RETURN NEW; END IF;
  END IF;
  -- AM: El grupo autenticado define al beneficiario; nunca se altera la identidad de la cita.
  v_beneficiario := NEW.id_cliente;
  IF NEW.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE NEW.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = NEW.id_grupo_cita;
    IF NOT FOUND THEN RETURN NEW; END IF;
  END IF;
  IF v_beneficiario IS NULL THEN RETURN NEW; END IF;
  v_origen := CASE WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  IF COALESCE(NEW.es_canje_recompensa, false) AND v_origen = 'titular' THEN RETURN NEW; END IF;
  SELECT c.id_usuario INTO v_usuario FROM public.clientes c
  WHERE c.id_cliente = v_beneficiario AND c.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_beneficiario::text));
  IF EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cita = NEW.id_cita AND pt.tipo_puntos_codigo = 'acumular') THEN RETURN NEW; END IF;
  SELECT * INTO v_cycle FROM public.fn_points_get_or_create_active_cycle(v_beneficiario, 12, now());
  INSERT INTO public.points_transactions (
    id_cliente, id_cita, id_cycle, id_sucursal_origen, tipo_puntos_codigo,
    origen_punto_codigo, puntos, vence_at, motivo, creado_por_usuario_id, created_at, updated_at
  ) VALUES (
    v_beneficiario, NEW.id_cita, v_cycle.id_cycle, NEW.id_sucursal, 'acumular',
    v_origen, 1, v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante' THEN 'Punto por acompañante en visita completada' ELSE 'Punto por visita completada del titular' END,
    COALESCE(NEW.creada_por_usuario_id, v_usuario), now(), now()
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

-- AM: Neutraliza la via historica de confirmacion sin cambiar triggers ni consumos de membresia.
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN RETURN NEW; END;
$function$;

-- AM: Fuente exacta db/manual/20261113161929_masterpuntos_paid_confirmation_v1.sql; SHA256 bcfbaf4ff3c74b1b298fc2f378c2990c4a18fcc234e1657924ca9604071194bc
-- AM: QA-MASTERPUNTOS-PAGO-CONFIRMADO-01. Ejecutar manualmente completa en QA, nunca desde CI.
-- AM: Requiere 20261113024454 ya aplicada. Sin backfill ni cambios a movimientos/ciclos historicos.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamptz)') IS NULL
     OR to_regprocedure('public.fn_points_tx_guard_acumular_final()') IS NULL
     OR to_regprocedure('public.fn_trg_otorgar_puntos_por_cita()') IS NULL THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_PREREQUISITE_REQUIRED';
  END IF;
  IF position('MASTERPUNTOS_CYCLE_ARGUMENT_INVALID' IN pg_get_functiondef(
      'public.fn_points_get_or_create_active_cycle(uuid,integer,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_COMPLETION_CYCLES_MIGRATION_REQUIRED';
  END IF;
  -- AM: Falla cerrado si falta el contrato verificado; no infiere columnas en QA.
  PERFORM c.id_cita, c.id_cliente, c.id_grupo_cita, c.total_pagar_hnl, c.moneda_codigo,
    c.es_canje_recompensa, c.orden_integrante, c.inicio_at FROM public.citas c WHERE false;
  PERFORM cg.id_cliente_titular, cg.origen_codigo FROM public.citas_grupos cg WHERE false;
  PERFORM p.id_payment, p.id_intent, p.estado_pago_codigo, p.provider_tx_id, p.pago_tardio,
    p.monto_hnl, p.moneda_codigo, p.paid_at FROM public.payments p WHERE false;
  PERFORM pi.id_provider, pi.id_membership_order, pi.origen_pago_codigo, pi.id_cita,
    pi.id_grupo_cita, pi.estado_intent_codigo FROM public.payment_intents pi WHERE false;
  PERFORM sp.id_payment, sp.id_suscripcion, sp.estado, sp.monto_hnl, sp.moneda_codigo, sp.paid_at
    FROM public.subscription_payments sp WHERE false;
  PERFORM mpo.id_order, mpo.id_suscripcion, mpo.id_cliente, mpo.estado_orden_codigo, mpo.total_hnl,
    mpo.moneda_codigo, mpo.paid_at FROM public.membership_purchase_orders mpo WHERE false;
  PERFORM sc.id_cita, sc.id_cliente, sc.id_suscripcion, sc.item_tipo, sc.id_servicio,
    sc.coverage_status, sc.invalidado, sc.created_at FROM public.subscription_consumptions sc WHERE false;
  PERFORM pe.id_intent, pe.evento_tipo, pe.payload_esencial FROM public.payment_events pe WHERE false;
  PERFORM pp.codigo FROM public.payment_providers pp WHERE false;
  IF NOT EXISTS (SELECT 1 FROM pg_index
      WHERE indrelid = 'public.points_transactions'::regclass AND indisunique AND indisvalid
        AND pg_get_indexdef(indexrelid) ~ '\(id_cita, tipo_puntos_codigo\)'
        AND pg_get_expr(indpred, indrelid) LIKE '%acumular%') THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_UNIQUE_APPOINTMENT_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
      AND tgfoid = 'public.fn_points_tx_guard_acumular_final()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_GUARD_REQUIRED';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION app_private.points_payment_valid_v1(p_id_payment uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
    JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
    WHERE p.id_payment = p_id_payment
      AND p.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
      AND p.pago_tardio IS FALSE AND pi.estado_intent_codigo = 'confirmado'
      AND p.paid_at IS NOT NULL AND p.paid_at <= clock_timestamp()
      AND p.monto_hnl > 0 AND p.monto_hnl = pi.monto_hnl
      AND p.moneda_codigo = pi.moneda_codigo
      AND NULLIF(btrim(p.provider_tx_id), '') IS NOT NULL
      AND pp.codigo IN ('pixelpay', 'todopago')
      AND p.provider_tx_id NOT LIKE 'tx_mock_%' AND p.provider_tx_id NOT LIKE 'todopago_sim_%'
      AND NOT EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.id_intent = pi.id_intent
        AND (pe.evento_tipo IN ('payment.simulated.result', 'membership.simulated.result')
          OR pe.payload_esencial->>'mode' = 'preprod_simulated'))
  )
$function$;

CREATE OR REPLACE FUNCTION app_private.points_appointment_paid_v1(p_id_cita uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.citas c WHERE c.id_cita = p_id_cita
      AND c.deleted_at IS NULL AND c.estado_cita_codigo = 'confirmada'
      AND NOT (COALESCE(c.es_canje_recompensa, false) AND COALESCE(c.orden_integrante, 1) <= 1)
      AND (
        (c.total_pagar_hnl > 0 AND EXISTS (
          SELECT 1 FROM public.payment_intents pi JOIN public.payments p ON p.id_intent = pi.id_intent
          WHERE pi.origen_pago_codigo = 'cita' AND app_private.points_payment_valid_v1(p.id_payment)
            AND pi.moneda_codigo = c.moneda_codigo
            AND (
              (c.id_grupo_cita IS NULL AND pi.id_grupo_cita IS NULL AND pi.id_cita = c.id_cita
                AND pi.monto_hnl = c.total_pagar_hnl)
              OR (c.id_grupo_cita IS NOT NULL
                AND ((pi.id_grupo_cita = c.id_grupo_cita AND (pi.id_cita IS NULL OR EXISTS (
                  SELECT 1 FROM public.citas anchor WHERE anchor.id_cita = pi.id_cita
                    AND anchor.id_grupo_cita = c.id_grupo_cita AND anchor.deleted_at IS NULL)))
                  OR (pi.id_grupo_cita IS NULL AND EXISTS (
                  SELECT 1 FROM public.citas anchor WHERE anchor.id_cita = pi.id_cita
                    AND anchor.id_grupo_cita = c.id_grupo_cita AND anchor.deleted_at IS NULL)))
                AND pi.monto_hnl = (SELECT sum(g.total_pagar_hnl) FROM public.citas g
                  WHERE g.id_grupo_cita = c.id_grupo_cita AND g.deleted_at IS NULL))
            )
        ))
        OR EXISTS (
          SELECT 1 FROM public.subscription_consumptions sc
          JOIN public.subscriptions s ON s.id_suscripcion = sc.id_suscripcion AND s.id_cliente = sc.id_cliente
          JOIN public.subscription_payments sp ON sp.id_suscripcion = s.id_suscripcion
          JOIN public.payments p ON p.id_payment = sp.id_payment
          JOIN public.payment_intents pi ON pi.id_intent = p.id_intent AND pi.origen_pago_codigo = 'membership'
          JOIN public.membership_purchase_orders mpo ON mpo.id_order = pi.id_membership_order
            AND mpo.id_suscripcion = s.id_suscripcion AND mpo.id_cliente = s.id_cliente
          WHERE sc.id_cita = c.id_cita AND sc.id_cliente = c.id_cliente
            AND sc.coverage_status = 'cubierto_plan' AND sc.invalidado IS FALSE
            AND sc.item_tipo = 'servicio' AND sc.id_servicio IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.citas_detalles cd
              WHERE cd.id_cita = c.id_cita AND cd.id_servicio = sc.id_servicio)
            AND (s.estado_suscripcion_codigo = 'activa'
              OR (s.estado_suscripcion_codigo = 'vencida' AND s.motivo_fin_codigo = 'agotamiento'))
            AND s.id_sucursal_contratada = c.id_sucursal
            AND s.inicio_at <= sc.created_at AND s.fin_at > sc.created_at
            AND sp.estado = 'pagado' AND sp.paid_at IS NOT NULL AND sp.paid_at <= clock_timestamp()
            AND sp.monto_hnl = p.monto_hnl AND sp.moneda_codigo = p.moneda_codigo
            AND mpo.estado_orden_codigo = 'pagada' AND mpo.paid_at IS NOT NULL
            AND mpo.total_hnl = p.monto_hnl AND mpo.moneda_codigo = p.moneda_codigo
            AND app_private.points_payment_valid_v1(p.id_payment)
        )
      )
  )
$function$;

CREATE OR REPLACE FUNCTION app_private.points_award_paid_appointment_v1(p_id_cita uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid; v_usuario uuid; v_cycle record; v_origen text;
BEGIN
  SELECT * INTO v_cita FROM public.citas WHERE id_cita = p_id_cita;
  IF NOT FOUND OR NOT app_private.points_appointment_paid_v1(p_id_cita) THEN RETURN; END IF;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  IF v_beneficiario IS NULL THEN RETURN; END IF;
  SELECT id_usuario INTO v_usuario FROM public.clientes WHERE id_cliente = v_beneficiario AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_beneficiario::text));
  IF EXISTS (SELECT 1 FROM public.points_transactions WHERE id_cita = p_id_cita AND tipo_puntos_codigo = 'acumular') THEN RETURN; END IF;
  SELECT * INTO v_cycle FROM public.fn_points_get_or_create_active_cycle(v_beneficiario, 12, now());
  v_origen := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  INSERT INTO public.points_transactions (id_cliente, id_cita, id_cycle, id_sucursal_origen,
    tipo_puntos_codigo, origen_punto_codigo, puntos, vence_at, motivo, creado_por_usuario_id)
  VALUES (v_beneficiario, p_id_cita, v_cycle.id_cycle, v_cita.id_sucursal, 'acumular', v_origen, 1, v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante' THEN 'Punto por acompañante con pago y reserva confirmados'
      ELSE 'Punto del titular con pago y reserva confirmados' END, COALESCE(v_cita.creada_por_usuario_id, v_usuario))
  ON CONFLICT DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid; v_vence_at timestamptz;
BEGIN
  -- AM: Una acreditacion existente no se revierte por no_show ni se reescribe como otra acreditacion.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tipo_puntos_codigo = 'acumular' AND OLD.id_cita IS NOT NULL THEN
      IF ROW(NEW.id_cliente, NEW.id_cita, NEW.id_cycle, NEW.tipo_puntos_codigo, NEW.origen_punto_codigo, NEW.puntos)
        IS DISTINCT FROM ROW(OLD.id_cliente, OLD.id_cita, OLD.id_cycle, OLD.tipo_puntos_codigo, OLD.origen_punto_codigo, OLD.puntos) THEN
        RAISE EXCEPTION 'MASTERPUNTOS_PAID_CREDIT_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN RETURN NEW; END IF;
  IF NOT app_private.points_appointment_paid_v1(NEW.id_cita) THEN RETURN NULL; END IF;
  SELECT * INTO v_cita FROM public.citas WHERE id_cita = NEW.id_cita;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF v_beneficiario IS NULL OR v_beneficiario IS DISTINCT FROM NEW.id_cliente THEN RETURN NULL; END IF;
  SELECT pc.vence_at INTO v_vence_at FROM public.points_cycles pc
    WHERE pc.id_cycle = NEW.id_cycle AND pc.id_cliente = v_beneficiario
      AND pc.estado_ciclo_codigo = 'activo' AND pc.vence_at > now()
      AND pc.vence_at = pc.primer_acumulado_at + interval '12 months';
  IF NOT FOUND THEN RETURN NULL; END IF;
  NEW.origen_punto_codigo := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  NEW.id_sucursal_origen := v_cita.id_sucursal;
  NEW.vence_at := v_vence_at;
  NEW.puntos := 1;
  RETURN NEW;
END;
$function$;

-- AM: Sustituye la guarda por el mismo nombre observado; tambien protege UPDATE de puntos/beneficiario.
DO $guard$
DECLARE v_name text;
BEGIN
  SELECT tgname INTO STRICT v_name FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
    AND tgfoid = 'public.fn_points_tx_guard_acumular_final()'::regprocedure AND tgenabled = 'O' AND NOT tgisinternal;
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE INSERT OR UPDATE ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_points_tx_guard_acumular_final()', v_name);
END;
$guard$;

-- AM: Los hooks antiguos dejan de acreditar por finalizacion o cobertura sin evidencia de pago.
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN RETURN NEW; END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION app_private.points_award_paid_event_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_intent public.payment_intents%ROWTYPE; v_id_cita uuid;
BEGIN
  IF TG_TABLE_NAME = 'citas' THEN
    IF NEW.estado_cita_codigo <> 'confirmada' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.estado_cita_codigo IS NOT DISTINCT FROM NEW.estado_cita_codigo THEN RETURN NEW; END IF;
    END IF;
    PERFORM app_private.points_award_paid_appointment_v1(NEW.id_cita);
  ELSIF TG_TABLE_NAME = 'subscription_consumptions' THEN
    IF NEW.coverage_status <> 'cubierto_plan' OR NEW.invalidado IS NOT FALSE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF ROW(OLD.id_cita, OLD.id_suscripcion, OLD.coverage_status, OLD.invalidado, OLD.id_servicio)
        IS NOT DISTINCT FROM ROW(NEW.id_cita, NEW.id_suscripcion, NEW.coverage_status, NEW.invalidado, NEW.id_servicio) THEN RETURN NEW; END IF;
    END IF;
    PERFORM app_private.points_award_paid_appointment_v1(NEW.id_cita);
  ELSE
    IF TG_TABLE_NAME = 'payment_intents' THEN
      IF NEW.estado_intent_codigo <> 'confirmado' THEN RETURN NEW; END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.estado_intent_codigo IS NOT DISTINCT FROM NEW.estado_intent_codigo THEN RETURN NEW; END IF;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF ROW(OLD.estado_pago_codigo, OLD.pago_tardio) IS NOT DISTINCT FROM ROW(NEW.estado_pago_codigo, NEW.pago_tardio) THEN RETURN NEW; END IF;
    END IF;
    SELECT * INTO v_intent FROM public.payment_intents WHERE id_intent = NEW.id_intent;
    IF NOT FOUND OR v_intent.origen_pago_codigo <> 'cita' THEN RETURN NEW; END IF;
    FOR v_id_cita IN SELECT c.id_cita FROM public.citas c WHERE c.deleted_at IS NULL
      AND (c.id_cita = v_intent.id_cita OR c.id_grupo_cita = v_intent.id_grupo_cita
        OR (v_intent.id_grupo_cita IS NULL AND c.id_grupo_cita = (
          SELECT anchor.id_grupo_cita FROM public.citas anchor WHERE anchor.id_cita = v_intent.id_cita)))
      ORDER BY c.id_cita
    LOOP PERFORM app_private.points_award_paid_appointment_v1(v_id_cita); END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

-- AM: Diferido hasta COMMIT: observa pago, confirmacion y consumo VIP en cualquier orden,
-- AM: despues de validar/descontar el canje, sin que los nuevos puntos financien ese mismo canje.
DO $triggers$
DECLARE v_table text; v_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['citas', 'payments', 'payment_intents', 'subscription_consumptions'] LOOP
    v_name := 'tr_points_paid_' || v_table;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || v_table)::regclass AND tgname = v_name) THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()', v_name, v_table);
    END IF;
  END LOOP;
END;
$triggers$;

DO $validation$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('tr_points_paid_citas', 'tr_points_paid_payments',
      'tr_points_paid_payment_intents', 'tr_points_paid_subscription_consumptions')
      AND tgfoid = 'app_private.points_award_paid_event_v1()'::regprocedure
      AND tgdeferrable AND tginitdeferred AND tgenabled = 'O' AND NOT tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_DEFERRED_TRIGGERS_REQUIRED';
  END IF;
END;
$validation$;

REVOKE ALL ON FUNCTION app_private.points_payment_valid_v1(uuid), app_private.points_appointment_paid_v1(uuid),
  app_private.points_award_paid_appointment_v1(uuid), app_private.points_award_paid_event_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.points_payment_valid_v1(uuid), app_private.points_appointment_paid_v1(uuid),
  app_private.points_award_paid_appointment_v1(uuid), app_private.points_award_paid_event_v1() TO postgres;

-- AM: Correccion focalizada de ciclos. Fuentes previas y respaldo SEGURIDAD-02 intactos.
CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_cycle public.points_cycles%ROWTYPE;
  v_balance bigint; v_movements bigint;
  v_anchor timestamptz := COALESCE(p_anchor_at, now());
BEGIN
  IF p_id_cliente IS NULL OR COALESCE(p_expiracion_meses, 12) <> 12 OR v_anchor > now() THEN
    RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_id_cliente::text));
  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);
  SELECT pc.* INTO v_cycle FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente AND pc.estado_ciclo_codigo = 'activo'
  ORDER BY pc.primer_acumulado_at ASC, pc.id_cycle ASC LIMIT 1 FOR UPDATE OF pc;
  IF v_cycle.id_cycle IS NOT NULL THEN
    SELECT count(*),COALESCE(sum(pt.puntos::bigint),0) INTO v_movements,v_balance
      FROM public.points_transactions pt WHERE pt.id_cliente=p_id_cliente AND COALESCE(pt.id_cycle,(SELECT legacy.id_cycle FROM public.points_cycles legacy
      WHERE legacy.id_cliente=pt.id_cliente AND pt.created_at>=legacy.primer_acumulado_at
        AND pt.created_at<legacy.vence_at
      ORDER BY legacy.primer_acumulado_at DESC,legacy.id_cycle DESC LIMIT 1))=v_cycle.id_cycle;
    IF v_balance<0 THEN RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_BALANCE_REVIEW'
      USING ERRCODE='23514',CONSTRAINT='masterpuntos_cycle_balance'; END IF;
    -- AM: Al agotarse el saldo se conserva el ciclo anterior y el siguiente empieza con su primer credito.
    IF v_movements>0 AND v_balance=0 THEN
      UPDATE public.points_cycles SET estado_ciclo_codigo='cerrado',updated_at=now()
        WHERE points_cycles.id_cycle=v_cycle.id_cycle;
      v_cycle:=NULL;
    ELSIF v_movements=0 THEN
      -- AM: Un ciclo previo vacio empieza al recibir su primera acreditacion, nunca al reservar.
      UPDATE public.points_cycles pc
      SET primer_acumulado_at = v_anchor, vence_at = ((v_anchor AT TIME ZONE 'America/Tegucigalpa')+interval '12 months') AT TIME ZONE 'America/Tegucigalpa', updated_at = now()
      WHERE pc.id_cycle = v_cycle.id_cycle RETURNING pc.* INTO v_cycle;
    ELSIF v_cycle.vence_at IS NULL THEN
      RAISE EXCEPTION 'MASTERPUNTOS_HISTORICAL_CYCLE_REVIEW_REQUIRED';
    END IF;
  END IF;
  IF v_cycle.id_cycle IS NULL THEN
    INSERT INTO public.points_cycles (id_cliente, primer_acumulado_at, vence_at, estado_ciclo_codigo)
    VALUES (p_id_cliente, v_anchor, ((v_anchor AT TIME ZONE 'America/Tegucigalpa')+interval '12 months') AT TIME ZONE 'America/Tegucigalpa', 'activo') RETURNING * INTO v_cycle;
  END IF;
  RETURN QUERY SELECT v_cycle.id_cycle, v_cycle.primer_acumulado_at, v_cycle.vence_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(p_id_cliente uuid DEFAULT NULL::uuid)
 RETURNS integer LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_cliente uuid; v_cycle record; v_balance integer; v_total integer:=0;
BEGIN
  -- AM: Mismo orden de locks que canjes/ajustes; serializa antes de bloquear ciclos.
  FOR v_cliente IN SELECT DISTINCT pc.id_cliente FROM public.points_cycles pc
    WHERE pc.estado_ciclo_codigo='activo' AND pc.vence_at<=now()
      AND (p_id_cliente IS NULL OR pc.id_cliente=p_id_cliente) ORDER BY pc.id_cliente
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_cliente::text));
    FOR v_cycle IN SELECT pc.* FROM public.points_cycles pc
      WHERE pc.id_cliente=v_cliente AND pc.estado_ciclo_codigo='activo' AND pc.vence_at<=now()
      ORDER BY pc.id_cycle FOR UPDATE OF pc
    LOOP
      SELECT COALESCE(sum(pt.puntos::bigint),0)::integer INTO v_balance
        FROM public.points_transactions pt WHERE pt.id_cliente=v_cliente AND COALESCE(pt.id_cycle,(SELECT legacy.id_cycle FROM public.points_cycles legacy
      WHERE legacy.id_cliente=pt.id_cliente AND pt.created_at>=legacy.primer_acumulado_at
        AND pt.created_at<legacy.vence_at
      ORDER BY legacy.primer_acumulado_at DESC,legacy.id_cycle DESC LIMIT 1))=v_cycle.id_cycle;
      IF v_balance<0 THEN RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_BALANCE_REVIEW'
        USING ERRCODE='23514',CONSTRAINT='masterpuntos_cycle_balance'; END IF;
      IF v_balance>0 THEN
        INSERT INTO public.points_transactions(id_cliente,id_cycle,tipo_puntos_codigo,puntos,vence_at,motivo)
          VALUES(v_cliente,v_cycle.id_cycle,'vencimiento',v_balance,v_cycle.vence_at,'Vencimiento automatico del ciclo')
          ON CONFLICT(id_cycle,tipo_puntos_codigo) WHERE id_cycle IS NOT NULL AND tipo_puntos_codigo='vencimiento' DO NOTHING;
      END IF;
      UPDATE public.points_cycles SET estado_ciclo_codigo='expirado',updated_at=now()
        WHERE id_cycle=v_cycle.id_cycle AND estado_ciclo_codigo='activo';
      IF FOUND THEN v_total:=v_total+1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid; v_vence_at timestamptz; v_balance bigint;
BEGIN
  -- AM: Una acreditacion existente no se revierte por no_show ni se reescribe como otra acreditacion.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tipo_puntos_codigo = 'acumular' AND OLD.id_cita IS NOT NULL THEN
      IF ROW(NEW.id_cliente, NEW.id_cita, NEW.id_cycle, NEW.tipo_puntos_codigo, NEW.origen_punto_codigo, NEW.puntos)
        IS DISTINCT FROM ROW(OLD.id_cliente, OLD.id_cita, OLD.id_cycle, OLD.tipo_puntos_codigo, OLD.origen_punto_codigo, OLD.puntos) THEN
        RAISE EXCEPTION 'MASTERPUNTOS_PAID_CREDIT_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.tipo_puntos_codigo IN ('ajustar','ajuste_resta','canjear','vencimiento') THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.id_cliente::text));
    -- AM: El indice unico sigue resolviendo el replay; no volver a descontar antes del ON CONFLICT.
    IF NEW.tipo_puntos_codigo='canjear' AND NEW.id_cita IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.points_transactions WHERE id_cliente=NEW.id_cliente
        AND id_cita=NEW.id_cita AND tipo_puntos_codigo='canjear') THEN RETURN NEW; END IF;
    IF NEW.tipo_puntos_codigo='ajustar' AND NEW.id_cycle IS NULL THEN
      SELECT c.id_cycle INTO NEW.id_cycle FROM public.fn_points_get_or_create_active_cycle(NEW.id_cliente,12,NEW.created_at) c;
    ELSIF NEW.id_cycle IS NULL THEN
      SELECT pc.id_cycle INTO NEW.id_cycle FROM public.points_cycles pc
        WHERE pc.id_cliente=NEW.id_cliente AND pc.estado_ciclo_codigo='activo' AND pc.vence_at>now();
    END IF;
    SELECT pc.vence_at INTO v_vence_at FROM public.points_cycles pc
      WHERE pc.id_cycle=NEW.id_cycle AND pc.id_cliente=NEW.id_cliente;
    IF NOT FOUND THEN RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_ASSIGNMENT_REQUIRED'
      USING ERRCODE='23514',CONSTRAINT='masterpuntos_cycle_balance'; END IF;
    IF NEW.tipo_puntos_codigo='ajustar' THEN
      IF NEW.created_at<(SELECT primer_acumulado_at FROM public.points_cycles WHERE id_cycle=NEW.id_cycle)
        OR NEW.created_at>=v_vence_at THEN RAISE EXCEPTION 'MASTERPUNTOS_CREDIT_OUTSIDE_CYCLE'
        USING ERRCODE='23514',CONSTRAINT='masterpuntos_cycle_balance'; END IF;
      NEW.vence_at:=v_vence_at;
    ELSE
      SELECT COALESCE(sum(pt.puntos::bigint),0) INTO v_balance FROM public.points_transactions pt
        WHERE pt.id_cliente=NEW.id_cliente AND COALESCE(pt.id_cycle,(SELECT legacy.id_cycle FROM public.points_cycles legacy
      WHERE legacy.id_cliente=pt.id_cliente AND pt.created_at>=legacy.primer_acumulado_at
        AND pt.created_at<legacy.vence_at
      ORDER BY legacy.primer_acumulado_at DESC,legacy.id_cycle DESC LIMIT 1))=NEW.id_cycle;
      IF abs(NEW.puntos::bigint)>v_balance THEN RAISE EXCEPTION 'MASTERPUNTOS_CYCLE_INSUFFICIENT_BALANCE'
        USING ERRCODE='23514',CONSTRAINT='masterpuntos_cycle_balance'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN RETURN NEW; END IF;
  IF NOT app_private.points_appointment_paid_v1(NEW.id_cita) THEN RETURN NULL; END IF;
  SELECT * INTO v_cita FROM public.citas WHERE id_cita = NEW.id_cita;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF v_beneficiario IS NULL OR v_beneficiario IS DISTINCT FROM NEW.id_cliente THEN RETURN NULL; END IF;
  SELECT pc.vence_at INTO v_vence_at FROM public.points_cycles pc
    WHERE pc.id_cycle = NEW.id_cycle AND pc.id_cliente = v_beneficiario
      AND pc.estado_ciclo_codigo = 'activo' AND pc.vence_at > now()
      AND pc.vence_at = pc.primer_acumulado_at + interval '12 months';
  IF NOT FOUND THEN RETURN NULL; END IF;
  NEW.origen_punto_codigo := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  NEW.id_sucursal_origen := v_cita.id_sucursal;
  NEW.vence_at := v_vence_at;
  NEW.puntos := 1;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE VIEW public.vw_points_balance AS
WITH resolved AS (
  SELECT pt.id_cliente,pt.puntos,COALESCE(pt.id_cycle,(SELECT legacy.id_cycle FROM public.points_cycles legacy
      WHERE legacy.id_cliente=pt.id_cliente AND pt.created_at>=legacy.primer_acumulado_at
        AND pt.created_at<legacy.vence_at
      ORDER BY legacy.primer_acumulado_at DESC,legacy.id_cycle DESC LIMIT 1)) AS effective_cycle FROM public.points_transactions pt
), ledger_balance AS (
  SELECT id_cliente,COALESCE(sum(puntos),0::bigint) ledger_points FROM resolved GROUP BY id_cliente
), pending_expired_cycles AS (
  SELECT pc.id_cliente,pc.id_cycle,COALESCE(sum(r.puntos),0::bigint) remaining_points
  FROM public.points_cycles pc JOIN resolved r ON r.effective_cycle=pc.id_cycle AND r.id_cliente=pc.id_cliente
  WHERE pc.estado_ciclo_codigo='activo' AND pc.vence_at<=now() GROUP BY pc.id_cliente,pc.id_cycle
), pending_expiration_by_client AS (
  SELECT id_cliente,sum(GREATEST(remaining_points,0)) pending_expired_points FROM pending_expired_cycles GROUP BY id_cliente
)
SELECT lb.id_cliente,(lb.ledger_points-COALESCE(pe.pending_expired_points,0))::integer balance_puntos
FROM ledger_balance lb LEFT JOIN pending_expiration_by_client pe ON pe.id_cliente=lb.id_cliente;

-- AM: Solo metadatos de ciclos. La politica de fechas de carga fue aprobada por el propietario.
-- AM: El preflight completo debe pasar antes; nunca actualiza ni sustituye movimientos del ledger.
CREATE TABLE IF NOT EXISTS app_private.release10_cycle_bootstrap_backup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  ledger_md5 text NOT NULL,
  cycles_before_md5 text NOT NULL,
  cycles_before jsonb NOT NULL,
  cycles_after jsonb NOT NULL,
  seal text NOT NULL
);
ALTER TABLE app_private.release10_cycle_bootstrap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.release10_cycle_bootstrap_backup FROM PUBLIC,anon,authenticated,service_role;
GRANT ALL ON app_private.release10_cycle_bootstrap_backup TO postgres;

DO $bootstrap$
DECLARE v_saved app_private.release10_cycle_bootstrap_backup%ROWTYPE;
  v_ledger text; v_cycles text; v_before jsonb; v_after jsonb;
BEGIN
  IF current_user<>'postgres' THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_POSTGRES_REQUIRED'; END IF;
  SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) INTO v_ledger
    FROM public.points_transactions t;
  SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')),
    COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id_cycle),'[]') INTO v_cycles,v_before FROM public.points_cycles t;
  SELECT * INTO v_saved FROM app_private.release10_cycle_bootstrap_backup WHERE singleton;
  IF FOUND THEN
    IF v_saved.ledger_md5<>v_ledger OR v_saved.seal<>md5(v_saved.ledger_md5||v_saved.cycles_before_md5||v_saved.cycles_before::text||v_saved.cycles_after::text)
      OR (v_before<>v_saved.cycles_before AND v_before<>v_saved.cycles_after) THEN
      RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BOOTSTRAP_BASELINE_CHANGED';
    END IF;
    IF v_before=v_saved.cycles_before THEN
      INSERT INTO public.points_cycles SELECT r.* FROM jsonb_populate_recordset(NULL::public.points_cycles,v_saved.cycles_after) r
        WHERE NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cycle=r.id_cycle);
    END IF;
  ELSE
    INSERT INTO public.points_cycles(id_cliente,primer_acumulado_at,vence_at,estado_ciclo_codigo)
    SELECT id_cliente,min(created_at) FILTER(WHERE puntos>0),
      ((min(created_at) FILTER(WHERE puntos>0) AT TIME ZONE 'America/Tegucigalpa')+interval '12 months') AT TIME ZONE 'America/Tegucigalpa','activo'
    FROM public.points_transactions pt WHERE pt.id_cycle IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=pt.id_cliente)
    GROUP BY id_cliente HAVING sum(puntos::bigint)>0;
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id_cycle),'[]') INTO v_after FROM public.points_cycles t;
    INSERT INTO app_private.release10_cycle_bootstrap_backup(singleton,ledger_md5,cycles_before_md5,cycles_before,cycles_after,seal)
      VALUES(true,v_ledger,v_cycles,v_before,v_after,md5(v_ledger||v_cycles||v_before::text||v_after::text));
  END IF;
END;
$bootstrap$;

-- AM: Solo cuatro dependencias MasterPuntos de SEGURIDAD-02; no importar su hardening global.
ALTER FUNCTION public.fn_points_estado_final_cita() SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_get_effective_rule(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_materialize_expired_cycles(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_tx_apply_tipo_sign() SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_tx_guard_acumular_final() SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada() SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_trg_otorgar_puntos_por_cita() SET search_path TO pg_catalog,public,pg_temp;
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
DO $release10$ DECLARE r record; BEGIN
 FOR r IN -- AM: SELECT compartido por preflight y aplicacion; sin escrituras ni reparacion implicita.
WITH historical AS (
  SELECT pt.*, tp.signo,
    sum(pt.puntos::bigint) OVER (PARTITION BY pt.id_cliente ORDER BY pt.created_at, pt.id_points_tx) running
  FROM public.points_transactions pt LEFT JOIN public.tipos_puntos tp USING(tipo_puntos_codigo)
  WHERE pt.id_cycle IS NULL
), history_review AS (
  SELECT h.id_cliente FROM historical h GROUP BY h.id_cliente
  HAVING NOT (
    min(h.running)>=0 AND count(DISTINCT h.created_at)=count(*)
    AND bool_and(COALESCE(isfinite(h.created_at) AND isfinite(h.updated_at)
      AND h.created_at<=h.updated_at AND h.updated_at<=now() AND h.vence_at IS NULL
      AND ((h.puntos>0 AND h.tipo_puntos_codigo IN ('acumular','ajustar') AND h.signo=1)
        OR (h.puntos<0 AND h.tipo_puntos_codigo='ajuste_resta' AND h.signo=-1)
        OR (h.puntos=-10 AND h.tipo_puntos_codigo='canjear' AND h.signo=-1)),false))
    AND (
      (sum(h.puntos::bigint)=0 AND NOT EXISTS(SELECT 1 FROM public.points_cycles pc
        WHERE pc.id_cliente=h.id_cliente AND (pc.primer_acumulado_at<=max(h.created_at)
          OR pc.primer_acumulado_at<=max(h.updated_at))))
      OR (
        -- AM: Carga manual aprobada por el propietario: el primer registro positivo inicia el ciclo.
        sum(h.puntos::bigint)>0 AND bool_and(h.tipo_puntos_codigo IN ('ajustar','ajuste_resta')
          AND h.creado_por_usuario_id IS NOT NULL)
        AND max(h.created_at)<((min(h.created_at) FILTER(WHERE h.puntos>0) AT TIME ZONE 'America/Tegucigalpa')
          +interval '12 months') AT TIME ZONE 'America/Tegucigalpa'
        AND (
          (NOT EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=h.id_cliente)
            AND ((min(h.created_at) FILTER(WHERE h.puntos>0) AT TIME ZONE 'America/Tegucigalpa')
              +interval '12 months') AT TIME ZONE 'America/Tegucigalpa'>now())
          OR (EXISTS(SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=h.id_cliente
                AND pc.primer_acumulado_at=min(h.created_at) FILTER(WHERE h.puntos>0))
            AND bool_and((SELECT count(*) FROM public.points_cycles pc
              WHERE pc.id_cliente=h.id_cliente AND h.created_at>=pc.primer_acumulado_at
                AND h.created_at<pc.vence_at)=1))
        )
      )
    )
  )
), effective AS (
  SELECT pt.*,COALESCE(pt.id_cycle,(SELECT pc.id_cycle FROM public.points_cycles pc
    WHERE pc.id_cliente=pt.id_cliente AND pt.created_at>=pc.primer_acumulado_at AND pt.created_at<pc.vence_at
    ORDER BY pc.primer_acumulado_at DESC,pc.id_cycle DESC LIMIT 1)) effective_cycle
  FROM public.points_transactions pt
), issues AS (
 SELECT 'HISTORICAL_UNCYCLED_REVIEW' code, count(*)::bigint affected FROM history_review
 UNION ALL SELECT 'RULE_REVIEW', count(*) FROM public.points_rules WHERE activo IS TRUE
   AND (puntos_por_cita IS DISTINCT FROM 1 OR puntos_para_premio IS DISTINCT FROM 10
     OR (expiracion_meses IS NOT NULL AND expiracion_meses<>12))
 UNION ALL SELECT 'ACTIVE_CYCLES_DUPLICATED', count(*) FROM (
   SELECT id_cliente FROM public.points_cycles WHERE estado_ciclo_codigo='activo' GROUP BY id_cliente HAVING count(*)>1) d
 UNION ALL SELECT 'CYCLE_DATES_REVIEW', count(*) FROM public.points_cycles pc
   WHERE EXISTS(SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle=pc.id_cycle)
     AND NOT COALESCE(isfinite(pc.primer_acumulado_at) AND isfinite(pc.vence_at)
       AND pc.primer_acumulado_at<=now() AND pc.vence_at=pc.primer_acumulado_at+interval '12 months',false)
 UNION ALL SELECT 'CYCLE_CLIENT_MISMATCH', count(*) FROM public.points_transactions pt
   LEFT JOIN public.points_cycles pc ON pc.id_cycle=pt.id_cycle
   WHERE pt.id_cycle IS NOT NULL AND pt.id_cliente IS DISTINCT FROM pc.id_cliente
 UNION ALL SELECT 'CYCLE_NEGATIVE_BALANCE', count(*) FROM (
   SELECT effective_cycle FROM effective WHERE effective_cycle IS NOT NULL GROUP BY effective_cycle HAVING sum(puntos::bigint)<0) d
 UNION ALL SELECT 'INACTIVE_CYCLE_BALANCE_REVIEW',count(*) FROM (
   SELECT pc.id_cycle FROM public.points_cycles pc JOIN effective e ON e.effective_cycle=pc.id_cycle
   JOIN public.clientes c ON c.id_cliente=pc.id_cliente AND c.deleted_at IS NULL AND c.estado IS NOT FALSE
   WHERE pc.estado_ciclo_codigo IN ('cerrado','expirado') GROUP BY pc.id_cycle HAVING sum(e.puntos::bigint)<>0) d
 UNION ALL SELECT 'CLIENT_NEGATIVE_OR_OVERFLOW_BALANCE', count(*) FROM (
   SELECT id_cliente FROM public.points_transactions GROUP BY id_cliente
   HAVING sum(puntos::bigint)<0 OR sum(puntos::bigint)>2147483647) d
 UNION ALL SELECT 'TRANSACTION_SIGN_OR_DATE_REVIEW', count(*) FROM public.points_transactions pt
   LEFT JOIN public.tipos_puntos tp USING(tipo_puntos_codigo)
   WHERE NOT COALESCE(pt.puntos<>0 AND sign(pt.puntos)=tp.signo
     AND isfinite(pt.created_at) AND isfinite(pt.updated_at)
     AND pt.created_at<=pt.updated_at AND pt.updated_at<=now(),false)
 UNION ALL SELECT 'DUPLICATE_CREDIT',count(*) FROM (
   SELECT id_cita FROM public.points_transactions WHERE id_cita IS NOT NULL AND tipo_puntos_codigo='acumular'
   GROUP BY id_cita HAVING count(*)>1) d
 UNION ALL SELECT 'CREDIT_BENEFICIARY_REVIEW',count(*) FROM public.points_transactions pt
   JOIN public.citas c USING(id_cita) LEFT JOIN public.citas_grupos cg USING(id_grupo_cita)
   WHERE pt.tipo_puntos_codigo='acumular' AND pt.id_cliente IS DISTINCT FROM
     CASE WHEN cg.origen_codigo='cliente_autenticado' THEN cg.id_cliente_titular ELSE c.id_cliente END
 UNION ALL SELECT 'REDEMPTION_AMOUNT_REVIEW',count(*) FROM public.points_transactions
   WHERE tipo_puntos_codigo='canjear' AND puntos<>-10
 UNION ALL SELECT 'REQUIRED_POINT_TYPES',count(*) FROM (
   VALUES('acumular',1),('ajustar',1),('ajuste_resta',-1),('canjear',-1),('vencimiento',-1)) expected(code,sign)
   WHERE NOT EXISTS(SELECT 1 FROM public.tipos_puntos tp WHERE tp.tipo_puntos_codigo=expected.code AND tp.signo=expected.sign)
)
SELECT code,affected FROM issues ORDER BY code LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;
DO $preserve$ BEGIN IF (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)<>current_setting('masterfade.release10_ledger') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $preserve$;
COMMIT;
