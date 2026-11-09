BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- AM: Solo la ultima Sale PixelPay finalizada e incierta protege el intent.
CREATE OR REPLACE FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(
  p_id_intent uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
  SELECT EXISTS (
    SELECT 1
    FROM public.payment_intents pi
    JOIN public.payment_providers pp ON pp.id_provider = pi.id_provider
    WHERE pi.id_intent = p_id_intent
      AND pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo = 'pendiente_confirmacion'
      AND lower(pp.codigo) = 'pixelpay'
      AND (
        SELECT a.outcome = 'uncertain' AND a.uncertain IS TRUE
        FROM app_private.pixelpay_sale_attempts a
        WHERE a.id_intent = pi.id_intent
          AND a.finalized_at IS NOT NULL
        ORDER BY a.created_at DESC, a.id_sale_attempt DESC
        LIMIT 1
      ) IS TRUE
  );
$mf$;

REVOKE ALL ON FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.pixelpay_intent_has_uncertain_sale_v1(uuid) TO postgres;

-- AM: Conserva el contrato exacto de QA y evita que el RPC expire la evidencia
-- durable antes de que la liberacion del hold active el trigger central.
CREATE OR REPLACE FUNCTION app_private.expirar_reservas_titular_v1(p_id_cliente_titular uuid, p_id_usuario_titular uuid, p_id_persona_titular uuid, p_ahora timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_gracia integer := app_private.obtener_gracia_confirmacion_pago_min_v1();
  v_holds_consumidos integer := 0;
  v_citas_confirmadas integer := 0;
  v_holds integer := 0;
  v_citas integer := 0;
  v_intents integer := 0;
  v_usos integer := 0;
BEGIN
  IF p_id_cliente_titular IS NULL
     AND p_id_usuario_titular IS NULL
     AND p_id_persona_titular IS NULL THEN
    RETURN jsonb_build_object(
      'holds_consumidos', 0,
      'citas_confirmadas', 0,
      'holds_expirados', 0,
      'citas_expiradas', 0,
      'intents_expirados', 0,
      'usos_revertidos', 0
    );
  END IF;

  WITH pagadas AS (
    SELECT h.id_hold, c.id_cita
    FROM public.citas_grupos cg
    JOIN public.citas c
      ON c.id_grupo_cita = cg.id_grupo_cita
     AND c.deleted_at IS NULL
    JOIN public.citas_holds h ON h.id_cita = c.id_cita
    WHERE (
      (p_id_cliente_titular IS NOT NULL AND cg.id_cliente_titular = p_id_cliente_titular)
      OR (p_id_usuario_titular IS NOT NULL AND cg.id_usuario_titular = p_id_usuario_titular)
      OR (p_id_persona_titular IS NOT NULL AND cg.id_persona_titular = p_id_persona_titular)
    )
      AND h.estado_hold_codigo = 'activo'
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago', 'confirmada')
      AND (
        c.estado_cita_codigo = 'confirmada'
        OR EXISTS (
          SELECT 1
          FROM public.payment_intents pi
          WHERE pi.origen_pago_codigo = 'cita'
            AND pi.estado_intent_codigo = 'confirmado'
            AND pi.paid_at IS NOT NULL
            AND pi.paid_at <= h.expires_at
            AND (
              pi.id_hold = h.id_hold
              OR pi.id_cita = c.id_cita
              OR pi.id_grupo_cita = c.id_grupo_cita
            )
        )
      )
    ORDER BY h.id_hold
    FOR UPDATE OF h SKIP LOCKED
    LIMIT 50
  ),
  confirmed_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'confirmada',
        updated_at = p_ahora
    FROM pagadas p
    WHERE c.id_cita = p.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita
  ),
  consumed_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'consumido',
        updated_at = p_ahora
    FROM pagadas p
    WHERE h.id_hold = p.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  )
  SELECT
    (SELECT count(*) FROM confirmed_citas),
    (SELECT count(*) FROM consumed_holds)
  INTO v_citas_confirmadas, v_holds_consumidos;

  WITH candidatos AS (
    SELECT h.id_hold, c.id_cita, c.id_grupo_cita
    FROM public.citas_grupos cg
    JOIN public.citas c
      ON c.id_grupo_cita = cg.id_grupo_cita
     AND c.deleted_at IS NULL
    JOIN public.citas_holds h ON h.id_cita = c.id_cita
    WHERE (
      (p_id_cliente_titular IS NOT NULL AND cg.id_cliente_titular = p_id_cliente_titular)
      OR (p_id_usuario_titular IS NOT NULL AND cg.id_usuario_titular = p_id_usuario_titular)
      OR (p_id_persona_titular IS NOT NULL AND cg.id_persona_titular = p_id_persona_titular)
    )
      AND cg.estado_grupo_codigo = 'activo'
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
      AND h.estado_hold_codigo = 'activo'
      AND h.expires_at <= p_ahora
      AND NOT EXISTS (
        SELECT 1
        FROM public.payment_intents pi
        WHERE pi.origen_pago_codigo = 'cita'
          AND (
            pi.id_hold = h.id_hold
            OR pi.id_cita = c.id_cita
            OR pi.id_grupo_cita = c.id_grupo_cita
          )
          AND (
            (
              pi.estado_intent_codigo = 'confirmado'
              AND pi.paid_at IS NOT NULL
              AND pi.paid_at <= h.expires_at
            )
            OR (
              pi.estado_intent_codigo = 'pendiente_confirmacion'
              AND pi.paid_at IS NOT NULL
              AND pi.paid_at <= h.expires_at
              AND pi.paid_at + make_interval(mins => v_gracia) > p_ahora
            )
          )
      )
    ORDER BY h.expires_at ASC, h.id_hold ASC
    FOR UPDATE OF h SKIP LOCKED
    LIMIT 50
  ),
  expired_intents AS (
    UPDATE public.payment_intents pi
    SET estado_intent_codigo = 'expirado',
        updated_at = p_ahora
    FROM candidatos x
    WHERE pi.origen_pago_codigo = 'cita'
      AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
      AND NOT app_private.pixelpay_intent_has_uncertain_sale_v1(pi.id_intent)
      AND (
        pi.id_hold = x.id_hold
        OR pi.id_cita = x.id_cita
        OR pi.id_grupo_cita = x.id_grupo_cita
      )
    RETURNING pi.id_intent
  ),
  expired_holds AS (
    UPDATE public.citas_holds h
    SET estado_hold_codigo = 'expirado',
        updated_at = p_ahora
    FROM candidatos x
    WHERE h.id_hold = x.id_hold
      AND h.estado_hold_codigo = 'activo'
    RETURNING h.id_hold
  ),
  expired_citas AS (
    UPDATE public.citas c
    SET estado_cita_codigo = 'expirada',
        updated_at = p_ahora
    FROM candidatos x
    WHERE c.id_cita = x.id_cita
      AND c.estado_cita_codigo IN ('en_espera', 'pendiente_pago')
    RETURNING c.id_cita, c.id_grupo_cita
  ),
  reverted_usages AS (
    UPDATE public.promociones_usos pu
    SET estado_uso_codigo = 'revertido',
        updated_at = p_ahora
    FROM public.citas_promociones cp
    JOIN expired_citas ec ON cp.id_grupo_cita = ec.id_grupo_cita
    WHERE pu.id_cita_promocion = cp.id_cita_promocion
      AND pu.estado_uso_codigo = 'reservado'
    RETURNING pu.id_promocion_uso
  )
  SELECT
    (SELECT count(*) FROM expired_holds),
    (SELECT count(*) FROM expired_citas),
    (SELECT count(*) FROM expired_intents),
    (SELECT count(*) FROM reverted_usages)
  INTO v_holds, v_citas, v_intents, v_usos;

  RETURN jsonb_build_object(
    'holds_consumidos', v_holds_consumidos,
    'citas_confirmadas', v_citas_confirmadas,
    'holds_expirados', v_holds,
    'citas_expiradas', v_citas,
    'intents_expirados', v_intents,
    'usos_revertidos', v_usos
  );
END;
$function$;



-- AM: Todo camino que libera un hold expira pendientes ordinarios, pero conserva
-- exclusivamente la evidencia durable de una Sale incierta de PixelPay.
CREATE OR REPLACE FUNCTION app_private.expire_unprotected_intents_for_hold_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $mf$
BEGIN
  IF NEW.estado_hold_codigo <> 'expirado'
     OR OLD.estado_hold_codigo IS NOT DISTINCT FROM NEW.estado_hold_codigo THEN
    RETURN NEW;
  END IF;

  UPDATE public.payment_intents pi
  SET estado_intent_codigo = 'expirado',
      updated_at = clock_timestamp()
  FROM public.citas c
  WHERE c.id_cita = NEW.id_cita
    AND pi.estado_intent_codigo IN ('creado', 'link_generado', 'pendiente_confirmacion')
    AND (
      pi.id_hold = NEW.id_hold
      OR pi.id_cita = NEW.id_cita
      OR (c.id_grupo_cita IS NOT NULL AND pi.id_grupo_cita = c.id_grupo_cita)
    )
    AND NOT app_private.pixelpay_intent_has_uncertain_sale_v1(pi.id_intent);

  RETURN NEW;
END;
$mf$;

REVOKE ALL ON FUNCTION app_private.expire_unprotected_intents_for_hold_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.expire_unprotected_intents_for_hold_v1() TO postgres;

DROP TRIGGER IF EXISTS tr_hold_expire_unprotected_intents ON public.citas_holds;
CREATE TRIGGER tr_hold_expire_unprotected_intents
AFTER UPDATE OF estado_hold_codigo ON public.citas_holds
FOR EACH ROW
WHEN (NEW.estado_hold_codigo = 'expirado' AND OLD.estado_hold_codigo IS DISTINCT FROM NEW.estado_hold_codigo)
EXECUTE FUNCTION app_private.expire_unprotected_intents_for_hold_v1();

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.citas_holds'::regclass
      AND t.tgname = 'tr_hold_expire_unprotected_intents'
      AND t.tgfoid = to_regprocedure('app_private.expire_unprotected_intents_for_hold_v1()')
      AND NOT t.tgisinternal
      AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'MF_UNCERTAIN_EXPIRATION_TRIGGER_REQUIRED';
  END IF;
END
$assert$;

COMMIT;
