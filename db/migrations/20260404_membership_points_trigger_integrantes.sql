-- AM: Ajuste de compatibilidad para otorgar 1 punto por cita confirmada asociada a membresía.
-- AM: Aplica tanto para titular como para integrantes.
-- AM: Regla: si la cita tiene registros en subscription_consumptions, suma punto según origen.

CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_has_membership_consumption boolean := false;
  v_origen text := 'titular';
  v_cliente_usuario uuid;
  v_cycle record;
  v_rule record;
  v_exp_meses integer := 12;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado_cita_codigo <> 'confirmada' THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.estado_cita_codigo IS DISTINCT FROM NEW.estado_cita_codigo
      AND NEW.estado_cita_codigo = 'confirmada'
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.id_cliente IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.subscription_consumptions sc
    WHERE sc.id_cita = NEW.id_cita
  )
  INTO v_has_membership_consumption;

  IF NOT v_has_membership_consumption THEN
    RETURN NEW;
  END IF;

  v_origen := CASE
    WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante'
    ELSE 'titular'
  END;

  SELECT c.id_usuario
  INTO v_cliente_usuario
  FROM public.clientes c
  WHERE c.id_cliente = NEW.id_cliente
    AND c.deleted_at IS NULL
  LIMIT 1;

  SELECT *
  INTO v_rule
  FROM public.fn_points_get_effective_rule(NEW.id_sucursal)
  LIMIT 1;

  IF v_rule.id_rule IS NOT NULL THEN
    v_exp_meses := COALESCE(v_rule.expiracion_meses, 12);
  END IF;

  SELECT *
  INTO v_cycle
  FROM public.fn_points_get_or_create_active_cycle(
    NEW.id_cliente,
    v_exp_meses,
    COALESCE(NEW.inicio_at, now())
  )
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
    1,
    v_cycle.vence_at,
    CASE
      WHEN v_origen = 'integrante' THEN 'Punto por integrante en cita con plan'
      ELSE 'Punto por cita titular asociada a plan'
    END,
    COALESCE(NEW.creada_por_usuario_id, v_cliente_usuario),
    now(),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tr_points_plan_cita_confirmada ON public.citas;

CREATE TRIGGER tr_points_plan_cita_confirmada
AFTER INSERT OR UPDATE OF estado_cita_codigo
ON public.citas
FOR EACH ROW
EXECUTE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada();
