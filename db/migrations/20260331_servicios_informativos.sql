-- 20260331_servicios_informativos.sql
-- AM: Marca servicios informativos por sucursal para separarlos de agenda/citas.

BEGIN;

ALTER TABLE public.servicios_tarifas
  ADD COLUMN IF NOT EXISTS servicio_informativo boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.servicios_tarifas.servicio_informativo
  IS 'TRUE cuando el servicio es solo informativo en la sucursal y no debe poder agendarse.';

COMMIT;
