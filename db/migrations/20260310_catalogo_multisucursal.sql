-- AM: Fase multi-sucursal catalogo (servicios + paquetes) con cambios minimos y compatibles.
BEGIN;

-- AM: Permite que cada sucursal tenga duracion y buffer operativo propios por servicio.
ALTER TABLE public.servicios_tarifas
  ADD COLUMN IF NOT EXISTS duracion_min integer,
  ADD COLUMN IF NOT EXISTS buffer_min integer;

-- AM: Backfill defensivo desde el servicio base para no dejar nulos en registros actuales de sucursal.
UPDATE public.servicios_tarifas st
SET
  duracion_min = COALESCE(st.duracion_min, s.duracion_min),
  buffer_min = COALESCE(st.buffer_min, s.buffer_min, 0)
FROM public.servicios s
WHERE s.id_servicio = st.id_servicio
  AND st.id_empleado IS NULL
  AND (st.duracion_min IS NULL OR st.buffer_min IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_servicios_tarifas_duracion_min'
      AND conrelid = 'public.servicios_tarifas'::regclass
  ) THEN
    ALTER TABLE public.servicios_tarifas
      ADD CONSTRAINT ck_servicios_tarifas_duracion_min
      CHECK (duracion_min IS NULL OR duracion_min > 0);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_servicios_tarifas_buffer_min'
      AND conrelid = 'public.servicios_tarifas'::regclass
  ) THEN
    ALTER TABLE public.servicios_tarifas
      ADD CONSTRAINT ck_servicios_tarifas_buffer_min
      CHECK (buffer_min IS NULL OR buffer_min >= 0);
  END IF;
END
$$;

-- AM: Oferta comercial por sucursal para paquetes (precio/estado/visibilidad por sucursal).
CREATE TABLE IF NOT EXISTS public.paquetes_sucursal (
  id_paquete_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_paquete uuid NOT NULL,
  id_sucursal uuid NOT NULL,
  precio_hnl numeric(10,2),
  activo boolean NOT NULL DEFAULT TRUE,
  visible_publico boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_paquetes_sucursal_precio_hnl CHECK (precio_hnl IS NULL OR precio_hnl >= 0),
  CONSTRAINT fk_paquetes_sucursal_paquete FOREIGN KEY (id_paquete) REFERENCES public.paquetes(id_paquete),
  CONSTRAINT fk_paquetes_sucursal_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_paquetes_sucursal_scope
  ON public.paquetes_sucursal (id_paquete, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_paquetes_sucursal_branch
  ON public.paquetes_sucursal (id_sucursal, activo, visible_publico, id_paquete);

CREATE INDEX IF NOT EXISTS idx_paquetes_sucursal_package
  ON public.paquetes_sucursal (id_paquete, id_sucursal);

-- AM: Backfill inicial para no romper paquetes existentes; replica la oferta actual a sucursales activas.
INSERT INTO public.paquetes_sucursal (
  id_paquete,
  id_sucursal,
  precio_hnl,
  activo,
  visible_publico,
  created_at,
  updated_at
)
SELECT
  p.id_paquete,
  s.id_sucursal,
  NULLIF(to_jsonb(p)->>'precio_hnl', '')::numeric,
  COALESCE(p.activo, TRUE),
  COALESCE(p.activo, TRUE),
  NOW(),
  NOW()
FROM public.paquetes p
JOIN public.sucursales s
  ON s.deleted_at IS NULL
 AND s.estado IS TRUE
WHERE p.deleted_at IS NULL
ON CONFLICT (id_paquete, id_sucursal)
DO UPDATE SET
  precio_hnl = EXCLUDED.precio_hnl,
  activo = EXCLUDED.activo,
  updated_at = NOW();

COMMIT;
