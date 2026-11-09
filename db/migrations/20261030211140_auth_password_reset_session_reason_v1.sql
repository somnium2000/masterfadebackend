-- QA-AUTH-RESET-01: registrar el motivo semantico usado por el reset seguro.
ALTER TABLE public.seguridad_sesiones
  DROP CONSTRAINT ck_seg_sesiones_motivo_cierre,
  ADD CONSTRAINT ck_seg_sesiones_motivo_cierre
  CHECK (
    motivo_cierre IS NULL
    OR motivo_cierre = ANY (ARRAY[
      'logout_usuario'::text,
      'logout_admin'::text,
      'reemplazo_sesion_cliente'::text,
      'sesion_expirada'::text,
      'riesgo_seguridad'::text,
      'eliminacion_cuenta'::text,
      'password_reset'::text
    ])
  ) NOT VALID;

ALTER TABLE public.seguridad_sesiones
  VALIDATE CONSTRAINT ck_seg_sesiones_motivo_cierre;
