BEGIN;

DO $mf$
DECLARE
  v_intent uuid := '55555555-5555-4555-8555-555555555555';
  v_group uuid := '99999999-9999-4999-8999-999999999999';
  v_hold_a uuid := '51515151-5151-4151-8151-515151515151';
  v_hold_b uuid := '52525252-5252-4252-8252-525252525252';
  v_protected_until timestamptz;
  v_before_result jsonb;
  v_after_rejected boolean := false;
BEGIN
  UPDATE public.citas_grupos
  SET total_hnl = 600,
      estado_grupo_codigo = 'activo'
  WHERE id_grupo_cita = v_group;

  UPDATE public.citas
  SET estado_cita_codigo = 'en_espera',
      total_pagar_hnl = 300,
      deleted_at = NULL
  WHERE id_grupo_cita = v_group;

  INSERT INTO public.citas_holds (
    id_hold, id_cita, estado_hold_codigo, expires_at
  ) VALUES
    (v_hold_a, '66666666-6666-4666-8666-666666666666', 'activo', clock_timestamp() + interval '30 seconds'),
    (v_hold_b, '77777777-7777-4777-8777-777777777777', 'activo', clock_timestamp() + interval '30 seconds')
  ON CONFLICT (id_cita) DO UPDATE
  SET estado_hold_codigo = 'activo',
      expires_at = EXCLUDED.expires_at;

  SELECT id_hold INTO v_hold_a
  FROM public.citas_holds
  WHERE id_cita = '66666666-6666-4666-8666-666666666666';

  UPDATE public.payment_intents
  SET id_cita = '66666666-6666-4666-8666-666666666666',
      id_grupo_cita = v_group,
      id_hold = v_hold_a,
      origen_pago_codigo = 'cita',
      estado_intent_codigo = 'link_generado',
      monto_hnl = 600,
      moneda_codigo = 'HNL',
      paid_at = NULL,
      expires_at = clock_timestamp() + interval '30 seconds'
  WHERE id_intent = v_intent;

  v_protected_until := app_private.proteger_reserva_pago_v1(v_intent, v_group);

  IF v_protected_until < clock_timestamp() + interval '4 minutes 50 seconds'
     OR v_protected_until > clock_timestamp() + interval '5 minutes 10 seconds' THEN
    RAISE EXCEPTION 'payment protection is not approximately five minutes: %', v_protected_until;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    WHERE c.id_grupo_cita = v_group
      AND h.expires_at <> v_protected_until
  ) THEN
    RAISE EXCEPTION 'group holds do not share the canonical protection deadline';
  END IF;

  IF (SELECT expires_at FROM public.payment_intents WHERE id_intent = v_intent)
     IS DISTINCT FROM v_protected_until THEN
    RAISE EXCEPTION 'intent deadline is not synchronized with holds';
  END IF;

  PERFORM app_private.expirar_reservas_vencidas_v1(
    500, v_protected_until - interval '1 second', NULL, NULL, NULL, NULL, NULL
  );
  IF EXISTS (
    SELECT 1
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    WHERE c.id_grupo_cita = v_group
      AND h.estado_hold_codigo <> 'activo'
  ) THEN
    RAISE EXCEPTION 'slot was released inside the protection window';
  END IF;

  PERFORM app_private.expirar_reservas_vencidas_v1(
    500, v_protected_until + interval '1 second', NULL, NULL, NULL, NULL, NULL
  );
  IF EXISTS (
    SELECT 1
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    WHERE c.id_grupo_cita = v_group
      AND h.estado_hold_codigo <> 'expirado'
  ) THEN
    RAISE EXCEPTION 'slot was not released after the protection window';
  END IF;

  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent)
     <> 'pendiente_confirmacion' THEN
    RAISE EXCEPTION 'unresolved payment intent was expired with its slot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas c
    WHERE c.id_grupo_cita = v_group
      AND c.estado_cita_codigo <> 'expirada'
  ) THEN
    RAISE EXCEPTION 'booking was not expired after the protection window';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.citas c
    LEFT JOIN public.citas_holds h ON h.id_cita = c.id_cita
    WHERE c.id_grupo_cita = v_group
      AND (
        c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
        OR h.estado_hold_codigo = 'activo'
      )
  ) THEN
    RAISE EXCEPTION 'pending payment intent kept the slot blocked';
  END IF;

  SELECT app_private.confirmar_reserva_pagada_v1(
    v_intent,
    'TX-BEFORE-EXPIRY',
    v_protected_until - interval '1 second'
  ) INTO v_before_result;

  IF (v_before_result->>'estado_intent_codigo') <> 'confirmado'
     OR EXISTS (
       SELECT 1 FROM public.citas c
       WHERE c.id_grupo_cita = v_group
         AND c.estado_cita_codigo <> 'confirmada'
     )
     OR EXISTS (
       SELECT 1
       FROM public.citas_holds h
       JOIN public.citas c ON c.id_cita = h.id_cita
       WHERE c.id_grupo_cita = v_group
         AND h.estado_hold_codigo <> 'consumido'
     ) THEN
    RAISE EXCEPTION 'canonical recovery before expiry failed: %', v_before_result;
  END IF;

  UPDATE public.payment_intents
  SET estado_intent_codigo = 'expirado',
      paid_at = NULL
  WHERE id_intent = v_intent;
  UPDATE public.citas SET estado_cita_codigo = 'expirada' WHERE id_grupo_cita = v_group;
  UPDATE public.citas_holds h
  SET estado_hold_codigo = 'expirado'
  FROM public.citas c
  WHERE c.id_grupo_cita = v_group
    AND c.id_cita = h.id_cita;

  BEGIN
    PERFORM app_private.confirmar_reserva_pagada_v1(
      v_intent,
      'TX-AFTER-EXPIRY',
      v_protected_until + interval '1 second'
    );
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      v_after_rejected := SQLERRM = 'MF_PAYMENT_AFTER_HOLD_EXPIRY';
  END;

  IF NOT v_after_rejected THEN
    RAISE EXCEPTION 'payment after expiry was not rejected';
  END IF;

  UPDATE public.citas SET estado_cita_codigo = 'en_espera' WHERE id_grupo_cita = v_group;
  UPDATE public.citas_holds h
  SET estado_hold_codigo = 'activo',
      expires_at = clock_timestamp() + interval '5 minutes'
  FROM public.citas c
  WHERE c.id_grupo_cita = v_group
    AND c.id_cita = h.id_cita;
  UPDATE public.payment_intents
  SET estado_intent_codigo = 'pendiente_confirmacion',
      paid_at = NULL,
      expires_at = clock_timestamp() + interval '5 minutes'
  WHERE id_intent = v_intent;

  PERFORM app_private.confirmar_reserva_pagada_v1(
    v_intent,
    'TX-ACTIVE-NO-PROVIDER-TIMESTAMP',
    NULL
  );

  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'confirmado'
     OR (SELECT paid_at FROM public.payment_intents WHERE id_intent = v_intent) IS NOT NULL THEN
    RAISE EXCEPTION 'active hold confirmation fabricated paid_at';
  END IF;

  PERFORM app_private.expirar_reservas_vencidas_v1(
    500, clock_timestamp() + interval '10 minutes', NULL, NULL, NULL, NULL, NULL
  );
  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'confirmado' THEN
    RAISE EXCEPTION 'confirmed intent was degraded by the global expiry scheduler';
  END IF;

  UPDATE public.citas
  SET estado_cita_codigo = 'en_espera'
  WHERE id_grupo_cita = v_group;
  UPDATE public.citas_holds h
  SET estado_hold_codigo = 'activo',
      expires_at = clock_timestamp() - interval '1 second'
  FROM public.citas c
  WHERE c.id_grupo_cita = v_group
    AND c.id_cita = h.id_cita;
  UPDATE public.payment_intents
  SET estado_intent_codigo = 'creado',
      paid_at = NULL,
      expires_at = clock_timestamp() - interval '1 second'
  WHERE id_intent = v_intent;

  PERFORM app_private.expirar_reservas_vencidas_v1(
    500, clock_timestamp(), NULL, NULL, NULL, NULL, NULL
  );
  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'expirado' THEN
    RAISE EXCEPTION 'created intent did not expire with its slot';
  END IF;

  UPDATE public.citas
  SET estado_cita_codigo = 'pendiente_pago'
  WHERE id_grupo_cita = v_group;
  UPDATE public.citas_holds h
  SET estado_hold_codigo = 'activo',
      expires_at = clock_timestamp() - interval '1 second'
  FROM public.citas c
  WHERE c.id_grupo_cita = v_group
    AND c.id_cita = h.id_cita;
  UPDATE public.payment_intents
  SET estado_intent_codigo = 'link_generado',
      expires_at = clock_timestamp() - interval '1 second'
  WHERE id_intent = v_intent;

  PERFORM app_private.expirar_reservas_vencidas_v1(
    500, clock_timestamp(), NULL, NULL, NULL, NULL, NULL
  );
  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'expirado' THEN
    RAISE EXCEPTION 'link-generated intent did not expire with its slot';
  END IF;
END
$mf$;

DO $mf$
DECLARE
  v_client uuid := '12121212-1212-4212-8212-121212121212';
  v_group uuid := '99999999-9999-4999-8999-999999999999';
  v_intent uuid := '55555555-5555-4555-8555-555555555555';
  v_hold uuid;
  v_now timestamptz := clock_timestamp();
  v_new_reservation jsonb;
  v_new_group uuid;
BEGIN
  UPDATE public.citas_grupos
  SET id_persona_titular = '22222222-2222-4222-8222-222222222222',
      id_cliente_titular = v_client,
      id_usuario_titular = '13131313-1313-4313-8313-131313131313',
      estado_grupo_codigo = 'activo'
  WHERE id_grupo_cita = v_group;

  UPDATE public.citas
  SET estado_cita_codigo = 'pendiente_pago',
      deleted_at = NULL
  WHERE id_cita = '66666666-6666-4666-8666-666666666666';

  INSERT INTO public.citas_holds (id_hold, id_cita, id_usuario, estado_hold_codigo, expires_at)
  VALUES (
    '51515151-5151-4151-8151-515151515151',
    '66666666-6666-4666-8666-666666666666',
    '13131313-1313-4313-8313-131313131313',
    'activo',
    v_now - interval '1 second'
  )
  ON CONFLICT (id_cita) DO UPDATE
  SET id_usuario = EXCLUDED.id_usuario,
      estado_hold_codigo = 'activo',
      expires_at = EXCLUDED.expires_at
  RETURNING id_hold INTO v_hold;

  UPDATE public.payment_intents
  SET id_cita = '66666666-6666-4666-8666-666666666666',
      id_grupo_cita = v_group,
      id_hold = v_hold,
      origen_pago_codigo = 'cita',
      estado_intent_codigo = 'pendiente_confirmacion',
      paid_at = NULL,
      expires_at = v_now - interval '1 second'
  WHERE id_intent = v_intent;

  PERFORM app_private.mf1b1_expirar_reservas_cliente_v1(v_client, v_now);

  IF (SELECT estado_hold_codigo FROM public.citas_holds WHERE id_hold = v_hold) <> 'expirado' THEN
    RAISE EXCEPTION 'client expiry did not release the expired hold';
  END IF;
  IF (SELECT estado_cita_codigo FROM public.citas WHERE id_cita = '66666666-6666-4666-8666-666666666666') <> 'expirada' THEN
    RAISE EXCEPTION 'client expiry did not expire the booking';
  END IF;
  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'pendiente_confirmacion' THEN
    RAISE EXCEPTION 'client expiry degraded an unresolved payment intent';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.citas c
    LEFT JOIN public.citas_holds h ON h.id_cita = c.id_cita
    WHERE c.id_grupo_cita = v_group
      AND (
        c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada', 'en_salon', 'en_atencion')
        OR h.estado_hold_codigo = 'activo'
      )
  ) THEN
    RAISE EXCEPTION 'client expiry left the previous slot blocked';
  END IF;

  SELECT app_private.crear_reserva_canonica_v1(
    jsonb_build_object(
      'request_id', 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
      'id_sucursal', '11111111-1111-4111-8111-111111111111',
      'id_persona_titular', '22222222-2222-4222-8222-222222222222',
      'id_cliente_titular', v_client,
      'id_usuario_titular', '13131313-1313-4313-8313-131313131313',
      'origen_codigo', 'cliente_autenticado',
      'integrantes', jsonb_build_array(
        jsonb_build_object(
          'orden_integrante', 1,
          'id_persona', '22222222-2222-4222-8222-222222222222',
          'id_cliente', v_client,
          'id_usuario', '13131313-1313-4313-8313-131313131313',
          'tipo_cliente_codigo', 'autenticado',
          'alias', 'Titular',
          'id_empleado_barbero', '33333333-3333-4333-8333-333333333333',
          'selection_type', 'services',
          'inicio_at', '2027-09-24T15:00:00Z',
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
  ) INTO v_new_reservation;

  v_new_group := (v_new_reservation->>'id_grupo_cita')::uuid;
  IF v_new_group IS NULL OR v_new_group = v_group THEN
    RAISE EXCEPTION 'client could not create a separate reservation after slot release';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.citas_holds h
    JOIN public.citas c ON c.id_cita = h.id_cita
    WHERE c.id_grupo_cita = v_new_group
      AND h.estado_hold_codigo = 'activo'
  ) THEN
    RAISE EXCEPTION 'new reservation did not obtain its own active hold';
  END IF;
  IF (SELECT estado_intent_codigo FROM public.payment_intents WHERE id_intent = v_intent) <> 'pendiente_confirmacion' THEN
    RAISE EXCEPTION 'new reservation reused or removed the previous pending intent';
  END IF;
END
$mf$;

ROLLBACK;
