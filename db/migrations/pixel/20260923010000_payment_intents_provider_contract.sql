BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Contrato provider-agnostic del intent de pago.
-- Estos campos son atributos escalares 1:1 del intent y permanecen en payment_intents.
ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS orden_compra text,
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS launch_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;

-- Normaliza despliegues parciales/legacy antes de imponer el contrato.
UPDATE public.payment_intents
SET verification_attempts = 0
WHERE verification_attempts IS NULL;

ALTER TABLE public.payment_intents
  ALTER COLUMN verification_attempts SET DEFAULT 0,
  ALTER COLUMN verification_attempts SET NOT NULL;

DO $mf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.payment_intents'::regclass
      AND conname = 'ck_payment_intents_verification_attempts_nonnegative'
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT ck_payment_intents_verification_attempts_nonnegative
      CHECK (verification_attempts >= 0)
      NOT VALID;
  END IF;
END
$mf$;

ALTER TABLE public.payment_intents
  VALIDATE CONSTRAINT ck_payment_intents_verification_attempts_nonnegative;

-- No se hacen UNIQUE todavía: primero debe auditarse el legado de otros proveedores.
CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_order
  ON public.payment_intents (id_provider, orden_compra)
  WHERE id_provider IS NOT NULL
    AND orden_compra IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_session
  ON public.payment_intents (id_provider, provider_session_id)
  WHERE id_provider IS NOT NULL
    AND provider_session_id IS NOT NULL;

COMMENT ON COLUMN public.payment_intents.orden_compra IS
  'Referencia estable de orden enviada al proveedor de pagos.';
COMMENT ON COLUMN public.payment_intents.provider_session_id IS
  'Identificador consultable de la sesión/transacción asignado por el proveedor.';
COMMENT ON COLUMN public.payment_intents.launch_expires_at IS
  'Expiración del lanzamiento/checkout cuando el proveedor usa un flujo hosted.';
COMMENT ON COLUMN public.payment_intents.last_verified_at IS
  'Marca temporal del último intento de consulta de estado al proveedor.';
COMMENT ON COLUMN public.payment_intents.verification_attempts IS
  'Contador resumido de intentos de consulta de estado; el historial detallado vive en app_private.payment_status_checks.';

COMMIT;
