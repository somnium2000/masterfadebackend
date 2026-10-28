-- AM: Migracion exclusivamente LOCAL; revisar y autorizar antes de aplicar en otro ambiente.
BEGIN;
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE FUNCTION app_private.guard_sucursal_active_dependency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  next_active boolean;
  previous_active boolean := false;
  branch_active boolean;
BEGIN
  IF TG_TABLE_NAME = 'empleados' THEN
    next_active := COALESCE(NEW.estado, TRUE) AND NEW.deleted_at IS NULL;
    IF TG_OP = 'UPDATE' THEN
      previous_active := COALESCE(OLD.estado, TRUE) AND OLD.deleted_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'roles_usuarios' THEN
    next_active := NEW.activo IS TRUE;
    IF TG_OP = 'UPDATE' THEN previous_active := OLD.activo IS TRUE; END IF;
  ELSIF TG_TABLE_NAME = 'servicios_tarifas' THEN
    next_active := COALESCE(NEW.activo, TRUE) AND NEW.deleted_at IS NULL;
    IF TG_OP = 'UPDATE' THEN
      previous_active := COALESCE(OLD.activo, TRUE) AND OLD.deleted_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'citas' THEN
    next_active := NEW.deleted_at IS NULL
      AND NEW.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
      AND NEW.inicio_at >= NOW();
    IF TG_OP = 'UPDATE' THEN
      previous_active := OLD.deleted_at IS NULL
        AND OLD.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
        AND OLD.inicio_at >= NOW();
    END IF;
  ELSE
    RAISE EXCEPTION 'Guard de sucursal aplicado a una dependencia no soportada';
  END IF;

  -- AM: No altera roles globales, cancelaciones ni registros fuera del contrato de dependencia activa.
  IF next_active IS NOT TRUE OR NEW.id_sucursal IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF previous_active IS TRUE AND OLD.id_sucursal IS NOT DISTINCT FROM NEW.id_sucursal THEN
      RETURN NEW;
    END IF;
  END IF;

  -- AM: No usar KEY SHARE: SHARE tambien coordina con UPDATE de estado y se conserva hasta COMMIT.
  SELECT COALESCE(s.estado, TRUE) AND s.deleted_at IS NULL
    INTO branch_active
    FROM public.sucursales s
    WHERE s.id_sucursal = NEW.id_sucursal
    FOR SHARE;

  IF NOT FOUND OR branch_active IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'La sucursal no esta activa para esta operacion',
      CONSTRAINT = 'sucursal_active_dependency_guard';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION app_private.guard_sucursal_active_dependency() FROM PUBLIC;

CREATE TRIGGER empleados_sucursal_active_guard
BEFORE INSERT OR UPDATE OF id_sucursal, estado, deleted_at ON public.empleados
FOR EACH ROW EXECUTE FUNCTION app_private.guard_sucursal_active_dependency();

CREATE TRIGGER roles_usuarios_sucursal_active_guard
BEFORE INSERT OR UPDATE OF id_sucursal, activo ON public.roles_usuarios
FOR EACH ROW EXECUTE FUNCTION app_private.guard_sucursal_active_dependency();

CREATE TRIGGER servicios_tarifas_sucursal_active_guard
BEFORE INSERT OR UPDATE OF id_sucursal, activo, deleted_at ON public.servicios_tarifas
FOR EACH ROW EXECUTE FUNCTION app_private.guard_sucursal_active_dependency();

CREATE TRIGGER citas_sucursal_active_guard
BEFORE INSERT OR UPDATE OF id_sucursal, estado_cita_codigo, inicio_at, deleted_at ON public.citas
FOR EACH ROW EXECUTE FUNCTION app_private.guard_sucursal_active_dependency();
COMMIT;

-- AM: Rollback manual autorizado, si se retira esta proteccion (no borra registros):
-- BEGIN;
-- DROP TRIGGER empleados_sucursal_active_guard ON public.empleados;
-- DROP TRIGGER roles_usuarios_sucursal_active_guard ON public.roles_usuarios;
-- DROP TRIGGER servicios_tarifas_sucursal_active_guard ON public.servicios_tarifas;
-- DROP TRIGGER citas_sucursal_active_guard ON public.citas;
-- DROP FUNCTION app_private.guard_sucursal_active_dependency();
-- COMMIT;
