-- AM: Definiciones de QA leidas sin escrituras el 2026-11-12; solo fixture local, no migracion.
CREATE OR REPLACE VIEW public.vw_points_balance AS
 WITH ledger_balance AS (
         SELECT pt.id_cliente,
            COALESCE(sum(pt.puntos), 0::bigint) AS ledger_points
           FROM points_transactions pt
          GROUP BY pt.id_cliente
        ), pending_expired_cycles AS (
         SELECT pc.id_cliente,
            pc.id_cycle,
            COALESCE(sum(pt.puntos), 0::bigint) AS remaining_points
           FROM points_cycles pc
             JOIN points_transactions pt ON pt.id_cycle = pc.id_cycle
          WHERE pc.estado_ciclo_codigo = 'activo'::text AND pc.vence_at IS NOT NULL AND pc.vence_at <= now()
          GROUP BY pc.id_cliente, pc.id_cycle
        ), pending_expiration_by_client AS (
         SELECT pec.id_cliente,
            COALESCE(sum(
                CASE
                    WHEN pec.remaining_points > 0 THEN pec.remaining_points
                    ELSE 0::bigint
                END), 0::bigint::numeric) AS pending_expired_points
           FROM pending_expired_cycles pec
          GROUP BY pec.id_cliente
        )
 SELECT lb.id_cliente,
    (lb.ledger_points::numeric - COALESCE(pe.pending_expired_points, 0::bigint::numeric))::integer AS balance_puntos
   FROM ledger_balance lb
     LEFT JOIN pending_expiration_by_client pe ON pe.id_cliente = lb.id_cliente;;

CREATE OR REPLACE FUNCTION public.fn_points_estado_final_cita()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_estado text;
BEGIN
  SELECT ec.estado_cita_codigo
  INTO v_estado
  FROM public.estados_cita ec
  WHERE lower(trim(ec.estado_cita_codigo)) IN ('completada','atendida','finalizada')
  ORDER BY
    CASE lower(trim(ec.estado_cita_codigo))
      WHEN 'completada' THEN 1
      WHEN 'atendida' THEN 2
      WHEN 'finalizada' THEN 3
      ELSE 99
    END
  LIMIT 1;

  IF v_estado IS NULL THEN
    v_estado := 'completada';
  END IF;

  RETURN v_estado;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_final text;
  v_estado_cita text;
  v_orden integer;
  v_es_canje boolean;
  v_origen text;
BEGIN
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  SELECT
    c.estado_cita_codigo,
    COALESCE(c.orden_integrante, 1),
    COALESCE(c.es_canje_recompensa, false)
  INTO v_estado_cita, v_orden, v_es_canje
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita
    AND c.deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_estado_cita IS DISTINCT FROM v_estado_final THEN
    RETURN NULL;
  END IF;

  v_origen := COALESCE(
    NULLIF(trim(NEW.origen_punto_codigo), ''),
    CASE WHEN v_orden > 1 THEN 'integrante' ELSE 'titular' END
  );

  NEW.origen_punto_codigo := v_origen;

  IF v_es_canje IS TRUE AND v_origen = 'titular' THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_final text;
  v_origen text;
  v_puntos_por_cita integer := 1;
  v_cycle record;
  v_cliente_usuario uuid;
BEGIN
  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado_cita_codigo IS DISTINCT FROM v_estado_final THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.estado_cita_codigo IS DISTINCT FROM NEW.estado_cita_codigo
      AND NEW.estado_cita_codigo = v_estado_final
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.id_cliente IS NULL THEN
    RETURN NEW;
  END IF;

  v_origen := CASE
    WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante'
    ELSE 'titular'
  END;

  IF COALESCE(NEW.es_canje_recompensa, false) IS TRUE AND v_origen = 'titular' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(pr.puntos_por_cita, 1)
  INTO v_puntos_por_cita
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = NEW.id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = NEW.id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC NULLS LAST,
    pr.created_at DESC NULLS LAST
  LIMIT 1;

  SELECT *
  INTO v_cycle
  FROM public.fn_points_get_or_create_active_cycle(
    NEW.id_cliente,
    COALESCE(NEW.inicio_at, now())
  )
  LIMIT 1;

  SELECT c.id_usuario
  INTO v_cliente_usuario
  FROM public.clientes c
  WHERE c.id_cliente = NEW.id_cliente
    AND c.deleted_at IS NULL
  LIMIT 1;

  INSERT INTO public.points_transactions (
    id_cliente,
    id_cita,
    id_cycle,
    id_sucursal_origen,
    tipo_puntos_codigo,
    origen_punto_codigo,
    puntos,
    vence_at,
    motivo,
    creado_por_usuario_id,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id_cliente,
    NEW.id_cita,
    v_cycle.id_cycle,
    NEW.id_sucursal,
    'acumular',
    v_origen,
    GREATEST(1, COALESCE(v_puntos_por_cita, 1)),
    v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante'
      THEN 'Punto por acompañante en visita completada'
      ELSE 'Punto por visita completada del titular'
    END,
    COALESCE(NEW.creada_por_usuario_id, v_cliente_usuario),
    now(),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;
