-- AM: Migracion aditiva; aplicar manualmente en un ambiente autorizado y reiniciar el backend.
-- AM: Las ordenes historicas mantienen NULL y no se modifican snapshots ni estados.
BEGIN;

ALTER TABLE public.membership_purchase_orders
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_purchase_orders_cliente_idempotency
  ON public.membership_purchase_orders (id_cliente, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
