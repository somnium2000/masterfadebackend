-- AM: Migracion manual LOCAL. Aplicar antes del backend; no reconstruir roles historicos.
BEGIN;
ALTER TABLE public.empleados
  ADD COLUMN roles_reactivacion jsonb,
  ADD CONSTRAINT empleados_roles_reactivacion_array
    CHECK (roles_reactivacion IS NULL OR jsonb_typeof(roles_reactivacion) = 'array');
COMMENT ON COLUMN public.empleados.roles_reactivacion IS
  'Asignaciones vigentes suspendidas por ciclo de vida. NULL exige revision administrativa explicita; nunca inferir del historial.';
COMMIT;
-- AM: Rollback manual (solo tras retirar el backend que utiliza la columna):
-- ALTER TABLE public.empleados DROP COLUMN roles_reactivacion;
