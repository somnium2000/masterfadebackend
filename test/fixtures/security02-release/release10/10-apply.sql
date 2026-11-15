-- AM: MANUAL, requiere autorizacion y ventana sin escritores. DDL atomico, sin backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.citas,public.citas_detalles,public.citas_grupos,public.clientes,public.membership_purchase_orders,public.payment_events,public.payment_intents,public.payment_providers,public.payments,public.points_cycles,public.points_rule_services,public.points_rules,public.points_transactions,public.subscription_consumptions,public.subscription_payments,public.subscriptions,public.tipos_puntos IN SHARE ROW EXCLUSIVE MODE;
DO $release10$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (SELECT 'CATALOG_DRIFT' code, CASE WHEN (NOT EXISTS (SELECT 1 FROM (VALUES
('public.fn_points_estado_final_cita()','4dfc98cfab7a75463c5c83174052bcec',''),
('public.fn_points_get_effective_rule(uuid)','a683ccd7ac0e7b57692f08b2f3a0de4b',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','4920fc016184b7946b64df47dabbfc8e',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','f493e6430190188179dc3010df3af753',''),
('public.fn_points_materialize_expired_cycles(uuid)','5448c179064e0e830e3ac7759d47cf5f',''),
('public.fn_points_tx_apply_tipo_sign()','9cbd32e13662f771108d7cc7b6a049d1',''),
('public.fn_points_tx_guard_acumular_final()','b574793906178b14218d867aea5fdb2d',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','8fca75d897f52916538b04d82dcdc5ef',''),
('public.fn_trg_otorgar_puntos_por_cita()','99e0f5af5be5cf544855d0ba85ae7f26','')
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
 WHERE t.oid IS NULL OR t.tgenabled<>'O' OR pg_get_triggerdef(t.oid)<>e.definition)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal)) OR (NOT EXISTS (SELECT 1 FROM (VALUES
('app_private.points_appointment_paid_v1(uuid)','663537c379708916af32a983c04bd4cd','{postgres=X/postgres}'),
('app_private.points_award_paid_appointment_v1(uuid)','e8912101bcf8da89a498de48b530928e','{postgres=X/postgres}'),
('app_private.points_award_paid_event_v1()','6234460cf41408ba70f151d2613246af','{postgres=X/postgres}'),
('app_private.points_payment_valid_v1(uuid)','fd02d98719e13fef3b90356343f318c4','{postgres=X/postgres}'),
('public.fn_points_estado_final_cita()','7fb6bdfda4c090baa1cc35217fb793b7',''),
('public.fn_points_get_effective_rule(uuid)','66f5ab15eeca8e37248f9dcfcb47ad4f',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','a19921956d5cba6513a6834f76b3a11a',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','bf11db33b109b40df887e26780a29ef4',''),
('public.fn_points_materialize_expired_cycles(uuid)','64f4a8091790eeeaf5887fb505edaf61',''),
('public.fn_points_tx_apply_tipo_sign()','880bc208992a8e325add77fe7edf467f',''),
('public.fn_points_tx_guard_acumular_final()','e5721692abbd0a4e16bf7cfdcad7a0fb',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','e2f678a29bd43bbc93c459ce5d6e2a76',''),
('public.fn_trg_otorgar_puntos_por_cita()','444831d3bffad0afb238a2801833fbda','')
) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=13 AND NOT EXISTS (SELECT 1 FROM (VALUES
('citas','tr_points_cita_confirmada','CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita()'),
('citas','tr_points_paid_citas','CREATE CONSTRAINT TRIGGER tr_points_paid_citas AFTER INSERT OR UPDATE ON public.citas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payment_intents','tr_points_paid_payment_intents','CREATE CONSTRAINT TRIGGER tr_points_paid_payment_intents AFTER INSERT OR UPDATE ON public.payment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payments','tr_points_paid_payments','CREATE CONSTRAINT TRIGGER tr_points_paid_payments AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('subscription_consumptions','tr_points_paid_subscription_consumptions','CREATE CONSTRAINT TRIGGER tr_points_paid_subscription_consumptions AFTER INSERT OR UPDATE ON public.subscription_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('points_transactions','tr_points_tx_apply_tipo_sign','CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign()'),
('points_transactions','tr_points_tx_guard_acumular_final','CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final()')
) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR t.tgenabled<>'O' OR pg_get_triggerdef(t.oid)<>e.definition)) THEN 0 ELSE 1 END::bigint affected
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
SELECT code,affected FROM issues ORDER BY code) data_checks LOOP
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

-- AM: Solo cuatro dependencias MasterPuntos de SEGURIDAD-02; no importar su hardening global.
ALTER FUNCTION public.fn_points_estado_final_cita() SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_get_effective_rule(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_materialize_expired_cycles(uuid) SET search_path TO pg_catalog,public,pg_temp;
ALTER FUNCTION public.fn_points_tx_apply_tipo_sign() SET search_path TO pg_catalog,public,pg_temp;
DO $release10$ DECLARE r record; BEGIN
 FOR r IN SELECT 'TARGET_FUNCTIONS_OR_TRIGGERS' code,CASE WHEN NOT EXISTS (SELECT 1 FROM (VALUES
('app_private.points_appointment_paid_v1(uuid)','663537c379708916af32a983c04bd4cd','{postgres=X/postgres}'),
('app_private.points_award_paid_appointment_v1(uuid)','e8912101bcf8da89a498de48b530928e','{postgres=X/postgres}'),
('app_private.points_award_paid_event_v1()','6234460cf41408ba70f151d2613246af','{postgres=X/postgres}'),
('app_private.points_payment_valid_v1(uuid)','fd02d98719e13fef3b90356343f318c4','{postgres=X/postgres}'),
('public.fn_points_estado_final_cita()','7fb6bdfda4c090baa1cc35217fb793b7',''),
('public.fn_points_get_effective_rule(uuid)','66f5ab15eeca8e37248f9dcfcb47ad4f',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','a19921956d5cba6513a6834f76b3a11a',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','bf11db33b109b40df887e26780a29ef4',''),
('public.fn_points_materialize_expired_cycles(uuid)','64f4a8091790eeeaf5887fb505edaf61',''),
('public.fn_points_tx_apply_tipo_sign()','880bc208992a8e325add77fe7edf467f',''),
('public.fn_points_tx_guard_acumular_final()','e5721692abbd0a4e16bf7cfdcad7a0fb',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','e2f678a29bd43bbc93c459ce5d6e2a76',''),
('public.fn_trg_otorgar_puntos_por_cita()','444831d3bffad0afb238a2801833fbda','')
) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=13 AND NOT EXISTS (SELECT 1 FROM (VALUES
('citas','tr_points_cita_confirmada','CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita()'),
('citas','tr_points_paid_citas','CREATE CONSTRAINT TRIGGER tr_points_paid_citas AFTER INSERT OR UPDATE ON public.citas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payment_intents','tr_points_paid_payment_intents','CREATE CONSTRAINT TRIGGER tr_points_paid_payment_intents AFTER INSERT OR UPDATE ON public.payment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('payments','tr_points_paid_payments','CREATE CONSTRAINT TRIGGER tr_points_paid_payments AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('subscription_consumptions','tr_points_paid_subscription_consumptions','CREATE CONSTRAINT TRIGGER tr_points_paid_subscription_consumptions AFTER INSERT OR UPDATE ON public.subscription_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()'),
('points_transactions','tr_points_tx_apply_tipo_sign','CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign()'),
('points_transactions','tr_points_tx_guard_acumular_final','CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final()')
) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR t.tgenabled<>'O' OR pg_get_triggerdef(t.oid)<>e.definition) THEN 0 ELSE 1 END::bigint affected LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;
DO $unchanged$ BEGIN IF (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)<>current_setting('masterfade.release10_ledger')
 OR (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)<>current_setting('masterfade.release10_cycles') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $unchanged$;
COMMIT;
