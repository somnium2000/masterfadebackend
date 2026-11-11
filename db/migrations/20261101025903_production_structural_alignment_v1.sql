BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.membership_purchase_orders
  ADD COLUMN idempotency_key text;

DO $preflight$
DECLARE
  v_required_constraints constant text[] := ARRAY[
    'ck_payment_intents_provider_session_not_blank',
    'ck_payment_intents_orden_compra_not_blank',
    'ck_payment_intents_verification_attempts_nonnegative'
  ];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(v_required_constraints) AS required(conname)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.payment_intents'::regclass
        AND c.conname = required.conname
        AND c.contype = 'c'
    )
  ) THEN
    RAISE EXCEPTION 'MF_PAYMENT_INTENTS_PROTECTIVE_CONSTRAINT_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.membership_purchase_orders
    WHERE idempotency_key IS NOT NULL
    GROUP BY id_cliente, idempotency_key HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'MF_MEMBERSHIP_IDEMPOTENCY_DUPLICATES';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE motivo_fin_codigo IS NOT NULL
      AND motivo_fin_codigo NOT IN ('tiempo','agotamiento','reemplazo','cancelacion','eliminacion_cuenta')
  ) THEN
    RAISE EXCEPTION 'MF_SUB_MOTIVO_FIN_UNSUPPORTED_VALUE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.seguridad_sesiones
    WHERE motivo_cierre IS NOT NULL
      AND motivo_cierre NOT IN (
        'logout_usuario','logout_admin','reemplazo_sesion_cliente',
        'sesion_expirada','riesgo_seguridad','eliminacion_cuenta','password_reset'
      )
  ) THEN
    RAISE EXCEPTION 'MF_SESSION_CLOSE_REASON_UNSUPPORTED_VALUE';
  END IF;
END
$preflight$;

CREATE UNIQUE INDEX ux_membership_purchase_orders_cliente_idempotency
  ON public.membership_purchase_orders (id_cliente, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT ck_sub_motivo_fin_v2
  CHECK (
    motivo_fin_codigo IS NULL OR motivo_fin_codigo IN
      ('tiempo','agotamiento','reemplazo','cancelacion','eliminacion_cuenta')
  ) NOT VALID;
ALTER TABLE public.subscriptions VALIDATE CONSTRAINT ck_sub_motivo_fin_v2;
ALTER TABLE public.subscriptions DROP CONSTRAINT ck_sub_motivo_fin;
ALTER TABLE public.subscriptions RENAME CONSTRAINT ck_sub_motivo_fin_v2 TO ck_sub_motivo_fin;

ALTER TABLE public.seguridad_sesiones
  ADD CONSTRAINT ck_seg_sesiones_motivo_cierre_v2
  CHECK (
    motivo_cierre IS NULL OR motivo_cierre IN (
      'logout_usuario','logout_admin','reemplazo_sesion_cliente',
      'sesion_expirada','riesgo_seguridad','eliminacion_cuenta','password_reset'
    )
  ) NOT VALID;
ALTER TABLE public.seguridad_sesiones VALIDATE CONSTRAINT ck_seg_sesiones_motivo_cierre_v2;
ALTER TABLE public.seguridad_sesiones DROP CONSTRAINT ck_seg_sesiones_motivo_cierre;
ALTER TABLE public.seguridad_sesiones
  RENAME CONSTRAINT ck_seg_sesiones_motivo_cierre_v2 TO ck_seg_sesiones_motivo_cierre;

COMMIT;
