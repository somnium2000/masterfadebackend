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

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_promociones'
      AND column_name = 'id_promocion_codigo'
  ) THEN
    RAISE EXCEPTION 'MF2A4 citas_promociones id_promocion_codigo missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_promociones'
      AND column_name = 'codigo_promocional_snapshot'
  ) THEN
    RAISE EXCEPTION 'MF2A4 citas_promociones codigo snapshot missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'promociones_usos'
      AND column_name = 'id_empleado_barbero'
  ) THEN
    RAISE EXCEPTION 'MF2A4 promociones_usos id_empleado_barbero missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'promociones_usos'
      AND indexname = 'idx_promociones_usos_barbero_periodo'
  ) THEN
    RAISE EXCEPTION 'MF2A4 promociones_usos barbero period index missing';
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

DO $$
BEGIN
  IF to_regclass('app_private.reserva_idempotencia') IS NULL THEN
    RAISE EXCEPTION 'canonical idempotency table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'crear_reserva_canonica_v1'
  ) THEN
    RAISE EXCEPTION 'canonical create RPC missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'confirmar_reserva_pagada_v1'
  ) THEN
    RAISE EXCEPTION 'canonical paid confirmation RPC missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_intents'
      AND column_name = 'paid_at'
  ) THEN
    RAISE EXCEPTION 'payment_intents.paid_at missing';
  END IF;
END $$;

DO $$
DECLARE
  v_result jsonb;
  v_confirm jsonb;
  v_id_grupo uuid;
BEGIN
  SELECT app_private.crear_reserva_canonica_v1(
    jsonb_build_object(
      'request_id', 'abababab-abab-4bab-8bab-abababababab',
      'id_sucursal', '11111111-1111-4111-8111-111111111111',
      'id_persona_titular', '22222222-2222-4222-8222-222222222222',
      'id_cliente_titular', '12121212-1212-4212-8212-121212121212',
      'id_usuario_titular', '13131313-1313-4313-8313-131313131313',
      'origen_codigo', 'cliente_autenticado',
      'integrantes', jsonb_build_array(
        jsonb_build_object(
          'orden_integrante', 1,
          'id_persona', '22222222-2222-4222-8222-222222222222',
          'id_cliente', '12121212-1212-4212-8212-121212121212',
          'id_usuario', '13131313-1313-4313-8313-131313131313',
          'tipo_cliente_codigo', 'autenticado',
          'alias', 'Titular',
          'id_empleado_barbero', '33333333-3333-4333-8333-333333333333',
          'selection_type', 'services',
          'inicio_at', '2027-07-15T15:00:00Z',
          'detalles', jsonb_build_array(
            jsonb_build_object(
              'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'id_tarifa', '44444444-4444-4444-8444-444444444444',
              'cantidad', 1,
              'duracion_min', 30,
              'buffer_min', 5,
              'nombre_servicio_snapshot', 'Corte fixture',
              'precio_referencia_hnl', 300,
              'precio_unitario_hnl', 300,
              'descuento_hnl', 0,
              'incluye_isv_snapshot', false,
              'isv_porcentaje', 0,
              'origen_item_codigo', 'servicio_manual'
            )
          )
        )
      )
    )
  )
  INTO v_result;

  IF (v_result->>'request_id') <> 'abababab-abab-4bab-8bab-abababababab'
     OR (v_result->>'total_pagar_hnl')::numeric <> 300.00 THEN
    RAISE EXCEPTION 'canonical create RPC result mismatch: %', v_result;
  END IF;

  v_id_grupo := (v_result->>'id_grupo_cita')::uuid;

  INSERT INTO public.payment_intents (
    id_intent,
    id_grupo_cita,
    origen_pago_codigo,
    estado_intent_codigo,
    monto_hnl
  )
  VALUES (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    v_id_grupo,
    'cita',
    'creado',
    300.00
  )
  ON CONFLICT (id_intent) DO UPDATE
  SET id_grupo_cita = EXCLUDED.id_grupo_cita,
      origen_pago_codigo = EXCLUDED.origen_pago_codigo,
      estado_intent_codigo = EXCLUDED.estado_intent_codigo,
      monto_hnl = EXCLUDED.monto_hnl;

  SELECT app_private.confirmar_reserva_pagada_v1(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'ci-canonical-paid',
    clock_timestamp()
  )
  INTO v_confirm;

  IF (v_confirm->>'estado_intent_codigo') <> 'confirmado'
     OR (v_confirm->>'id_grupo_cita')::uuid <> v_id_grupo THEN
    RAISE EXCEPTION 'canonical confirm RPC result mismatch: %', v_confirm;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_detalles cd
    JOIN public.citas c ON c.id_cita = cd.id_cita
    WHERE c.id_grupo_cita = v_id_grupo
      AND (
        cd.incluye_isv_snapshot IS DISTINCT FROM false
        OR cd.isv_porcentaje <> 0
        OR cd.isv_hnl <> 0
        OR cd.total_linea_hnl <> 300
      )
  ) THEN
    RAISE EXCEPTION 'canonical RPC reactivated disabled ISV';
  END IF;
END $$;

DO $$
DECLARE
  v_result jsonb;
  v_second jsonb;
  v_id_grupo uuid;
  v_id_cita uuid;
  v_id_hold uuid;
  v_expires_at timestamptz;
  v_reject_message text;
  v_expiry jsonb;
BEGIN
  INSERT INTO public.personas (id_persona, nombres, apellidos)
  VALUES
	    ('25252525-2525-4525-8525-252525252525', 'Cliente Dos', 'Fixture'),
	    ('26262626-2626-4626-8626-262626262626', 'Cliente Tres', 'Fixture'),
	    ('27272727-2727-4727-8727-272727272727', 'Cliente Cuatro', 'Fixture'),
	    ('28282828-2828-4828-8828-282828282828', 'Cliente Cinco', 'Fixture')
  ON CONFLICT (id_persona) DO NOTHING;

  INSERT INTO public.clientes (id_cliente, id_persona)
  VALUES
	    ('15151515-1515-4515-8515-151515151515', '25252525-2525-4525-8525-252525252525'),
	    ('16161616-1616-4616-8616-161616161616', '26262626-2626-4626-8626-262626262626'),
	    ('17171717-1717-4717-8717-171717171717', '27272727-2727-4727-8727-272727272727'),
	    ('18181818-1818-4818-8818-282828282828', '28282828-2828-4828-8828-282828282828')
  ON CONFLICT (id_cliente) DO NOTHING;

  INSERT INTO public.usuarios (id_usuario, id_persona)
  VALUES
	    ('18181818-1818-4818-8818-181818181818', '25252525-2525-4525-8525-252525252525'),
	    ('19191919-1919-4919-8919-191919191919', '26262626-2626-4626-8626-262626262626'),
	    ('1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a', '27272727-2727-4727-8727-272727272727'),
	    ('1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b', '28282828-2828-4828-8828-282828282828')
  ON CONFLICT (id_usuario) DO NOTHING;

  SELECT app_private.crear_reserva_canonica_v1(
    jsonb_build_object(
      'request_id', 'babababa-baba-4aba-8aba-babababababa',
      'id_sucursal', '11111111-1111-4111-8111-111111111111',
      'id_persona_titular', '25252525-2525-4525-8525-252525252525',
      'id_cliente_titular', '15151515-1515-4515-8515-151515151515',
      'id_usuario_titular', '18181818-1818-4818-8818-181818181818',
      'origen_codigo', 'cliente_autenticado',
      'integrantes', jsonb_build_array(jsonb_build_object(
        'orden_integrante', 1,
        'id_persona', '25252525-2525-4525-8525-252525252525',
        'id_cliente', '15151515-1515-4515-8515-151515151515',
        'id_usuario', '18181818-1818-4818-8818-181818181818',
        'tipo_cliente_codigo', 'autenticado',
        'alias', 'Titular',
        'id_empleado_barbero', '33333333-3333-4333-8333-333333333333',
        'selection_type', 'services',
        'inicio_at', '2027-07-16T15:00:00Z',
        'detalles', jsonb_build_array(jsonb_build_object(
          'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'id_tarifa', '44444444-4444-4444-8444-444444444444',
          'cantidad', 1,
          'duracion_min', 30,
          'buffer_min', 5,
          'nombre_servicio_snapshot', 'Corte fixture',
          'precio_referencia_hnl', 300,
          'precio_unitario_hnl', 300,
          'descuento_hnl', 0,
          'incluye_isv_snapshot', false,
          'isv_porcentaje', 0,
          'origen_item_codigo', 'servicio_manual'
        ))
      ))
    )
  )
  INTO v_result;

  v_id_grupo := (v_result->>'id_grupo_cita')::uuid;
  v_id_cita := ((v_result->'bloques')->0->>'id_cita')::uuid;
  v_id_hold := ((v_result->'bloques')->0->>'id_hold')::uuid;
  v_expires_at := (v_result->>'expires_at')::timestamptz;

  INSERT INTO public.citas_promociones (
    id_cita_promocion,
    id_grupo_cita,
    id_cita,
    id_promocion,
    id_promocion_regla,
    aplica_a_codigo,
    nombre_promocion_snapshot,
    tipo_descuento_codigo,
    estado_aplicacion_codigo
  )
  VALUES (
    'adadadad-adad-4dad-8dad-adadadadadad',
    v_id_grupo,
    v_id_cita,
    'abababab-abab-4aba-8aba-abababababab',
    'acacacac-acac-4cac-8cac-acacacacacac',
    'servicio',
    'Promo fixture',
    'monto',
    'aplicada'
  )
  ON CONFLICT (id_cita_promocion) DO NOTHING;

  INSERT INTO public.promociones_usos (
    id_promocion_uso,
    id_cita_promocion,
    id_promocion_regla,
    id_grupo_cita,
    id_cita,
    id_cliente,
    id_persona,
    fecha_operativa,
    estado_uso_codigo
  )
  VALUES (
    'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
    'adadadad-adad-4dad-8dad-adadadadadad',
    'acacacac-acac-4cac-8cac-acacacacacac',
    v_id_grupo,
    v_id_cita,
    '15151515-1515-4515-8515-151515151515',
    '25252525-2525-4525-8525-252525252525',
    '2027-07-16',
    'reservado'
  )
  ON CONFLICT (id_promocion_uso) DO UPDATE
  SET estado_uso_codigo = 'reservado';

  UPDATE public.citas_holds
  SET expires_at = clock_timestamp() - interval '1 minute'
  WHERE id_hold = v_id_hold;

  INSERT INTO public.payment_intents (
    id_intent,
    id_grupo_cita,
    id_hold,
    origen_pago_codigo,
    estado_intent_codigo,
    monto_hnl,
    paid_at
  )
  VALUES (
    'edededed-eded-4ded-8ded-edededededed',
    v_id_grupo,
    v_id_hold,
    'cita',
    'pendiente_confirmacion',
    300,
    NULL
  )
  ON CONFLICT (id_intent) DO UPDATE
  SET estado_intent_codigo = 'pendiente_confirmacion',
      paid_at = NULL;

  SELECT app_private.expirar_reservas_vencidas_v1(500, clock_timestamp(), NULL, NULL, NULL, NULL, NULL)
  INTO v_expiry;

  IF (SELECT estado_cita_codigo FROM public.citas WHERE id_cita = v_id_cita) <> 'expirada' THEN
    RAISE EXCEPTION 'pending_confirmacion without paid_at did not expire';
  END IF;

  IF (SELECT estado_uso_codigo FROM public.promociones_usos WHERE id_promocion_uso = 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae') <> 'revertido' THEN
    RAISE EXCEPTION 'reserved promotion usage was not reverted on expiry: %', v_expiry;
  END IF;

  SELECT app_private.crear_reserva_canonica_v1(
    jsonb_build_object(
      'request_id', 'cacacaca-caca-4aca-8aca-cacacacacaca',
      'id_sucursal', '11111111-1111-4111-8111-111111111111',
      'id_persona_titular', '26262626-2626-4626-8626-262626262626',
      'id_cliente_titular', '16161616-1616-4616-8616-161616161616',
      'id_usuario_titular', '19191919-1919-4919-8919-191919191919',
      'origen_codigo', 'cliente_autenticado',
      'integrantes', jsonb_build_array(jsonb_build_object(
        'orden_integrante', 1,
        'id_persona', '26262626-2626-4626-8626-262626262626',
        'id_cliente', '16161616-1616-4616-8616-161616161616',
        'id_usuario', '19191919-1919-4919-8919-191919191919',
        'tipo_cliente_codigo', 'autenticado',
        'alias', 'Titular',
        'id_empleado_barbero', '33333333-3333-4333-8333-333333333333',
        'selection_type', 'services',
        'inicio_at', '2027-07-17T15:00:00Z',
        'detalles', jsonb_build_array(jsonb_build_object(
          'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'id_tarifa', '44444444-4444-4444-8444-444444444444',
          'cantidad', 1,
          'duracion_min', 30,
          'buffer_min', 5,
          'nombre_servicio_snapshot', 'Corte fixture',
          'precio_referencia_hnl', 300,
          'precio_unitario_hnl', 300,
          'descuento_hnl', 0,
          'incluye_isv_snapshot', false,
          'isv_porcentaje', 0,
          'origen_item_codigo', 'servicio_manual'
        ))
      ))
    )
  )
  INTO v_result;

  v_id_grupo := (v_result->>'id_grupo_cita')::uuid;
  v_id_hold := ((v_result->'bloques')->0->>'id_hold')::uuid;
  v_expires_at := (v_result->>'expires_at')::timestamptz;

  INSERT INTO public.payment_intents (
    id_intent,
    id_grupo_cita,
    id_hold,
    origen_pago_codigo,
    estado_intent_codigo,
    monto_hnl,
    paid_at
  )
  VALUES (
    'efefefef-efef-4fef-8fef-efefefefefef',
    v_id_grupo,
    v_id_hold,
    'cita',
    'pendiente_confirmacion',
    300,
    v_expires_at - interval '1 second'
  )
  ON CONFLICT (id_intent) DO UPDATE
  SET estado_intent_codigo = 'pendiente_confirmacion',
      paid_at = EXCLUDED.paid_at;

  UPDATE public.citas_holds
  SET expires_at = v_expires_at
  WHERE id_hold = v_id_hold;

  PERFORM app_private.expirar_reservas_vencidas_v1(500, v_expires_at + interval '1 minute', NULL, NULL, NULL, NULL, NULL);

  IF (SELECT estado_hold_codigo FROM public.citas_holds WHERE id_hold = v_id_hold) <> 'activo' THEN
    RAISE EXCEPTION 'pending_confirmacion with paid_at inside TTL did not receive grace';
  END IF;

  SELECT app_private.crear_reserva_canonica_v1(
    jsonb_build_object(
      'request_id', 'dadadada-dada-4ada-8ada-dadadadadada',
      'id_sucursal', '11111111-1111-4111-8111-111111111111',
      'id_persona_titular', '27272727-2727-4727-8727-272727272727',
      'id_cliente_titular', '17171717-1717-4717-8717-171717171717',
      'id_usuario_titular', '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a',
      'origen_codigo', 'cliente_autenticado',
      'integrantes', jsonb_build_array(jsonb_build_object(
        'orden_integrante', 1,
        'id_persona', '27272727-2727-4727-8727-272727272727',
        'id_cliente', '17171717-1717-4717-8717-171717171717',
        'id_usuario', '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a',
        'tipo_cliente_codigo', 'autenticado',
        'alias', 'Titular',
        'id_empleado_barbero', NULL,
        'barber_candidate_ids', jsonb_build_array(
          '33333333-3333-4333-8333-333333333333',
          '34343434-3434-4434-8434-343434343434'
        ),
        'selection_type', 'services',
        'inicio_at', '2027-07-15T15:00:00Z',
        'detalles', jsonb_build_array(jsonb_build_object(
          'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'id_tarifa', '44444444-4444-4444-8444-444444444444',
          'cantidad', 1,
          'duracion_min', 30,
          'buffer_min', 5,
          'nombre_servicio_snapshot', 'Corte fixture',
          'precio_referencia_hnl', 300,
          'precio_unitario_hnl', 300,
          'descuento_hnl', 0,
          'incluye_isv_snapshot', false,
          'isv_porcentaje', 0,
          'origen_item_codigo', 'servicio_manual'
        ))
      ))
    )
  )
  INTO v_second;

  IF ((v_second->'bloques')->0->>'id_empleado_barbero')::uuid <> '34343434-3434-4434-8434-343434343434'::uuid THEN
    RAISE EXCEPTION 'autoassign did not select second available barber: %', v_second;
  END IF;

	  PERFORM app_private.crear_reserva_canonica_v1(
	    jsonb_build_object(
	      'request_id', 'eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea',
	      'id_sucursal', '11111111-1111-4111-8111-111111111111',
	      'id_persona_titular', '28282828-2828-4828-8828-282828282828',
	      'id_cliente_titular', '18181818-1818-4818-8818-282828282828',
	      'id_usuario_titular', '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
	      'origen_codigo', 'cliente_autenticado',
	      'integrantes', jsonb_build_array(jsonb_build_object(
	        'orden_integrante', 1,
	        'id_persona', '28282828-2828-4828-8828-282828282828',
	        'id_cliente', '18181818-1818-4818-8818-282828282828',
	        'id_usuario', '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
	        'tipo_cliente_codigo', 'autenticado',
	        'alias', 'Titular',
	        'id_empleado_barbero', '34343434-3434-4434-8434-343434343434',
	        'selection_type', 'services',
	        'inicio_at', '2027-07-19T15:00:00Z',
	        'detalles', jsonb_build_array(jsonb_build_object(
	          'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	          'id_tarifa', '44444444-4444-4444-8444-444444444444',
	          'cantidad', 1,
	          'duracion_min', 30,
	          'buffer_min', 5,
	          'nombre_servicio_snapshot', 'Corte fixture',
	          'precio_referencia_hnl', 300,
	          'precio_unitario_hnl', 300,
	          'descuento_hnl', 0,
	          'incluye_isv_snapshot', false,
	          'isv_porcentaje', 0,
	          'origen_item_codigo', 'servicio_manual'
	        ))
	      ))
	    )
	  );

	  v_reject_message := NULL;
	  BEGIN
	    PERFORM app_private.crear_reserva_canonica_v1(
	      jsonb_build_object(
	        'request_id', 'ebebebeb-ebeb-4beb-8beb-ebebebebebeb',
	        'id_sucursal', '11111111-1111-4111-8111-111111111111',
	        'id_persona_titular', '28282828-2828-4828-8828-282828282828',
	        'id_cliente_titular', '18181818-1818-4818-8818-282828282828',
	        'id_usuario_titular', '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
	        'origen_codigo', 'cliente_autenticado',
	        'integrantes', jsonb_build_array(jsonb_build_object(
	          'orden_integrante', 1,
	          'id_persona', '28282828-2828-4828-8828-282828282828',
	          'id_cliente', '18181818-1818-4818-8818-282828282828',
	          'id_usuario', '1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b',
	          'tipo_cliente_codigo', 'autenticado',
	          'alias', 'Titular',
	          'id_empleado_barbero', '34343434-3434-4434-8434-343434343434',
	          'selection_type', 'services',
	          'inicio_at', '2027-07-20T15:00:00Z',
          'detalles', jsonb_build_array(jsonb_build_object(
            'id_servicio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'id_tarifa', '44444444-4444-4444-8444-444444444444',
            'cantidad', 1,
            'duracion_min', 30,
            'buffer_min', 5,
            'nombre_servicio_snapshot', 'Corte fixture',
            'precio_referencia_hnl', 300,
            'precio_unitario_hnl', 300,
            'descuento_hnl', 0,
            'incluye_isv_snapshot', false,
            'isv_porcentaje', 0,
            'origen_item_codigo', 'servicio_manual'
          ))
        ))
      )
    );
  EXCEPTION
    WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_reject_message = MESSAGE_TEXT;
  END;

  IF v_reject_message <> 'MF_RESERVA_PENDIENTE_EXISTENTE' THEN
    RAISE EXCEPTION 'same client pending group was not rejected: %', v_reject_message;
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
