BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Historial normalizado (4FN) de cada consulta saliente de estado al proveedor.
-- Se mantiene en app_private porque es telemetría/auditoría interna y no debe
-- quedar expuesta directamente por la Data API del esquema public.
CREATE TABLE IF NOT EXISTS app_private.payment_status_checks (
  id_status_check uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_intent uuid NOT NULL,
  provider_reference text,
  origen_consulta_codigo text NOT NULL DEFAULT 'manual',
  provider_status text,
  resultado_consulta_codigo text NOT NULL,
  http_status smallint,
  error_code text,
  duration_ms integer,
  request_id text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- Permite rerun seguro si existiera una creación parcial previa.
ALTER TABLE app_private.payment_status_checks
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS origen_consulta_codigo text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS resultado_consulta_codigo text,
  ADD COLUMN IF NOT EXISTS http_status smallint,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS checked_at timestamptz NOT NULL DEFAULT now();

-- Si existiera una tabla parcial con filas legacy, no inventamos el resultado
-- técnico de consultas históricas: se detiene y se exige reconciliación explícita.
DO $mf$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app_private.payment_status_checks
    WHERE resultado_consulta_codigo IS NULL
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_STATUS_CHECKS_LEGACY_RESULT_MISSING';
  END IF;
END
$mf$;

ALTER TABLE app_private.payment_status_checks
  ALTER COLUMN resultado_consulta_codigo SET NOT NULL,
  ALTER COLUMN origen_consulta_codigo SET DEFAULT 'manual',
  ALTER COLUMN origen_consulta_codigo SET NOT NULL,
  ALTER COLUMN checked_at SET DEFAULT now(),
  ALTER COLUMN checked_at SET NOT NULL;

DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_private.payment_status_checks'::regclass
      AND conname = 'fk_payment_status_checks_intent'
  ) THEN
    ALTER TABLE app_private.payment_status_checks
      ADD CONSTRAINT fk_payment_status_checks_intent
      FOREIGN KEY (id_intent)
      REFERENCES public.payment_intents(id_intent)
      ON UPDATE CASCADE
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_private.payment_status_checks'::regclass
      AND conname = 'ck_payment_status_checks_origen'
  ) THEN
    ALTER TABLE app_private.payment_status_checks
      ADD CONSTRAINT ck_payment_status_checks_origen
      CHECK (origen_consulta_codigo IN ('manual', 'automatico', 'reconciliacion', 'post_venta'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_private.payment_status_checks'::regclass
      AND conname = 'ck_payment_status_checks_resultado'
  ) THEN
    ALTER TABLE app_private.payment_status_checks
      ADD CONSTRAINT ck_payment_status_checks_resultado
      CHECK (resultado_consulta_codigo IN ('ok', 'timeout', 'error_red', 'error_proveedor', 'respuesta_invalida'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_private.payment_status_checks'::regclass
      AND conname = 'ck_payment_status_checks_http_status'
  ) THEN
    ALTER TABLE app_private.payment_status_checks
      ADD CONSTRAINT ck_payment_status_checks_http_status
      CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_private.payment_status_checks'::regclass
      AND conname = 'ck_payment_status_checks_duration'
  ) THEN
    ALTER TABLE app_private.payment_status_checks
      ADD CONSTRAINT ck_payment_status_checks_duration
      CHECK (duration_ms IS NULL OR duration_ms >= 0)
      NOT VALID;
  END IF;
END
$mf$;

ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT fk_payment_status_checks_intent;
ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT ck_payment_status_checks_origen;
ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT ck_payment_status_checks_resultado;
ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT ck_payment_status_checks_http_status;
ALTER TABLE app_private.payment_status_checks
  VALIDATE CONSTRAINT ck_payment_status_checks_duration;

CREATE INDEX IF NOT EXISTS idx_payment_status_checks_intent_checked_at
  ON app_private.payment_status_checks (id_intent, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_status_checks_result_checked_at
  ON app_private.payment_status_checks (resultado_consulta_codigo, checked_at DESC)
  WHERE resultado_consulta_codigo <> 'ok';

COMMENT ON TABLE app_private.payment_status_checks IS
  'Historial append-only y provider-agnostic de consultas salientes de estado de pagos.';
COMMENT ON COLUMN app_private.payment_status_checks.provider_reference IS
  'Identificador consultado en el proveedor (por ejemplo payment_uuid), sin PAN/CVV.';
COMMENT ON COLUMN app_private.payment_status_checks.origen_consulta_codigo IS
  'Origen de la consulta: manual, automatico, reconciliacion o post_venta.';
COMMENT ON COLUMN app_private.payment_status_checks.resultado_consulta_codigo IS
  'Resultado técnico de la consulta, independiente del estado financiero retornado por el proveedor.';
COMMENT ON COLUMN app_private.payment_status_checks.provider_status IS
  'Estado normalizado devuelto por el proveedor, por ejemplo PAID, PENDING o DECLINED.';

-- Punto único de escritura para conservar historial y actualizar el resumen 1:1.
-- IMPORTANTE: cuando el backend use esta función debe eliminar su incremento manual
-- de verification_attempts/last_verified_at para evitar doble conteo.
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
SET search_path = pg_catalog, app_private, public
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
     OR p_resultado_consulta_codigo NOT IN ('ok', 'timeout', 'error_red', 'error_proveedor', 'respuesta_invalida') THEN
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

REVOKE ALL ON TABLE app_private.payment_status_checks FROM PUBLIC;

REVOKE ALL ON FUNCTION app_private.registrar_payment_status_check_v1(
  uuid, text, text, text, text, smallint, text, integer, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.registrar_payment_status_check_v1(
  uuid, text, text, text, text, smallint, text, integer, text, timestamptz
) TO postgres;

COMMIT;
