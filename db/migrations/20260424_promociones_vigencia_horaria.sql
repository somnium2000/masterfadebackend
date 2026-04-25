BEGIN;

/* // JK: Agrega vigencia por hora opcional en promociones por sucursal sin alterar la vigencia por fecha existente. */
ALTER TABLE IF EXISTS public.promociones_sucursal
  ADD COLUMN IF NOT EXISTS vigencia_hora_desde time NULL,
  ADD COLUMN IF NOT EXISTS vigencia_hora_hasta time NULL;

COMMIT;
