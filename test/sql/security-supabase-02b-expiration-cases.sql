-- AM: SOLO PostgreSQL aislado: fixture55, materialize real 1fc9... y signo real.
-- AM: Datos nuevos sinteticos; cada ejecucion revierte tambien indice y trigger.
BEGIN;
CREATE UNIQUE INDEX qa02b_expiration_unique ON public.points_transactions (id_cycle, tipo_puntos_codigo)
  WHERE id_cycle IS NOT NULL AND tipo_puntos_codigo = 'vencimiento';
CREATE TRIGGER qa02b_expiration_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos
  ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_points_tx_apply_tipo_sign();
INSERT INTO public.tipos_puntos (tipo_puntos_codigo, signo)
SELECT code, sign FROM (VALUES ('ajustar', 1), ('ajuste_resta', -1), ('vencimiento', -1)) v(code, sign)
WHERE NOT EXISTS (SELECT 1 FROM public.tipos_puntos t WHERE t.tipo_puntos_codigo = v.code);
INSERT INTO public.clientes (id_cliente) VALUES
  ('b0200000-0000-0000-0000-000000000001'),
  ('b0200000-0000-0000-0000-000000000002'),
  ('b0200000-0000-0000-0000-000000000003');
INSERT INTO public.points_cycles (id_cycle, id_cliente, primer_acumulado_at, vence_at, estado_ciclo_codigo)
SELECT cycle, client, now() - interval '13 months', now() - interval '13 months' + interval '12 months', 'activo'
FROM (VALUES
  ('b0200000-0000-0000-0000-000000000101'::uuid, 'b0200000-0000-0000-0000-000000000001'::uuid),
  ('b0200000-0000-0000-0000-000000000102'::uuid, 'b0200000-0000-0000-0000-000000000002'::uuid),
  ('b0200000-0000-0000-0000-000000000103'::uuid, 'b0200000-0000-0000-0000-000000000003'::uuid)
) v(cycle, client);
INSERT INTO public.points_transactions (id_cliente, id_cycle, tipo_puntos_codigo, puntos)
SELECT client, cycle, code, amount FROM (VALUES
  ('b0200000-0000-0000-0000-000000000001'::uuid, 'b0200000-0000-0000-0000-000000000101'::uuid, 'ajustar', 10),
  ('b0200000-0000-0000-0000-000000000001'::uuid, 'b0200000-0000-0000-0000-000000000101'::uuid, 'ajuste_resta', 3),
  ('b0200000-0000-0000-0000-000000000002'::uuid, 'b0200000-0000-0000-0000-000000000102'::uuid, 'ajustar', 4),
  ('b0200000-0000-0000-0000-000000000003'::uuid, 'b0200000-0000-0000-0000-000000000103'::uuid, 'ajustar', 2),
  ('b0200000-0000-0000-0000-000000000003'::uuid, 'b0200000-0000-0000-0000-000000000103'::uuid, 'ajuste_resta', 2)
) v(client, cycle, code, amount);
DO $expiration_cases$
DECLARE v_first integer; v_repeat integer;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13) || chr(10), chr(10))) FROM pg_proc
      WHERE oid = 'public.fn_points_materialize_expired_cycles(uuid)'::regprocedure) <> '1fc9e808d8d6d56570897b5c84480144' THEN
    RAISE EXCEPTION 'QA02B expected real concurrent expiration body';
  END IF;
  IF (SELECT sum(puntos) FROM public.points_transactions WHERE id_cliente = 'b0200000-0000-0000-0000-000000000001') <> 7 THEN
    RAISE EXCEPTION 'QA02B expected signed balance +10-3=7 before expiration';
  END IF;
  v_first := public.fn_points_materialize_expired_cycles('b0200000-0000-0000-0000-000000000001');
  v_repeat := public.fn_points_materialize_expired_cycles('b0200000-0000-0000-0000-000000000001');
  IF v_first IS DISTINCT FROM 1 OR v_repeat IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'QA02B expiration must update once and be idempotent';
  END IF;
  IF (SELECT count(*) FROM public.points_transactions WHERE id_cliente = 'b0200000-0000-0000-0000-000000000001'
      AND tipo_puntos_codigo = 'vencimiento' AND puntos = -7) <> 1
     OR (SELECT sum(puntos) FROM public.points_transactions WHERE id_cliente = 'b0200000-0000-0000-0000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'QA02B expiration must subtract the signed remainder exactly once';
  END IF;
  IF (SELECT estado_ciclo_codigo FROM public.points_cycles WHERE id_cycle = 'b0200000-0000-0000-0000-000000000101') <> 'expirado'
     OR (SELECT estado_ciclo_codigo FROM public.points_cycles WHERE id_cycle = 'b0200000-0000-0000-0000-000000000102') <> 'activo'
     OR (SELECT sum(puntos) FROM public.points_transactions WHERE id_cliente = 'b0200000-0000-0000-0000-000000000002') <> 4 THEN
    RAISE EXCEPTION 'QA02B scoped expiration must preserve the other client';
  END IF;
  IF public.fn_points_materialize_expired_cycles('b0200000-0000-0000-0000-000000000003') <> 1
     OR EXISTS (SELECT 1 FROM public.points_transactions WHERE id_cliente = 'b0200000-0000-0000-0000-000000000003'
       AND tipo_puntos_codigo = 'vencimiento') THEN
    RAISE EXCEPTION 'QA02B zero remainder expires its cycle without another debit';
  END IF;
END;
$expiration_cases$;
ROLLBACK;
