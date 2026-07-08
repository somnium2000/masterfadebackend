BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Fase 2A.2
-- Completa las fuentes transaccionales que modifican la disponibilidad
-- y que no estaban cubiertas por la migracion 20260703010000.

DO $migration_guard$
BEGIN
  IF to_regclass('app_private.agenda_eventos_outbox') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'AGENDA_OUTBOX_REQUIRED';
  END IF;

  IF to_regprocedure(
    'app_private.registrar_evento_agenda_v1(text,uuid,text,text,uuid,uuid,date,date,timestamptz,timestamptz)'
  ) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'AGENDA_OUTBOX_REGISTER_FUNCTION_REQUIRED';
  END IF;
END;
$migration_guard$;

ALTER TABLE app_private.agenda_eventos_outbox
  DROP CONSTRAINT IF EXISTS ck_agenda_eventos_outbox_motivo;

ALTER TABLE app_private.agenda_eventos_outbox
  ADD CONSTRAINT ck_agenda_eventos_outbox_motivo
  CHECK (
    motivo = ANY (
      ARRAY[
        'hold_created',
        'hold_released',
        'hold_expired',
        'booking_confirmed',
        'booking_cancelled',
        'booking_rescheduled',
        'availability_released',
        'block_changed',
        'branch_schedule_changed',
        'barber_schedule_changed',
        'branch_availability_changed',
        'barber_availability_changed',
        'service_availability_changed',
        'booking_rules_changed'
      ]::text[]
    )
  );

CREATE OR REPLACE FUNCTION app_private.trg_sucursales_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_old_activa boolean := false;
  v_new_activa boolean := false;
  v_scope_changed boolean := false;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_activa := OLD.deleted_at IS NULL AND OLD.estado IS TRUE;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_activa := NEW.deleted_at IS NULL AND NEW.estado IS TRUE;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_activa THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_availability_changed',
        NEW.id_sucursal,
        'public.sucursales',
        'INSERT',
        NEW.id_sucursal,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_activa THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_availability_changed',
        OLD.id_sucursal,
        'public.sucursales',
        'DELETE',
        OLD.id_sucursal,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_scope_changed := OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal;
  v_changed := v_scope_changed
    OR OLD.estado IS DISTINCT FROM NEW.estado
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_activa AND (NOT v_new_activa OR v_scope_changed) THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_availability_changed',
      OLD.id_sucursal,
      'public.sucursales',
      'UPDATE_OLD',
      OLD.id_sucursal,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END IF;

  IF v_new_activa THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_availability_changed',
      NEW.id_sucursal,
      'public.sucursales',
      'UPDATE_NEW',
      NEW.id_sucursal,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.trg_empleados_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_old_barbero_activo boolean := false;
  v_new_barbero_activo boolean := false;
  v_scope_changed boolean := false;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_barbero_activo := OLD.deleted_at IS NULL
      AND OLD.estado IS TRUE
      AND OLD.es_barbero IS TRUE;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_barbero_activo := NEW.deleted_at IS NULL
      AND NEW.estado IS TRUE
      AND NEW.es_barbero IS TRUE;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_barbero_activo THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'barber_availability_changed',
        NEW.id_sucursal,
        'public.empleados',
        'INSERT',
        NEW.id_empleado,
        NEW.id_empleado,
        NULL,
        NULL,
        NULL,
        NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_barbero_activo THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'barber_availability_changed',
        OLD.id_sucursal,
        'public.empleados',
        'DELETE',
        OLD.id_empleado,
        OLD.id_empleado,
        NULL,
        NULL,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_scope_changed := OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal;
  v_changed := v_scope_changed
    OR OLD.estado IS DISTINCT FROM NEW.estado
    OR OLD.es_barbero IS DISTINCT FROM NEW.es_barbero
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_barbero_activo AND (NOT v_new_barbero_activo OR v_scope_changed) THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'barber_availability_changed',
      OLD.id_sucursal,
      'public.empleados',
      'UPDATE_OLD',
      OLD.id_empleado,
      OLD.id_empleado,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END IF;

  IF v_new_barbero_activo THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'barber_availability_changed',
      NEW.id_sucursal,
      'public.empleados',
      'UPDATE_NEW',
      NEW.id_empleado,
      NEW.id_empleado,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.trg_servicios_tarifas_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_old_relevante boolean := false;
  v_new_relevante boolean := false;
  v_scope_changed boolean := false;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_relevante := OLD.deleted_at IS NULL
      AND OLD.activo IS TRUE
      AND OLD.servicio_informativo IS FALSE;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_relevante := NEW.deleted_at IS NULL
      AND NEW.activo IS TRUE
      AND NEW.servicio_informativo IS FALSE;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_relevante THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'service_availability_changed',
        NEW.id_sucursal,
        'public.servicios_tarifas',
        'INSERT',
        NEW.id_tarifa,
        NEW.id_empleado,
        NEW.vigente_desde,
        NEW.vigente_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_relevante THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'service_availability_changed',
        OLD.id_sucursal,
        'public.servicios_tarifas',
        'DELETE',
        OLD.id_tarifa,
        OLD.id_empleado,
        OLD.vigente_desde,
        OLD.vigente_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_scope_changed :=
    OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal
    OR OLD.id_empleado IS DISTINCT FROM NEW.id_empleado
    OR OLD.vigente_desde IS DISTINCT FROM NEW.vigente_desde
    OR OLD.vigente_hasta IS DISTINCT FROM NEW.vigente_hasta;

  v_changed := v_scope_changed
    OR OLD.id_servicio IS DISTINCT FROM NEW.id_servicio
    OR OLD.activo IS DISTINCT FROM NEW.activo
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.duracion_min IS DISTINCT FROM NEW.duracion_min
    OR OLD.buffer_min IS DISTINCT FROM NEW.buffer_min
    OR OLD.servicio_informativo IS DISTINCT FROM NEW.servicio_informativo;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_relevante AND (NOT v_new_relevante OR v_scope_changed) THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'service_availability_changed',
      OLD.id_sucursal,
      'public.servicios_tarifas',
      'UPDATE_OLD',
      OLD.id_tarifa,
      OLD.id_empleado,
      OLD.vigente_desde,
      OLD.vigente_hasta,
      NULL,
      NULL
    );
  END IF;

  IF v_new_relevante THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'service_availability_changed',
      NEW.id_sucursal,
      'public.servicios_tarifas',
      'UPDATE_NEW',
      NEW.id_tarifa,
      NEW.id_empleado,
      NEW.vigente_desde,
      NEW.vigente_hasta,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.trg_servicios_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_id_servicio uuid;
  v_operacion text;
  v_changed boolean := true;
  v_branch record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_changed :=
      OLD.duracion_min IS DISTINCT FROM NEW.duracion_min
      OR OLD.buffer_min IS DISTINCT FROM NEW.buffer_min
      OR OLD.activo IS DISTINCT FROM NEW.activo
      OR OLD.visible_publico IS DISTINCT FROM NEW.visible_publico
      OR OLD.agendable IS DISTINCT FROM NEW.agendable
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at;

    IF NOT v_changed THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_id_servicio := OLD.id_servicio;
    v_operacion := 'DELETE';
  ELSIF TG_OP = 'INSERT' THEN
    v_id_servicio := NEW.id_servicio;
    v_operacion := 'INSERT';
  ELSE
    v_id_servicio := NEW.id_servicio;
    v_operacion := 'UPDATE_NEW';
  END IF;

  FOR v_branch IN
    SELECT DISTINCT st.id_sucursal
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = v_id_servicio
      AND st.deleted_at IS NULL
    ORDER BY st.id_sucursal
  LOOP
    PERFORM app_private.registrar_evento_agenda_v1(
      'service_availability_changed',
      v_branch.id_sucursal,
      'public.servicios',
      v_operacion,
      v_id_servicio,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.trg_parametros_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_old_relevante boolean := false;
  v_new_relevante boolean := false;
  v_changed boolean := true;
  v_operacion text;
  v_branch record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_relevante := OLD.clave = ANY (
      ARRAY['agenda_buffer_global_min', 'agenda_min_servicio_vendible_min']::text[]
    );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_relevante := NEW.clave = ANY (
      ARRAY['agenda_buffer_global_min', 'agenda_min_servicio_vendible_min']::text[]
    );
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_changed :=
      OLD.clave IS DISTINCT FROM NEW.clave
      OR OLD.valor_numero IS DISTINCT FROM NEW.valor_numero;
  END IF;

  IF NOT v_changed OR (NOT v_old_relevante AND NOT v_new_relevante) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_operacion := 'DELETE';
  ELSIF TG_OP = 'INSERT' THEN
    v_operacion := 'INSERT';
  ELSIF v_new_relevante THEN
    v_operacion := 'UPDATE_NEW';
  ELSE
    v_operacion := 'UPDATE_OLD';
  END IF;

  FOR v_branch IN
    SELECT s.id_sucursal
    FROM public.sucursales s
    WHERE s.deleted_at IS NULL
      AND s.estado IS TRUE
    ORDER BY s.id_sucursal
  LOOP
    PERFORM app_private.registrar_evento_agenda_v1(
      'booking_rules_changed',
      v_branch.id_sucursal,
      'public.parametros_sistema',
      v_operacion,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.trg_sucursales_agenda_outbox_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.trg_empleados_agenda_outbox_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.trg_servicios_tarifas_agenda_outbox_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.trg_servicios_agenda_outbox_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.trg_parametros_agenda_outbox_v1()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION app_private.trg_sucursales_agenda_outbox_v1() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.trg_empleados_agenda_outbox_v1() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.trg_servicios_tarifas_agenda_outbox_v1() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.trg_servicios_agenda_outbox_v1() TO postgres;
GRANT EXECUTE ON FUNCTION app_private.trg_parametros_agenda_outbox_v1() TO postgres;

DROP TRIGGER IF EXISTS tr_agenda_outbox_sucursales ON public.sucursales;
CREATE TRIGGER tr_agenda_outbox_sucursales
AFTER INSERT OR UPDATE OR DELETE ON public.sucursales
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_sucursales_agenda_outbox_v1();

DROP TRIGGER IF EXISTS tr_agenda_outbox_empleados ON public.empleados;
CREATE TRIGGER tr_agenda_outbox_empleados
AFTER INSERT OR UPDATE OR DELETE ON public.empleados
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_empleados_agenda_outbox_v1();

DROP TRIGGER IF EXISTS tr_agenda_outbox_servicios_tarifas ON public.servicios_tarifas;
CREATE TRIGGER tr_agenda_outbox_servicios_tarifas
AFTER INSERT OR UPDATE OR DELETE ON public.servicios_tarifas
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_servicios_tarifas_agenda_outbox_v1();

DROP TRIGGER IF EXISTS tr_agenda_outbox_servicios ON public.servicios;
DROP TRIGGER IF EXISTS tr_agenda_outbox_servicios_iu ON public.servicios;
DROP TRIGGER IF EXISTS tr_agenda_outbox_servicios_d ON public.servicios;

CREATE TRIGGER tr_agenda_outbox_servicios_iu
AFTER INSERT OR UPDATE ON public.servicios
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_servicios_agenda_outbox_v1();

CREATE TRIGGER tr_agenda_outbox_servicios_d
BEFORE DELETE ON public.servicios
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_servicios_agenda_outbox_v1();

DROP TRIGGER IF EXISTS tr_agenda_outbox_parametros_sistema ON public.parametros_sistema;
CREATE TRIGGER tr_agenda_outbox_parametros_sistema
AFTER INSERT OR UPDATE OR DELETE ON public.parametros_sistema
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_parametros_agenda_outbox_v1();

INSERT INTO supabase_migrations.schema_migrations (
  version,
  statements,
  name,
  created_by,
  idempotency_key,
  rollback
)
VALUES (
  '20260703020000',
  ARRAY['fase_2a2_agenda_outbox_fuentes_disponibilidad_v1']::text[],
  'fase_2a2_agenda_outbox_fuentes_disponibilidad_v1',
  'postgres',
  'masterfade:20260703020000:fase_2a2_agenda_outbox_fuentes_disponibilidad_v1',
  NULL
)
ON CONFLICT DO NOTHING;

COMMIT;

SELECT
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'app_private.agenda_eventos_outbox'::regclass
      AND conname = 'ck_agenda_eventos_outbox_motivo'
      AND pg_get_constraintdef(oid, true) LIKE '%branch_availability_changed%'
      AND pg_get_constraintdef(oid, true) LIKE '%barber_availability_changed%'
      AND pg_get_constraintdef(oid, true) LIKE '%service_availability_changed%'
      AND pg_get_constraintdef(oid, true) LIKE '%booking_rules_changed%'
  ) AS constraint_motivos_actualizado,
  to_regprocedure('app_private.trg_sucursales_agenda_outbox_v1()') IS NOT NULL
    AS funcion_sucursales_creada,
  to_regprocedure('app_private.trg_empleados_agenda_outbox_v1()') IS NOT NULL
    AS funcion_empleados_creada,
  to_regprocedure('app_private.trg_servicios_tarifas_agenda_outbox_v1()') IS NOT NULL
    AS funcion_tarifas_creada,
  to_regprocedure('app_private.trg_servicios_agenda_outbox_v1()') IS NOT NULL
    AS funcion_servicios_creada,
  to_regprocedure('app_private.trg_parametros_agenda_outbox_v1()') IS NOT NULL
    AS funcion_parametros_creada,
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.sucursales'::regclass
      AND tgname = 'tr_agenda_outbox_sucursales'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) AS trigger_sucursales_creado,
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.empleados'::regclass
      AND tgname = 'tr_agenda_outbox_empleados'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) AS trigger_empleados_creado,
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.servicios_tarifas'::regclass
      AND tgname = 'tr_agenda_outbox_servicios_tarifas'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) AS trigger_tarifas_creado,
  (
    SELECT count(*) = 2
    FROM pg_trigger
    WHERE tgrelid = 'public.servicios'::regclass
      AND tgname IN ('tr_agenda_outbox_servicios_iu', 'tr_agenda_outbox_servicios_d')
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) AS triggers_servicios_creados,
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.parametros_sistema'::regclass
      AND tgname = 'tr_agenda_outbox_parametros_sistema'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) AS trigger_parametros_creado,
  EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations
    WHERE version = '20260703020000'
  ) AS migracion_registrada;
