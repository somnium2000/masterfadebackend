CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.citas (id_cita uuid PRIMARY KEY, id_grupo_cita uuid);
CREATE TABLE public.citas_holds (
  id_hold uuid PRIMARY KEY, id_cita uuid NOT NULL REFERENCES public.citas,
  expires_at timestamptz NOT NULL, estado_hold_codigo text NOT NULL
);
CREATE TABLE public.payment_intents (
  id_intent uuid PRIMARY KEY, id_cita uuid, id_grupo_cita uuid, id_hold uuid,
  origen_pago_codigo text NOT NULL DEFAULT 'cita', monto_hnl numeric(12,2) NOT NULL,
  moneda_codigo text NOT NULL, expires_at timestamptz NOT NULL,
  estado_intent_codigo text NOT NULL, paid_at timestamptz,
  orden_compra text, provider_session_id text, verification_attempts integer DEFAULT 0,
  CONSTRAINT ck_payment_intents_orden_compra_not_blank CHECK (orden_compra IS NULL OR btrim(orden_compra) <> ''),
  CONSTRAINT ck_payment_intents_provider_session_not_blank CHECK (provider_session_id IS NULL OR btrim(provider_session_id) <> ''),
  CONSTRAINT ck_payment_intents_verification_attempts_nonnegative CHECK (verification_attempts >= 0)
);
CREATE TABLE public.payments (
  id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_intent uuid NOT NULL REFERENCES public.payment_intents,
  estado_pago_codigo text NOT NULL, monto_hnl numeric(12,2) NOT NULL, moneda_codigo text NOT NULL,
  paid_at timestamptz, pago_tardio boolean NOT NULL DEFAULT false
);
CREATE FUNCTION public.fn_trg_validar_pago_monto_tiempo() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE FUNCTION public.fn_trg_aplicar_pago_a_cita() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE FUNCTION public.fn_payment_intents_capture_paid_at() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER tr_pay_validar BEFORE INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.fn_trg_validar_pago_monto_tiempo();
CREATE TRIGGER tr_pay_aplicar AFTER INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.fn_trg_aplicar_pago_a_cita();
CREATE TRIGGER tr_payment_intents_capture_paid_at BEFORE INSERT OR UPDATE OF estado_intent_codigo, paid_at ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.fn_payment_intents_capture_paid_at();

CREATE TABLE public.membership_purchase_orders (
  id_order uuid PRIMARY KEY, id_cliente uuid NOT NULL,
  estado_orden_codigo text NOT NULL DEFAULT 'pendiente_pago', paid_at timestamptz
);
CREATE TABLE public.subscriptions (
  id_subscription uuid PRIMARY KEY,
  motivo_fin_codigo text,
  CONSTRAINT ck_sub_motivo_fin CHECK (motivo_fin_codigo IS NULL OR motivo_fin_codigo IN ('tiempo','agotamiento','reemplazo','cancelacion'))
);
CREATE TABLE public.subscription_payments (
  id_subscription_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estado text NOT NULL, paid_at timestamptz
);

CREATE TABLE public.citas_detalles (id uuid PRIMARY KEY);
CREATE FUNCTION public.fn_citas_detalles_line_identity_v2() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RETURN NEW; END$$;
CREATE FUNCTION public.fn_hold_defaults_y_unico() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER tr_zz_citas_detalles_line_identity BEFORE INSERT ON public.citas_detalles FOR EACH ROW EXECUTE FUNCTION public.fn_citas_detalles_line_identity_v2();
CREATE TRIGGER tr_hold_unico BEFORE INSERT ON public.citas_holds FOR EACH ROW EXECUTE FUNCTION public.fn_hold_defaults_y_unico();
GRANT EXECUTE ON FUNCTION public.fn_citas_detalles_line_identity_v2() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() TO PUBLIC, anon, authenticated;
