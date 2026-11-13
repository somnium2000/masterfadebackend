-- AM: Solo lectura. Propuesta de preflight; NO ejecutada en Supabase remoto.
BEGIN READ ONLY;
SELECT p.oid::regprocedure AS funcion, md5(pg_get_functiondef(p.oid)) AS definicion_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'fn_points_get_or_create_active_cycle', 'fn_points_materialize_expired_cycles',
  'fn_points_tx_guard_acumular_final', 'fn_trg_otorgar_puntos_por_cita', 'fn_trg_otorgar_puntos_plan_confirmada'
);
SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definicion
FROM pg_trigger t WHERE NOT t.tgisinternal
AND t.tgrelid IN ('public.citas'::regclass, 'public.points_transactions'::regclass);
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('points_cycles', 'points_transactions');
SELECT id_sucursal IS NULL AS regla_global, puntos_por_cita, puntos_para_premio, expiracion_meses, count(*)
FROM public.points_rules WHERE activo IS TRUE
GROUP BY id_sucursal IS NULL, puntos_por_cita, puntos_para_premio, expiracion_meses;
SELECT
  count(*) FILTER (WHERE pc.vence_at IS NULL AND EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle=pc.id_cycle)) AS ciclos_con_movimientos_sin_vencimiento,
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cycle=pc.id_cycle)) AS ciclos_vacios,
  count(*) FILTER (WHERE pc.vence_at IS NOT NULL AND pc.vence_at <> pc.primer_acumulado_at+interval '12 months') AS ciclos_con_plazo_distinto
FROM public.points_cycles pc WHERE pc.estado_ciclo_codigo='activo';
SELECT count(*) AS canjes_historicos_sin_ciclo
FROM public.points_transactions WHERE tipo_puntos_codigo='canjear' AND id_cycle IS NULL;
-- AM: Estas magnitudes son para revision, nunca una orden de recalculo o backfill.
SELECT count(*) AS movimientos_acreditados_fuera_de_completada
FROM public.points_transactions pt JOIN public.citas c ON c.id_cita=pt.id_cita
WHERE pt.tipo_puntos_codigo='acumular' AND c.estado_cita_codigo<>'completada';
SELECT count(*) AS movimientos_con_identidad_distinta
FROM public.points_transactions pt JOIN public.citas c ON c.id_cita=pt.id_cita
WHERE pt.tipo_puntos_codigo='acumular' AND pt.id_cliente IS DISTINCT FROM c.id_cliente;
COMMIT;
