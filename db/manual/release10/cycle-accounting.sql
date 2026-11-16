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
