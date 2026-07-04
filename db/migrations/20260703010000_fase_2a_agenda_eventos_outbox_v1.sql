-- MasterFade - Fase 2A
-- Outbox transaccional para invalidacion de disponibilidad de agenda.
-- PostgreSQL 17 / Supabase QA auditado el 2026-07-02.
-- Ejecutar una sola vez desde pgAdmin 4 con el rol propietario de la base.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtext('masterfade:fase-2a-agenda-eventos-outbox-v1')
);

DO $preflight$
DECLARE
  v_missing text;
BEGIN
  IF to_regnamespace('app_private') IS NULL THEN
    RAISE EXCEPTION 'Falta el esquema requerido app_private';
  END IF;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO v_missing
  FROM (
    VALUES
      ('public.citas', to_regclass('public.citas')),
      ('public.bloqueos_agenda', to_regclass('public.bloqueos_agenda')),
      ('public.horarios_semanales_sucursales', to_regclass('public.horarios_semanales_sucursales')),
      ('public.horarios_semanales_sucursales_bloques', to_regclass('public.horarios_semanales_sucursales_bloques')),
      ('public.horarios_semanales_empleados', to_regclass('public.horarios_semanales_empleados')),
      ('public.empleados', to_regclass('public.empleados'))
  ) AS required_objects(object_name, object_regclass)
  WHERE object_regclass IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Faltan objetos requeridos para la Fase 2A: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_cron'
  ) THEN
    RAISE EXCEPTION 'La extension pg_cron no esta instalada';
  END IF;

  IF to_regclass('app_private.agenda_eventos_outbox') IS NOT NULL THEN
    RAISE EXCEPTION 'La migracion ya fue aplicada: app_private.agenda_eventos_outbox ya existe';
  END IF;
END;
$preflight$;

CREATE TABLE app_private.agenda_eventos_outbox (
  id_evento bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo_evento text NOT NULL DEFAULT 'agenda.availability.changed',
  motivo text NOT NULL,
  id_sucursal uuid NOT NULL,
  id_empleado_barbero uuid NULL,
  fecha_desde date NULL,
  fecha_hasta date NULL,
  inicio_at timestamp with time zone NULL,
  fin_at timestamp with time zone NULL,
  origen_tabla text NOT NULL,
  origen_id uuid NULL,
  operacion text NOT NULL,
  txid_origen bigint NOT NULL DEFAULT txid_current(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT ck_agenda_eventos_outbox_tipo
    CHECK (tipo_evento = 'agenda.availability.changed'),

  CONSTRAINT ck_agenda_eventos_outbox_motivo
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
          'barber_schedule_changed'
        ]::text[]
      )
    ),

  CONSTRAINT ck_agenda_eventos_outbox_operacion
    CHECK (
      operacion = ANY (
        ARRAY['INSERT', 'UPDATE_OLD', 'UPDATE_NEW', 'DELETE']::text[]
      )
    ),

  CONSTRAINT ck_agenda_eventos_outbox_fechas
    CHECK (
      fecha_desde IS NULL
      OR fecha_hasta IS NULL
      OR fecha_hasta >= fecha_desde
    ),

  CONSTRAINT ck_agenda_eventos_outbox_rango
    CHECK (
      inicio_at IS NULL
      OR fin_at IS NULL
      OR fin_at > inicio_at
    ),

  CONSTRAINT ck_agenda_eventos_outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE app_private.agenda_eventos_outbox IS
  'Outbox transaccional de invalidaciones de disponibilidad para SSE. No contiene datos personales.';

COMMENT ON COLUMN app_private.agenda_eventos_outbox.id_evento IS
  'Secuencia global y durable usada como SSE event id y Last-Event-ID.';

COMMENT ON COLUMN app_private.agenda_eventos_outbox.payload IS
  'Payload publico minimo, construido por funcion controlada y sin PII.';

CREATE INDEX idx_agenda_eventos_outbox_sucursal_evento
  ON app_private.agenda_eventos_outbox (id_sucursal, id_evento);

CREATE INDEX idx_agenda_eventos_outbox_sucursal_barbero_evento
  ON app_private.agenda_eventos_outbox (
    id_sucursal,
    id_empleado_barbero,
    id_evento
  );

CREATE INDEX idx_agenda_eventos_outbox_created_at
  ON app_private.agenda_eventos_outbox (created_at);

REVOKE ALL ON TABLE app_private.agenda_eventos_outbox FROM PUBLIC;
REVOKE ALL ON TABLE app_private.agenda_eventos_outbox FROM anon;
REVOKE ALL ON TABLE app_private.agenda_eventos_outbox FROM authenticated;
REVOKE ALL ON TABLE app_private.agenda_eventos_outbox FROM service_role;

REVOKE ALL ON SEQUENCE app_private.agenda_eventos_outbox_id_evento_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE app_private.agenda_eventos_outbox_id_evento_seq FROM anon;
REVOKE ALL ON SEQUENCE app_private.agenda_eventos_outbox_id_evento_seq FROM authenticated;
REVOKE ALL ON SEQUENCE app_private.agenda_eventos_outbox_id_evento_seq FROM service_role;

CREATE OR REPLACE FUNCTION app_private.registrar_evento_agenda_v1(
  p_motivo text,
  p_id_sucursal uuid,
  p_origen_tabla text,
  p_operacion text,
  p_origen_id uuid DEFAULT NULL,
  p_id_empleado_barbero uuid DEFAULT NULL,
  p_fecha_desde date DEFAULT NULL,
  p_fecha_hasta date DEFAULT NULL,
  p_inicio_at timestamp with time zone DEFAULT NULL,
  p_fin_at timestamp with time zone DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_id_evento bigint;
  v_fecha_desde date := p_fecha_desde;
  v_fecha_hasta date := p_fecha_hasta;
  v_payload jsonb;
BEGIN
  IF p_id_sucursal IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'AGENDA_EVENT_BRANCH_REQUIRED';
  END IF;

  IF v_fecha_desde IS NULL AND p_inicio_at IS NOT NULL THEN
    v_fecha_desde := (p_inicio_at AT TIME ZONE 'America/Tegucigalpa')::date;
  END IF;

  IF v_fecha_hasta IS NULL AND p_fin_at IS NOT NULL THEN
    v_fecha_hasta := (
      (p_fin_at - interval '1 microsecond')
      AT TIME ZONE 'America/Tegucigalpa'
    )::date;
  END IF;

  IF v_fecha_desde IS NOT NULL
     AND v_fecha_hasta IS NOT NULL
     AND v_fecha_hasta < v_fecha_desde THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = 'AGENDA_EVENT_DATE_RANGE_INVALID';
  END IF;

  IF p_inicio_at IS NOT NULL
     AND p_fin_at IS NOT NULL
     AND p_fin_at <= p_inicio_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = 'AGENDA_EVENT_TIME_RANGE_INVALID';
  END IF;

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'event', 'agenda.availability.changed',
      'reason', p_motivo,
      'id_sucursal', p_id_sucursal,
      'id_barbero', p_id_empleado_barbero,
      'fecha_desde', v_fecha_desde,
      'fecha_hasta', v_fecha_hasta,
      'inicio_at', p_inicio_at,
      'fin_at', p_fin_at,
      'occurred_at', clock_timestamp()
    )
  );

  INSERT INTO app_private.agenda_eventos_outbox (
    motivo,
    id_sucursal,
    id_empleado_barbero,
    fecha_desde,
    fecha_hasta,
    inicio_at,
    fin_at,
    origen_tabla,
    origen_id,
    operacion,
    payload
  )
  VALUES (
    p_motivo,
    p_id_sucursal,
    p_id_empleado_barbero,
    v_fecha_desde,
    v_fecha_hasta,
    p_inicio_at,
    p_fin_at,
    p_origen_tabla,
    p_origen_id,
    p_operacion,
    v_payload
  )
  RETURNING id_evento INTO v_id_evento;

  RETURN v_id_evento;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.registrar_evento_agenda_v1(
  text,
  uuid,
  text,
  text,
  uuid,
  uuid,
  date,
  date,
  timestamp with time zone,
  timestamp with time zone
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.trg_citas_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_old_ocupa boolean := false;
  v_new_ocupa boolean := false;
  v_scope_changed boolean := false;
  v_reason text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_ocupa := OLD.deleted_at IS NULL
      AND OLD.estado_cita_codigo = ANY (
        ARRAY[
          'en_espera',
          'pendiente_pago',
          'confirmada',
          'en_salon',
          'en_atencion'
        ]::text[]
      );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_ocupa := NEW.deleted_at IS NULL
      AND NEW.estado_cita_codigo = ANY (
        ARRAY[
          'en_espera',
          'pendiente_pago',
          'confirmada',
          'en_salon',
          'en_atencion'
        ]::text[]
      );
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_ocupa THEN
      v_reason := CASE
        WHEN NEW.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
          THEN 'hold_created'
        ELSE 'booking_confirmed'
      END;

      PERFORM app_private.registrar_evento_agenda_v1(
        v_reason,
        NEW.id_sucursal,
        'public.citas',
        'INSERT',
        NEW.id_cita,
        NEW.id_empleado_barbero,
        NULL,
        NULL,
        NEW.inicio_at,
        NEW.fin_at
      );
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_ocupa THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'booking_cancelled',
        OLD.id_sucursal,
        'public.citas',
        'DELETE',
        OLD.id_cita,
        OLD.id_empleado_barbero,
        NULL,
        NULL,
        OLD.inicio_at,
        OLD.fin_at
      );
    END IF;

    RETURN OLD;
  END IF;

  v_scope_changed :=
    OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal
    OR OLD.id_empleado_barbero IS DISTINCT FROM NEW.id_empleado_barbero
    OR OLD.inicio_at IS DISTINCT FROM NEW.inicio_at
    OR OLD.fin_at IS DISTINCT FROM NEW.fin_at;

  IF v_old_ocupa AND v_new_ocupa AND v_scope_changed THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'booking_rescheduled',
      OLD.id_sucursal,
      'public.citas',
      'UPDATE_OLD',
      OLD.id_cita,
      OLD.id_empleado_barbero,
      NULL,
      NULL,
      OLD.inicio_at,
      OLD.fin_at
    );

    PERFORM app_private.registrar_evento_agenda_v1(
      'booking_rescheduled',
      NEW.id_sucursal,
      'public.citas',
      'UPDATE_NEW',
      NEW.id_cita,
      NEW.id_empleado_barbero,
      NULL,
      NULL,
      NEW.inicio_at,
      NEW.fin_at
    );

    RETURN NEW;
  END IF;

  IF v_old_ocupa AND NOT v_new_ocupa THEN
    v_reason := CASE
      WHEN NEW.estado_cita_codigo = 'expirada'
        THEN 'hold_expired'
      WHEN NEW.estado_cita_codigo IN ('cancelada', 'cancelada_por_cliente', 'anulada')
           AND OLD.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
        THEN 'hold_released'
      WHEN NEW.estado_cita_codigo IN ('cancelada', 'cancelada_por_cliente', 'anulada')
           OR NEW.deleted_at IS NOT NULL
        THEN 'booking_cancelled'
      ELSE 'availability_released'
    END;

    PERFORM app_private.registrar_evento_agenda_v1(
      v_reason,
      OLD.id_sucursal,
      'public.citas',
      'UPDATE_OLD',
      OLD.id_cita,
      OLD.id_empleado_barbero,
      NULL,
      NULL,
      OLD.inicio_at,
      OLD.fin_at
    );

    RETURN NEW;
  END IF;

  IF NOT v_old_ocupa AND v_new_ocupa THEN
    v_reason := CASE
      WHEN NEW.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
        THEN 'hold_created'
      ELSE 'booking_confirmed'
    END;

    PERFORM app_private.registrar_evento_agenda_v1(
      v_reason,
      NEW.id_sucursal,
      'public.citas',
      'UPDATE_NEW',
      NEW.id_cita,
      NEW.id_empleado_barbero,
      NULL,
      NULL,
      NEW.inicio_at,
      NEW.fin_at
    );
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.trg_citas_agenda_outbox_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.trg_bloqueos_agenda_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'block_changed',
      NEW.id_sucursal,
      'public.bloqueos_agenda',
      'INSERT',
      NEW.id_bloqueo,
      NEW.id_empleado,
      NULL,
      NULL,
      lower(NEW.rango),
      upper(NEW.rango)
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'block_changed',
      OLD.id_sucursal,
      'public.bloqueos_agenda',
      'DELETE',
      OLD.id_bloqueo,
      OLD.id_empleado,
      NULL,
      NULL,
      lower(OLD.rango),
      upper(OLD.rango)
    );
    RETURN OLD;
  END IF;

  v_changed :=
    OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal
    OR OLD.id_empleado IS DISTINCT FROM NEW.id_empleado
    OR OLD.rango IS DISTINCT FROM NEW.rango
    OR OLD.tipo_bloqueo_codigo IS DISTINCT FROM NEW.tipo_bloqueo_codigo;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  PERFORM app_private.registrar_evento_agenda_v1(
    'block_changed',
    OLD.id_sucursal,
    'public.bloqueos_agenda',
    'UPDATE_OLD',
    OLD.id_bloqueo,
    OLD.id_empleado,
    NULL,
    NULL,
    lower(OLD.rango),
    upper(OLD.rango)
  );

  PERFORM app_private.registrar_evento_agenda_v1(
    'block_changed',
    NEW.id_sucursal,
    'public.bloqueos_agenda',
    'UPDATE_NEW',
    NEW.id_bloqueo,
    NEW.id_empleado,
    NULL,
    NULL,
    lower(NEW.rango),
    upper(NEW.rango)
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.trg_bloqueos_agenda_outbox_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.trg_horarios_sucursal_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_old_publicado boolean := false;
  v_new_publicado boolean := false;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_publicado := OLD.estado_horario_codigo = 'publicado';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_publicado := NEW.estado_horario_codigo = 'publicado';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_publicado THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_schedule_changed',
        NEW.id_sucursal,
        'public.horarios_semanales_sucursales',
        'INSERT',
        NEW.id_horario_sucursal,
        NULL,
        NEW.vigencia_desde,
        NEW.vigencia_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_publicado THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_schedule_changed',
        OLD.id_sucursal,
        'public.horarios_semanales_sucursales',
        'DELETE',
        OLD.id_horario_sucursal,
        NULL,
        OLD.vigencia_desde,
        OLD.vigencia_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_changed :=
    OLD.id_sucursal IS DISTINCT FROM NEW.id_sucursal
    OR OLD.estado_horario_codigo IS DISTINCT FROM NEW.estado_horario_codigo
    OR OLD.vigencia_desde IS DISTINCT FROM NEW.vigencia_desde
    OR OLD.vigencia_hasta IS DISTINCT FROM NEW.vigencia_hasta;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_publicado THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_schedule_changed',
      OLD.id_sucursal,
      'public.horarios_semanales_sucursales',
      'UPDATE_OLD',
      OLD.id_horario_sucursal,
      NULL,
      OLD.vigencia_desde,
      OLD.vigencia_hasta,
      NULL,
      NULL
    );
  END IF;

  IF v_new_publicado THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_schedule_changed',
      NEW.id_sucursal,
      'public.horarios_semanales_sucursales',
      'UPDATE_NEW',
      NEW.id_horario_sucursal,
      NULL,
      NEW.vigencia_desde,
      NEW.vigencia_hasta,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.trg_horarios_sucursal_outbox_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.trg_horarios_sucursal_bloques_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_old_parent record;
  v_new_parent record;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT
      h.id_sucursal,
      h.estado_horario_codigo,
      h.vigencia_desde,
      h.vigencia_hasta
    INTO v_old_parent
    FROM public.horarios_semanales_sucursales h
    WHERE h.id_horario_sucursal = OLD.id_horario_sucursal;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT
      h.id_sucursal,
      h.estado_horario_codigo,
      h.vigencia_desde,
      h.vigencia_hasta
    INTO v_new_parent
    FROM public.horarios_semanales_sucursales h
    WHERE h.id_horario_sucursal = NEW.id_horario_sucursal;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_parent.estado_horario_codigo = 'publicado' THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_schedule_changed',
        v_new_parent.id_sucursal,
        'public.horarios_semanales_sucursales_bloques',
        'INSERT',
        NEW.id_bloque_horario,
        NULL,
        v_new_parent.vigencia_desde,
        v_new_parent.vigencia_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_parent.estado_horario_codigo = 'publicado' THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'branch_schedule_changed',
        v_old_parent.id_sucursal,
        'public.horarios_semanales_sucursales_bloques',
        'DELETE',
        OLD.id_bloque_horario,
        NULL,
        v_old_parent.vigencia_desde,
        v_old_parent.vigencia_hasta,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_changed :=
    OLD.id_horario_sucursal IS DISTINCT FROM NEW.id_horario_sucursal
    OR OLD.dia_semana IS DISTINCT FROM NEW.dia_semana
    OR OLD.hora_inicio IS DISTINCT FROM NEW.hora_inicio
    OR OLD.hora_fin IS DISTINCT FROM NEW.hora_fin
    OR OLD.minuto_inicio IS DISTINCT FROM NEW.minuto_inicio
    OR OLD.minuto_fin IS DISTINCT FROM NEW.minuto_fin;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_parent.estado_horario_codigo = 'publicado' THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_schedule_changed',
      v_old_parent.id_sucursal,
      'public.horarios_semanales_sucursales_bloques',
      'UPDATE_OLD',
      OLD.id_bloque_horario,
      NULL,
      v_old_parent.vigencia_desde,
      v_old_parent.vigencia_hasta,
      NULL,
      NULL
    );
  END IF;

  IF v_new_parent.estado_horario_codigo = 'publicado' THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'branch_schedule_changed',
      v_new_parent.id_sucursal,
      'public.horarios_semanales_sucursales_bloques',
      'UPDATE_NEW',
      NEW.id_bloque_horario,
      NULL,
      v_new_parent.vigencia_desde,
      v_new_parent.vigencia_hasta,
      NULL,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.trg_horarios_sucursal_bloques_outbox_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.trg_horarios_empleado_outbox_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_old_sucursal uuid;
  v_new_sucursal uuid;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT e.id_sucursal
    INTO v_old_sucursal
    FROM public.empleados e
    WHERE e.id_empleado = OLD.id_empleado;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT e.id_sucursal
    INTO v_new_sucursal
    FROM public.empleados e
    WHERE e.id_empleado = NEW.id_empleado;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_sucursal IS NOT NULL THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'barber_schedule_changed',
        v_new_sucursal,
        'public.horarios_semanales_empleados',
        'INSERT',
        NEW.id_horario,
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
    IF v_old_sucursal IS NOT NULL THEN
      PERFORM app_private.registrar_evento_agenda_v1(
        'barber_schedule_changed',
        v_old_sucursal,
        'public.horarios_semanales_empleados',
        'DELETE',
        OLD.id_horario,
        OLD.id_empleado,
        NULL,
        NULL,
        NULL,
        NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  v_changed :=
    OLD.id_empleado IS DISTINCT FROM NEW.id_empleado
    OR OLD.dia_semana IS DISTINCT FROM NEW.dia_semana
    OR OLD.hora_inicio IS DISTINCT FROM NEW.hora_inicio
    OR OLD.hora_fin IS DISTINCT FROM NEW.hora_fin
    OR OLD.almuerzo_inicio IS DISTINCT FROM NEW.almuerzo_inicio
    OR OLD.almuerzo_fin IS DISTINCT FROM NEW.almuerzo_fin
    OR OLD.activo IS DISTINCT FROM NEW.activo;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  IF v_old_sucursal IS NOT NULL THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'barber_schedule_changed',
      v_old_sucursal,
      'public.horarios_semanales_empleados',
      'UPDATE_OLD',
      OLD.id_horario,
      OLD.id_empleado,
      NULL,
      NULL,
      NULL,
      NULL
    );
  END IF;

  IF v_new_sucursal IS NOT NULL THEN
    PERFORM app_private.registrar_evento_agenda_v1(
      'barber_schedule_changed',
      v_new_sucursal,
      'public.horarios_semanales_empleados',
      'UPDATE_NEW',
      NEW.id_horario,
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

REVOKE ALL ON FUNCTION app_private.trg_horarios_empleado_outbox_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.limpiar_agenda_eventos_outbox_v1(
  p_retencion interval DEFAULT interval '24 hours',
  p_limite integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $function$
DECLARE
  v_limite integer := LEAST(50000, GREATEST(1, COALESCE(p_limite, 5000)));
  v_deleted integer := 0;
BEGIN
  IF p_retencion IS NULL OR p_retencion < interval '1 hour' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'AGENDA_OUTBOX_RETENTION_INVALID';
  END IF;

  WITH candidatos AS (
    SELECT o.id_evento
    FROM app_private.agenda_eventos_outbox o
    WHERE o.created_at < clock_timestamp() - p_retencion
    ORDER BY o.id_evento
    FOR UPDATE SKIP LOCKED
    LIMIT v_limite
  ),
  eliminados AS (
    DELETE FROM app_private.agenda_eventos_outbox o
    USING candidatos c
    WHERE o.id_evento = c.id_evento
    RETURNING o.id_evento
  )
  SELECT count(*)::integer
  INTO v_deleted
  FROM eliminados;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.limpiar_agenda_eventos_outbox_v1(
  interval,
  integer
) FROM PUBLIC;

CREATE TRIGGER tr_agenda_outbox_citas
AFTER INSERT OR UPDATE OR DELETE
ON public.citas
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_citas_agenda_outbox_v1();

CREATE TRIGGER tr_agenda_outbox_bloqueos
AFTER INSERT OR UPDATE OR DELETE
ON public.bloqueos_agenda
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_bloqueos_agenda_outbox_v1();

CREATE TRIGGER tr_agenda_outbox_horarios_sucursal
AFTER INSERT OR UPDATE OR DELETE
ON public.horarios_semanales_sucursales
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_horarios_sucursal_outbox_v1();

CREATE TRIGGER tr_agenda_outbox_horarios_sucursal_bloques
AFTER INSERT OR UPDATE OR DELETE
ON public.horarios_semanales_sucursales_bloques
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_horarios_sucursal_bloques_outbox_v1();

CREATE TRIGGER tr_agenda_outbox_horarios_empleado
AFTER INSERT OR UPDATE OR DELETE
ON public.horarios_semanales_empleados
FOR EACH ROW
EXECUTE FUNCTION app_private.trg_horarios_empleado_outbox_v1();

DO $cron_setup$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'masterfade-clean-agenda-events'
  ) THEN
    PERFORM cron.unschedule('masterfade-clean-agenda-events');
  END IF;

  PERFORM cron.schedule(
    'masterfade-clean-agenda-events',
    '0 * * * *',
    $command$
      SELECT app_private.limpiar_agenda_eventos_outbox_v1(
        interval '24 hours',
        5000
      );
    $command$
  );
END;
$cron_setup$;

INSERT INTO supabase_migrations.schema_migrations (
  version,
  statements,
  name,
  created_by,
  idempotency_key,
  rollback
)
VALUES (
  '20260703010000',
  ARRAY['fase_2a_agenda_eventos_outbox_v1']::text[],
  'fase_2a_agenda_eventos_outbox_v1',
  current_user,
  'masterfade:20260703010000:fase_2a_agenda_eventos_outbox_v1',
  NULL
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verificacion posterior. Debe devolver una sola fila con todo en true.
SELECT
  to_regclass('app_private.agenda_eventos_outbox') IS NOT NULL AS outbox_creada,
  to_regprocedure(
    'app_private.registrar_evento_agenda_v1(text,uuid,text,text,uuid,uuid,date,date,timestamp with time zone,timestamp with time zone)'
  ) IS NOT NULL AS funcion_registro_creada,
  to_regprocedure(
    'app_private.limpiar_agenda_eventos_outbox_v1(interval,integer)'
  ) IS NOT NULL AS funcion_limpieza_creada,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_agenda_outbox_citas'
      AND NOT tgisinternal
  ) AS trigger_citas_creado,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_agenda_outbox_bloqueos'
      AND NOT tgisinternal
  ) AS trigger_bloqueos_creado,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_agenda_outbox_horarios_sucursal'
      AND NOT tgisinternal
  ) AS trigger_horario_sucursal_creado,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_agenda_outbox_horarios_sucursal_bloques'
      AND NOT tgisinternal
  ) AS trigger_bloques_horario_creado,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tr_agenda_outbox_horarios_empleado'
      AND NOT tgisinternal
  ) AS trigger_horario_empleado_creado,
  EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'masterfade-clean-agenda-events'
      AND active IS TRUE
  ) AS cron_limpieza_activo,
  EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations
    WHERE version = '20260703010000'
  ) AS migracion_registrada;
