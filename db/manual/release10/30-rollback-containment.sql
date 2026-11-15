-- AM: MANUAL; mantener trafico detenido. No restaurar backend antiguo ni reabrir con creditos suspendidos.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.citas,public.citas_detalles,public.citas_grupos,public.clientes,public.membership_purchase_orders,public.payment_events,public.payment_intents,public.payment_providers,public.payments,public.points_cycles,public.points_rule_services,public.points_rules,public.points_transactions,public.subscription_consumptions,public.subscription_payments,public.subscriptions,public.tipos_puntos IN SHARE ROW EXCLUSIVE MODE;
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
 WHERE t.oid IS NULL OR t.tgenabled NOT IN('O','D') OR pg_get_triggerdef(t.oid)<>e.definition) THEN 0 ELSE 1 END::bigint affected LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;
SELECT set_config('masterfade.release10_ledger',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t),true),set_config('masterfade.release10_cycles',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t),true);
ALTER TABLE public.citas DISABLE TRIGGER tr_points_paid_citas;
ALTER TABLE public.payment_intents DISABLE TRIGGER tr_points_paid_payment_intents;
ALTER TABLE public.payments DISABLE TRIGGER tr_points_paid_payments;
ALTER TABLE public.subscription_consumptions DISABLE TRIGGER tr_points_paid_subscription_consumptions;
DO $unchanged$ BEGIN IF (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)<>current_setting('masterfade.release10_ledger')
 OR (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)<>current_setting('masterfade.release10_cycles') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $unchanged$;
COMMIT;
