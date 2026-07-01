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

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_recalc_cita_paquetes'
      AND tgrelid = 'public.citas_paquetes'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'package recalc trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'citas_detalles'
      AND indexname = 'idx_citas_detalles_origen_item'
  ) THEN
    RAISE EXCEPTION 'origen item index missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_citas_detalles_normalizar'
      AND pg_get_functiondef(p.oid) LIKE '%MF2A3_CITA_DETALLE_SNAPSHOT_FISCAL_INMUTABLE%'
  ) THEN
    RAISE EXCEPTION 'MF2A3 fiscal snapshot guard missing';
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
  incluye_isv_snapshot,
  isv_porcentaje,
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
  false,
  0,
  'Corte fixture'
)
ON CONFLICT (id_cita_detalle) DO NOTHING;

INSERT INTO public.citas (
  id_cita,
  id_grupo_cita,
  id_sucursal,
  id_empleado_barbero,
  inicio_at,
  fin_at,
  duracion_total_min,
  buffer_total_min,
  subtotal_servicios_hnl,
  total_pagar_hnl
)
VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '99999999-9999-4999-8999-999999999999',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  '2026-07-15T17:00:00Z',
  '2026-07-15T17:35:00Z',
  30,
  5,
  0,
  0
)
ON CONFLICT (id_cita) DO NOTHING;

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
  incluye_isv_snapshot,
  isv_porcentaje,
  nombre_servicio_snapshot
)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '44444444-4444-4444-8444-444444444444',
  1,
  30,
  5,
  300,
  300,
  300,
  0,
  false,
  15,
  'Corte fixture'
)
ON CONFLICT (id_cita_detalle) DO NOTHING;

UPDATE public.citas_detalles
SET descuento_hnl = 0
WHERE id_cita_detalle IN (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
);

DO $$
DECLARE
  v_detail record;
  v_taxed_detail record;
  v_cita record;
  v_taxed_cita record;
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
  IF v_detail.isv_porcentaje <> 0.00 OR v_detail.isv_hnl <> 0.00 OR v_detail.total_linea_hnl <> 300.00 THEN
    RAISE EXCEPTION 'ISV disabled trigger mismatch: %, %, %', v_detail.isv_porcentaje, v_detail.isv_hnl, v_detail.total_linea_hnl;
  END IF;

  SELECT *
  INTO v_taxed_detail
  FROM public.citas_detalles
  WHERE id_cita_detalle = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  IF v_taxed_detail.incluye_isv_snapshot IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'incluye_isv_snapshot additional trigger mismatch';
  END IF;
  IF v_taxed_detail.isv_porcentaje <> 15.00 OR v_taxed_detail.isv_hnl <> 45.00 OR v_taxed_detail.total_linea_hnl <> 345.00 THEN
    RAISE EXCEPTION 'ISV enabled trigger mismatch: %, %, %', v_taxed_detail.isv_porcentaje, v_taxed_detail.isv_hnl, v_taxed_detail.total_linea_hnl;
  END IF;

  SELECT subtotal_servicios_hnl, total_pagar_hnl, duracion_total_min, buffer_total_min
  INTO v_cita
  FROM public.citas
  WHERE id_cita = '77777777-7777-4777-8777-777777777777';

  IF v_cita.subtotal_servicios_hnl <> 300.00 OR v_cita.total_pagar_hnl <> 300.00 THEN
    RAISE EXCEPTION 'cita recalculation mismatch: %, %', v_cita.subtotal_servicios_hnl, v_cita.total_pagar_hnl;
  END IF;
  IF v_cita.duracion_total_min <> 30 OR v_cita.buffer_total_min <> 5 THEN
    RAISE EXCEPTION 'cita timing recalculation mismatch';
  END IF;

  SELECT subtotal_servicios_hnl, total_pagar_hnl
  INTO v_taxed_cita
  FROM public.citas
  WHERE id_cita = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  IF v_taxed_cita.subtotal_servicios_hnl <> 300.00 OR v_taxed_cita.total_pagar_hnl <> 345.00 THEN
    RAISE EXCEPTION 'taxed cita recalculation mismatch: %, %', v_taxed_cita.subtotal_servicios_hnl, v_taxed_cita.total_pagar_hnl;
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

UPDATE public.citas_detalles
SET descuento_hnl = 50
WHERE id_cita_detalle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

DO $$
DECLARE
  v_detail record;
BEGIN
  SELECT incluye_isv_snapshot, isv_porcentaje, isv_hnl, total_linea_hnl
  INTO v_detail
  FROM public.citas_detalles
  WHERE id_cita_detalle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  IF v_detail.incluye_isv_snapshot IS DISTINCT FROM false
     OR v_detail.isv_porcentaje <> 0.00
     OR v_detail.isv_hnl <> 0.00
     OR v_detail.total_linea_hnl <> 250.00 THEN
    RAISE EXCEPTION 'false/0 snapshot was reactivated after discount update: %, %, %, %',
      v_detail.incluye_isv_snapshot,
      v_detail.isv_porcentaje,
      v_detail.isv_hnl,
      v_detail.total_linea_hnl;
  END IF;

  BEGIN
    UPDATE public.citas_detalles
    SET isv_porcentaje = 15
    WHERE id_cita_detalle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    RAISE EXCEPTION 'snapshot fiscal immutability update did not fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'MF2A3_CITA_DETALLE_SNAPSHOT_FISCAL_INMUTABLE' THEN
        RAISE;
      END IF;
  END;
END $$;
