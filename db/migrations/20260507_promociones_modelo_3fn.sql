BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- AM: Fase 1 - Normalizacion 3FN de promociones (solo capa de datos, sin logica de negocio compleja).

-- 1) Columnas faltantes en reglas de agendamiento
ALTER TABLE IF EXISTS public.promociones_reglas_agendamiento
  ADD COLUMN IF NOT EXISTS modo_aplicacion_codigo text NOT NULL DEFAULT 'automatico',
  ADD COLUMN IF NOT EXISTS min_subtotal_hnl numeric(12,2),
  ADD COLUMN IF NOT EXISTS max_descuento_hnl numeric(12,2);

UPDATE public.promociones_reglas_agendamiento
SET modo_aplicacion_codigo = 'automatico'
WHERE modo_aplicacion_codigo IS NULL
   OR btrim(modo_aplicacion_codigo) = '';

-- 2) Columna faltante en items de agendamiento
ALTER TABLE IF EXISTS public.promociones_items_agendamiento
  ADD COLUMN IF NOT EXISTS cantidad_minima integer NOT NULL DEFAULT 1;

UPDATE public.promociones_items_agendamiento
SET cantidad_minima = 1
WHERE cantidad_minima IS NULL
   OR cantidad_minima <= 0;

-- Checks nuevos (idempotentes)
DO $$
BEGIN
  IF to_regclass('public.promociones_reglas_agendamiento') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_reglas_agendamiento
        ADD CONSTRAINT ck_promociones_reglas_modo_aplicacion_codigo
        CHECK (modo_aplicacion_codigo IN ('automatico', 'codigo', 'seleccion_cliente', 'admin'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      ALTER TABLE public.promociones_reglas_agendamiento
        ADD CONSTRAINT ck_promociones_reglas_min_subtotal_hnl
        CHECK (min_subtotal_hnl IS NULL OR min_subtotal_hnl >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      ALTER TABLE public.promociones_reglas_agendamiento
        ADD CONSTRAINT ck_promociones_reglas_max_descuento_hnl
        CHECK (max_descuento_hnl IS NULL OR max_descuento_hnl >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF to_regclass('public.promociones_items_agendamiento') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_items_agendamiento
        ADD CONSTRAINT ck_promociones_items_cantidad_minima
        CHECK (cantidad_minima > 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- 3A) Compatibilidad entre reglas
CREATE TABLE IF NOT EXISTS public.promociones_reglas_compatibilidad (
  id_compatibilidad uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_promocion_regla_a uuid NOT NULL,
  id_promocion_regla_b uuid NOT NULL,
  compatible boolean NOT NULL DEFAULT false,
  motivo text,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_promociones_reglas_compatibilidad_distintas
    CHECK (id_promocion_regla_a <> id_promocion_regla_b),
  CONSTRAINT fk_promociones_reglas_compatibilidad_regla_a
    FOREIGN KEY (id_promocion_regla_a)
    REFERENCES public.promociones_reglas_agendamiento(id_promocion_regla)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_promociones_reglas_compatibilidad_regla_b
    FOREIGN KEY (id_promocion_regla_b)
    REFERENCES public.promociones_reglas_agendamiento(id_promocion_regla)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_reglas_compatibilidad_par
  ON public.promociones_reglas_compatibilidad (
    LEAST(id_promocion_regla_a, id_promocion_regla_b),
    GREATEST(id_promocion_regla_a, id_promocion_regla_b)
  );

CREATE INDEX IF NOT EXISTS idx_promociones_reglas_compatibilidad_a
  ON public.promociones_reglas_compatibilidad (id_promocion_regla_a, activo);

CREATE INDEX IF NOT EXISTS idx_promociones_reglas_compatibilidad_b
  ON public.promociones_reglas_compatibilidad (id_promocion_regla_b, activo);

-- 3B) Cupos por regla
CREATE TABLE IF NOT EXISTS public.promociones_reglas_cupos (
  id_promocion_regla_cupo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_promocion_regla uuid NOT NULL,
  id_promocion_sucursal uuid NULL,
  id_empleado_barbero uuid NULL,
  periodo_codigo text NOT NULL,
  limite_usos integer NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_promociones_reglas_cupos_regla
    FOREIGN KEY (id_promocion_regla)
    REFERENCES public.promociones_reglas_agendamiento(id_promocion_regla)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ck_promociones_reglas_cupos_periodo
    CHECK (periodo_codigo IN ('total', 'dia', 'semana', 'mes')),
  CONSTRAINT ck_promociones_reglas_cupos_limite
    CHECK (limite_usos > 0)
);

DO $$
BEGIN
  IF to_regclass('public.promociones_reglas_cupos') IS NOT NULL
     AND to_regclass('public.promociones_sucursal') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_reglas_cupos
        ADD CONSTRAINT fk_promociones_reglas_cupos_promocion_sucursal
        FOREIGN KEY (id_promocion_sucursal)
        REFERENCES public.promociones_sucursal(id_promocion_sucursal)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF to_regclass('public.promociones_reglas_cupos') IS NOT NULL
     AND to_regclass('public.empleados') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_reglas_cupos
        ADD CONSTRAINT fk_promociones_reglas_cupos_empleado_barbero
        FOREIGN KEY (id_empleado_barbero)
        REFERENCES public.empleados(id_empleado)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- 3C) Codigos promocionales
CREATE TABLE IF NOT EXISTS public.promociones_codigos (
  id_promocion_codigo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_promocion_regla uuid NOT NULL,
  codigo text NOT NULL,
  max_usos integer NULL,
  max_usos_por_cliente integer NULL,
  vigencia_desde timestamptz NULL,
  vigencia_hasta timestamptz NULL,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_promociones_codigos_regla
    FOREIGN KEY (id_promocion_regla)
    REFERENCES public.promociones_reglas_agendamiento(id_promocion_regla)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ck_promociones_codigos_max_usos
    CHECK (max_usos IS NULL OR max_usos > 0),
  CONSTRAINT ck_promociones_codigos_max_usos_por_cliente
    CHECK (max_usos_por_cliente IS NULL OR max_usos_por_cliente > 0),
  CONSTRAINT ck_promociones_codigos_vigencia
    CHECK (vigencia_hasta IS NULL OR vigencia_desde IS NULL OR vigencia_hasta >= vigencia_desde)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promociones_codigos_lower
  ON public.promociones_codigos (LOWER(codigo));

CREATE INDEX IF NOT EXISTS idx_promociones_codigos_regla_activo
  ON public.promociones_codigos (id_promocion_regla, activo);

-- 3D) Usos reales / auditoria
CREATE TABLE IF NOT EXISTS public.promociones_usos (
  id_promocion_uso uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cita_promocion uuid NOT NULL,
  id_promocion_regla uuid NOT NULL,
  id_grupo_cita uuid NOT NULL,
  id_cita uuid NULL,
  id_cliente uuid NULL,
  id_persona uuid NULL,
  id_promocion_sucursal uuid NULL,
  fecha_operativa date NOT NULL,
  estado_uso_codigo text NOT NULL DEFAULT 'consumido',
  usado_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_promociones_usos_cita_promocion
    FOREIGN KEY (id_cita_promocion)
    REFERENCES public.citas_promociones(id_cita_promocion)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_promociones_usos_promocion_regla
    FOREIGN KEY (id_promocion_regla)
    REFERENCES public.promociones_reglas_agendamiento(id_promocion_regla)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_promociones_usos_grupo_cita
    FOREIGN KEY (id_grupo_cita)
    REFERENCES public.citas_grupos(id_grupo_cita)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_promociones_usos_estado
    CHECK (estado_uso_codigo IN ('reservado', 'consumido', 'revertido', 'cancelado'))
);

DO $$
BEGIN
  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.citas') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_usos
        ADD CONSTRAINT fk_promociones_usos_cita
        FOREIGN KEY (id_cita)
        REFERENCES public.citas(id_cita)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.clientes') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_usos
        ADD CONSTRAINT fk_promociones_usos_cliente
        FOREIGN KEY (id_cliente)
        REFERENCES public.clientes(id_cliente)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.personas') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_usos
        ADD CONSTRAINT fk_promociones_usos_persona
        FOREIGN KEY (id_persona)
        REFERENCES public.personas(id_persona)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF to_regclass('public.promociones_usos') IS NOT NULL
     AND to_regclass('public.promociones_sucursal') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.promociones_usos
        ADD CONSTRAINT fk_promociones_usos_promocion_sucursal
        FOREIGN KEY (id_promocion_sucursal)
        REFERENCES public.promociones_sucursal(id_promocion_sucursal)
        ON UPDATE CASCADE ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- 4) Indices recomendados
CREATE INDEX IF NOT EXISTS idx_promociones_reglas_promocion_activo
  ON public.promociones_reglas_agendamiento (id_promocion, activo);

CREATE INDEX IF NOT EXISTS idx_promociones_items_regla
  ON public.promociones_items_agendamiento (id_promocion_regla);

CREATE INDEX IF NOT EXISTS idx_promociones_items_servicio
  ON public.promociones_items_agendamiento (id_servicio)
  WHERE id_servicio IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_items_paquete
  ON public.promociones_items_agendamiento (id_paquete)
  WHERE id_paquete IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_restricciones_regla
  ON public.promociones_restricciones_agendamiento (id_promocion_regla);

CREATE INDEX IF NOT EXISTS idx_promociones_sucursal_promocion_sucursal
  ON public.promociones_sucursal (id_promocion, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_promociones_usos_regla_fecha_estado
  ON public.promociones_usos (id_promocion_regla, fecha_operativa, estado_uso_codigo);

CREATE INDEX IF NOT EXISTS idx_promociones_usos_cliente_regla_estado
  ON public.promociones_usos (id_cliente, id_promocion_regla, estado_uso_codigo)
  WHERE id_cliente IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_usos_persona_regla_estado
  ON public.promociones_usos (id_persona, id_promocion_regla, estado_uso_codigo)
  WHERE id_persona IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promociones_usos_promocion_sucursal_fecha_estado
  ON public.promociones_usos (id_promocion_sucursal, fecha_operativa, estado_uso_codigo)
  WHERE id_promocion_sucursal IS NOT NULL;

-- 5) Migracion suave de datos legacy (solo cuando el mapeo es seguro)
DO $$
BEGIN
  IF to_regclass('public.promociones') IS NOT NULL
     AND to_regclass('public.promociones_reglas_agendamiento') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'promociones'
         AND column_name = 'valor_descuento'
     ) THEN

    INSERT INTO public.promociones_reglas_agendamiento (
      id_promocion,
      tipo_promocion_agendamiento_codigo,
      tipo_descuento_codigo,
      aplica_a_codigo,
      valor_descuento,
      es_acumulable,
      prioridad_aplicacion,
      requiere_codigo,
      activo,
      modo_aplicacion_codigo,
      min_subtotal_hnl,
      max_descuento_hnl,
      created_at,
      updated_at
    )
    SELECT
      p.id_promocion,
      CASE
        WHEN p.tipo_promocion IN ('descuento_servicio', 'descuento_paquete') THEN p.tipo_promocion
        ELSE NULL
      END AS tipo_promocion_agendamiento_codigo,
      CASE
        WHEN p.mecanica IN ('porcentaje', 'monto_fijo') THEN p.mecanica
        ELSE NULL
      END AS tipo_descuento_codigo,
      CASE
        WHEN p.aplica_a IN ('servicio', 'paquete') THEN p.aplica_a
        ELSE NULL
      END AS aplica_a_codigo,
      COALESCE(p.valor_descuento, 0)::numeric(12,2) AS valor_descuento,
      FALSE,
      100,
      FALSE,
      TRUE,
      'automatico',
      NULL,
      NULL,
      now(),
      now()
    FROM public.promociones p
    WHERE COALESCE(p.valor_descuento, 0) > 0
      AND p.tipo_promocion IN ('descuento_servicio', 'descuento_paquete')
      AND p.mecanica IN ('porcentaje', 'monto_fijo')
      AND p.aplica_a IN ('servicio', 'paquete')
      AND NOT EXISTS (
        SELECT 1
        FROM public.promociones_reglas_agendamiento pra
        WHERE pra.id_promocion = p.id_promocion
      );
  END IF;
END $$;

-- Migrar items objetivo servicio/paquete -> promociones_items_agendamiento (siempre que exista una regla)
DO $$
BEGIN
  IF to_regclass('public.promociones') IS NOT NULL
     AND to_regclass('public.promociones_reglas_agendamiento') IS NOT NULL
     AND to_regclass('public.promociones_items_agendamiento') IS NOT NULL THEN

    INSERT INTO public.promociones_items_agendamiento (
      id_promocion_regla,
      tipo_item_codigo,
      id_servicio,
      id_paquete,
      cantidad_minima,
      created_at
    )
    SELECT
      pr.id_promocion_regla,
      'servicio',
      p.id_servicio_objetivo,
      NULL,
      1,
      now()
    FROM public.promociones p
    JOIN LATERAL (
      SELECT pra.id_promocion_regla
      FROM public.promociones_reglas_agendamiento pra
      WHERE pra.id_promocion = p.id_promocion
      ORDER BY pra.prioridad_aplicacion ASC, pra.created_at ASC, pra.id_promocion_regla ASC
      LIMIT 1
    ) pr ON TRUE
    WHERE p.id_servicio_objetivo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.promociones_items_agendamiento pia
        WHERE pia.id_promocion_regla = pr.id_promocion_regla
          AND pia.id_servicio = p.id_servicio_objetivo
      );

    INSERT INTO public.promociones_items_agendamiento (
      id_promocion_regla,
      tipo_item_codigo,
      id_servicio,
      id_paquete,
      cantidad_minima,
      created_at
    )
    SELECT
      pr.id_promocion_regla,
      'paquete',
      NULL,
      p.id_paquete_objetivo,
      1,
      now()
    FROM public.promociones p
    JOIN LATERAL (
      SELECT pra.id_promocion_regla
      FROM public.promociones_reglas_agendamiento pra
      WHERE pra.id_promocion = p.id_promocion
      ORDER BY pra.prioridad_aplicacion ASC, pra.created_at ASC, pra.id_promocion_regla ASC
      LIMIT 1
    ) pr ON TRUE
    WHERE p.id_paquete_objetivo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.promociones_items_agendamiento pia
        WHERE pia.id_promocion_regla = pr.id_promocion_regla
          AND pia.id_paquete = p.id_paquete_objetivo
      );
  END IF;
END $$;

-- Migrar codigo_promocional legacy de reglas -> promociones_codigos (sin duplicar por lower(codigo))
INSERT INTO public.promociones_codigos (
  id_promocion_regla,
  codigo,
  max_usos,
  max_usos_por_cliente,
  vigencia_desde,
  vigencia_hasta,
  activo,
  created_at,
  updated_at
)
SELECT
  pra.id_promocion_regla,
  btrim(pra.codigo_promocional) AS codigo,
  pra.max_usos_por_reserva,
  pra.max_usos_por_cliente,
  NULL,
  NULL,
  COALESCE(pra.activo, TRUE),
  now(),
  now()
FROM public.promociones_reglas_agendamiento pra
WHERE pra.codigo_promocional IS NOT NULL
  AND btrim(pra.codigo_promocional) <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM public.promociones_codigos pc
    WHERE lower(pc.codigo) = lower(btrim(pra.codigo_promocional))
  );

COMMIT;

-- =============================================
-- Diagnosticos post-migracion (consultas manuales)
-- =============================================

-- 1) Promociones legacy con valor_descuento que no migraron a regla por mapping no seguro.
-- SELECT p.id_promocion, p.tipo_promocion, p.aplica_a, p.mecanica, p.valor_descuento
-- FROM public.promociones p
-- WHERE COALESCE(p.valor_descuento, 0) > 0
--   AND NOT EXISTS (
--     SELECT 1 FROM public.promociones_reglas_agendamiento pra WHERE pra.id_promocion = p.id_promocion
--   );

-- 2) Posibles codigos duplicados case-insensitive (deberia regresar 0 filas).
-- SELECT lower(codigo) AS codigo_ci, count(*)
-- FROM public.promociones_codigos
-- GROUP BY lower(codigo)
-- HAVING count(*) > 1;

-- 3) Reglas sin items asociados (si aplica al negocio).
-- SELECT pra.id_promocion_regla, pra.id_promocion, pra.tipo_promocion_agendamiento_codigo
-- FROM public.promociones_reglas_agendamiento pra
-- LEFT JOIN public.promociones_items_agendamiento pia
--   ON pia.id_promocion_regla = pra.id_promocion_regla
-- WHERE pia.id_promocion_item IS NULL;

-- 4) Huerfanos potenciales para FKs opcionales de promociones_usos.
-- SELECT pu.*
-- FROM public.promociones_usos pu
-- LEFT JOIN public.clientes c ON c.id_cliente = pu.id_cliente
-- LEFT JOIN public.personas pe ON pe.id_persona = pu.id_persona
-- LEFT JOIN public.promociones_sucursal ps ON ps.id_promocion_sucursal = pu.id_promocion_sucursal
-- WHERE (pu.id_cliente IS NOT NULL AND c.id_cliente IS NULL)
--    OR (pu.id_persona IS NOT NULL AND pe.id_persona IS NULL)
--    OR (pu.id_promocion_sucursal IS NOT NULL AND ps.id_promocion_sucursal IS NULL);

-- 5) Cobertura de indices principales (verificar definiciones en pg_indexes).
-- SELECT schemaname, tablename, indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'promociones_reglas_agendamiento',
--     'promociones_items_agendamiento',
--     'promociones_restricciones_agendamiento',
--     'promociones_reglas_compatibilidad',
--     'promociones_reglas_cupos',
--     'promociones_codigos',
--     'promociones_usos'
--   )
-- ORDER BY tablename, indexname;
