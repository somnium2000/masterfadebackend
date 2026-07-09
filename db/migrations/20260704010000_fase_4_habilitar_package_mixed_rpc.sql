BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtextextended('masterfade:20260704:fase_4_habilitar_package_mixed_rpc', 0)
);

DO $migration$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_occurrences integer;
BEGIN
  IF to_regprocedure('app_private.crear_reserva_canonica_core_v2(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MF_F4_CORE_RPC_MISSING';
  END IF;

  IF to_regclass('public.citas') IS NULL
     OR to_regclass('public.citas_detalles') IS NULL
     OR to_regclass('public.citas_paquetes') IS NULL
     OR to_regclass('public.paquetes') IS NULL
     OR to_regclass('public.paquetes_sucursal') IS NULL
     OR to_regclass('public.paquetes_detalles') IS NULL
     OR to_regclass('public.servicios') IS NULL THEN
    RAISE EXCEPTION 'MF_F4_REQUIRED_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas'
      AND column_name = 'selection_type'
      AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas'
      AND column_name = 'id_paquete'
      AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_detalles'
      AND column_name = 'id_cita_paquete'
      AND udt_name = 'uuid'
  ) THEN
    RAISE EXCEPTION 'MF_F4_REQUIRED_COLUMN_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_paquetes'
      AND column_name = 'id_cita_paquete'
      AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_paquetes'
      AND column_name = 'id_paquete_sucursal'
      AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'citas_paquetes'
      AND column_name = 'precio_lista_hnl'
      AND udt_name = 'numeric'
  ) THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_SNAPSHOT_COLUMN_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'ck_citas_detalles_origen_item'
      AND position('paquete_incluido' IN check_clause) > 0
  ) THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_DETAIL_ORIGIN_NOT_ALLOWED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'ck_citas_paquetes_origen'
      AND position('seleccion_cliente' IN check_clause) > 0
  ) THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_SNAPSHOT_ORIGIN_NOT_ALLOWED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'citas_paquetes'
      AND constraint_name = 'uq_citas_paquetes_un_paquete_por_cita'
      AND constraint_type = 'UNIQUE'
  ) THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_SNAPSHOT_UNIQUE_MISSING';
  END IF;

  SELECT p.oid, pg_get_functiondef(p.oid)
  INTO v_oid, v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'crear_reserva_canonica_core_v2'
    AND pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb'
  LIMIT 1;

  IF v_oid IS NULL OR v_def IS NULL THEN
    RAISE EXCEPTION 'MF_F4_CORE_RPC_DEFINITION_NOT_FOUND';
  END IF;

  IF position('BOOKING_PACKAGE_FLOW_PENDING_2B' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MF_F4_EXPECTED_PACKAGE_BLOCKER_NOT_FOUND';
  END IF;

  v_old := $old$
  v_es_canje_recompensa boolean;
  v_inicio_text text;$old$;

  v_new := $new$
  v_es_canje_recompensa boolean;
  v_selection_type text;
  v_id_paquete uuid;
  v_id_paquete_sucursal uuid;
  v_id_cita_paquete uuid;
  v_det_id_cita_paquete uuid;
  v_paquete_nombre text;
  v_paquete_descripcion text;
  v_paquete_precio numeric;
  v_paquete_duracion_total integer;
  v_inicio_text text;$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_DECLARATION_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
    IF COALESCE(NULLIF(v_integrante->>'selection_type', ''), 'services') <> 'services' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_PACKAGE_FLOW_PENDING_2B';
    END IF;$old$;

  v_new := $new$
    v_selection_type := lower(
      COALESCE(
        NULLIF(btrim(v_integrante->>'selection_type'), ''),
        'services'
      )
    );

    v_id_paquete := NULL;
    v_id_paquete_sucursal := NULL;
    v_id_cita_paquete := NULL;
    v_det_id_cita_paquete := NULL;
    v_paquete_nombre := NULL;
    v_paquete_descripcion := NULL;
    v_paquete_precio := NULL;
    v_paquete_duracion_total := 0;

    IF v_selection_type NOT IN ('services', 'package', 'mixed') THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'MF_RESERVA_SELECTION_TYPE_INVALID';
    END IF;

    IF NULLIF(btrim(v_integrante->>'id_paquete'), '') IS NOT NULL THEN
      BEGIN
        v_id_paquete := NULLIF(btrim(v_integrante->>'id_paquete'), '')::uuid;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'MF_RESERVA_PACKAGE_ID_INVALID';
      END;
    END IF;

    IF v_selection_type = 'services' THEN
      IF v_id_paquete IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_SERVICES_PACKAGE_NOT_ALLOWED';
      END IF;
    ELSE
      IF v_id_paquete IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'MF_RESERVA_PACKAGE_ID_REQUIRED';
      END IF;

      SELECT
        ps.id_paquete_sucursal,
        p.nombre_paquete,
        p.descripcion,
        COALESCE(ps.precio_hnl, p.precio_hnl)
      INTO
        v_id_paquete_sucursal,
        v_paquete_nombre,
        v_paquete_descripcion,
        v_paquete_precio
      FROM public.paquetes p
      JOIN public.paquetes_sucursal ps
        ON ps.id_paquete = p.id_paquete
       AND ps.id_sucursal = v_id_sucursal
       AND ps.activo IS TRUE
       AND ps.visible_publico IS TRUE
      WHERE p.id_paquete = v_id_paquete
        AND p.activo IS TRUE
        AND p.deleted_at IS NULL
      ORDER BY ps.updated_at DESC, ps.id_paquete_sucursal DESC
      LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_PACKAGE_NOT_AVAILABLE';
      END IF;

      IF v_paquete_precio IS NULL OR v_paquete_precio <= 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_PACKAGE_PRICE_INVALID';
      END IF;

      IF (
        SELECT count(*)
        FROM public.paquetes_detalles pd
        WHERE pd.id_paquete = v_id_paquete
      ) < 2 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_PACKAGE_SERVICES_MIN_REQUIRED';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.paquetes_detalles pd
        LEFT JOIN public.servicios s
          ON s.id_servicio = pd.id_servicio
        WHERE pd.id_paquete = v_id_paquete
          AND (
            s.id_servicio IS NULL
            OR s.deleted_at IS NOT NULL
            OR s.activo IS DISTINCT FROM TRUE
            OR s.agendable IS DISTINCT FROM TRUE
          )
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'AGENDA_PACKAGE_SERVICES_INACTIVE';
      END IF;
    END IF;$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_BLOCKER_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      IF v_det_origen NOT IN (
        'servicio_manual', 'servicio_extra', 'plan_incluido', 'recompensa_masterpuntos'
      ) THEN$old$;

  v_new := $new$
      IF v_det_origen NOT IN (
        'servicio_manual',
        'servicio_extra',
        'paquete_incluido',
        'plan_incluido',
        'recompensa_masterpuntos'
      ) THEN$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_ORIGIN_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
    END LOOP;

    v_fin_at := v_inicio_at + make_interval(mins => v_duracion_total + v_buffer_total);$old$;

  v_new := $new$
    END LOOP;

    IF v_selection_type IN ('package', 'mixed') THEN
      IF EXISTS (
        WITH package_items AS (
          SELECT
            pd.id_servicio,
            sum(pd.cantidad)::integer AS cantidad
          FROM public.paquetes_detalles pd
          WHERE pd.id_paquete = v_id_paquete
          GROUP BY pd.id_servicio
        ),
        payload_items AS (
          SELECT
            (d.item->>'id_servicio')::uuid AS id_servicio,
            sum(COALESCE(NULLIF(btrim(d.item->>'cantidad'), '')::integer, 1))::integer AS cantidad
          FROM jsonb_array_elements(v_detalles) AS d(item)
          GROUP BY (d.item->>'id_servicio')::uuid
        )
        SELECT 1
        FROM package_items pi
        LEFT JOIN payload_items pay
          ON pay.id_servicio = pi.id_servicio
        WHERE COALESCE(pay.cantidad, 0) <> pi.cantidad
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_PACKAGE_DETAILS_MISMATCH';
      END IF;

      IF v_selection_type = 'package'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v_detalles) AS d(item)
           WHERE NOT EXISTS (
             SELECT 1
             FROM public.paquetes_detalles pd
             WHERE pd.id_paquete = v_id_paquete
               AND pd.id_servicio = (d.item->>'id_servicio')::uuid
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_PACKAGE_EXTRA_SERVICE_NOT_ALLOWED';
      END IF;

      IF v_selection_type = 'mixed'
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v_detalles) AS d(item)
           WHERE NOT EXISTS (
             SELECT 1
             FROM public.paquetes_detalles pd
             WHERE pd.id_paquete = v_id_paquete
               AND pd.id_servicio = (d.item->>'id_servicio')::uuid
           )
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MF_RESERVA_MIXED_EXTRA_REQUIRED';
      END IF;

      SELECT COALESCE(
        sum(
          NULLIF(btrim(d.item->>'duracion_min'), '')::integer
          * COALESCE(NULLIF(btrim(d.item->>'cantidad'), '')::integer, 1)
        ),
        0
      )::integer
      INTO v_paquete_duracion_total
      FROM jsonb_array_elements(v_detalles) AS d(item)
      WHERE EXISTS (
        SELECT 1
        FROM public.paquetes_detalles pd
        WHERE pd.id_paquete = v_id_paquete
          AND pd.id_servicio = (d.item->>'id_servicio')::uuid
      );
    END IF;

    v_fin_at := v_inicio_at + make_interval(mins => v_duracion_total + v_buffer_total);$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_VALIDATION_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      v_es_canje_recompensa,
      'services',
      NULL,
      v_contacto_nombre,$old$;

  v_new := $new$
      v_es_canje_recompensa,
      v_selection_type,
      v_id_paquete,
      v_contacto_nombre,$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_CITA_VALUES_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
    RETURNING id_cita INTO v_id_cita;

    FOR v_detalle, v_detalle_ordinality IN$old$;

  v_new := $new$
    RETURNING id_cita INTO v_id_cita;

    IF v_selection_type IN ('package', 'mixed') THEN
      INSERT INTO public.citas_paquetes (
        id_cita,
        id_paquete,
        id_paquete_sucursal,
        origen_paquete_codigo,
        nombre_paquete_snapshot,
        descripcion_paquete_snapshot,
        duracion_total_min,
        precio_lista_hnl,
        descuento_hnl,
        isv_porcentaje,
        isv_hnl,
        total_hnl
      )
      VALUES (
        v_id_cita,
        v_id_paquete,
        v_id_paquete_sucursal,
        'seleccion_cliente',
        v_paquete_nombre,
        v_paquete_descripcion,
        v_paquete_duracion_total,
        round(v_paquete_precio, 2),
        0,
        0,
        0,
        round(v_paquete_precio, 2)
      )
      ON CONFLICT (id_cita) DO UPDATE
      SET id_paquete = EXCLUDED.id_paquete,
          id_paquete_sucursal = EXCLUDED.id_paquete_sucursal,
          origen_paquete_codigo = EXCLUDED.origen_paquete_codigo,
          nombre_paquete_snapshot = EXCLUDED.nombre_paquete_snapshot,
          descripcion_paquete_snapshot = EXCLUDED.descripcion_paquete_snapshot,
          duracion_total_min = EXCLUDED.duracion_total_min,
          precio_lista_hnl = EXCLUDED.precio_lista_hnl,
          descuento_hnl = EXCLUDED.descuento_hnl,
          isv_porcentaje = EXCLUDED.isv_porcentaje,
          isv_hnl = EXCLUDED.isv_hnl,
          total_hnl = EXCLUDED.total_hnl
      RETURNING id_cita_paquete INTO v_id_cita_paquete;
    END IF;

    FOR v_detalle, v_detalle_ordinality IN$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_INSERT_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      v_det_origen := COALESCE(NULLIF(btrim(v_detalle->>'origen_item_codigo'), ''), 'servicio_manual');
      v_det_orden := COALESCE($old$;

  v_new := $new$
      v_det_origen := COALESCE(NULLIF(btrim(v_detalle->>'origen_item_codigo'), ''), 'servicio_manual');
      v_det_id_cita_paquete := CASE
        WHEN v_id_cita_paquete IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM public.paquetes_detalles pd
           WHERE pd.id_paquete = v_id_paquete
             AND pd.id_servicio = v_det_id_servicio
         )
          THEN v_id_cita_paquete
        ELSE NULL
      END;
      v_det_orden := COALESCE($new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_DETAIL_PACKAGE_LINK_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      INSERT INTO public.citas_detalles (
        id_cita,
        line_key,$old$;

  v_new := $new$
      INSERT INTO public.citas_detalles (
        id_cita,
        id_cita_paquete,
        line_key,$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_DETAIL_COLUMN_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      VALUES (
        v_id_cita,
        v_det_line_key,$old$;

  v_new := $new$
      VALUES (
        v_id_cita,
        v_det_id_cita_paquete,
        v_det_line_key,$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_DETAIL_VALUE_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
    END LOOP;

    SELECT *
    INTO v_cita
    FROM public.citas c$old$;

  v_new := $new$
    END LOOP;

    IF v_id_cita_paquete IS NOT NULL THEN
      UPDATE public.citas_paquetes cp
      SET duracion_total_min = x.duracion_total_min,
          descuento_hnl = x.descuento_hnl,
          isv_porcentaje = x.isv_porcentaje,
          isv_hnl = x.isv_hnl,
          total_hnl = x.total_hnl
      FROM (
        SELECT
          COALESCE(sum(cd.duracion_min * cd.cantidad), 0)::integer AS duracion_total_min,
          round(COALESCE(sum(cd.descuento_hnl), 0), 2) AS descuento_hnl,
          round(COALESCE(max(cd.isv_porcentaje), 0), 2) AS isv_porcentaje,
          round(COALESCE(sum(cd.isv_hnl), 0), 2) AS isv_hnl,
          round(COALESCE(sum(cd.total_linea_hnl), 0), 2) AS total_hnl
        FROM public.citas_detalles cd
        WHERE cd.id_cita_paquete = v_id_cita_paquete
      ) AS x
      WHERE cp.id_cita_paquete = v_id_cita_paquete;
    END IF;

    SELECT *
    INTO v_cita
    FROM public.citas c$new$;

  v_occurrences := (
    length(v_def) - length(replace(v_def, v_old, ''))
  ) / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'MF_F4_PACKAGE_SNAPSHOT_MARKER_MISMATCH: %', v_occurrences;
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE v_def;
END;
$migration$;

ALTER FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) FROM anon;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) FROM service_role;
REVOKE ALL ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) FROM authenticator;
GRANT EXECUTE ON FUNCTION app_private.crear_reserva_canonica_core_v2(jsonb) TO postgres;

DO $verify$
DECLARE
  v_def text;
  v_security_definer boolean;
  v_config text[];
BEGIN
  SELECT
    pg_get_functiondef(p.oid),
    p.prosecdef,
    p.proconfig
  INTO
    v_def,
    v_security_definer,
    v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'crear_reserva_canonica_core_v2'
    AND pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_FUNCTION_MISSING';
  END IF;

  IF position('BOOKING_PACKAGE_FLOW_PENDING_2B' IN v_def) > 0 THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_OLD_BLOCKER_PRESENT';
  END IF;

  IF position('MF_RESERVA_SELECTION_TYPE_INVALID' IN v_def) = 0
     OR position('MF_RESERVA_PACKAGE_DETAILS_MISMATCH' IN v_def) = 0
     OR position('paquete_incluido' IN v_def) = 0
     OR position('INSERT INTO public.citas_paquetes' IN v_def) = 0
     OR position('id_cita_paquete' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_PATCH_INCOMPLETE';
  END IF;

  IF position($forced$
      v_es_canje_recompensa,
      'services',
      NULL,
      v_contacto_nombre,$forced$ IN v_def) > 0 THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_FORCED_SERVICES_PRESENT';
  END IF;

  IF v_security_definer IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_SECURITY_DEFINER_MISSING';
  END IF;

  IF v_config IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM unnest(v_config) AS cfg(value)
       WHERE cfg.value = 'search_path=pg_catalog, public, app_private'
     ) THEN
    RAISE EXCEPTION 'MF_F4_VERIFY_SEARCH_PATH_INVALID';
  END IF;
END;
$verify$;

COMMIT;

-- Verificación visible posterior.
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_userbyid(p.proowner) AS owner_name,
  p.prosecdef AS security_definer,
  p.proconfig AS function_config,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  position('BOOKING_PACKAGE_FLOW_PENDING_2B' IN pg_get_functiondef(p.oid)) = 0 AS old_blocker_removed,
  position('MF_RESERVA_PACKAGE_DETAILS_MISMATCH' IN pg_get_functiondef(p.oid)) > 0 AS package_validation_present,
  position('INSERT INTO public.citas_paquetes' IN pg_get_functiondef(p.oid)) > 0 AS package_snapshot_present,
  position('paquete_incluido' IN pg_get_functiondef(p.oid)) > 0 AS package_origin_present
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_private'
  AND p.proname = 'crear_reserva_canonica_core_v2'
  AND pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb';
