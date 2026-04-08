-- AM: Soporte operativo de membresias (aditivo) para adquisicion, consumo y alertas.
-- No rompe contratos actuales: extiende modelo existente de subscriptions.

-- ============================================================================
-- subscriptions: snapshot de beneficios + metadata comercial de vigencia/fin
-- ============================================================================
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS beneficios_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS id_sucursal_contratada uuid,
  ADD COLUMN IF NOT EXISTS motivo_fin_codigo text;

UPDATE public.subscriptions
SET beneficios_snapshot = COALESCE(beneficios_snapshot, '{"version":1,"items":[]}'::jsonb)
WHERE beneficios_snapshot IS NULL;

ALTER TABLE public.subscriptions
  ALTER COLUMN beneficios_snapshot SET DEFAULT '{"version":1,"items":[]}'::jsonb,
  ALTER COLUMN beneficios_snapshot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_sub_sucursal_contratada'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT fk_sub_sucursal_contratada
      FOREIGN KEY (id_sucursal_contratada)
      REFERENCES public.sucursales(id_sucursal)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_sub_motivo_fin'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT ck_sub_motivo_fin
      CHECK (
        motivo_fin_codigo IS NULL
        OR motivo_fin_codigo IN ('tiempo', 'agotamiento', 'reemplazo', 'cancelacion')
      );
  END IF;
END
$$;

-- AM: Compatibilidad: si existen múltiples suscripciones activas por cliente
-- AM: (estado heredado previo), se conserva la más reciente y se cierran las demás
-- AM: para permitir crear el índice único parcial sin romper la migración.
WITH active_ranked AS (
  SELECT
    s.id_suscripcion,
    s.id_cliente,
    ROW_NUMBER() OVER (
      PARTITION BY s.id_cliente
      ORDER BY s.created_at DESC, s.id_suscripcion DESC
    ) AS rn
  FROM public.subscriptions s
  WHERE s.estado_suscripcion_codigo = 'activa'
),
duplicated_active AS (
  SELECT id_suscripcion
  FROM active_ranked
  WHERE rn > 1
)
UPDATE public.subscriptions s
SET estado_suscripcion_codigo = 'vencida',
    motivo_fin_codigo = COALESCE(s.motivo_fin_codigo, 'reemplazo'),
    updated_at = now()
FROM duplicated_active d
WHERE s.id_suscripcion = d.id_suscripcion;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_cliente_activa
  ON public.subscriptions (id_cliente)
  WHERE estado_suscripcion_codigo = 'activa';

CREATE INDEX IF NOT EXISTS idx_subscriptions_cliente_fin
  ON public.subscriptions (id_cliente, fin_at DESC);

-- ============================================================================
-- Ledger de consumo: cubierto por plan vs extras pendientes
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.subscription_consumptions (
  id_consumo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_suscripcion uuid NOT NULL,
  id_cliente uuid NOT NULL,
  id_cita uuid NOT NULL,
  orden_integrante integer NULL,
  item_tipo text NOT NULL,
  id_servicio uuid NULL,
  item_codigo text NULL,
  item_nombre text NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario_hnl numeric(12,2) NOT NULL DEFAULT 0,
  total_hnl numeric(12,2) NOT NULL DEFAULT 0,
  coverage_status text NOT NULL,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_subc_sub FOREIGN KEY (id_suscripcion) REFERENCES public.subscriptions(id_suscripcion) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_subc_cliente FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_subc_cita FOREIGN KEY (id_cita) REFERENCES public.citas(id_cita) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_subc_servicio FOREIGN KEY (id_servicio) REFERENCES public.servicios(id_servicio) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT ck_subc_item_tipo CHECK (item_tipo IN ('servicio', 'cortesia')),
  CONSTRAINT ck_subc_cantidad CHECK (cantidad > 0),
  CONSTRAINT ck_subc_precios CHECK (precio_unitario_hnl >= 0 AND total_hnl >= 0),
  CONSTRAINT ck_subc_coverage_status CHECK (coverage_status IN ('cubierto_plan', 'extra_pendiente', 'extra_pagado')),
  CONSTRAINT uq_subc_source_key UNIQUE (source_key)
);

CREATE INDEX IF NOT EXISTS idx_subc_suscripcion
  ON public.subscription_consumptions (id_suscripcion, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subc_cliente
  ON public.subscription_consumptions (id_cliente, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subc_cita
  ON public.subscription_consumptions (id_cita);

CREATE INDEX IF NOT EXISTS idx_subc_coverage
  ON public.subscription_consumptions (coverage_status, created_at DESC);

-- ============================================================================
-- Alertas idempotentes por suscripcion (adquisicion / vencimiento / saldo)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.subscription_alert_events (
  id_alert_event uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_suscripcion uuid NOT NULL,
  alert_type text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_suba_sub FOREIGN KEY (id_suscripcion) REFERENCES public.subscriptions(id_suscripcion) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ck_suba_type CHECK (alert_type IN ('adquisicion', 'vencimiento_3_dias', 'saldo_1_1')),
  CONSTRAINT uq_suba_unique_alert UNIQUE (id_suscripcion, alert_type)
);

CREATE INDEX IF NOT EXISTS idx_suba_sub_sent_at
  ON public.subscription_alert_events (id_suscripcion, sent_at DESC);

-- ============================================================================
-- Masterpuntos: origen del punto para distinguir titular vs integrante
-- ============================================================================
ALTER TABLE public.points_transactions
  ADD COLUMN IF NOT EXISTS origen_punto_codigo text;

UPDATE public.points_transactions
SET origen_punto_codigo = COALESCE(origen_punto_codigo, 'titular')
WHERE origen_punto_codigo IS NULL;

ALTER TABLE public.points_transactions
  ALTER COLUMN origen_punto_codigo SET DEFAULT 'titular',
  ALTER COLUMN origen_punto_codigo SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_points_tx_origen'
  ) THEN
    ALTER TABLE public.points_transactions
      ADD CONSTRAINT ck_points_tx_origen
      CHECK (origen_punto_codigo IN ('titular', 'integrante', 'sistema'));
  END IF;
END
$$;

DROP INDEX IF EXISTS uq_points_tx_ganancia_por_cita_origen;
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_tx_ganancia_por_cita_origen
  ON public.points_transactions (id_cita, tipo_puntos_codigo, origen_punto_codigo)
  WHERE (id_cita IS NOT NULL AND tipo_puntos_codigo = 'acumular');

-- ============================================================================
-- Trigger aditivo: 1 Masterpunto por cita confirmada cubierta por plan
-- titular = dorado, integrante = color secundario en frontend.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_has_plan_usage boolean := false;
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
      AND sc.coverage_status = 'cubierto_plan'
  )
  INTO v_has_plan_usage;

  IF NOT v_has_plan_usage THEN
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
      ELSE 'Punto por cita titular cubierta por plan'
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
