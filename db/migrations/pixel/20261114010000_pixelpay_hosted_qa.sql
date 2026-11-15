BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.payment_intents ADD COLUMN payment_channel text NOT NULL DEFAULT 'sdk'
  CHECK (payment_channel IN ('sdk', 'hosted'));

CREATE TABLE app_private.pixelpay_hosted_sessions (
  id_intent uuid PRIMARY KEY REFERENCES public.payment_intents(id_intent),
  id_grupo_cita uuid NOT NULL UNIQUE REFERENCES public.citas_grupos(id_grupo_cita),
  order_id text NOT NULL UNIQUE CHECK (order_id ~ '^MF-PIXELPAY-[A-F0-9]{32}$'),
  amount_hnl numeric(12,2) NOT NULL CHECK (amount_hnl > 0),
  currency text NOT NULL CHECK (currency = 'HNL'),
  expires_at timestamptz NOT NULL,
  creation_state text NOT NULL DEFAULT 'creating' CHECK (creation_state IN ('creating','checkout_ready','creation_uncertain','creation_rejected')),
  checkout_url text,
  callback_received_at timestamptz,
  callback_digest text CHECK (callback_digest IS NULL OR callback_digest ~ '^[a-f0-9]{64}$'),
  callback_digests text[] NOT NULL DEFAULT '{}' CHECK (cardinality(callback_digests) <= 16),
  provider_status_untrusted text CHECK (provider_status_untrusted IN ('paid','failed','cancelled')),
  payment_uuid_untrusted text CHECK (payment_uuid_untrusted IS NULL OR payment_uuid_untrusted ~ '^[A-Za-z0-9._-]{1,80}$'),
  late_payment_reported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (creation_state <> 'checkout_ready' OR checkout_url IS NOT NULL)
);
ALTER TABLE app_private.pixelpay_hosted_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.pixelpay_hosted_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON app_private.pixelpay_hosted_sessions TO postgres;

COMMENT ON TABLE app_private.pixelpay_hosted_sessions IS
  'AM: Hosted QA Sandbox; callback y paymentHash solo correlacionan. No constituye evidencia financiera ni autoriza confirmacion.';

CREATE FUNCTION app_private.guard_pixelpay_hosted_session_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $mf$
DECLARE v_intent record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id_intent,NEW.id_grupo_cita,NEW.order_id,NEW.amount_hnl,NEW.currency,NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id_intent,OLD.id_grupo_cita,OLD.order_id,OLD.amount_hnl,OLD.currency,OLD.expires_at) THEN
      RAISE EXCEPTION 'MF_HOSTED_SESSION_IDENTITY_IMMUTABLE';
    END IF;
    IF OLD.creation_state <> 'creating' AND ROW(NEW.creation_state, NEW.checkout_url) IS DISTINCT FROM ROW(OLD.creation_state, OLD.checkout_url) THEN
      RAISE EXCEPTION 'MF_HOSTED_SESSION_CREATION_FINALIZED';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pixelpay-channel-group:' || NEW.id_grupo_cita::text, 0));
  SELECT pi.*, pp.codigo AS provider_code INTO v_intent FROM public.payment_intents pi
  JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider WHERE pi.id_intent = NEW.id_intent;
  IF NOT FOUND OR v_intent.provider_code <> 'pixelpay' OR v_intent.id_grupo_cita IS DISTINCT FROM NEW.id_grupo_cita
     OR v_intent.orden_compra IS DISTINCT FROM NEW.order_id OR v_intent.monto_hnl IS DISTINCT FROM NEW.amount_hnl
     OR v_intent.moneda_codigo IS DISTINCT FROM NEW.currency OR v_intent.paid_at IS NOT NULL
     OR v_intent.estado_intent_codigo <> 'pendiente_confirmacion' THEN
    RAISE EXCEPTION 'MF_HOSTED_CANONICAL_ORDER_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.pixelpay_sale_attempts sa JOIN public.payment_intents pi ON pi.id_intent = sa.id_intent
             WHERE pi.id_grupo_cita = NEW.id_grupo_cita) THEN
    RAISE EXCEPTION 'MF_HOSTED_SDK_ATTEMPT_EXISTS';
  END IF;
  RETURN NEW;
END $mf$;
CREATE TRIGGER tr_guard_pixelpay_hosted_session BEFORE INSERT OR UPDATE ON app_private.pixelpay_hosted_sessions
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_pixelpay_hosted_session_v1();

CREATE FUNCTION app_private.guard_pixelpay_payment_channel_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $mf$
DECLARE v_group uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'public' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.id_grupo_cita IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('pixelpay-channel-group:' || NEW.id_grupo_cita::text, 0));
        IF EXISTS (SELECT 1 FROM app_private.pixelpay_hosted_sessions hs WHERE hs.id_grupo_cita = NEW.id_grupo_cita) THEN
          RAISE EXCEPTION 'MF_HOSTED_GROUP_ORDER_EXISTS';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.payment_channel = 'hosted' AND ROW(NEW.payment_channel,NEW.id_provider,NEW.id_grupo_cita,NEW.id_cita,NEW.id_hold,NEW.created_by_usuario_id,NEW.orden_compra,NEW.monto_hnl,NEW.moneda_codigo)
       IS DISTINCT FROM ROW(OLD.payment_channel,OLD.id_provider,OLD.id_grupo_cita,OLD.id_cita,OLD.id_hold,OLD.created_by_usuario_id,OLD.orden_compra,OLD.monto_hnl,OLD.moneda_codigo) THEN
      RAISE EXCEPTION 'MF_HOSTED_PAYMENT_CHANNEL_IMMUTABLE';
    END IF;
    IF NEW.payment_channel = 'hosted' AND NOT EXISTS (SELECT 1 FROM app_private.pixelpay_hosted_sessions hs
                                                    WHERE hs.id_intent = NEW.id_intent) THEN
      RAISE EXCEPTION 'MF_HOSTED_SESSION_REQUIRED';
    END IF;
  ELSE
    SELECT pi.id_grupo_cita INTO v_group FROM public.payment_intents pi WHERE pi.id_intent = NEW.id_intent;
    IF v_group IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('pixelpay-channel-group:' || v_group::text, 0));
      IF EXISTS (SELECT 1 FROM app_private.pixelpay_hosted_sessions hs WHERE hs.id_grupo_cita = v_group) THEN
        RAISE EXCEPTION 'MF_HOSTED_PAYMENT_CHANNEL_MISMATCH';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $mf$;
-- AM: Ejecutar despues de tr_payment_intents_set_group cubre INSERT legacy sin grupo explicito.
CREATE TRIGGER tr_payment_intents_zz_guard_hosted_channel BEFORE INSERT OR UPDATE OF payment_channel,id_provider,id_grupo_cita,id_cita,id_hold,created_by_usuario_id,orden_compra,monto_hnl,moneda_codigo ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_pixelpay_payment_channel_v1();
CREATE TRIGGER tr_guard_pixelpay_sdk_channel BEFORE INSERT ON app_private.pixelpay_sale_attempts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_pixelpay_payment_channel_v1();
REVOKE ALL ON FUNCTION app_private.guard_pixelpay_hosted_session_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_pixelpay_payment_channel_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
