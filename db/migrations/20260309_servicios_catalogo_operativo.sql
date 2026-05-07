-- AM: Fase de cierre de SERVICIOS para eliminar clasificacion hardcodeada por nombre.
BEGIN;

ALTER TABLE public.servicios
  ADD COLUMN IF NOT EXISTS grupo_catalogo text,
  ADD COLUMN IF NOT EXISTS visible_publico boolean,
  ADD COLUMN IF NOT EXISTS agendable boolean,
  ADD COLUMN IF NOT EXISTS orden_visual integer;

-- AM: Inicializa grupo de catalogo de forma compatible con la clasificacion historica.
WITH normalized_services AS (
  SELECT
    s.id_servicio,
    UPPER(TRIM(translate(s.nombre_servicio, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))) AS nombre_normalizado
  FROM public.servicios s
)
UPDATE public.servicios s
SET grupo_catalogo = CASE
  WHEN ns.nombre_normalizado IN (
    'NANO',
    'PERMANENTE',
    'TRATAMIENTOS DE COLORIMETRIA',
    'MANICURE Y PEDICURE'
  ) THEN 'otros'
  ELSE 'barberia'
END
FROM normalized_services ns
WHERE ns.id_servicio = s.id_servicio
  AND s.grupo_catalogo IS NULL;

UPDATE public.servicios
SET visible_publico = TRUE
WHERE visible_publico IS NULL;

UPDATE public.servicios
SET agendable = CASE
  WHEN grupo_catalogo = 'otros' THEN FALSE
  ELSE TRUE
END
WHERE agendable IS NULL;

UPDATE public.servicios
SET orden_visual = 100
WHERE orden_visual IS NULL;

ALTER TABLE public.servicios
  ALTER COLUMN grupo_catalogo SET DEFAULT 'barberia',
  ALTER COLUMN visible_publico SET DEFAULT TRUE,
  ALTER COLUMN agendable SET DEFAULT TRUE,
  ALTER COLUMN orden_visual SET DEFAULT 100;

ALTER TABLE public.servicios
  ALTER COLUMN grupo_catalogo SET NOT NULL,
  ALTER COLUMN visible_publico SET NOT NULL,
  ALTER COLUMN agendable SET NOT NULL,
  ALTER COLUMN orden_visual SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_servicios_grupo_catalogo'
      AND conrelid = 'public.servicios'::regclass
  ) THEN
    ALTER TABLE public.servicios
      ADD CONSTRAINT ck_servicios_grupo_catalogo
      CHECK (grupo_catalogo IN ('barberia', 'otros'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_servicios_orden_visual'
      AND conrelid = 'public.servicios'::regclass
  ) THEN
    ALTER TABLE public.servicios
      ADD CONSTRAINT ck_servicios_orden_visual
      CHECK (orden_visual >= 0);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_servicios_catalogo_publico
  ON public.servicios (orden_visual, nombre_servicio)
  WHERE deleted_at IS NULL
    AND activo IS TRUE
    AND visible_publico IS TRUE;

COMMIT;
