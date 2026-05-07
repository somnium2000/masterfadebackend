BEGIN;

-- AM: Alinea el repo al modelo operativo real de promociones:
-- AM: - estado operativo en public.promociones.estado
-- AM: - sin dependencia de public.promociones.deleted_at
-- AM: - sin dependencia de public.promociones_sucursal.estado

ALTER TABLE IF EXISTS public.promociones
  ADD COLUMN IF NOT EXISTS estado text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'promociones_sucursal'
      AND column_name = 'estado'
  ) THEN
    WITH estado_resuelto AS (
      SELECT
        ps.id_promocion,
        CASE
          WHEN BOOL_OR(ps.estado = 'publicada') THEN 'publicada'
          WHEN BOOL_OR(ps.estado = 'borrador') THEN 'borrador'
          WHEN BOOL_OR(ps.estado = 'archivada') THEN 'archivada'
          ELSE 'borrador'
        END AS estado
      FROM public.promociones_sucursal ps
      GROUP BY ps.id_promocion
    )
    UPDATE public.promociones p
    SET estado = er.estado
    FROM estado_resuelto er
    WHERE p.id_promocion = er.id_promocion
      AND (
        p.estado IS NULL
        OR btrim(p.estado) = ''
        OR p.estado NOT IN ('borrador', 'publicada', 'archivada')
      );
  END IF;
END$$;

UPDATE public.promociones
SET estado = 'borrador'
WHERE estado IS NULL
   OR btrim(estado) = ''
   OR estado NOT IN ('borrador', 'publicada', 'archivada');

ALTER TABLE public.promociones
  ALTER COLUMN estado SET DEFAULT 'borrador',
  ALTER COLUMN estado SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_estado'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_estado
      CHECK (estado IN ('borrador', 'publicada', 'archivada'));
  END IF;
END$$;

ALTER TABLE IF EXISTS public.promociones_sucursal
  DROP CONSTRAINT IF EXISTS ck_promociones_sucursal_estado;

DROP INDEX IF EXISTS public.idx_promociones_sucursal_branch;

ALTER TABLE IF EXISTS public.promociones_sucursal
  DROP COLUMN IF EXISTS estado;

ALTER TABLE IF EXISTS public.promociones
  DROP COLUMN IF EXISTS deleted_at;

CREATE INDEX IF NOT EXISTS idx_promociones_estado_lookup
  ON public.promociones (estado, updated_at DESC, id_promocion);

CREATE INDEX IF NOT EXISTS idx_promociones_sucursal_branch
  ON public.promociones_sucursal (id_sucursal, visible_publico, orden_visual, id_promocion);

CREATE INDEX IF NOT EXISTS idx_promociones_sucursal_public
  ON public.promociones_sucursal (id_sucursal, visible_publico, destacada, orden_visual, vigencia_desde, vigencia_hasta, id_promocion);

COMMIT;
