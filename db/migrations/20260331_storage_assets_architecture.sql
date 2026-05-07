-- 20260331_storage_assets_architecture.sql
-- Arquitectura base de Storage para MasterFade:
-- - tabla central de assets
-- - columnas de enlace en promociones/personas
-- - buckets publico/privado en Supabase Storage

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.storage_assets (
  id_asset uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name text NOT NULL,
  object_path text NOT NULL,
  public_url text NULL,
  scope_key text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  entity_type text NOT NULL,
  entity_id uuid NULL,
  id_sucursal uuid NULL,
  owner_user_id uuid NULL,
  owner_cliente_id uuid NULL,
  mime_type text NOT NULL,
  bytes bigint NOT NULL,
  original_filename text NULL,
  extension text NULL,
  status text NOT NULL DEFAULT 'temporal' CHECK (status IN ('temporal', 'activo', 'reemplazado', 'eliminado', 'fallido')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_assets_bucket_object
  ON public.storage_assets (bucket_name, object_path);

CREATE INDEX IF NOT EXISTS idx_storage_assets_entity
  ON public.storage_assets (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_storage_assets_scope_status
  ON public.storage_assets (scope_key, status);

CREATE INDEX IF NOT EXISTS idx_storage_assets_owner_cliente
  ON public.storage_assets (owner_cliente_id);

CREATE INDEX IF NOT EXISTS idx_storage_assets_sucursal
  ON public.storage_assets (id_sucursal);

CREATE INDEX IF NOT EXISTS idx_storage_assets_uploaded_by
  ON public.storage_assets (uploaded_by);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'fn_set_updated_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_storage_assets'
      AND tgrelid = 'public.storage_assets'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_storage_assets
      BEFORE UPDATE ON public.storage_assets
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

ALTER TABLE public.promociones
  ADD COLUMN IF NOT EXISTS imagen_principal_asset_id uuid NULL,
  ADD COLUMN IF NOT EXISTS imagen_principal_path text NULL,
  ADD COLUMN IF NOT EXISTS imagen_mobile_asset_id uuid NULL,
  ADD COLUMN IF NOT EXISTS imagen_mobile_path text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_promociones_img_principal_asset'
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT fk_promociones_img_principal_asset
      FOREIGN KEY (imagen_principal_asset_id)
      REFERENCES public.storage_assets(id_asset)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_promociones_img_mobile_asset'
  ) THEN
    ALTER TABLE public.promociones
      ADD CONSTRAINT fk_promociones_img_mobile_asset
      FOREIGN KEY (imagen_mobile_asset_id)
      REFERENCES public.storage_assets(id_asset)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.personas
  ADD COLUMN IF NOT EXISTS foto_perfil_asset_id uuid NULL,
  ADD COLUMN IF NOT EXISTS foto_perfil_path text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_personas_foto_perfil_asset'
  ) THEN
    ALTER TABLE public.personas
      ADD CONSTRAINT fk_personas_foto_perfil_asset
      FOREIGN KEY (foto_perfil_asset_id)
      REFERENCES public.storage_assets(id_asset)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'imagenes_publicas',
      'imagenes_publicas',
      TRUE,
      5242880,
      ARRAY[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/svg+xml'
      ]::text[]
    )
    ON CONFLICT (id) DO UPDATE
    SET
      public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'imagenes_privadas',
      'imagenes_privadas',
      FALSE,
      5242880,
      ARRAY[
        'image/jpeg',
        'image/png',
        'image/webp'
      ]::text[]
    )
    ON CONFLICT (id) DO UPDATE
    SET
      public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'storage'
        AND tablename = 'objects'
        AND policyname = 'storage_public_read_imagenes_publicas'
    ) THEN
      CREATE POLICY storage_public_read_imagenes_publicas
        ON storage.objects
        FOR SELECT
        TO anon, authenticated
        USING (bucket_id = 'imagenes_publicas');
    END IF;
  END IF;
END $$;

COMMIT;
