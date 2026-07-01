DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'incluye_isv_snapshot'
  ) THEN
    RAISE EXCEPTION 'incluye_isv_snapshot missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_citas_detalles_isv_formula'
      AND conrelid = 'public.citas_detalles'::regclass
  ) THEN
    RAISE EXCEPTION 'ISV constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_citas_detalles_normalizar'
      AND tgrelid = 'public.citas_detalles'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'detail normalize trigger missing';
  END IF;

  IF (
    SELECT precio_referencia_hnl
    FROM public.citas_detalles
    WHERE id_cita_detalle = '88888888-8888-4888-8888-888888888888'
  ) <> 300 THEN
    RAISE EXCEPTION 'backfill precio_referencia_hnl 0 -> 300 failed';
  END IF;

  IF (
    SELECT id_grupo_cita
    FROM public.payment_intents
    WHERE id_intent = '55555555-5555-4555-8555-555555555555'
  ) <> '99999999-9999-4999-8999-999999999999'::uuid THEN
    RAISE EXCEPTION 'payment intent group backfill failed';
  END IF;
END $$;

INSERT INTO public.citas_detalles (
  id_cita_detalle,
  id_cita,
  id_servicio,
  id_tarifa,
  cantidad,
  duracion_min,
  buffer_min,
  precio_referencia_hnl,
  precio_unitario_hnl,
  subtotal_hnl,
  descuento_hnl,
  nombre_servicio_snapshot
)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '77777777-7777-4777-8777-777777777777',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '44444444-4444-4444-8444-444444444444',
  1,
  30,
  5,
  300,
  300,
  300,
  0,
  'Corte fixture'
)
ON CONFLICT (id_cita_detalle) DO NOTHING;

DO $$
DECLARE
  v_detail record;
  v_cita record;
  v_grupo record;
  v_expected_group_total numeric;
BEGIN
  SELECT *
  INTO v_detail
  FROM public.citas_detalles
  WHERE id_cita_detalle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  IF v_detail.incluye_isv_snapshot IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'incluye_isv_snapshot trigger mismatch';
  END IF;
  IF v_detail.isv_hnl <> 45.00 OR v_detail.total_linea_hnl <> 345.00 THEN
    RAISE EXCEPTION 'ISV trigger mismatch: %, %', v_detail.isv_hnl, v_detail.total_linea_hnl;
  END IF;

  SELECT subtotal_servicios_hnl, total_pagar_hnl, duracion_total_min, buffer_total_min
  INTO v_cita
  FROM public.citas
  WHERE id_cita = '77777777-7777-4777-8777-777777777777';

  IF v_cita.subtotal_servicios_hnl <> 300.00 OR v_cita.total_pagar_hnl <> 345.00 THEN
    RAISE EXCEPTION 'cita recalculation mismatch: %, %', v_cita.subtotal_servicios_hnl, v_cita.total_pagar_hnl;
  END IF;
  IF v_cita.duracion_total_min <> 30 OR v_cita.buffer_total_min <> 5 THEN
    RAISE EXCEPTION 'cita timing recalculation mismatch';
  END IF;

  SELECT total_hnl, estado_grupo_codigo
  INTO v_grupo
  FROM public.citas_grupos
  WHERE id_grupo_cita = '99999999-9999-4999-8999-999999999999';

  SELECT COALESCE(SUM(total_pagar_hnl), 0)
  INTO v_expected_group_total
  FROM public.citas
  WHERE id_grupo_cita = '99999999-9999-4999-8999-999999999999'
    AND deleted_at IS NULL;

  IF v_grupo.total_hnl <> v_expected_group_total OR v_grupo.estado_grupo_codigo <> 'activo' THEN
    RAISE EXCEPTION 'grupo sync mismatch: %, %', v_grupo.total_hnl, v_grupo.estado_grupo_codigo;
  END IF;
END $$;
