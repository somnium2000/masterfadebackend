BEGIN;
SET LOCAL lock_timeout='5s';
-- AM: Ephemeral SDK ciphertext only; no PAN/CVV, financial evidence or historical intents are written.
ALTER TABLE app_private.pixelpay_songbird_handoffs
  ADD COLUMN context_box text CHECK (length(context_box)<=40000),
  ADD COLUMN block_code text CHECK (block_code IS NULL OR block_code ~ '^[A-Z][A-Z0-9_]{1,90}$'),
  ADD COLUMN provider_http_status smallint CHECK (provider_http_status BETWEEN 100 AND 599);
ALTER TABLE app_private.pixelpay_songbird_handoffs DROP CONSTRAINT pixelpay_songbird_handoffs_state_check;
ALTER TABLE app_private.pixelpay_songbird_handoffs ADD CONSTRAINT pixelpay_songbird_handoffs_state_check
  CHECK(state IN ('awaiting_response','handoff_ready','browser_leased','setup_in_flight','challenge_ready',
    'validation_in_flight','authentication_complete','authentication_failed','contract_blocked','interrupted','expired'));
ALTER TABLE app_private.pixelpay_songbird_handoffs ADD CONSTRAINT pixelpay_songbird_context_lifetime
  CHECK(state IN ('handoff_ready','browser_leased') OR context_box IS NULL);
-- AM: Older binaries can still close a lease after rollback without retaining expired context or failing the CHECK.
CREATE FUNCTION app_private.clear_pixelpay_songbird_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state NOT IN ('handoff_ready','browser_leased') OR NEW.expires_at<=clock_timestamp() THEN
    NEW.context_box=NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.clear_pixelpay_songbird_context() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.clear_pixelpay_songbird_context() TO service_role;
CREATE TRIGGER pixelpay_songbird_context_cleanup BEFORE INSERT OR UPDATE
  ON app_private.pixelpay_songbird_handoffs FOR EACH ROW EXECUTE FUNCTION app_private.clear_pixelpay_songbird_context();
COMMIT;
