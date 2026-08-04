-- Microfase 3C.0: Corrige el saldo de MasterPuntos usando puntos ya firmados.

CREATE OR REPLACE VIEW public.vw_points_balance AS
SELECT
  pt.id_cliente,
  COALESCE(SUM(pt.puntos), 0::bigint)::integer AS balance_puntos
FROM public.points_transactions pt
GROUP BY pt.id_cliente;

COMMENT ON VIEW public.vw_points_balance IS
  'Saldo calculado sobre puntos cuyo signo ya fue normalizado por tr_points_tx_apply_tipo_sign.';
