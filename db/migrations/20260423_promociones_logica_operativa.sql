BEGIN;

/* // JK: Extiende promociones con metadatos operativos sin reemplazar la estructura editorial existente. */
ALTER TABLE public.promociones
  ADD COLUMN IF NOT EXISTS tipo_promocion text,
  ADD COLUMN IF NOT EXISTS aplica_a text,
  ADD COLUMN IF NOT EXISTS mecanica text,
  ADD COLUMN IF NOT EXISTS id_servicio_objetivo uuid,
  ADD COLUMN IF NOT EXISTS id_paquete_objetivo uuid,
  ADD COLUMN IF NOT EXISTS valor_descuento numeric(10,2),
  ADD COLUMN IF NOT EXISTS cantidad_requerida integer,
  ADD COLUMN IF NOT EXISTS cantidad_bonificada integer;

/* // JK: Backfill defensivo para garantizar NOT NULL en columnas text sin invalidar datos previos. */
UPDATE public.promociones
SET tipo_promocion = 'descuento_servicio'
WHERE tipo_promocion IS NULL
   OR btrim(tipo_promocion) = ''
   OR tipo_promocion NOT IN ('descuento_servicio', 'descuento_paquete', 'dos_por_uno_servicio');

UPDATE public.promociones
SET aplica_a = 'servicio'
WHERE aplica_a IS NULL
   OR btrim(aplica_a) = ''
   OR aplica_a NOT IN ('servicio', 'paquete');

UPDATE public.promociones
SET mecanica = 'porcentaje'
WHERE mecanica IS NULL
   OR btrim(mecanica) = ''
   OR mecanica NOT IN ('porcentaje', 'monto_fijo', 'dos_por_uno');

/* // JK: Normaliza valores no positivos para evitar basura histórica antes de constraints. */
UPDATE public.promociones
SET valor_descuento = NULL
WHERE valor_descuento IS NOT NULL
  AND valor_descuento <= 0;

UPDATE public.promociones
SET cantidad_requerida = NULL
WHERE cantidad_requerida IS NOT NULL
  AND cantidad_requerida <= 0;

UPDATE public.promociones
SET cantidad_bonificada = NULL
WHERE cantidad_bonificada IS NOT NULL
  AND cantidad_bonificada <= 0;

ALTER TABLE public.promociones
  ALTER COLUMN tipo_promocion SET DEFAULT 'descuento_servicio',
  ALTER COLUMN aplica_a SET DEFAULT 'servicio',
  ALTER COLUMN mecanica SET DEFAULT 'porcentaje';

ALTER TABLE public.promociones
  ALTER COLUMN tipo_promocion SET NOT NULL,
  ALTER COLUMN aplica_a SET NOT NULL,
  ALTER COLUMN mecanica SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_tipo_promocion'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_tipo_promocion
      CHECK (tipo_promocion IN ('descuento_servicio', 'descuento_paquete', 'dos_por_uno_servicio'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_aplica_a'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_aplica_a
      CHECK (aplica_a IN ('servicio', 'paquete'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_mecanica'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_mecanica
      CHECK (mecanica IN ('porcentaje', 'monto_fijo', 'dos_por_uno'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_valor_descuento_positivo'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_valor_descuento_positivo
      CHECK (valor_descuento IS NULL OR valor_descuento > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_valor_descuento_porcentaje'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_valor_descuento_porcentaje
      CHECK (mecanica <> 'porcentaje' OR valor_descuento IS NULL OR valor_descuento <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_cantidad_requerida'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_cantidad_requerida
      CHECK (cantidad_requerida IS NULL OR cantidad_requerida > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_cantidad_bonificada'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_cantidad_bonificada
      CHECK (cantidad_bonificada IS NULL OR cantidad_bonificada > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_promociones_objetivo_exclusivo'
      AND conrelid = 'public.promociones'::regclass
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT ck_promociones_objetivo_exclusivo
      CHECK (NOT (id_servicio_objetivo IS NOT NULL AND id_paquete_objetivo IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_promociones_servicio_objetivo'
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT fk_promociones_servicio_objetivo
      FOREIGN KEY (id_servicio_objetivo)
      REFERENCES public.servicios(id_servicio)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_promociones_paquete_objetivo'
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT fk_promociones_paquete_objetivo
      FOREIGN KEY (id_paquete_objetivo)
      REFERENCES public.paquetes(id_paquete)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_promociones_tipo_aplica
  ON public.promociones (tipo_promocion, aplica_a, mecanica);

CREATE INDEX IF NOT EXISTS idx_promociones_servicio_objetivo
  ON public.promociones (id_servicio_objetivo)
  WHERE id_servicio_objetivo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_paquete_objetivo
  ON public.promociones (id_paquete_objetivo)
  WHERE id_paquete_objetivo IS NOT NULL;

COMMIT;
