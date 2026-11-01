BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.membership_purchase_orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $preflight$
BEGIN
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
END
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_purchase_orders_cliente_idempotency
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

COMMIT;
