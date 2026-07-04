BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

SELECT pg_advisory_xact_lock(hashtext('masterfade:microfase_2a3_guardia_snapshot_fiscal'));

LOCK TABLE public.citas_detalles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.citas IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.servicios_tarifas IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'incluye_isv_snapshot'
  ) THEN
    RAISE EXCEPTION 'MF2A3_PREVALIDACION_COLUMNA_INCLUYE_ISV_FALTANTE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    WHERE id_tarifa IS NULL
  ) THEN
    RAISE EXCEPTION 'MF2A3_PREVALIDACION_DETALLES_SIN_TARIFA';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_citas_detalles_normalizar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id_sucursal uuid;
  v_id_barbero uuid;
  v_inicio_at timestamptz;
  v_fecha_operativa date;
  v_nombre_servicio text;
  v_servicio_duracion integer;
  v_servicio_buffer integer;
  v_tarifa_id uuid;
  v_tarifa_servicio uuid;
  v_tarifa_sucursal uuid;
  v_tarifa_empleado uuid;
  v_tarifa_precio numeric;
  v_tarifa_incluye_isv boolean;
  v_tarifa_isv_porcentaje numeric;
  v_tarifa_vigente_desde date;
  v_tarifa_vigente_hasta date;
  v_tarifa_activa boolean;
  v_tarifa_deleted_at timestamptz;
  v_duracion_efectiva integer;
  v_buffer_efectivo integer;
  v_revalidar_fuente boolean := false;
  v_base_despues_descuento numeric;
BEGIN
  SELECT c.id_sucursal, c.id_empleado_barbero, c.inicio_at
  INTO v_id_sucursal, v_id_barbero, v_inicio_at
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A3_CITA_DETALLE_CITA_NO_EXISTE';
  END IF;

  SELECT s.nombre_servicio, s.duracion_min, s.buffer_min
  INTO v_nombre_servicio, v_servicio_duracion, v_servicio_buffer
  FROM public.servicios s
  WHERE s.id_servicio = NEW.id_servicio;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A3_CITA_DETALLE_SERVICIO_NO_EXISTE';
  END IF;

  v_fecha_operativa := (v_inicio_at AT TIME ZONE 'America/Tegucigalpa')::date;

  IF TG_OP = 'UPDATE' AND NEW.id_servicio IS NOT DISTINCT FROM OLD.id_servicio THEN
    NEW.nombre_servicio_snapshot := OLD.nombre_servicio_snapshot;
  ELSE
    NEW.nombre_servicio_snapshot := COALESCE(
      NULLIF(btrim(NEW.nombre_servicio_snapshot), ''),
      v_nombre_servicio,
      'Servicio no disponible'
    );
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_revalidar_fuente := true;
    NEW.incluye_isv_snapshot := COALESCE(NEW.incluye_isv_snapshot, false);
    NEW.isv_porcentaje := COALESCE(NEW.isv_porcentaje, 0);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.incluye_isv_snapshot IS DISTINCT FROM OLD.incluye_isv_snapshot
       OR NEW.isv_porcentaje IS DISTINCT FROM OLD.isv_porcentaje THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_SNAPSHOT_FISCAL_INMUTABLE';
    END IF;

    NEW.incluye_isv_snapshot := OLD.incluye_isv_snapshot;
    NEW.isv_porcentaje := OLD.isv_porcentaje;

    v_revalidar_fuente :=
         NEW.id_cita IS DISTINCT FROM OLD.id_cita
      OR NEW.id_servicio IS DISTINCT FROM OLD.id_servicio
      OR NEW.id_tarifa IS DISTINCT FROM OLD.id_tarifa
      OR NEW.duracion_min IS DISTINCT FROM OLD.duracion_min
      OR NEW.buffer_min IS DISTINCT FROM OLD.buffer_min
      OR NEW.precio_referencia_hnl IS DISTINCT FROM OLD.precio_referencia_hnl
      OR NEW.precio_unitario_hnl IS DISTINCT FROM OLD.precio_unitario_hnl
      OR NEW.origen_item_codigo IS DISTINCT FROM OLD.origen_item_codigo
      OR NEW.id_cita_paquete IS DISTINCT FROM OLD.id_cita_paquete;
  END IF;

  IF v_revalidar_fuente THEN
    IF NEW.id_tarifa IS NULL THEN
      SELECT
        st.id_tarifa,
        st.id_servicio,
        st.id_sucursal,
        st.id_empleado,
        st.precio_hnl,
        COALESCE(st.incluye_isv, false),
        COALESCE(st.isv_porcentaje, 0),
        st.vigente_desde,
        st.vigente_hasta,
        st.activo,
        st.deleted_at,
        COALESCE(st.duracion_min, v_servicio_duracion),
        COALESCE(st.buffer_min, v_servicio_buffer)
      INTO
        v_tarifa_id,
        v_tarifa_servicio,
        v_tarifa_sucursal,
        v_tarifa_empleado,
        v_tarifa_precio,
        v_tarifa_incluye_isv,
        v_tarifa_isv_porcentaje,
        v_tarifa_vigente_desde,
        v_tarifa_vigente_hasta,
        v_tarifa_activa,
        v_tarifa_deleted_at,
        v_duracion_efectiva,
        v_buffer_efectivo
      FROM public.servicios_tarifas st
      WHERE st.id_servicio = NEW.id_servicio
        AND st.id_sucursal = v_id_sucursal
        AND st.deleted_at IS NULL
        AND st.activo IS TRUE
        AND (st.id_empleado IS NULL OR st.id_empleado = v_id_barbero)
        AND st.vigente_desde <= v_fecha_operativa
        AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= v_fecha_operativa)
      ORDER BY
        CASE WHEN st.id_empleado = v_id_barbero THEN 0 ELSE 1 END,
        st.vigente_desde DESC,
        st.updated_at DESC,
        st.id_tarifa DESC
      LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_VIGENTE_NO_ENCONTRADA';
      END IF;
    ELSE
      SELECT
        st.id_tarifa,
        st.id_servicio,
        st.id_sucursal,
        st.id_empleado,
        st.precio_hnl,
        COALESCE(st.incluye_isv, false),
        COALESCE(st.isv_porcentaje, 0),
        st.vigente_desde,
        st.vigente_hasta,
        st.activo,
        st.deleted_at,
        COALESCE(st.duracion_min, s.duracion_min),
        COALESCE(st.buffer_min, s.buffer_min)
      INTO
        v_tarifa_id,
        v_tarifa_servicio,
        v_tarifa_sucursal,
        v_tarifa_empleado,
        v_tarifa_precio,
        v_tarifa_incluye_isv,
        v_tarifa_isv_porcentaje,
        v_tarifa_vigente_desde,
        v_tarifa_vigente_hasta,
        v_tarifa_activa,
        v_tarifa_deleted_at,
        v_duracion_efectiva,
        v_buffer_efectivo
      FROM public.servicios_tarifas st
      JOIN public.servicios s
        ON s.id_servicio = st.id_servicio
      WHERE st.id_tarifa = NEW.id_tarifa;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_NO_EXISTE';
      END IF;
    END IF;

    IF v_tarifa_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_ELIMINADA';
    END IF;
    IF v_tarifa_activa IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_INACTIVA';
    END IF;
    IF v_tarifa_servicio IS DISTINCT FROM NEW.id_servicio THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_SERVICIO_MISMATCH';
    END IF;
    IF v_tarifa_sucursal IS DISTINCT FROM v_id_sucursal THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_SUCURSAL_MISMATCH';
    END IF;
    IF v_tarifa_empleado IS NOT NULL AND v_tarifa_empleado IS DISTINCT FROM v_id_barbero THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_BARBERO_MISMATCH';
    END IF;
    IF v_tarifa_vigente_desde > v_fecha_operativa
       OR (v_tarifa_vigente_hasta IS NOT NULL AND v_tarifa_vigente_hasta < v_fecha_operativa) THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_TARIFA_FUERA_DE_VIGENCIA';
    END IF;
    IF NEW.duracion_min IS DISTINCT FROM v_duracion_efectiva THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_DURACION_MISMATCH';
    END IF;
    IF NEW.buffer_min IS DISTINCT FROM v_buffer_efectivo THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_BUFFER_MISMATCH';
    END IF;

    IF COALESCE(NEW.precio_referencia_hnl, 0) <= 0 THEN
      NEW.precio_referencia_hnl := v_tarifa_precio;
    ELSIF ROUND(NEW.precio_referencia_hnl, 2) IS DISTINCT FROM ROUND(v_tarifa_precio, 2) THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_PRECIO_REFERENCIA_MISMATCH';
    END IF;

    IF NEW.origen_item_codigo IN ('servicio_manual', 'servicio_extra')
       AND ROUND(NEW.precio_unitario_hnl, 2) IS DISTINCT FROM ROUND(v_tarifa_precio, 2) THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_PRECIO_UNITARIO_MISMATCH';
    END IF;

    NEW.id_tarifa := v_tarifa_id;

    IF NEW.isv_porcentaje < 0 OR NEW.isv_porcentaje > 100 THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_ISV_PORCENTAJE_INVALIDO';
    END IF;

    IF (NEW.incluye_isv_snapshot IS TRUE OR NEW.isv_porcentaje > 0)
       AND (
            NEW.incluye_isv_snapshot IS DISTINCT FROM COALESCE(v_tarifa_incluye_isv, false)
            OR ROUND(NEW.isv_porcentaje, 2) IS DISTINCT FROM ROUND(COALESCE(v_tarifa_isv_porcentaje, 0), 2)
           ) THEN
      RAISE EXCEPTION 'MF2A3_CITA_DETALLE_SNAPSHOT_FISCAL_TARIFA_MISMATCH';
    END IF;

    IF NEW.incluye_isv_snapshot IS NOT TRUE AND NEW.isv_porcentaje <= 0 THEN
      NEW.incluye_isv_snapshot := false;
      NEW.isv_porcentaje := 0;
    END IF;
  END IF;

  NEW.incluye_isv_snapshot := COALESCE(NEW.incluye_isv_snapshot, false);
  NEW.isv_porcentaje := COALESCE(NEW.isv_porcentaje, 0);
  NEW.subtotal_hnl := ROUND(NEW.precio_unitario_hnl * NEW.cantidad, 2);

  IF NEW.descuento_hnl < 0 OR NEW.descuento_hnl > NEW.subtotal_hnl THEN
    RAISE EXCEPTION 'MF2A3_CITA_DETALLE_DESCUENTO_INVALIDO';
  END IF;

  v_base_despues_descuento := GREATEST(0::numeric, NEW.subtotal_hnl - NEW.descuento_hnl);

  IF NEW.isv_porcentaje <= 0 THEN
    NEW.isv_hnl := 0;
  ELSIF NEW.incluye_isv_snapshot IS TRUE THEN
    NEW.isv_hnl := ROUND(
      v_base_despues_descuento - (v_base_despues_descuento / (1 + NEW.isv_porcentaje / 100)),
      2
    );
  ELSE
    NEW.isv_hnl := ROUND((v_base_despues_descuento * NEW.isv_porcentaje) / 100, 2);
  END IF;

  NEW.total_linea_hnl := ROUND(
    v_base_despues_descuento + CASE WHEN NEW.incluye_isv_snapshot IS TRUE THEN 0::numeric ELSE NEW.isv_hnl END,
    2
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tr_citas_detalles_normalizar ON public.citas_detalles;
CREATE TRIGGER tr_citas_detalles_normalizar
BEFORE INSERT OR UPDATE ON public.citas_detalles
FOR EACH ROW
EXECUTE FUNCTION public.fn_citas_detalles_normalizar();

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM pg_trigger
    WHERE tgname = 'tr_citas_detalles_normalizar'
      AND tgrelid = 'public.citas_detalles'::regclass
      AND NOT tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'MF2A3_VALIDACION_TRIGGER_NORMALIZACION_INVALIDO';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_trg_recalcular_cita_paquete'
  ) THEN
    RAISE EXCEPTION 'MF2A3_VALIDACION_FUNCION_PAQUETES_FALTANTE';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_trigger
    WHERE tgname = 'tr_recalc_cita_paquetes'
      AND tgrelid = 'public.citas_paquetes'::regclass
      AND NOT tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'MF2A3_VALIDACION_TRIGGER_PAQUETES_INVALIDO';
  END IF;
END $$;

COMMIT;
