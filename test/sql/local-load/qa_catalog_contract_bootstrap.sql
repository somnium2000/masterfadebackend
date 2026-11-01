-- LOCAL LOAD TEST ONLY. Recovered from read-only QA catalog metadata and
-- repository runtime contracts on 2026-10-31.
-- This is deliberately separate from production migrations and contains no QA rows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.storage_assets (
  id_asset uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_name text NOT NULL,
  object_path text NOT NULL, public_url text, scope_key text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  entity_type text NOT NULL, entity_id uuid, id_sucursal uuid, owner_user_id uuid,
  owner_cliente_id uuid, mime_type text NOT NULL, bytes bigint NOT NULL,
  original_filename text, extension text,
  status text NOT NULL DEFAULT 'temporal' CHECK (status IN ('temporal', 'activo', 'reemplazado', 'eliminado', 'fallido')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_assets_bucket_object ON public.storage_assets (bucket_name, object_path);

ALTER TABLE public.personas ADD COLUMN IF NOT EXISTS telefono_principal text,
  ADD COLUMN IF NOT EXISTS foto_perfil_asset_id uuid, ADD COLUMN IF NOT EXISTS foto_perfil_path text;
ALTER TABLE public.personas ALTER COLUMN id_persona SET DEFAULT gen_random_uuid();
ALTER TABLE public.servicios_tarifas ADD COLUMN IF NOT EXISTS servicio_informativo boolean NOT NULL DEFAULT false;
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz, ADD COLUMN IF NOT EXISTS agendable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS descripcion text, ADD COLUMN IF NOT EXISTS grupo_catalogo text NOT NULL DEFAULT 'barberia',
  ADD COLUMN IF NOT EXISTS visible_publico boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS orden_visual integer NOT NULL DEFAULT 100;
-- agendaService.js and the admin appointment route persist this timestamp.
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
CREATE TABLE IF NOT EXISTS public.payment_providers (
  id_provider uuid PRIMARY KEY,
  codigo text NOT NULL
);
ALTER TABLE public.horarios_semanales_sucursales_bloques
  ADD COLUMN IF NOT EXISTS id_bloque_horario uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_horarios_sucursales_bloques_id_bloque_horario
  ON public.horarios_semanales_sucursales_bloques (id_bloque_horario);

CREATE TABLE IF NOT EXISTS public.modos_excepcion_sucursal (
  modo_excepcion_codigo text PRIMARY KEY, descripcion text NOT NULL,
  reemplaza_horario_base boolean NOT NULL DEFAULT false, bloquea_disponibilidad boolean NOT NULL DEFAULT false,
  requiere_bloques boolean NOT NULL DEFAULT false, orden_prioridad smallint NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.agenda_excepciones_sucursal (
  id_excepcion_sucursal uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sucursal uuid NOT NULL REFERENCES public.sucursales(id_sucursal) ON UPDATE CASCADE ON DELETE RESTRICT,
  fecha date NOT NULL, modo_excepcion_codigo text NOT NULL REFERENCES public.modos_excepcion_sucursal(modo_excepcion_codigo) ON UPDATE CASCADE ON DELETE RESTRICT,
  motivo text, creado_por uuid REFERENCES public.usuarios(id_usuario) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_sucursal, fecha, modo_excepcion_codigo)
);
CREATE TABLE IF NOT EXISTS public.agenda_excepciones_sucursal_bloques (
  id_bloque_excepcion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_excepcion_sucursal uuid NOT NULL REFERENCES public.agenda_excepciones_sucursal(id_excepcion_sucursal) ON UPDATE CASCADE ON DELETE CASCADE,
  hora_inicio time NOT NULL, hora_fin time NOT NULL,
  minuto_inicio integer GENERATED ALWAYS AS (floor(extract(epoch from hora_inicio) / 60)::integer) STORED,
  minuto_fin integer GENERATED ALWAYS AS (floor(extract(epoch from hora_fin) / 60)::integer) STORED,
  orden_visual smallint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hora_fin > hora_inicio), CHECK (minuto_fin > minuto_inicio), CHECK (orden_visual > 0),
  EXCLUDE USING gist (id_excepcion_sucursal WITH =, int4range(minuto_inicio, minuto_fin, '[)') WITH &&)
);
CREATE TABLE IF NOT EXISTS public.tipos_bloqueo_agenda (tipo_bloqueo_codigo text PRIMARY KEY, descripcion text NOT NULL);
CREATE TABLE IF NOT EXISTS public.agenda_bloqueos_empleados (
  id_bloqueo_empleado uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_empleado uuid NOT NULL REFERENCES public.empleados(id_empleado) ON UPDATE CASCADE ON DELETE RESTRICT,
  tipo_bloqueo_codigo text NOT NULL REFERENCES public.tipos_bloqueo_agenda(tipo_bloqueo_codigo) ON UPDATE CASCADE ON DELETE RESTRICT,
  rango tstzrange NOT NULL, motivo text, creado_por uuid REFERENCES public.usuarios(id_usuario) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(rango) AND upper(rango) > lower(rango)), EXCLUDE USING gist (id_empleado WITH =, rango WITH &&)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_personas_foto_perfil_asset') THEN
    ALTER TABLE public.personas ADD CONSTRAINT fk_personas_foto_perfil_asset FOREIGN KEY (foto_perfil_asset_id)
      REFERENCES public.storage_assets(id_asset) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.barberos_perfiles_publicos (
  id_perfil_publico uuid PRIMARY KEY DEFAULT gen_random_uuid(), id_empleado uuid NOT NULL,
  alias_publico varchar(80), resumen_publico varchar(500), certificaciones_titulos text[] NOT NULL DEFAULT '{}'::text[],
  visible_en_landing boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CONSTRAINT fk_barberos_perfiles_publicos_empleado FOREIGN KEY (id_empleado) REFERENCES public.empleados(id_empleado) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT uq_barberos_perfiles_publicos_id_empleado UNIQUE (id_empleado),
  CONSTRAINT chk_barberos_perfiles_publicos_alias_no_vacio CHECK (alias_publico IS NULL OR btrim(alias_publico) <> ''),
  CONSTRAINT chk_barberos_perfiles_publicos_resumen_len CHECK (resumen_publico IS NULL OR (char_length(btrim(resumen_publico)) >= 10 AND char_length(btrim(resumen_publico)) <= 500))
);
CREATE INDEX IF NOT EXISTS idx_barberos_perfiles_publicos_empleado ON public.barberos_perfiles_publicos (id_empleado) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_barberos_perfiles_publicos_visible ON public.barberos_perfiles_publicos (visible_en_landing) WHERE deleted_at IS NULL;
COMMIT;
