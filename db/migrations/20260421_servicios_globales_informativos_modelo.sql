-- 20260421_servicios_globales_informativos_modelo.sql
-- Objetivo:
-- 1) Consolidar servicios base globales por sucursal (id_empleado IS NULL).
-- 2) Mantener asignacion manual por barbero solo para servicios informativos.
-- 3) Marcar "Corte de Cabello" y "Corte de Cejas" como informativos y no agendables.
--
-- Nota:
-- Esta migracion identifica servicios informativos por nombre normalizado.
-- Si existen variantes de nombre no contempladas, deben ajustarse manualmente por ID.

BEGIN;

-- AM: scope operativo actual tomado desde cualquier tarifa existente por servicio+sucursal.
WITH scope_seed AS (
  SELECT DISTINCT
    st.id_servicio,
    st.id_sucursal
  FROM public.servicios_tarifas st
  WHERE st.id_servicio IS NOT NULL
    AND st.id_sucursal IS NOT NULL
),
latest_scope_tariff AS (
  SELECT DISTINCT ON (st.id_servicio, st.id_sucursal)
    st.id_servicio,
    st.id_sucursal,
    st.precio_hnl,
    st.duracion_min,
    st.buffer_min
  FROM public.servicios_tarifas st
  JOIN scope_seed ss
    ON ss.id_servicio = st.id_servicio
   AND ss.id_sucursal = st.id_sucursal
  WHERE st.deleted_at IS NULL
  ORDER BY
    st.id_servicio,
    st.id_sucursal,
    (CASE WHEN st.id_empleado IS NULL THEN 1 ELSE 2 END) ASC,
    st.activo DESC,
    st.vigente_desde DESC,
    st.updated_at DESC,
    st.id_tarifa DESC
),
target_rows AS (
  SELECT
    lst.id_servicio,
    lst.id_sucursal,
    COALESCE(lst.precio_hnl, 0)::numeric AS precio_hnl,
    COALESCE(lst.duracion_min, s.duracion_min, 1)::int AS duracion_min,
    COALESCE(lst.buffer_min, s.buffer_min, 0)::int AS buffer_min
  FROM latest_scope_tariff lst
  JOIN public.servicios s
    ON s.id_servicio = lst.id_servicio
   AND s.deleted_at IS NULL
   AND s.activo IS TRUE
)
INSERT INTO public.servicios_tarifas (
  id_servicio,
  id_sucursal,
  id_empleado,
  precio_hnl,
  duracion_min,
  buffer_min,
  servicio_informativo,
  vigente_desde,
  activo
)
SELECT
  tr.id_servicio,
  tr.id_sucursal,
  NULL,
  tr.precio_hnl,
  GREATEST(tr.duracion_min, 1),
  GREATEST(tr.buffer_min, 0),
  FALSE,
  CURRENT_DATE,
  TRUE
FROM target_rows tr
WHERE NOT EXISTS (
  SELECT 1
  FROM public.servicios_tarifas existing
  WHERE existing.id_servicio = tr.id_servicio
    AND existing.id_sucursal = tr.id_sucursal
    AND existing.id_empleado IS NULL
    AND existing.deleted_at IS NULL
);

-- AM: Reactiva y normaliza todas las tarifas base (globales) del scope actual.
UPDATE public.servicios_tarifas st
SET
  activo = TRUE,
  deleted_at = NULL,
  vigente_hasta = NULL,
  servicio_informativo = FALSE,
  updated_at = NOW()
WHERE st.id_empleado IS NULL
  AND st.deleted_at IS NULL;

WITH informative_services AS (
  SELECT s.id_servicio
  FROM public.servicios s
  WHERE s.deleted_at IS NULL
    AND UPPER(TRIM(translate(
      s.nombre_servicio,
      'ÁÉÍÓÚáéíóú',
      'AEIOUaeiou'
    ))) IN ('CORTE DE CABELLO', 'CORTE DE CEJAS')
)
UPDATE public.servicios s
SET
  agendable = CASE
    WHEN s.id_servicio IN (SELECT id_servicio FROM informative_services) THEN FALSE
    ELSE TRUE
  END,
  visible_publico = CASE
    WHEN s.id_servicio IN (SELECT id_servicio FROM informative_services) THEN TRUE
    ELSE s.visible_publico
  END,
  updated_at = NOW()
WHERE s.deleted_at IS NULL;

WITH informative_services AS (
  SELECT s.id_servicio
  FROM public.servicios s
  WHERE s.deleted_at IS NULL
    AND UPPER(TRIM(translate(
      s.nombre_servicio,
      'ÁÉÍÓÚáéíóú',
      'AEIOUaeiou'
    ))) IN ('CORTE DE CABELLO', 'CORTE DE CEJAS')
)
UPDATE public.servicios_tarifas st
SET
  servicio_informativo = CASE
    WHEN st.id_servicio IN (SELECT id_servicio FROM informative_services) THEN TRUE
    ELSE FALSE
  END,
  updated_at = NOW()
WHERE st.deleted_at IS NULL;

-- AM: Servicios no informativos dejan de tener asignacion manual por barbero.
WITH informative_services AS (
  SELECT s.id_servicio
  FROM public.servicios s
  WHERE s.deleted_at IS NULL
    AND UPPER(TRIM(translate(
      s.nombre_servicio,
      'ÁÉÍÓÚáéíóú',
      'AEIOUaeiou'
    ))) IN ('CORTE DE CABELLO', 'CORTE DE CEJAS')
)
UPDATE public.servicios_tarifas st
SET
  activo = FALSE,
  deleted_at = COALESCE(st.deleted_at, NOW()),
  vigente_hasta = COALESCE(st.vigente_hasta, CURRENT_DATE),
  updated_at = NOW()
WHERE st.id_empleado IS NOT NULL
  AND st.deleted_at IS NULL
  AND st.id_servicio NOT IN (SELECT id_servicio FROM informative_services);

COMMIT;

