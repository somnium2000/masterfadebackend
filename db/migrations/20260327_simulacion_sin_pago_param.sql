-- AM: Parametro temporal para controlar simulacion sin pago en /agendar.
BEGIN;

INSERT INTO public.parametros_sistema (
  clave,
  valor_booleano,
  descripcion,
  updated_at
)
VALUES (
  'simulacion_sin_pago',
  TRUE,
  'Habilita temporalmente el agendamiento sin cobro para pruebas',
  now()
)
ON CONFLICT (clave)
DO UPDATE SET
  valor_booleano = COALESCE(public.parametros_sistema.valor_booleano, TRUE),
  descripcion = COALESCE(EXCLUDED.descripcion, public.parametros_sistema.descripcion),
  updated_at = now();

COMMIT;
