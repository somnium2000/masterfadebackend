-- AM: QA-MASTERPUNTOS-PAGO-CONFIRMADO-01. Ejecutar manualmente completa en QA, nunca desde CI.
-- AM: Requiere 20261113024454 ya aplicada. Sin backfill ni cambios a movimientos/ciclos historicos.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamptz)') IS NULL
     OR to_regprocedure('public.fn_points_tx_guard_acumular_final()') IS NULL
     OR to_regprocedure('public.fn_trg_otorgar_puntos_por_cita()') IS NULL THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_PREREQUISITE_REQUIRED';
  END IF;
  IF position('MASTERPUNTOS_CYCLE_ARGUMENT_INVALID' IN pg_get_functiondef(
      'public.fn_points_get_or_create_active_cycle(uuid,integer,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_COMPLETION_CYCLES_MIGRATION_REQUIRED';
  END IF;
  -- AM: Falla cerrado si falta el contrato verificado; no infiere columnas en QA.
  PERFORM c.id_cita, c.id_cliente, c.id_grupo_cita, c.total_pagar_hnl, c.moneda_codigo,
    c.es_canje_recompensa, c.orden_integrante, c.inicio_at FROM public.citas c WHERE false;
  PERFORM cg.id_cliente_titular, cg.origen_codigo FROM public.citas_grupos cg WHERE false;
  PERFORM p.id_payment, p.id_intent, p.estado_pago_codigo, p.provider_tx_id, p.pago_tardio,
    p.monto_hnl, p.moneda_codigo, p.paid_at FROM public.payments p WHERE false;
  PERFORM pi.id_provider, pi.id_membership_order, pi.origen_pago_codigo, pi.id_cita,
    pi.id_grupo_cita, pi.estado_intent_codigo FROM public.payment_intents pi WHERE false;
  PERFORM sp.id_payment, sp.id_suscripcion, sp.estado, sp.monto_hnl, sp.moneda_codigo, sp.paid_at
    FROM public.subscription_payments sp WHERE false;
  PERFORM mpo.id_order, mpo.id_suscripcion, mpo.id_cliente, mpo.estado_orden_codigo, mpo.total_hnl,
    mpo.moneda_codigo, mpo.paid_at FROM public.membership_purchase_orders mpo WHERE false;
  PERFORM sc.id_cita, sc.id_cliente, sc.id_suscripcion, sc.item_tipo, sc.id_servicio,
    sc.coverage_status, sc.invalidado, sc.created_at FROM public.subscription_consumptions sc WHERE false;
  PERFORM pe.id_intent, pe.evento_tipo, pe.payload_esencial FROM public.payment_events pe WHERE false;
  PERFORM pp.codigo FROM public.payment_providers pp WHERE false;
  IF NOT EXISTS (SELECT 1 FROM pg_index
      WHERE indrelid = 'public.points_transactions'::regclass AND indisunique AND indisvalid
        AND pg_get_indexdef(indexrelid) ~ '\(id_cita, tipo_puntos_codigo\)'
        AND pg_get_expr(indpred, indrelid) LIKE '%acumular%') THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_UNIQUE_APPOINTMENT_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
      AND tgfoid = 'public.fn_points_tx_guard_acumular_final()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_GUARD_REQUIRED';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION app_private.points_payment_valid_v1(p_id_payment uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    JOIN public.payment_intents pi ON pi.id_intent = p.id_intent
    JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
    WHERE p.id_payment = p_id_payment
      AND p.estado_pago_codigo IN ('capturado', 'conciliado', 'manual_pagado')
      AND p.pago_tardio IS FALSE AND pi.estado_intent_codigo = 'confirmado'
      AND p.paid_at IS NOT NULL AND p.paid_at <= clock_timestamp()
      AND p.monto_hnl > 0 AND p.monto_hnl = pi.monto_hnl
      AND p.moneda_codigo = pi.moneda_codigo
      AND NULLIF(btrim(p.provider_tx_id), '') IS NOT NULL
      AND pp.codigo IN ('pixelpay', 'todopago')
      AND p.provider_tx_id NOT LIKE 'tx_mock_%' AND p.provider_tx_id NOT LIKE 'todopago_sim_%'
      AND NOT EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.id_intent = pi.id_intent
        AND (pe.evento_tipo IN ('payment.simulated.result', 'membership.simulated.result')
          OR pe.payload_esencial->>'mode' = 'preprod_simulated'))
  )
$function$;

CREATE OR REPLACE FUNCTION app_private.points_appointment_paid_v1(p_id_cita uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.citas c WHERE c.id_cita = p_id_cita
      AND c.deleted_at IS NULL AND c.estado_cita_codigo = 'confirmada'
      AND NOT (COALESCE(c.es_canje_recompensa, false) AND COALESCE(c.orden_integrante, 1) <= 1)
      AND (
        (c.total_pagar_hnl > 0 AND EXISTS (
          SELECT 1 FROM public.payment_intents pi JOIN public.payments p ON p.id_intent = pi.id_intent
          WHERE pi.origen_pago_codigo = 'cita' AND app_private.points_payment_valid_v1(p.id_payment)
            AND pi.moneda_codigo = c.moneda_codigo
            AND (
              (c.id_grupo_cita IS NULL AND pi.id_grupo_cita IS NULL AND pi.id_cita = c.id_cita
                AND pi.monto_hnl = c.total_pagar_hnl)
              OR (c.id_grupo_cita IS NOT NULL
                AND ((pi.id_grupo_cita = c.id_grupo_cita AND (pi.id_cita IS NULL OR EXISTS (
                  SELECT 1 FROM public.citas anchor WHERE anchor.id_cita = pi.id_cita
                    AND anchor.id_grupo_cita = c.id_grupo_cita AND anchor.deleted_at IS NULL)))
                  OR (pi.id_grupo_cita IS NULL AND EXISTS (
                  SELECT 1 FROM public.citas anchor WHERE anchor.id_cita = pi.id_cita
                    AND anchor.id_grupo_cita = c.id_grupo_cita AND anchor.deleted_at IS NULL)))
                AND pi.monto_hnl = (SELECT sum(g.total_pagar_hnl) FROM public.citas g
                  WHERE g.id_grupo_cita = c.id_grupo_cita AND g.deleted_at IS NULL))
            )
        ))
        OR EXISTS (
          SELECT 1 FROM public.subscription_consumptions sc
          JOIN public.subscriptions s ON s.id_suscripcion = sc.id_suscripcion AND s.id_cliente = sc.id_cliente
          JOIN public.subscription_payments sp ON sp.id_suscripcion = s.id_suscripcion
          JOIN public.payments p ON p.id_payment = sp.id_payment
          JOIN public.payment_intents pi ON pi.id_intent = p.id_intent AND pi.origen_pago_codigo = 'membership'
          JOIN public.membership_purchase_orders mpo ON mpo.id_order = pi.id_membership_order
            AND mpo.id_suscripcion = s.id_suscripcion AND mpo.id_cliente = s.id_cliente
          WHERE sc.id_cita = c.id_cita AND sc.id_cliente = c.id_cliente
            AND sc.coverage_status = 'cubierto_plan' AND sc.invalidado IS FALSE
            AND sc.item_tipo = 'servicio' AND sc.id_servicio IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.citas_detalles cd
              WHERE cd.id_cita = c.id_cita AND cd.id_servicio = sc.id_servicio)
            AND (s.estado_suscripcion_codigo = 'activa'
              OR (s.estado_suscripcion_codigo = 'vencida' AND s.motivo_fin_codigo = 'agotamiento'))
            AND s.id_sucursal_contratada = c.id_sucursal
            AND s.inicio_at <= sc.created_at AND s.fin_at > sc.created_at
            AND sp.estado = 'pagado' AND sp.paid_at IS NOT NULL AND sp.paid_at <= clock_timestamp()
            AND sp.monto_hnl = p.monto_hnl AND sp.moneda_codigo = p.moneda_codigo
            AND mpo.estado_orden_codigo = 'pagada' AND mpo.paid_at IS NOT NULL
            AND mpo.total_hnl = p.monto_hnl AND mpo.moneda_codigo = p.moneda_codigo
            AND app_private.points_payment_valid_v1(p.id_payment)
        )
      )
  )
$function$;

CREATE OR REPLACE FUNCTION app_private.points_award_paid_appointment_v1(p_id_cita uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid; v_usuario uuid; v_cycle record; v_origen text;
BEGIN
  SELECT * INTO v_cita FROM public.citas WHERE id_cita = p_id_cita;
  IF NOT FOUND OR NOT app_private.points_appointment_paid_v1(p_id_cita) THEN RETURN; END IF;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  IF v_beneficiario IS NULL THEN RETURN; END IF;
  SELECT id_usuario INTO v_usuario FROM public.clientes WHERE id_cliente = v_beneficiario AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_beneficiario::text));
  IF EXISTS (SELECT 1 FROM public.points_transactions WHERE id_cita = p_id_cita AND tipo_puntos_codigo = 'acumular') THEN RETURN; END IF;
  SELECT * INTO v_cycle FROM public.fn_points_get_or_create_active_cycle(v_beneficiario, 12, now());
  v_origen := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  INSERT INTO public.points_transactions (id_cliente, id_cita, id_cycle, id_sucursal_origen,
    tipo_puntos_codigo, origen_punto_codigo, puntos, vence_at, motivo, creado_por_usuario_id)
  VALUES (v_beneficiario, p_id_cita, v_cycle.id_cycle, v_cita.id_sucursal, 'acumular', v_origen, 1, v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante' THEN 'Punto por acompañante con pago y reserva confirmados'
      ELSE 'Punto del titular con pago y reserva confirmados' END, COALESCE(v_cita.creada_por_usuario_id, v_usuario))
  ON CONFLICT DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_cita public.citas%ROWTYPE; v_beneficiario uuid; v_vence_at timestamptz;
BEGIN
  -- AM: Una acreditacion existente no se revierte por no_show ni se reescribe como otra acreditacion.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tipo_puntos_codigo = 'acumular' AND OLD.id_cita IS NOT NULL THEN
      IF ROW(NEW.id_cliente, NEW.id_cita, NEW.id_cycle, NEW.tipo_puntos_codigo, NEW.origen_punto_codigo, NEW.puntos)
        IS DISTINCT FROM ROW(OLD.id_cliente, OLD.id_cita, OLD.id_cycle, OLD.tipo_puntos_codigo, OLD.origen_punto_codigo, OLD.puntos) THEN
        RAISE EXCEPTION 'MASTERPUNTOS_PAID_CREDIT_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN RETURN NEW; END IF;
  IF NOT app_private.points_appointment_paid_v1(NEW.id_cita) THEN RETURN NULL; END IF;
  SELECT * INTO v_cita FROM public.citas WHERE id_cita = NEW.id_cita;
  v_beneficiario := v_cita.id_cliente;
  IF v_cita.id_grupo_cita IS NOT NULL THEN
    SELECT CASE WHEN cg.origen_codigo = 'cliente_autenticado' THEN cg.id_cliente_titular ELSE v_cita.id_cliente END
    INTO v_beneficiario FROM public.citas_grupos cg WHERE cg.id_grupo_cita = v_cita.id_grupo_cita;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF v_beneficiario IS NULL OR v_beneficiario IS DISTINCT FROM NEW.id_cliente THEN RETURN NULL; END IF;
  SELECT pc.vence_at INTO v_vence_at FROM public.points_cycles pc
    WHERE pc.id_cycle = NEW.id_cycle AND pc.id_cliente = v_beneficiario
      AND pc.estado_ciclo_codigo = 'activo' AND pc.vence_at > now()
      AND pc.vence_at = pc.primer_acumulado_at + interval '12 months';
  IF NOT FOUND THEN RETURN NULL; END IF;
  NEW.origen_punto_codigo := CASE WHEN COALESCE(v_cita.orden_integrante, 1) > 1 THEN 'integrante' ELSE 'titular' END;
  NEW.id_sucursal_origen := v_cita.id_sucursal;
  NEW.vence_at := v_vence_at;
  NEW.puntos := 1;
  RETURN NEW;
END;
$function$;

-- AM: Sustituye la guarda por el mismo nombre observado; tambien protege UPDATE de puntos/beneficiario.
DO $guard$
DECLARE v_name text;
BEGIN
  SELECT tgname INTO STRICT v_name FROM pg_trigger WHERE tgrelid = 'public.points_transactions'::regclass
    AND tgfoid = 'public.fn_points_tx_guard_acumular_final()'::regprocedure AND tgenabled = 'O' AND NOT tgisinternal;
  EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE INSERT OR UPDATE ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_points_tx_guard_acumular_final()', v_name);
END;
$guard$;

-- AM: Los hooks antiguos dejan de acreditar por finalizacion o cobertura sin evidencia de pago.
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN RETURN NEW; END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION app_private.points_award_paid_event_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE v_intent public.payment_intents%ROWTYPE; v_id_cita uuid;
BEGIN
  IF TG_TABLE_NAME = 'citas' THEN
    IF NEW.estado_cita_codigo <> 'confirmada' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.estado_cita_codigo IS NOT DISTINCT FROM NEW.estado_cita_codigo THEN RETURN NEW; END IF;
    END IF;
    PERFORM app_private.points_award_paid_appointment_v1(NEW.id_cita);
  ELSIF TG_TABLE_NAME = 'subscription_consumptions' THEN
    IF NEW.coverage_status <> 'cubierto_plan' OR NEW.invalidado IS NOT FALSE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF ROW(OLD.id_cita, OLD.id_suscripcion, OLD.coverage_status, OLD.invalidado, OLD.id_servicio)
        IS NOT DISTINCT FROM ROW(NEW.id_cita, NEW.id_suscripcion, NEW.coverage_status, NEW.invalidado, NEW.id_servicio) THEN RETURN NEW; END IF;
    END IF;
    PERFORM app_private.points_award_paid_appointment_v1(NEW.id_cita);
  ELSE
    IF TG_TABLE_NAME = 'payment_intents' THEN
      IF NEW.estado_intent_codigo <> 'confirmado' THEN RETURN NEW; END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.estado_intent_codigo IS NOT DISTINCT FROM NEW.estado_intent_codigo THEN RETURN NEW; END IF;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF ROW(OLD.estado_pago_codigo, OLD.pago_tardio) IS NOT DISTINCT FROM ROW(NEW.estado_pago_codigo, NEW.pago_tardio) THEN RETURN NEW; END IF;
    END IF;
    SELECT * INTO v_intent FROM public.payment_intents WHERE id_intent = NEW.id_intent;
    IF NOT FOUND OR v_intent.origen_pago_codigo <> 'cita' THEN RETURN NEW; END IF;
    FOR v_id_cita IN SELECT c.id_cita FROM public.citas c WHERE c.deleted_at IS NULL
      AND (c.id_cita = v_intent.id_cita OR c.id_grupo_cita = v_intent.id_grupo_cita
        OR (v_intent.id_grupo_cita IS NULL AND c.id_grupo_cita = (
          SELECT anchor.id_grupo_cita FROM public.citas anchor WHERE anchor.id_cita = v_intent.id_cita)))
      ORDER BY c.id_cita
    LOOP PERFORM app_private.points_award_paid_appointment_v1(v_id_cita); END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

-- AM: Diferido hasta COMMIT: observa pago, confirmacion y consumo VIP en cualquier orden,
-- AM: despues de validar/descontar el canje, sin que los nuevos puntos financien ese mismo canje.
DO $triggers$
DECLARE v_table text; v_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['citas', 'payments', 'payment_intents', 'subscription_consumptions'] LOOP
    v_name := 'tr_points_paid_' || v_table;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || v_table)::regclass AND tgname = v_name) THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.points_award_paid_event_v1()', v_name, v_table);
    END IF;
  END LOOP;
END;
$triggers$;

DO $validation$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('tr_points_paid_citas', 'tr_points_paid_payments',
      'tr_points_paid_payment_intents', 'tr_points_paid_subscription_consumptions')
      AND tgfoid = 'app_private.points_award_paid_event_v1()'::regprocedure
      AND tgdeferrable AND tginitdeferred AND tgenabled = 'O' AND NOT tgisinternal) <> 4 THEN
    RAISE EXCEPTION 'MASTERPUNTOS_PAID_DEFERRED_TRIGGERS_REQUIRED';
  END IF;
END;
$validation$;

REVOKE ALL ON FUNCTION app_private.points_payment_valid_v1(uuid), app_private.points_appointment_paid_v1(uuid),
  app_private.points_award_paid_appointment_v1(uuid), app_private.points_award_paid_event_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.points_payment_valid_v1(uuid), app_private.points_appointment_paid_v1(uuid),
  app_private.points_award_paid_appointment_v1(uuid), app_private.points_award_paid_event_v1() TO postgres;
COMMIT;
