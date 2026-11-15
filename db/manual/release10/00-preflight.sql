-- AM: SOLO LECTURA; cualquier affected>0 es NO-GO. No llamar helpers mutables.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
SELECT * FROM (SELECT 'CATALOG_DRIFT' code, CASE WHEN (NOT EXISTS (SELECT 1 FROM (VALUES
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
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal)) OR (NOT EXISTS (SELECT 1 FROM (VALUES
('app_private.points_appointment_paid_v1(uuid)','663537c379708916af32a983c04bd4cd','{postgres=X/postgres}'),
('app_private.points_award_paid_appointment_v1(uuid)','e8912101bcf8da89a498de48b530928e','{postgres=X/postgres}'),
('app_private.points_award_paid_event_v1()','6234460cf41408ba70f151d2613246af','{postgres=X/postgres}'),
('app_private.points_payment_valid_v1(uuid)','fd02d98719e13fef3b90356343f318c4','{postgres=X/postgres}'),
('public.fn_points_estado_final_cita()','7fb6bdfda4c090baa1cc35217fb793b7',''),
('public.fn_points_get_effective_rule(uuid)','66f5ab15eeca8e37248f9dcfcb47ad4f',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','50a10a365d5da4d86fdf44a34698c704',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','8591cd5d75c788dad26d3f01da39916e',''),
('public.fn_points_materialize_expired_cycles(uuid)','64f4a8091790eeeaf5887fb505edaf61',''),
('public.fn_points_tx_apply_tipo_sign()','880bc208992a8e325add77fe7edf467f',''),
('public.fn_points_tx_guard_acumular_final()','1bddbe08306f6ebdde21b92b065b2a8b',''),
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
  HAVING sum(h.puntos::bigint) <> 0
    OR min(h.running) < 0 OR count(DISTINCT h.created_at) <> count(*)
    OR NOT bool_and(COALESCE(
      h.created_at IS NOT NULL AND isfinite(h.created_at)
      AND h.updated_at IS NOT NULL AND isfinite(h.updated_at)
      AND h.updated_at >= h.created_at AND h.updated_at <= now() AND h.vence_at IS NULL
      AND ((h.puntos > 0 AND h.tipo_puntos_codigo IN ('acumular','ajustar') AND h.signo=1)
        OR (h.puntos < 0 AND h.tipo_puntos_codigo='ajuste_resta' AND h.signo=-1)
        OR (h.puntos=-10 AND h.tipo_puntos_codigo='canjear' AND h.signo=-1)),false))
    OR EXISTS (SELECT 1 FROM public.points_cycles pc WHERE pc.id_cliente=h.id_cliente
      AND (pc.primer_acumulado_at <= max(h.created_at) OR pc.primer_acumulado_at <= max(h.updated_at)))
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
   SELECT id_cycle FROM public.points_transactions WHERE id_cycle IS NOT NULL GROUP BY id_cycle HAVING sum(puntos::bigint)<0) d
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
 WHERE b.signature IS NULL OR b.routine_oid<>to_regprocedure(e.signature)::oid OR to_jsonb(b)-'routine_oid'<>e.metadata::jsonb;
SELECT count(*) ledger_rows,COALESCE(sum(puntos::bigint),0) ledger_sum,(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t) ledger_md5,(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t) cycles_md5 FROM public.points_transactions;
COMMIT;
