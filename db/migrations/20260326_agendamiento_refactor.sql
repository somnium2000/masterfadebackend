BEGIN;

-- Alinear esquema para flujo público agrupado y holds sin usuario autenticado
CREATE TABLE IF NOT EXISTS public.citas_grupos (
  id_grupo_cita uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sucursal uuid NOT NULL,
  id_persona_titular uuid NOT NULL,
  id_cliente_titular uuid,
  estado_grupo_codigo text NOT NULL DEFAULT 'activo',
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_citas_grupos_estado CHECK (estado_grupo_codigo IN ('activo', 'cancelado', 'completado')),
  CONSTRAINT fk_citas_grupos_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_citas_grupos_persona_titular FOREIGN KEY (id_persona_titular) REFERENCES public.personas(id_persona) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_citas_grupos_cliente_titular FOREIGN KEY (id_cliente_titular) REFERENCES public.clientes(id_cliente) ON UPDATE CASCADE ON DELETE SET NULL
);

ALTER TABLE public.citas
  ADD COLUMN IF NOT EXISTS id_grupo_cita uuid,
  ADD COLUMN IF NOT EXISTS orden_integrante integer,
  ADD COLUMN IF NOT EXISTS alias_integrante text;

ALTER TABLE public.citas
  ALTER COLUMN creada_por_usuario_id DROP NOT NULL;

ALTER TABLE public.citas_holds
  ALTER COLUMN id_usuario DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_grupo'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT fk_citas_grupo
      FOREIGN KEY (id_grupo_cita)
      REFERENCES public.citas_grupos(id_grupo_cita)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_citas_grupo_orden'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT uq_citas_grupo_orden
      UNIQUE (id_grupo_cita, orden_integrante);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_orden_integrante_pos'
      AND conrelid = 'public.citas'::regclass
  ) THEN
    ALTER TABLE public.citas
      ADD CONSTRAINT ck_citas_orden_integrante_pos
      CHECK (orden_integrante IS NULL OR orden_integrante > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_id_grupo_cita ON public.citas (id_grupo_cita);
CREATE INDEX IF NOT EXISTS idx_citas_grupos_sucursal ON public.citas_grupos (id_sucursal);
CREATE INDEX IF NOT EXISTS idx_citas_grupos_estado ON public.citas_grupos (estado_grupo_codigo);
CREATE INDEX IF NOT EXISTS idx_citas_operativas_scope ON public.citas (id_sucursal, estado_cita_codigo, inicio_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_citas_barbero_fecha_scope ON public.citas (id_empleado_barbero, inicio_at) WHERE deleted_at IS NULL;

-- Trazabilidad de reagendación de emergencia
CREATE TABLE IF NOT EXISTS public.citas_reagendaciones (
  id_reagendacion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita uuid NOT NULL,
  id_sucursal uuid NOT NULL,
  id_empleado_barbero_anterior uuid NOT NULL,
  id_empleado_barbero_nuevo uuid NOT NULL,
  inicio_at_anterior timestamptz NOT NULL,
  fin_at_anterior timestamptz NOT NULL,
  inicio_at_nuevo timestamptz NOT NULL,
  fin_at_nuevo timestamptz NOT NULL,
  motivo text,
  tipo_reagendacion_codigo text NOT NULL DEFAULT 'emergencia',
  id_usuario_accion uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_citas_reag_fin_anterior CHECK (fin_at_anterior > inicio_at_anterior),
  CONSTRAINT ck_citas_reag_fin_nuevo CHECK (fin_at_nuevo > inicio_at_nuevo),
  CONSTRAINT ck_citas_reag_tipo CHECK (tipo_reagendacion_codigo IN ('emergencia', 'administrativa')),
  CONSTRAINT fk_citas_reag_cita FOREIGN KEY (id_cita) REFERENCES public.citas(id_cita) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_citas_reag_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_citas_reag_barbero_anterior FOREIGN KEY (id_empleado_barbero_anterior) REFERENCES public.empleados(id_empleado) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_citas_reag_barbero_nuevo FOREIGN KEY (id_empleado_barbero_nuevo) REFERENCES public.empleados(id_empleado) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_citas_reag_usuario FOREIGN KEY (id_usuario_accion) REFERENCES public.usuarios(id_usuario) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_citas_reagendaciones_cita ON public.citas_reagendaciones (id_cita);
CREATE INDEX IF NOT EXISTS idx_citas_reagendaciones_sucursal ON public.citas_reagendaciones (id_sucursal, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_citas_reagendaciones_barbero_nuevo ON public.citas_reagendaciones (id_empleado_barbero_nuevo, inicio_at_nuevo);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_set_updated_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_citas_grupos'
      AND tgrelid = 'public.citas_grupos'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_citas_grupos
      BEFORE UPDATE ON public.citas_grupos
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
    WHERE tgname = 'tr_set_updated_at_citas_reagendaciones'
      AND tgrelid = 'public.citas_reagendaciones'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_citas_reagendaciones
      BEFORE UPDATE ON public.citas_reagendaciones
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

COMMIT;
