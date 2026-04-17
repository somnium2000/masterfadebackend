BEGIN;

-- AM: Nuevo estado operativo para separar llegada al salon de inicio real del servicio.
INSERT INTO public.estados_cita (estado_cita_codigo, descripcion)
VALUES ('en_atencion', 'Servicio iniciado por el barbero')
ON CONFLICT (estado_cita_codigo)
DO UPDATE SET descripcion = EXCLUDED.descripcion;

-- AM: Normaliza citas en curso creadas antes de este estado.
UPDATE public.citas
SET estado_cita_codigo = 'en_atencion',
    updated_at = now()
WHERE estado_cita_codigo = 'en_salon'
  AND atencion_iniciada_at IS NOT NULL
  AND atencion_finalizada_at IS NULL
  AND deleted_at IS NULL;

COMMIT;
