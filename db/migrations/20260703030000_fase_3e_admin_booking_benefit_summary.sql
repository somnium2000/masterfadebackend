-- Fase 3E - Resumen durable de beneficios para holds administrativos.
-- Rollback:
--   DROP TABLE IF EXISTS public.citas_admin_beneficios_resumen;

CREATE TABLE IF NOT EXISTS public.citas_admin_beneficios_resumen (
  id_grupo_cita uuid PRIMARY KEY
    REFERENCES public.citas_grupos(id_grupo_cita)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  resumen_beneficios jsonb NOT NULL DEFAULT '{}'::jsonb,
  descuento_membresia_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_recompensa_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_promocion_hnl numeric(12,2) NOT NULL DEFAULT 0,
  descuento_cortesia_hnl numeric(12,2) NOT NULL DEFAULT 0,
  total_pagar_hnl numeric(12,2) NOT NULL DEFAULT 0,
  recompensa_context_token text NULL,
  cortesia_aplicada boolean NOT NULL DEFAULT false,
  membresia_aplicada boolean NOT NULL DEFAULT false,
  recompensa_aplicada boolean NOT NULL DEFAULT false,
  promocion_aplicada boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_citas_admin_beneficios_resumen_json
    CHECK (jsonb_typeof(resumen_beneficios) = 'object'),
  CONSTRAINT ck_citas_admin_beneficios_resumen_montos_non_negative
    CHECK (
      descuento_membresia_hnl >= 0
      AND descuento_recompensa_hnl >= 0
      AND descuento_promocion_hnl >= 0
      AND descuento_cortesia_hnl >= 0
      AND total_pagar_hnl >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_citas_admin_beneficios_resumen_recompensa
  ON public.citas_admin_beneficios_resumen (recompensa_aplicada, id_grupo_cita)
  WHERE recompensa_aplicada IS TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_set_updated_at_citas_admin_beneficios_resumen'
      AND tgrelid = 'public.citas_admin_beneficios_resumen'::regclass
  ) THEN
    CREATE TRIGGER tr_set_updated_at_citas_admin_beneficios_resumen
      BEFORE UPDATE ON public.citas_admin_beneficios_resumen
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;
