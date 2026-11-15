-- AM: Fixture exclusivamente local, columnas/rutinas productivas del catalogo de lectura Release01.
-- No es migracion, no aplicar en Supabase. No incluye ciclos/canjes QA propuestos.
CREATE SCHEMA app_private;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

CREATE TABLE public.personas(
"apellidos" text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"deleted_at" timestamp with time zone,
"direccion_texto" text,
"dni" text,
"fecha_nacimiento" date,
"foto_perfil_asset_id" uuid,
"foto_perfil_path" text,
"genero_codigo" text,
"id_persona" uuid DEFAULT gen_random_uuid() NOT NULL,
"nombres" text NOT NULL,
"observaciones" text,
"rtn" text,
"telefono_principal" text,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.usuarios(
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"credenciales_completadas_at" timestamp with time zone,
"deleted_at" timestamp with time zone,
"estado" boolean DEFAULT true NOT NULL,
"estado_acceso" text DEFAULT 'pendiente_password'::text NOT NULL,
"id_persona" uuid NOT NULL,
"id_usuario" uuid NOT NULL,
"password_hash" text,
"ultimo_login_at" timestamp with time zone,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.clientes(
"acepta_terminos" boolean DEFAULT false NOT NULL,
"acepta_terminos_at" timestamp with time zone,
"anonimizado" boolean DEFAULT false NOT NULL,
"consentimiento_marketing" boolean DEFAULT false NOT NULL,
"consentimiento_marketing_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"deleted_at" timestamp with time zone,
"estado" boolean DEFAULT true NOT NULL,
"fecha_ingreso" date DEFAULT CURRENT_DATE NOT NULL,
"id_cliente" uuid DEFAULT gen_random_uuid() NOT NULL,
"id_persona" uuid NOT NULL,
"id_sucursal_origen" uuid,
"id_usuario" uuid,
"preferencias" jsonb DEFAULT '{}'::jsonb NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sucursales(
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"deleted_at" timestamp with time zone,
"direccion_texto" text,
"estado" boolean DEFAULT true NOT NULL,
"fecha_inauguracion" date,
"id_correo" uuid,
"id_empresa" uuid NOT NULL,
"id_sucursal" uuid DEFAULT gen_random_uuid() NOT NULL,
"nombre_sucursal" text NOT NULL,
"telefono_texto" text,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tipos_puntos(
"descripcion" text NOT NULL,
"signo" integer NOT NULL,
"tipo_puntos_codigo" text NOT NULL
);

CREATE TABLE public.points_rules(
"activo" boolean DEFAULT true NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"expiracion_meses" integer DEFAULT 12,
"id_rule" uuid DEFAULT gen_random_uuid() NOT NULL,
"id_sucursal" uuid,
"puntos_para_premio" integer DEFAULT 10 NOT NULL,
"puntos_por_cita" integer DEFAULT 1 NOT NULL,
"servicios_redimibles" text[] DEFAULT ARRAY['corte'::text, 'barba'::text] NOT NULL,
"umbral_monto_hnl" numeric(12,2) DEFAULT 250 NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.points_cycles(
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"estado_ciclo_codigo" text DEFAULT 'activo'::text NOT NULL,
"id_cliente" uuid NOT NULL,
"id_cycle" uuid DEFAULT gen_random_uuid() NOT NULL,
"primer_acumulado_at" timestamp with time zone NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"vence_at" timestamp with time zone
);

CREATE TABLE public.points_transactions(
"creado_por_usuario_id" uuid,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"id_cita" uuid,
"id_cliente" uuid NOT NULL,
"id_cycle" uuid,
"id_points_tx" uuid DEFAULT gen_random_uuid() NOT NULL,
"id_servicio_canje" uuid,
"id_sucursal_origen" uuid,
"motivo" text,
"origen_punto_codigo" text DEFAULT 'titular'::text NOT NULL,
"puntos" integer NOT NULL,
"tipo_puntos_codigo" text NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"vence_at" timestamp with time zone
);

ALTER TABLE public.points_transactions ADD PRIMARY KEY(id_points_tx);
ALTER TABLE public.clientes ADD PRIMARY KEY(id_cliente);
ALTER TABLE public.usuarios ADD PRIMARY KEY(id_usuario);
ALTER TABLE public.personas ADD PRIMARY KEY(id_persona);
ALTER TABLE public.sucursales ADD PRIMARY KEY(id_sucursal);

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

CREATE TRIGGER tr_points_tx_apply_tipo_sign BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, puntos ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_apply_tipo_sign();

CREATE TRIGGER tr_points_tx_guard_acumular_final BEFORE INSERT OR UPDATE OF tipo_puntos_codigo, id_cita, origen_punto_codigo ON public.points_transactions FOR EACH ROW EXECUTE FUNCTION fn_points_tx_guard_acumular_final();

-- Microfase 3C.0: Corrige el saldo de MasterPuntos usando puntos ya firmados.

CREATE OR REPLACE VIEW public.vw_points_balance AS
SELECT
  pt.id_cliente,
  COALESCE(SUM(pt.puntos), 0::bigint)::integer AS balance_puntos
FROM public.points_transactions pt
GROUP BY pt.id_cliente;

COMMENT ON VIEW public.vw_points_balance IS
  'Saldo calculado sobre puntos cuyo signo ya fue normalizado por tr_points_tx_apply_tipo_sign.';


-- QA-MP-02: idempotencia durable para ajustes manuales administrativos.
CREATE TABLE app_private.points_manual_adjustment_idempotency (
  idempotency_key uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  id_cliente uuid NOT NULL,
  requested_by_usuario_id uuid NOT NULL,
  id_points_tx uuid NULL,
  response_payload jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT ck_points_manual_adjustment_idempotency_payload_hash
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_points_manual_adjustment_idempotency_completion
    CHECK (
      (id_points_tx IS NULL AND response_payload IS NULL AND completed_at IS NULL)
      OR
      (id_points_tx IS NOT NULL AND response_payload IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT ck_points_manual_adjustment_idempotency_response_object
    CHECK (response_payload IS NULL OR jsonb_typeof(response_payload) = 'object')
);

CREATE UNIQUE INDEX ux_points_manual_adjustment_idempotency_tx
  ON app_private.points_manual_adjustment_idempotency (id_points_tx)
  WHERE id_points_tx IS NOT NULL;

CREATE INDEX idx_points_manual_adjustment_idempotency_created_at
  ON app_private.points_manual_adjustment_idempotency (created_at);

REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM anon;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM authenticated;
REVOKE ALL ON TABLE app_private.points_manual_adjustment_idempotency FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE app_private.points_manual_adjustment_idempotency TO postgres;

COMMENT ON TABLE app_private.points_manual_adjustment_idempotency IS
  'Deduplicacion transaccional de ajustes manuales MasterPuntos; no expuesta por Data API.';
