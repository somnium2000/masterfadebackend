-- AM: SOLO LECTURA; cualquier affected>0 es NO-GO. No llamar helpers mutables.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
SELECT * FROM (SELECT 'CATALOG_DRIFT' code, CASE WHEN (NOT EXISTS (SELECT 1 FROM (VALUES
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
SELECT code,affected FROM issues ORDER BY code) data_checks;
SELECT count(*) ledger_rows,COALESCE(sum(puntos::bigint),0) ledger_sum,(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t) ledger_md5,(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t) cycles_md5 FROM public.points_transactions;
COMMIT;
