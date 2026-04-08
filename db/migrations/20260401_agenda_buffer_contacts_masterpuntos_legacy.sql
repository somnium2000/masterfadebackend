BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parametros_sistema'
      AND column_name = 'created_at'
  ) THEN
    INSERT INTO public.parametros_sistema (
      clave,
      valor_numero,
      descripcion,
      created_at,
      updated_at
    )
    VALUES (
      'agenda_buffer_global_min',
      0,
      'Buffer global en minutos aplicado entre citas',
      now(),
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_numero = COALESCE(public.parametros_sistema.valor_numero, EXCLUDED.valor_numero),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  ELSE
    INSERT INTO public.parametros_sistema (
      clave,
      valor_numero,
      descripcion,
      updated_at
    )
    VALUES (
      'agenda_buffer_global_min',
      0,
      'Buffer global en minutos aplicado entre citas',
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_numero = COALESCE(public.parametros_sistema.valor_numero, EXCLUDED.valor_numero),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parametros_sistema'
      AND column_name = 'created_at'
  ) THEN
    INSERT INTO public.parametros_sistema (
      clave,
      valor_booleano,
      descripcion,
      created_at,
      updated_at
    )
    VALUES (
      'masterpuntos_migracion_manual_habilitada',
      FALSE,
      'Habilita la migracion manual unica de puntos legacy por cliente',
      now(),
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_booleano = COALESCE(public.parametros_sistema.valor_booleano, EXCLUDED.valor_booleano),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  ELSE
    INSERT INTO public.parametros_sistema (
      clave,
      valor_booleano,
      descripcion,
      updated_at
    )
    VALUES (
      'masterpuntos_migracion_manual_habilitada',
      FALSE,
      'Habilita la migracion manual unica de puntos legacy por cliente',
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_booleano = COALESCE(public.parametros_sistema.valor_booleano, EXCLUDED.valor_booleano),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  END IF;
END $$;

ALTER TABLE public.citas
  ADD COLUMN IF NOT EXISTS contacto_nombre text,
  ADD COLUMN IF NOT EXISTS contacto_email text,
  ADD COLUMN IF NOT EXISTS contacto_telefono text;

CREATE TABLE IF NOT EXISTS public.points_legacy_migrations (
  id_migracion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cliente uuid NOT NULL,
  id_points_tx uuid NOT NULL,
  puntos_migrados integer NOT NULL,
  motivo text,
  creado_por_usuario_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_points_legacy_migrations_cliente UNIQUE (id_cliente),
  CONSTRAINT ck_points_legacy_migrations_puntos CHECK (puntos_migrados > 0),
  CONSTRAINT fk_points_legacy_migrations_cliente FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_points_legacy_migrations_tx FOREIGN KEY (id_points_tx) REFERENCES public.points_transactions(id_points_tx) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_points_legacy_migrations_usuario FOREIGN KEY (creado_por_usuario_id) REFERENCES public.usuarios(id_usuario) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_points_legacy_migrations_created_at
  ON public.points_legacy_migrations (created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_set_updated_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_points_legacy_migrations'
      AND tgrelid = 'public.points_legacy_migrations'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_points_legacy_migrations
      BEFORE UPDATE ON public.points_legacy_migrations
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

COMMIT;
