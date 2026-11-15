-- AM: SOLO antes de reabrir. Introducir hashes 00; valores vacios bloquean. Mantener trafico detenido.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.citas,public.citas_detalles,public.citas_grupos,public.clientes,public.membership_purchase_orders,public.payment_events,public.payment_intents,public.payment_providers,public.payments,public.points_cycles,public.points_rule_services,public.points_rules,public.points_transactions,public.subscription_consumptions,public.subscription_payments,public.subscriptions,public.tipos_puntos IN SHARE ROW EXCLUSIVE MODE;
DO $gate$ BEGIN
 IF COALESCE(current_setting('masterfade.release10_expected_ledger',true),'')<>(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)
 OR COALESCE(current_setting('masterfade.release10_expected_cycles',true),'')<>(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)
 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_RESTORE_REQUIRES_UNCHANGED_BASELINE'; END IF; END $gate$;
SELECT set_config('masterfade.release10_ledger',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t),true),set_config('masterfade.release10_cycles',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t),true);
DROP TRIGGER tr_points_paid_citas ON public.citas;
DROP TRIGGER tr_points_paid_payment_intents ON public.payment_intents;
DROP TRIGGER tr_points_paid_payments ON public.payments;
DROP TRIGGER tr_points_paid_subscription_consumptions ON public.subscription_consumptions;
CREATE OR REPLACE FUNCTION public.fn_points_estado_final_cita()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_estado text;
BEGIN
  SELECT ec.estado_cita_codigo
  INTO v_estado
  FROM public.estados_cita ec
  WHERE lower(trim(ec.estado_cita_codigo)) IN ('completada','atendida','finalizada')
  ORDER BY
    CASE lower(trim(ec.estado_cita_codigo))
      WHEN 'completada' THEN 1
      WHEN 'atendida' THEN 2
      WHEN 'finalizada' THEN 3
      ELSE 99
    END
  LIMIT 1;

  IF v_estado IS NULL THEN
    v_estado := 'completada';
  END IF;

  RETURN v_estado;
END;
$function$
;
ALTER FUNCTION public.fn_points_estado_final_cita() RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_get_effective_rule(p_id_sucursal uuid)
 RETURNS TABLE(id_rule uuid, id_sucursal uuid, umbral_monto_hnl numeric, puntos_por_cita integer, puntos_para_premio integer, expiracion_meses integer, activo boolean)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    pr.id_rule,
    pr.id_sucursal,
    pr.umbral_monto_hnl,
    pr.puntos_por_cita,
    pr.puntos_para_premio,
    pr.expiracion_meses,
    pr.activo
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = p_id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = p_id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC,
    pr.created_at DESC,
    pr.id_rule DESC
  LIMIT 1
$function$
;
ALTER FUNCTION public.fn_points_get_effective_rule(uuid) RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_expiracion_meses integer, p_anchor_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_anchor timestamptz;
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  PERFORM public.fn_points_materialize_expired_cycles(p_id_cliente);

  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND pc.vence_at > now()
  ORDER BY pc.primer_acumulado_at ASC
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  v_anchor := COALESCE(p_anchor_at, now());

  BEGIN
    INSERT INTO public.points_cycles (
      id_cliente,
      primer_acumulado_at,
      vence_at,
      estado_ciclo_codigo
    )
    VALUES (
      p_id_cliente,
      v_anchor,
      v_anchor + make_interval(months => GREATEST(p_expiracion_meses, 1)),
      'activo'
    )
    RETURNING * INTO v_inserted;
  EXCEPTION WHEN unique_violation THEN
    SELECT *
    INTO v_inserted
    FROM public.points_cycles
    WHERE id_cliente = p_id_cliente
      AND estado_ciclo_codigo = 'activo'
    ORDER BY primer_acumulado_at ASC
    LIMIT 1;
  END;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;
  RETURN NEXT;
END;
$function$
;
ALTER FUNCTION public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone) RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_get_or_create_active_cycle(p_id_cliente uuid, p_anchor_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(id_cycle uuid, primer_acumulado_at timestamp with time zone, vence_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_inserted public.points_cycles%ROWTYPE;
BEGIN
  SELECT pc.id_cycle, pc.primer_acumulado_at, pc.vence_at
  INTO id_cycle, primer_acumulado_at, vence_at
  FROM public.points_cycles pc
  WHERE pc.id_cliente = p_id_cliente
    AND pc.estado_ciclo_codigo = 'activo'
    AND (pc.vence_at IS NULL OR pc.vence_at > now())
  ORDER BY pc.primer_acumulado_at DESC NULLS LAST
  LIMIT 1;

  IF id_cycle IS NOT NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO public.points_cycles (
    id_cliente,
    primer_acumulado_at,
    vence_at,
    estado_ciclo_codigo
  )
  VALUES (
    p_id_cliente,
    COALESCE(p_anchor_at, now()),
    NULL,
    'activo'
  )
  RETURNING * INTO v_inserted;

  id_cycle := v_inserted.id_cycle;
  primer_acumulado_at := v_inserted.primer_acumulado_at;
  vence_at := v_inserted.vence_at;

  RETURN NEXT;
END;
$function$
;
ALTER FUNCTION public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone) RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_materialize_expired_cycles(p_id_cliente uuid DEFAULT NULL::uuid)
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
$function$
;
ALTER FUNCTION public.fn_points_materialize_expired_cycles(uuid) RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_tx_apply_tipo_sign()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_signo integer;
BEGIN
  IF NEW.puntos = 0 THEN
    RAISE EXCEPTION 'points_transactions.puntos no puede ser 0';
  END IF;

  SELECT tp.signo
  INTO v_signo
  FROM public.tipos_puntos tp
  WHERE tp.tipo_puntos_codigo = NEW.tipo_puntos_codigo
  LIMIT 1;

  IF v_signo = 1 THEN
    NEW.puntos := abs(NEW.puntos);
  ELSIF v_signo = -1 THEN
    NEW.puntos := -abs(NEW.puntos);
  END IF;

  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_points_tx_apply_tipo_sign() RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_points_tx_guard_acumular_final()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_final text;
  v_estado_cita text;
  v_orden integer;
  v_es_canje boolean;
  v_origen text;
BEGIN
  IF NEW.tipo_puntos_codigo <> 'acumular' OR NEW.id_cita IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  SELECT
    c.estado_cita_codigo,
    COALESCE(c.orden_integrante, 1),
    COALESCE(c.es_canje_recompensa, false)
  INTO v_estado_cita, v_orden, v_es_canje
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita
    AND c.deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_estado_cita IS DISTINCT FROM v_estado_final THEN
    RETURN NULL;
  END IF;

  v_origen := COALESCE(
    NULLIF(trim(NEW.origen_punto_codigo), ''),
    CASE WHEN v_orden > 1 THEN 'integrante' ELSE 'titular' END
  );

  NEW.origen_punto_codigo := v_origen;

  IF v_es_canje IS TRUE AND v_origen = 'titular' THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_points_tx_guard_acumular_final() RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_trg_otorgar_puntos_plan_confirmada() RESET ALL;
CREATE OR REPLACE FUNCTION public.fn_trg_otorgar_puntos_por_cita()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_estado_final text;
  v_origen text;
  v_puntos_por_cita integer := 1;
  v_cycle record;
  v_cliente_usuario uuid;
BEGIN
  SELECT public.fn_points_estado_final_cita() INTO v_estado_final;

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado_cita_codigo IS DISTINCT FROM v_estado_final THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.estado_cita_codigo IS DISTINCT FROM NEW.estado_cita_codigo
      AND NEW.estado_cita_codigo = v_estado_final
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.id_cliente IS NULL THEN
    RETURN NEW;
  END IF;

  v_origen := CASE
    WHEN COALESCE(NEW.orden_integrante, 1) > 1 THEN 'integrante'
    ELSE 'titular'
  END;

  IF COALESCE(NEW.es_canje_recompensa, false) IS TRUE AND v_origen = 'titular' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(pr.puntos_por_cita, 1)
  INTO v_puntos_por_cita
  FROM public.points_rules pr
  WHERE pr.activo IS TRUE
    AND (pr.id_sucursal = NEW.id_sucursal OR pr.id_sucursal IS NULL)
  ORDER BY
    CASE WHEN pr.id_sucursal = NEW.id_sucursal THEN 0 ELSE 1 END,
    pr.updated_at DESC NULLS LAST,
    pr.created_at DESC NULLS LAST
  LIMIT 1;

  SELECT *
  INTO v_cycle
  FROM public.fn_points_get_or_create_active_cycle(
    NEW.id_cliente,
    COALESCE(NEW.inicio_at, now())
  )
  LIMIT 1;

  SELECT c.id_usuario
  INTO v_cliente_usuario
  FROM public.clientes c
  WHERE c.id_cliente = NEW.id_cliente
    AND c.deleted_at IS NULL
  LIMIT 1;

  INSERT INTO public.points_transactions (
    id_cliente,
    id_cita,
    id_cycle,
    id_sucursal_origen,
    tipo_puntos_codigo,
    origen_punto_codigo,
    puntos,
    vence_at,
    motivo,
    creado_por_usuario_id,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id_cliente,
    NEW.id_cita,
    v_cycle.id_cycle,
    NEW.id_sucursal,
    'acumular',
    v_origen,
    GREATEST(1, COALESCE(v_puntos_por_cita, 1)),
    v_cycle.vence_at,
    CASE WHEN v_origen = 'integrante'
      THEN 'Punto por acompañante en visita completada'
      ELSE 'Punto por visita completada del titular'
    END,
    COALESCE(NEW.creada_por_usuario_id, v_cliente_usuario),
    now(),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$
;
ALTER FUNCTION public.fn_trg_otorgar_puntos_por_cita() RESET ALL;
CREATE OR REPLACE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita();
CREATE OR REPLACE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();
CREATE OR REPLACE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();
DROP FUNCTION app_private.points_payment_valid_v1(uuid);
DROP FUNCTION app_private.points_award_paid_event_v1();
DROP FUNCTION app_private.points_award_paid_appointment_v1(uuid);
DROP FUNCTION app_private.points_appointment_paid_v1(uuid);
DO $release10$ DECLARE r record; BEGIN
 FOR r IN SELECT 'RESTORE_CATALOG' code,CASE WHEN NOT EXISTS (SELECT 1 FROM (VALUES
('public.fn_points_estado_final_cita()','4dfc98cfab7a75463c5c83174052bcec',''),
('public.fn_points_get_effective_rule(uuid)','a683ccd7ac0e7b57692f08b2f3a0de4b',''),
('public.fn_points_get_or_create_active_cycle(uuid,integer,timestamp with time zone)','4920fc016184b7946b64df47dabbfc8e',''),
('public.fn_points_get_or_create_active_cycle(uuid,timestamp with time zone)','f493e6430190188179dc3010df3af753',''),
('public.fn_points_materialize_expired_cycles(uuid)','5448c179064e0e830e3ac7759d47cf5f',''),
('public.fn_points_tx_apply_tipo_sign()','9cbd32e13662f771108d7cc7b6a049d1',''),
('public.fn_points_tx_guard_acumular_final()','b574793906178b14218d867aea5fdb2d',''),
('public.fn_trg_otorgar_puntos_plan_confirmada()','8fca75d897f52916538b04d82dcdc5ef',''),
('public.fn_trg_otorgar_puntos_por_cita()','99e0f5af5be5cf544855d0ba85ae7f26','')
) e(signature,hash,acl)
 WHERE to_regprocedure(e.signature) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.signature))) <> e.hash
 OR (SELECT pg_get_userbyid(proowner) <> 'postgres' OR prosecdef OR COALESCE(proacl::text,'')<>e.acl FROM pg_proc WHERE oid=to_regprocedure(e.signature)))
 AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','app_private') AND (p.proname ILIKE '%point%' OR p.proname ILIKE '%punto%'))=9 AND NOT EXISTS (SELECT 1 FROM (VALUES
('citas','tr_points_cita_confirmada','CREATE TRIGGER tr_points_cita_confirmada AFTER UPDATE ON public.citas FOR EACH ROW EXECUTE FUNCTION fn_trg_otorgar_puntos_por_cita()'),
('points_transactions','tr_points_tx_apply_tipo_sign','CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign()'),
('points_transactions','tr_points_tx_guard_acumular_final','CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final()')
) e(tablename,name,definition)
 LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.tablename) AND t.tgname=e.name
 WHERE t.oid IS NULL OR t.tgenabled<>'O' OR pg_get_triggerdef(t.oid)<>e.definition)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname LIKE 'tr_points_paid_%' AND NOT tgisinternal) THEN 0 ELSE 1 END::bigint affected LOOP
 IF r.affected<>0 THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_BLOCKED: % (%)',r.code,r.affected; END IF;
 END LOOP; END $release10$;
DO $unchanged$ BEGIN IF (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_points_tx),'')) FROM public.points_transactions t)<>current_setting('masterfade.release10_ledger')
 OR (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id_cycle),'')) FROM public.points_cycles t)<>current_setting('masterfade.release10_cycles') THEN RAISE EXCEPTION 'MASTERPUNTOS_RELEASE10_LEDGER_CHANGED'; END IF; END $unchanged$;
COMMIT;
