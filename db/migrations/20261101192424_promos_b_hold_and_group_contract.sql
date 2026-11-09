BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
BEGIN
  IF to_regclass('public.citas_promociones') IS NULL
     OR to_regclass('public.promociones_usos') IS NULL
     OR to_regclass('public.promociones_reglas_agendamiento') IS NULL
     OR to_regclass('public.citas_holds') IS NULL THEN
    RAISE EXCEPTION 'MF_PROMOS_B_SCHEMA_PREFLIGHT_FAILED';
  END IF;
END
$preflight$;

ALTER TABLE public.citas_promociones
  ADD COLUMN IF NOT EXISTS id_hold uuid,
  ADD COLUMN IF NOT EXISTS calculado_en_codigo text;

ALTER TABLE public.promociones_usos
  ADD COLUMN IF NOT EXISTS id_hold uuid,
  ADD COLUMN IF NOT EXISTS reservado_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS liberado_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.promociones_reglas_agendamiento
  ADD COLUMN IF NOT EXISTS cantidad_requerida integer,
  ADD COLUMN IF NOT EXISTS cantidad_bonificada integer,
  ADD COLUMN IF NOT EXISTS bonificacion_modo_codigo text,
  ADD COLUMN IF NOT EXISTS scope_evaluacion_codigo text DEFAULT 'cita';

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.citas_promociones'::regclass
      AND conname = 'fk_citas_promociones_hold'
  ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT fk_citas_promociones_hold
      FOREIGN KEY (id_hold) REFERENCES public.citas_holds(id_hold)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.citas_promociones'::regclass
      AND conname = 'ck_citas_promociones_calculado_en'
  ) THEN
    ALTER TABLE public.citas_promociones
      ADD CONSTRAINT ck_citas_promociones_calculado_en
      CHECK (calculado_en_codigo IS NULL OR calculado_en_codigo IN ('hold', 'intent_pago', 'confirmacion_pago', 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_usos'::regclass
      AND conname = 'fk_promociones_usos_hold'
  ) THEN
    ALTER TABLE public.promociones_usos
      ADD CONSTRAINT fk_promociones_usos_hold
      FOREIGN KEY (id_hold) REFERENCES public.citas_holds(id_hold)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_usos'::regclass
      AND conname = 'ck_promociones_usos_reserva_fechas'
  ) THEN
    ALTER TABLE public.promociones_usos
      ADD CONSTRAINT ck_promociones_usos_reserva_fechas
      CHECK (
        reservado_expires_at IS NULL
        OR liberado_at IS NULL
        OR liberado_at <= reservado_expires_at
        OR estado_uso_codigo <> 'reservado'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_reglas_agendamiento'::regclass
      AND conname = 'ck_promociones_reglas_bonificacion_modo'
  ) THEN
    ALTER TABLE public.promociones_reglas_agendamiento
      ADD CONSTRAINT ck_promociones_reglas_bonificacion_modo
      CHECK (
        (bonificacion_modo_codigo IS NULL OR bonificacion_modo_codigo IN ('menor_precio', 'mismo_precio', 'manual_backend'))
        AND (tipo_descuento_codigo <> 'bonificacion' OR bonificacion_modo_codigo IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_reglas_agendamiento'::regclass
      AND conname = 'ck_promociones_reglas_cantidades_2x1'
  ) THEN
    ALTER TABLE public.promociones_reglas_agendamiento
      ADD CONSTRAINT ck_promociones_reglas_cantidades_2x1
      CHECK (
        (cantidad_requerida IS NULL OR cantidad_requerida > 0)
        AND (cantidad_bonificada IS NULL OR cantidad_bonificada > 0)
        AND (
          tipo_descuento_codigo <> 'bonificacion'
          OR (
            cantidad_requerida IS NOT NULL
            AND cantidad_bonificada IS NOT NULL
            AND cantidad_requerida > cantidad_bonificada
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_reglas_agendamiento'::regclass
      AND conname = 'ck_promociones_reglas_scope_evaluacion'
  ) THEN
    ALTER TABLE public.promociones_reglas_agendamiento
      ADD CONSTRAINT ck_promociones_reglas_scope_evaluacion
      CHECK (scope_evaluacion_codigo IS NULL OR scope_evaluacion_codigo IN ('cita', 'integrante', 'grupo_cita'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promociones_reglas_agendamiento'::regclass
      AND conname = 'ck_promociones_reglas_scope_requerido_activo'
  ) THEN
    ALTER TABLE public.promociones_reglas_agendamiento
      ADD CONSTRAINT ck_promociones_reglas_scope_requerido_activo
      CHECK (activo IS FALSE OR scope_evaluacion_codigo IS NOT NULL);
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS idx_citas_promociones_hold
  ON public.citas_promociones (id_hold)
  WHERE id_hold IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_usos_hold_estado
  ON public.promociones_usos (id_hold, estado_uso_codigo)
  WHERE id_hold IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_usos_idempotency
  ON public.promociones_usos (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
