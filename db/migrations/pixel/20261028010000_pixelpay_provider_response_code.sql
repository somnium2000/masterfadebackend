BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app_private.pixelpay_sale_attempts
  ADD COLUMN IF NOT EXISTS provider_response_code varchar(16);

ALTER TABLE app_private.pixelpay_sale_attempts
  DROP CONSTRAINT IF EXISTS ck_pixelpay_sale_attempts_provider_response_code;

ALTER TABLE app_private.pixelpay_sale_attempts
  ADD CONSTRAINT ck_pixelpay_sale_attempts_provider_response_code CHECK (
    provider_response_code IS NULL
    OR (
      provider_response_code = btrim(provider_response_code)
      AND provider_response_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,15}$'
      AND provider_response_code !~ '^[0-9]{13,19}$'
    )
  );

COMMENT ON COLUMN app_private.pixelpay_sale_attempts.provider_response_code IS
  'Codigo financiero validado devuelto por PixelPay; excluye texto libre y datos de tarjeta.';

REVOKE ALL ON TABLE app_private.pixelpay_sale_attempts FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
