-- 20260330_comunicaciones_exclusiones_snapshot.sql
-- Agrega snapshot persistente de exclusiones para campanas de comunicacion.

ALTER TABLE public.comunicaciones_campanias
  ADD COLUMN IF NOT EXISTS exclusiones_snapshot jsonb;

COMMENT ON COLUMN public.comunicaciones_campanias.exclusiones_snapshot IS
  'Snapshot de exclusiones al programar campana: incluye excluidos por reglas y exclusiones manuales.';
