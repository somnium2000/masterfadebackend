-- SOLO PostgreSQL aislado. Requiere fixture + cuerpos originales de las rutinas.
-- Cada ejecución revierte datos/esquema de prueba; se puede ejecutar antes/después.
-- Las políticas reproducen las ramas propietario/administración de citas usando
-- los dos helpers reales; no sustituyen la totalidad de políticas de producción.
BEGIN;

CREATE SCHEMA qa_security02_test;
GRANT USAGE ON SCHEMA qa_security02_test TO anon, authenticated, service_role;

CREATE FUNCTION qa_security02_test.assert_true(ok boolean, description text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'QA-SEGURIDAD-SUPABASE-02 assertion failed: %', description;
  END IF;
END;
$$;

INSERT INTO public.roles (id_rol, nombre) VALUES
  ('99000000-0000-0000-0000-000000000001', 'admin'),
  ('99000000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO public.roles_usuarios (id_rol_usuario, id_rol, id_usuario, id_sucursal, activo) VALUES
  ('99000000-0000-0000-0000-000000000011', '99000000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000021', '99000000-0000-0000-0000-000000000031', true),
  ('99000000-0000-0000-0000-000000000012', '99000000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000022', '99000000-0000-0000-0000-000000000032', true),
  ('99000000-0000-0000-0000-000000000013', '99000000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-000000000023', NULL, true),
  ('99000000-0000-0000-0000-000000000014', '99000000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000024', '99000000-0000-0000-0000-000000000031', false);

CREATE TABLE qa_security02_test.citas (
  id_cita integer PRIMARY KEY,
  id_sucursal uuid NOT NULL,
  creada_por_usuario_id uuid NOT NULL,
  observacion text
);
INSERT INTO qa_security02_test.citas VALUES
  (1, '99000000-0000-0000-0000-000000000031', '99000000-0000-0000-0000-000000000041', 'own'),
  (2, '99000000-0000-0000-0000-000000000031', '99000000-0000-0000-0000-000000000042', 'other A'),
  (3, '99000000-0000-0000-0000-000000000032', '99000000-0000-0000-0000-000000000042', 'other B');
ALTER TABLE qa_security02_test.citas ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON qa_security02_test.citas TO anon, authenticated, service_role;
CREATE POLICY qa_citas_select_scope ON qa_security02_test.citas
  FOR SELECT TO authenticated USING (
    public.fn_is_super_admin(auth.uid())
    OR public.fn_es_admin_de_sucursal(auth.uid(), id_sucursal)
    OR creada_por_usuario_id = auth.uid()
  );
CREATE POLICY qa_citas_update_staff ON qa_security02_test.citas
  FOR UPDATE TO authenticated
  USING (public.fn_is_super_admin(auth.uid()) OR public.fn_es_admin_de_sucursal(auth.uid(), id_sucursal))
  WITH CHECK (public.fn_is_super_admin(auth.uid()) OR public.fn_es_admin_de_sucursal(auth.uid(), id_sucursal));

SET LOCAL ROLE anon;
SELECT qa_security02_test.assert_true((SELECT count(*) FROM qa_security02_test.citas) = 0, 'anon cannot see synthetic private appointments');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000041', true);
SELECT qa_security02_test.assert_true(has_function_privilege(current_user, 'public.fn_is_super_admin(uuid)', 'EXECUTE'), 'RLS super-admin helper remains executable');
SELECT qa_security02_test.assert_true(has_function_privilege(current_user, 'public.fn_es_admin_de_sucursal(uuid,uuid)', 'EXECUTE'), 'RLS branch-admin helper remains executable');
SELECT qa_security02_test.assert_true((SELECT array_agg(id_cita ORDER BY id_cita) FROM qa_security02_test.citas) = ARRAY[1], 'client sees own appointment only');
WITH changed AS (UPDATE qa_security02_test.citas SET observacion = 'forbidden' WHERE id_cita = 1 RETURNING 1)
SELECT qa_security02_test.assert_true((SELECT count(*) FROM changed) = 0, 'client cannot perform staff update');

SELECT set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000021', true);
SELECT qa_security02_test.assert_true((SELECT array_agg(id_cita ORDER BY id_cita) FROM qa_security02_test.citas) = ARRAY[1, 2], 'admin A sees branch A only');
WITH changed AS (UPDATE qa_security02_test.citas SET observacion = 'allowed' WHERE id_cita = 1 RETURNING 1)
SELECT qa_security02_test.assert_true((SELECT count(*) FROM changed) = 1, 'admin A may update branch A');
WITH changed AS (UPDATE qa_security02_test.citas SET observacion = 'forbidden' WHERE id_cita = 3 RETURNING 1)
SELECT qa_security02_test.assert_true((SELECT count(*) FROM changed) = 0, 'admin A cannot update branch B');
DO $$
BEGIN
  BEGIN
    UPDATE qa_security02_test.citas SET id_sucursal = '99000000-0000-0000-0000-000000000032' WHERE id_cita = 1;
    RAISE EXCEPTION 'expected RLS WITH CHECK rejection';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000022', true);
SELECT qa_security02_test.assert_true((SELECT array_agg(id_cita ORDER BY id_cita) FROM qa_security02_test.citas) = ARRAY[3], 'admin B sees branch B only');
SELECT set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000023', true);
SELECT qa_security02_test.assert_true((SELECT count(*) FROM qa_security02_test.citas) = 3, 'super-admin sees all branches');
SELECT set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000024', true);
SELECT qa_security02_test.assert_true((SELECT count(*) FROM qa_security02_test.citas) = 0, 'inactive admin has no branch access');

-- Solo DESPUES del endurecimiento: el runner activa esta expectativa.
-- El baseline conserva un path vulnerable conocido; no se presenta como PASS.
DO $temp_shadow$
BEGIN
  IF current_setting('qa_security02.expect_hardened', true) = 'true' THEN
    CREATE TEMP TABLE roles (id_rol uuid, nombre text);
    CREATE TEMP TABLE roles_usuarios (id_rol uuid, id_usuario uuid, id_sucursal uuid, activo boolean);
    INSERT INTO pg_temp.roles VALUES
      ('99000000-0000-0000-0000-000000000081', 'super_admin'),
      ('99000000-0000-0000-0000-000000000082', 'admin');
    INSERT INTO pg_temp.roles_usuarios VALUES
      ('99000000-0000-0000-0000-000000000081', '99000000-0000-0000-0000-000000000041', NULL, true),
      ('99000000-0000-0000-0000-000000000082', '99000000-0000-0000-0000-000000000042', '99000000-0000-0000-0000-000000000031', true);
    PERFORM qa_security02_test.assert_true(
      NOT public.fn_is_super_admin('99000000-0000-0000-0000-000000000041'),
      'temporary super-admin membership cannot shadow real role tables');
    PERFORM qa_security02_test.assert_true(
      NOT public.fn_es_admin_de_sucursal('99000000-0000-0000-0000-000000000042', '99000000-0000-0000-0000-000000000031'),
      'temporary branch-admin membership cannot shadow real role tables');
    PERFORM set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000041', true);
    PERFORM qa_security02_test.assert_true(
      (SELECT array_agg(id_cita ORDER BY id_cita) FROM qa_security02_test.citas) = ARRAY[1],
      'temporary fake super-admin cannot expand RLS scope');
    PERFORM set_config('request.jwt.claim.sub', '99000000-0000-0000-0000-000000000042', true);
    PERFORM qa_security02_test.assert_true(
      (SELECT array_agg(id_cita ORDER BY id_cita) FROM qa_security02_test.citas) = ARRAY[2, 3],
      'temporary fake branch-admin cannot expand RLS scope');
    DROP TABLE pg_temp.roles_usuarios;
    DROP TABLE pg_temp.roles;
  END IF;
END;
$temp_shadow$;
RESET ROLE;

-- Funciones de trigger reales y sus tablas mínimas del fixture.
-- Los datos son nuevos y quedan revertidos al final.
INSERT INTO public.citas (id_cita, orden_integrante) VALUES
  ('99000000-0000-0000-0000-000000000051', 2),
  ('99000000-0000-0000-0000-000000000052', 1);

SELECT qa_security02_test.assert_true(EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.citas_detalles'::regclass
    AND tgfoid = 'public.fn_citas_detalles_line_identity_v2()'::regprocedure
    AND NOT tgisinternal AND tgenabled <> 'D'
), 'real identity trigger is attached');
SELECT qa_security02_test.assert_true(EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.citas_holds'::regclass
    AND tgfoid = 'public.fn_hold_defaults_y_unico()'::regprocedure
    AND NOT tgisinternal AND tgenabled <> 'D'
), 'real hold trigger is attached');

GRANT SELECT, INSERT, UPDATE ON public.citas_detalles, public.citas_holds TO authenticated;
SET LOCAL ROLE authenticated;
INSERT INTO public.citas_detalles (id_cita, id_servicio, origen_item_codigo)
VALUES ('99000000-0000-0000-0000-000000000051', '99000000-0000-0000-0000-000000000061', 'servicio');
SELECT qa_security02_test.assert_true(EXISTS (
  SELECT 1 FROM public.citas_detalles
  WHERE id_cita = '99000000-0000-0000-0000-000000000051'
    AND orden_linea = 1 AND line_key IS NOT NULL
), 'authenticated INSERT still invokes identity trigger');
DO $$
BEGIN
  BEGIN
    UPDATE public.citas_detalles SET id_servicio = '99000000-0000-0000-0000-000000000062'
    WHERE id_cita = '99000000-0000-0000-0000-000000000051';
    RAISE EXCEPTION 'expected immutable identity rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'MF_BOOKING_LINE_IDENTITY_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.citas_detalles (id_cita, id_servicio, origen_item_codigo, line_key)
    VALUES ('99000000-0000-0000-0000-000000000051', '99000000-0000-0000-0000-000000000061', 'servicio', 'invalid');
    RAISE EXCEPTION 'expected invalid line key rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'MF_BOOKING_LINE_KEY_MISMATCH' THEN RAISE; END IF;
  END;
END;
$$;

INSERT INTO public.citas_holds (id_hold, id_cita, id_usuario)
VALUES ('99000000-0000-0000-0000-000000000071', '99000000-0000-0000-0000-000000000051', '99000000-0000-0000-0000-000000000041');
SELECT qa_security02_test.assert_true(EXISTS (
  SELECT 1 FROM public.citas_holds WHERE id_hold = '99000000-0000-0000-0000-000000000071'
    AND estado_hold_codigo = 'activo' AND expires_at > clock_timestamp()
    AND expires_at <= clock_timestamp() + interval '120 minutes'
), 'authenticated INSERT still invokes hold defaults');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.citas_holds (id_hold, id_cita, id_usuario)
    VALUES ('99000000-0000-0000-0000-000000000072', '99000000-0000-0000-0000-000000000052', '99000000-0000-0000-0000-000000000041');
    RAISE EXCEPTION 'expected duplicate active hold rejection';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'YA_EXISTE_HOLD_ACTIVO_PARA_USUARIO' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.citas_holds (id_hold, id_cita, expires_at)
    VALUES ('99000000-0000-0000-0000-000000000073', '99000000-0000-0000-0000-000000000052', clock_timestamp() - interval '1 second');
    RAISE EXCEPTION 'expected expired hold rejection';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'MF_HOLD_EXPIRY_MUST_BE_FUTURE' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.citas_holds (id_hold, id_cita, expires_at)
    VALUES ('99000000-0000-0000-0000-000000000074', '99000000-0000-0000-0000-000000000052', clock_timestamp() + interval '121 minutes');
    RAISE EXCEPTION 'expected excessive hold expiry rejection';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'MF_HOLD_EXPIRY_EXCEEDS_MAXIMUM' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

ROLLBACK;
