-- Microfase 2A - nucleo transaccional de citas.
-- Esta migracion fue aplicada manualmente en Supabase antes de versionarse.

ALTER TABLE public.citas_grupos
  ADD COLUMN IF NOT EXISTS codigo_reserva text,
  ADD COLUMN IF NOT EXISTS id_usuario_titular uuid,
  ADD COLUMN IF NOT EXISTS origen_codigo text NOT NULL DEFAULT 'publico',
  ADD COLUMN IF NOT EXISTS total_hnl numeric NOT NULL DEFAULT 0;

UPDATE public.citas_grupos
SET codigo_reserva = upper(substr(replace(id_grupo_cita::text, '-', ''), 1, 10))
WHERE codigo_reserva IS NULL;

ALTER TABLE public.citas_grupos
  ALTER COLUMN codigo_reserva SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_grupos_usuario_titular'
      AND conrelid = 'public.citas_grupos'::regclass
  ) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT fk_citas_grupos_usuario_titular
      FOREIGN KEY (id_usuario_titular)
      REFERENCES public.usuarios(id_usuario)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_grupos_origen_codigo'
      AND conrelid = 'public.citas_grupos'::regclass
  ) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT ck_citas_grupos_origen_codigo
      CHECK (origen_codigo = ANY (ARRAY[
        'publico',
        'cliente_autenticado',
        'admin',
        'barbero',
        'legacy',
        'sistema',
        'panel'
      ]));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_grupos_total_hnl_non_negative'
      AND conrelid = 'public.citas_grupos'::regclass
  ) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT ck_citas_grupos_total_hnl_non_negative
      CHECK (total_hnl >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_citas_grupos_codigo_reserva'
      AND conrelid = 'public.citas_grupos'::regclass
  ) THEN
    ALTER TABLE public.citas_grupos
      ADD CONSTRAINT uq_citas_grupos_codigo_reserva
      UNIQUE (codigo_reserva);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_grupos_codigo_reserva
  ON public.citas_grupos (codigo_reserva);

CREATE INDEX IF NOT EXISTS idx_citas_grupos_usuario_titular
  ON public.citas_grupos (id_usuario_titular)
  WHERE id_usuario_titular IS NOT NULL;

ALTER TABLE public.citas_detalles
  ADD COLUMN IF NOT EXISTS origen_item_codigo text NOT NULL DEFAULT 'servicio_manual',
  ADD COLUMN IF NOT EXISTS nombre_servicio_snapshot text,
  ADD COLUMN IF NOT EXISTS precio_referencia_hnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_hnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_porcentaje numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS isv_hnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_linea_hnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS id_tarifa uuid;

UPDATE public.citas_detalles cd
SET nombre_servicio_snapshot = COALESCE(NULLIF(cd.nombre_servicio_snapshot, ''), s.nombre_servicio),
    precio_referencia_hnl = COALESCE(cd.precio_referencia_hnl, cd.precio_unitario_hnl, 0),
    total_linea_hnl = GREATEST(0, round((COALESCE(cd.subtotal_hnl, 0) - COALESCE(cd.descuento_hnl, 0) + COALESCE(cd.isv_hnl, 0)), 2))
FROM public.servicios s
WHERE s.id_servicio = cd.id_servicio
  AND (cd.nombre_servicio_snapshot IS NULL OR cd.nombre_servicio_snapshot = '' OR cd.total_linea_hnl = 0);

ALTER TABLE public.citas_detalles
  ALTER COLUMN nombre_servicio_snapshot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_citas_detalles_tarifa'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT fk_citas_detalles_tarifa
      FOREIGN KEY (id_tarifa)
      REFERENCES public.servicios_tarifas(id_tarifa)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_detalles_origen_item'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT ck_citas_detalles_origen_item
      CHECK (origen_item_codigo = ANY (ARRAY[
        'servicio_manual',
        'servicio_extra',
        'paquete_incluido',
        'plan_incluido',
        'recompensa_masterpuntos'
      ]));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_detalles_montos_normalizados_non_negative'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT ck_citas_detalles_montos_normalizados_non_negative
      CHECK (
        precio_referencia_hnl >= 0
        AND descuento_hnl >= 0
        AND isv_porcentaje >= 0
        AND isv_hnl >= 0
        AND total_linea_hnl >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_detalles_total_linea_formula'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    ALTER TABLE public.citas_detalles
      ADD CONSTRAINT ck_citas_detalles_total_linea_formula
      CHECK (total_linea_hnl = GREATEST(0, round((subtotal_hnl - descuento_hnl + isv_hnl), 2)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_citas_detalles_id_tarifa
  ON public.citas_detalles (id_tarifa)
  WHERE id_tarifa IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_citas_detalles_origen_item
  ON public.citas_detalles (origen_item_codigo);

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS id_grupo_cita uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_payment_intents_grupo_cita'
      AND conrelid = 'public.payment_intents'::regclass
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT fk_payment_intents_grupo_cita
      FOREIGN KEY (id_grupo_cita)
      REFERENCES public.citas_grupos(id_grupo_cita)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_intents_id_grupo_cita
  ON public.payment_intents (id_grupo_cita)
  WHERE id_grupo_cita IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_servicios_tarifas_resolucion_fecha
  ON public.servicios_tarifas (
    id_sucursal,
    id_servicio,
    id_empleado,
    vigente_desde DESC,
    vigente_hasta,
    updated_at DESC
  )
  WHERE deleted_at IS NULL
    AND activo IS TRUE;
