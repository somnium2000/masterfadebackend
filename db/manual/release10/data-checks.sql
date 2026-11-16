-- AM: SELECT compartido por preflight y aplicacion; sin escrituras ni reparacion implicita.
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
SELECT code,affected FROM issues ORDER BY code;
