-- AM: QA-MASTERPUNTOS-INTEGRAL-01. Propuesta manual; NO ejecutar en remoto desde CI.
-- AM: No reescribe reglas, ciclos, movimientos ni saldos existentes; sin backfill.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- AM: Mantiene estable la prueba historica hasta COMMIT; no escribe ni bloquea lecturas.
LOCK TABLE public.points_transactions, public.points_cycles, public.tipos_puntos, public.points_rules IN SHARE MODE;

DO $preflight$
BEGIN
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
DECLARE v_cita public.citas%ROWTYPE;
BEGIN
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN RETURN NEW; END IF;
  SELECT c.* INTO v_cita FROM public.citas c
  WHERE c.id_cita = NEW.id_cita AND c.deleted_at IS NULL;
  IF NOT FOUND OR v_cita.estado_cita_codigo <> 'completada'
     OR v_cita.id_cliente IS NULL OR v_cita.id_cliente IS DISTINCT FROM NEW.id_cliente
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
DECLARE v_cycle record; v_usuario uuid; v_origen text;
BEGIN
  IF NEW.estado_cita_codigo <> 'completada' OR NEW.id_cliente IS NULL OR NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado_cita_codigo IS NOT DISTINCT FROM NEW.estado_cita_codigo THEN RETURN NEW; END IF;
  END IF;
  v_origen := CASE WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  IF COALESCE(NEW.es_canje_recompensa, false) AND v_origen = 'titular' THEN RETURN NEW; END IF;
  SELECT c.id_usuario INTO v_usuario FROM public.clientes c
  WHERE c.id_cliente = NEW.id_cliente AND c.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.id_cliente::text));
  IF EXISTS (SELECT 1 FROM public.points_transactions pt WHERE pt.id_cita = NEW.id_cita AND pt.tipo_puntos_codigo = 'acumular') THEN RETURN NEW; END IF;
  SELECT * INTO v_cycle FROM public.fn_points_get_or_create_active_cycle(NEW.id_cliente, 12, now());
  INSERT INTO public.points_transactions (
    id_cliente, id_cita, id_cycle, id_sucursal_origen, tipo_puntos_codigo,
    origen_punto_codigo, puntos, vence_at, motivo, creado_por_usuario_id, created_at, updated_at
  ) VALUES (
    NEW.id_cliente, NEW.id_cita, v_cycle.id_cycle, NEW.id_sucursal, 'acumular',
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
COMMIT;
