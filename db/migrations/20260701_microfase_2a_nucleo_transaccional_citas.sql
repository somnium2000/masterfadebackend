-- Microfase 2A - nucleo transaccional de citas.
-- Reconstruida desde catalogo QA pdzsmkjnyazpkoocjbpw en modo readonly.
-- No ejecutar manualmente en QA/produccion sin ventana de migracion aprobada.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

SELECT pg_advisory_xact_lock(hashtext('masterfade:microfase-2a-nucleo-transaccional-citas'));

DO $$
BEGIN
  IF to_regclass('public.citas') IS NULL
     OR to_regclass('public.citas_grupos') IS NULL
     OR to_regclass('public.citas_detalles') IS NULL
     OR to_regclass('public.servicios_tarifas') IS NULL
     OR to_regclass('public.payment_intents') IS NULL THEN
    RAISE EXCEPTION 'MF2A_SCHEMA_BASE_INCOMPLETO';
  END IF;
END $$;

LOCK TABLE public.citas_grupos, public.citas, public.citas_detalles, public.payment_intents IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.citas_grupos
  ADD COLUMN IF NOT EXISTS codigo_reserva text,
  ADD COLUMN IF NOT EXISTS id_usuario_titular uuid,
  ADD COLUMN IF NOT EXISTS origen_codigo text NOT NULL DEFAULT 'publico',
  ADD COLUMN IF NOT EXISTS total_hnl numeric(12,2) NOT NULL DEFAULT 0;

UPDATE public.citas_grupos
SET codigo_reserva = 'MF' || upper(substr(replace(id_grupo_cita::text, '-', ''), 1, 10))
WHERE codigo_reserva IS NULL OR btrim(codigo_reserva) = '';

ALTER TABLE public.citas_grupos
  ALTER COLUMN codigo_reserva SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_citas_grupos_usuario_titular' AND conrelid = 'public.citas_grupos'::regclass) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT fk_citas_grupos_usuario_titular
      FOREIGN KEY (id_usuario_titular)
      REFERENCES public.usuarios(id_usuario)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_citas_grupos_origen_codigo' AND conrelid = 'public.citas_grupos'::regclass) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT ck_citas_grupos_origen_codigo
      CHECK (origen_codigo = ANY (ARRAY['publico','cliente_autenticado','admin','barbero','legacy','sistema','panel']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_citas_grupos_total_hnl_non_negative' AND conrelid = 'public.citas_grupos'::regclass) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT ck_citas_grupos_total_hnl_non_negative
      CHECK (total_hnl >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_citas_grupos_codigo_reserva' AND conrelid = 'public.citas_grupos'::regclass) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT uq_citas_grupos_codigo_reserva
      UNIQUE (codigo_reserva);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_grupos_codigo_reserva
  ON public.citas_grupos (codigo_reserva);

CREATE INDEX IF NOT EXISTS idx_citas_grupos_usuario_titular
  ON public.citas_grupos (id_usuario_titular)
  WHERE id_usuario_titular IS NOT NULL;

ALTER TABLE public.citas_detalles
  ADD COLUMN IF NOT EXISTS origen_item_codigo text NOT NULL DEFAULT 'servicio_manual',
  ADD COLUMN IF NOT EXISTS nombre_servicio_snapshot text,
  ADD COLUMN IF NOT EXISTS precio_referencia_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_porcentaje numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_linea_hnl numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS id_tarifa uuid;

WITH detalle_tarifa_unica AS (
  SELECT
    cd.id_cita_detalle,
    st.id_tarifa,
    st.precio_hnl,
    row_number() OVER (
      PARTITION BY cd.id_cita_detalle
      ORDER BY
        CASE WHEN st.id_empleado = c.id_empleado_barbero THEN 0 ELSE 1 END,
        st.vigente_desde DESC,
        st.updated_at DESC,
        st.id_tarifa DESC
    ) AS rn,
    count(*) OVER (PARTITION BY cd.id_cita_detalle) AS candidates
  FROM public.citas_detalles cd
  JOIN public.citas c ON c.id_cita = cd.id_cita
  JOIN public.servicios_tarifas st
    ON st.id_servicio = cd.id_servicio
   AND st.id_sucursal = c.id_sucursal
   AND st.deleted_at IS NULL
   AND st.activo IS TRUE
   AND (st.id_empleado IS NULL OR st.id_empleado = c.id_empleado_barbero)
   AND st.vigente_desde <= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
   AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date)
   AND st.precio_hnl = cd.precio_unitario_hnl
  WHERE cd.id_tarifa IS NULL
)
UPDATE public.citas_detalles cd
SET id_tarifa = dtu.id_tarifa
FROM detalle_tarifa_unica dtu
WHERE dtu.id_cita_detalle = cd.id_cita_detalle
  AND dtu.rn = 1
  AND dtu.candidates = 1;

DO $$
DECLARE
  v_ambiguos integer;
BEGIN
  SELECT count(*)
  INTO v_ambiguos
  FROM (
    SELECT cd.id_cita_detalle
    FROM public.citas_detalles cd
    JOIN public.citas c ON c.id_cita = cd.id_cita
    JOIN public.servicios_tarifas st
      ON st.id_servicio = cd.id_servicio
     AND st.id_sucursal = c.id_sucursal
     AND st.deleted_at IS NULL
     AND st.activo IS TRUE
     AND (st.id_empleado IS NULL OR st.id_empleado = c.id_empleado_barbero)
     AND st.vigente_desde <= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date
     AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= (c.inicio_at AT TIME ZONE 'America/Tegucigalpa')::date)
     AND st.precio_hnl = cd.precio_unitario_hnl
    WHERE cd.id_tarifa IS NULL
    GROUP BY cd.id_cita_detalle
    HAVING count(*) > 1
  ) ambiguos;

  IF v_ambiguos > 0 THEN
    RAISE EXCEPTION 'MF2A_BACKFILL_TARIFA_AMBIGUA: % detalles', v_ambiguos;
  END IF;
END $$;

UPDATE public.citas_detalles cd
SET nombre_servicio_snapshot = COALESCE(NULLIF(btrim(cd.nombre_servicio_snapshot), ''), s.nombre_servicio, 'Servicio no disponible'),
    precio_referencia_hnl = CASE
      WHEN COALESCE(cd.precio_referencia_hnl, 0) <= 0
        THEN COALESCE(
          (SELECT st.precio_hnl FROM public.servicios_tarifas st WHERE st.id_tarifa = cd.id_tarifa),
          cd.precio_unitario_hnl,
          0
        )
      ELSE cd.precio_referencia_hnl
    END,
    total_linea_hnl = GREATEST(0, round((COALESCE(cd.subtotal_hnl, 0) - COALESCE(cd.descuento_hnl, 0) + COALESCE(cd.isv_hnl, 0)), 2))
FROM public.servicios s
WHERE s.id_servicio = cd.id_servicio
  AND (
    cd.nombre_servicio_snapshot IS NULL
    OR btrim(cd.nombre_servicio_snapshot) = ''
    OR COALESCE(cd.precio_referencia_hnl, 0) <= 0
    OR cd.total_linea_hnl = 0
  );

ALTER TABLE public.citas_detalles
  ALTER COLUMN nombre_servicio_snapshot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_citas_detalles_tarifa' AND conrelid = 'public.citas_detalles'::regclass) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT fk_citas_detalles_tarifa
      FOREIGN KEY (id_tarifa)
      REFERENCES public.servicios_tarifas(id_tarifa)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_citas_detalles_origen_item' AND conrelid = 'public.citas_detalles'::regclass) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT ck_citas_detalles_origen_item
      CHECK (origen_item_codigo = ANY (ARRAY['servicio_manual','servicio_extra','paquete_incluido','plan_incluido','recompensa_masterpuntos']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_citas_detalles_total_linea_formula' AND conrelid = 'public.citas_detalles'::regclass) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT ck_citas_detalles_total_linea_formula
      CHECK (total_linea_hnl = GREATEST(0, round((subtotal_hnl - descuento_hnl + isv_hnl), 2)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_detalles_id_tarifa
  ON public.citas_detalles (id_tarifa)
  WHERE id_tarifa IS NOT NULL;

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS id_grupo_cita uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_intents_grupo_cita' AND conrelid = 'public.payment_intents'::regclass) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT fk_payment_intents_grupo_cita
      FOREIGN KEY (id_grupo_cita)
      REFERENCES public.citas_grupos(id_grupo_cita)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

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
  v_id_sucursal uuid;
  v_id_empleado_barbero uuid;
  v_inicio_at timestamptz;
  v_fecha_operativa date;
  v_tarifa_id uuid;
  v_tarifa_servicio uuid;
  v_tarifa_sucursal uuid;
  v_tarifa_empleado uuid;
  v_tarifa_precio numeric;
  v_nombre_servicio text;
BEGIN
  SELECT c.id_sucursal, c.id_empleado_barbero, c.inicio_at
  INTO v_id_sucursal, v_id_empleado_barbero, v_inicio_at
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A_CITA_DETALLE_CITA_NO_EXISTE';
  END IF;

  v_fecha_operativa := (v_inicio_at AT TIME ZONE 'America/Tegucigalpa')::date;

  SELECT s.nombre_servicio
  INTO v_nombre_servicio
  FROM public.servicios s
  WHERE s.id_servicio = NEW.id_servicio;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MF2A_CITA_DETALLE_SERVICIO_NO_EXISTE';
  END IF;

  NEW.nombre_servicio_snapshot := COALESCE(NULLIF(btrim(NEW.nombre_servicio_snapshot), ''), v_nombre_servicio, 'Servicio no disponible');

  IF NEW.id_tarifa IS NOT NULL THEN
    SELECT st.id_tarifa, st.id_servicio, st.id_sucursal, st.id_empleado, st.precio_hnl
    INTO v_tarifa_id, v_tarifa_servicio, v_tarifa_sucursal, v_tarifa_empleado, v_tarifa_precio
    FROM public.servicios_tarifas st
    WHERE st.id_tarifa = NEW.id_tarifa;

    IF v_tarifa_id IS NULL THEN RAISE EXCEPTION 'MF2A_CITA_DETALLE_TARIFA_NO_EXISTE'; END IF;
    IF v_tarifa_servicio IS DISTINCT FROM NEW.id_servicio THEN RAISE EXCEPTION 'MF2A_CITA_DETALLE_TARIFA_SERVICIO_MISMATCH'; END IF;
    IF v_tarifa_sucursal IS DISTINCT FROM v_id_sucursal THEN RAISE EXCEPTION 'MF2A_CITA_DETALLE_TARIFA_SUCURSAL_MISMATCH'; END IF;
    IF v_tarifa_empleado IS NOT NULL AND v_tarifa_empleado IS DISTINCT FROM v_id_empleado_barbero THEN
      RAISE EXCEPTION 'MF2A_CITA_DETALLE_TARIFA_BARBERO_MISMATCH';
    END IF;
  ELSE
    SELECT st.id_tarifa, st.id_servicio, st.id_sucursal, st.id_empleado, st.precio_hnl
    INTO v_tarifa_id, v_tarifa_servicio, v_tarifa_sucursal, v_tarifa_empleado, v_tarifa_precio
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = NEW.id_servicio
      AND st.id_sucursal = v_id_sucursal
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND (st.id_empleado IS NULL OR st.id_empleado = v_id_empleado_barbero)
      AND st.vigente_desde <= v_fecha_operativa
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= v_fecha_operativa)
      AND (
        st.precio_hnl = NEW.precio_unitario_hnl
        OR COALESCE(NEW.origen_item_codigo, 'servicio_manual') IN ('paquete_incluido','plan_incluido','recompensa_masterpuntos')
      )
    ORDER BY
      CASE WHEN st.id_empleado = v_id_empleado_barbero THEN 0 ELSE 1 END,
      st.vigente_desde DESC,
      st.updated_at DESC,
      st.id_tarifa DESC
    LIMIT 1;

    IF v_tarifa_id IS NOT NULL THEN
      NEW.id_tarifa := v_tarifa_id;
    END IF;
  END IF;

  IF COALESCE(NEW.precio_referencia_hnl, 0) <= 0 THEN
    NEW.precio_referencia_hnl := COALESCE(v_tarifa_precio, NEW.precio_unitario_hnl, 0);
  END IF;

  NEW.subtotal_hnl := ROUND(NEW.precio_unitario_hnl * NEW.cantidad, 2);
  NEW.total_linea_hnl := GREATEST(0::numeric, ROUND(NEW.subtotal_hnl - NEW.descuento_hnl + NEW.isv_hnl, 2));
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
  v_descuento numeric(12,2);
  v_duracion integer;
  v_buffer integer;
  v_subtotal_detalles numeric(12,2);
  v_subtotal_extras numeric(12,2);
  v_total_paquete numeric(12,2);
  v_tiene_paquete boolean;
  v_subtotal numeric(12,2);
  v_total numeric(12,2);
BEGIN
  SELECT c.inicio_at, c.fin_at, COALESCE(c.descuento_hnl, 0)
  INTO v_inicio, v_fin_actual, v_descuento
  FROM public.citas c
  WHERE c.id_cita = p_cita_id;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT
    COALESCE(SUM(cd.duracion_min * cd.cantidad), 0)::integer,
    COALESCE(MAX(cd.buffer_min), 0)::integer,
    COALESCE(SUM(cd.subtotal_hnl), 0)::numeric(12,2),
    COALESCE(SUM(cd.subtotal_hnl) FILTER (WHERE cd.origen_item_codigo <> 'paquete_incluido'), 0)::numeric(12,2)
  INTO v_duracion, v_buffer, v_subtotal_detalles, v_subtotal_extras
  FROM public.citas_detalles cd
  WHERE cd.id_cita = p_cita_id;

  SELECT EXISTS (SELECT 1 FROM public.citas_paquetes cp WHERE cp.id_cita = p_cita_id),
         COALESCE((SELECT SUM(cp.total_hnl) FROM public.citas_paquetes cp WHERE cp.id_cita = p_cita_id), 0)::numeric(12,2)
  INTO v_tiene_paquete, v_total_paquete;

  v_subtotal := CASE WHEN v_tiene_paquete THEN v_total_paquete + v_subtotal_extras ELSE v_subtotal_detalles END;
  v_total := GREATEST(0::numeric, ROUND(COALESCE(v_subtotal, 0) - COALESCE(v_descuento, 0), 2));

  UPDATE public.citas c
  SET duracion_total_min = v_duracion,
      buffer_total_min = v_buffer,
      subtotal_servicios_hnl = ROUND(COALESCE(v_subtotal, 0), 2),
      total_pagar_hnl = v_total,
      fin_at = CASE WHEN v_duracion > 0 THEN v_inicio + make_interval(mins => v_duracion + v_buffer) ELSE v_fin_actual END,
      updated_at = now()
  WHERE c.id_cita = p_cita_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sincronizar_grupo_cita(p_id_grupo_cita uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total_citas integer;
  v_total_hnl numeric(12,2);
  v_todas_terminales boolean;
  v_alguna_completada boolean;
  v_estado_destino text;
BEGIN
  IF p_id_grupo_cita IS NULL THEN RETURN; END IF;

  SELECT COUNT(*)::integer,
         COALESCE(SUM(c.total_pagar_hnl), 0)::numeric(12,2),
         COALESCE(BOOL_AND(c.estado_cita_codigo IN ('cancelada','cancelada_por_cliente','expirada','no_show','anulada','completada')), FALSE),
         COALESCE(BOOL_OR(c.estado_cita_codigo = 'completada'), FALSE)
  INTO v_total_citas, v_total_hnl, v_todas_terminales, v_alguna_completada
  FROM public.citas c
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL;

  IF v_total_citas = 0 THEN
    v_estado_destino := 'cancelado';
  ELSIF v_todas_terminales AND v_alguna_completada THEN
    v_estado_destino := 'completado';
  ELSIF v_todas_terminales THEN
    v_estado_destino := 'cancelado';
  ELSE
    v_estado_destino := 'activo';
  END IF;

  UPDATE public.citas_grupos cg
  SET total_hnl = v_total_hnl,
      estado_grupo_codigo = v_estado_destino,
      updated_at = now()
  WHERE cg.id_grupo_cita = p_id_grupo_cita
    AND (cg.total_hnl IS DISTINCT FROM v_total_hnl OR cg.estado_grupo_codigo IS DISTINCT FROM v_estado_destino);
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
      RAISE EXCEPTION 'MF2A_MEMBERSHIP_INTENT_NO_DEBE_TENER_GRUPO_CITA';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id_cita IS NULL THEN RETURN NEW; END IF;

  SELECT c.id_grupo_cita INTO v_id_grupo_cita
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita;

  IF NOT FOUND THEN RAISE EXCEPTION 'MF2A_PAYMENT_INTENT_CITA_NO_EXISTE'; END IF;

  IF NEW.id_grupo_cita IS NULL THEN
    NEW.id_grupo_cita := v_id_grupo_cita;
  ELSIF NEW.id_grupo_cita IS DISTINCT FROM v_id_grupo_cita THEN
    RAISE EXCEPTION 'MF2A_PAYMENT_INTENT_GRUPO_MISMATCH';
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

DROP TRIGGER IF EXISTS tr_citas_detalles_normalizar ON public.citas_detalles;
CREATE TRIGGER tr_citas_detalles_normalizar
BEFORE INSERT OR UPDATE ON public.citas_detalles
FOR EACH ROW EXECUTE FUNCTION public.fn_citas_detalles_normalizar();

DROP TRIGGER IF EXISTS tr_recalc_cita_detalles ON public.citas_detalles;
CREATE TRIGGER tr_recalc_cita_detalles
AFTER INSERT OR DELETE OR UPDATE ON public.citas_detalles
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_recalcular_cita();

DROP TRIGGER IF EXISTS tr_recalc_cita_paquetes ON public.citas_paquetes;
CREATE TRIGGER tr_recalc_cita_paquetes
AFTER INSERT OR DELETE OR UPDATE ON public.citas_paquetes
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_recalcular_cita_paquete();

DROP TRIGGER IF EXISTS tr_citas_sync_grupo ON public.citas;
CREATE TRIGGER tr_citas_sync_grupo
AFTER INSERT OR DELETE OR UPDATE ON public.citas
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_sincronizar_grupo_cita();

DROP TRIGGER IF EXISTS tr_payment_intents_set_group ON public.payment_intents;
CREATE TRIGGER tr_payment_intents_set_group
BEFORE INSERT OR UPDATE ON public.payment_intents
FOR EACH ROW EXECUTE FUNCTION public.fn_payment_intents_set_group();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    WHERE nombre_servicio_snapshot IS NULL
       OR COALESCE(precio_referencia_hnl, 0) <= 0
       OR total_linea_hnl <> GREATEST(0, round((subtotal_hnl - descuento_hnl + isv_hnl), 2))
  ) THEN
    RAISE EXCEPTION 'MF2A_VALIDACION_DETALLES_FALLO';
  END IF;
END $$;

COMMIT;
