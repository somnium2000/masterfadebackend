BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.pixelpay_sale_attempts
  ADD COLUMN IF NOT EXISTS observed_payment_uuid_untrusted varchar(80),
  ADD COLUMN IF NOT EXISTS observed_transaction_id_untrusted varchar(160),
  ADD COLUMN IF NOT EXISTS observed_transaction_reference_untrusted varchar(160);

ALTER TABLE app_private.pixelpay_sale_attempts
  DROP CONSTRAINT IF EXISTS ck_pixelpay_sale_attempts_observed_payment_uuid,
  DROP CONSTRAINT IF EXISTS ck_pixelpay_sale_attempts_observed_transaction_id,
  DROP CONSTRAINT IF EXISTS ck_pixelpay_sale_attempts_observed_transaction_reference,
  DROP CONSTRAINT IF EXISTS ck_pixelpay_sale_attempts_message;

ALTER TABLE app_private.pixelpay_sale_attempts
  ADD CONSTRAINT ck_pixelpay_sale_attempts_observed_payment_uuid
    CHECK (observed_payment_uuid_untrusted IS NULL OR
      observed_payment_uuid_untrusted ~* '^P-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  ADD CONSTRAINT ck_pixelpay_sale_attempts_observed_transaction_id
    CHECK (observed_transaction_id_untrusted IS NULL OR (
      observed_transaction_id_untrusted = btrim(observed_transaction_id_untrusted)
      AND char_length(observed_transaction_id_untrusted) BETWEEN 1 AND 160
      AND observed_transaction_id_untrusted !~ '[[:cntrl:]]'
    )),
  ADD CONSTRAINT ck_pixelpay_sale_attempts_observed_transaction_reference
    CHECK (observed_transaction_reference_untrusted IS NULL OR (
      observed_transaction_reference_untrusted = btrim(observed_transaction_reference_untrusted)
      AND char_length(observed_transaction_reference_untrusted) BETWEEN 1 AND 160
      AND observed_transaction_reference_untrusted !~ '[[:cntrl:]]'
    )),
  ADD CONSTRAINT ck_pixelpay_sale_attempts_message
    CHECK (safe_message_code IS NULL OR safe_message_code IN (
      'SDK_PUBLIC_KEY_UNAVAILABLE', 'SDK_ENCRYPTION_FAILED', 'SDK_HTTP_TIMEOUT', 'SDK_UPSTREAM_TIMEOUT',
      'SDK_NETWORK_ERROR', 'SDK_REQUEST_CONFIG_ERROR', 'SDK_EXCEPTION_OTHER', 'SDK_MESSAGE_ABSENT'
    ));

COMMENT ON COLUMN app_private.pixelpay_sale_attempts.observed_payment_uuid_untrusted IS
  'AM: Evidencia privada observada en Sale incierta; no demuestra aprobacion ni identidad financiera confiable.';
COMMENT ON COLUMN app_private.pixelpay_sale_attempts.observed_transaction_id_untrusted IS
  'AM: Evidencia privada observada en Sale incierta; no demuestra aprobacion ni identidad financiera confiable.';
COMMENT ON COLUMN app_private.pixelpay_sale_attempts.observed_transaction_reference_untrusted IS
  'AM: Evidencia privada observada en Sale incierta; no demuestra aprobacion ni identidad financiera confiable.';

REVOKE ALL ON TABLE app_private.pixelpay_sale_attempts FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
