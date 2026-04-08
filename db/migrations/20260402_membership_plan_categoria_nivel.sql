-- AM: Categoria visual/comercial para jerarquia de planes sin alterar logica operativa.
ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS categoria_nivel smallint;

-- AM: Backfill seguro para planes existentes.
UPDATE public.membership_plans
SET categoria_nivel = 1
WHERE categoria_nivel IS NULL;

ALTER TABLE public.membership_plans
  ALTER COLUMN categoria_nivel SET DEFAULT 1,
  ALTER COLUMN categoria_nivel SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_membership_plans_categoria_nivel_1_5'
  ) THEN
    ALTER TABLE public.membership_plans
      ADD CONSTRAINT chk_membership_plans_categoria_nivel_1_5
      CHECK (categoria_nivel BETWEEN 1 AND 5);
  END IF;
END
$$;
