BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: Son funciones trigger internas; ningun cliente Data API necesita invocarlas directamente.
REVOKE EXECUTE ON FUNCTION public.fn_citas_detalles_line_identity_v2() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_citas_detalles_line_identity_v2() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_hold_defaults_y_unico() TO postgres;

COMMIT;
