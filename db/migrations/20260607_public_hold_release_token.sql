-- Habilita validacion segura de liberacion publica de holds.
ALTER TABLE public.citas_grupos
  ADD COLUMN IF NOT EXISTS release_token_hash text,
  ADD COLUMN IF NOT EXISTS release_token_created_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_citas_grupos_release_token_hash
  ON public.citas_grupos (release_token_hash)
  WHERE release_token_hash IS NOT NULL;
