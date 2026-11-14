-- AM: SOLO fixture PostgreSQL 17 aislado; nunca ejecutar contra QA/Produccion.
-- No contiene datos historicos, credenciales ni la migracion de endurecimiento.
-- Columnas/tipos/defaults: snapshot QA 2026-10-28,
-- _PRODUCTION-PREP-20261028/evidence/qa-catalog.json.
-- Rutinas auxiliares reales: _ADMIN-DATA-ENTRY-20261028/sql-validation/prod-functions.json.
-- Las rutinas objetivo/dependencias se cargan desde routines.json DESPUES de este archivo.
-- Orden SQL: fn_has_role, fn_is_super_admin, fn_es_admin_de_sucursal.
-- Las tablas son stubs: omiten NOT NULL, PK, FK, CHECK, indices, RLS y triggers.
-- Los tests adjuntan las definiciones originales de triggers que ejercitan.
-- Las columnas generadas de minutos conservan sus expresiones del catalogo.
-- La expiracion de reservas tiene un stub limitado y falla si hay holds vencidos.
-- Este fixture no certifica restricciones de negocio ni limpieza de reservas/pagos.

DO $fixture_roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$fixture_roles$;

CREATE SCHEMA auth;
CREATE SCHEMA app_private;
CREATE EXTENSION citext WITH SCHEMA public;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

-- AM: contratos locales de claims JWT; no instancia el servicio Auth.
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $fixture_uid$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$fixture_uid$;
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $fixture_role$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
$fixture_role$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
-- AM: SHA256 catalogo fuente: 212684b1f41dff187f2d9d7bdaa029728750504661623c2c2ef1c4073c635360

CREATE TABLE public.agenda_bloqueos_empleados (
  id_bloqueo_empleado uuid DEFAULT gen_random_uuid(),
  id_empleado uuid,
  tipo_bloqueo_codigo text,
  rango tstzrange,
  motivo text,
  creado_por uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agenda_excepciones_sucursal (
  id_excepcion_sucursal uuid DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  fecha date,
  modo_excepcion_codigo text,
  motivo text,
  creado_por uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.agenda_excepciones_sucursal_bloques (
  id_bloque_excepcion uuid DEFAULT gen_random_uuid(),
  id_excepcion_sucursal uuid,
  hora_inicio time without time zone,
  hora_fin time without time zone,
  minuto_inicio integer GENERATED ALWAYS AS ((floor((EXTRACT(epoch FROM hora_inicio) / (60)::numeric)))::integer) STORED,
  minuto_fin integer GENERATED ALWAYS AS ((floor((EXTRACT(epoch FROM hora_fin) / (60)::numeric)))::integer) STORED,
  orden_visual smallint DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.app_protected_users (
  id_usuario uuid,
  email text,
  motivo text,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.archivos (
  id_archivo uuid DEFAULT gen_random_uuid(),
  bucket text,
  ruta text,
  mime_type text,
  size_bytes bigint,
  checksum_sha256 text,
  descripcion text,
  id_usuario_subio uuid,
  id_persona uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.barberos_perfiles_publicos (
  id_perfil_publico uuid DEFAULT gen_random_uuid(),
  id_empleado uuid,
  alias_publico character varying(80),
  resumen_publico character varying(500),
  certificaciones_titulos text[] DEFAULT '{}'::text[],
  visible_en_landing boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.bloqueos_agenda (
  id_bloqueo uuid DEFAULT gen_random_uuid(),
  id_empleado uuid,
  id_sucursal uuid,
  tipo_bloqueo_codigo text,
  rango tstzrange,
  motivo text,
  creado_por uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.citas (
  id_cita uuid DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  id_empleado_barbero uuid,
  id_persona_cliente uuid,
  id_cliente uuid,
  creada_por_usuario_id uuid,
  asignada_automaticamente boolean DEFAULT false,
  estado_cita_codigo text,
  inicio_at timestamp with time zone,
  fin_at timestamp with time zone,
  duracion_total_min integer DEFAULT 0,
  buffer_total_min integer DEFAULT 0,
  subtotal_servicios_hnl numeric(12,2) DEFAULT 0,
  descuento_hnl numeric(12,2) DEFAULT 0,
  total_pagar_hnl numeric(12,2) DEFAULT 0,
  moneda_codigo text DEFAULT 'HNL'::text,
  notas text,
  llegada_real_at timestamp with time zone,
  no_show_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  id_grupo_cita uuid,
  orden_integrante integer,
  alias_integrante text,
  contacto_nombre text,
  contacto_email text,
  contacto_telefono text,
  selection_type text DEFAULT 'services'::text,
  id_paquete uuid,
  atencion_iniciada_at timestamp with time zone,
  atencion_finalizada_at timestamp with time zone,
  retraso_inicio_min integer DEFAULT 0,
  es_canje_recompensa boolean DEFAULT false,
  id_cita_integrante uuid
);

CREATE TABLE public.citas_detalles (
  id_cita_detalle uuid DEFAULT gen_random_uuid(),
  id_cita uuid,
  id_servicio uuid,
  cantidad integer DEFAULT 1,
  duracion_min integer,
  buffer_min integer DEFAULT 5,
  precio_unitario_hnl numeric(12,2),
  subtotal_hnl numeric(12,2),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  id_cita_paquete uuid,
  origen_item_codigo text DEFAULT 'servicio_manual'::text,
  nombre_servicio_snapshot text,
  precio_referencia_hnl numeric(12,2) DEFAULT 0,
  descuento_hnl numeric(12,2) DEFAULT 0,
  isv_porcentaje numeric(5,2) DEFAULT 0,
  isv_hnl numeric(12,2) DEFAULT 0,
  total_linea_hnl numeric(12,2) DEFAULT 0,
  id_tarifa uuid,
  incluye_isv_snapshot boolean DEFAULT false,
  line_key text,
  orden_linea integer
);

CREATE TABLE public.citas_grupos (
  id_grupo_cita uuid DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  id_persona_titular uuid,
  id_cliente_titular uuid,
  estado_grupo_codigo text DEFAULT 'activo'::text,
  notas text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  codigo_reserva text,
  id_usuario_titular uuid,
  origen_codigo text DEFAULT 'publico'::text,
  total_hnl numeric(12,2) DEFAULT 0,
  release_token text,
  release_token_hash text,
  release_token_created_at timestamp with time zone
);

CREATE TABLE public.citas_holds (
  id_hold uuid DEFAULT gen_random_uuid(),
  id_cita uuid,
  id_usuario uuid,
  estado_hold_codigo text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.citas_integrantes (
  id_cita_integrante uuid DEFAULT gen_random_uuid(),
  id_grupo_cita uuid,
  orden_integrante integer,
  rol_integrante_codigo text,
  tipo_cliente_codigo text DEFAULT 'invitado'::text,
  id_usuario uuid,
  id_persona uuid,
  id_cliente uuid,
  contacto_nombre_snapshot text DEFAULT 'Cliente'::text,
  contacto_email_snapshot text,
  contacto_telefono_snapshot text,
  alias_integrante text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.citas_reagendaciones (
  id_reagendacion uuid DEFAULT gen_random_uuid(),
  id_cita uuid,
  id_sucursal uuid,
  id_empleado_barbero_anterior uuid,
  id_empleado_barbero_nuevo uuid,
  inicio_at_anterior timestamp with time zone,
  fin_at_anterior timestamp with time zone,
  inicio_at_nuevo timestamp with time zone,
  fin_at_nuevo timestamp with time zone,
  motivo text,
  tipo_reagendacion_codigo text DEFAULT 'emergencia'::text,
  id_usuario_accion uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  id_cita_causante uuid,
  id_lote_reagendacion uuid,
  retraso_min integer
);

CREATE TABLE public.clientes (
  id_cliente uuid DEFAULT gen_random_uuid(),
  id_persona uuid,
  id_usuario uuid,
  fecha_ingreso date DEFAULT CURRENT_DATE,
  estado boolean DEFAULT true,
  consentimiento_marketing boolean DEFAULT false,
  acepta_terminos boolean DEFAULT false,
  preferencias jsonb DEFAULT '{}'::jsonb,
  anonimizado boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  id_sucursal_origen uuid,
  acepta_terminos_at timestamp with time zone,
  consentimiento_marketing_at timestamp with time zone
);

CREATE TABLE public.comprobantes_agendamiento (
  id_comprobante_agendamiento uuid DEFAULT gen_random_uuid(),
  id_grupo_cita uuid,
  codigo_comprobante text,
  codigo_reserva_snapshot text,
  tipo_comprobante_codigo text DEFAULT 'agendamiento_no_fiscal'::text,
  estado_comprobante_codigo text DEFAULT 'generado'::text,
  resultado_reserva_codigo text DEFAULT 'pendiente'::text,
  id_sucursal uuid,
  id_usuario_titular uuid,
  id_cliente_titular uuid,
  id_persona_titular uuid,
  titular_nombre_snapshot text DEFAULT 'Cliente'::text,
  titular_email_snapshot text,
  titular_telefono_snapshot text,
  moneda_codigo text DEFAULT 'HNL'::text,
  subtotal_hnl numeric(12,2) DEFAULT 0,
  descuento_hnl numeric(12,2) DEFAULT 0,
  isv_porcentaje numeric(5,2) DEFAULT 0,
  isv_hnl numeric(12,2) DEFAULT 0,
  total_hnl numeric(12,2) DEFAULT 0,
  email_enviado boolean DEFAULT false,
  email_enviado_at timestamp with time zone,
  email_intentos integer DEFAULT 0,
  email_ultimo_error_codigo text,
  email_ultimo_error_detalle text,
  payload_resumen jsonb DEFAULT '{}'::jsonb,
  facturacion_fiscal_habilitada_snapshot boolean DEFAULT false,
  cai_preparado_snapshot boolean DEFAULT false,
  id_factura_futura uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.comprobantes_agendamiento_destinatarios (
  id_comprobante_destinatario uuid DEFAULT gen_random_uuid(),
  id_comprobante_agendamiento uuid,
  tipo_destinatario_codigo text DEFAULT 'titular'::text,
  nombre_destinatario_snapshot text,
  email_destinatario_snapshot text,
  estado_envio_codigo text DEFAULT 'pendiente'::text,
  enviado_at timestamp with time zone,
  intento_envio_count integer DEFAULT 0,
  ultimo_error_codigo text,
  ultimo_error_detalle text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.correos (
  id_correo uuid DEFAULT gen_random_uuid(),
  id_persona uuid,
  direccion_correo citext,
  es_principal boolean DEFAULT false,
  verificado boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.cortesias (
  id uuid DEFAULT gen_random_uuid(),
  nombre text,
  descripcion text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.cortesias_sucursales (
  id uuid DEFAULT gen_random_uuid(),
  cortesia_id uuid,
  id_sucursal uuid,
  activa boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.empleados (
  id_empleado uuid DEFAULT gen_random_uuid(),
  id_persona uuid,
  id_sucursal uuid,
  fecha_ingreso timestamp with time zone,
  salario_base numeric(12,2),
  estado boolean DEFAULT true,
  es_barbero boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  roles_reactivacion jsonb
);

CREATE TABLE public.empresas (
  id_empresa uuid DEFAULT gen_random_uuid(),
  nombre_empresa text,
  rtn text,
  moneda text DEFAULT 'HNL'::text,
  zona_horaria text DEFAULT 'America/Tegucigalpa'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.estados_cita (
  estado_cita_codigo text,
  descripcion text
);

CREATE TABLE public.facturas (
  id_factura uuid DEFAULT gen_random_uuid(),
  id_grupo_cita uuid,
  id_comprobante_agendamiento uuid,
  id_sucursal uuid,
  tipo_factura_codigo text DEFAULT 'factura_fiscal_cai'::text,
  estado_factura_codigo text DEFAULT 'borrador'::text,
  modo_emision_codigo text DEFAULT 'preparada_futuro'::text,
  numero_factura text,
  cai_codigo text,
  cai_rango_desde text,
  cai_rango_hasta text,
  cai_fecha_limite_emision date,
  cai_resolucion text,
  sar_integracion_habilitada_snapshot boolean DEFAULT false,
  sar_notificada boolean DEFAULT false,
  sar_notificada_at timestamp with time zone,
  sar_respuesta_payload jsonb DEFAULT '{}'::jsonb,
  emisor_nombre_snapshot text,
  emisor_rtn_snapshot text,
  emisor_direccion_snapshot text,
  emisor_telefono_snapshot text,
  receptor_nombre_snapshot text DEFAULT 'Consumidor Final'::text,
  receptor_rtn_snapshot text,
  receptor_email_snapshot text,
  receptor_telefono_snapshot text,
  id_usuario_titular uuid,
  id_cliente_titular uuid,
  id_persona_titular uuid,
  fecha_emision timestamp with time zone,
  fecha_anulacion timestamp with time zone,
  motivo_anulacion text,
  moneda_codigo text DEFAULT 'HNL'::text,
  subtotal_exento_hnl numeric(12,2) DEFAULT 0,
  subtotal_gravado_hnl numeric(12,2) DEFAULT 0,
  subtotal_hnl numeric(12,2) DEFAULT 0,
  descuento_hnl numeric(12,2) DEFAULT 0,
  isv_porcentaje numeric(5,2) DEFAULT 0,
  isv_hnl numeric(12,2) DEFAULT 0,
  total_hnl numeric(12,2) DEFAULT 0,
  observaciones text,
  payload_factura jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.horarios_semanales_empleados (
  id_horario uuid DEFAULT gen_random_uuid(),
  id_empleado uuid,
  dia_semana smallint,
  hora_inicio time without time zone,
  hora_fin time without time zone,
  almuerzo_inicio time without time zone,
  almuerzo_fin time without time zone,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.horarios_semanales_sucursales (
  id_horario_sucursal uuid DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  estado_horario_codigo text DEFAULT 'publicado'::text,
  vigencia_desde date DEFAULT CURRENT_DATE,
  vigencia_hasta date,
  motivo_cambio text,
  creado_por uuid,
  publicado_por uuid,
  publicado_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.horarios_semanales_sucursales_bloques (
  id_bloque_horario uuid DEFAULT gen_random_uuid(),
  id_horario_sucursal uuid,
  dia_semana smallint,
  hora_inicio time without time zone,
  hora_fin time without time zone,
  minuto_inicio integer GENERATED ALWAYS AS ((((EXTRACT(hour FROM hora_inicio))::integer * 60) + (EXTRACT(minute FROM hora_inicio))::integer)) STORED,
  minuto_fin integer GENERATED ALWAYS AS ((((EXTRACT(hour FROM hora_fin))::integer * 60) + (EXTRACT(minute FROM hora_fin))::integer)) STORED,
  orden_visual smallint DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.membership_plans (
  id_plan uuid DEFAULT gen_random_uuid(),
  nombre_plan text,
  precio_hnl numeric(12,2),
  periodo_membresia_codigo text,
  beneficios jsonb DEFAULT '{}'::jsonb,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  descripcion text,
  categoria_nivel smallint DEFAULT 1
);

CREATE TABLE public.membership_purchase_orders (
  id_order uuid DEFAULT gen_random_uuid(),
  id_cliente uuid,
  id_usuario uuid,
  id_plan uuid,
  id_plan_sucursal uuid,
  id_sucursal uuid,
  id_suscripcion uuid,
  estado_orden_codigo text DEFAULT 'pendiente_pago'::text,
  moneda_codigo text DEFAULT 'HNL'::text,
  subtotal_hnl numeric(12,2),
  descuento_hnl numeric(12,2) DEFAULT 0,
  total_hnl numeric(12,2),
  plan_snapshot jsonb,
  cliente_snapshot jsonb DEFAULT '{}'::jsonb,
  factura_snapshot jsonb DEFAULT '{}'::jsonb,
  email_factura text,
  notas text,
  expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_by_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  idempotency_key text
);

CREATE TABLE public.notificaciones_email (
  id_notificacion uuid DEFAULT gen_random_uuid(),
  evento text,
  id_usuario_destino uuid,
  correo_destino citext,
  asunto text,
  cuerpo text,
  plantilla_codigo text,
  enviar_en timestamp with time zone DEFAULT now(),
  enviado_en timestamp with time zone,
  estado_notificacion_codigo text,
  ultimo_error text,
  id_cita uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  procesando_desde timestamp with time zone,
  worker_id text,
  intentos_envio integer DEFAULT 0
);

CREATE TABLE public.pantallas (
  id_pantalla uuid DEFAULT gen_random_uuid(),
  codigo text,
  nombre text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.paquetes (
  id_paquete uuid DEFAULT gen_random_uuid(),
  nombre_paquete text,
  descripcion text,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  precio_hnl numeric(10,2)
);

CREATE TABLE public.paquetes_detalles (
  id_paquete_detalle uuid DEFAULT gen_random_uuid(),
  id_paquete uuid,
  id_servicio uuid,
  cantidad integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.parametros_sistema (
  clave text,
  valor_texto text,
  valor_numero numeric,
  valor_booleano boolean,
  descripcion text,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.parametros_sucursal (
  id_sucursal uuid,
  clave text,
  valor_texto text,
  valor_numero numeric,
  valor_booleano boolean,
  descripcion text,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.payment_intents (
  id_intent uuid DEFAULT gen_random_uuid(),
  id_provider uuid,
  id_cita uuid,
  id_hold uuid,
  estado_intent_codigo text,
  monto_hnl numeric(12,2),
  moneda_codigo text DEFAULT 'HNL'::text,
  link_pago_url text,
  referencia_externa text,
  idempotency_key text,
  expires_at timestamp with time zone,
  created_by_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  id_membership_order uuid,
  origen_pago_codigo text DEFAULT 'cita'::text,
  id_grupo_cita uuid,
  paid_at timestamp with time zone,
  orden_compra text,
  provider_session_id text,
  launch_expires_at timestamp with time zone,
  last_verified_at timestamp with time zone,
  verification_attempts integer DEFAULT 0
);

CREATE TABLE public.payment_providers (
  id_provider uuid DEFAULT gen_random_uuid(),
  codigo text,
  nombre text,
  activo boolean DEFAULT true,
  configuracion_publica jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.payments (
  id_payment uuid DEFAULT gen_random_uuid(),
  id_intent uuid,
  estado_pago_codigo text,
  provider_tx_id text,
  monto_hnl numeric(12,2),
  moneda_codigo text DEFAULT 'HNL'::text,
  paid_at timestamp with time zone,
  pago_tardio boolean DEFAULT false,
  registrado_manualmente boolean DEFAULT false,
  registrado_por_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.permisos (
  id_permiso uuid DEFAULT gen_random_uuid(),
  nombre_permiso text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.personas (
  id_persona uuid DEFAULT gen_random_uuid(),
  nombres text,
  apellidos text,
  fecha_nacimiento date,
  genero_codigo text,
  dni text,
  rtn text,
  telefono_principal text,
  direccion_texto text,
  observaciones text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  foto_perfil_asset_id uuid,
  foto_perfil_path text
);

CREATE TABLE public.points_cycles (
  id_cycle uuid DEFAULT gen_random_uuid(),
  id_cliente uuid,
  primer_acumulado_at timestamp with time zone,
  vence_at timestamp with time zone,
  estado_ciclo_codigo text DEFAULT 'activo'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.points_legacy_migrations (
  id_migracion uuid DEFAULT gen_random_uuid(),
  id_cliente uuid,
  id_points_tx uuid,
  puntos_migrados integer,
  motivo text,
  creado_por_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.points_rule_services (
  id_rule_service uuid DEFAULT gen_random_uuid(),
  id_rule uuid,
  id_servicio uuid,
  created_at timestamp with time zone DEFAULT now(),
  cliente_condicion_codigo text DEFAULT 'sin_membresia'::text,
  puntos_canje integer,
  habilitado boolean DEFAULT true,
  visible_cliente boolean DEFAULT true,
  orden_visual integer DEFAULT 100,
  updated_at timestamp with time zone DEFAULT statement_timestamp()
);

CREATE TABLE public.points_rules (
  id_rule uuid DEFAULT gen_random_uuid(),
  id_sucursal uuid,
  umbral_monto_hnl numeric(12,2) DEFAULT 250,
  puntos_por_cita integer DEFAULT 1,
  puntos_para_premio integer DEFAULT 10,
  expiracion_meses integer DEFAULT 12,
  servicios_redimibles text[] DEFAULT ARRAY['corte'::text, 'barba'::text],
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.points_transactions (
  id_points_tx uuid DEFAULT gen_random_uuid(),
  id_cliente uuid,
  id_cita uuid,
  tipo_puntos_codigo text,
  puntos integer,
  vence_at timestamp with time zone,
  motivo text,
  creado_por_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  id_cycle uuid,
  id_sucursal_origen uuid,
  id_servicio_canje uuid,
  origen_punto_codigo text DEFAULT 'titular'::text
);

CREATE TABLE public.roles (
  id_rol uuid DEFAULT gen_random_uuid(),
  nombre text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.roles_pantallas_permisos (
  id_rpp uuid DEFAULT gen_random_uuid(),
  id_rol uuid,
  id_pantalla uuid,
  id_permiso uuid,
  permitido boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.roles_usuarios (
  id_rol_usuario uuid DEFAULT gen_random_uuid(),
  id_rol uuid,
  id_usuario uuid,
  id_sucursal uuid,
  activo boolean DEFAULT true,
  asignado_por uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.servicios (
  id_servicio uuid DEFAULT gen_random_uuid(),
  nombre_servicio text,
  descripcion text,
  duracion_min integer,
  buffer_min integer DEFAULT 5,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  grupo_catalogo text DEFAULT 'barberia'::text,
  visible_publico boolean DEFAULT true,
  agendable boolean DEFAULT true,
  orden_visual integer DEFAULT 100
);

CREATE TABLE public.servicios_tarifas (
  id_tarifa uuid DEFAULT gen_random_uuid(),
  id_servicio uuid,
  id_sucursal uuid,
  id_empleado uuid,
  precio_hnl numeric(12,2),
  incluye_isv boolean DEFAULT false,
  isv_porcentaje numeric(5,2),
  vigente_desde date DEFAULT CURRENT_DATE,
  vigente_hasta date,
  activo boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  duracion_min integer,
  buffer_min integer,
  servicio_informativo boolean DEFAULT false
);

CREATE TABLE public.storage_assets (
  id_asset uuid DEFAULT gen_random_uuid(),
  bucket_name text,
  object_path text,
  public_url text,
  scope_key text,
  visibility text,
  entity_type text,
  entity_id uuid,
  id_sucursal uuid,
  owner_user_id uuid,
  owner_cliente_id uuid,
  mime_type text,
  bytes bigint,
  original_filename text,
  extension text,
  status text DEFAULT 'temporal'::text,
  metadata jsonb DEFAULT '{}'::jsonb,
  uploaded_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.subscription_payments (
  id_sub_payment uuid DEFAULT gen_random_uuid(),
  id_suscripcion uuid,
  monto_hnl numeric(12,2),
  moneda_codigo text DEFAULT 'HNL'::text,
  metodo text,
  estado text,
  paid_at timestamp with time zone,
  id_payment uuid,
  registrado_por_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.subscriptions (
  id_suscripcion uuid DEFAULT gen_random_uuid(),
  id_cliente uuid,
  id_plan uuid,
  estado_suscripcion_codigo text,
  inicio_at timestamp with time zone DEFAULT now(),
  fin_at timestamp with time zone,
  renovacion_auto boolean DEFAULT false,
  cancelada_al_fin boolean DEFAULT false,
  created_by_usuario_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  beneficios_snapshot jsonb DEFAULT '{"items": [], "version": 1}'::jsonb,
  id_sucursal_contratada uuid,
  motivo_fin_codigo text
);

CREATE TABLE public.sucursales (
  id_sucursal uuid DEFAULT gen_random_uuid(),
  id_empresa uuid,
  nombre_sucursal text,
  direccion_texto text,
  telefono_texto text,
  id_correo uuid,
  fecha_inauguracion date,
  estado boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.tipos_puntos (
  tipo_puntos_codigo text,
  descripcion text,
  signo integer
);

CREATE TABLE public.usuarios (
  id_usuario uuid,
  id_persona uuid,
  estado boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  password_hash text,
  estado_acceso text DEFAULT 'pendiente_password'::text,
  credenciales_completadas_at timestamp with time zone,
  ultimo_login_at timestamp with time zone
);

-- AM: auxiliares reales copiados sin cambios de cuerpo del snapshot.
CREATE OR REPLACE FUNCTION public.fn_has_role(p_uid uuid, p_role_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM roles_usuarios ru
    JOIN roles r ON r.id_rol = ru.id_rol
    WHERE ru.id_usuario = p_uid
      AND ru.activo = true
      AND r.nombre = p_role_name
  );
$function$;
CREATE OR REPLACE FUNCTION app_private.build_booking_line_key_v1(p_orden_integrante integer, p_id_servicio uuid, p_id_tarifa uuid, p_origen_item_codigo text, p_occurrence integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT concat_ws(
    '|',
    GREATEST(1, COALESCE(p_orden_integrante, 1))::text,
    p_id_servicio::text,
    COALESCE(p_id_tarifa::text, 'sin_tarifa'),
    COALESCE(NULLIF(btrim(p_origen_item_codigo), ''), 'servicio_manual'),
    GREATEST(1, COALESCE(p_occurrence, 1))::text
  )
$function$;
CREATE OR REPLACE FUNCTION app_private.obtener_hold_ttl_min_v1()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT LEAST(
    120,
    GREATEST(
      1,
      COALESCE(
        (
          SELECT trunc(ps.valor_numero)::integer
          FROM public.parametros_sistema ps
          WHERE ps.clave = 'hold_duracion_min'
          LIMIT 1
        ),
        5
      )
    )
  );
$function$;

-- AM: UNICO stub de comportamiento. No ejecuta expiraciones ni cambios de pago.
-- Solo habilita pruebas del trigger de holds sin reservas vencidas; cualquier
-- caso que necesite limpieza real falla explicitamente y queda fuera de cobertura.
CREATE FUNCTION app_private.expirar_reservas_vencidas_v1(
  p_limite integer DEFAULT 500,
  p_ahora timestamp with time zone DEFAULT clock_timestamp(),
  p_id_sucursal uuid DEFAULT NULL::uuid,
  p_id_barbero uuid DEFAULT NULL::uuid,
  p_inicio_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_fin_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_id_usuario_titular uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fixture_expiry$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.citas_holds h
    WHERE h.estado_hold_codigo = 'activo'
      AND h.expires_at <= p_ahora
      AND (p_id_usuario_titular IS NULL OR h.id_usuario = p_id_usuario_titular)
  ) THEN
    RAISE EXCEPTION 'QA_SECURITY02_FIXTURE_EXPIRATION_NOT_IMPLEMENTED';
  END IF;
  RETURN '{"fixture_only":true,"expired_count":0}'::jsonb;
END;
$fixture_expiry$;
