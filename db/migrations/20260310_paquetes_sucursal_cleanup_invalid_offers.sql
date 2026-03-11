-- AM: Limpieza puntual de ofertas de paquetes por sucursal que no son operativas.
-- AM: Evita mostrar en sucursales paquetes "heredados" que no tienen servicios tarifados en esa sede.
BEGIN;

WITH invalid_offers AS (
  SELECT
    ps.id_paquete_sucursal
  FROM public.paquetes_sucursal ps
  JOIN public.paquetes p
    ON p.id_paquete = ps.id_paquete
   AND p.deleted_at IS NULL
  LEFT JOIN public.paquetes_detalles pd
    ON pd.id_paquete = ps.id_paquete
  LEFT JOIN public.servicios s
    ON s.id_servicio = pd.id_servicio
   AND s.deleted_at IS NULL
   AND s.activo IS TRUE
  LEFT JOIN LATERAL (
    SELECT 1 AS has_tarifa
    FROM public.servicios_tarifas st
    WHERE st.id_servicio = pd.id_servicio
      AND st.id_sucursal = ps.id_sucursal
      AND st.id_empleado IS NULL
      AND st.deleted_at IS NULL
      AND st.activo IS TRUE
      AND st.vigente_desde <= CURRENT_DATE
      AND (st.vigente_hasta IS NULL OR st.vigente_hasta >= CURRENT_DATE)
    ORDER BY st.vigente_desde DESC, st.updated_at DESC, st.id_tarifa DESC
    LIMIT 1
  ) tariff_scope ON TRUE
  GROUP BY ps.id_paquete_sucursal
  HAVING COUNT(pd.id_servicio) = 0
      OR COUNT(s.id_servicio) <> COUNT(pd.id_servicio)
      OR COUNT(tariff_scope.has_tarifa) <> COUNT(pd.id_servicio)
)
DELETE FROM public.paquetes_sucursal ps
USING invalid_offers io
WHERE io.id_paquete_sucursal = ps.id_paquete_sucursal;

COMMIT;
