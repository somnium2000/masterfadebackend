-- Microfase 1.9A - Guardrails de servicios maestro y tarifas por sucursal.
-- AM: Ejecutar manualmente en Supabase/Postgres. No modifica datos existentes.

-- 1) Validacion previa: duplicados vivos por nombre normalizado.
-- Esperado: 0 filas.
SELECT
  lower(regexp_replace(trim(nombre_servicio), '[^[:alnum:]]+', '', 'g')) AS nombre_normalizado,
  COUNT(*) AS total,
  array_agg(id_servicio ORDER BY nombre_servicio) AS ids_servicio,
  array_agg(nombre_servicio ORDER BY nombre_servicio) AS nombres_servicio
FROM public.servicios
WHERE deleted_at IS NULL
GROUP BY lower(regexp_replace(trim(nombre_servicio), '[^[:alnum:]]+', '', 'g'))
HAVING COUNT(*) > 1;

-- 2) Indice unico de servicios vivos por nombre normalizado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_servicios_nombre_normalizado_vivo
ON public.servicios (
  lower(regexp_replace(trim(nombre_servicio), '[^[:alnum:]]+', '', 'g'))
)
WHERE deleted_at IS NULL;

-- 3) Validacion previa: duplicados de tarifa base actual por servicio/sucursal.
-- Esperado: 0 filas.
SELECT
  id_servicio,
  id_sucursal,
  COUNT(*) AS total,
  array_agg(id_tarifa ORDER BY updated_at DESC, id_tarifa DESC) AS ids_tarifa
FROM public.servicios_tarifas
WHERE deleted_at IS NULL
  AND id_empleado IS NULL
  AND activo IS TRUE
  AND vigente_hasta IS NULL
GROUP BY id_servicio, id_sucursal
HAVING COUNT(*) > 1;

-- 4) Indice unico de tarifa base actual activa por servicio/sucursal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_servicios_tarifas_base_actual_vivo
ON public.servicios_tarifas (id_servicio, id_sucursal)
WHERE deleted_at IS NULL
  AND id_empleado IS NULL
  AND activo IS TRUE
  AND vigente_hasta IS NULL;
