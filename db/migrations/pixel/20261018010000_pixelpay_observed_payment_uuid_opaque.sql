BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE app_private.pixelpay_sale_attempts
  DROP CONSTRAINT ck_pixelpay_sale_attempts_observed_payment_uuid;

ALTER TABLE app_private.pixelpay_sale_attempts
  ADD CONSTRAINT ck_pixelpay_sale_attempts_observed_payment_uuid
    CHECK (observed_payment_uuid_untrusted IS NULL OR (
      btrim(observed_payment_uuid_untrusted) <> ''
      AND char_length(observed_payment_uuid_untrusted) <= 80
      AND observed_payment_uuid_untrusted !~ '[[:cntrl:]]'
    ));

COMMIT;
