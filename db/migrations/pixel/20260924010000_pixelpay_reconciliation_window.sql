BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

UPDATE public.parametros_sistema
SET valor_numero = 5,
    descripcion = 'Ventana maxima para proteger una reserva mientras se confirma un pago incierto',
    updated_at = clock_timestamp()
WHERE clave = 'agendamiento_confirmacion_pago_gracia_min';

DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.parametros_sistema ps
    WHERE ps.clave = 'agendamiento_confirmacion_pago_gracia_min'
      AND ps.valor_numero = 5
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_CONFIRMATION_GRACE_SETTING_MISSING';
  END IF;
END
$mf$;

CREATE OR REPLACE FUNCTION app_private.proteger_reserva_pago_v1(
  p_id_intent uuid,
  p_id_grupo_cita uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $mf$
DECLARE
  v_ahora timestamptz := clock_timestamp();
  v_proteccion_hasta timestamptz;
  v_intent public.payment_intents%ROWTYPE;
  v_citas integer;
  v_holds integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masterfade:payment-group:' || p_id_grupo_cita::text, 0)
  );

  SELECT pi.*
  INTO v_intent
  FROM public.payment_intents pi
  WHERE pi.id_intent = p_id_intent
    AND pi.id_grupo_cita = p_id_grupo_cita
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_NOT_FOUND';
  END IF;

  IF v_intent.origen_pago_codigo <> 'cita'
     OR v_intent.estado_intent_codigo <> 'link_generado' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_STATE_INVALID';
  END IF;

  PERFORM 1
  FROM public.citas c
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
  ORDER BY c.id_cita
  FOR UPDATE OF c;

  SELECT count(*)::integer
  INTO v_citas
  FROM public.citas c
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
    AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago');

  IF v_citas = 0 OR EXISTS (
    SELECT 1
    FROM public.citas c
    WHERE c.id_grupo_cita = p_id_grupo_cita
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo NOT IN ('en_espera', 'pendiente_pago')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_GROUP_STATE_INVALID';
  END IF;

  PERFORM 1
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
  ORDER BY h.id_cita, h.id_hold
  FOR UPDATE OF h;

  SELECT count(*)::integer
  INTO v_holds
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
    AND h.estado_hold_codigo = 'activo'
    AND h.expires_at > v_ahora;

  IF v_holds <> v_citas THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_HOLD_EXPIRED';
  END IF;

  v_proteccion_hasta := v_ahora + pg_catalog.make_interval(
    mins => app_private.obtener_gracia_confirmacion_pago_min_v1()
  );

  UPDATE public.citas_holds h
  SET expires_at = GREATEST(h.expires_at, v_proteccion_hasta),
      updated_at = v_ahora
  FROM public.citas c
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
    AND c.id_cita = h.id_cita
    AND h.estado_hold_codigo = 'activo';

  SELECT min(h.expires_at)
  INTO v_proteccion_hasta
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE c.id_grupo_cita = p_id_grupo_cita
    AND c.deleted_at IS NULL
    AND h.estado_hold_codigo = 'activo';

  UPDATE public.payment_intents pi
  SET estado_intent_codigo = 'pendiente_confirmacion',
      expires_at = v_proteccion_hasta,
      updated_at = v_ahora
  WHERE pi.id_intent = p_id_intent
    AND pi.estado_intent_codigo = 'link_generado';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_PAYMENT_INTENT_STATE_INVALID';
  END IF;

  RETURN v_proteccion_hasta;
END
$mf$;

REVOKE ALL ON FUNCTION app_private.proteger_reserva_pago_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.proteger_reserva_pago_v1(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION app_private.proteger_reserva_pago_v1(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.proteger_reserva_pago_v1(uuid, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.proteger_reserva_pago_v1(uuid, uuid) TO postgres;

-- paid_at solo representa una hora entregada por el proveedor. Cuando no existe,
-- la confirmacion es valida unicamente mientras todos los holds siguen activos.
CREATE OR REPLACE FUNCTION public.fn_payment_intents_capture_paid_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mf$
DECLARE
  v_expires_at timestamptz;
  v_payment_time timestamptz;
  v_all_holds_active boolean;
BEGIN
  IF NEW.origen_pago_codigo <> 'cita' THEN
    RETURN NEW;
  END IF;

  SELECT min(h.expires_at),
         bool_and(h.estado_hold_codigo = 'activo')
  INTO v_expires_at, v_all_holds_active
  FROM public.citas_holds h
  JOIN public.citas c ON c.id_cita = h.id_cita
  WHERE h.id_hold = NEW.id_hold
     OR c.id_cita = NEW.id_cita
     OR (NEW.id_grupo_cita IS NOT NULL AND c.id_grupo_cita = NEW.id_grupo_cita);

  IF NEW.estado_intent_codigo = 'pendiente_confirmacion'
     AND NEW.paid_at IS NOT NULL THEN
    IF v_expires_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
    END IF;
    IF NEW.paid_at > v_expires_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.estado_intent_codigo <> 'confirmado' THEN
    RETURN NEW;
  END IF;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
  END IF;

  SELECT min(p.paid_at)
  INTO v_payment_time
  FROM public.payments p
  WHERE p.id_intent = NEW.id_intent
    AND p.estado_pago_codigo = 'capturado'
    AND p.paid_at IS NOT NULL;

  IF TG_OP = 'UPDATE' THEN
    v_payment_time := COALESCE(NEW.paid_at, v_payment_time, OLD.paid_at);
  ELSE
    v_payment_time := COALESCE(NEW.paid_at, v_payment_time);
  END IF;

  IF v_payment_time IS NULL THEN
    IF v_all_holds_active IS TRUE AND v_expires_at > clock_timestamp() THEN
      NEW.paid_at := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_PAID_AT_REQUIRED';
  END IF;

  IF v_payment_time > v_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
  END IF;

  NEW.paid_at := v_payment_time;
  RETURN NEW;
END
$mf$;

CREATE OR REPLACE FUNCTION app_private.confirmar_reserva_pagada_v1(
  p_id_intent uuid,
  p_referencia_externa text DEFAULT NULL,
  p_pagado_at timestamptz DEFAULT NULL
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
  v_all_holds_active boolean;
  v_citas_confirmadas integer;
  v_holds_consumidos integer;
  v_payment_time timestamptz;
  v_idempotent boolean := false;
BEGIN
  SELECT * INTO v_intent
  FROM public.payment_intents pi
  WHERE pi.id_intent = p_id_intent
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_INTENT_NOT_FOUND';
  END IF;
  IF v_intent.origen_pago_codigo <> 'cita' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_INTENT_NOT_BOOKING';
  END IF;

  v_id_grupo_cita := v_intent.id_grupo_cita;
  IF v_id_grupo_cita IS NULL THEN
    SELECT c.id_grupo_cita INTO v_id_grupo_cita
    FROM public.citas c
    WHERE c.id_cita = v_intent.id_cita;
  END IF;
  IF v_id_grupo_cita IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_GROUP_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('masterfade:payment-group:' || v_id_grupo_cita::text, 0)
  );

  SELECT min(h.expires_at), cg.total_hnl,
         bool_and(h.estado_hold_codigo = 'activo')
  INTO v_expires_at, v_total_grupo, v_all_holds_active
  FROM public.citas_grupos cg
  JOIN public.citas c
    ON c.id_grupo_cita = cg.id_grupo_cita
   AND c.deleted_at IS NULL
  JOIN public.citas_holds h ON h.id_cita = c.id_cita
  WHERE cg.id_grupo_cita = v_id_grupo_cita
  GROUP BY cg.total_hnl;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_HOLD_NOT_FOUND';
  END IF;
  IF v_intent.estado_intent_codigo NOT IN (
    'creado', 'link_generado', 'pendiente_confirmacion', 'expirado', 'confirmado'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_INTENT_STATE_INVALID';
  END IF;

  v_idempotent := v_intent.estado_intent_codigo = 'confirmado';
  v_payment_time := CASE WHEN v_idempotent THEN v_intent.paid_at ELSE p_pagado_at END;

  IF NOT v_idempotent THEN
    IF v_payment_time IS NULL THEN
      IF v_all_holds_active IS NOT TRUE OR v_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_PAID_AT_REQUIRED';
      END IF;
    ELSIF v_payment_time > v_expires_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
    END IF;
  END IF;

  IF round(v_intent.monto_hnl, 2) IS DISTINCT FROM round(v_total_grupo, 2) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_AMOUNT_MISMATCH';
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
    SET estado_cita_codigo = 'confirmada', updated_at = now()
    WHERE c.id_grupo_cita = v_id_grupo_cita
      AND c.deleted_at IS NULL
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'expirada')
    RETURNING c.id_cita
  )
  SELECT count(*) INTO v_citas_confirmadas FROM confirmed;

  WITH consumed AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'consumido', updated_at = now()
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
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_PAYMENT_SLOT_ALREADY_RELEASED';
END
$mf$;

COMMIT;
