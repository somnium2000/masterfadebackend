-- AM: Registro publico cliente - trazabilidad minima de consentimientos.
BEGIN;

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS acepta_terminos_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS consentimiento_marketing_at timestamptz NULL;

-- AM: Backfill no destructivo para datos historicos existentes.
UPDATE public.clientes
SET
  acepta_terminos_at = COALESCE(acepta_terminos_at, CASE WHEN acepta_terminos IS TRUE THEN created_at ELSE NULL END),
  consentimiento_marketing_at = COALESCE(
    consentimiento_marketing_at,
    CASE WHEN consentimiento_marketing IS TRUE THEN created_at ELSE NULL END
  )
WHERE deleted_at IS NULL;

COMMIT;
