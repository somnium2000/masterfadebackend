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
LEFT JOIN public.citas_grupos cg ON cg.id_grupo_cita=c.id_grupo_cita
WHERE pt.tipo_puntos_codigo='acumular' AND pt.id_cliente IS DISTINCT FROM
  CASE WHEN cg.origen_codigo='cliente_autenticado' THEN cg.id_cliente_titular ELSE c.id_cliente END;
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
SELECT id_cliente, id_cycle, movimientos_sin_ciclo, neto_historico,
  primer_movimiento, ultimo_movimiento, ultima_modificacion, inicio_ciclo,
  saldo_ledger, saldo_ciclo, saldo_efectivo,
  cardinality(motivos_revision) = 0 AS historico_compensado_seguro, motivos_revision
FROM historical_debits_evaluation ORDER BY id_cliente, id_cycle;
COMMIT;
