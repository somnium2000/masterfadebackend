BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parametros_sistema'
      AND column_name = 'created_at'
  ) THEN
    INSERT INTO public.parametros_sistema (
      clave,
      valor_numero,
      descripcion,
      created_at,
      updated_at
    )
    VALUES (
      'agenda_min_servicio_vendible_min',
      10,
      'Duracion minima vendible en minutos para descartar huecos huerfanos no comercializables',
      now(),
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_numero = COALESCE(public.parametros_sistema.valor_numero, EXCLUDED.valor_numero),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  ELSE
    INSERT INTO public.parametros_sistema (
      clave,
      valor_numero,
      descripcion,
      updated_at
    )
    VALUES (
      'agenda_min_servicio_vendible_min',
      10,
      'Duracion minima vendible en minutos para descartar huecos huerfanos no comercializables',
      now()
    )
    ON CONFLICT (clave)
    DO UPDATE SET
      valor_numero = COALESCE(public.parametros_sistema.valor_numero, EXCLUDED.valor_numero),
      descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
      updated_at = now();
  END IF;
END $$;

COMMIT;
