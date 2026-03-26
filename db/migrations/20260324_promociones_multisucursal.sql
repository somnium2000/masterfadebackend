CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- AM: Tabla base de promociones (contenido editorial global).
CREATE TABLE IF NOT EXISTS public.promociones (
  id_promocion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  titulo text NOT NULL,
  subtitulo text,
  parrafos jsonb NOT NULL DEFAULT '[]'::jsonb,
  imagen_principal_url text,
  imagen_mobile_url text,
  imagen_alt text,
  cta_texto text,
  cta_url text,
  cta_tipo text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- AM: Hardening para instalaciones donde la tabla ya existia con esquema parcial.
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS titulo text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS subtitulo text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS parrafos jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS imagen_principal_url text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS imagen_mobile_url text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS imagen_alt text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS cta_texto text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS cta_url text;
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS cta_tipo text DEFAULT 'none';
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.promociones ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

UPDATE public.promociones
SET parrafos = '[]'::jsonb
WHERE parrafos IS NULL OR jsonb_typeof(parrafos) <> 'array';

UPDATE public.promociones
SET cta_tipo = 'none'
WHERE cta_tipo IS NULL OR btrim(cta_tipo) = '';

UPDATE public.promociones
SET cta_texto = NULLIF(btrim(cta_texto), ''),
    cta_url = NULLIF(btrim(cta_url), '')
WHERE cta_texto IS NOT NULL
   OR cta_url IS NOT NULL;

UPDATE public.promociones
SET cta_texto = NULL,
    cta_url = NULL
WHERE cta_tipo = 'none'
  AND (cta_texto IS NOT NULL OR cta_url IS NOT NULL);

UPDATE public.promociones
SET cta_tipo = 'none',
    cta_texto = NULL,
    cta_url = NULL
WHERE cta_tipo IN ('interno', 'externo')
  AND (cta_texto IS NULL OR cta_url IS NULL);

UPDATE public.promociones
SET slug = CONCAT('promo-', LEFT(id_promocion::text, 8))
WHERE slug IS NULL OR btrim(slug) = '';

UPDATE public.promociones
SET titulo = CONCAT('Promocion ', LEFT(id_promocion::text, 8))
WHERE titulo IS NULL OR btrim(titulo) = '';

-- AM: Tabla scope por sucursal (estado/publicacion/vigencia/orden).
CREATE TABLE IF NOT EXISTS public.promociones_sucursal (
  id_promocion_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_promocion uuid NOT NULL,
  id_sucursal uuid NOT NULL,
  estado text NOT NULL DEFAULT 'borrador',
  visible_publico boolean NOT NULL DEFAULT FALSE,
  vigencia_desde date,
  vigencia_hasta date,
  orden_visual integer NOT NULL DEFAULT 100,
  destacada boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_promociones_sucursal_promocion FOREIGN KEY (id_promocion) REFERENCES public.promociones(id_promocion),
  CONSTRAINT fk_promociones_sucursal_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal)
);

-- AM: Hardening para instalaciones donde la tabla ya existia con esquema parcial.
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS estado text DEFAULT 'borrador';
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS visible_publico boolean DEFAULT FALSE;
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS vigencia_desde date;
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS vigencia_hasta date;
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS orden_visual integer DEFAULT 100;
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS destacada boolean DEFAULT FALSE;
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.promociones_sucursal ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.promociones_sucursal
SET estado = 'borrador'
WHERE estado IS NULL OR btrim(estado) = '' OR estado NOT IN ('borrador', 'publicada', 'archivada');

UPDATE public.promociones_sucursal
SET visible_publico = FALSE
WHERE visible_publico IS NULL;

UPDATE public.promociones_sucursal
SET orden_visual = 100
WHERE orden_visual IS NULL OR orden_visual < 0;

UPDATE public.promociones_sucursal
SET destacada = FALSE
WHERE destacada IS NULL;

UPDATE public.promociones_sucursal
SET vigencia_hasta = vigencia_desde
WHERE vigencia_desde IS NOT NULL
  AND vigencia_hasta IS NOT NULL
  AND vigencia_hasta < vigencia_desde;

ALTER TABLE public.promociones
  ALTER COLUMN slug SET NOT NULL,
  ALTER COLUMN titulo SET NOT NULL,
  ALTER COLUMN parrafos SET NOT NULL,
  ALTER COLUMN cta_tipo SET NOT NULL;

ALTER TABLE public.promociones_sucursal
  ALTER COLUMN estado SET NOT NULL,
  ALTER COLUMN visible_publico SET NOT NULL,
  ALTER COLUMN orden_visual SET NOT NULL,
  ALTER COLUMN destacada SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_slug_not_blank'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_slug_not_blank
      CHECK (length(btrim(slug)) >= 3);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_cta_consistencia'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_cta_consistencia
      CHECK (
        (
          cta_tipo = 'none'
          AND NULLIF(btrim(COALESCE(cta_texto, '')), '') IS NULL
          AND NULLIF(btrim(COALESCE(cta_url, '')), '') IS NULL
        )
        OR (
          cta_tipo IN ('interno', 'externo')
          AND NULLIF(btrim(COALESCE(cta_texto, '')), '') IS NOT NULL
          AND NULLIF(btrim(COALESCE(cta_url, '')), '') IS NOT NULL
        )
      );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_titulo_not_blank'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_titulo_not_blank
      CHECK (length(btrim(titulo)) >= 3);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_cta_tipo'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_cta_tipo
      CHECK (cta_tipo IN ('interno', 'externo', 'none'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_parrafos_array'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_parrafos_array
      CHECK (
        CASE
          WHEN jsonb_typeof(parrafos) = 'array' THEN jsonb_array_length(parrafos) <= 8
          ELSE FALSE
        END
      );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_sucursal_estado'
      AND conrelid = 'public.promociones_sucursal'::regclass
  ) THEN
    ALTER TABLE public.promociones_sucursal
      ADD CONSTRAINT ck_promociones_sucursal_estado
      CHECK (estado IN ('borrador', 'publicada', 'archivada'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_sucursal_orden_visual'
      AND conrelid = 'public.promociones_sucursal'::regclass
  ) THEN
    ALTER TABLE public.promociones_sucursal
      ADD CONSTRAINT ck_promociones_sucursal_orden_visual
      CHECK (orden_visual >= 0);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_promociones_sucursal_vigencia'
      AND conrelid = 'public.promociones_sucursal'::regclass
  ) THEN
    ALTER TABLE public.promociones_sucursal
      ADD CONSTRAINT ck_promociones_sucursal_vigencia
      CHECK (
        vigencia_hasta IS NULL OR vigencia_desde IS NULL OR vigencia_hasta >= vigencia_desde
      );
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_slug_ci
  ON public.promociones (LOWER(TRIM(slug)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_sucursal_scope
  ON public.promociones_sucursal (id_promocion, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_promociones_titulo
  ON public.promociones (titulo);

CREATE INDEX IF NOT EXISTS idx_promociones_estado_updated
  ON public.promociones (updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_promociones_sucursal_branch
  ON public.promociones_sucursal (id_sucursal, estado, visible_publico, orden_visual, id_promocion);

CREATE INDEX IF NOT EXISTS idx_promociones_sucursal_public
  ON public.promociones_sucursal (id_sucursal, visible_publico, destacada, orden_visual, vigencia_desde, vigencia_hasta, id_promocion);

COMMIT;
