BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtextextended('masterfade:20260701:fase_1_rpc_reserva_atomica_holds', 0)
);

-- ============================================================================
-- 0. PREVALIDACIONES DEL ESQUEMA ACTUAL
-- ============================================================================
DO $mf$
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'MF_F1_POSTGRES_17_REQUIRED';
  END IF;

  IF to_regclass('public.citas') IS NULL
     OR to_regclass('public.citas_holds') IS NULL
     OR to_regclass('public.citas_grupos') IS NULL
     OR to_regclass('public.citas_integrantes') IS NULL
     OR to_regclass('public.citas_detalles') IS NULL
     OR to_regclass('public.payment_intents') IS NULL
     OR to_regclass('public.payments') IS NULL
     OR to_regclass('public.parametros_sistema') IS NULL
     OR to_regclass('public.bloqueos_agenda') IS NULL
     OR to_regclass('public.horarios_semanales_sucursales') IS NULL
     OR to_regclass('public.horarios_semanales_sucursales_bloques') IS NULL
     OR to_regclass('public.horarios_semanales_empleados') IS NULL THEN
    RAISE EXCEPTION 'MF_F1_REQUIRED_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.citas'::regclass
      AND conname = 'ex_citas_solape_barbero'
      AND contype = 'x'
  ) THEN
    RAISE EXCEPTION 'MF_F1_OVERLAP_CONSTRAINT_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.citas_holds'::regclass
      AND conname = 'uq_hold_cita'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'MF_F1_HOLD_PER_APPOINTMENT_CONSTRAINT_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_citas_detalles_normalizar'
  ) THEN
    RAISE EXCEPTION 'MF_F1_DETAIL_GUARD_MISSING';
  END IF;
END;
$mf$;

-- ============================================================================
-- 1. PARÁMETROS CANÓNICOS
-- hold_duracion_min es la fuente de verdad porque ya la consumen backend y panel.
-- ============================================================================
INSERT INTO public.parametros_sistema (
  clave,
  valor_numero,
  descripcion,
  updated_at
)
VALUES (
  'hold_duracion_min',
  5,
  'Duración configurable en minutos del hold de citas antes de liberar el horario',
  now()
)
ON CONFLICT (clave) DO NOTHING;

UPDATE public.parametros_sistema
SET valor_numero = 5,
    updated_at = now()
WHERE clave = 'hold_duracion_min'
  AND (
    valor_numero IS NULL
    OR valor_numero < 1
    OR valor_numero > 120
  );

INSERT INTO public.parametros_sistema (
  clave,
  valor_numero,
  descripcion,
  updated_at
)
SELECT
  alias.clave,
  canonical.valor_numero,
  alias.descripcion,
  now()
FROM (
  VALUES
    ('hold_minutos', 'Alias legado sincronizado con hold_duracion_min'),
    ('agendamiento_hold_ttl_minutos', 'Alias legado sincronizado con hold_duracion_min')
) AS alias(clave, descripcion)
CROSS JOIN LATERAL (
  SELECT valor_numero
  FROM public.parametros_sistema
  WHERE clave = 'hold_duracion_min'
) AS canonical
ON CONFLICT (clave) DO UPDATE
SET valor_numero = EXCLUDED.valor_numero,
    descripcion = EXCLUDED.descripcion,
    updated_at = now();

INSERT INTO public.parametros_sistema (
  clave,
  valor_numero,
  descripcion,
  updated_at
)
VALUES (
  'agendamiento_confirmacion_pago_gracia_min',
  2,
  'Gracia máxima para finalizar una confirmación de pago detectada antes de vencer el hold',
  now()
)
ON CONFLICT (clave) DO NOTHING;

UPDATE public.parametros_sistema
SET valor_numero = 2,
    updated_at = now()
WHERE clave = 'agendamiento_confirmacion_pago_gracia_min'
  AND (
    valor_numero IS NULL
    OR valor_numero < 0
    OR valor_numero > 15
  );

INSERT INTO public.parametros_sistema (
  clave,
  valor_booleano,
  descripcion,
  updated_at
)
VALUES
  (
    'pago_total_obligatorio',
    true,
    'Exige el pago total antes de confirmar una cita con saldo pendiente',
    now()
  ),
  (
    'simulacion_sin_pago',
    false,
    'Desactiva la confirmación sin pago fuera de pruebas locales controladas',
    now()
  )
ON CONFLICT (clave) DO UPDATE
SET valor_booleano = EXCLUDED.valor_booleano,
    descripcion = EXCLUDED.descripcion,
    updated_at = now();

-- ============================================================================
-- 2. ESQUEMA PRIVADO E IDEMPOTENCIA
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION postgres;

REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
REVOKE ALL ON SCHEMA app_private FROM anon;
REVOKE ALL ON SCHEMA app_private FROM authenticated;
REVOKE ALL ON SCHEMA app_private FROM service_role;
GRANT USAGE ON SCHEMA app_private TO postgres;

CREATE TABLE IF NOT EXISTS app_private.reserva_idempotencia (
  request_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  id_grupo_cita uuid NULL,
  resultado jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'app_private.reserva_idempotencia'::regclass
      AND conname = 'fk_reserva_idempotencia_grupo'
  ) THEN
    ALTER TABLE app_private.reserva_idempotencia
      ADD CONSTRAINT fk_reserva_idempotencia_grupo
      FOREIGN KEY (id_grupo_cita)
      REFERENCES public.citas_grupos(id_grupo_cita)
      ON UPDATE CASCADE
      ON DELETE CASCADE;
  END IF;
END;
$mf$;

CREATE INDEX IF NOT EXISTS idx_reserva_idempotencia_created_at
  ON app_private.reserva_idempotencia (created_at);

REVOKE ALL ON TABLE app_private.reserva_idempotencia FROM PUBLIC;
REVOKE ALL ON TABLE app_private.reserva_idempotencia FROM anon;
REVOKE ALL ON TABLE app_private.reserva_idempotencia FROM authenticated;
REVOKE ALL ON TABLE app_private.reserva_idempotencia FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_private.reserva_idempotencia TO postgres;

-- ============================================================================
-- 3. MARCA AUTORITATIVA DEL MOMENTO DE PAGO
-- paid_at representa cuándo el proveedor capturó el pago, no cuándo llegó el
-- callback. Para compatibilidad, al confirmar se intenta tomar payments.paid_at.
-- ============================================================================
ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL;

CREATE OR REPLACE FUNCTION public.fn_payment_intents_capture_paid_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mf$
DECLARE
  v_expires_at timestamptz;
  v_payment_time timestamptz;
BEGIN
  IF NEW.origen_pago_codigo <> 'cita' THEN
    RETURN NEW;
  END IF;

  -- pendiente_confirmacion solo se considera pago detectado cuando el backend
  -- envía paid_at explícitamente desde un evento firmado del proveedor.
  IF NEW.estado_intent_codigo = 'pendiente_confirmacion'
     AND NEW.paid_at IS NOT NULL THEN
    SELECT min(h.expires_at)
    INTO v_expires_at
    FROM public.citas_holds h
    JOIN public.citas c
      ON c.id_cita = h.id_cita
    WHERE h.id_hold = NEW.id_hold
       OR c.id_cita = NEW.id_cita
       OR (
         NEW.id_grupo_cita IS NOT NULL
         AND c.id_grupo_cita = NEW.id_grupo_cita
       );

    IF v_expires_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
    END IF;

    IF NEW.paid_at > v_expires_at THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.estado_intent_codigo <> 'confirmado' THEN
    RETURN NEW;
  END IF;

  SELECT min(h.expires_at)
  INTO v_expires_at
  FROM public.citas_holds h
  JOIN public.citas c
    ON c.id_cita = h.id_cita
  WHERE h.id_hold = NEW.id_hold
     OR c.id_cita = NEW.id_cita
     OR (
       NEW.id_grupo_cita IS NOT NULL
       AND c.id_grupo_cita = NEW.id_grupo_cita
     );

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
  END IF;

  SELECT min(p.paid_at)
  INTO v_payment_time
  FROM public.payments p
  WHERE p.id_intent = NEW.id_intent
    AND p.estado_pago_codigo = 'capturado'
    AND p.paid_at IS NOT NULL;

  IF TG_OP = 'UPDATE' THEN
    v_payment_time := COALESCE(
      NEW.paid_at,
      v_payment_time,
      OLD.paid_at,
      clock_timestamp()
    );
  ELSE
    v_payment_time := COALESCE(
      NEW.paid_at,
      v_payment_time,
      clock_timestamp()
    );
  END IF;

  IF v_payment_time > v_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
  END IF;

  NEW.paid_at := v_payment_time;
  RETURN NEW;
END;
$mf$;

REVOKE ALL ON FUNCTION public.fn_payment_intents_capture_paid_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_payment_intents_capture_paid_at() FROM anon;
REVOKE ALL ON FUNCTION public.fn_payment_intents_capture_paid_at() FROM authenticated;
REVOKE ALL ON FUNCTION public.fn_payment_intents_capture_paid_at() FROM service_role;
GRANT EXECUTE ON FUNCTION public.fn_payment_intents_capture_paid_at() TO postgres;

DROP TRIGGER IF EXISTS tr_payment_intents_capture_paid_at
  ON public.payment_intents;

CREATE TRIGGER tr_payment_intents_capture_paid_at
BEFORE INSERT OR UPDATE OF estado_intent_codigo, paid_at
ON public.payment_intents
FOR EACH ROW
EXECUTE FUNCTION public.fn_payment_intents_capture_paid_at();

-- ============================================================================
-- 4. ÍNDICES OPERATIVOS Y CORRECCIÓN DE IDENTIDAD DE LÍNEA
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_citas_holds_activos_expires
  ON public.citas_holds (expires_at, id_cita)
  WHERE estado_hold_codigo = 'activo';

CREATE INDEX IF NOT EXISTS idx_payment_intents_activos_expires
  ON public.payment_intents (expires_at, id_grupo_cita, id_cita, id_hold)
  WHERE estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion');

CREATE INDEX IF NOT EXISTS idx_bloqueos_agenda_empleado_rango_gist
  ON public.bloqueos_agenda
  USING gist (id_empleado, rango);

CREATE INDEX IF NOT EXISTS idx_horarios_sucursal_publicados_vigencia
  ON public.horarios_semanales_sucursales (
    id_sucursal,
    vigencia_desde DESC,
    vigencia_hasta,
    created_at DESC
  )
  WHERE estado_horario_codigo = 'publicado';

CREATE INDEX IF NOT EXISTS idx_horarios_sucursal_bloques_dia
  ON public.horarios_semanales_sucursales_bloques (
    id_horario_sucursal,
    dia_semana,
    hora_inicio,
    hora_fin
  );

CREATE INDEX IF NOT EXISTS idx_horarios_empleado_dia_activo
  ON public.horarios_semanales_empleados (
    id_empleado,
    dia_semana,
    hora_inicio,
    hora_fin
  )
  WHERE activo IS TRUE;

DO $mf$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.citas_holds
    WHERE id_usuario IS NOT NULL
      AND estado_hold_codigo = 'activo'
    GROUP BY id_usuario
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'MF_F1_DUPLICATE_ACTIVE_USER_HOLDS';
  END IF;
END;
$mf$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_citas_holds_usuario_activo
  ON public.citas_holds (id_usuario)
  WHERE id_usuario IS NOT NULL
    AND estado_hold_codigo = 'activo';

DO $mf$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles
    GROUP BY
      id_cita,
      id_servicio,
      COALESCE(id_tarifa, '00000000-0000-0000-0000-000000000000'::uuid),
      origen_item_codigo,
      COALESCE(id_cita_paquete, '00000000-0000-0000-0000-000000000000'::uuid)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'MF_F1_DUPLICATE_CANONICAL_DETAIL_LINES';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.citas_detalles'::regclass
      AND conname = 'uq_cita_servicio'
      AND contype = 'u'
  ) THEN
    ALTER TABLE public.citas_detalles
      DROP CONSTRAINT uq_cita_servicio;
  END IF;
END;
$mf$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_citas_detalles_linea_canonica
  ON public.citas_detalles (
    id_cita,
    id_servicio,
    COALESCE(id_tarifa, '00000000-0000-0000-0000-000000000000'::uuid),
    origen_item_codigo,
    COALESCE(id_cita_paquete, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================================
-- 5. HELPERS DE CONFIGURACIÓN
-- ============================================================================
CREATE OR REPLACE FUNCTION app_private.obtener_hold_ttl_min_v1()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mf$
  SELECT LEAST(
    120,
    GREATEST(
      1,
      COALESCE(
        (
          SELECT trunc(ps.valor_numero)::integer
          FROM public.parametros_sistema ps
          WHERE ps.clave = 'hold_duracion_min'
          LIMIT 1
        ),
        5
      )
    )
  );
$mf$;

CREATE OR REPLACE FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $mf$
  SELECT LEAST(
    15,
    GREATEST(
      0,
      COALESCE(
        (
          SELECT trunc(ps.valor_numero)::integer
          FROM public.parametros_sistema ps
          WHERE ps.clave = 'agendamiento_confirmacion_pago_gracia_min'
          LIMIT 1
        ),
        2
      )
    )
  );
$mf$;

REVOKE ALL ON FUNCTION app_private.obtener_hold_ttl_min_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.obtener_hold_ttl_min_v1() FROM anon;
REVOKE ALL ON FUNCTION app_private.obtener_hold_ttl_min_v1() FROM authenticated;
REVOKE ALL ON FUNCTION app_private.obtener_hold_ttl_min_v1() FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.obtener_hold_ttl_min_v1() TO postgres;

REVOKE ALL ON FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1() FROM anon;
REVOKE ALL ON FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1() FROM authenticated;
REVOKE ALL ON FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1() FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.obtener_gracia_confirmacion_pago_min_v1() TO postgres;

-- Revalidación operativa dentro de la misma transacción de creación.
CREATE OR REPLACE FUNCTION app_private.validar_horario_reserva_v1(
  p_id_sucursal uuid,
  p_id_barbero uuid,
  p_inicio_at timestamptz,
  p_fin_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mf$
DECLARE
  v_inicio_local timestamp without time zone;
  v_fin_local timestamp without time zone;
  v_fecha date;
  v_dia_semana smallint;
  v_hora_inicio time without time zone;
  v_hora_fin time without time zone;
  v_id_horario_sucursal uuid;
  v_id_empleado_plantilla uuid;
  v_tiene_horario boolean;
  v_disponible boolean;
BEGIN
  IF p_id_sucursal IS NULL
     OR p_id_barbero IS NULL
     OR p_inicio_at IS NULL
     OR p_fin_at IS NULL
     OR p_fin_at <= p_inicio_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_SLOT_RANGE_INVALID';
  END IF;

  v_inicio_local := p_inicio_at AT TIME ZONE 'America/Tegucigalpa';
  v_fin_local := p_fin_at AT TIME ZONE 'America/Tegucigalpa';

  IF v_inicio_local::date IS DISTINCT FROM v_fin_local::date THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_CROSSES_OPERATIONAL_DAY';
  END IF;

  v_fecha := v_inicio_local::date;
  v_dia_semana := extract(dow FROM v_fecha)::smallint;
  v_hora_inicio := v_inicio_local::time;
  v_hora_fin := v_fin_local::time;

  IF NOT EXISTS (
    SELECT 1
    FROM public.empleados e
    WHERE e.id_empleado = p_id_barbero
      AND e.id_sucursal = p_id_sucursal
      AND e.estado IS TRUE
      AND e.es_barbero IS TRUE
      AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_BARBERO_INVALIDO';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bloqueos_agenda ba
    WHERE ba.id_empleado = p_id_barbero
      AND ba.id_sucursal = p_id_sucursal
      AND ba.rango && tstzrange(p_inicio_at, p_fin_at, '[)')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_BLOCKED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas c
    WHERE c.id_empleado_barbero = p_id_barbero
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo IN (
        'en_espera',
        'pendiente_pago',
        'confirmada',
        'en_salon',
        'en_atencion'
      )
      AND tstzrange(c.inicio_at, c.fin_at, '[)')
          && tstzrange(p_inicio_at, p_fin_at, '[)')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_TAKEN';
  END IF;

  SELECT hss.id_horario_sucursal
  INTO v_id_horario_sucursal
  FROM public.horarios_semanales_sucursales hss
  WHERE hss.id_sucursal = p_id_sucursal
    AND hss.estado_horario_codigo = 'publicado'
    AND hss.vigencia_desde <= v_fecha
    AND (
      hss.vigencia_hasta IS NULL
      OR hss.vigencia_hasta >= v_fecha
    )
  ORDER BY
    hss.vigencia_desde DESC,
    hss.created_at DESC,
    hss.id_horario_sucursal DESC
  LIMIT 1;

  IF v_id_horario_sucursal IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.horarios_semanales_sucursales_bloques b
      WHERE b.id_horario_sucursal = v_id_horario_sucursal
        AND b.dia_semana = v_dia_semana
        AND v_hora_inicio >= b.hora_inicio
        AND v_hora_fin <= b.hora_fin
    )
    INTO v_disponible;

    IF NOT v_disponible THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_SLOT_OUTSIDE_BRANCH_SCHEDULE';
    END IF;

    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.horarios_semanales_empleados hs
    WHERE hs.id_empleado = p_id_barbero
      AND hs.dia_semana = v_dia_semana
      AND hs.activo IS TRUE
  )
  INTO v_tiene_horario;

  IF v_tiene_horario THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.horarios_semanales_empleados hs
      WHERE hs.id_empleado = p_id_barbero
        AND hs.dia_semana = v_dia_semana
        AND hs.activo IS TRUE
        AND v_hora_inicio >= hs.hora_inicio
        AND v_hora_fin <= hs.hora_fin
        AND NOT (
          hs.almuerzo_inicio IS NOT NULL
          AND hs.almuerzo_fin IS NOT NULL
          AND v_hora_inicio < hs.almuerzo_fin
          AND v_hora_fin > hs.almuerzo_inicio
        )
    )
    INTO v_disponible;

    IF NOT v_disponible THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_SLOT_OUTSIDE_BARBER_SCHEDULE';
    END IF;

    RETURN;
  END IF;

  SELECT e.id_empleado
  INTO v_id_empleado_plantilla
  FROM public.empleados e
  WHERE e.id_sucursal = p_id_sucursal
    AND e.deleted_at IS NULL
    AND e.estado IS TRUE
    AND EXISTS (
      SELECT 1
      FROM public.horarios_semanales_empleados hs
      WHERE hs.id_empleado = e.id_empleado
        AND hs.dia_semana = v_dia_semana
        AND hs.activo IS TRUE
    )
  ORDER BY e.es_barbero DESC, e.id_empleado ASC
  LIMIT 1;

  IF v_id_empleado_plantilla IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.horarios_semanales_empleados hs
      WHERE hs.id_empleado = v_id_empleado_plantilla
        AND hs.dia_semana = v_dia_semana
        AND hs.activo IS TRUE
        AND v_hora_inicio >= hs.hora_inicio
        AND v_hora_fin <= hs.hora_fin
        AND NOT (
          hs.almuerzo_inicio IS NOT NULL
          AND hs.almuerzo_fin IS NOT NULL
          AND v_hora_inicio < hs.almuerzo_fin
          AND v_hora_fin > hs.almuerzo_inicio
        )
    )
    INTO v_disponible;

    IF NOT v_disponible THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_SLOT_OUTSIDE_TEMPLATE_SCHEDULE';
    END IF;

    RETURN;
  END IF;

  -- Fallback legado idéntico al servicio actual mientras todas las sucursales
  -- terminan de publicar su horario semanal.
  IF v_dia_semana = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_BRANCH_CLOSED';
  END IF;

  IF v_hora_inicio < time '08:00:00'
     OR v_hora_fin > (
       CASE
         WHEN v_dia_semana = 6 THEN time '17:00:00'
         ELSE time '19:00:00'
       END
     )
     OR (
       v_hora_inicio < time '13:00:00'
       AND v_hora_fin > time '12:00:00'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_OUTSIDE_FALLBACK_SCHEDULE';
  END IF;
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.validar_horario_reserva_v1(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.validar_horario_reserva_v1(uuid, uuid, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION app_private.validar_horario_reserva_v1(uuid, uuid, timestamptz, timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.validar_horario_reserva_v1(uuid, uuid, timestamptz, timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.validar_horario_reserva_v1(uuid, uuid, timestamptz, timestamptz) TO postgres;

-- ============================================================================
-- 6. EXPIRACIÓN INTEGRAL DE HOLDS
-- Libera citas con hold vencido, aunque todavía no exista payment_intent.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_private.expirar_reservas_vencidas_v1(
  p_limite integer DEFAULT 500,
  p_ahora timestamptz DEFAULT clock_timestamp(),
  p_id_sucursal uuid DEFAULT NULL,
  p_id_barbero uuid DEFAULT NULL,
  p_inicio_at timestamptz DEFAULT NULL,
  p_fin_at timestamptz DEFAULT NULL,
  p_id_usuario_titular uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
DECLARE
  v_limite integer := LEAST(5000, GREATEST(1, COALESCE(p_limite, 500)));
  v_gracia integer := app_private.obtener_gracia_confirmacion_pago_min_v1();
  v_holds_consumidos integer := 0;
  v_citas_confirmadas integer := 0;
  v_holds_expirados integer := 0;
  v_citas_expiradas integer := 0;
  v_intents_expirados integer := 0;
BEGIN
  IF (p_inicio_at IS NULL) <> (p_fin_at IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_F1_EXPIRY_RANGE_INCOMPLETE';
  END IF;

  IF p_inicio_at IS NOT NULL AND p_fin_at <= p_inicio_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_F1_EXPIRY_RANGE_INVALID';
  END IF;

  -- Reparación idempotente: si el intent quedó confirmado dentro del TTL,
  -- el hold debe quedar consumido y la cita confirmada.
  WITH pagadas AS (
    SELECT
      h.id_hold,
      h.id_cita,
      c.id_grupo_cita
    FROM public.citas_holds h
    JOIN public.citas c
      ON c.id_cita = h.id_cita
    LEFT JOIN public.citas_grupos cg
      ON cg.id_grupo_cita = c.id_grupo_cita
    WHERE h.estado_hold_codigo = 'activo'
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada')
      AND (p_id_sucursal IS NULL OR c.id_sucursal = p_id_sucursal)
      AND (p_id_barbero IS NULL OR c.id_empleado_barbero = p_id_barbero)
      AND (
        p_id_usuario_titular IS NULL
        OR cg.id_usuario_titular = p_id_usuario_titular
        OR h.id_usuario = p_id_usuario_titular
      )
      AND (
        p_inicio_at IS NULL
        OR tstzrange(c.inicio_at, c.fin_at, '[)')
           && tstzrange(p_inicio_at, p_fin_at, '[)')
      )
      AND (
        c.estado_cita_codigo = 'confirmada'
        OR EXISTS (
          SELECT 1
          FROM public.payment_intents pi
          WHERE pi.origen_pago_codigo = 'cita'
            AND pi.estado_intent_codigo = 'confirmado'
            AND COALESCE(pi.paid_at, pi.updated_at) <= h.expires_at
            AND (
              pi.id_hold = h.id_hold
              OR pi.id_cita = c.id_cita
              OR pi.id_grupo_cita = c.id_grupo_cita
            )
        )
      )
    ORDER BY h.id_hold
    FOR UPDATE OF h SKIP LOCKED
    LIMIT v_limite
  ),
  confirmed_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'confirmada',
        updated_at = now()
    FROM pagadas p
    WHERE c.id_cita = p.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita
  ),
  consumed_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'consumido',
        updated_at = now()
    FROM pagadas p
    WHERE h.id_hold = p.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  )
  SELECT
    (SELECT count(*) FROM confirmed_citas),
    (SELECT count(*) FROM consumed_holds)
  INTO v_citas_confirmadas, v_holds_consumidos;

  WITH candidatos AS (
    SELECT
      h.id_hold,
      h.id_cita,
      c.id_grupo_cita,
      h.expires_at
    FROM public.citas_holds h
    JOIN public.citas c
      ON c.id_cita = h.id_cita
    LEFT JOIN public.citas_grupos cg
      ON cg.id_grupo_cita = c.id_grupo_cita
    WHERE h.estado_hold_codigo = 'activo'
      AND h.expires_at <= p_ahora
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
      AND (p_id_sucursal IS NULL OR c.id_sucursal = p_id_sucursal)
      AND (p_id_barbero IS NULL OR c.id_empleado_barbero = p_id_barbero)
      AND (
        p_id_usuario_titular IS NULL
        OR cg.id_usuario_titular = p_id_usuario_titular
        OR h.id_usuario = p_id_usuario_titular
      )
      AND (
        p_inicio_at IS NULL
        OR tstzrange(c.inicio_at, c.fin_at, '[)')
           && tstzrange(p_inicio_at, p_fin_at, '[)')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payment_intents pi
        WHERE pi.origen_pago_codigo = 'cita'
          AND (
            pi.id_hold = h.id_hold
            OR pi.id_cita = c.id_cita
            OR pi.id_grupo_cita = c.id_grupo_cita
          )
          AND (
            (
              pi.estado_intent_codigo = 'confirmado'
              AND COALESCE(pi.paid_at, pi.updated_at) <= h.expires_at
            )
            OR (
              pi.estado_intent_codigo = 'pendiente_confirmacion'
              AND COALESCE(pi.paid_at, pi.updated_at) <= h.expires_at
              AND COALESCE(pi.paid_at, pi.updated_at) + make_interval(mins => v_gracia) > p_ahora
            )
          )
      )
    ORDER BY h.expires_at, h.id_hold
    FOR UPDATE OF h SKIP LOCKED
    LIMIT v_limite
  ),
  expired_intents AS (
    UPDATE public.payment_intents pi
    SET estado_intent_codigo = 'expirado',
        updated_at = now()
    FROM candidatos x
    WHERE pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
      AND (
        pi.id_hold = x.id_hold
        OR pi.id_cita = x.id_cita
        OR pi.id_grupo_cita = x.id_grupo_cita
      )
    RETURNING pi.id_intent
  ),
  expired_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'expirado',
        updated_at = now()
    FROM candidatos x
    WHERE h.id_hold = x.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  ),
  expired_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'expirada',
        updated_at = now()
    FROM candidatos x
    WHERE c.id_cita = x.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita
  )
  SELECT
    (SELECT count(*) FROM expired_intents),
    (SELECT count(*) FROM expired_holds),
    (SELECT count(*) FROM expired_citas)
  INTO v_intents_expirados, v_holds_expirados, v_citas_expiradas;

  RETURN jsonb_build_object(
    'holds_consumidos', v_holds_consumidos,
    'citas_confirmadas', v_citas_confirmadas,
    'holds_expirados', v_holds_expirados,
    'citas_expiradas', v_citas_expiradas,
    'intents_expirados', v_intents_expirados,
    'procesado_at', p_ahora
  );
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM anon;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) TO postgres;

-- Compatibilidad con el cron y código existentes.
CREATE OR REPLACE PROCEDURE public.fn_reconcile_pending_payments(
  IN p_limite integer DEFAULT 500
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
BEGIN
  PERFORM app_private.expirar_reservas_vencidas_v1(
    p_limite,
    clock_timestamp(),
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );
END;
$mf$;

REVOKE ALL ON PROCEDURE public.fn_reconcile_pending_payments(integer) FROM PUBLIC;
REVOKE ALL ON PROCEDURE public.fn_reconcile_pending_payments(integer) FROM anon;
REVOKE ALL ON PROCEDURE public.fn_reconcile_pending_payments(integer) FROM authenticated;
REVOKE ALL ON PROCEDURE public.fn_reconcile_pending_payments(integer) FROM service_role;
GRANT EXECUTE ON PROCEDURE public.fn_reconcile_pending_payments(integer) TO postgres;

-- El trigger legado pasa a usar la configuración real y un lock por usuario.
CREATE OR REPLACE FUNCTION public.fn_hold_defaults_y_unico()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
DECLARE
  v_existe boolean;
  v_ahora timestamptz := clock_timestamp();
BEGIN
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := v_ahora
      + make_interval(mins => app_private.obtener_hold_ttl_min_v1());
  END IF;

  IF NEW.expires_at <= v_ahora THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_HOLD_EXPIRY_MUST_BE_FUTURE';
  END IF;

  IF NEW.expires_at > v_ahora + interval '120 minutes' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_HOLD_EXPIRY_EXCEEDS_MAXIMUM';
  END IF;

  IF NEW.estado_hold_codigo IS NULL OR btrim(NEW.estado_hold_codigo) = '' THEN
    NEW.estado_hold_codigo := 'activo';
  END IF;

  IF NEW.id_usuario IS NOT NULL
     AND NEW.estado_hold_codigo = 'activo' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('masterfade:active-hold-user:' || NEW.id_usuario::text, 0)
    );

    PERFORM app_private.expirar_reservas_vencidas_v1(
      100,
      v_ahora,
      NULL,
      NULL,
      NULL,
      NULL,
      NEW.id_usuario
    );

    SELECT EXISTS (
      SELECT 1
      FROM public.citas_holds h
      WHERE h.id_usuario = NEW.id_usuario
        AND h.estado_hold_codigo = 'activo'
        AND h.expires_at > v_ahora
        AND h.id_cita <> NEW.id_cita
    )
    INTO v_existe;

    IF v_existe THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO';
    END IF;
  END IF;

  RETURN NEW;
END;
$mf$;

-- ============================================================================
-- 7. RPC CANÓNICA PARA CREAR GRUPO + CITAS + DETALLES + HOLDS
-- Solo services en esta fase. El backend resuelve identidad y descuentos.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_private.crear_reserva_canonica_v1(
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
DECLARE
  v_request_id uuid;
  v_payload_hash text;
  v_idempotencia_insertada integer;
  v_idempotencia app_private.reserva_idempotencia%ROWTYPE;

  v_id_sucursal uuid;
  v_id_persona_titular uuid;
  v_id_cliente_titular uuid;
  v_id_usuario_titular uuid;
  v_origen_codigo text;
  v_notas text;
  v_release_token_hash text;

  v_integrantes jsonb;
  v_integrante jsonb;
  v_detalles jsonb;
  v_detalle jsonb;
  v_num_integrantes integer;
  v_max_integrantes integer;
  v_indice integer := 0;
  v_orden integer;

  v_id_grupo_cita uuid;
  v_codigo_reserva text;
  v_estado_grupo text;
  v_id_cita_integrante uuid;
  v_id_cita uuid;
  v_id_hold uuid;

  v_id_persona uuid;
  v_id_cliente uuid;
  v_id_usuario_integrante uuid;
  v_tipo_cliente text;
  v_alias text;
  v_contacto_nombre text;
  v_contacto_email text;
  v_contacto_telefono text;
  v_id_barbero uuid;
  v_autoasignada boolean;
  v_es_canje_recompensa boolean;
  v_inicio_text text;
  v_inicio_at timestamptz;
  v_fin_at timestamptz;
  v_fecha_operativa date;
  v_fecha_titular date;
  v_duracion_total integer;
  v_buffer_total integer;

  v_det_id_servicio uuid;
  v_det_id_tarifa uuid;
  v_det_cantidad integer;
  v_det_duracion integer;
  v_det_buffer integer;
  v_det_precio numeric;
  v_det_precio_referencia numeric;
  v_det_descuento numeric;
  v_det_incluye_isv boolean;
  v_det_isv_porcentaje numeric;
  v_det_origen text;

  v_hold_ttl integer;
  v_expires_at timestamptz;
  v_hold_user_id uuid;
  v_ahora timestamptz := clock_timestamp();

  v_cita public.citas%ROWTYPE;
  v_total_grupo numeric;
  v_bloques jsonb := '[]'::jsonb;
  v_resultado jsonb;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_PAYLOAD_INVALIDO';
  END IF;

  BEGIN
    v_request_id := NULLIF(btrim(p_payload->>'request_id'), '')::uuid;
    v_id_sucursal := NULLIF(btrim(p_payload->>'id_sucursal'), '')::uuid;
    v_id_persona_titular := NULLIF(btrim(p_payload->>'id_persona_titular'), '')::uuid;
    v_id_cliente_titular := NULLIF(btrim(p_payload->>'id_cliente_titular'), '')::uuid;
    v_id_usuario_titular := NULLIF(btrim(p_payload->>'id_usuario_titular'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_UUID_INVALIDO';
  END;

  IF v_request_id IS NULL
     OR v_id_sucursal IS NULL
     OR v_id_persona_titular IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_REQUIRED_IDS_MISSING';
  END IF;

  v_payload_hash := md5(p_payload::text);

  INSERT INTO app_private.reserva_idempotencia (
    request_id,
    payload_hash
  )
  VALUES (
    v_request_id,
    v_payload_hash
  )
  ON CONFLICT (request_id) DO NOTHING;

  GET DIAGNOSTICS v_idempotencia_insertada = ROW_COUNT;

  IF v_idempotencia_insertada = 0 THEN
    SELECT *
    INTO v_idempotencia
    FROM app_private.reserva_idempotencia
    WHERE request_id = v_request_id
    FOR UPDATE;

    IF v_idempotencia.payload_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;

    IF v_idempotencia.resultado IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_IDEMPOTENCY_INCOMPLETE';
    END IF;

    RETURN v_idempotencia.resultado;
  END IF;

  v_origen_codigo := COALESCE(
    NULLIF(btrim(p_payload->>'origen_codigo'), ''),
    CASE WHEN v_id_usuario_titular IS NULL THEN 'publico' ELSE 'cliente_autenticado' END
  );

  IF v_origen_codigo NOT IN (
    'publico',
    'cliente_autenticado',
    'admin',
    'barbero',
    'legacy',
    'sistema',
    'panel'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_ORIGEN_INVALIDO';
  END IF;

  v_notas := NULLIF(btrim(p_payload->>'notas'), '');
  IF length(COALESCE(v_notas, '')) > 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_NOTAS_TOO_LONG';
  END IF;

  v_release_token_hash := lower(NULLIF(btrim(p_payload->>'release_token_hash'), ''));
  IF v_release_token_hash IS NOT NULL
     AND v_release_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_RELEASE_TOKEN_HASH_INVALIDO';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.sucursales s
    WHERE s.id_sucursal = v_id_sucursal
      AND s.estado IS TRUE
      AND s.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_SUCURSAL_INACTIVA_O_INEXISTENTE';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.personas p
    WHERE p.id_persona = v_id_persona_titular
      AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_PERSONA_TITULAR_INEXISTENTE';
  END IF;

  IF v_id_cliente_titular IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.clientes c
       WHERE c.id_cliente = v_id_cliente_titular
         AND c.id_persona = v_id_persona_titular
         AND c.estado IS TRUE
         AND c.deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_CLIENTE_TITULAR_MISMATCH';
  END IF;

  IF v_id_usuario_titular IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.usuarios u
       WHERE u.id_usuario = v_id_usuario_titular
         AND u.id_persona = v_id_persona_titular
         AND u.estado IS TRUE
         AND u.deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_USUARIO_TITULAR_MISMATCH';
  END IF;

  v_integrantes := p_payload->'integrantes';
  IF v_integrantes IS NULL OR jsonb_typeof(v_integrantes) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_INTEGRANTES_REQUIRED';
  END IF;

  v_num_integrantes := jsonb_array_length(v_integrantes);
  SELECT LEAST(
    10,
    GREATEST(
      1,
      COALESCE(
        (
          SELECT trunc(ps.valor_numero)::integer + 1
          FROM public.parametros_sistema ps
          WHERE ps.clave = 'agendamiento_max_acompanantes'
          LIMIT 1
        ),
        5
      )
    )
  )
  INTO v_max_integrantes;

  IF v_num_integrantes < 1 OR v_num_integrantes > v_max_integrantes THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'MF_RESERVA_INTEGRANTES_LIMIT_INVALID';
  END IF;

  IF v_id_usuario_titular IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('masterfade:booking-user:' || v_id_usuario_titular::text, 0)
    );

    PERFORM app_private.expirar_reservas_vencidas_v1(
      500,
      v_ahora,
      NULL,
      NULL,
      NULL,
      NULL,
      v_id_usuario_titular
    );

    IF EXISTS (
      SELECT 1
      FROM public.citas_grupos cg
      JOIN public.citas c
        ON c.id_grupo_cita = cg.id_grupo_cita
      JOIN public.citas_holds h
        ON h.id_cita = c.id_cita
      WHERE cg.id_usuario_titular = v_id_usuario_titular
        AND cg.estado_grupo_codigo = 'activo'
        AND c.deleted_at IS NULL
        AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
        AND h.estado_hold_codigo = 'activo'
        AND h.expires_at > v_ahora
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_PENDIENTE_EXISTENTE';
    END IF;
  END IF;

  v_hold_ttl := app_private.obtener_hold_ttl_min_v1();
  v_expires_at := v_ahora + make_interval(mins => v_hold_ttl);
  v_hold_user_id := CASE
    WHEN v_num_integrantes = 1 THEN v_id_usuario_titular
    ELSE NULL
  END;

  INSERT INTO public.citas_grupos (
    id_sucursal,
    id_persona_titular,
    id_cliente_titular,
    id_usuario_titular,
    origen_codigo,
    estado_grupo_codigo,
    notas,
    release_token_hash,
    release_token_created_at
  )
  VALUES (
    v_id_sucursal,
    v_id_persona_titular,
    v_id_cliente_titular,
    v_id_usuario_titular,
    v_origen_codigo,
    'activo',
    v_notas,
    v_release_token_hash,
    CASE WHEN v_release_token_hash IS NULL THEN NULL ELSE v_ahora END
  )
  RETURNING id_grupo_cita, codigo_reserva, estado_grupo_codigo
  INTO v_id_grupo_cita, v_codigo_reserva, v_estado_grupo;

  FOR v_integrante IN
    SELECT value
    FROM jsonb_array_elements(v_integrantes)
  LOOP
    v_indice := v_indice + 1;

    IF jsonb_typeof(v_integrante) <> 'object' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_INTEGRANTE_INVALIDO';
    END IF;

    BEGIN
      v_orden := COALESCE(
        NULLIF(btrim(v_integrante->>'orden_integrante'), '')::integer,
        v_indice
      );
      v_id_persona := COALESCE(
        NULLIF(btrim(v_integrante->>'id_persona'), '')::uuid,
        v_id_persona_titular
      );
      v_id_cliente := NULLIF(
        btrim(v_integrante->>'id_cliente'),
        ''
      )::uuid;
      v_id_usuario_integrante := NULLIF(
        btrim(v_integrante->>'id_usuario'),
        ''
      )::uuid;
      v_id_barbero := NULLIF(
        btrim(v_integrante->>'id_empleado_barbero'),
        ''
      )::uuid;
      v_autoasignada := COALESCE(
        NULLIF(btrim(v_integrante->>'asignada_automaticamente'), '')::boolean,
        false
      );
      v_es_canje_recompensa := COALESCE(
        NULLIF(btrim(v_integrante->>'es_canje_recompensa'), '')::boolean,
        false
      );
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_INTEGRANTE_UUID_INVALIDO';
    END;

    IF v_orden <> v_indice THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_ORDEN_INTEGRANTE_INVALIDO';
    END IF;

    IF v_id_cliente IS NULL
       AND v_id_persona = v_id_persona_titular THEN
      v_id_cliente := v_id_cliente_titular;
    END IF;

    IF v_id_usuario_integrante IS NULL
       AND v_orden = 1 THEN
      v_id_usuario_integrante := v_id_usuario_titular;
    END IF;

    IF COALESCE(NULLIF(v_integrante->>'selection_type', ''), 'services') <> 'services' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'BOOKING_PACKAGE_FLOW_PENDING_2B';
    END IF;

    IF v_id_persona IS NULL OR v_id_barbero IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_INTEGRANTE_REQUIRED_IDS_MISSING';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.personas p
      WHERE p.id_persona = v_id_persona
        AND p.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_PERSONA_INTEGRANTE_INEXISTENTE';
    END IF;

    IF v_id_cliente IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.clientes c
         WHERE c.id_cliente = v_id_cliente
           AND c.id_persona = v_id_persona
           AND c.estado IS TRUE
           AND c.deleted_at IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_CLIENTE_INTEGRANTE_MISMATCH';
    END IF;

    IF v_id_usuario_integrante IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.usuarios u
         WHERE u.id_usuario = v_id_usuario_integrante
           AND u.id_persona = v_id_persona
           AND u.estado IS TRUE
           AND u.deleted_at IS NULL
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_USUARIO_INTEGRANTE_MISMATCH';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.empleados e
      WHERE e.id_empleado = v_id_barbero
        AND e.id_sucursal = v_id_sucursal
        AND e.estado IS TRUE
        AND e.es_barbero IS TRUE
        AND e.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_BARBERO_INVALIDO';
    END IF;

    v_alias := NULLIF(btrim(v_integrante->>'alias'), '');
    IF v_alias IS NULL THEN
      v_alias := CASE WHEN v_orden = 1 THEN 'Titular' ELSE 'Acompañante ' || (v_orden - 1)::text END;
    END IF;
    IF length(v_alias) > 80 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_ALIAS_TOO_LONG';
    END IF;

    v_contacto_nombre := COALESCE(
      NULLIF(btrim(v_integrante->>'contacto_nombre'), ''),
      v_alias
    );
    v_contacto_email := lower(NULLIF(btrim(v_integrante->>'contacto_email'), ''));
    v_contacto_telefono := NULLIF(btrim(v_integrante->>'contacto_telefono'), '');

    IF length(v_contacto_nombre) > 180
       OR length(COALESCE(v_contacto_email, '')) > 160
       OR length(COALESCE(v_contacto_telefono, '')) > 24 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_CONTACTO_TOO_LONG';
    END IF;

    v_tipo_cliente := COALESCE(
      NULLIF(btrim(v_integrante->>'tipo_cliente_codigo'), ''),
      CASE WHEN v_id_usuario_integrante IS NOT NULL THEN 'autenticado' ELSE 'invitado' END
    );
    IF v_tipo_cliente NOT IN ('invitado', 'autenticado') THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_TIPO_CLIENTE_INVALIDO';
    END IF;

    v_inicio_text := NULLIF(btrim(v_integrante->>'inicio_at'), '');
    IF v_inicio_text IS NULL
       OR v_inicio_text !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'AGENDA_DATETIME_TIMEZONE_REQUIRED';
    END IF;

    BEGIN
      v_inicio_at := v_inicio_text::timestamptz;
    EXCEPTION
      WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_INICIO_INVALIDO';
    END;

    IF v_inicio_at <= v_ahora THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_INICIO_EN_PASADO';
    END IF;

    v_fecha_operativa := (v_inicio_at AT TIME ZONE 'America/Tegucigalpa')::date;
    IF v_indice = 1 THEN
      v_fecha_titular := v_fecha_operativa;
    ELSIF v_fecha_operativa IS DISTINCT FROM v_fecha_titular THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_COMPANION_DATE_MISMATCH';
    END IF;

    v_detalles := v_integrante->'detalles';
    IF v_detalles IS NULL
       OR jsonb_typeof(v_detalles) <> 'array'
       OR jsonb_array_length(v_detalles) < 1
       OR jsonb_array_length(v_detalles) > 20 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_DETALLES_INVALIDOS';
    END IF;

    v_duracion_total := 0;
    v_buffer_total := 0;

    FOR v_detalle IN
      SELECT value
      FROM jsonb_array_elements(v_detalles)
    LOOP
      IF jsonb_typeof(v_detalle) <> 'object' THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_DETALLE_INVALIDO';
      END IF;

      BEGIN
        v_det_id_servicio := NULLIF(btrim(v_detalle->>'id_servicio'), '')::uuid;
        v_det_id_tarifa := NULLIF(btrim(v_detalle->>'id_tarifa'), '')::uuid;
        v_det_cantidad := NULLIF(btrim(v_detalle->>'cantidad'), '')::integer;
        v_det_duracion := NULLIF(btrim(v_detalle->>'duracion_min'), '')::integer;
        v_det_buffer := NULLIF(btrim(v_detalle->>'buffer_min'), '')::integer;
        v_det_precio := NULLIF(btrim(v_detalle->>'precio_unitario_hnl'), '')::numeric;
        v_det_precio_referencia := COALESCE(
          NULLIF(btrim(v_detalle->>'precio_referencia_hnl'), '')::numeric,
          v_det_precio
        );
        v_det_descuento := COALESCE(
          NULLIF(btrim(v_detalle->>'descuento_hnl'), '')::numeric,
          0
        );
        v_det_incluye_isv := COALESCE(
          NULLIF(btrim(v_detalle->>'incluye_isv_snapshot'), '')::boolean,
          false
        );
        v_det_isv_porcentaje := COALESCE(
          NULLIF(btrim(v_detalle->>'isv_porcentaje'), '')::numeric,
          0
        );
      EXCEPTION
        WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'MF_RESERVA_DETALLE_FORMATO_INVALIDO';
      END;

      IF v_det_id_servicio IS NULL
         OR v_det_cantidad IS NULL
         OR v_det_duracion IS NULL
         OR v_det_buffer IS NULL
         OR v_det_precio IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_DETALLE_REQUIRED_FIELDS_MISSING';
      END IF;

      IF v_det_cantidad < 1
         OR v_det_cantidad > 20
         OR v_det_duracion < 1
         OR v_det_buffer < 0
         OR v_det_precio < 0
         OR v_det_precio_referencia < 0
         OR v_det_descuento < 0
         OR v_det_isv_porcentaje < 0
         OR v_det_isv_porcentaje > 100 THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_DETALLE_VALORES_INVALIDOS';
      END IF;

      IF round(v_det_descuento, 2)
         > round(v_det_precio * v_det_cantidad, 2) THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_DETALLE_DESCUENTO_INVALIDO';
      END IF;

      v_det_origen := COALESCE(
        NULLIF(btrim(v_detalle->>'origen_item_codigo'), ''),
        'servicio_manual'
      );

      IF v_det_origen NOT IN (
        'servicio_manual',
        'servicio_extra',
        'plan_incluido',
        'recompensa_masterpuntos'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_DETALLE_ORIGEN_INVALIDO';
      END IF;

      v_duracion_total := v_duracion_total
        + (v_det_duracion * v_det_cantidad);
      v_buffer_total := GREATEST(v_buffer_total, v_det_buffer);
    END LOOP;

    v_fin_at := v_inicio_at
      + make_interval(mins => v_duracion_total + v_buffer_total);

    PERFORM app_private.expirar_reservas_vencidas_v1(
      500,
      v_ahora,
      v_id_sucursal,
      v_id_barbero,
      v_inicio_at,
      v_fin_at,
      NULL
    );

    PERFORM app_private.validar_horario_reserva_v1(
      v_id_sucursal,
      v_id_barbero,
      v_inicio_at,
      v_fin_at
    );

    INSERT INTO public.citas_integrantes (
      id_grupo_cita,
      orden_integrante,
      rol_integrante_codigo,
      tipo_cliente_codigo,
      id_usuario,
      id_persona,
      id_cliente,
      contacto_nombre_snapshot,
      contacto_email_snapshot,
      contacto_telefono_snapshot,
      alias_integrante
    )
    VALUES (
      v_id_grupo_cita,
      v_orden,
      CASE WHEN v_orden = 1 THEN 'titular' ELSE 'acompanante' END,
      v_tipo_cliente,
      v_id_usuario_integrante,
      v_id_persona,
      v_id_cliente,
      v_contacto_nombre,
      v_contacto_email,
      v_contacto_telefono,
      v_alias
    )
    RETURNING id_cita_integrante
    INTO v_id_cita_integrante;

    INSERT INTO public.citas (
      id_grupo_cita,
      id_cita_integrante,
      orden_integrante,
      alias_integrante,
      id_sucursal,
      id_empleado_barbero,
      id_persona_cliente,
      id_cliente,
      creada_por_usuario_id,
      asignada_automaticamente,
      estado_cita_codigo,
      inicio_at,
      fin_at,
      duracion_total_min,
      buffer_total_min,
      subtotal_servicios_hnl,
      descuento_hnl,
      total_pagar_hnl,
      es_canje_recompensa,
      selection_type,
      id_paquete,
      contacto_nombre,
      contacto_email,
      contacto_telefono,
      notas
    )
    VALUES (
      v_id_grupo_cita,
      v_id_cita_integrante,
      v_orden,
      v_alias,
      v_id_sucursal,
      v_id_barbero,
      v_id_persona,
      v_id_cliente,
      v_id_usuario_titular,
      v_autoasignada,
      'en_espera',
      v_inicio_at,
      v_fin_at,
      v_duracion_total,
      v_buffer_total,
      0,
      0,
      0,
      v_es_canje_recompensa,
      'services',
      NULL,
      v_contacto_nombre,
      v_contacto_email,
      v_contacto_telefono,
      NULLIF(btrim(v_integrante->>'notas'), '')
    )
    RETURNING id_cita
    INTO v_id_cita;

    FOR v_detalle IN
      SELECT value
      FROM jsonb_array_elements(v_detalles)
    LOOP
      INSERT INTO public.citas_detalles (
        id_cita,
        id_servicio,
        id_tarifa,
        cantidad,
        duracion_min,
        buffer_min,
        nombre_servicio_snapshot,
        precio_referencia_hnl,
        precio_unitario_hnl,
        subtotal_hnl,
        descuento_hnl,
        incluye_isv_snapshot,
        isv_porcentaje,
        isv_hnl,
        total_linea_hnl,
        origen_item_codigo
      )
      VALUES (
        v_id_cita,
        (v_detalle->>'id_servicio')::uuid,
        (v_detalle->>'id_tarifa')::uuid,
        (v_detalle->>'cantidad')::integer,
        (v_detalle->>'duracion_min')::integer,
        (v_detalle->>'buffer_min')::integer,
        COALESCE(NULLIF(btrim(v_detalle->>'nombre_servicio_snapshot'), ''), 'Servicio'),
        COALESCE(
          NULLIF(v_detalle->>'precio_referencia_hnl', '')::numeric,
          (v_detalle->>'precio_unitario_hnl')::numeric
        ),
        (v_detalle->>'precio_unitario_hnl')::numeric,
        round(
          (v_detalle->>'precio_unitario_hnl')::numeric
          * (v_detalle->>'cantidad')::integer,
          2
        ),
        round(COALESCE((v_detalle->>'descuento_hnl')::numeric, 0), 2),
        COALESCE((v_detalle->>'incluye_isv_snapshot')::boolean, false),
        round(COALESCE((v_detalle->>'isv_porcentaje')::numeric, 0), 2),
        0,
        0,
        COALESCE(NULLIF(v_detalle->>'origen_item_codigo', ''), 'servicio_manual')
      );
    END LOOP;

    SELECT *
    INTO v_cita
    FROM public.citas c
    WHERE c.id_cita = v_id_cita
    FOR UPDATE;

    IF v_cita.duracion_total_min IS DISTINCT FROM v_duracion_total
       OR v_cita.buffer_total_min IS DISTINCT FROM v_buffer_total
       OR v_cita.fin_at IS DISTINCT FROM v_fin_at THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_TIMING_RECALC_MISMATCH';
    END IF;

    INSERT INTO public.citas_holds (
      id_cita,
      id_usuario,
      estado_hold_codigo,
      expires_at
    )
    VALUES (
      v_id_cita,
      v_hold_user_id,
      'activo',
      v_expires_at
    )
    RETURNING id_hold
    INTO v_id_hold;

    v_bloques := v_bloques || jsonb_build_array(
      jsonb_build_object(
        'id_cita', v_id_cita,
        'id_hold', v_id_hold,
        'orden_integrante', v_orden,
        'alias', v_alias,
        'id_empleado_barbero', v_id_barbero,
        'inicio_at', v_cita.inicio_at,
        'fin_at', v_cita.fin_at,
        'duracion_total_min', v_cita.duracion_total_min,
        'buffer_total_min', v_cita.buffer_total_min,
        'subtotal_hnl', round(v_cita.subtotal_servicios_hnl, 2),
        'descuento_hnl', round(v_cita.descuento_hnl, 2),
        'total_pagar_hnl', round(v_cita.total_pagar_hnl, 2),
        'estado_cita_codigo', v_cita.estado_cita_codigo
      )
    );
  END LOOP;

  PERFORM public.fn_sincronizar_grupo_cita(v_id_grupo_cita);

  SELECT cg.estado_grupo_codigo, cg.total_hnl
  INTO v_estado_grupo, v_total_grupo
  FROM public.citas_grupos cg
  WHERE cg.id_grupo_cita = v_id_grupo_cita;

  v_resultado := jsonb_build_object(
    'request_id', v_request_id,
    'id_grupo_cita', v_id_grupo_cita,
    'codigo_reserva', v_codigo_reserva,
    'estado_grupo_codigo', v_estado_grupo,
    'hold_duracion_min', v_hold_ttl,
    'expires_at', v_expires_at,
    'total_pagar_hnl', round(v_total_grupo, 2),
    'bloques', v_bloques
  );

  UPDATE app_private.reserva_idempotencia
  SET id_grupo_cita = v_id_grupo_cita,
      resultado = v_resultado,
      completed_at = now()
  WHERE request_id = v_request_id;

  RETURN v_resultado;
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_SLOT_TAKEN';
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_UNIQUE_CONFLICT';
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) TO postgres;

-- ============================================================================
-- 8. RPC DE CONFIRMACIÓN DE PAGO DENTRO DEL TTL
-- El backend debe enviar p_pagado_at desde el proveedor cuando exista.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_private.confirmar_reserva_pagada_v1(
  p_id_intent uuid,
  p_referencia_externa text DEFAULT NULL,
  p_pagado_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
DECLARE
  v_intent public.payment_intents%ROWTYPE;
  v_id_grupo_cita uuid;
  v_expires_at timestamptz;
  v_total_grupo numeric;
  v_citas_confirmadas integer;
  v_holds_consumidos integer;
  v_payment_time timestamptz;
  v_idempotent boolean := false;
BEGIN
  SELECT *
  INTO v_intent
  FROM public.payment_intents pi
  WHERE pi.id_intent = p_id_intent
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_NOT_FOUND';
  END IF;

  IF v_intent.origen_pago_codigo <> 'cita' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_NOT_BOOKING';
  END IF;

  v_id_grupo_cita := v_intent.id_grupo_cita;
  IF v_id_grupo_cita IS NULL THEN
    SELECT c.id_grupo_cita
    INTO v_id_grupo_cita
    FROM public.citas c
    WHERE c.id_cita = v_intent.id_cita;
  END IF;

  IF v_id_grupo_cita IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_GROUP_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('masterfade:payment-group:' || v_id_grupo_cita::text, 0)
  );

  SELECT min(h.expires_at), cg.total_hnl
  INTO v_expires_at, v_total_grupo
  FROM public.citas_grupos cg
  JOIN public.citas c
    ON c.id_grupo_cita = cg.id_grupo_cita
   AND c.deleted_at IS NULL
  JOIN public.citas_holds h
    ON h.id_cita = c.id_cita
  WHERE cg.id_grupo_cita = v_id_grupo_cita
  GROUP BY cg.total_hnl;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
  END IF;

  IF v_intent.estado_intent_codigo NOT IN (
    'creado',
    'link_generado',
    'pendiente_confirmacion',
    'expirado',
    'confirmado'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_STATE_INVALID';
  END IF;

  v_idempotent := v_intent.estado_intent_codigo = 'confirmado';
  v_payment_time := CASE
    WHEN v_idempotent THEN COALESCE(v_intent.paid_at, v_intent.updated_at)
    ELSE p_pagado_at
  END;

  IF v_payment_time IS NULL OR v_payment_time > v_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
  END IF;

  IF round(v_intent.monto_hnl, 2) IS DISTINCT FROM round(v_total_grupo, 2) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_AMOUNT_MISMATCH';
  END IF;

  IF NOT v_idempotent THEN
    UPDATE public.payment_intents
    SET estado_intent_codigo = 'confirmado',
        referencia_externa = COALESCE(NULLIF(btrim(p_referencia_externa), ''), referencia_externa),
        paid_at = v_payment_time,
        updated_at = clock_timestamp()
    WHERE id_intent = p_id_intent;
  END IF;

  WITH confirmed AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'confirmada',
        updated_at = now()
    WHERE c.id_grupo_cita = v_id_grupo_cita
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'expirada')
    RETURNING c.id_cita
  )
  SELECT count(*) INTO v_citas_confirmadas FROM confirmed;

  WITH consumed AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'consumido',
        updated_at = now()
    FROM public.citas c
    WHERE c.id_grupo_cita = v_id_grupo_cita
      AND c.id_cita = h.id_cita
      AND h.estado_hold_codigo IN ('activo', 'expirado')
    RETURNING h.id_hold
  )
  SELECT count(*) INTO v_holds_consumidos FROM consumed;

  RETURN jsonb_build_object(
    'id_intent', p_id_intent,
    'id_grupo_cita', v_id_grupo_cita,
    'estado_intent_codigo', 'confirmado',
    'citas_confirmadas', v_citas_confirmadas,
    'holds_consumidos', v_holds_consumidos,
    'idempotent', v_idempotent
  );
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_SLOT_ALREADY_RELEASED';
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.confirmar_reserva_pagada_v1(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.confirmar_reserva_pagada_v1(uuid, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION app_private.confirmar_reserva_pagada_v1(uuid, text, timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.confirmar_reserva_pagada_v1(uuid, text, timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.confirmar_reserva_pagada_v1(uuid, text, timestamptz) TO postgres;

-- ============================================================================
-- 9. CRON CADA MINUTO
-- ============================================================================
DO $mf$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'masterfade-reconcile-payments'
       OR command ILIKE '%fn_reconcile_pending_payments%'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'masterfade-reconcile-payments',
    '* * * * *',
    'call public.fn_reconcile_pending_payments(500);'
  );
END;
$mf$;

-- Ejecuta una reconciliación inicial idempotente.
CALL public.fn_reconcile_pending_payments(500);

-- ============================================================================
-- 10. VALIDACIONES FINALES
-- ============================================================================
DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'crear_reserva_canonica_v1'
  ) THEN
    RAISE EXCEPTION 'MF_F1_CREATE_RPC_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'confirmar_reserva_pagada_v1'
  ) THEN
    RAISE EXCEPTION 'MF_F1_CONFIRM_PAYMENT_RPC_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'validar_horario_reserva_v1'
  ) THEN
    RAISE EXCEPTION 'MF_F1_SLOT_VALIDATOR_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'paid_at'
  ) THEN
    RAISE EXCEPTION 'MF_F1_PAYMENT_PAID_AT_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.payment_intents'::regclass
      AND tgname = 'tr_payment_intents_capture_paid_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'MF_F1_PAYMENT_PAID_AT_TRIGGER_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_citas_holds_activos_expires'
  ) THEN
    RAISE EXCEPTION 'MF_F1_HOLD_EXPIRY_INDEX_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_bloqueos_agenda_empleado_rango_gist'
  ) THEN
    RAISE EXCEPTION 'MF_F1_BLOCK_RANGE_INDEX_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_citas_detalles_linea_canonica'
  ) THEN
    RAISE EXCEPTION 'MF_F1_CANONICAL_DETAIL_INDEX_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'masterfade-reconcile-payments'
      AND schedule = '* * * * *'
      AND active IS TRUE
  ) THEN
    RAISE EXCEPTION 'MF_F1_CRON_NOT_SCHEDULED';
  END IF;
END;
$mf$;

COMMIT;

-- POST-CHECKS DE SOLO LECTURA
SELECT
  app_private.obtener_hold_ttl_min_v1() AS hold_duracion_min,
  app_private.obtener_gracia_confirmacion_pago_min_v1() AS confirmacion_pago_gracia_min;

SELECT jobid, jobname, schedule, command, active
FROM cron.job
WHERE jobname = 'masterfade-reconcile-payments';

SELECT conname, pg_get_constraintdef(oid, true) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.citas'::regclass
  AND conname = 'ex_citas_solape_barbero';

SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE indexname IN (
  'idx_citas_holds_activos_expires',
  'idx_payment_intents_activos_expires',
  'idx_bloqueos_agenda_empleado_rango_gist',
  'idx_horarios_sucursal_publicados_vigencia',
  'idx_horarios_sucursal_bloques_dia',
  'idx_horarios_empleado_dia_activo',
  'uq_citas_holds_usuario_activo',
  'uq_citas_detalles_linea_canonica'
)
ORDER BY indexname;
