ALTER TABLE app_private.solicitudes_eliminacion_cuenta
  ADD COLUMN IF NOT EXISTS execution_token_hash text,
  ADD COLUMN IF NOT EXISTS execution_token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_token_last_used_at timestamptz;

COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_hash
  IS 'Hash SHA-256 hexadecimal del token opaco usado exclusivamente para continuar una eliminacion autonoma.';

COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_issued_at
  IS 'Fecha de emision del token opaco de continuacion.';

COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_expires_at
  IS 'Expiracion para iniciar la fase irreversible mientras la solicitud permanece evaluada; una solicitud ya iniciada o completada conserva replay autenticado por hash.';

COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_last_used_at
  IS 'Ultimo uso valido del token de continuacion; no contiene el secreto.';

ALTER TABLE app_private.solicitudes_eliminacion_cuenta
  DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_execution_token_hash,
  DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_execution_token_timestamps,
  DROP CONSTRAINT IF EXISTS ck_solicitud_eliminacion_execution_token_last_used;

ALTER TABLE app_private.solicitudes_eliminacion_cuenta
  ADD CONSTRAINT ck_solicitud_eliminacion_execution_token_hash
    CHECK (execution_token_hash IS NULL OR execution_token_hash ~ '^[0-9a-f]{64}$'::text),
  ADD CONSTRAINT ck_solicitud_eliminacion_execution_token_timestamps
    CHECK (
      execution_token_hash IS NULL
      OR execution_token_issued_at IS NOT NULL
        AND execution_token_expires_at IS NOT NULL
        AND execution_token_expires_at > execution_token_issued_at
    ),
  ADD CONSTRAINT ck_solicitud_eliminacion_execution_token_last_used
    CHECK (
      execution_token_last_used_at IS NULL
      OR execution_token_issued_at IS NOT NULL
        AND execution_token_last_used_at >= execution_token_issued_at
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitud_eliminacion_execution_token_hash
  ON app_private.solicitudes_eliminacion_cuenta (execution_token_hash)
  WHERE execution_token_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'auth'
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  BEGIN
    v_actor := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF v_actor IS NULL THEN
    v_actor := COALESCE(NEW.decision_por, NEW.id_usuario, OLD.id_usuario);
  END IF;

  INSERT INTO public.bitacoras (
    tabla,
    registro_id,
    accion,
    descripcion,
    datos_antes,
    datos_despues,
    id_usuario
  )
  VALUES (
    'app_private.solicitudes_eliminacion_cuenta',
    COALESCE(NEW.id_solicitud, OLD.id_solicitud),
    TG_OP,
    'Trazabilidad de solicitud de eliminacion de cuenta',
    CASE
      WHEN TG_OP = 'INSERT' THEN NULL
      ELSE to_jsonb(OLD) - 'execution_token_hash'
    END,
    to_jsonb(NEW) - 'execution_token_hash',
    v_actor
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta() FROM anon;
REVOKE ALL ON FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta() FROM authenticated;
REVOKE ALL ON FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta() FROM service_role;
