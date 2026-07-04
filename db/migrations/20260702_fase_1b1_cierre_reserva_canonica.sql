BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtextextended('masterfade:20260702:fase_1b1_cierre_reserva_canonica', 0)
);

DO $mf$
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'MF_F1B1_POSTGRES_17_REQUIRED';
  END IF;

  IF to_regclass('public.citas') IS NULL
     OR to_regclass('public.citas_holds') IS NULL
     OR to_regclass('public.citas_grupos') IS NULL
     OR to_regclass('public.citas_detalles') IS NULL
     OR to_regclass('public.citas_promociones') IS NULL
     OR to_regclass('public.promociones_usos') IS NULL
     OR to_regclass('app_private.reserva_idempotencia') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B1_REQUIRED_OBJECT_MISSING';
  END IF;

  IF to_regprocedure('app_private.crear_reserva_canonica_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B1_CREATE_RPC_MISSING';
  END IF;
END;
$mf$;

ALTER TABLE app_private.reserva_idempotencia
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS response_payload jsonb,
  ADD COLUMN IF NOT EXISTS response_completed_at timestamptz;

UPDATE app_private.reserva_idempotencia
SET scope = COALESCE(scope, 'legacy'),
    request_fingerprint = COALESCE(request_fingerprint, payload_hash),
    response_payload = COALESCE(
      response_payload,
      CASE
        WHEN resultado IS NULL THEN NULL
        ELSE jsonb_build_object('status_code', 201, 'data', resultado)
      END
    ),
    response_completed_at = COALESCE(response_completed_at, completed_at)
WHERE scope IS NULL
   OR request_fingerprint IS NULL
   OR (response_payload IS NULL AND resultado IS NOT NULL)
   OR (response_completed_at IS NULL AND completed_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_reserva_idempotencia_scope_fingerprint
  ON app_private.reserva_idempotencia (scope, request_fingerprint);

ALTER TABLE public.citas_detalles
  ADD COLUMN IF NOT EXISTS line_key text,
  ADD COLUMN IF NOT EXISTS orden_linea integer;

WITH ordered AS (
  SELECT
    cd.id_cita_detalle,
    row_number() OVER (
      PARTITION BY cd.id_cita
      ORDER BY cd.created_at ASC, cd.id_cita_detalle ASC
    )::integer AS rn
  FROM public.citas_detalles cd
)
UPDATE public.citas_detalles cd
SET orden_linea = COALESCE(cd.orden_linea, ordered.rn),
    line_key = COALESCE(
      NULLIF(btrim(cd.line_key), ''),
      'legacy|' || cd.id_cita::text || '|' || ordered.rn::text || '|' || cd.id_cita_detalle::text
    )
FROM ordered
WHERE ordered.id_cita_detalle = cd.id_cita_detalle
  AND (cd.orden_linea IS NULL OR NULLIF(btrim(cd.line_key), '') IS NULL);

ALTER TABLE public.citas_detalles
  ALTER COLUMN line_key SET NOT NULL,
  ALTER COLUMN orden_linea SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_citas_detalles_cita_line_key
  ON public.citas_detalles (id_cita, line_key);

CREATE INDEX IF NOT EXISTS idx_citas_detalles_cita_orden_linea
  ON public.citas_detalles (id_cita, orden_linea);

CREATE OR REPLACE FUNCTION public.fn_citas_detalles_line_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mf$
DECLARE
  v_next_order integer;
  v_tarifa text;
  v_paquete text;
BEGIN
  IF NEW.orden_linea IS NULL OR NEW.orden_linea < 1 THEN
    SELECT COALESCE(max(cd.orden_linea), 0) + 1
    INTO v_next_order
    FROM public.citas_detalles cd
    WHERE cd.id_cita = NEW.id_cita
      AND (TG_OP = 'INSERT' OR cd.id_cita_detalle <> NEW.id_cita_detalle);

    NEW.orden_linea := COALESCE(v_next_order, 1);
  END IF;

  IF NULLIF(btrim(NEW.line_key), '') IS NULL THEN
    v_tarifa := COALESCE(NEW.id_tarifa::text, 'sin_tarifa');
    v_paquete := COALESCE(NEW.id_cita_paquete::text, 'sin_paquete');
    NEW.line_key := concat_ws(
      '|',
      GREATEST(1, NEW.orden_linea)::text,
      NEW.id_servicio::text,
      v_tarifa,
      COALESCE(NULLIF(btrim(NEW.origen_item_codigo), ''), 'servicio_manual'),
      v_paquete
    );
  END IF;

  RETURN NEW;
END;
$mf$;

DROP TRIGGER IF EXISTS tr_aa_citas_detalles_line_identity
  ON public.citas_detalles;

CREATE TRIGGER tr_aa_citas_detalles_line_identity
BEFORE INSERT OR UPDATE ON public.citas_detalles
FOR EACH ROW
EXECUTE FUNCTION public.fn_citas_detalles_line_identity_v1();

ALTER TABLE public.citas_promociones
  ADD COLUMN IF NOT EXISTS line_key text,
  ADD COLUMN IF NOT EXISTS id_promocion_sucursal uuid,
  ADD COLUMN IF NOT EXISTS id_promocion_codigo uuid,
  ADD COLUMN IF NOT EXISTS codigo_promocional_snapshot text;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_line_key
  ON public.citas_promociones (id_grupo_cita, line_key)
  WHERE line_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_promocion_sucursal
  ON public.citas_promociones (id_promocion_sucursal)
  WHERE id_promocion_sucursal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_promocion_codigo
  ON public.citas_promociones (id_promocion_codigo)
  WHERE id_promocion_codigo IS NOT NULL;

DO $mf$
BEGIN
  IF to_regclass('public.promociones_sucursal') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.citas_promociones'::regclass
         AND conname = 'fk_citas_promociones_promocion_sucursal'
     ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT fk_citas_promociones_promocion_sucursal
      FOREIGN KEY (id_promocion_sucursal)
      REFERENCES public.promociones_sucursal(id_promocion_sucursal)
      ON UPDATE CASCADE
      ON DELETE SET NULL
      NOT VALID;
    ALTER TABLE public.citas_promociones
      VALIDATE CONSTRAINT fk_citas_promociones_promocion_sucursal;
  END IF;

  IF to_regclass('public.promociones_codigos') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.citas_promociones'::regclass
         AND conname = 'fk_citas_promociones_promocion_codigo'
     ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT fk_citas_promociones_promocion_codigo
      FOREIGN KEY (id_promocion_codigo)
      REFERENCES public.promociones_codigos(id_promocion_codigo)
      ON UPDATE CASCADE
      ON DELETE SET NULL
      NOT VALID;
    ALTER TABLE public.citas_promociones
      VALIDATE CONSTRAINT fk_citas_promociones_promocion_codigo;
  END IF;
END;
$mf$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_usos_grupo_regla_codigo_activo
  ON public.promociones_usos (
    id_grupo_cita,
    id_promocion_regla,
    COALESCE(id_promocion_codigo, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE estado_uso_codigo IN ('reservado', 'consumido');

CREATE OR REPLACE FUNCTION app_private.obtener_reserva_idempotente_v1(
  p_request_id uuid,
  p_scope text,
  p_request_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $mf$
DECLARE
  v_row app_private.reserva_idempotencia%ROWTYPE;
  v_scope text := NULLIF(btrim(p_scope), '');
  v_fingerprint text := NULLIF(btrim(p_request_fingerprint), '');
BEGIN
  IF p_request_id IS NULL OR v_scope IS NULL OR v_fingerprint IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'BOOKING_IDEMPOTENCY_KEY_INVALID';
  END IF;

  SELECT *
  INTO v_row
  FROM app_private.reserva_idempotencia
  WHERE request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF COALESCE(NULLIF(btrim(v_row.scope), ''), v_scope) IS DISTINCT FROM v_scope
     OR COALESCE(NULLIF(btrim(v_row.request_fingerprint), ''), v_fingerprint) IS DISTINCT FROM v_fingerprint THEN
    RETURN jsonb_build_object('status', 'payload_mismatch');
  END IF;

  IF v_row.response_payload IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'completed',
      'response_payload', v_row.response_payload
    );
  END IF;

  RETURN jsonb_build_object('status', 'incomplete');
END;
$mf$;

CREATE OR REPLACE FUNCTION app_private.finalizar_reserva_idempotente_v1(
  p_request_id uuid,
  p_scope text,
  p_request_fingerprint text,
  p_response_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $mf$
DECLARE
  v_scope text := NULLIF(btrim(p_scope), '');
  v_fingerprint text := NULLIF(btrim(p_request_fingerprint), '');
  v_existing app_private.reserva_idempotencia%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR v_scope IS NULL OR v_fingerprint IS NULL OR p_response_payload IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'BOOKING_IDEMPOTENCY_KEY_INVALID';
  END IF;

  SELECT *
  INTO v_existing
  FROM app_private.reserva_idempotencia
  WHERE request_id = p_request_id
  FOR UPDATE;

  IF FOUND
     AND NULLIF(btrim(v_existing.request_fingerprint), '') IS NOT NULL
     AND v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MF_RESERVA_IDEMPOTENCY_PAYLOAD_MISMATCH';
  END IF;

  INSERT INTO app_private.reserva_idempotencia (
    request_id,
    payload_hash,
    scope,
    request_fingerprint,
    response_payload,
    response_completed_at,
    completed_at
  )
  VALUES (
    p_request_id,
    md5(v_fingerprint),
    v_scope,
    v_fingerprint,
    p_response_payload,
    now(),
    now()
  )
  ON CONFLICT (request_id) DO UPDATE
  SET scope = EXCLUDED.scope,
      request_fingerprint = EXCLUDED.request_fingerprint,
      response_payload = EXCLUDED.response_payload,
      response_completed_at = EXCLUDED.response_completed_at,
      completed_at = COALESCE(app_private.reserva_idempotencia.completed_at, EXCLUDED.completed_at);

  RETURN jsonb_build_object('status', 'completed');
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.obtener_reserva_idempotente_v1(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finalizar_reserva_idempotente_v1(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.obtener_reserva_idempotente_v1(uuid, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION app_private.finalizar_reserva_idempotente_v1(uuid, text, text, jsonb) TO postgres;

DO $mf$
BEGIN
  IF to_regprocedure('app_private.crear_reserva_canonica_v1_core_20260702(jsonb)') IS NULL THEN
    ALTER FUNCTION app_private.crear_reserva_canonica_v1(jsonb)
      RENAME TO crear_reserva_canonica_v1_core_20260702;
  END IF;
END;
$mf$;

CREATE OR REPLACE FUNCTION app_private.mf1b1_expirar_reservas_cliente_v1(
  p_id_cliente_titular uuid,
  p_ahora timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
DECLARE
  v_holds integer := 0;
  v_citas integer := 0;
  v_intents integer := 0;
  v_usos integer := 0;
BEGIN
  IF p_id_cliente_titular IS NULL THEN
    RETURN jsonb_build_object('holds_expirados', 0, 'citas_expiradas', 0, 'intents_expirados', 0, 'usos_revertidos', 0);
  END IF;

  WITH candidatos AS (
    SELECT h.id_hold, c.id_cita, c.id_grupo_cita
    FROM public.citas_grupos cg
    JOIN public.citas c
      ON c.id_grupo_cita = cg.id_grupo_cita
     AND c.deleted_at IS NULL
    JOIN public.citas_holds h
      ON h.id_cita = c.id_cita
    WHERE cg.id_cliente_titular = p_id_cliente_titular
      AND cg.estado_grupo_codigo = 'activo'
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
      AND h.estado_hold_codigo = 'activo'
      AND h.expires_at <= p_ahora
    ORDER BY h.expires_at ASC, h.id_hold ASC
    FOR UPDATE OF h SKIP LOCKED
    LIMIT 50
  ),
  expired_intents AS (
    UPDATE public.payment_intents pi
    SET estado_intent_codigo = 'expirado',
        updated_at = now()
    FROM candidatos x
    WHERE pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
      AND (pi.id_hold = x.id_hold OR pi.id_cita = x.id_cita OR pi.id_grupo_cita = x.id_grupo_cita)
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
    RETURNING c.id_cita, c.id_grupo_cita
  ),
  reverted_usages AS (
    UPDATE public.promociones_usos pu
    SET estado_uso_codigo = 'revertido',
        updated_at = now()
    FROM public.citas_promociones cp
    JOIN expired_citas ec
      ON cp.id_grupo_cita = ec.id_grupo_cita
    WHERE pu.id_cita_promocion = cp.id_cita_promocion
      AND pu.estado_uso_codigo = 'reservado'
    RETURNING pu.id_promocion_uso
  )
  SELECT
    (SELECT count(*) FROM expired_holds),
    (SELECT count(*) FROM expired_citas),
    (SELECT count(*) FROM expired_intents),
    (SELECT count(*) FROM reverted_usages)
  INTO v_holds, v_citas, v_intents, v_usos;

  RETURN jsonb_build_object(
    'holds_expirados', v_holds,
    'citas_expiradas', v_citas,
    'intents_expirados', v_intents,
    'usos_revertidos', v_usos
  );
END;
$mf$;

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
  v_base_payload jsonb;
  v_attempts jsonb;
  v_attempt jsonb;
  v_attempt_payload jsonb;
  v_payload_matches boolean := false;
  v_attempt_index integer := 0;
  v_attempt_count integer := 0;
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

  v_base_payload := p_payload - 'assignment_attempts';
  v_attempts := p_payload->'assignment_attempts';

  IF v_request_id IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM app_private.reserva_idempotencia
    WHERE request_id = v_request_id
    FOR UPDATE;

    IF FOUND AND v_existing.resultado IS NOT NULL THEN
      IF v_attempts IS NULL
         OR jsonb_typeof(v_attempts) <> 'array'
         OR jsonb_array_length(v_attempts) = 0 THEN
        v_payload_matches := v_existing.payload_hash = md5(v_base_payload::text);
      ELSE
        FOR v_attempt IN
          SELECT value
          FROM jsonb_array_elements(v_attempts)
        LOOP
          IF jsonb_typeof(v_attempt->'integrantes') = 'array'
             AND jsonb_array_length(v_attempt->'integrantes') > 0 THEN
            v_attempt_payload := jsonb_set(
              v_base_payload,
              '{integrantes}',
              v_attempt->'integrantes',
              true
            );
            IF v_existing.payload_hash = md5(v_attempt_payload::text) THEN
              v_payload_matches := true;
              EXIT;
            END IF;
          END IF;
        END LOOP;
      END IF;

      IF v_payload_matches THEN
        RETURN v_existing.resultado;
      END IF;

      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MF_RESERVA_IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
  END IF;

  IF v_id_cliente_titular IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('masterfade:booking-client:' || v_id_cliente_titular::text, 0)
    );

    PERFORM app_private.mf1b1_expirar_reservas_cliente_v1(v_id_cliente_titular, clock_timestamp());

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

  IF v_attempts IS NULL
     OR jsonb_typeof(v_attempts) <> 'array'
     OR jsonb_array_length(v_attempts) = 0 THEN
    RETURN app_private.crear_reserva_canonica_v1_core_20260702(v_base_payload);
  END IF;

  v_attempt_count := jsonb_array_length(v_attempts);
  IF v_attempt_count > 64 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BOOKING_ASSIGNMENT_COMBINATIONS_LIMIT';
  END IF;

  FOR v_attempt IN
    SELECT value
    FROM jsonb_array_elements(v_attempts)
  LOOP
    v_attempt_index := v_attempt_index + 1;
    IF jsonb_typeof(v_attempt->'integrantes') <> 'array'
       OR jsonb_array_length(v_attempt->'integrantes') = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_ASSIGNMENT_ATTEMPT_INVALID';
    END IF;

    v_attempt_payload := jsonb_set(
      v_base_payload,
      '{integrantes}',
      v_attempt->'integrantes',
      true
    );

    BEGIN
      RETURN app_private.crear_reserva_canonica_v1_core_20260702(v_attempt_payload);
    EXCEPTION
      WHEN exclusion_violation THEN
        IF v_attempt_index < v_attempt_count THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MF_SLOT_TAKEN';
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        IF v_message = 'MF_SLOT_TAKEN' AND v_attempt_index < v_attempt_count THEN
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

REVOKE ALL ON FUNCTION app_private.mf1b1_expirar_reservas_cliente_v1(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.mf1b1_expirar_reservas_cliente_v1(uuid, timestamptz) TO postgres;
GRANT EXECUTE ON FUNCTION app_private.crear_reserva_canonica_v1(jsonb) TO postgres;

DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'line_key'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'MF_F1B1_LINE_KEY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_citas_detalles_cita_line_key'
  ) THEN
    RAISE EXCEPTION 'MF_F1B1_LINE_KEY_INDEX_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_promociones cp
    LEFT JOIN public.promociones_sucursal ps
      ON ps.id_promocion_sucursal = cp.id_promocion_sucursal
    WHERE cp.id_promocion_sucursal IS NOT NULL
      AND ps.id_promocion_sucursal IS NULL
  ) THEN
    RAISE EXCEPTION 'MF_F1B1_PROMOCION_SUCURSAL_INVALID_REF';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_promociones cp
    LEFT JOIN public.promociones_codigos pc
      ON pc.id_promocion_codigo = cp.id_promocion_codigo
    WHERE cp.id_promocion_codigo IS NOT NULL
      AND pc.id_promocion_codigo IS NULL
  ) THEN
    RAISE EXCEPTION 'MF_F1B1_PROMOCION_CODIGO_INVALID_REF';
  END IF;

  IF to_regprocedure('app_private.obtener_reserva_idempotente_v1(uuid,text,text)') IS NULL
     OR to_regprocedure('app_private.finalizar_reserva_idempotente_v1(uuid,text,text,jsonb)') IS NULL
     OR to_regprocedure('app_private.crear_reserva_canonica_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MF_F1B1_REQUIRED_FUNCTION_MISSING';
  END IF;
END;
$mf$;

COMMIT;
