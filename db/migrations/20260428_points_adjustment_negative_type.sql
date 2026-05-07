-- AM: Agrega tipo de puntos especifico para ajuste administrativo negativo.
-- Este tipo permite restas manuales sin reutilizar tipos de canje/recompensa.

DO $$
BEGIN
  IF to_regclass('public.tipos_puntos') IS NULL THEN
    RAISE EXCEPTION 'Falta tabla public.tipos_puntos para registrar ajuste_resta';
  END IF;

  INSERT INTO public.tipos_puntos (tipo_puntos_codigo, descripcion, signo)
  VALUES ('ajuste_resta', 'Ajuste administrativo negativo', -1)
  ON CONFLICT (tipo_puntos_codigo)
  DO UPDATE SET
    descripcion = EXCLUDED.descripcion,
    signo = EXCLUDED.signo;
END
$$;

