-- QA-MP-01C: lecturas puras de saldo y materializacion concurrente segura.
-- Esta migracion debe desplegarse coordinadamente con el backend QA-MP-01C.

BEGIN;

CREATE OR REPLACE VIEW public.vw_points_balance AS
WITH ledger_balance AS (
  SELECT
    pt.id_cliente,
    COALESCE(SUM(pt.puntos), 0::bigint) AS ledger_points
  FROM public.points_transactions pt
  GROUP BY pt.id_cliente
),
pending_expired_cycles AS (
  SELECT
    pc.id_cliente,
    pc.id_cycle,
    COALESCE(SUM(pt.puntos), 0::bigint) AS remaining_points
  FROM public.points_cycles pc
  JOIN public.points_transactions pt
    ON pt.id_cycle = pc.id_cycle
  WHERE pc.estado_ciclo_codigo = 'activo'
    AND pc.vence_at IS NOT NULL
    AND pc.vence_at <= now()
  GROUP BY pc.id_cliente, pc.id_cycle
),
pending_expiration_by_client AS (
  SELECT
    pec.id_cliente,
    COALESCE(
      SUM(
        CASE
          WHEN pec.remaining_points > 0 THEN pec.remaining_points
          ELSE 0::bigint
        END
      ),
      0::bigint
    ) AS pending_expired_points
  FROM pending_expired_cycles pec
  GROUP BY pec.id_cliente
)
SELECT
  lb.id_cliente,
  (
    lb.ledger_points
    - COALESCE(pe.pending_expired_points, 0::bigint)
  )::integer AS balance_puntos
FROM ledger_balance lb
LEFT JOIN pending_expiration_by_client pe
  ON pe.id_cliente = lb.id_cliente;

COMMENT ON VIEW public.vw_points_balance IS
  'Saldo efectivo firmado: excluye remanentes positivos de ciclos activos vencidos sin producir escrituras.';

CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(
  p_id_cliente uuid DEFAULT NULL::uuid
)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  v_cycle record;
  v_balance integer;
  v_total integer := 0;
BEGIN
  FOR v_cycle IN
    SELECT
      pc.id_cycle,
      pc.id_cliente,
      pc.vence_at
    FROM public.points_cycles pc
    WHERE pc.estado_ciclo_codigo = 'activo'
      AND pc.vence_at <= now()
      AND (p_id_cliente IS NULL OR pc.id_cliente = p_id_cliente)
    ORDER BY pc.id_cycle
    FOR UPDATE OF pc
  LOOP
    SELECT COALESCE(SUM(pt.puntos), 0)::integer
      INTO v_balance
    FROM public.points_transactions pt
    WHERE pt.id_cycle = v_cycle.id_cycle;

    IF v_balance > 0 THEN
      INSERT INTO public.points_transactions (
        id_cliente,
        id_cycle,
        tipo_puntos_codigo,
        puntos,
        vence_at,
        motivo,
        created_at,
        updated_at
      )
      VALUES (
        v_cycle.id_cliente,
        v_cycle.id_cycle,
        'vencimiento',
        v_balance,
        v_cycle.vence_at,
        'Vencimiento automatico del ciclo',
        now(),
        now()
      )
      ON CONFLICT (id_cycle, tipo_puntos_codigo)
        WHERE id_cycle IS NOT NULL
          AND tipo_puntos_codigo = 'vencimiento'
      DO NOTHING;
    END IF;

    UPDATE public.points_cycles
    SET estado_ciclo_codigo = 'expirado',
        updated_at = now()
    WHERE id_cycle = v_cycle.id_cycle
      AND estado_ciclo_codigo = 'activo';

    IF FOUND THEN
      v_total := v_total + 1;
    END IF;
  END LOOP;

  RETURN v_total;
END;
$function$;

COMMIT;

-- Reversion manual no aplicada:
--
-- CREATE OR REPLACE VIEW public.vw_points_balance AS
-- SELECT
--   pt.id_cliente,
--   COALESCE(SUM(pt.puntos), 0::bigint)::integer AS balance_puntos
-- FROM public.points_transactions pt
-- GROUP BY pt.id_cliente;
--
-- COMMENT ON VIEW public.vw_points_balance IS
--   'Saldo calculado sobre puntos cuyo signo ya fue normalizado por tr_points_tx_apply_tipo_sign.';
--
-- CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(
--   p_id_cliente uuid DEFAULT NULL::uuid
-- )
-- RETURNS integer
-- LANGUAGE plpgsql
-- AS $function$
-- DECLARE
--   v_cycle record;
--   v_balance integer;
--   v_total integer := 0;
-- BEGIN
--   FOR v_cycle IN
--     SELECT pc.id_cycle, pc.id_cliente, pc.vence_at
--     FROM public.points_cycles pc
--     WHERE pc.estado_ciclo_codigo = 'activo'
--       AND pc.vence_at <= now()
--       AND (p_id_cliente IS NULL OR pc.id_cliente = p_id_cliente)
--   LOOP
--     SELECT COALESCE(SUM(pt.puntos), 0)::integer
--       INTO v_balance
--     FROM public.points_transactions pt
--     WHERE pt.id_cycle = v_cycle.id_cycle;
--
--     IF v_balance > 0
--       AND NOT EXISTS (
--         SELECT 1
--         FROM public.points_transactions pt
--         WHERE pt.id_cycle = v_cycle.id_cycle
--           AND pt.tipo_puntos_codigo = 'vencimiento'
--       )
--     THEN
--       INSERT INTO public.points_transactions (
--         id_cliente,
--         id_cycle,
--         tipo_puntos_codigo,
--         puntos,
--         vence_at,
--         motivo,
--         created_at,
--         updated_at
--       )
--       VALUES (
--         v_cycle.id_cliente,
--         v_cycle.id_cycle,
--         'vencimiento',
--         v_balance,
--         v_cycle.vence_at,
--         'Vencimiento automatico del ciclo',
--         now(),
--         now()
--       );
--     END IF;
--
--     UPDATE public.points_cycles
--     SET estado_ciclo_codigo = 'expirado',
--         updated_at = now()
--     WHERE id_cycle = v_cycle.id_cycle
--       AND estado_ciclo_codigo = 'activo';
--
--     v_total := v_total + 1;
--   END LOOP;
--
--   RETURN v_total;
-- END;
-- $function$;
