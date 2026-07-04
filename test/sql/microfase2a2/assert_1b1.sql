DO $mf$
DECLARE
  v_request_id uuid := 'aaaaaaaa-1111-4111-8111-aaaaaaaa1111'::uuid;
  v_state jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'line_key'
      AND data_type = 'text'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'ASSERT_1B1_LINE_KEY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'orden_linea'
      AND data_type = 'integer'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'ASSERT_1B1_ORDEN_LINEA_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_promociones'
      AND column_name IN ('line_key', 'id_promocion_sucursal', 'id_promocion_codigo', 'codigo_promocional_snapshot')
    GROUP BY table_schema, table_name
    HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'ASSERT_1B1_PROMO_TRACE_COLUMNS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'reserva_idempotencia'
      AND column_name IN ('scope', 'request_fingerprint', 'response_payload', 'response_completed_at')
    GROUP BY table_schema, table_name
    HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'ASSERT_1B1_IDEMPOTENCY_COLUMNS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_citas_detalles_cita_line_key'
  ) THEN
    RAISE EXCEPTION 'ASSERT_1B1_LINE_KEY_INDEX_MISSING';
  END IF;

  IF to_regprocedure('app_private.obtener_reserva_idempotente_v1(uuid,text,text)') IS NULL
     OR to_regprocedure('app_private.finalizar_reserva_idempotente_v1(uuid,text,text,jsonb)') IS NULL
     OR to_regprocedure('app_private.crear_reserva_canonica_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT_1B1_FUNCTIONS_MISSING';
  END IF;

  v_state := app_private.obtener_reserva_idempotente_v1(v_request_id, 'ci:test', 'fingerprint-a');
  IF v_state->>'status' NOT IN ('not_found', 'completed') THEN
    RAISE EXCEPTION 'ASSERT_1B1_IDEMPOTENCY_UNEXPECTED_INITIAL_STATUS';
  END IF;

  PERFORM app_private.finalizar_reserva_idempotente_v1(
    v_request_id,
    'ci:test',
    'fingerprint-a',
    jsonb_build_object('status_code', 201, 'data', jsonb_build_object('request_id', v_request_id::text))
  );

  v_state := app_private.obtener_reserva_idempotente_v1(v_request_id, 'ci:test', 'fingerprint-a');
  IF v_state->>'status' <> 'completed'
     OR v_state#>>'{response_payload,data,request_id}' IS DISTINCT FROM v_request_id::text THEN
    RAISE EXCEPTION 'ASSERT_1B1_IDEMPOTENCY_COMPLETED_FAILED';
  END IF;

  v_state := app_private.obtener_reserva_idempotente_v1(v_request_id, 'ci:test', 'fingerprint-b');
  IF v_state->>'status' <> 'payload_mismatch' THEN
    RAISE EXCEPTION 'ASSERT_1B1_IDEMPOTENCY_MISMATCH_FAILED';
  END IF;
END;
$mf$;
