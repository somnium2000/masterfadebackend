BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: Una fila privada por intento; el claim y el registro inicial comparten COMMIT.
CREATE TABLE IF NOT EXISTS app_private.pixelpay_sale_attempts (
  id_sale_attempt uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_intent uuid NOT NULL,
  payment_attempt_id uuid NOT NULL UNIQUE,
  request_id varchar(120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  duration_ms integer,
  sdk_response_class varchar(80),
  upstream_http_status smallint,
  safe_message_code varchar(120),
  outcome varchar(80),
  uncertain boolean,
  input_error_fields text[] NOT NULL DEFAULT '{}',
  input_error_count integer NOT NULL DEFAULT 0,
  input_error_unknown_count integer NOT NULL DEFAULT 0,
  card_expire_format_valid boolean,
  card_expire_future boolean,
  billing_address_length integer,
  response_success boolean,
  transaction_result_valid boolean,
  transaction_result_parsed boolean,
  response_approved boolean,
  response_incomplete boolean,
  response_code_present boolean,
  payment_uuid_present boolean,
  transaction_id_present boolean,
  payment_hash_present boolean,
  payment_hash_valid boolean,
  transaction_amount_matches boolean,
  approved_amount_matches boolean,
  amount_matches boolean,
  cf_ray varchar(120),
  error_code varchar(120),
  error_name varchar(80),
  sdk_error_name varchar(80),
  error_constructor_name varchar(80),
  CONSTRAINT fk_pixelpay_sale_attempts_intent
    FOREIGN KEY (id_intent) REFERENCES public.payment_intents(id_intent)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_pixelpay_sale_attempts_status
    CHECK (upstream_http_status IS NULL OR upstream_http_status BETWEEN 100 AND 599),
  CONSTRAINT ck_pixelpay_sale_attempts_duration
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT ck_pixelpay_sale_attempts_counts
    CHECK (input_error_count BETWEEN 0 AND 32 AND input_error_unknown_count >= 0
      AND cardinality(input_error_fields) <= 32
      AND input_error_count = cardinality(input_error_fields)),
  CONSTRAINT ck_pixelpay_sale_attempts_inputs
    CHECK (array_position(input_error_fields, NULL) IS NULL
      AND input_error_fields <@ ARRAY[
        'authentication_request', 'billing_address', 'billing_city', 'billing_country',
        'billing_phone', 'billing_state', 'card_cvv', 'card_expire', 'card_holder', 'card_number',
        'customer_email', 'customer_name', 'from', 'lang', 'order_amount', 'order_content',
        'order_currency', 'order_extras', 'order_id', 'sdk_version'
      ]::text[]),
  CONSTRAINT ck_pixelpay_sale_attempts_outcome
    CHECK (outcome IS NULL OR outcome IN (
      'approved', 'payment_declined', 'request_error_definitive', 'uncertain'
    )),
  CONSTRAINT ck_pixelpay_sale_attempts_message
    CHECK (safe_message_code IS NULL OR safe_message_code IN (
      'SDK_PUBLIC_KEY_UNAVAILABLE', 'SDK_ENCRYPTION_FAILED', 'SDK_HTTP_TIMEOUT', 'SDK_NETWORK_ERROR',
      'SDK_REQUEST_CONFIG_ERROR', 'SDK_EXCEPTION_OTHER', 'SDK_MESSAGE_ABSENT'
    )),
  CONSTRAINT ck_pixelpay_sale_attempts_error_code
    CHECK (error_code IS NULL OR error_code IN (
      'PIXELPAY_CARD_EXPIRE_INVALID', 'PIXELPAY_CARD_EXPIRED', 'PIXELPAY_BILLING_ADDRESS_INVALID',
      'PIXELPAY_BILLING_COUNTRY_INVALID', 'PIXELPAY_BILLING_STATE_INVALID', 'PIXELPAY_ORDER_ITEMS_INVALID',
      'PIXELPAY_ORDER_AMOUNT_MISMATCH', 'PIXELPAY_NETWORK_ERROR', 'PIXELPAY_TIMEOUT', 'PIXELPAY_RESPONSE_INVALID'
    )),
  CONSTRAINT ck_pixelpay_sale_attempts_billing_length
    CHECK (billing_address_length IS NULL OR billing_address_length BETWEEN 0 AND 180),
  CONSTRAINT ck_pixelpay_sale_attempts_cf_ray
    CHECK (cf_ray IS NULL OR (cf_ray ~* '^[a-f0-9]{16}(-[A-Z]{3})?$'
      AND left(cf_ray, 16) ~* '[a-f]'))
);

CREATE INDEX IF NOT EXISTS idx_pixelpay_sale_attempts_intent_created
  ON app_private.pixelpay_sale_attempts (id_intent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pixelpay_sale_attempts_unfinalized
  ON app_private.pixelpay_sale_attempts (created_at)
  WHERE finalized_at IS NULL;

COMMENT ON TABLE app_private.pixelpay_sale_attempts IS
  'AM: Diagnostico interno sanitizado de Sale. Sin payloads, valores de inputs ni credenciales.';

REVOKE ALL ON TABLE app_private.pixelpay_sale_attempts FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
