BEGIN;

ALTER TABLE public.citas
  ADD COLUMN IF NOT EXISTS selection_type text NOT NULL DEFAULT 'services',
  ADD COLUMN IF NOT EXISTS id_paquete uuid,
  ADD COLUMN IF NOT EXISTS atencion_iniciada_at timestamptz,
  ADD COLUMN IF NOT EXISTS atencion_finalizada_at timestamptz,
  ADD COLUMN IF NOT EXISTS retraso_inicio_min integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_selection_type'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT ck_citas_selection_type
      CHECK (selection_type IN ('services', 'package'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_retraso_inicio_min_non_negative'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT ck_citas_retraso_inicio_min_non_negative
      CHECK (retraso_inicio_min >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_paquete'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT fk_citas_paquete
      FOREIGN KEY (id_paquete)
      REFERENCES public.paquetes(id_paquete)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.citas_reagendaciones
  ADD COLUMN IF NOT EXISTS id_cita_causante uuid,
  ADD COLUMN IF NOT EXISTS id_lote_reagendacion uuid,
  ADD COLUMN IF NOT EXISTS retraso_min integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_reag_tipo'
      AND conrelid = 'public.citas_reagendaciones'::regclass
  ) THEN
    ALTER TABLE public.citas_reagendaciones
      DROP CONSTRAINT ck_citas_reag_tipo;
  END IF;

  ALTER TABLE public.citas_reagendaciones
    ADD CONSTRAINT ck_citas_reag_tipo
    CHECK (tipo_reagendacion_codigo IN ('emergencia', 'administrativa', 'retraso_operativo'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_reag_cita_causante'
      AND conrelid = 'public.citas_reagendaciones'::regclass
  ) THEN
    ALTER TABLE public.citas_reagendaciones
      ADD CONSTRAINT fk_citas_reag_cita_causante
      FOREIGN KEY (id_cita_causante)
      REFERENCES public.citas(id_cita)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_reag_retraso_min_non_negative'
      AND conrelid = 'public.citas_reagendaciones'::regclass
  ) THEN
    ALTER TABLE public.citas_reagendaciones
      ADD CONSTRAINT ck_citas_reag_retraso_min_non_negative
      CHECK (retraso_min IS NULL OR retraso_min >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_attention_state
  ON public.citas (id_empleado_barbero, estado_cita_codigo, inicio_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_citas_reag_lote
  ON public.citas_reagendaciones (id_lote_reagendacion, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_citas_reag_causante
  ON public.citas_reagendaciones (id_cita_causante, created_at DESC);

COMMIT;
