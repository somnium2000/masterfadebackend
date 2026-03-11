-- AM: Fase PLANES - capa operativa multi-sucursal para catalogo administrativo/publico.
BEGIN;

ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS descripcion text;

-- AM: Nombre unico de plan (case-insensitive) para evitar duplicados comerciales.
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_plans_nombre_ci
  ON public.membership_plans (LOWER(TRIM(nombre_plan)));

-- AM: Oferta operativa por sucursal para planes (precio, estado, visibilidad y orden visual).
CREATE TABLE IF NOT EXISTS public.membership_plans_sucursal (
  id_plan_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_plan uuid NOT NULL,
  id_sucursal uuid NOT NULL,
  precio_hnl numeric(10,2),
  activo boolean NOT NULL DEFAULT TRUE,
  visible_publico boolean NOT NULL DEFAULT TRUE,
  orden_visual integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_mps_precio_hnl CHECK (precio_hnl IS NULL OR precio_hnl >= 0),
  CONSTRAINT ck_mps_orden_visual CHECK (orden_visual >= 0),
  CONSTRAINT fk_mps_plan FOREIGN KEY (id_plan) REFERENCES public.membership_plans(id_plan),
  CONSTRAINT fk_mps_sucursal FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mps_scope
  ON public.membership_plans_sucursal (id_plan, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_mps_branch
  ON public.membership_plans_sucursal (id_sucursal, activo, visible_publico, orden_visual, id_plan);

CREATE INDEX IF NOT EXISTS idx_mps_plan
  ON public.membership_plans_sucursal (id_plan, id_sucursal);

-- AM: Backfill para no romper planes ya existentes; replica oferta base a sucursales activas.
INSERT INTO public.membership_plans_sucursal (
  id_plan,
  id_sucursal,
  precio_hnl,
  activo,
  visible_publico,
  orden_visual,
  created_at,
  updated_at
)
SELECT
  mp.id_plan,
  s.id_sucursal,
  mp.precio_hnl,
  COALESCE(mp.activo, TRUE),
  TRUE,
  100,
  NOW(),
  NOW()
FROM public.membership_plans mp
JOIN public.sucursales s
  ON s.deleted_at IS NULL
 AND s.estado IS TRUE
ON CONFLICT (id_plan, id_sucursal)
DO UPDATE SET
  precio_hnl = EXCLUDED.precio_hnl,
  activo = EXCLUDED.activo,
  updated_at = NOW();

COMMIT;
