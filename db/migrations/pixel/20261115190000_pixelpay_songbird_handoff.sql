BEGIN;
SET LOCAL lock_timeout='5s';
-- AM: Private authentication state only; no payment/cita/hold trigger or v2 evidence is altered.
CREATE TABLE app_private.pixelpay_songbird_handoffs (
  id_intent uuid PRIMARY KEY REFERENCES public.payment_intents(id_intent) ON DELETE RESTRICT,
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES app_private.pixelpay_sale_attempts(payment_attempt_id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL, group_id uuid NOT NULL, order_id text NOT NULL,
  amount_hnl numeric(14,2) NOT NULL CHECK(amount_hnl=1), currency text NOT NULL CHECK(currency='HNL'),
  state text NOT NULL CHECK(state IN ('awaiting_response','handoff_ready','browser_leased','setup_in_flight','challenge_ready',
    'validation_in_flight','authentication_complete','contract_blocked','interrupted','expired')),
  expires_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 0,
  lease_id uuid, payload_box text CHECK(length(payload_box)<=40000), challenge_box text CHECK(length(challenge_box)<=40000),
  input_hash text CHECK(input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$'),
  authentication_id text CHECK(authentication_id IS NULL OR authentication_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(state='handoff_ready' OR payload_box IS NULL)
);
ALTER TABLE app_private.pixelpay_songbird_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.pixelpay_songbird_handoffs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON app_private.pixelpay_songbird_handoffs TO service_role;
COMMIT;
