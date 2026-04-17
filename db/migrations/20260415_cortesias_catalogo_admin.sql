BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.cortesias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  descripcion text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cortesias_nombre_not_blank CHECK (length(trim(nombre)) > 0),
  CONSTRAINT ck_cortesias_nombre_len CHECK (length(trim(nombre)) <= 140),
  CONSTRAINT ck_cortesias_descripcion_len CHECK (descripcion IS NULL OR length(trim(descripcion)) <= 500)
);

CREATE TABLE IF NOT EXISTS public.cortesias_sucursales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cortesia_id uuid NOT NULL,
  id_sucursal uuid NOT NULL,
  activa boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_cortesias_sucursales_cortesia FOREIGN KEY (cortesia_id) REFERENCES public.cortesias(id),
  CONSTRAINT fk_cortesias_sucursales_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cortesias_sucursales_scope
  ON public.cortesias_sucursales (cortesia_id, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_cortesias_nombre
  ON public.cortesias (nombre);

CREATE INDEX IF NOT EXISTS idx_cortesias_nombre_ci
  ON public.cortesias (LOWER(TRIM(nombre)));

CREATE INDEX IF NOT EXISTS idx_cortesias_sucursales_cortesia
  ON public.cortesias_sucursales (cortesia_id);

CREATE INDEX IF NOT EXISTS idx_cortesias_sucursales_sucursal
  ON public.cortesias_sucursales (id_sucursal);

CREATE INDEX IF NOT EXISTS idx_cortesias_sucursales_activa
  ON public.cortesias_sucursales (activa);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_set_updated_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_cortesias'
      AND tgrelid = 'public.cortesias'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_cortesias
      BEFORE UPDATE ON public.cortesias
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_set_updated_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_cortesias_sucursales'
      AND tgrelid = 'public.cortesias_sucursales'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_cortesias_sucursales
      BEFORE UPDATE ON public.cortesias_sucursales
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

COMMIT;

