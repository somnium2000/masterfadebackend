ALTER TABLE app_private.solicitudes_eliminacion_cuenta
  DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_completed_token_cleared,
  DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_execution_token_state;

ALTER TABLE app_private.solicitudes_eliminacion_cuenta
  ADD CONSTRAINT ck_solicitud_eliminacion_execution_token_state
    CHECK (
      execution_token_hash IS NULL
      OR estado_codigo = ANY (
        ARRAY[
          'evaluada'::text,
          'procesando'::text,
          'storage_pendiente'::text,
          'auth_pendiente'::text,
          'completada'::text
        ]
      )
    );
