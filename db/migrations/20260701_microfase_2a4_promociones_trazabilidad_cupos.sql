BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pg_advisory_xact_lock(hashtextextended('mf_microfase_2a4_promociones_trazabilidad_cupos', 0));

ALTER TABLE IF EXISTS public.citas_promociones
  ADD COLUMN IF NOT EXISTS id_promocion_sucursal uuid NULL,
  ADD COLUMN IF NOT EXISTS id_promocion_codigo uuid NULL,
  ADD COLUMN IF NOT EXISTS codigo_promocional_snapshot text NULL;

ALTER TABLE IF EXISTS public.promociones_usos
  ADD COLUMN IF NOT EXISTS id_promocion_codigo uuid NULL,
  ADD COLUMN IF NOT EXISTS id_empleado_barbero uuid NULL;

DO $$
BEGIN
  IF to_regclass('public.citas_promociones') IS NOT NULL
     AND to_regclass('public.promociones_sucursal') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'fk_citas_promociones_promocion_sucursal'
         AND conrelid = 'public.citas_promociones'::regclass
     ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT fk_citas_promociones_promocion_sucursal
      FOREIGN KEY (id_promocion_sucursal)
      REFERENCES public.promociones_sucursal(id_promocion_sucursal)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.citas_promociones') IS NOT NULL
     AND to_regclass('public.promociones_codigos') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'fk_citas_promociones_promocion_codigo'
         AND conrelid = 'public.citas_promociones'::regclass
     ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT fk_citas_promociones_promocion_codigo
      FOREIGN KEY (id_promocion_codigo)
      REFERENCES public.promociones_codigos(id_promocion_codigo)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.promociones_codigos') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'fk_promociones_usos_promocion_codigo'
         AND conrelid = 'public.promociones_usos'::regclass
     ) THEN
    ALTER TABLE public.promociones_usos
      ADD CONSTRAINT fk_promociones_usos_promocion_codigo
      FOREIGN KEY (id_promocion_codigo)
      REFERENCES public.promociones_codigos(id_promocion_codigo)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.empleados') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'fk_promociones_usos_empleado_barbero'
         AND conrelid = 'public.promociones_usos'::regclass
     ) THEN
    ALTER TABLE public.promociones_usos
      ADD CONSTRAINT fk_promociones_usos_empleado_barbero
      FOREIGN KEY (id_empleado_barbero)
      REFERENCES public.empleados(id_empleado)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_codigo
  ON public.citas_promociones (id_promocion_codigo)
  WHERE id_promocion_codigo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_sucursal
  ON public.citas_promociones (id_promocion_sucursal)
  WHERE id_promocion_sucursal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_usos_codigo
  ON public.promociones_usos (id_promocion_codigo)
  WHERE id_promocion_codigo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_usos_barbero_periodo
  ON public.promociones_usos (
    id_promocion_regla,
    id_promocion_sucursal,
    id_empleado_barbero,
    fecha_operativa,
    estado_uso_codigo
  )
  WHERE estado_uso_codigo IN ('reservado', 'consumido');

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_usos_activo_cita_promocion
  ON public.promociones_usos (id_cita_promocion)
  WHERE estado_uso_codigo IN ('reservado', 'consumido');

DO $$
BEGIN
  IF to_regclass('public.citas_promociones') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'citas_promociones'
         AND column_name = 'id_promocion_codigo'
     ) THEN
    RAISE EXCEPTION 'MF2A4_CITAS_PROMOCIONES_CODIGO_MISSING';
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'promociones_usos'
         AND column_name = 'id_empleado_barbero'
     ) THEN
    RAISE EXCEPTION 'MF2A4_PROMOCIONES_USOS_BARBERO_MISSING';
  END IF;
END $$;

COMMIT;
