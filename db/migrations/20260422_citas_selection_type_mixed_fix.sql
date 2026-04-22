BEGIN;

ALTER TABLE public.citas
  DROP CONSTRAINT IF EXISTS ck_citas_selection_type;

ALTER TABLE public.citas
  ADD CONSTRAINT ck_citas_selection_type
  CHECK (selection_type IN ('services', 'package', 'mixed'));

COMMIT;

