-- Migration para garantizar la unicidad de id_cliente en points_legacy_migrations

-- 1. Eliminar duplicados si los hubiera (dejando solo el último registro por cliente)
DELETE FROM public.points_legacy_migrations a USING (
    SELECT id_cliente, MIN(ctid) as keep_ctid
    FROM public.points_legacy_migrations 
    GROUP BY id_cliente HAVING COUNT(*) > 1
) b
WHERE a.id_cliente = b.id_cliente 
AND a.ctid <> b.keep_ctid;

-- 2. Añadir la restricción UNIQUE a id_cliente
ALTER TABLE public.points_legacy_migrations
DROP CONSTRAINT IF EXISTS unique_cliente_legacy_migration;

ALTER TABLE public.points_legacy_migrations
ADD CONSTRAINT unique_cliente_legacy_migration UNIQUE (id_cliente);
