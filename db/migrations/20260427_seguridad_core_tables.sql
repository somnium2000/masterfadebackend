BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.seguridad_usuarios_acceso (
  id_usuario uuid PRIMARY KEY REFERENCES public.usuarios(id_usuario) ON DELETE CASCADE,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  last_failed_login_at timestamptz NULL,
  locked_until_at timestamptz NULL,
  last_login_at timestamptz NULL,
  last_login_ip inet NULL,
  force_password_change boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.seguridad_login_logs (
  id_login_log uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_usuario uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  identificador_hash text NULL,
  email_masked text NULL,
  provider text NOT NULL,
  resultado text NOT NULL,
  motivo_codigo text NULL,
  ip inet NULL,
  user_agent text NULL,
  request_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'seguridad_login_logs'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%resultado%'
  LOOP
    EXECUTE format('ALTER TABLE public.seguridad_login_logs DROP CONSTRAINT %I', rec.conname);
  END LOOP;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seguridad_login_logs_resultado_chk'
  ) THEN
    ALTER TABLE public.seguridad_login_logs
      ADD CONSTRAINT seguridad_login_logs_resultado_chk
      CHECK (resultado IN ('success', 'failed', 'blocked', 'session_limit', 'error'));
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.seguridad_sesiones (
  id_sesion uuid PRIMARY KEY,
  id_usuario uuid NOT NULL REFERENCES public.usuarios(id_usuario) ON DELETE CASCADE,
  token_jti_hash text NOT NULL,
  estado text NOT NULL DEFAULT 'activa',
  inicio_at timestamptz NOT NULL DEFAULT NOW(),
  ultimo_uso_at timestamptz NULL,
  expira_at timestamptz NOT NULL,
  cierre_at timestamptz NULL,
  revocada_at timestamptz NULL,
  cerrada_por uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  motivo_cierre text NULL,
  ip_inicio inet NULL,
  ip_ultimo_uso inet NULL,
  user_agent text NULL,
  request_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seguridad_sesiones_estado_chk'
  ) THEN
    ALTER TABLE public.seguridad_sesiones
      ADD CONSTRAINT seguridad_sesiones_estado_chk
      CHECK (estado IN ('activa', 'cerrada', 'revocada', 'expirada'));
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.seguridad_session_policy (
  id_policy bigserial PRIMARY KEY,
  id_rol uuid NOT NULL REFERENCES public.roles(id_rol) ON DELETE CASCADE,
  max_active_sessions integer NOT NULL CHECK (max_active_sessions > 0),
  collision_action text NOT NULL DEFAULT 'allow',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seguridad_session_policy_collision_action_chk'
  ) THEN
    ALTER TABLE public.seguridad_session_policy
      ADD CONSTRAINT seguridad_session_policy_collision_action_chk
      CHECK (collision_action IN ('allow', 'block', 'confirm_replace'));
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.seguridad_alertas (
  id_alerta uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  severidad text NOT NULL DEFAULT 'media',
  estado text NOT NULL DEFAULT 'abierta',
  id_usuario uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  ip inet NULL,
  resumen text NULL,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  detectada_at timestamptz NOT NULL DEFAULT NOW(),
  resuelta_at timestamptz NULL,
  resuelta_por uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  comentario_resolucion text NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seguridad_alertas_severidad_chk'
  ) THEN
    ALTER TABLE public.seguridad_alertas
      ADD CONSTRAINT seguridad_alertas_severidad_chk
      CHECK (severidad IN ('baja', 'media', 'alta', 'critica'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'seguridad_alertas_estado_chk'
  ) THEN
    ALTER TABLE public.seguridad_alertas
      ADD CONSTRAINT seguridad_alertas_estado_chk
      CHECK (estado IN ('abierta', 'en_revision', 'resuelta', 'descartada'));
  END IF;
END$$;

ALTER TABLE IF EXISTS public.seguridad_alertas
  ADD COLUMN IF NOT EXISTS comentario_resolucion text NULL;

CREATE TABLE IF NOT EXISTS public.seguridad_audit_logs (
  id_audit_log uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_usuario uuid NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  accion text NOT NULL,
  entidad text NULL,
  entidad_id text NULL,
  resultado text NOT NULL DEFAULT 'ok',
  motivo_codigo text NULL,
  ip inet NULL,
  request_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.seguridad_password_policy (
  id_policy smallint PRIMARY KEY DEFAULT 1,
  min_length integer NOT NULL DEFAULT 8 CHECK (min_length >= 8),
  require_uppercase boolean NOT NULL DEFAULT true,
  require_lowercase boolean NOT NULL DEFAULT true,
  require_number boolean NOT NULL DEFAULT true,
  require_special boolean NOT NULL DEFAULT false,
  password_max_age_days integer NULL CHECK (password_max_age_days IS NULL OR password_max_age_days >= 1),
  password_history_count integer NOT NULL DEFAULT 5 CHECK (password_history_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_seguridad_session_policy_id_rol
  ON public.seguridad_session_policy (id_rol);
CREATE UNIQUE INDEX IF NOT EXISTS ux_seguridad_sesiones_token_jti_hash
  ON public.seguridad_sesiones (token_jti_hash);

CREATE INDEX IF NOT EXISTS ix_seguridad_login_logs_created_at
  ON public.seguridad_login_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_login_logs_id_usuario_created_at
  ON public.seguridad_login_logs (id_usuario, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_login_logs_identificador_hash_created_at
  ON public.seguridad_login_logs (identificador_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_login_logs_ip_created_at
  ON public.seguridad_login_logs (ip, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_seguridad_sesiones_id_usuario_estado
  ON public.seguridad_sesiones (id_usuario, estado);
CREATE INDEX IF NOT EXISTS ix_seguridad_sesiones_estado_inicio_at
  ON public.seguridad_sesiones (estado, inicio_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_sesiones_expira_at
  ON public.seguridad_sesiones (expira_at);

CREATE INDEX IF NOT EXISTS ix_seguridad_alertas_estado_detectada_at
  ON public.seguridad_alertas (estado, detectada_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_alertas_tipo_detectada_at
  ON public.seguridad_alertas (tipo, detectada_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_alertas_id_usuario_detectada_at
  ON public.seguridad_alertas (id_usuario, detectada_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_alertas_ip_detectada_at
  ON public.seguridad_alertas (ip, detectada_at DESC);

CREATE INDEX IF NOT EXISTS ix_seguridad_audit_logs_created_at
  ON public.seguridad_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_audit_logs_id_usuario_created_at
  ON public.seguridad_audit_logs (id_usuario, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_seguridad_audit_logs_entidad_entidad_id
  ON public.seguridad_audit_logs (entidad, entidad_id);

COMMIT;
