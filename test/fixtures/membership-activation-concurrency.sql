CREATE SCHEMA app_private;

CREATE TABLE app_private.solicitudes_eliminacion_cuenta (
  id_cliente uuid,
  id_usuario uuid,
  id_persona uuid,
  estado_codigo text
);

CREATE TABLE public.usuarios (
  id_usuario uuid PRIMARY KEY,
  id_persona uuid NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  estado_acceso text NOT NULL DEFAULT 'activo'
);

CREATE TABLE public.clientes (
  id_cliente uuid PRIMARY KEY,
  id_usuario uuid NOT NULL REFERENCES public.usuarios(id_usuario),
  id_persona uuid NOT NULL,
  estado boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  anonimizado boolean NOT NULL DEFAULT false
);

CREATE TABLE public.sucursales (
  id_sucursal uuid PRIMARY KEY,
  nombre_sucursal text NOT NULL
);

CREATE TABLE public.membership_plans (
  id_plan uuid PRIMARY KEY,
  nombre_plan text NOT NULL,
  periodo_membresia_codigo text NOT NULL,
  beneficios jsonb NOT NULL,
  categoria_nivel integer NOT NULL DEFAULT 1
);

CREATE TABLE public.payment_providers (
  id_provider uuid PRIMARY KEY,
  codigo text NOT NULL UNIQUE
);

CREATE TABLE public.subscriptions (
  id_suscripcion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cliente uuid NOT NULL REFERENCES public.clientes(id_cliente),
  id_plan uuid NOT NULL REFERENCES public.membership_plans(id_plan),
  estado_suscripcion_codigo text NOT NULL,
  inicio_at timestamptz NOT NULL,
  fin_at timestamptz NOT NULL,
  renovacion_auto boolean NOT NULL,
  cancelada_al_fin boolean NOT NULL,
  created_by_usuario_id uuid,
  id_sucursal_contratada uuid REFERENCES public.sucursales(id_sucursal),
  beneficios_snapshot jsonb NOT NULL,
  motivo_fin_codigo text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.membership_purchase_orders (
  id_order uuid PRIMARY KEY,
  id_cliente uuid NOT NULL REFERENCES public.clientes(id_cliente),
  id_usuario uuid NOT NULL REFERENCES public.usuarios(id_usuario),
  id_plan uuid NOT NULL REFERENCES public.membership_plans(id_plan),
  id_plan_sucursal uuid NOT NULL,
  id_sucursal uuid NOT NULL REFERENCES public.sucursales(id_sucursal),
  estado_orden_codigo text NOT NULL,
  total_hnl numeric(12,2) NOT NULL,
  moneda_codigo text NOT NULL,
  expires_at timestamptz NOT NULL,
  id_suscripcion uuid REFERENCES public.subscriptions(id_suscripcion),
  plan_snapshot jsonb NOT NULL,
  cliente_snapshot jsonb NOT NULL,
  paid_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.payment_intents (
  id_intent uuid PRIMARY KEY,
  id_provider uuid NOT NULL REFERENCES public.payment_providers(id_provider),
  id_membership_order uuid NOT NULL REFERENCES public.membership_purchase_orders(id_order),
  origen_pago_codigo text NOT NULL,
  estado_intent_codigo text NOT NULL,
  monto_hnl numeric(12,2) NOT NULL,
  moneda_codigo text NOT NULL,
  referencia_externa text,
  provider_session_id text,
  orden_compra text,
  expires_at timestamptz NOT NULL,
  created_by_usuario_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.payment_events (
  id_event uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_provider uuid NOT NULL REFERENCES public.payment_providers(id_provider),
  provider_event_id text NOT NULL,
  evento_tipo text NOT NULL,
  firma_valida boolean NOT NULL,
  payload_esencial jsonb NOT NULL,
  id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
  recibido_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id_provider, provider_event_id)
);

CREATE TABLE public.payments (
  id_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_intent uuid NOT NULL REFERENCES public.payment_intents(id_intent),
  estado_pago_codigo text NOT NULL,
  provider_tx_id text NOT NULL UNIQUE,
  monto_hnl numeric(12,2) NOT NULL,
  moneda_codigo text NOT NULL,
  paid_at timestamptz NOT NULL,
  pago_tardio boolean NOT NULL DEFAULT false,
  registrado_manualmente boolean NOT NULL DEFAULT false,
  registrado_por_usuario_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.test_membership_payment_time()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_expiry timestamptz;
BEGIN
  SELECT expires_at INTO v_expiry FROM public.payment_intents WHERE id_intent = NEW.id_intent;
  IF NEW.paid_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='MF_PAYMENT_PAID_AT_REQUIRED';
  END IF;
  NEW.pago_tardio := NEW.paid_at > v_expiry;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER tr_membership_payment_time
BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.test_membership_payment_time();

CREATE TABLE public.subscription_payments (
  id_subscription_payment uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_suscripcion uuid NOT NULL REFERENCES public.subscriptions(id_suscripcion),
  monto_hnl numeric(12,2) NOT NULL,
  moneda_codigo text NOT NULL,
  metodo text NOT NULL,
  estado text NOT NULL,
  paid_at timestamptz NOT NULL,
  id_payment uuid NOT NULL UNIQUE REFERENCES public.payments(id_payment),
  registrado_por_usuario_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.subscription_consumptions (
  id_consumption uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_suscripcion uuid NOT NULL REFERENCES public.subscriptions(id_suscripcion),
  source_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.test_membership_failures (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fail_subscription_payment boolean NOT NULL DEFAULT false
);
INSERT INTO public.test_membership_failures DEFAULT VALUES;

CREATE OR REPLACE FUNCTION public.test_fail_subscription_payment()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT fail_subscription_payment FROM public.test_membership_failures WHERE singleton) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='TEST_SUBSCRIPTION_PAYMENT_FAILURE';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER tr_test_fail_subscription_payment
BEFORE INSERT ON public.subscription_payments
FOR EACH ROW EXECUTE FUNCTION public.test_fail_subscription_payment();

-- Capability probes only; the activation path does not write these tables.
CREATE TABLE public.membership_plans_sucursal (id_plan_sucursal uuid PRIMARY KEY);
CREATE TABLE public.subscription_alert_events (id_event uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.points_transactions (id_transaction uuid PRIMARY KEY DEFAULT gen_random_uuid(), origen_punto_codigo text);
