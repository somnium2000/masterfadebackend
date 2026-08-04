-- Microfase 3C.1: permite cerrar sesiones por eliminacion de cuenta.

ALTER TABLE public.seguridad_sesiones
  DROP CONSTRAINT ck_seg_sesiones_motivo_cierre;

ALTER TABLE public.seguridad_sesiones
  ADD CONSTRAINT ck_seg_sesiones_motivo_cierre
  CHECK (
    motivo_cierre IS NULL
    OR motivo_cierre = ANY (
      ARRAY[
        'logout_usuario',
        'logout_admin',
        'reemplazo_sesion_cliente',
        'sesion_expirada',
        'riesgo_seguridad',
        'eliminacion_cuenta'
      ]::text[]
    )
  );
