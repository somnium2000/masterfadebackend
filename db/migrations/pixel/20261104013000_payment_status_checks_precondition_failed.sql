BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.payment_status_checks
  DROP CONSTRAINT IF EXISTS ck_payment_status_checks_resultado;

ALTER TABLE app_private.payment_status_checks
  ADD CONSTRAINT ck_payment_status_checks_resultado
  CHECK (
    resultado_consulta_codigo IN (
      'ok',
      'timeout',
      'error_red',
      'error_proveedor',
      'respuesta_invalida',
      'precondicion_fallida'
    )
  )
  NOT VALID;

ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT ck_payment_status_checks_resultado;

CREATE OR REPLACE FUNCTION app_private.registrar_payment_status_check_v1(
  p_id_intent uuid,
  p_provider_reference text,
  p_origen_consulta_codigo text,
  p_provider_status text,
  p_resultado_consulta_codigo text,
  p_http_status smallint,
  p_error_code text,
  p_duration_ms integer,
  p_request_id text,
  p_checked_at timestamptz DEFAULT clock_timestamp()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $mf$
DECLARE
  v_id_status_check uuid;
  v_checked_at timestamptz := COALESCE(p_checked_at, clock_timestamp());
BEGIN
  IF p_id_intent IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PAYMENT_STATUS_CHECK_INTENT_REQUIRED';
  END IF;

  IF p_origen_consulta_codigo IS NULL
     OR p_origen_consulta_codigo NOT IN ('manual', 'automatico', 'reconciliacion', 'post_venta') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PAYMENT_STATUS_CHECK_ORIGIN_INVALID';
  END IF;

  IF p_resultado_consulta_codigo IS NULL
     OR p_resultado_consulta_codigo NOT IN (
       'ok',
       'timeout',
       'error_red',
       'error_proveedor',
       'respuesta_invalida',
       'precondicion_fallida'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PAYMENT_STATUS_CHECK_RESULT_INVALID';
  END IF;

  IF p_http_status IS NOT NULL AND (p_http_status < 100 OR p_http_status > 599) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PAYMENT_STATUS_CHECK_HTTP_STATUS_INVALID';
  END IF;

  IF p_duration_ms IS NOT NULL AND p_duration_ms < 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'PAYMENT_STATUS_CHECK_DURATION_INVALID';
  END IF;

  INSERT INTO app_private.payment_status_checks (
    id_intent,
    provider_reference,
    origen_consulta_codigo,
    provider_status,
    resultado_consulta_codigo,
    http_status,
    error_code,
    duration_ms,
    request_id,
    checked_at
  ) VALUES (
    p_id_intent,
    NULLIF(btrim(p_provider_reference), ''),
    p_origen_consulta_codigo,
    NULLIF(btrim(p_provider_status), ''),
    p_resultado_consulta_codigo,
    p_http_status,
    NULLIF(btrim(p_error_code), ''),
    p_duration_ms,
    NULLIF(btrim(p_request_id), ''),
    v_checked_at
  )
  RETURNING id_status_check INTO v_id_status_check;

  UPDATE public.payment_intents
  SET last_verified_at = CASE
        WHEN last_verified_at IS NULL OR last_verified_at < v_checked_at THEN v_checked_at
        ELSE last_verified_at
      END,
      verification_attempts = COALESCE(verification_attempts, 0) + 1,
      updated_at = now()
  WHERE id_intent = p_id_intent;

  RETURN v_id_status_check;
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.registrar_payment_status_check_v1(
  uuid, text, text, text, text, smallint, text, integer, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.registrar_payment_status_check_v1(
  uuid, text, text, text, text, smallint, text, integer, text, timestamptz
) TO postgres;

COMMIT;
