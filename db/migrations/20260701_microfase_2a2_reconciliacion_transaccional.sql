BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

SELECT pg_advisory_xact_lock(hashtext('masterfade:microfase_2a2_reconciliacion_transaccional'));

CREATE EXTENSION IF NOT EXISTS btree_gist;

LOCK TABLE public.citas IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.citas_detalles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.citas_grupos IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.citas_holds IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.payment_intents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.servicios_tarifas IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.citas_detalles
  ADD COLUMN IF NOT EXISTS precio_referencia_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_porcentaje numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_linea_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS id_tarifa uuid,
  ADD COLUMN IF NOT EXISTS incluye_isv_snapshot boolean NOT NULL DEFAULT false;

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS id_grupo_cita uuid;

UPDATE public.citas_detalles
SET
  precio_referencia_hnl = COALESCE(precio_referencia_hnl, 0),
  descuento_hnl = COALESCE(descuento_hnl, 0),
  isv_porcentaje = COALESCE(isv_porcentaje, 0),
  isv_hnl = COALESCE(isv_hnl, 0),
  total_linea_hnl = COALESCE(total_linea_hnl, 0),
  incluye_isv_snapshot = COALESCE(incluye_isv_snapshot, false)
WHERE precio_referencia_hnl IS NULL
   OR descuento_hnl IS NULL
   OR isv_porcentaje IS NULL
   OR isv_hnl IS NULL
   OR total_linea_hnl IS NULL
   OR incluye_isv_snapshot IS NULL;

ALTER TABLE public.citas_detalles
  ALTER COLUMN precio_referencia_hnl SET DEFAULT 0,
  ALTER COLUMN precio_referencia_hnl SET NOT NULL,
  ALTER COLUMN descuento_hnl SET DEFAULT 0,
  ALTER COLUMN descuento_hnl SET NOT NULL,
  ALTER COLUMN isv_porcentaje SET DEFAULT 0,
  ALTER COLUMN isv_porcentaje SET NOT NULL,
  ALTER COLUMN isv_hnl SET DEFAULT 0,
  ALTER COLUMN isv_hnl SET NOT NULL,
  ALTER COLUMN total_linea_hnl SET DEFAULT 0,
  ALTER COLUMN total_linea_hnl SET NOT NULL,
  ALTER COLUMN incluye_isv_snapshot SET DEFAULT false,
  ALTER COLUMN incluye_isv_snapshot SET NOT NULL;

UPDATE public.citas_detalles
SET precio_referencia_hnl = ROUND(COALESCE(precio_unitario_hnl, 0), 2)
WHERE COALESCE(precio_referencia_hnl, 0) = 0
  AND COALESCE(precio_unitario_hnl, 0) > 0;

DO $$
BEGIN
  IF EXISTS (
    WITH candidatos AS (
      SELECT
        cd.id_cita_detalle,
        st.id_tarifa,
        CASE WHEN st.id_empleado = c.id_empleado_barbero THEN 0 ELSE 1 END AS scope_rank
      FROM public.citas_detalles cd
      JOIN public.citas c
        ON c.id_cita = cd.id_cita
      JOIN public.servicios s
        ON s.id_servicio = cd.id_servicio
      JOIN public.servicios_tarifas st
        ON st.id_servicio = cd.id_servicio
       AND st.id_sucursal = c.id_sucursal
       AND st.deleted_at IS NULL
       AND st.activo IS TRUE
       AND (st.id_empleado IS NULL OR st.id_empleado = c.id_empleado_barbero)
       AND st.vigente_desde <= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
       AND (
         st.vigente_hasta IS NULL
         OR st.vigente_hasta >= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
       )
       AND ROUND(st.precio_hnl, 2) = ROUND(COALESCE(cd.precio_unitario_hnl, 0), 2)
       AND COALESCE(st.duracion_min, s.duracion_min) = cd.duracion_min
       AND COALESCE(st.buffer_min, s.buffer_min, 0) = cd.buffer_min
      WHERE cd.id_tarifa IS NULL
    ),
    mejor_scope AS (
      SELECT id_cita_detalle, MIN(scope_rank) AS scope_rank
      FROM candidatos
      GROUP BY id_cita_detalle
    ),
    finales AS (
      SELECT c.id_cita_detalle, COUNT(*) AS total
      FROM candidatos c
      JOIN mejor_scope ms
        ON ms.id_cita_detalle = c.id_cita_detalle
       AND ms.scope_rank = c.scope_rank
      GROUP BY c.id_cita_detalle
    )
    SELECT 1
    FROM public.citas_detalles cd
    LEFT JOIN finales f
      ON f.id_cita_detalle = cd.id_cita_detalle
    WHERE cd.id_tarifa IS NULL
      AND COALESCE(f.total, 0) <> 1
  ) THEN
    RAISE EXCEPTION 'MF2A2_BACKFILL_ID_TARIFA_AMBIGUO_O_INEXISTENTE';
  END IF;
END $$;

WITH candidatos AS (
  SELECT
    cd.id_cita_detalle,
    st.id_tarifa,
    CASE WHEN st.id_empleado = c.id_empleado_barbero THEN 0 ELSE 1 END AS scope_rank
  FROM public.citas_detalles cd
  JOIN public.citas c
    ON c.id_cita = cd.id_cita
  JOIN public.servicios s
    ON s.id_servicio = cd.id_servicio
  JOIN public.servicios_tarifas st
    ON st.id_servicio = cd.id_servicio
   AND st.id_sucursal = c.id_sucursal
   AND st.deleted_at IS NULL
   AND st.activo IS TRUE
   AND (st.id_empleado IS NULL OR st.id_empleado = c.id_empleado_barbero)
   AND st.vigente_desde <= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
   AND (
     st.vigente_hasta IS NULL
     OR st.vigente_hasta >= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
   )
   AND ROUND(st.precio_hnl, 2) = ROUND(COALESCE(cd.precio_unitario_hnl, 0), 2)
   AND COALESCE(st.duracion_min, s.duracion_min) = cd.duracion_min
   AND COALESCE(st.buffer_min, s.buffer_min, 0) = cd.buffer_min
  WHERE cd.id_tarifa IS NULL
),
mejor_scope AS (
  SELECT id_cita_detalle, MIN(scope_rank) AS scope_rank
  FROM candidatos
  GROUP BY id_cita_detalle
),
unicos AS (
  SELECT c.id_cita_detalle, c.id_tarifa
  FROM candidatos c
  JOIN mejor_scope ms
    ON ms.id_cita_detalle = c.id_cita_detalle
   AND ms.scope_rank = c.scope_rank
  WHERE NOT EXISTS (
    SELECT 1
    FROM candidatos other
    WHERE other.id_cita_detalle = c.id_cita_detalle
      AND other.scope_rank = c.scope_rank
      AND other.id_tarifa <> c.id_tarifa
  )
)
UPDATE public.citas_detalles cd
SET id_tarifa = u.id_tarifa
FROM unicos u
WHERE u.id_cita_detalle = cd.id_cita_detalle
  AND cd.id_tarifa IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    WHERE id_tarifa IS NULL
  ) THEN
    RAISE EXCEPTION 'MF2A2_VALIDACION_BACKFILL_ID_TARIFA_INCOMPLETO';
  END IF;
END $$;

UPDATE public.citas_detalles
SET
  subtotal_hnl = ROUND(COALESCE(precio_unitario_hnl, 0) * COALESCE(cantidad, 1), 2),
  descuento_hnl = LEAST(GREATEST(COALESCE(descuento_hnl, 0), 0), ROUND(COALESCE(precio_unitario_hnl, 0) * COALESCE(cantidad, 1), 2)),
  incluye_isv_snapshot = COALESCE(incluye_isv_snapshot, false),
  isv_porcentaje = LEAST(GREATEST(COALESCE(isv_porcentaje, 0), 0), 100);

UPDATE public.citas_detalles
SET
  isv_hnl = CASE
    WHEN isv_porcentaje <= 0 THEN 0
    WHEN incluye_isv_snapshot IS TRUE THEN ROUND(
      GREATEST(0, subtotal_hnl - descuento_hnl)
      - (GREATEST(0, subtotal_hnl - descuento_hnl) / (1 + isv_porcentaje / 100)),
      2
    )
    ELSE ROUND((GREATEST(0, subtotal_hnl - descuento_hnl) * isv_porcentaje) / 100, 2)
  END;

UPDATE public.citas_detalles
SET total_linea_hnl = GREATEST(
  0,
  ROUND(
    (subtotal_hnl - descuento_hnl)
    + CASE WHEN incluye_isv_snapshot IS TRUE THEN 0 ELSE isv_hnl END,
    2
  )
);

UPDATE public.payment_intents pi
SET id_grupo_cita = c.id_grupo_cita
FROM public.citas c
WHERE pi.id_cita = c.id_cita
  AND pi.id_grupo_cita IS NULL
  AND c.id_grupo_cita IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_detalles_tarifa'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT fk_citas_detalles_tarifa
      FOREIGN KEY (id_tarifa)
      REFERENCES public.servicios_tarifas(id_tarifa)
      ON UPDATE CASCADE
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_payment_intents_grupo_cita'
      AND conrelid = 'public.payment_intents'::regclass
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT fk_payment_intents_grupo_cita
      FOREIGN KEY (id_grupo_cita)
      REFERENCES public.citas_grupos(id_grupo_cita)
      ON UPDATE CASCADE
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.citas_detalles
  DROP CONSTRAINT IF EXISTS ck_citas_detalles_montos_normalizados_non_negative,
  DROP CONSTRAINT IF EXISTS ck_citas_detalles_isv_formula,
  DROP CONSTRAINT IF EXISTS ck_citas_detalles_total_linea_formula;

ALTER TABLE public.citas_detalles
  ADD CONSTRAINT ck_citas_detalles_montos_normalizados_non_negative
  CHECK (
    precio_referencia_hnl >= 0
    AND descuento_hnl >= 0
    AND descuento_hnl <= subtotal_hnl
    AND isv_porcentaje >= 0
    AND isv_porcentaje <= 100
    AND isv_hnl >= 0
    AND total_linea_hnl >= 0
  ) NOT VALID,
  ADD CONSTRAINT ck_citas_detalles_isv_formula
  CHECK (
    isv_hnl = CASE
      WHEN isv_porcentaje <= 0 THEN 0
      WHEN incluye_isv_snapshot IS TRUE THEN ROUND(
        GREATEST(0, subtotal_hnl - descuento_hnl)
        - (GREATEST(0, subtotal_hnl - descuento_hnl) / (1 + isv_porcentaje / 100)),
        2
      )
      ELSE ROUND((GREATEST(0, subtotal_hnl - descuento_hnl) * isv_porcentaje) / 100, 2)
    END
  ) NOT VALID,
  ADD CONSTRAINT ck_citas_detalles_total_linea_formula
  CHECK (
    total_linea_hnl = GREATEST(
      0,
      ROUND(
        (subtotal_hnl - descuento_hnl)
        + CASE WHEN incluye_isv_snapshot IS TRUE THEN 0 ELSE isv_hnl END,
        2
      )
    )
  ) NOT VALID;

ALTER TABLE public.citas_detalles VALIDATE CONSTRAINT ck_citas_detalles_montos_normalizados_non_negative;
ALTER TABLE public.citas_detalles VALIDATE CONSTRAINT ck_citas_detalles_isv_formula;
ALTER TABLE public.citas_detalles VALIDATE CONSTRAINT ck_citas_detalles_total_linea_formula;
ALTER TABLE public.citas_detalles VALIDATE CONSTRAINT fk_citas_detalles_tarifa;
ALTER TABLE public.payment_intents VALIDATE CONSTRAINT fk_payment_intents_grupo_cita;

ALTER TABLE public.citas
  DROP CONSTRAINT IF EXISTS ex_citas_solape_barbero;

ALTER TABLE public.citas
  ADD CONSTRAINT ex_citas_solape_barbero
  EXCLUDE USING gist (
    id_empleado_barbero WITH =,
    tstzrange(inicio_at, fin_at, '[)') WITH &&
  )
  WHERE (
    deleted_at IS NULL
    AND estado_cita_codigo = ANY (ARRAY[
      'en_espera'::text,
      'pendiente_pago'::text,
      'confirmada'::text,
      'en_salon'::text,
      'en_atencion'::text
    ])
  );

ALTER TABLE public.servicios_tarifas
  DROP CONSTRAINT IF EXISTS ex_servicios_tarifas_scope_vigencia;

ALTER TABLE public.servicios_tarifas
  ADD CONSTRAINT ex_servicios_tarifas_scope_vigencia
  EXCLUDE USING gist (
    id_servicio WITH =,
    id_sucursal WITH =,
    COALESCE(id_empleado, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange(vigente_desde, COALESCE(vigente_hasta, 'infinity'::date), '[]') WITH &&
  )
  WHERE (deleted_at IS NULL AND activo IS TRUE)
  DEFERRABLE;

CREATE INDEX IF NOT EXISTS idx_citas_detalles_id_tarifa
  ON public.citas_detalles (id_tarifa)
  WHERE id_tarifa IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citas_detalles_origen_item
  ON public.citas_detalles (origen_item_codigo);

CREATE INDEX IF NOT EXISTS idx_payment_intents_id_grupo_cita
  ON public.payment_intents (id_grupo_cita)
  WHERE id_grupo_cita IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_servicios_tarifas_resolucion_fecha
  ON public.servicios_tarifas (
    id_sucursal,
    id_servicio,
    id_empleado,
    vigente_desde DESC,
    vigente_hasta,
    updated_at DESC
  )
  WHERE deleted_at IS NULL
    AND activo IS TRUE;

CREATE OR REPLACE FUNCTION public.fn_citas_detalles_normalizar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cita record;
  v_servicio record;
  v_tarifa record;
  v_fecha_operativa date;
  v_base_despues_descuento numeric;
BEGIN
  SELECT c.id_sucursal, c.id_empleado_barbero, c.inicio_at
  INTO v_cita
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_CITA_NO_EXISTE';
  END IF;

  SELECT s.nombre_servicio, s.duracion_min, s.buffer_min
  INTO v_servicio
  FROM public.servicios s
  WHERE s.id_servicio = NEW.id_servicio;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_SERVICIO_NO_EXISTE';
  END IF;

  v_fecha_operativa := (v_cita.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date;
  NEW.nombre_servicio_snapshot := COALESCE(NULLIF(btrim(NEW.nombre_servicio_snapshot), ''), v_servicio.nombre_servicio, 'Servicio no disponible');

  IF NEW.id_tarifa IS NULL THEN
    SELECT
      st.id_tarifa,
      st.id_servicio,
      st.id_sucursal,
      st.id_empleado,
      st.precio_hnl,
      COALESCE(st.incluye_isv, false) AS incluye_isv,
      COALESCE(st.isv_porcentaje, 0) AS isv_porcentaje,
      COALESCE(st.duracion_min, v_servicio.duracion_min) AS duracion_min,
      COALESCE(st.buffer_min, v_servicio.buffer_min) AS buffer_min
    INTO v_tarifa
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = NEW.id_servicio
      AND st.id_sucursal = v_cita.id_sucursal
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND (st.id_empleado IS NULL OR st.id_empleado = v_cita.id_empleado_barbero)
      AND st.vigente_desde <= v_fecha_operativa
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= v_fecha_operativa)
    ORDER BY
      CASE WHEN st.id_empleado = v_cita.id_empleado_barbero THEN 0 ELSE 1 END,
      st.vigente_desde DESC,
      st.updated_at DESC,
      st.id_tarifa DESC
    LIMIT 1;
  ELSE
    SELECT
      st.id_tarifa,
      st.id_servicio,
      st.id_sucursal,
      st.id_empleado,
      st.precio_hnl,
      COALESCE(st.incluye_isv, false) AS incluye_isv,
      COALESCE(st.isv_porcentaje, 0) AS isv_porcentaje,
      COALESCE(st.duracion_min, v_servicio.duracion_min) AS duracion_min,
      COALESCE(st.buffer_min, v_servicio.buffer_min) AS buffer_min
    INTO v_tarifa
    FROM public.servicios_tarifas st
    WHERE st.id_tarifa = NEW.id_tarifa
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_TARIFA_VIGENTE_NO_ENCONTRADA';
  END IF;

  IF v_tarifa.id_servicio IS DISTINCT FROM NEW.id_servicio THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_TARIFA_SERVICIO_MISMATCH';
  END IF;
  IF v_tarifa.id_sucursal IS DISTINCT FROM v_cita.id_sucursal THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_TARIFA_SUCURSAL_MISMATCH';
  END IF;
  IF v_tarifa.id_empleado IS NOT NULL AND v_tarifa.id_empleado IS DISTINCT FROM v_cita.id_empleado_barbero THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_TARIFA_BARBERO_MISMATCH';
  END IF;
  IF NEW.duracion_min IS DISTINCT FROM v_tarifa.duracion_min THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_DURACION_MISMATCH';
  END IF;
  IF NEW.buffer_min IS DISTINCT FROM v_tarifa.buffer_min THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_BUFFER_MISMATCH';
  END IF;
  IF ROUND(COALESCE(NEW.precio_unitario_hnl, 0), 2) IS DISTINCT FROM ROUND(COALESCE(v_tarifa.precio_hnl, 0), 2) THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_PRECIO_UNITARIO_MISMATCH';
  END IF;

  NEW.id_tarifa := v_tarifa.id_tarifa;
  NEW.precio_referencia_hnl := COALESCE(NULLIF(NEW.precio_referencia_hnl, 0), v_tarifa.precio_hnl, NEW.precio_unitario_hnl, 0);
  NEW.incluye_isv_snapshot := COALESCE(NEW.incluye_isv_snapshot, false);
  NEW.isv_porcentaje := LEAST(GREATEST(COALESCE(NEW.isv_porcentaje, 0), 0), 100);
  NEW.subtotal_hnl := ROUND(NEW.precio_unitario_hnl * NEW.cantidad, 2);

  IF NEW.descuento_hnl < 0 OR NEW.descuento_hnl > NEW.subtotal_hnl THEN
    RAISE EXCEPTION 'MF2A2_CITA_DETALLE_DESCUENTO_INVALIDO';
  END IF;

  v_base_despues_descuento := GREATEST(0::numeric, NEW.subtotal_hnl - NEW.descuento_hnl);
  NEW.isv_hnl := CASE
    WHEN NEW.isv_porcentaje <= 0 THEN 0
    WHEN NEW.incluye_isv_snapshot IS TRUE THEN ROUND(v_base_despues_descuento - (v_base_despues_descuento / (1 + NEW.isv_porcentaje / 100)), 2)
    ELSE ROUND((v_base_despues_descuento * NEW.isv_porcentaje) / 100, 2)
  END;
  NEW.total_linea_hnl := ROUND(
    v_base_despues_descuento + CASE WHEN NEW.incluye_isv_snapshot IS TRUE THEN 0 ELSE NEW.isv_hnl END,
    2
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_recalcular_cita(p_cita_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inicio timestamptz;
  v_fin_actual timestamptz;
  v_fin_calculado timestamptz;
  v_duracion integer;
  v_buffer integer;
  v_subtotal_detalles numeric;
  v_descuento_detalles numeric;
  v_total_detalles numeric;
  v_subtotal_extras numeric;
  v_descuento_extras numeric;
  v_total_extras numeric;
  v_cantidad_paquetes integer;
  v_precio_lista_paquete numeric;
  v_descuento_paquete numeric;
  v_total_paquete numeric;
  v_subtotal_final numeric;
  v_descuento_final numeric;
  v_total_final numeric;
BEGIN
  SELECT c.inicio_at, c.fin_at
  INTO v_inicio, v_fin_actual
  FROM public.citas c
  WHERE c.id_cita = p_cita_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(cd.duracion_min * cd.cantidad), 0)::integer,
    COALESCE(MAX(cd.buffer_min), 0)::integer,
    COALESCE(SUM(cd.subtotal_hnl), 0),
    COALESCE(SUM(cd.descuento_hnl), 0),
    COALESCE(SUM(cd.total_linea_hnl), 0),
    COALESCE(SUM(cd.subtotal_hnl) FILTER (WHERE cd.origen_item_codigo <> 'paquete_incluido'), 0),
    COALESCE(SUM(cd.descuento_hnl) FILTER (WHERE cd.origen_item_codigo <> 'paquete_incluido'), 0),
    COALESCE(SUM(cd.total_linea_hnl) FILTER (WHERE cd.origen_item_codigo <> 'paquete_incluido'), 0)
  INTO
    v_duracion,
    v_buffer,
    v_subtotal_detalles,
    v_descuento_detalles,
    v_total_detalles,
    v_subtotal_extras,
    v_descuento_extras,
    v_total_extras
  FROM public.citas_detalles cd
  WHERE cd.id_cita = p_cita_id;

  SELECT
    COUNT(*)::integer,
    COALESCE(SUM(cp.precio_lista_hnl), 0),
    COALESCE(SUM(cp.descuento_hnl), 0),
    COALESCE(SUM(cp.total_hnl), 0)
  INTO
    v_cantidad_paquetes,
    v_precio_lista_paquete,
    v_descuento_paquete,
    v_total_paquete
  FROM public.citas_paquetes cp
  WHERE cp.id_cita = p_cita_id;

  IF v_cantidad_paquetes > 0 THEN
    v_subtotal_final := v_precio_lista_paquete + v_subtotal_extras;
    v_descuento_final := v_descuento_paquete + v_descuento_extras;
    v_total_final := v_total_paquete + v_total_extras;
  ELSE
    v_subtotal_final := v_subtotal_detalles;
    v_descuento_final := v_descuento_detalles;
    v_total_final := v_total_detalles;
  END IF;

  v_subtotal_final := ROUND(COALESCE(v_subtotal_final, 0), 2);
  v_descuento_final := ROUND(COALESCE(v_descuento_final, 0), 2);
  v_total_final := ROUND(COALESCE(v_total_final, 0), 2);
  v_fin_calculado := CASE
    WHEN v_duracion > 0 THEN v_inicio + make_interval(mins => v_duracion + v_buffer)
    ELSE v_fin_actual
  END;

  UPDATE public.citas c
  SET
    duracion_total_min = v_duracion,
    buffer_total_min = v_buffer,
    subtotal_servicios_hnl = v_subtotal_final,
    descuento_hnl = v_descuento_final,
    total_pagar_hnl = v_total_final,
    fin_at = v_fin_calculado,
    updated_at = now()
  WHERE c.id_cita = p_cita_id
    AND (
         c.duracion_total_min IS DISTINCT FROM v_duracion
      OR c.buffer_total_min IS DISTINCT FROM v_buffer
      OR c.subtotal_servicios_hnl IS DISTINCT FROM v_subtotal_final
      OR c.descuento_hnl IS DISTINCT FROM v_descuento_final
      OR c.total_pagar_hnl IS DISTINCT FROM v_total_final
      OR c.fin_at IS DISTINCT FROM v_fin_calculado
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sincronizar_grupo_cita(p_id_grupo_cita uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total_citas integer;
  v_total_hnl numeric;
  v_todas_completadas boolean;
  v_todas_terminales boolean;
  v_estado_destino text;
BEGIN
  IF p_id_grupo_cita IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*)::integer,
    COALESCE(SUM(c.total_pagar_hnl), 0),
    COALESCE(BOOL_AND(c.estado_cita_codigo = 'completada'), false),
    COALESCE(BOOL_AND(c.estado_cita_codigo IN ('cancelada','cancelada_por_cliente','expirada','no_show','anulada','completada')), false)
  INTO v_total_citas, v_total_hnl, v_todas_completadas, v_todas_terminales
  FROM public.citas c
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL;

  IF v_total_citas = 0 THEN
    v_estado_destino := 'cancelado';
  ELSIF v_todas_completadas THEN
    v_estado_destino := 'completado';
  ELSIF v_todas_terminales THEN
    v_estado_destino := 'cancelado';
  ELSE
    v_estado_destino := 'activo';
  END IF;

  UPDATE public.citas_grupos cg
  SET
    total_hnl = ROUND(COALESCE(v_total_hnl, 0), 2),
    estado_grupo_codigo = v_estado_destino,
    updated_at = now()
  WHERE cg.id_grupo_cita = p_id_grupo_cita;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_payment_intents_set_group()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id_grupo_cita uuid;
BEGIN
  IF NEW.origen_pago_codigo = 'membership' THEN
    IF NEW.id_grupo_cita IS NOT NULL THEN
      RAISE EXCEPTION 'MF2A2_MEMBERSHIP_INTENT_NO_DEBE_TENER_GRUPO_CITA';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id_cita IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.id_grupo_cita
  INTO v_id_grupo_cita
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A2_PAYMENT_INTENT_CITA_NO_EXISTE';
  END IF;

  IF NEW.id_grupo_cita IS NULL THEN
    NEW.id_grupo_cita := v_id_grupo_cita;
  ELSIF NEW.id_grupo_cita IS DISTINCT FROM v_id_grupo_cita THEN
    RAISE EXCEPTION 'MF2A2_PAYMENT_INTENT_GRUPO_MISMATCH';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_recalcular_cita()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_recalcular_cita(OLD.id_cita);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id_cita IS DISTINCT FROM NEW.id_cita THEN
    PERFORM public.fn_recalcular_cita(OLD.id_cita);
  END IF;

  PERFORM public.fn_recalcular_cita(NEW.id_cita);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_sincronizar_grupo_cita()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_sincronizar_grupo_cita(OLD.id_grupo_cita);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id_grupo_cita IS DISTINCT FROM NEW.id_grupo_cita THEN
    PERFORM public.fn_sincronizar_grupo_cita(OLD.id_grupo_cita);
  END IF;

  PERFORM public.fn_sincronizar_grupo_cita(NEW.id_grupo_cita);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_recalcular_cita_paquete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_recalcular_cita(OLD.id_cita);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.id_cita IS DISTINCT FROM NEW.id_cita THEN
    PERFORM public.fn_recalcular_cita(OLD.id_cita);
  END IF;

  PERFORM public.fn_recalcular_cita(NEW.id_cita);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tr_citas_detalles_normalizar ON public.citas_detalles;
CREATE TRIGGER tr_citas_detalles_normalizar
BEFORE INSERT OR UPDATE ON public.citas_detalles
FOR EACH ROW
EXECUTE FUNCTION public.fn_citas_detalles_normalizar();

DROP TRIGGER IF EXISTS tr_recalc_cita_detalles ON public.citas_detalles;
CREATE TRIGGER tr_recalc_cita_detalles
AFTER INSERT OR DELETE OR UPDATE ON public.citas_detalles
FOR EACH ROW
EXECUTE FUNCTION public.fn_trg_recalcular_cita();

DROP TRIGGER IF EXISTS tr_citas_sync_grupo ON public.citas;
CREATE TRIGGER tr_citas_sync_grupo
AFTER INSERT OR DELETE OR UPDATE ON public.citas
FOR EACH ROW
EXECUTE FUNCTION public.fn_trg_sincronizar_grupo_cita();

DROP TRIGGER IF EXISTS tr_recalc_cita_paquetes ON public.citas_paquetes;
CREATE TRIGGER tr_recalc_cita_paquetes
AFTER INSERT OR DELETE OR UPDATE ON public.citas_paquetes
FOR EACH ROW
EXECUTE FUNCTION public.fn_trg_recalcular_cita_paquete();

DROP TRIGGER IF EXISTS tr_payment_intents_set_group ON public.payment_intents;
CREATE TRIGGER tr_payment_intents_set_group
BEFORE INSERT OR UPDATE ON public.payment_intents
FOR EACH ROW
EXECUTE FUNCTION public.fn_payment_intents_set_group();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'incluye_isv_snapshot'
  ) THEN
    RAISE EXCEPTION 'MF2A2_VALIDACION_COLUMNA_ISV_SNAPSHOT_FALTANTE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    WHERE precio_referencia_hnl <= 0
      AND precio_unitario_hnl > 0
  ) THEN
    RAISE EXCEPTION 'MF2A2_VALIDACION_BACKFILL_PRECIO_REFERENCIA_INCOMPLETO';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    WHERE total_linea_hnl <> GREATEST(
      0,
      ROUND(
        (subtotal_hnl - descuento_hnl)
        + CASE WHEN incluye_isv_snapshot IS TRUE THEN 0 ELSE isv_hnl END,
        2
      )
    )
  ) THEN
    RAISE EXCEPTION 'MF2A2_VALIDACION_TOTAL_LINEA_INCONSISTENTE';
  END IF;
END $$;

COMMIT;
