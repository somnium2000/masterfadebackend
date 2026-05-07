BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT regexp_replace(COALESCE(dni, ''), '\D', '', 'g') AS documento
      FROM public.personas
      WHERE deleted_at IS NULL
        AND COALESCE(dni, '') <> ''
    ) d
    WHERE d.documento <> ''
    GROUP BY d.documento
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede crear uq_personas_dni_norm: existen DNI duplicados en public.personas';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT regexp_replace(COALESCE(rtn, ''), '\D', '', 'g') AS documento
      FROM public.personas
      WHERE deleted_at IS NULL
        AND COALESCE(rtn, '') <> ''
    ) r
    WHERE r.documento <> ''
    GROUP BY r.documento
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede crear uq_personas_rtn_norm: existen RTN duplicados en public.personas';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_dni_norm
  ON public.personas (regexp_replace(COALESCE(dni, ''), '\D', '', 'g'))
  WHERE deleted_at IS NULL
    AND COALESCE(dni, '') <> ''
    AND regexp_replace(COALESCE(dni, ''), '\D', '', 'g') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_rtn_norm
  ON public.personas (regexp_replace(COALESCE(rtn, ''), '\D', '', 'g'))
  WHERE deleted_at IS NULL
    AND COALESCE(rtn, '') <> ''
    AND regexp_replace(COALESCE(rtn, ''), '\D', '', 'g') <> '';

COMMIT;
