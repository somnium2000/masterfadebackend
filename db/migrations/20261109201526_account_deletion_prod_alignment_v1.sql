BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: PostgreSQL 17 or newer is required';
  END IF;

  IF to_regnamespace('app_private') IS NULL
     OR to_regclass('public.personas') IS NULL
     OR to_regclass('public.clientes') IS NULL
     OR to_regclass('public.empleados') IS NULL
     OR to_regclass('public.usuarios') IS NULL
     OR to_regclass('public.bitacoras') IS NULL
     OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: required schemas or relations are missing';
  END IF;

  IF to_regclass('app_private.solicitudes_eliminacion_cuenta') IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: target table already exists; reconcile migration history before continuing';
  END IF;

  IF to_regprocedure('gen_random_uuid()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: gen_random_uuid() or auth.uid() is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.usuarios'::regclass
      AND c.conname = 'fk_usuario_auth'
      AND c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype = 'c'
      AND c.confupdtype = 'c'
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: production public.usuarios -> auth.users CASCADE contract is missing or changed';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM (VALUES
      ('public', 'personas', 'id_persona', 'uuid'),
      ('public', 'clientes', 'id_cliente', 'uuid'),
      ('public', 'empleados', 'id_empleado', 'uuid'),
      ('public', 'usuarios', 'id_usuario', 'uuid'),
      ('public', 'bitacoras', 'tabla', 'text'),
      ('public', 'bitacoras', 'registro_id', 'uuid'),
      ('public', 'bitacoras', 'accion', 'text'),
      ('public', 'bitacoras', 'descripcion', 'text'),
      ('public', 'bitacoras', 'datos_antes', 'jsonb'),
      ('public', 'bitacoras', 'datos_despues', 'jsonb'),
      ('public', 'bitacoras', 'id_usuario', 'uuid')
    ) AS required(table_schema, table_name, column_name, data_type)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = required.table_schema
     AND c.table_name = required.table_name
     AND c.column_name = required.column_name
     AND c.data_type = required.data_type
    WHERE c.column_name IS NULL
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_PREFLIGHT: required columns or data types are missing';
  END IF;
END;
$preflight$;

-- Production currently links public.usuarios(id_usuario) to auth.users(id) with
-- ON DELETE CASCADE. That is incompatible with the existing physical-delete
-- guard on public.usuarios and would erase the internal historical identity if
-- that guard were ever relaxed. Preserve the UUID and enforce the lifecycle
-- with explicit guards instead.
CREATE FUNCTION app_private.fn_guard_masterfade_auth_user_delete_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private', 'auth'
AS $function$
DECLARE
  v_estado boolean;
  v_estado_acceso text;
  v_deleted_at timestamptz;
BEGIN
  SELECT u.estado, u.estado_acceso, u.deleted_at
  INTO v_estado, v_estado_acceso, v_deleted_at
  FROM public.usuarios u
  WHERE u.id_usuario = OLD.id;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF v_estado IS DISTINCT FROM false
     OR v_estado_acceso IS DISTINCT FROM 'inactivo'
     OR v_deleted_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'AUTH_USER_DELETE_REQUIRES_INTERNAL_DEACTIVATION';
  END IF;

  RETURN OLD;
END;
$function$;

CREATE FUNCTION app_private.fn_guard_masterfade_usuario_auth_link_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users au WHERE au.id = NEW.id_usuario) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'USUARIO_AUTH_LINK_NOT_FOUND';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER tr_guard_masterfade_auth_user_delete
BEFORE DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION app_private.fn_guard_masterfade_auth_user_delete_v1();

CREATE TRIGGER tr_guard_masterfade_usuario_auth_link
BEFORE INSERT OR UPDATE OF id_usuario ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION app_private.fn_guard_masterfade_usuario_auth_link_v1();

ALTER TABLE public.usuarios DROP CONSTRAINT fk_usuario_auth;

REVOKE ALL ON FUNCTION app_private.fn_guard_masterfade_auth_user_delete_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fn_guard_masterfade_usuario_auth_link_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.fn_redact_account_pii_jsonb_v1(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'app_private'
AS $function$
DECLARE
  v_type text;
  v_result jsonb;
  v_key text;
  v_item jsonb;
  v_key_normalized text;
BEGIN
  v_type := jsonb_typeof(p_value);

  IF v_type = 'object' THEN
    v_result := '{}'::jsonb;

    FOR v_key, v_item IN
      SELECT key, value
      FROM jsonb_each(p_value)
    LOOP
      v_key_normalized := lower(v_key);

      IF v_key_normalized = ANY (ARRAY[
        'nombre', 'nombres', 'apellidos', 'nombre_completo', 'nombre_cliente',
        'cliente_nombre', 'titular_nombre', 'titular_nombre_snapshot',
        'receptor_nombre', 'receptor_nombre_snapshot', 'contacto_nombre',
        'contacto_nombre_snapshot', 'nombre_destinatario',
        'nombre_destinatario_snapshot',
        'email', 'correo', 'direccion_correo', 'correo_destino', 'email_factura',
        'titular_email', 'titular_email_snapshot', 'receptor_email',
        'receptor_email_snapshot', 'contacto_email', 'contacto_email_snapshot',
        'email_destinatario_snapshot', 'email_masked',
        'telefono', 'telefono_principal', 'telefono_cliente', 'titular_telefono',
        'titular_telefono_snapshot', 'receptor_telefono',
        'receptor_telefono_snapshot', 'contacto_telefono',
        'contacto_telefono_snapshot', 'celular', 'phone',
        'dni', 'rtn', 'identidad', 'documento', 'numero_documento',
        'direccion', 'direccion_texto', 'address', 'fecha_nacimiento',
        'birth_date', 'birthdate', 'genero_codigo',
        'observaciones', 'notas', 'comentario', 'comentarios', 'cuerpo',
        'mensaje', 'detalle_tecnico', 'ultimo_error',
        'email_ultimo_error_detalle', 'ultimo_error_detalle',
        'foto_perfil_path', 'foto_perfil_asset_id', 'avatar_url', 'foto',
        'imagen_perfil', 'release_token', 'release_token_hash', 'token',
        'access_token', 'refresh_token', 'token_jti_hash', 'ip', 'ip_inicio',
        'ip_ultimo_uso', 'last_login_ip', 'user_agent', 'identificador_hash',
        'public_url', 'object_path', 'original_filename'
      ]::text[]) THEN
        IF v_key_normalized = ANY (ARRAY[
          'nombre', 'nombres', 'apellidos', 'nombre_completo', 'nombre_cliente',
          'cliente_nombre', 'titular_nombre', 'titular_nombre_snapshot',
          'receptor_nombre', 'receptor_nombre_snapshot', 'contacto_nombre',
          'contacto_nombre_snapshot', 'nombre_destinatario',
          'nombre_destinatario_snapshot'
        ]::text[]) THEN
          v_result := v_result || jsonb_build_object(v_key, 'Cliente eliminado');
        ELSE
          v_result := v_result || jsonb_build_object(v_key, 'null'::jsonb);
        END IF;
      ELSE
        v_result := v_result || jsonb_build_object(
          v_key,
          app_private.fn_redact_account_pii_jsonb_v1(v_item)
        );
      END IF;
    END LOOP;

    RETURN v_result;
  END IF;

  IF v_type = 'array' THEN
    SELECT COALESCE(
      jsonb_agg(app_private.fn_redact_account_pii_jsonb_v1(value)),
      '[]'::jsonb
    )
    INTO v_result
    FROM jsonb_array_elements(p_value);

    RETURN v_result;
  END IF;

  RETURN p_value;
END;
$function$;

REVOKE ALL ON FUNCTION app_private.fn_redact_account_pii_jsonb_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.fn_redact_account_pii_jsonb_v1(jsonb) TO postgres;

CREATE TABLE app_private.solicitudes_eliminacion_cuenta (
  id_solicitud uuid NOT NULL DEFAULT gen_random_uuid(),
  referencia_publica text NOT NULL DEFAULT ('DEL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  tipo_sujeto text NOT NULL,
  id_persona uuid NOT NULL,
  id_usuario uuid,
  id_cliente uuid,
  id_empleado uuid,
  modo_proceso text NOT NULL,
  requiere_aprobacion boolean NOT NULL,
  origen_codigo text NOT NULL,
  estado_codigo text NOT NULL DEFAULT 'evaluada',
  auth_user_id_pendiente uuid,
  resumen_impacto jsonb NOT NULL DEFAULT '{}'::jsonb,
  bloqueos_detectados jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_codigo text,
  decision_por uuid,
  decision_at timestamptz,
  comentario_decision text,
  reautenticado_at timestamptz,
  idempotency_key text NOT NULL,
  request_id text,
  error_codigo text,
  error_detalle_tecnico text,
  solicitado_at timestamptz NOT NULL DEFAULT now(),
  procesando_at timestamptz,
  completado_at timestamptz,
  cancelado_at timestamptz,
  fallido_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  execution_token_hash text,
  execution_token_issued_at timestamptz,
  execution_token_expires_at timestamptz,
  execution_token_last_used_at timestamptz,
  CONSTRAINT solicitudes_eliminacion_cuenta_pkey PRIMARY KEY (id_solicitud),
  CONSTRAINT uq_solicitud_eliminacion_idempotencia UNIQUE (idempotency_key),
  CONSTRAINT uq_solicitud_eliminacion_referencia UNIQUE (referencia_publica),
  CONSTRAINT fk_solicitud_eliminacion_persona FOREIGN KEY (id_persona) REFERENCES public.personas(id_persona) ON DELETE RESTRICT,
  CONSTRAINT fk_solicitud_eliminacion_cliente FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente) ON DELETE RESTRICT,
  CONSTRAINT fk_solicitud_eliminacion_empleado FOREIGN KEY (id_empleado) REFERENCES public.empleados(id_empleado) ON DELETE RESTRICT,
  CONSTRAINT fk_solicitud_eliminacion_usuario FOREIGN KEY (id_usuario) REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  CONSTRAINT fk_solicitud_eliminacion_decision_por FOREIGN KEY (decision_por) REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  CONSTRAINT ck_solicitud_eliminacion_auth_ids_coherentes CHECK (id_usuario IS NULL OR auth_user_id_pendiente IS NULL OR id_usuario = auth_user_id_pendiente),
  CONSTRAINT ck_solicitud_eliminacion_decision CHECK (decision_codigo IS NULL OR decision_codigo = ANY (ARRAY['aprobada', 'rechazada'])),
  CONSTRAINT ck_solicitud_eliminacion_error_codigo_longitud CHECK (error_codigo IS NULL OR char_length(error_codigo) <= 120),
  CONSTRAINT ck_solicitud_eliminacion_estado CHECK (estado_codigo = ANY (ARRAY['evaluada','bloqueada','pendiente_confirmacion','pendiente_aprobacion','aprobada','rechazada','procesando','storage_pendiente','auth_pendiente','completada','fallida','cancelada'])),
  CONSTRAINT ck_solicitud_eliminacion_estado_decision CHECK (
    (estado_codigo <> 'aprobada' OR (decision_codigo = 'aprobada' AND decision_at IS NOT NULL))
    AND (estado_codigo <> 'rechazada' OR (decision_codigo = 'rechazada' AND decision_at IS NOT NULL))
    AND (estado_codigo <> 'pendiente_aprobacion' OR (requiere_aprobacion IS TRUE AND decision_codigo IS NULL))
  ),
  CONSTRAINT ck_solicitud_eliminacion_estado_timestamps CHECK (
    (estado_codigo <> ALL (ARRAY['procesando','storage_pendiente','auth_pendiente','completada']) OR procesando_at IS NOT NULL)
    AND (estado_codigo <> 'completada' OR (completado_at IS NOT NULL AND auth_user_id_pendiente IS NULL))
    AND (estado_codigo <> 'fallida' OR fallido_at IS NOT NULL)
    AND (estado_codigo <> 'cancelada' OR cancelado_at IS NOT NULL)
    AND (estado_codigo <> 'auth_pendiente' OR auth_user_id_pendiente IS NOT NULL)
  ),
  CONSTRAINT ck_solicitud_eliminacion_execution_token_hash CHECK (execution_token_hash IS NULL OR execution_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_solicitud_eliminacion_execution_token_timestamps CHECK (execution_token_hash IS NULL OR (execution_token_issued_at IS NOT NULL AND execution_token_expires_at IS NOT NULL AND execution_token_expires_at > execution_token_issued_at)),
  CONSTRAINT ck_solicitud_eliminacion_execution_token_last_used CHECK (execution_token_last_used_at IS NULL OR (execution_token_issued_at IS NOT NULL AND execution_token_last_used_at >= execution_token_issued_at)),
  CONSTRAINT ck_solicitud_eliminacion_execution_token_state CHECK (execution_token_hash IS NULL OR estado_codigo = ANY (ARRAY['evaluada','procesando','storage_pendiente','auth_pendiente','completada'])),
  CONSTRAINT ck_solicitud_eliminacion_flujo_aprobacion CHECK (modo_proceso <> 'requiere_aprobacion' OR (estado_codigo <> 'pendiente_confirmacion' AND ((decision_codigo IS NULL AND decision_at IS NULL) OR (decision_codigo IS NOT NULL AND decision_at IS NOT NULL)))),
  CONSTRAINT ck_solicitud_eliminacion_flujo_autonomo CHECK (modo_proceso <> 'autonomo' OR (estado_codigo <> ALL (ARRAY['pendiente_aprobacion','aprobada','rechazada']) AND decision_codigo IS NULL AND decision_por IS NULL AND decision_at IS NULL AND comentario_decision IS NULL)),
  CONSTRAINT ck_solicitud_eliminacion_idempotencia_longitud CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 160),
  CONSTRAINT ck_solicitud_eliminacion_json_bloqueos CHECK (jsonb_typeof(bloqueos_detectados) = 'array'),
  CONSTRAINT ck_solicitud_eliminacion_json_impacto CHECK (jsonb_typeof(resumen_impacto) = 'object'),
  CONSTRAINT ck_solicitud_eliminacion_modo_proceso CHECK (modo_proceso = ANY (ARRAY['autonomo','requiere_aprobacion'])),
  CONSTRAINT ck_solicitud_eliminacion_origen CHECK (origen_codigo = ANY (ARRAY['cliente','personal','soporte','administracion'])),
  CONSTRAINT ck_solicitud_eliminacion_referencia_formato CHECK (referencia_publica ~ '^DEL-[A-F0-9]{12}$'),
  CONSTRAINT ck_solicitud_eliminacion_request_id_longitud CHECK (request_id IS NULL OR char_length(request_id) <= 200),
  CONSTRAINT ck_solicitud_eliminacion_sujeto CHECK (
    (tipo_sujeto = 'cliente' AND id_cliente IS NOT NULL AND id_empleado IS NULL AND modo_proceso = 'autonomo' AND requiere_aprobacion IS FALSE)
    OR (tipo_sujeto = 'personal' AND id_empleado IS NOT NULL AND modo_proceso = 'requiere_aprobacion' AND requiere_aprobacion IS TRUE)
  ),
  CONSTRAINT ck_solicitud_eliminacion_tipo_sujeto CHECK (tipo_sujeto = ANY (ARRAY['cliente','personal']))
);

COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.referencia_publica IS 'Referencia no personal para operaciones administrativas.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.auth_user_id_pendiente IS 'Identificador temporal de Auth; debe quedar NULL al completar la solicitud.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.resumen_impacto IS 'Impacto calculado sin datos personales.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.bloqueos_detectados IS 'Bloqueos estructurados detectados durante la evaluacion.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.error_detalle_tecnico IS 'Detalle tecnico sin credenciales, tokens ni PII.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_hash IS 'Hash SHA-256 hexadecimal del token opaco usado exclusivamente para continuar una eliminacion autonoma.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_issued_at IS 'Fecha de emision del token opaco de continuacion.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_expires_at IS 'Expiracion para iniciar la fase irreversible mientras la solicitud permanece evaluada; una solicitud ya iniciada o completada conserva replay autenticado por hash.';
COMMENT ON COLUMN app_private.solicitudes_eliminacion_cuenta.execution_token_last_used_at IS 'Ultimo uso valido del token de continuacion; no contiene el secreto.';

CREATE INDEX idx_solicitudes_eliminacion_decision_por ON app_private.solicitudes_eliminacion_cuenta (decision_por) WHERE decision_por IS NOT NULL;
CREATE INDEX idx_solicitudes_eliminacion_estado_fecha ON app_private.solicitudes_eliminacion_cuenta (estado_codigo, solicitado_at DESC);
CREATE INDEX idx_solicitudes_eliminacion_pendientes_aprobacion ON app_private.solicitudes_eliminacion_cuenta (solicitado_at) WHERE estado_codigo = 'pendiente_aprobacion';
CREATE INDEX idx_solicitudes_eliminacion_pendientes_tecnicas ON app_private.solicitudes_eliminacion_cuenta (updated_at) WHERE estado_codigo = ANY (ARRAY['storage_pendiente','auth_pendiente','fallida']);
CREATE INDEX idx_solicitudes_eliminacion_persona ON app_private.solicitudes_eliminacion_cuenta (id_persona);
CREATE INDEX idx_solicitudes_eliminacion_tipo_estado_fecha ON app_private.solicitudes_eliminacion_cuenta (tipo_sujeto, estado_codigo, solicitado_at DESC);
CREATE INDEX idx_solicitudes_eliminacion_usuario ON app_private.solicitudes_eliminacion_cuenta (id_usuario) WHERE id_usuario IS NOT NULL;
CREATE UNIQUE INDEX uq_solicitud_eliminacion_cliente_activa ON app_private.solicitudes_eliminacion_cuenta (id_cliente) WHERE id_cliente IS NOT NULL AND estado_codigo <> ALL (ARRAY['completada','rechazada','cancelada']);
CREATE UNIQUE INDEX uq_solicitud_eliminacion_empleado_activa ON app_private.solicitudes_eliminacion_cuenta (id_empleado) WHERE id_empleado IS NOT NULL AND estado_codigo <> ALL (ARRAY['completada','rechazada','cancelada']);
CREATE UNIQUE INDEX uq_solicitud_eliminacion_usuario_activa ON app_private.solicitudes_eliminacion_cuenta (COALESCE(id_usuario, auth_user_id_pendiente)) WHERE COALESCE(id_usuario, auth_user_id_pendiente) IS NOT NULL AND estado_codigo <> ALL (ARRAY['completada','rechazada','cancelada']);
CREATE UNIQUE INDEX uq_solicitud_eliminacion_execution_token_hash ON app_private.solicitudes_eliminacion_cuenta (execution_token_hash) WHERE execution_token_hash IS NOT NULL;

CREATE FUNCTION app_private.fn_guard_solicitudes_eliminacion_cuenta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'app_private'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Las solicitudes de eliminacion de cuenta son historicas y no pueden eliminarse';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado_codigo IN ('completada', 'rechazada', 'cancelada') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Una solicitud de eliminacion en estado terminal no puede modificarse';
    END IF;
    IF NEW.id_solicitud IS DISTINCT FROM OLD.id_solicitud
       OR NEW.referencia_publica IS DISTINCT FROM OLD.referencia_publica
       OR NEW.tipo_sujeto IS DISTINCT FROM OLD.tipo_sujeto
       OR NEW.id_persona IS DISTINCT FROM OLD.id_persona
       OR NEW.id_cliente IS DISTINCT FROM OLD.id_cliente
       OR NEW.id_empleado IS DISTINCT FROM OLD.id_empleado
       OR NEW.modo_proceso IS DISTINCT FROM OLD.modo_proceso
       OR NEW.requiere_aprobacion IS DISTINCT FROM OLD.requiere_aprobacion
       OR NEW.origen_codigo IS DISTINCT FROM OLD.origen_codigo
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.solicitado_at IS DISTINCT FROM OLD.solicitado_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Se intento modificar la identidad inmutable de una solicitud de eliminacion';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta()
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
  INSERT INTO public.bitacoras (tabla, registro_id, accion, descripcion, datos_antes, datos_despues, id_usuario)
  VALUES (
    'app_private.solicitudes_eliminacion_cuenta',
    COALESCE(NEW.id_solicitud, OLD.id_solicitud),
    TG_OP,
    'Trazabilidad de solicitud de eliminacion de cuenta',
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'execution_token_hash' END,
    to_jsonb(NEW) - 'execution_token_hash',
    v_actor
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_solicitudes_eliminacion_guard
BEFORE UPDATE OR DELETE ON app_private.solicitudes_eliminacion_cuenta
FOR EACH ROW EXECUTE FUNCTION app_private.fn_guard_solicitudes_eliminacion_cuenta();

CREATE TRIGGER trg_solicitudes_eliminacion_audit
AFTER INSERT OR UPDATE ON app_private.solicitudes_eliminacion_cuenta
FOR EACH ROW EXECUTE FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta();

REVOKE ALL ON TABLE app_private.solicitudes_eliminacion_cuenta FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fn_guard_solicitudes_eliminacion_cuenta() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.fn_auditar_solicitudes_eliminacion_cuenta() FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.usuarios'::regclass
      AND c.conname = 'fk_usuario_auth'
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_POSTFLIGHT: unsafe auth CASCADE FK still exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND tgname = 'tr_guard_masterfade_auth_user_delete'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_POSTFLIGHT: auth delete guard was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.usuarios'::regclass
      AND tgname = 'tr_guard_masterfade_usuario_auth_link'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_POSTFLIGHT: auth link guard was not installed';
  END IF;
  IF to_regprocedure('app_private.fn_redact_account_pii_jsonb_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_POSTFLIGHT: PII redaction function was not installed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'app_private.solicitudes_eliminacion_cuenta'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'ACCOUNT_DELETION_POSTFLIGHT: expected table triggers were not installed';
  END IF;
END;
$postflight$;

COMMIT;
