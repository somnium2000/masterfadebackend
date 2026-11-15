BEGIN;
SET LOCAL lock_timeout = '5s';
-- AM: Null preserves every historical/ordinary attempt; only new START inserts may mark QA.
ALTER TABLE app_private.pixelpay_sale_attempts
  ADD COLUMN qa_test_origin text CHECK (qa_test_origin IN ('sandbox_session', '3ds_diagnostic'));

CREATE FUNCTION app_private.preserve_pixelpay_qa_test_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.qa_test_origin IS NOT NULL THEN
      RAISE EXCEPTION 'PIXELPAY_QA_ORIGIN_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.qa_test_origin IS DISTINCT FROM OLD.qa_test_origin THEN
    RAISE EXCEPTION 'PIXELPAY_QA_ORIGIN_IMMUTABLE';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION app_private.preserve_pixelpay_qa_test_origin() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER preserve_pixelpay_qa_test_origin
BEFORE UPDATE OR DELETE ON app_private.pixelpay_sale_attempts
FOR EACH ROW EXECUTE FUNCTION app_private.preserve_pixelpay_qa_test_origin();
COMMIT;
