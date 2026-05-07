-- 20260401_cliente_profile_enrichment.sql
-- Enriquecimiento puntual del perfil de cliente para experiencia self-service.

BEGIN;

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS preferencias text NULL;

-- Respaldo defensivo por si un entorno no aplico la migracion previa de storage.
ALTER TABLE public.personas
  ADD COLUMN IF NOT EXISTS foto_perfil_asset_id uuid NULL,
  ADD COLUMN IF NOT EXISTS foto_perfil_path text NULL;

COMMIT;