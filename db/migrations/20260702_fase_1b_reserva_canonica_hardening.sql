BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtextextended('masterfade:20260702:fase_1b_reserva_canonica_hardening', 0)
);

DO $mf$
BEGIN
  IF to_regprocedure('app_private.crear_reserva_canonica_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B_CREATE_RPC_MISSING';
  END IF;

  IF to_regprocedure('app_private.crear_reserva_canonica_v1_core_20260702(jsonb)') IS NULL THEN
    ALTER FUNCTION app_private.crear_reserva_canonica_v1(jsonb)
      RENAME TO crear_reserva_canonica_v1_core_20260702;
  END IF;
END;
$mf$;

CREATE OR REPLACE FUNCTION app_private.mf1b_payload_with_barber_candidate(
  p_payload jsonb,
  p_rank integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mf$
DECLARE
  v_integrantes jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN NULLIF(btrim(item->>'id_empleado_barbero'), '') IS NULL
           AND jsonb_typeof(item->'barber_candidate_ids') = 'array'
           AND jsonb_array_length(item->'barber_candidate_ids') > 0
      THEN jsonb_set(
        item,
        '{id_empleado_barbero}',
        to_jsonb((
          SELECT candidate_id
          FROM (
            SELECT
              value AS candidate_id,
              ordinality AS candidate_order
            FROM jsonb_array_elements_text(item->'barber_candidate_ids') WITH ORDINALITY
          ) candidates
          ORDER BY
            CASE
              WHEN candidate_order >= GREATEST(1, p_rank) THEN candidate_order
              ELSE 100000 + candidate_order
            END ASC
          LIMIT 1
        )),
        true
      )
      ELSE item
    END
    ORDER BY ordinality
  ), '[]'::jsonb)
  INTO v_integrantes
  FROM jsonb_array_elements(COALESCE(p_payload->'integrantes', '[]'::jsonb)) WITH ORDINALITY AS entry(item, ordinality);

  RETURN jsonb_set(p_payload, '{integrantes}', v_integrantes, true);
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.mf1b_payload_with_barber_candidate(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.mf1b_payload_with_barber_candidate(jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION app_private.mf1b_payload_with_barber_candidate(jsonb, integer) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.mf1b_payload_with_barber_candidate(jsonb, integer) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.mf1b_payload_with_barber_candidate(jsonb, integer) TO postgres;

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
  v_id_cliente_titular uuid;
  v_existing app_private.reserva_idempotencia%ROWTYPE;
  v_max_candidates integer := 0;
  v_attempt integer;
  v_attempt_payload jsonb;
  v_message text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN app_private.crear_reserva_canonica_v1_core_20260702(p_payload);
  END IF;

  BEGIN
    v_request_id := NULLIF(btrim(p_payload->>'request_id'), '')::uuid;
    v_id_cliente_titular := NULLIF(btrim(p_payload->>'id_cliente_titular'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN app_private.crear_reserva_canonica_v1_core_20260702(p_payload);
  END;

  SELECT COALESCE(max(
    CASE
      WHEN jsonb_typeof(value->'barber_candidate_ids') = 'array'
           AND NULLIF(btrim(value->>'id_empleado_barbero'), '') IS NULL
      THEN jsonb_array_length(value->'barber_candidate_ids')
      ELSE 0
    END
  ), 0)
  INTO v_max_candidates
  FROM jsonb_array_elements(COALESCE(p_payload->'integrantes', '[]'::jsonb));

  IF v_request_id IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM app_private.reserva_idempotencia
    WHERE request_id = v_request_id
    FOR UPDATE;

    IF FOUND AND v_existing.resultado IS NOT NULL THEN
      FOR v_attempt IN 1..GREATEST(v_max_candidates, 1) LOOP
        v_attempt_payload := app_private.mf1b_payload_with_barber_candidate(p_payload, v_attempt);
        IF v_existing.payload_hash = md5(v_attempt_payload::text) THEN
          RETURN v_existing.resultado;
        END IF;
      END LOOP;

      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
  END IF;

  IF v_id_cliente_titular IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('masterfade:booking-client:' || v_id_cliente_titular::text, 0)
    );

    PERFORM app_private.expirar_reservas_vencidas_v1(500, clock_timestamp(), NULL, NULL, NULL, NULL, NULL);

    IF EXISTS (
      SELECT 1
      FROM public.citas_grupos cg
      JOIN public.citas c
        ON c.id_grupo_cita = cg.id_grupo_cita
       AND c.deleted_at IS NULL
      JOIN public.citas_holds h
        ON h.id_cita = c.id_cita
      WHERE cg.id_cliente_titular = v_id_cliente_titular
        AND cg.estado_grupo_codigo = 'activo'
        AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
        AND h.estado_hold_codigo = 'activo'
        AND h.expires_at > clock_timestamp()
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_PENDIENTE_EXISTENTE';
    END IF;
  END IF;

  FOR v_attempt IN 1..GREATEST(v_max_candidates, 1) LOOP
    v_attempt_payload := app_private.mf1b_payload_with_barber_candidate(p_payload, v_attempt);
    BEGIN
      RETURN app_private.crear_reserva_canonica_v1_core_20260702(v_attempt_payload);
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        IF v_message = 'MF_SLOT_TAKEN' AND v_attempt < GREATEST(v_max_candidates, 1) THEN
          CONTINUE;
        END IF;
        RAISE;
    END;
  END LOOP;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'MF_SLOT_TAKEN';
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) TO postgres;

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
  v_usos_revertidos integer := 0;
BEGIN
  IF (p_inicio_at IS NULL) <> (p_fin_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MF_F1_EXPIRY_RANGE_INCOMPLETE';
  END IF;

  IF p_inicio_at IS NOT NULL AND p_fin_at <= p_inicio_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MF_F1_EXPIRY_RANGE_INVALID';
  END IF;

  WITH pagadas AS (
    SELECT h.id_hold, h.id_cita, c.id_grupo_cita
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    LEFT JOIN public.citas_grupos cg ON cg.id_grupo_cita = c.id_grupo_cita
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
        OR tstzrange(c.inicio_at, c.fin_at, '[)') && tstzrange(p_inicio_at, p_fin_at, '[)')
      )
      AND (
        c.estado_cita_codigo = 'confirmada'
        OR EXISTS (
          SELECT 1
          FROM public.payment_intents pi
          WHERE pi.origen_pago_codigo = 'cita'
            AND pi.estado_intent_codigo = 'confirmado'
            AND pi.paid_at IS NOT NULL
            AND pi.paid_at <= h.expires_at
            AND (pi.id_hold = h.id_hold OR pi.id_cita = c.id_cita OR pi.id_grupo_cita = c.id_grupo_cita)
        )
      )
    ORDER BY h.id_hold
    FOR UPDATE OF h SKIP LOCKED
    LIMIT v_limite
  ),
  confirmed_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'confirmada', updated_at = now()
    FROM pagadas p
    WHERE c.id_cita = p.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita
  ),
  consumed_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'consumido', updated_at = now()
    FROM pagadas p
    WHERE h.id_hold = p.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  )
  SELECT (SELECT count(*) FROM confirmed_citas), (SELECT count(*) FROM consumed_holds)
  INTO v_citas_confirmadas, v_holds_consumidos;

  WITH candidatos AS (
    SELECT h.id_hold, h.id_cita, c.id_grupo_cita, h.expires_at
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    LEFT JOIN public.citas_grupos cg ON cg.id_grupo_cita = c.id_grupo_cita
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
        OR tstzrange(c.inicio_at, c.fin_at, '[)') && tstzrange(p_inicio_at, p_fin_at, '[)')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payment_intents pi
        WHERE pi.origen_pago_codigo = 'cita'
          AND (pi.id_hold = h.id_hold OR pi.id_cita = c.id_cita OR pi.id_grupo_cita = c.id_grupo_cita)
          AND (
            (
              pi.estado_intent_codigo = 'confirmado'
              AND pi.paid_at IS NOT NULL
              AND pi.paid_at <= h.expires_at
            )
            OR (
              pi.estado_intent_codigo = 'pendiente_confirmacion'
              AND pi.paid_at IS NOT NULL
              AND pi.paid_at <= h.expires_at
              AND pi.paid_at + make_interval(mins => v_gracia) > p_ahora
            )
          )
      )
    ORDER BY h.expires_at, h.id_hold
    FOR UPDATE OF h SKIP LOCKED
    LIMIT v_limite
  ),
  expired_intents AS (
    UPDATE public.payment_intents pi
    SET estado_intent_codigo = 'expirado', updated_at = now()
    FROM candidatos x
    WHERE pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
      AND (pi.id_hold = x.id_hold OR pi.id_cita = x.id_cita OR pi.id_grupo_cita = x.id_grupo_cita)
    RETURNING pi.id_intent
  ),
  expired_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'expirado', updated_at = now()
    FROM candidatos x
    WHERE h.id_hold = x.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  ),
  expired_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'expirada', updated_at = now()
    FROM candidatos x
    WHERE c.id_cita = x.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita, c.id_grupo_cita
  ),
  reverted_usages AS (
    UPDATE public.promociones_usos pu
    SET estado_uso_codigo = 'revertido', updated_at = now()
    FROM public.citas_promociones cp
    JOIN expired_citas ec
      ON (
        cp.id_cita = ec.id_cita
        OR (cp.id_cita IS NULL AND cp.id_grupo_cita = ec.id_grupo_cita)
      )
    WHERE pu.id_cita_promocion = cp.id_cita_promocion
      AND pu.estado_uso_codigo = 'reservado'
    RETURNING pu.id_promocion_uso
  )
  SELECT
    (SELECT count(*) FROM expired_intents),
    (SELECT count(*) FROM expired_holds),
    (SELECT count(*) FROM expired_citas),
    (SELECT count(*) FROM reverted_usages)
  INTO v_intents_expirados, v_holds_expirados, v_citas_expiradas, v_usos_revertidos;

  RETURN jsonb_build_object(
    'holds_consumidos', v_holds_consumidos,
    'citas_confirmadas', v_citas_confirmadas,
    'holds_expirados', v_holds_expirados,
    'citas_expiradas', v_citas_expiradas,
    'intents_expirados', v_intents_expirados,
    'usos_promocion_revertidos', v_usos_revertidos,
    'procesado_at', p_ahora
  );
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM anon;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION app_private.expirar_reservas_vencidas_v1(integer, timestamptz, uuid, uuid, timestamptz, timestamptz, uuid) TO postgres;

DO $mf$
BEGIN
  IF to_regprocedure('app_private.crear_reserva_canonica_v1_core_20260702(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B_CREATE_CORE_MISSING';
  END IF;

  IF to_regprocedure('app_private.mf1b_payload_with_barber_candidate(jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B_CANDIDATE_HELPER_MISSING';
  END IF;
END;
$mf$;

COMMIT;
