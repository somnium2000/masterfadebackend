BEGIN;

DO $$
DECLARE
  invalid_count integer := 0;
BEGIN
  IF to_regclass('public.promociones_reglas_agendamiento') IS NULL THEN
    RAISE NOTICE 'Tabla public.promociones_reglas_agendamiento no existe; se omite ajuste de constraint.';
    RETURN;
  END IF;

  SELECT COUNT(*)
    INTO invalid_count
  FROM public.promociones_reglas_agendamiento
  WHERE tipo_descuento_codigo IS NULL
     OR btrim(tipo_descuento_codigo) = ''
     OR tipo_descuento_codigo NOT IN ('porcentaje', 'monto_fijo', 'bonificacion');

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'No se puede actualizar ck_promociones_reglas_tipo_descuento: existen % filas con tipo_descuento_codigo fuera de [porcentaje,monto_fijo,bonificacion].',
      invalid_count;
  END IF;

  ALTER TABLE public.promociones_reglas_agendamiento
    DROP CONSTRAINT IF EXISTS ck_promociones_reglas_tipo_descuento;

  ALTER TABLE public.promociones_reglas_agendamiento
    ADD CONSTRAINT ck_promociones_reglas_tipo_descuento
    CHECK (tipo_descuento_codigo IN ('porcentaje', 'monto_fijo', 'bonificacion'));
END $$;

COMMIT;
