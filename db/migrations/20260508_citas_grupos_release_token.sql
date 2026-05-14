BEGIN;

ALTER TABLE public.citas_grupos
  ADD COLUMN IF NOT EXISTS release_token text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_citas_grupos_release_token
  ON public.citas_grupos (release_token)
  WHERE release_token IS NOT NULL;

COMMENT ON COLUMN public.citas_grupos.release_token
  IS 'Token opaco requerido para liberar holds publicos sin sesion autenticada.';

COMMIT;

-- Rollback seguro si se requiere revertir esta fase:
-- BEGIN;
-- DROP INDEX IF EXISTS public.ux_citas_grupos_release_token;
-- ALTER TABLE public.citas_grupos DROP COLUMN IF EXISTS release_token;
-- COMMIT;
