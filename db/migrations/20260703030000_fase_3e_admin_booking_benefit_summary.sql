-- Fase 3E - Resumen durable de beneficios para holds administrativos.
-- Ejecutada y auditada manualmente en Supabase masterfade-app (pdzsmkjnyazpkoocjbpw).
-- Rollback:
--   DROP TABLE IF EXISTS public.citas_admin_beneficios_resumen;

CREATE TABLE IF NOT EXISTS public.citas_admin_beneficios_resumen (
  id_grupo_cita uuid NOT NULL,
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
  CONSTRAINT citas_admin_beneficios_resumen_pkey
    PRIMARY KEY (id_grupo_cita),
  CONSTRAINT fk_citas_admin_beneficios_resumen_grupo
    FOREIGN KEY (id_grupo_cita)
    REFERENCES public.citas_grupos(id_grupo_cita)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT ck_citas_admin_beneficios_resumen_json
    CHECK (jsonb_typeof(resumen_beneficios) = 'object'),
  CONSTRAINT ck_citas_admin_beneficios_resumen_montos_non_negative
    CHECK (
      descuento_membresia_hnl >= 0
      AND descuento_recompensa_hnl >= 0
      AND descuento_promocion_hnl >= 0
      AND descuento_cortesia_hnl >= 0
      AND total_pagar_hnl >= 0
    ),
  CONSTRAINT ck_citas_admin_beneficios_resumen_token
    CHECK (
      recompensa_context_token IS NULL
      OR (
        length(btrim(recompensa_context_token)) BETWEEN 1 AND 1200
        AND recompensa_context_token = btrim(recompensa_context_token)
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_citas_admin_beneficios_resumen_recompensa
  ON public.citas_admin_beneficios_resumen (recompensa_aplicada, id_grupo_cita)
  WHERE recompensa_aplicada IS TRUE;

ALTER TABLE public.citas_admin_beneficios_resumen ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.citas_admin_beneficios_resumen FROM PUBLIC;
REVOKE ALL ON TABLE public.citas_admin_beneficios_resumen FROM anon;
REVOKE ALL ON TABLE public.citas_admin_beneficios_resumen FROM authenticated;
REVOKE ALL ON TABLE public.citas_admin_beneficios_resumen FROM service_role;
REVOKE ALL ON TABLE public.citas_admin_beneficios_resumen FROM authenticator;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.citas_admin_beneficios_resumen TO postgres;
GRANT SELECT ON TABLE public.citas_admin_beneficios_resumen TO mf_audit_readonly;
