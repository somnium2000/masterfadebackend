-- AM: Definiciones del pg_dump local BD-PG.sql; sin datos de personas ni acceso remoto.
CREATE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_anchor_at timestamp with time zone DEFAULT now()) RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND (pc.vence_at IS NULL OR pc.vence_at > now())
  ORDER BY pc.primer_acumulado_at DESC NULLS LAST
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.points_cycles (
    id_cliente,
    primer_acumulado_at,
    vence_at,
    estado_ciclo_codigo
  )
  VALUES (
    p_id_cliente,
    COALESCE(p_anchor_at, now()),
    NULL,
    'activo'
  )
  RETURNING * INTO v_inserted;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;

  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamp with time zone DEFAULT now()) RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_anchor timestamptz;
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);

  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND pc.vence_at > now()
  ORDER BY pc.primer_acumulado_at ASC
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_anchor := COALESCE(p_anchor_at, now());

  BEGIN
    INSERT INTO public.points_cycles (
      id_cliente,
      primer_acumulado_at,
      vence_at,
      estado_ciclo_codigo
    )
    VALUES (
      p_id_cliente,
      v_anchor,
      v_anchor + make_interval(months => GREATEST(p_expiracion_meses, 1)),
      'activo'
    )
    RETURNING * INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    SELECT *
    INTO v_inserted
    FROM public.points_cycles
    WHERE id_cliente = p_id_cliente
      AND estado_ciclo_codigo = 'activo'
    ORDER BY primer_acumulado_at ASC
    LIMIT 1;
  END;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.fn_points_get_effective_rule(p_id_sucursal uuid) RETURNS TABLE(id_rule uuid, id_sucursal uuid, umbral_monto_hnl numeric, puntos_por_cita integer, puntos_para_premio integer, expiracion_meses integer, activo boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    pr.id_rule,
    pr.id_sucursal,
    pr.umbral_monto_hnl,
    pr.puntos_por_cita,
    pr.puntos_para_premio,
    pr.expiracion_meses,
    pr.activo
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = p_id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = p_id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC,
    pr.created_at DESC,
    pr.id_rule DESC
  LIMIT 1
$$;

CREATE FUNCTION public.fn_points_tx_apply_tipo_sign() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_signo integer;
BEGIN
  IF NEW.puntos = 0 THEN
    RAISE EXCEPTION 'points_transactions.puntos no puede ser 0';
  END IF;

  SELECT tp.signo
  INTO v_signo
  FROM public.tipos_puntos tp
  WHERE tp.tipo_puntos_codigo = NEW.tipo_puntos_codigo
  LIMIT 1;

  IF v_signo = 1 THEN
    NEW.puntos := abs(NEW.puntos);
  ELSIF v_signo = -1 THEN
    NEW.puntos := -abs(NEW.puntos);
  END IF;

  RETURN NEW;
END;
$$;
